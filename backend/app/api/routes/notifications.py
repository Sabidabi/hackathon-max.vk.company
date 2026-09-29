import uuid
from datetime import UTC, datetime, time, timedelta, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.permissions import require_venue_admin
from app.database import get_session
from app.models import (
    NotificationCampaign,
    NotificationDelivery,
    Restaurant,
    RestaurantFavorite,
    User,
)

router = APIRouter(tags=["notifications"])
MOSCOW = timezone(timedelta(hours=3), "Europe/Moscow")
MARKETING_COOLDOWN = timedelta(hours=72)
USER_WEEKLY_LIMIT = 2


class FavoriteResponse(BaseModel):
    is_favorite: bool
    notifications_enabled: bool


class FavoriteUpdate(BaseModel):
    is_favorite: bool
    notifications_enabled: bool = False


class CampaignPreviewResponse(BaseModel):
    eligible_recipients: int
    can_send_now: bool
    next_available_at: datetime | None


class CampaignCreate(BaseModel):
    title: str = Field(min_length=1, max_length=80)
    body: str = Field(min_length=1, max_length=500)
    idempotency_key: uuid.UUID

    @field_validator("title", "body")
    @classmethod
    def clean_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Текст не может быть пустым")
        return value.strip()


class CampaignResponse(BaseModel):
    id: uuid.UUID
    kind: Literal["menu_published", "marketing"]
    status: Literal["queued", "sending", "completed", "cancelled"]
    title: str
    body: str
    recipient_count: int
    sent_count: int
    failed_count: int
    created_at: datetime
    completed_at: datetime | None


def campaign_response(campaign: NotificationCampaign) -> CampaignResponse:
    return CampaignResponse.model_validate(campaign, from_attributes=True)


def _quiet_hours_end(now: datetime) -> datetime | None:
    local = now.astimezone(MOSCOW)
    if local.time() >= time(21):
        return datetime.combine(local.date() + timedelta(days=1), time(9), MOSCOW).astimezone(UTC)
    if local.time() < time(9):
        return datetime.combine(local.date(), time(9), MOSCOW).astimezone(UTC)
    return None


async def _require_campaign_access(
    session: AsyncSession,
    user: User,
    restaurant_id: uuid.UUID,
) -> None:
    await require_venue_admin(session, user.id, restaurant_id)


def _recently_saturated_users(now: datetime):
    return (
        select(NotificationDelivery.user_id)
        .join(
            NotificationCampaign,
            NotificationCampaign.id == NotificationDelivery.campaign_id,
        )
        .where(
            NotificationCampaign.kind == "marketing",
            NotificationDelivery.status == "sent",
            NotificationDelivery.sent_at >= now - timedelta(days=7),
        )
        .group_by(NotificationDelivery.user_id)
        .having(func.count(NotificationDelivery.id) >= USER_WEEKLY_LIMIT)
    )


async def eligible_recipient_ids(
    session: AsyncSession,
    restaurant_id: uuid.UUID,
    now: datetime,
) -> list[uuid.UUID]:
    return list(
        (
            await session.scalars(
                select(RestaurantFavorite.user_id).where(
                    RestaurantFavorite.restaurant_id == restaurant_id,
                    RestaurantFavorite.notifications_enabled.is_(True),
                    RestaurantFavorite.user_id.not_in(_recently_saturated_users(now)),
                )
            )
        ).all()
    )


async def next_marketing_time(
    session: AsyncSession,
    restaurant_id: uuid.UUID,
    now: datetime,
) -> datetime | None:
    last_campaign = await session.scalar(
        select(func.max(NotificationCampaign.created_at)).where(
            NotificationCampaign.restaurant_id == restaurant_id,
            NotificationCampaign.kind == "marketing",
            NotificationCampaign.status.in_(("queued", "sending", "completed")),
        )
    )
    limits = [candidate for candidate in (_quiet_hours_end(now),) if candidate is not None]
    if last_campaign is not None and last_campaign + MARKETING_COOLDOWN > now:
        limits.append(last_campaign + MARKETING_COOLDOWN)
    return max(limits) if limits else None


async def enqueue_menu_published_notification(
    session: AsyncSession,
    *,
    restaurant: Restaurant,
    menu_version_id: uuid.UUID,
    actor_id: uuid.UUID,
    item_count: int,
) -> None:
    event_key = f"menu-published:{menu_version_id}"
    if await session.scalar(
        select(NotificationCampaign.id).where(NotificationCampaign.event_key == event_key)
    ):
        return
    campaign = NotificationCampaign(
        restaurant_id=restaurant.id,
        created_by_id=actor_id,
        source_menu_version_id=menu_version_id,
        event_key=event_key,
        kind="menu_published",
        status="queued",
        title="Меню опубликовано",
        body=f"«{restaurant.name}»: новая версия меню, позиций — {item_count}.",
        recipient_count=1,
    )
    session.add(campaign)
    await session.flush()
    session.add(
        NotificationDelivery(
            campaign_id=campaign.id,
            user_id=restaurant.owner_id,
            status="pending",
        )
    )


