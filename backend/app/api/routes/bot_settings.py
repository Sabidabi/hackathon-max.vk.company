"""Notification settings of the signed-in user and guest subscriptions.

Guest notifications need explicit consent per point or per position; admin types А1–А8
are on by default and switched off per venue. Every change applies on the server at once.
"""

import re
import uuid
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.point_items import points_with_item
from app.auth.dependencies import get_current_user
from app.auth.permissions import require_admin_of_venue
from app.bot.events import disable_marketing, first_point
from app.bot.localtime import to_local
from app.config import Settings, get_settings
from app.database import get_session
from app.models import (
    ADMIN_NOTIFICATION_KINDS,
    AdminNotificationMute,
    BotDialog,
    DemandSignalHit,
    ItemSubscription,
    Restaurant,
    RestaurantFavorite,
    User,
    Venue,
    VenueMember,
)

router = APIRouter(tags=["notifications"])
AdminKind = Literal[
    "a1_import_ready",
    "a2_admin_joined",
    "a3_menu_published",
    "a4_draft_stale",
    "a5_stop_list_demand",
    "a6_empty_searches",
    "a7_weekly_summary",
    "a8_point_message",
]
SPACES = re.compile(r"\s+")


class BotAccess(BaseModel):
    # The user started a dialog with the bot: without it nothing is sent.
    messages_allowed: bool
    # Opens the bot dialog (``/start`` with a payload); None when the bot is not configured.
    allow_link: str | None
    support_link: str | None


class VenueSubscription(BaseModel):
    restaurant_id: uuid.UUID
    public_id: str
    name: str
    notifications_enabled: bool


class ItemSubscriptionEntry(BaseModel):
    point_id: uuid.UUID
    public_id: str
    point_name: str
    item_key: uuid.UUID
    item_name: str


class AdminKindState(BaseModel):
    kind: AdminKind
    enabled: bool


class AdminVenueSettings(BaseModel):
    venue_id: uuid.UUID
    name: str
    public_id: str
    kinds: list[AdminKindState]


class NotificationSettings(BaseModel):
    bot: BotAccess
    venues: list[VenueSubscription]
    items: list[ItemSubscriptionEntry]
    admin: list[AdminVenueSettings]


class EnabledPayload(BaseModel):
    enabled: bool


class ItemSubscriptionState(BaseModel):
    subscribed: bool


class SignalPayload(BaseModel):
    kind: Literal["item_open", "empty_search"]
    key: str = Field(min_length=1, max_length=200)


def bot_link(settings: Settings, payload: str) -> str | None:
    username = settings.max_bot_username.strip().lstrip("@")
    return f"https://max.ru/{username}?start={payload}" if username else None


async def _point(session: AsyncSession, public_id: str) -> Restaurant:
    point = await session.scalar(select(Restaurant).where(Restaurant.public_id == public_id))
    if point is None:
        raise HTTPException(status_code=404, detail="Restaurant not found")
    return point


