"""Product analytics API (P1-DOC-10).

``POST /events`` is public: a guest of a published point may send events without signing in;
a MAX session, when present, only attaches ``user_id``. Admin events need a venue admin.
``GET /venues/{venue_id}/analytics`` is for the venue admins only (foreign venue → 404).
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.analytics.ingest import ingest_events, rate_limiter
from app.analytics.report import build_report
from app.analytics.vocabulary import ADMIN_EVENTS, EventName, Platform, validate_props
from app.api.routes.public_menu import DEMO_PUBLIC_IDS
from app.auth.dependencies import get_current_user
from app.auth.permissions import is_admin_of_venue, require_admin_of_venue
from app.auth.service import get_user_by_session_token
from app.config import Settings, get_settings
from app.database import get_session
from app.menu_library import active_tabs
from app.models import Restaurant, User

router = APIRouter(tags=["analytics"])

MAX_BATCH = 50


class EventIn(BaseModel):
    client_event_id: uuid.UUID
    name: EventName
    occurred_at: datetime | None = None
    props: dict[str, object] = Field(default_factory=dict)
    # Only for `search_empty`: normalised into the empty-search aggregate, never into props.
    query: str | None = Field(default=None, max_length=200)

    @field_validator("props")
    @classmethod
    def check_props(cls, value: dict[str, object]) -> dict[str, object]:
        return validate_props(value)


class EventBatch(BaseModel):
    point: str = Field(min_length=1, max_length=32)
    session_id: uuid.UUID
    platform: Platform
    events: list[EventIn] = Field(min_length=1, max_length=MAX_BATCH)


class BatchResult(BaseModel):
    accepted: int
    duplicates: int


async def optional_user(
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    request: Request,
) -> User | None:
    token = request.cookies.get(settings.session_cookie_name)
    return await get_user_by_session_token(session, token) if token else None


@router.post("/events", response_model=BatchResult)
async def post_events(
    batch: EventBatch,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User | None, Depends(optional_user)],
) -> BatchResult:
    client = request.client.host if request.client else "unknown"
    if not (
        rate_limiter.allow(f"s:{batch.session_id}") and rate_limiter.allow(f"ip:{client}")
    ):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                            detail="Слишком много событий")
    for event in batch.events:
        if event.query is not None and event.name != "search_empty":
            raise HTTPException(status_code=422, detail="query допустим только в search_empty")
    point = await session.scalar(select(Restaurant).where(Restaurant.public_id == batch.point))
    if point is None:
        raise HTTPException(status_code=404, detail="Restaurant not found")

    # Check admin events and permissions
    has_admin_events = any(event.name in ADMIN_EVENTS for event in batch.events)
    has_non_admin_events = any(event.name not in ADMIN_EVENTS for event in batch.events)

    if has_admin_events and (
        user is None or not await is_admin_of_venue(
            session, user.id, point.venue_id
        )
    ):
        raise HTTPException(
            status_code=403, detail="События администратора — только админам"
        )

    # Check if the point has a published menu only if there are non-admin events
    if has_non_admin_events:
        _, has_published_menu = await active_tabs(session, point.id, point.timezone)
        if not has_published_menu:
            raise HTTPException(status_code=404, detail="Restaurant not found")
    accepted, duplicates = await ingest_events(
        session,
        point=point,
        user=user,
        session_id=batch.session_id,
        platform=batch.platform,
        events=batch.events,
        now=datetime.now(UTC),
    )
    await session.commit()
    return BatchResult(accepted=accepted, duplicates=duplicates)


@router.get("/venues/{venue_id}/analytics")
async def get_venue_analytics(
    venue_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
    period: Annotated[Literal["today", "7d", "30d"], Query()] = "7d",
    point: Annotated[str | None, Query(max_length=32)] = None,
) -> dict:
    await require_admin_of_venue(session, current_user.id, venue_id)
    points = (await session.scalars(
        select(Restaurant).where(Restaurant.venue_id == venue_id).order_by(Restaurant.created_at)
    )).all()
    demo_venue = any(p.public_id in DEMO_PUBLIC_IDS for p in points)
    if point is not None:
        points = [p for p in points if p.public_id == point]
        if not points:
            raise HTTPException(status_code=404, detail="Restaurant not found")
    if not points:
        raise HTTPException(status_code=404, detail="Restaurant not found")
    report = await build_report(session, list(points), period, datetime.now(UTC))
    report["demo_venue"] = demo_venue
    return report
