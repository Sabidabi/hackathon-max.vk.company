"""AI features over HTTP: the guest's «Синица, что взять?», the item
description and «Синица проверила меню» for admins.

AI only suggests: nothing here writes a menu. The guest answer is grounded on the
point's published, available positions and filtered by ID; the admin description is
returned for the admin to put into the draft form; the menu check is computed by code.
"""

import logging
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.fallback import Candidate, keyword_picks
from app.ai.menu_check import MenuFinding, check_menu
from app.ai.provider import AIInvalidResponse, AIUnavailable
from app.ai.service import AILimitExceeded, ai_status, anonymous_subject, run_task
from app.ai.tasks import (
    GuestAskAnswer,
    ItemDescriptionAnswer,
    MenuCheckAnswer,
    WeeklySummaryAnswer,
    check_description,
    check_reason,
    check_summary,
    guest_ask_task,
    item_description_task,
    menu_check_task,
    weekly_summary_task,
)
from app.analytics.report import build_report
from app.api.routes.menus import (
    MenuItemResponse,
    check_revision,
    get_draft,
    menu_revision,
    read_version_sections,
)
from app.auth.dependencies import get_current_user
from app.auth.permissions import require_admin_of_venue, require_menu_admin
from app.auth.service import get_user_by_session_token
from app.config import Settings, get_settings
from app.database import get_session
from app.menu_configuration import availability_error
from app.menu_library import active_tabs
from app.models import Restaurant, User

logger = logging.getLogger(__name__)
router = APIRouter(tags=["ai"])

MAX_CANDIDATES = 150
ProviderName = Literal["openai", "mock"]


class AiStatusResponse(BaseModel):
    available: bool
    # "mock" is the labelled demo adapter: the UI marks its answers «Демо-ИИ».
    provider: ProviderName | None


@router.get("/ai/status", response_model=AiStatusResponse)
async def get_ai_status(settings: Annotated[Settings, Depends(get_settings)]) -> AiStatusResponse:
    available, provider = ai_status(settings)
    return AiStatusResponse(available=available, provider=provider)


async def optional_user(
    request: Request, session: AsyncSession, settings: Settings
) -> User | None:
    token = request.cookies.get(settings.session_cookie_name)
    return await get_user_by_session_token(session, token) if token else None


def guest_subject(request: Request, user: User | None) -> str:
    """Whose daily guest limit a request counts against: the signed-in MAX user, else an
    anonymous browser (client address from nginx ``X-Real-IP`` + user agent, hashed); the
    address alone also carries a ceiling that a changed user agent does not reset."""
    if user is not None:
        return f"user:{user.id}"
    address = request.headers.get("x-real-ip") or (request.client.host if request.client else "")
    agent = request.headers.get("user-agent", "")[:200]
    return anonymous_subject(address, agent)


# --- «Синица, что взять?» -------------------------------------------------------------


