"""Product events → bot outbox rows (Г1, Г2, А1–А3). Called inside the event's own
transaction; drafts never reach this module — only publication and the point stop-list do.
"""

import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.bot.links import app_button, callback_button, item_payload, manage_payload, menu_payload
from app.bot.localtime import after_quiet_hours
from app.bot.outbox import MARKETING, SERVICE, admin_recipients, enqueue
from app.models import (
    BotOutbox,
    ImportJob,
    ItemSubscription,
    Menu,
    PointItemOverride,
    Restaurant,
    RestaurantFavorite,
    User,
    Venue,
)

logger = logging.getLogger(__name__)
BACK_IN_STOCK_WINDOW = timedelta(days=7)
NEW_ITEMS_WINDOW = timedelta(days=7)
MAX_LISTED_ITEMS = 5


def _names(names: list[str]) -> str:
    quoted = [f"«{name}»" for name in names[:MAX_LISTED_ITEMS]]
    rest = len(names) - len(quoted)
    text = ", ".join(quoted)
    return f"{text} и ещё {rest}" if rest > 0 else text


def new_items_text(point_name: str, names: list[str]) -> str:
    label = "новинка" if len(names) == 1 else "новинки"
    return f"В «{point_name}» {label}: {_names(names)}."


def unsubscribe_point_button(point_id: uuid.UUID) -> dict:
    return callback_button("Не присылать", f"unsub_r:{point_id}")


def unsubscribe_item_button(point_id: uuid.UUID, item_key: uuid.UUID | str) -> dict:
    return callback_button("Не присылать", f"unsub_i:{point_id}:{item_key}")


async def first_point(session: AsyncSession, venue_id: uuid.UUID) -> Restaurant | None:
    return await session.scalar(
        select(Restaurant)
        .where(Restaurant.venue_id == venue_id)
        .order_by(Restaurant.created_at, Restaurant.id)
        .limit(1)
    )


# --- Guests: Г2 «новинка», Г1 «снова в наличии» ---


def _new_items_buttons(point: Restaurant, entries: list[dict]) -> list[list[dict]]:
    target = (
        item_payload(point.public_id, entries[0]["item_key"])
        if len(entries) == 1
        else menu_payload(point.public_id)
    )
    return [[app_button("Открыть", target)], [unsubscribe_point_button(point.id)]]


async def enqueue_new_items(
    session: AsyncSession,
    *,
    point: Restaurant,
    items: list[tuple[uuid.UUID, str]],
    source_key: str,
    now: datetime,
) -> int:
    """Г2 to every subscriber of the point: at most one message per point a week.

    A message still waiting (quiet hours or the weekly window) absorbs later novelties,
    so three publications in a week become one message listing all of them.
    """
    if not items:
        return 0
    subscribers = (await session.scalars(
        select(RestaurantFavorite.user_id).where(
            RestaurantFavorite.restaurant_id == point.id,
            RestaurantFavorite.notifications_enabled.is_(True),
        )
    )).all()
    created = 0
    earliest = await after_quiet_hours(session, point.timezone, now)
    for user_id in subscribers:
        waiting = await session.scalar(
            select(BotOutbox)
            .where(
                BotOutbox.kind == "g2_new_items",
                BotOutbox.user_id == user_id,
                BotOutbox.restaurant_id == point.id,
                BotOutbox.status == "pending",
            )
            .with_for_update()
        )
        if waiting is not None:
            known = {entry["item_key"] for entry in waiting.payload.get("items", [])}
            merged = list(waiting.payload.get("items", [])) + [
                {"item_key": str(key), "name": name}
                for key, name in items
                if str(key) not in known
            ]
            waiting.payload = {**waiting.payload, "items": merged}
            waiting.body = new_items_text(point.name, [entry["name"] for entry in merged])
            waiting.buttons = _new_items_buttons(point, merged)
            continue
        last_sent = await session.scalar(
            select(func.max(BotOutbox.sent_at)).where(
                BotOutbox.kind == "g2_new_items",
                BotOutbox.user_id == user_id,
                BotOutbox.restaurant_id == point.id,
                BotOutbox.status == "sent",
            )
        )
        not_before = earliest
        if last_sent is not None and last_sent + NEW_ITEMS_WINDOW > not_before:
            not_before = await after_quiet_hours(
                session, point.timezone, last_sent + NEW_ITEMS_WINDOW
            )
        entries = [{"item_key": str(key), "name": name} for key, name in items]
        if await enqueue(
            session,
            dedup_key=f"g2:{user_id}:{point.id}:{source_key}",
            kind="g2_new_items",
            category=MARKETING,
            user_id=user_id,
            restaurant_id=point.id,
            venue_id=point.venue_id,
            body=new_items_text(point.name, [name for _, name in items]),
            buttons=_new_items_buttons(point, entries),
            payload={"items": entries},
            not_before=not_before,
        ):
            created += 1
    return created


