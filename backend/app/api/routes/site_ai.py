"""ИИ-помощник оформления: план правок по просьбе владельца и применение в черновик.

The model only proposes a typed patch of visual settings (`DesignPatch`); a person sees it,
applies it to the draft and publishes the design in the cabinet as usual. Nothing is published
from here.
"""

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.guard import NOTE_SUSPICIOUS, clean_model_text, inspect_user_text
from app.ai.provider import AIUnavailable
from app.ai.service import AILimitExceeded, run_task
from app.ai.tasks import DesignPlanAnswer, design_plan_task
from app.api.routes.sites import (
    SiteDraftResponse,
    get_site,
    require_site_access,
    site_revision,
)
from app.auth.dependencies import get_current_user
from app.config import Settings, get_settings
from app.database import get_session
from app.models import MenuChangeProposal, Restaurant, RestaurantSite, User
from app.sites.contrast import contrast_issues
from app.sites.design_plan import DESIGN_FIELDS, DESIGN_OPTIONS
from app.sites.schemas import SiteConfig, default_site_config

logger = logging.getLogger(__name__)
router = APIRouter(tags=["site-ai"])


class SiteAiPlanRequest(BaseModel):
    prompt: str = Field(min_length=3, max_length=2000)
    expected_revision: str = Field(pattern="^[a-f0-9]{64}$")


class SiteAiPlanResponse(BaseModel):
    proposal_id: uuid.UUID
    summary: str
    changes: dict[str, object]
    warnings: list[str]
    provider: str
    expires_at: datetime


class SiteAiApplyRequest(BaseModel):
    proposal_id: uuid.UUID
    expected_revision: str = Field(pattern="^[a-f0-9]{64}$")


def _view(config: SiteConfig) -> dict[str, object]:
    data = config.model_dump(mode="json")
    return {key: data[key] for key in DESIGN_FIELDS}


def _merged(raw: dict, changes: dict) -> SiteConfig:
    base = SiteConfig.model_validate(raw).model_dump(mode="json")
    return SiteConfig.model_validate({**base, **changes})


@router.post(
    "/restaurants/{restaurant_id}/site/ai/plan", response_model=SiteAiPlanResponse
)
async def plan_site_design(
    restaurant_id: uuid.UUID,
    payload: SiteAiPlanRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> SiteAiPlanResponse:
    await require_site_access(session, current_user, restaurant_id)
    site = await get_site(session, restaurant_id)
    raw = site.draft_config if site else default_site_config()
    if site_revision(raw) != payload.expected_revision:
        raise HTTPException(status_code=409, detail="Оформление изменилось. Обновите страницу")
    restaurant = await session.get(Restaurant, restaurant_id)
    assert restaurant is not None  # site access found it
    venue_id, user_id = restaurant.venue_id, current_user.id
    current = _view(SiteConfig.model_validate(raw))
    report = inspect_user_text(payload.prompt)
    if len(report.text) < 3:
        raise HTTPException(status_code=422, detail="Опишите, что изменить в оформлении")
    if report.suspicious:
        # Only the signal names are logged, never the text itself.
        logger.warning("AI design prompt with injection signals: %s", ",".join(report.signals))
    await session.rollback()  # no transaction is held while the model thinks
    try:
        result = await run_task(
            settings,
            design_plan_task(report.text, current, DESIGN_OPTIONS),
            venue_id=venue_id,
            subject=f"user:{user_id}",
        )
    except AILimitExceeded as limit:
        raise HTTPException(status_code=429, detail=limit.detail()) from limit
    except AIUnavailable as error:
        raise HTTPException(
            status_code=503, detail=str(error) or "ИИ сейчас недоступен"
        ) from error
    answer = result.value
    assert isinstance(answer, DesignPlanAnswer)
    summary = clean_model_text(answer.summary)
    changes = answer.patch.changes()
    if not changes:
        raise HTTPException(status_code=422, detail=summary or "ИИ не понял, что менять")
    issues = contrast_issues(_merged(raw, changes))
    warnings = [clean_model_text(item) for item in answer.warnings]
    warnings += [
        f"{issue.label}: контраст {issue.ratio}:1, нужно {issue.required}:1" for issue in issues
    ]
    if report.suspicious:
        warnings.insert(0, NOTE_SUSPICIOUS)
    expires_at = datetime.now(UTC) + timedelta(seconds=settings.ai_proposal_ttl_seconds)
    proposal = MenuChangeProposal(
        restaurant_id=restaurant_id,
        created_by_id=user_id,
        expected_revision=payload.expected_revision,
        plan={"kind": "design", "summary": summary, "changes": changes},
        status="pending",
        expires_at=expires_at,
    )
    session.add(proposal)
    await session.commit()
    return SiteAiPlanResponse(
        proposal_id=proposal.id,
        summary=summary,
        changes=changes,
        warnings=warnings,
        provider=result.provider,
        expires_at=expires_at,
    )


@router.post(
    "/restaurants/{restaurant_id}/site/ai/apply", response_model=SiteDraftResponse
)
async def apply_site_design(
    restaurant_id: uuid.UUID,
    payload: SiteAiApplyRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> SiteDraftResponse:
    await require_site_access(session, current_user, restaurant_id)
    proposal = await session.scalar(
        select(MenuChangeProposal)
        .where(
            MenuChangeProposal.id == payload.proposal_id,
            MenuChangeProposal.restaurant_id == restaurant_id,
            MenuChangeProposal.created_by_id == current_user.id,
        )
        .with_for_update()
    )
    if proposal is None or proposal.plan.get("kind") != "design":
        raise HTTPException(status_code=404, detail="Предложение не найдено")
    if proposal.status != "pending":
        raise HTTPException(status_code=409, detail="Предложение уже применено или устарело")
    now = datetime.now(UTC)
    if proposal.expires_at <= now:
        proposal.status = "expired"
        await session.commit()
        raise HTTPException(status_code=410, detail="Предложение устарело. Создайте новое")
    if proposal.expected_revision != payload.expected_revision:
        raise HTTPException(status_code=409, detail="Предложение создано для другой версии")
    await session.scalar(select(Restaurant).where(Restaurant.id == restaurant_id).with_for_update())
    site = await get_site(session, restaurant_id)
    raw = site.draft_config if site else default_site_config()
    if site_revision(raw) != payload.expected_revision:
        raise HTTPException(status_code=409, detail="Оформление изменилось. Обновите страницу")
    changes = {k: v for k, v in proposal.plan["changes"].items() if k in DESIGN_FIELDS}
    merged = _merged(raw, changes)
    dumped = merged.model_dump(mode="json")
    if site is None:
        site = RestaurantSite(restaurant_id=restaurant_id, draft_config=dumped, published_version=0)
        session.add(site)
    else:
        site.draft_config = dumped
    site.updated_at = now.astimezone()
    revision = site_revision(dumped)
    proposal.status = "applied"
    proposal.applied_at = now
    proposal.result_revision = revision
    await session.commit()
    await session.refresh(site)
    return SiteDraftResponse(
        revision=revision,
        restaurant_id=restaurant_id,
        config=merged,
        published_version=site.published_version,
        published_at=site.published_at,
        contrast_issues=contrast_issues(merged),
    )