class GuestAskPayload(BaseModel):
    question: str = Field(min_length=1, max_length=300)

    @field_validator("question")
    @classmethod
    def clean(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value:
            raise ValueError("Напишите, что вам хочется")
        return value


class GuestPick(BaseModel):
    id: uuid.UUID
    item_key: uuid.UUID
    menu_id: uuid.UUID
    name: str
    section: str
    # Straight from the published snapshot with the point's own prices; never from the AI.
    price_minor: int
    has_sizes: bool
    image_url: str | None


class GuestAskResponse(BaseModel):
    # "ai" — picked by the model and filtered by the server; "fallback" — without AI.
    source: Literal["ai", "fallback"]
    provider: ProviderName | None
    reason: str
    notice: str | None
    items: list[GuestPick]


def _sellable(item: MenuItemResponse) -> bool:
    return item.is_available and availability_error(item.configuration) is None


def _pick(item: MenuItemResponse, menu_id: uuid.UUID, section: str) -> GuestPick:
    prices = [v.price_minor for v in item.configuration.variants if v.is_available]
    return GuestPick(
        id=item.id,
        item_key=item.item_key,
        menu_id=menu_id,
        name=item.name,
        section=section,
        price_minor=min(prices) if prices else item.price_minor,
        has_sizes=len(prices) > 1,
        image_url=item.image_url,
    )


@router.post(
    "/public/restaurants/{public_id}/ask",
    response_model=GuestAskResponse,
    responses={429: {"description": "Daily AI limit; detail carries picks without AI"}},
)
async def ask_sinitsa(
    public_id: str,
    payload: GuestAskPayload,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> Any:
    restaurant = await session.scalar(select(Restaurant).where(Restaurant.public_id == public_id))
    if restaurant is None:
        raise HTTPException(status_code=404, detail="Меню не найдено")
    tabs, has_published = await active_tabs(session, restaurant.id, restaurant.timezone)
    if not has_published:
        raise HTTPException(status_code=404, detail="Меню не опубликовано")

    # Grounding: only positions a guest can take right now (stop-list and hours applied).
    by_ref: dict[str, GuestPick] = {}
    candidates: list[Candidate] = []
    for tab in tabs:
        for section in tab.sections:
            for item in section.items:
                if not _sellable(item) or len(candidates) >= MAX_CANDIDATES:
                    continue
                ref = f"p{len(candidates) + 1}"
                by_ref[ref] = _pick(item, tab.menu.id, section.name)
                candidates.append(Candidate(
                    ref=ref,
                    name=item.name,
                    section=section.name,
                    description=(item.description or "")[:200],
                    sizes=tuple(v.name for v in item.configuration.variants if v.is_available),
                ))
    if not candidates:
        return GuestAskResponse(
            source="fallback", provider=None, reason="", items=[],
            notice="Сейчас в меню нет доступных позиций",
        )

    def fallback(notice: str) -> GuestAskResponse:
        refs = keyword_picks(payload.question, candidates)
        return GuestAskResponse(
            source="fallback", provider=None, reason="", notice=notice,
            items=[by_ref[ref] for ref in refs],
        )

    user = await optional_user(request, session, settings)
    try:
        result = await run_task(
            settings,
            guest_ask_task(payload.question, candidates),
            venue_id=restaurant.venue_id,
            subject=guest_subject(request, user),
        )
    except AILimitExceeded as limit:
        picks = fallback("Подобрали без ИИ")
        return JSONResponse(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            content={"detail": {
                **limit.detail(),
                "items": [pick.model_dump(mode="json") for pick in picks.items],
            }},
        )
    except AIUnavailable:
        return fallback("ИИ сейчас недоступен — вот что можно взять")

    answer = result.value
    assert isinstance(answer, GuestAskAnswer)
    # The model may only point at candidates: unknown, foreign or repeated IDs are dropped.
    seen: set[str] = set()
    items: list[GuestPick] = []
    picked: list[Candidate] = []
    by_candidate = {candidate.ref: candidate for candidate in candidates}
    for ref in answer.item_ids:
        if ref in by_ref and ref not in seen:
            seen.add(ref)
            items.append(by_ref[ref])
            picked.append(by_candidate[ref])
    dropped = len(answer.item_ids) - len(items)
    if dropped:
        logger.warning("AI guest answer: %s unknown item IDs dropped", dropped)
    if not items:
        return fallback("Точного совпадения нет — посмотрите это")
    # The model's «why» is shown only when it states nothing the picked positions lack.
    reason = check_reason(answer.reason, picked)
    if answer.reason and not reason:
        logger.warning("AI guest answer: reason with invented facts dropped")
    return GuestAskResponse(
        source="ai", provider=result.provider, reason=reason, notice=None, items=items
    )


# --- Описание позиции ------------------------------------------------------------------


class DescribeItem(BaseModel):
    name: str = Field(min_length=1, max_length=250)
    section: str | None = Field(default=None, max_length=200)
    ingredients: str | None = Field(default=None, max_length=1000)
    weight_text: str | None = Field(default=None, max_length=100)
    sizes: list[str] = Field(default_factory=list, max_length=20)
    modifiers: list[str] = Field(default_factory=list, max_length=20)


class DescribePayload(BaseModel):
    expected_revision: str = Field(pattern="^[a-f0-9]{64}$")
    item: DescribeItem


class DescribeResponse(BaseModel):
    description: str
    provider: ProviderName
    revision: str


def unavailable_503(error: AIUnavailable) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={"code": error.code, "message": "ИИ сейчас недоступен — напишите вручную"},
    )


@router.post("/menus/{menu_id}/ai/description", response_model=DescribeResponse)
async def describe_item(
    menu_id: uuid.UUID,
    payload: DescribePayload,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> DescribeResponse:
    """A suggestion for the item form: nothing is written. The admin puts it into the
    draft with the usual save, which checks the revision again."""
    menu = await require_menu_admin(session, current_user.id, menu_id)
    draft = await get_draft(session, menu.id)
    await check_revision(session, draft.id, payload.expected_revision)
    user_id = current_user.id
    source = {
        key: value for key, value in payload.item.model_dump().items() if value not in (None, [])
    }
    venue_id = menu.venue_id
    await session.rollback()  # no transaction is held while the model thinks
    try:
        result = await run_task(
            settings,
            item_description_task(source),
            venue_id=venue_id,
            subject=f"user:{user_id}",
        )
        answer = result.value
        assert isinstance(answer, ItemDescriptionAnswer)
        description = check_description(answer.description, source)
    except AILimitExceeded as limit:
        raise HTTPException(status_code=429, detail=limit.detail()) from limit
    except AIUnavailable as error:
        raise unavailable_503(error) from error
    return DescribeResponse(
        description=description, provider=result.provider, revision=payload.expected_revision
    )


# --- Проверка меню ---------------------------------------------------------------------


class MenuCheckResponse(BaseModel):
    revision: str
    findings: list[MenuFinding]
    summary: str | None
    # "ok" — wording from the model; otherwise only the code's own messages.
    ai: Literal["ok", "unavailable", "limit", "skipped"]
    provider: ProviderName | None


@router.post("/menus/{menu_id}/check", response_model=MenuCheckResponse)
async def check_menu_draft(
    menu_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> MenuCheckResponse:
    menu = await require_menu_admin(session, current_user.id, menu_id)
    draft = await get_draft(session, menu.id)
    sections = await read_version_sections(session, draft.id)
    venue_id, user_id = menu.venue_id, current_user.id
    await session.rollback()
    findings = check_menu(sections)
    response = MenuCheckResponse(
        revision=menu_revision(sections), findings=findings, summary=None,
        ai="skipped", provider=None,
    )
    if not findings:
        return response
    compact = [
        {"index": index, "code": finding.code, "message": finding.message}
        for index, finding in enumerate(findings[:60])
    ]
    try:
        result = await run_task(
            settings, menu_check_task(compact),
            venue_id=venue_id, subject=f"user:{user_id}",
        )
    except AILimitExceeded:
        response.ai = "limit"
        return response
    except AIUnavailable:
        response.ai = "unavailable"
        return response
    answer = result.value
    assert isinstance(answer, MenuCheckAnswer)
    for tip in answer.tips:
        if tip.index < len(compact):  # tips only for findings the code produced
            findings[tip.index].tip = tip.text
    response.summary = answer.summary or None
    response.ai = "ok"
    response.provider = result.provider
    return response


# --- Недельная сводка ------------------------------------------------------------------

SUMMARY_MIN_GUESTS = 20


class WeeklySummaryResponse(BaseModel):
    state: Literal["ok", "few_data", "ai_unavailable", "ai_limit"]
    period: Literal["7d"] = "7d"
    metrics: dict[str, Any]
    text: str | None = None
    tips: list[str] = Field(default_factory=list)
    provider: ProviderName | None = None


def summary_metrics(report: dict[str, Any]) -> dict[str, Any]:
    """Key numbers of the 7-day report — only what the analytics report already computed."""
    guests = report.get("guests") or {}
    total = int(guests.get("max_users", 0)) + int(guests.get("web_sessions", 0))
    d7 = report.get("d7_return") or {}
    metrics: dict[str, Any] = {
        "guests": total,
        "choices": report.get("choices"),
        "choice_rate_percent": report.get("choice_rate"),
        "avg_choice_size": report.get("avg_choice_size"),
        "d7_return_percent": d7.get("rate"),
        "top_viewed": [
            {"name": i["name"], "views": i["views"]} for i in report.get("top_viewed", [])
        ],
        "top_chosen": [
            {"name": i["name"], "adds": i["adds"]} for i in report.get("top_chosen", [])
        ],
        "looked_not_chosen": [
            {"name": i["name"], "views": i["views"], "adds": i["adds"]}
            for i in report.get("looked_not_chosen", [])
        ],
        "empty_searches": [
            {"query": e["query"], "hits": e["hits"]} for e in report.get("empty_searches", [])
        ],
    }
    return {key: value for key, value in metrics.items() if value not in (None, [])}


@router.get(
    "/venues/{venue_id}/analytics/ai-summary", response_model=WeeklySummaryResponse
)
async def weekly_ai_summary(
    venue_id: uuid.UUID,
    response: Response,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
    point: Annotated[str | None, Query(max_length=32)] = None,
) -> WeeklySummaryResponse:
    """«Синица подводит неделю»: numbers come from the analytics report, the model only
    words them; a number it invents drops the text and leaves the figures."""
    await require_admin_of_venue(session, current_user.id, venue_id)
    points = (await session.scalars(
        select(Restaurant).where(Restaurant.venue_id == venue_id).order_by(Restaurant.created_at)
    )).all()
    if point is not None:
        points = [p for p in points if p.public_id == point]
    if not points:
        raise HTTPException(status_code=404, detail="Restaurant not found")
    report = await build_report(session, list(points), "7d", datetime.now(UTC))
    user_id = current_user.id
    await session.rollback()  # no transaction is held while the model thinks
    metrics = summary_metrics(report)
    response.headers["Cache-Control"] = "private, max-age=3600"
    result = WeeklySummaryResponse(state="ok", metrics=metrics)
    if int(metrics.get("guests", 0)) < SUMMARY_MIN_GUESTS:
        result.state = "few_data"
        return result
    try:
        run = await run_task(
            settings, weekly_summary_task(metrics),
            venue_id=venue_id, subject=f"user:{user_id}",
        )
        answer = run.value
        assert isinstance(answer, WeeklySummaryAnswer)
        check_summary(answer, metrics)
    except AILimitExceeded:
        result.state = "ai_limit"
        return result
    except (AIUnavailable, AIInvalidResponse):
        result.state = "ai_unavailable"
        return result
    result.text, result.tips, result.provider = answer.text, answer.tips, run.provider
    return result