@router.get(
    "/public/restaurants/{public_id}/favorite",
    response_model=FavoriteResponse,
)
async def get_favorite(
    public_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> FavoriteResponse:
    restaurant_id = await session.scalar(
        select(Restaurant.id).where(Restaurant.public_id == public_id)
    )
    if restaurant_id is None:
        raise HTTPException(status_code=404, detail="Restaurant not found")
    favorite = await session.get(RestaurantFavorite, (restaurant_id, current_user.id))
    return FavoriteResponse(
        is_favorite=favorite is not None,
        notifications_enabled=bool(favorite and favorite.notifications_enabled),
    )


@router.put(
    "/public/restaurants/{public_id}/favorite",
    response_model=FavoriteResponse,
)
async def update_favorite(
    public_id: str,
    payload: FavoriteUpdate,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> FavoriteResponse:
    restaurant_id = await session.scalar(
        select(Restaurant.id).where(Restaurant.public_id == public_id)
    )
    if restaurant_id is None:
        raise HTTPException(status_code=404, detail="Restaurant not found")
    favorite = await session.get(RestaurantFavorite, (restaurant_id, current_user.id))
    if not payload.is_favorite:
        if favorite is not None:
            await session.delete(favorite)
        await session.commit()
        return FavoriteResponse(is_favorite=False, notifications_enabled=False)
    if favorite is None:
        favorite = RestaurantFavorite(
            restaurant_id=restaurant_id,
            user_id=current_user.id,
        )
        session.add(favorite)
    favorite.notifications_enabled = payload.notifications_enabled
    await session.commit()
    return FavoriteResponse(
        is_favorite=True,
        notifications_enabled=favorite.notifications_enabled,
    )


@router.get(
    "/restaurants/{restaurant_id}/notifications/preview",
    response_model=CampaignPreviewResponse,
)
async def preview_campaign(
    restaurant_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> CampaignPreviewResponse:
    await _require_campaign_access(session, current_user, restaurant_id)
    now = datetime.now(UTC)
    next_at = await next_marketing_time(session, restaurant_id, now)
    recipients = await eligible_recipient_ids(session, restaurant_id, now)
    return CampaignPreviewResponse(
        eligible_recipients=len(recipients),
        can_send_now=next_at is None and bool(recipients),
        next_available_at=next_at,
    )


@router.get(
    "/restaurants/{restaurant_id}/notifications/campaigns",
    response_model=list[CampaignResponse],
)
async def list_campaigns(
    restaurant_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[CampaignResponse]:
    await _require_campaign_access(session, current_user, restaurant_id)
    campaigns = (
        await session.scalars(
            select(NotificationCampaign)
            .where(NotificationCampaign.restaurant_id == restaurant_id)
            .order_by(NotificationCampaign.created_at.desc())
            .limit(20)
        )
    ).all()
    return [campaign_response(campaign) for campaign in campaigns]


@router.post(
    "/restaurants/{restaurant_id}/notifications/campaigns",
    response_model=CampaignResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_campaign(
    restaurant_id: uuid.UUID,
    payload: CampaignCreate,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> CampaignResponse:
    await _require_campaign_access(session, current_user, restaurant_id)
    await session.scalar(
        select(Restaurant).where(Restaurant.id == restaurant_id).with_for_update()
    )
    event_key = f"marketing:{restaurant_id}:{payload.idempotency_key}"
    existing = await session.scalar(
        select(NotificationCampaign).where(NotificationCampaign.event_key == event_key)
    )
    if existing is not None:
        return campaign_response(existing)
    now = datetime.now(UTC)
    next_at = await next_marketing_time(session, restaurant_id, now)
    if next_at is not None:
        raise HTTPException(
            status_code=429,
            detail=f"Следующая рассылка доступна {next_at.isoformat()}",
        )
    recipients = await eligible_recipient_ids(session, restaurant_id, now)
    if not recipients:
        raise HTTPException(status_code=409, detail="Нет подписчиков для рассылки")
    campaign = NotificationCampaign(
        restaurant_id=restaurant_id,
        created_by_id=current_user.id,
        event_key=event_key,
        kind="marketing",
        status="queued",
        title=payload.title,
        body=payload.body,
        recipient_count=len(recipients),
    )
    session.add(campaign)
    await session.flush()
    session.add_all(
        [
            NotificationDelivery(campaign_id=campaign.id, user_id=user_id, status="pending")
            for user_id in recipients
        ]
    )
    await session.commit()
    return campaign_response(campaign)
