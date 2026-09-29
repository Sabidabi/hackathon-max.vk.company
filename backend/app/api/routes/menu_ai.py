import json
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.guard import NOTE_SUSPICIOUS, clean_model_text, inspect_user_text
from app.ai.openai_compat import OpenAICompatError, OpenAICompatMenuPlanner
from app.ai.provider import configured_provider_name
from app.ai.service import AILimitExceeded, consume_quota
from app.api.routes.menus import (
    DraftMenuResponse,
    check_revision,
    get_menu_and_draft,
    menu_revision,
    read_version_sections,
    require_menu_access,
    write_version_sections,
)
from app.auth.dependencies import get_current_user
from app.config import Settings, get_settings
from app.database import get_session
from app.menu_commands.schemas import MenuChangePlan
from app.menu_commands.service import apply_menu_change_plan
from app.models import MenuChangeProposal, Restaurant, User

router = APIRouter(tags=["menu-ai"])


def composer_available(settings: Settings) -> bool:
    """The composer needs a real model: off by ``AI_PROVIDER=off``, without a key, and
    under the demo mock (it has no menu planner)."""
    return configured_provider_name(settings) == "openai"


class MenuAiStatusResponse(BaseModel):
    provider: Literal["openai"] = "openai"
    configured: bool
    capabilities: list[str] = ["create_item", "variants", "modifier_groups"]


class MenuAiPlanRequest(BaseModel):
    prompt: str = Field(min_length=3, max_length=4000)
    expected_revision: str = Field(pattern="^[a-f0-9]{64}$")


class MenuAiPlanResponse(BaseModel):
    proposal_id: uuid.UUID
    plan: MenuChangePlan
    expires_at: datetime


class MenuAiApplyRequest(BaseModel):
    proposal_id: uuid.UUID
    expected_revision: str = Field(pattern="^[a-f0-9]{64}$")


def _menu_context(sections) -> str:
    context = [
        {
            "section": section.name,
            "items": [
                {
                    "name": item.name,
                    "price_minor": item.price_minor,
                    "variants": [
                        {
                            "name": variant.name,
                            "price_minor": variant.price_minor,
                            "weight_text": variant.weight_text,
                        }
                        for variant in item.configuration.variants
                    ],
                    "modifier_groups": [group.name for group in item.configuration.modifier_groups],
                }
                for item in section.items
            ],
        }
        for section in sections
    ]
    return json.dumps(context, ensure_ascii=False, separators=(",", ":"))


@router.get(
    "/restaurants/{restaurant_id}/menu/ai/status",
    response_model=MenuAiStatusResponse,
)
async def menu_ai_status(
    restaurant_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> MenuAiStatusResponse:
    await require_menu_access(session, current_user, restaurant_id)
    return MenuAiStatusResponse(configured=composer_available(settings))


@router.post(
    "/restaurants/{restaurant_id}/menu/ai/plan",
    response_model=MenuAiPlanResponse,
)
async def plan_menu_change(
    restaurant_id: uuid.UUID,
    payload: MenuAiPlanRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> MenuAiPlanResponse:
    await require_menu_access(session, current_user, restaurant_id)
    _, draft = await get_menu_and_draft(session, restaurant_id)
    await check_revision(session, draft.id, payload.expected_revision)
    sections = await read_version_sections(session, draft.id)
    if not composer_available(settings):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="ИИ сейчас недоступен — добавьте позицию вручную",
        )
    report = inspect_user_text(payload.prompt)
    if len(report.text) < 3:
        raise HTTPException(status_code=422, detail="Опишите, что добавить в меню")
    restaurant = await session.get(Restaurant, restaurant_id)
    assert restaurant is not None  # require_menu_access found it
    try:
        await consume_quota(
            settings, venue_id=restaurant.venue_id, feature="menu_plan",
            subject=f"user:{current_user.id}",
        )
    except AILimitExceeded as limit:
        raise HTTPException(status_code=429, detail=limit.detail()) from limit
    try:
        plan = await OpenAICompatMenuPlanner(settings).generate(
            report.text,
            _menu_context(sections),
        )
    except (OpenAICompatError, httpx.HTTPError) as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(error) or "ИИ-сервис временно недоступен",
        ) from error

    # The model's own words for the person are plain text: no links, no markup.
    plan.summary = clean_model_text(plan.summary)
    plan.warnings = [clean_model_text(item) for item in plan.warnings]
    if report.suspicious:
        plan.warnings.insert(0, NOTE_SUSPICIOUS)
    expires_at = datetime.now(UTC) + timedelta(seconds=settings.ai_proposal_ttl_seconds)
    proposal = MenuChangeProposal(
        restaurant_id=restaurant_id,
        created_by_id=current_user.id,
        expected_revision=payload.expected_revision,
        plan=plan.model_dump(mode="json"),
        status="pending",
        expires_at=expires_at,
    )
    session.add(proposal)
    await session.commit()
    return MenuAiPlanResponse(proposal_id=proposal.id, plan=plan, expires_at=expires_at)


@router.post(
    "/restaurants/{restaurant_id}/menu/ai/apply",
    response_model=DraftMenuResponse,
)
async def apply_menu_change(
    restaurant_id: uuid.UUID,
    payload: MenuAiApplyRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DraftMenuResponse:
    await require_menu_access(session, current_user, restaurant_id)
    proposal = await session.scalar(
        select(MenuChangeProposal)
        .where(
            MenuChangeProposal.id == payload.proposal_id,
            MenuChangeProposal.restaurant_id == restaurant_id,
            MenuChangeProposal.created_by_id == current_user.id,
        )
        .with_for_update()
    )
    if proposal is None:
        raise HTTPException(status_code=404, detail="Предложение не найдено")
    if proposal.plan.get("kind") == "design":
        raise HTTPException(status_code=404, detail="Предложение не найдено")
    if proposal.status != "pending":
        raise HTTPException(status_code=409, detail="Предложение уже применено или устарело")
    now = datetime.now(UTC)
    if proposal.expires_at <= now:
        proposal.status = "expired"
        await session.commit()
        raise HTTPException(status_code=410, detail="Предложение устарело. Создайте новое")
    if proposal.expected_revision != payload.expected_revision:
        raise HTTPException(status_code=409, detail="Предложение создано для другой версии меню")

    menu, draft = await get_menu_and_draft(session, restaurant_id, lock=True)
    await check_revision(session, draft.id, payload.expected_revision)
    current_sections = await read_version_sections(session, draft.id)
    plan = MenuChangePlan.model_validate(proposal.plan)
    next_sections = apply_menu_change_plan(current_sections, plan)
    await write_version_sections(session, draft.id, next_sections)
    await session.flush()
    sections = await read_version_sections(session, draft.id)
    revision = menu_revision(sections)
    proposal.status = "applied"
    proposal.applied_at = now
    proposal.result_revision = revision
    menu.updated_at = now
    await session.commit()
    return DraftMenuResponse(
        menu_id=menu.id,
        draft_version_id=draft.id,
        sections=sections,
        revision=revision,
    )