async def enqueue_back_in_stock(
    session: AsyncSession,
    *,
    point: Restaurant,
    item_key: uuid.UUID,
    item_name: str,
    now: datetime,
) -> int:
    """Г1 to guests who asked «Сообщить, когда появится»: once per position in 7 days."""
    subscribers = (await session.scalars(
        select(ItemSubscription.user_id).where(
            ItemSubscription.point_id == point.id, ItemSubscription.item_key == item_key
        )
    )).all()
    created = 0
    if not subscribers:
        return 0
    not_before = await after_quiet_hours(session, point.timezone, now)
    for user_id in subscribers:
        recent = await session.scalar(
            select(BotOutbox.id).where(
                BotOutbox.kind == "g1_back_in_stock",
                BotOutbox.user_id == user_id,
                BotOutbox.restaurant_id == point.id,
                BotOutbox.payload["item_key"].astext == str(item_key),
                BotOutbox.status.in_(("pending", "processing", "sent")),
                BotOutbox.created_at > now - BACK_IN_STOCK_WINDOW,
            ).limit(1)
        )
        if recent is not None:
            continue
        if await enqueue(
            session,
            dedup_key=f"g1:{user_id}:{point.id}:{item_key}:{now.date().isoformat()}",
            kind="g1_back_in_stock",
            category=MARKETING,
            user_id=user_id,
            restaurant_id=point.id,
            venue_id=point.venue_id,
            body=f"В «{point.name}» снова есть «{item_name}».",
            buttons=[
                [app_button("Открыть", item_payload(point.public_id, item_key))],
                [unsubscribe_item_button(point.id, item_key)],
            ],
            payload={"item_key": str(item_key), "name": item_name},
            not_before=not_before,
        ):
            created += 1
    return created


async def on_point_availability_changed(
    session: AsyncSession,
    *,
    point_id: uuid.UUID,
    item_key: uuid.UUID,
    item_name: str,
    was_available: bool,
    now_available: bool,
) -> None:
    """Stop-list of a point lifted: the position is back for this point's guests."""
    if was_available or not now_available:
        return
    point = await session.get(Restaurant, point_id)
    if point is not None:
        await enqueue_back_in_stock(
            session, point=point, item_key=item_key, item_name=item_name, now=datetime.now(UTC)
        )


# --- Publication: Г1, Г2 for guests and А3 for the other admins ---