@router.get("/me/notifications", response_model=NotificationSettings)
async def get_notification_settings(
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> NotificationSettings:
    dialog = await session.get(BotDialog, current_user.max_user_id)
    venues = (await session.execute(
        select(RestaurantFavorite.notifications_enabled, Restaurant)
        .join(Restaurant, Restaurant.id == RestaurantFavorite.restaurant_id)
        .where(RestaurantFavorite.user_id == current_user.id)
        .order_by(Restaurant.name)
    )).all()
    items = (await session.execute(
        select(ItemSubscription, Restaurant)
        .join(Restaurant, Restaurant.id == ItemSubscription.point_id)
        .where(ItemSubscription.user_id == current_user.id)
        .order_by(ItemSubscription.created_at.desc())
    )).all()
    memberships = (await session.execute(
        select(Venue)
        .join(VenueMember, VenueMember.venue_id == Venue.id)
        .where(VenueMember.user_id == current_user.id)
        .order_by(VenueMember.created_at)
    )).scalars().all()
    muted = {
        (row.venue_id, row.kind)
        for row in (await session.scalars(select(AdminNotificationMute).where(
            AdminNotificationMute.user_id == current_user.id
        ))).all()
    }
    admin = []
    for venue in memberships:
        point = await first_point(session, venue.id)
        if point is None:
            continue
        admin.append(AdminVenueSettings(
            venue_id=venue.id,
            name=venue.name,
            public_id=point.public_id,
            kinds=[
                AdminKindState(kind=kind, enabled=(venue.id, kind) not in muted)
                for kind in ADMIN_NOTIFICATION_KINDS
            ],
        ))
    return NotificationSettings(
        bot=BotAccess(
            messages_allowed=dialog is not None and dialog.stopped_at is None,
            allow_link=bot_link(settings, "settings"),
            support_link=bot_link(settings, "support"),
        ),
        venues=[
            VenueSubscription(
                restaurant_id=point.id,
                public_id=point.public_id,
                name=point.name,
                notifications_enabled=enabled,
            )
            for enabled, point in venues
        ],
        items=[
            ItemSubscriptionEntry(
                point_id=point.id,
                public_id=point.public_id,
                point_name=point.name,
                item_key=subscription.item_key,
                item_name=subscription.item_name,
            )
            for subscription, point in items
        ],
        admin=admin,
    )


@router.put("/me/notifications/venues/{restaurant_id}", status_code=204)
async def set_venue_subscription(
    restaurant_id: uuid.UUID,
    payload: EnabledPayload,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> Response:
    """«Узнавать о новинках» for a favourite point (only favourites can be subscribed)."""
    favorite = await session.get(RestaurantFavorite, (restaurant_id, current_user.id))
    if favorite is None:
        raise HTTPException(status_code=404, detail="Заведения нет в избранном")
    favorite.notifications_enabled = payload.enabled
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/me/notifications/items/{point_id}/{item_key}", status_code=204)
async def delete_item_subscription(
    point_id: uuid.UUID,
    item_key: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> Response:
    await session.execute(delete(ItemSubscription).where(
        ItemSubscription.user_id == current_user.id,
        ItemSubscription.point_id == point_id,
        ItemSubscription.item_key == item_key,
    ))
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/me/notifications/admin/{venue_id}/{kind}", status_code=204)
async def set_admin_kind(
    venue_id: uuid.UUID,
    kind: AdminKind,
    payload: EnabledPayload,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> Response:
    await require_admin_of_venue(session, current_user.id, venue_id)
    if payload.enabled:
        await session.execute(delete(AdminNotificationMute).where(
            AdminNotificationMute.user_id == current_user.id,
            AdminNotificationMute.venue_id == venue_id,
            AdminNotificationMute.kind == kind,
        ))
    else:
        await session.execute(
            insert(AdminNotificationMute)
            .values(user_id=current_user.id, venue_id=venue_id, kind=kind)
            .on_conflict_do_nothing()
        )
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/me/notifications/stop", status_code=204)
async def stop_all_marketing(
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> Response:
    """«Отписаться от всего» — the same as /stop in the bot."""
    await disable_marketing(session, current_user.id)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get(
    "/public/restaurants/{public_id}/items/{item_key}/subscription",
    response_model=ItemSubscriptionState,
)
async def get_item_subscription(
    public_id: str,
    item_key: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> ItemSubscriptionState:
    point = await _point(session, public_id)
    row = await session.get(ItemSubscription, (current_user.id, point.id, item_key))
    return ItemSubscriptionState(subscribed=row is not None)


@router.put(
    "/public/restaurants/{public_id}/items/{item_key}/subscription",
    response_model=ItemSubscriptionState,
)
async def set_item_subscription(
    public_id: str,
    item_key: uuid.UUID,
    payload: ItemSubscriptionState,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> ItemSubscriptionState:
    """«Сообщить, когда появится» on an unavailable position of this point."""
    point = await _point(session, public_id)
    if not payload.subscribed:
        await session.execute(delete(ItemSubscription).where(
            ItemSubscription.user_id == current_user.id,
            ItemSubscription.point_id == point.id,
            ItemSubscription.item_key == item_key,
        ))
        await session.commit()
        return ItemSubscriptionState(subscribed=False)
    item = (await points_with_item(session, [point.id], item_key)).get(point.id)
    if item is None:
        raise HTTPException(status_code=404, detail="Позиция не найдена")
    await session.execute(
        insert(ItemSubscription)
        .values(user_id=current_user.id, point_id=point.id, item_key=item_key,
                item_name=item.name)
        .on_conflict_do_nothing()
    )
    await session.commit()
    return ItemSubscriptionState(subscribed=True)


@router.post("/public/restaurants/{public_id}/signals", status_code=204)
async def record_signal(
    public_id: str,
    payload: SignalPayload,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> Response:
    """Demand signals for А5/А6: one row per guest, point, local day and position/phrase."""
    point = await _point(session, public_id)
    if payload.kind == "item_open":
        try:
            key = str(uuid.UUID(payload.key))
        except ValueError as error:
            raise HTTPException(status_code=422, detail="Неверный ключ позиции") from error
    else:
        key = SPACES.sub(" ", payload.key).strip().lower()[:100]
        if not key:
            raise HTTPException(status_code=422, detail="Пустой запрос")
    day = (await to_local(session, point.timezone, datetime.now(UTC))).date()
    await session.execute(
        insert(DemandSignalHit)
        .values(point_id=point.id, day=day, kind=payload.kind, key=key, user_id=current_user.id)
        .on_conflict_do_nothing()
    )
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