async def on_menu_published(
    session: AsyncSession,
    *,
    menu: Menu,
    previous_version_id: uuid.UUID | None,
    published_version_id: uuid.UUID,
    actor: User,
    point_ids: list[uuid.UUID],
) -> None:
    from app.api.routes.me import count_unpublished_changes
    from app.api.routes.menus import read_version_sections

    now = datetime.now(UTC)
    new_sections = await read_version_sections(session, published_version_id)
    old_sections = (
        await read_version_sections(session, previous_version_id) if previous_version_id else []
    )
    old_items = {item.item_key: item for section in old_sections for item in section.items}
    new_items = [item for section in new_sections for item in section.items]
    points = list((await session.scalars(
        select(Restaurant)
        .where(Restaurant.id.in_(point_ids))
        .order_by(Restaurant.created_at, Restaurant.id)
    )).all()) if point_ids else []

    # The first publication of a menu is not «новинка»: there is nothing to compare with.
    if previous_version_id is not None and points:
        added = [
            (item.item_key, item.name)
            for item in new_items
            if item.item_key not in old_items and item.is_available
        ]
        returned = [
            item
            for item in new_items
            if item.is_available
            and item.item_key in old_items
            and not old_items[item.item_key].is_available
        ]
        stopped: set[tuple[uuid.UUID, uuid.UUID]] = set()
        if returned:
            stopped = {
                (row.point_id, row.item_key)
                for row in (await session.execute(
                    select(PointItemOverride.point_id, PointItemOverride.item_key).where(
                        PointItemOverride.point_id.in_(point_ids),
                        PointItemOverride.available.is_(False),
                    )
                )).all()
            }
        for point in points:
            await enqueue_new_items(
                session,
                point=point,
                items=added,
                source_key=str(published_version_id),
                now=now,
            )
            for item in returned:
                if (point.id, item.item_key) not in stopped:
                    await enqueue_back_in_stock(
                        session, point=point, item_key=item.item_key, item_name=item.name, now=now
                    )

    changes = count_unpublished_changes(new_sections, old_sections)
    target = points[0] if points else await first_point(session, menu.venue_id)
    if target is None:
        return
    for user_id in await admin_recipients(
        session, menu.venue_id, "a3_menu_published", exclude=[actor.id]
    ):
        await enqueue(
            session,
            dedup_key=f"a3:{published_version_id}:{user_id}",
            kind="a3_menu_published",
            category=SERVICE,
            user_id=user_id,
            venue_id=menu.venue_id,
            restaurant_id=target.id,
            body=(
                f"{actor.display_name} опубликовал(а) меню «{menu.title}»: "
                f"изменений — {changes}."
            ),
            buttons=[[app_button("Открыть меню", manage_payload(target.public_id, "menu"))]],
        )


# --- Admin events: А1 импорт готов, А2 новый администратор ---


async def on_import_finished(session: AsyncSession, job_id: uuid.UUID, text: str) -> None:
    row = (await session.execute(
        select(ImportJob.created_by_id, Restaurant)
        .join(Restaurant, Restaurant.id == ImportJob.restaurant_id)
        .where(ImportJob.id == job_id)
    )).one_or_none()
    if row is None:
        return
    creator_id, point = row
    if creator_id not in await admin_recipients(session, point.venue_id, "a1_import_ready"):
        return
    await enqueue(
        session,
        dedup_key=f"a1:{job_id}",
        kind="a1_import_ready",
        category=SERVICE,
        user_id=creator_id,
        venue_id=point.venue_id,
        restaurant_id=point.id,
        body=text,
        buttons=[[app_button("Проверить импорт", manage_payload(point.public_id, "import"))]],
    )


async def on_admin_joined(session: AsyncSession, *, venue_id: uuid.UUID, user: User) -> None:
    venue_name = await session.scalar(select(Venue.name).where(Venue.id == venue_id))
    point = await first_point(session, venue_id)
    if point is None:
        return
    for user_id in await admin_recipients(
        session, venue_id, "a2_admin_joined", exclude=[user.id]
    ):
        await enqueue(
            session,
            dedup_key=f"a2:{venue_id}:{user.id}:{user_id}:{datetime.now(UTC).date()}",
            kind="a2_admin_joined",
            category=SERVICE,
            user_id=user_id,
            venue_id=venue_id,
            restaurant_id=point.id,
            body=f"{user.display_name} теперь администратор «{venue_name}».",
            buttons=[[app_button("Администраторы", manage_payload(point.public_id, "team"))]],
        )


async def disable_marketing(session: AsyncSession, user_id: uuid.UUID) -> None:
    """/stop and «Отписаться от всего»: every guest subscription off, queued ones dropped."""
    await session.execute(
        update(RestaurantFavorite)
        .where(RestaurantFavorite.user_id == user_id)
        .values(notifications_enabled=False)
    )
    await session.execute(delete(ItemSubscription).where(ItemSubscription.user_id == user_id))
    await session.execute(
        update(BotOutbox)
        .where(
            BotOutbox.user_id == user_id,
            BotOutbox.category == MARKETING,
            BotOutbox.status == "pending",
        )
        .values(status="skipped", error_code="unsubscribed")
    )
