"""Periodic admin signals (А4–А7), run by the worker every few minutes.

Each signal is keyed by venue and period in the outbox, so however often the check runs,
a venue gets at most one А5 a day, one А6 and one А7 a week and one А4 per stale draft.
Numbers only — the weekly summary has no AI conclusion (P1-PLAN-13 scope).
"""

import uuid
from datetime import date, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.bot.links import app_button, manage_payload
from app.bot.localtime import after_quiet_hours, to_local
from app.bot.outbox import SERVICE, admin_recipients, enqueue
from app.models import (
    DemandSignalHit,
    Menu,
    MenuVersion,
    Restaurant,
    RestaurantFavorite,
    Venue,
)

STALE_DRAFT = timedelta(hours=24)
STOP_LIST_DEMAND_THRESHOLD = 10
EMPTY_SEARCH_THRESHOLD = 5
DEMAND_CHECK_HOUR = 18
EMPTY_SEARCH_CHECK_HOUR = 12
SUMMARY_HOUR = 10


def _week(day: date) -> str:
    year, week, _ = day.isocalendar()
    return f"{year}-W{week:02d}"


async def _notify_admins(
    session: AsyncSession,
    *,
    venue_id: uuid.UUID,
    point: Restaurant,
    kind: str,
    key: str,
    body: str,
    button: dict,
    now: datetime,
) -> int:
    not_before = await after_quiet_hours(session, point.timezone, now)
    created = 0
    for user_id in await admin_recipients(session, venue_id, kind):
        if await enqueue(
            session,
            dedup_key=f"{key}:{user_id}",
            kind=kind,
            category=SERVICE,
            user_id=user_id,
            venue_id=venue_id,
            restaurant_id=point.id,
            body=body,
            buttons=[[button]],
            not_before=not_before,
        ):
            created += 1
    return created


async def check_stale_drafts(
    session: AsyncSession, venue: Venue, point: Restaurant, now: datetime
) -> int:
    """А4: a draft with changes nobody published for more than 24 hours."""
    from app.api.routes.me import count_unpublished_changes
    from app.api.routes.menus import read_version_sections

    created = 0
    menus = (await session.scalars(
        select(Menu).where(Menu.venue_id == venue.id, Menu.archived_at.is_(None))
    )).all()
    for menu in menus:
        if menu.updated_at is None or menu.updated_at > now - STALE_DRAFT:
            continue
        draft_id = await session.scalar(
            select(MenuVersion.id)
            .where(MenuVersion.menu_id == menu.id, MenuVersion.status == "draft")
            .order_by(MenuVersion.version.desc())
            .limit(1)
        )
        if draft_id is None or menu.current_published_version_id is None:
            continue
        changes = count_unpublished_changes(
            await read_version_sections(session, draft_id),
            await read_version_sections(session, menu.current_published_version_id),
        )
        if not changes:
            continue
        created += await _notify_admins(
            session,
            venue_id=venue.id,
            point=point,
            kind="a4_draft_stale",
            key=f"a4:{draft_id}:{int(menu.updated_at.timestamp())}",
            body=(
                f"В «{venue.name}» неопубликованных изменений: {changes} "
                f"(меню «{menu.title}»)."
            ),
            button=app_button("Опубликовать", manage_payload(point.public_id, "menu")),
            now=now,
        )
    return created


async def check_stop_list_demand(
    session: AsyncSession, venue: Venue, points: list[Restaurant], day: date, now: datetime
) -> int:
    """А5: today ≥ 10 guests opened a position that is on the stop-list of that point."""
    from app.api.routes.point_items import point_menu_contents
    from app.menu_library import point_overrides

    best: tuple[int, Restaurant, str] | None = None
    for point in points:
        counts = dict((await session.execute(
            select(DemandSignalHit.key, func.count())
            .where(
                DemandSignalHit.point_id == point.id,
                DemandSignalHit.day == day,
                DemandSignalHit.kind == "item_open",
            )
            .group_by(DemandSignalHit.key)
            .having(func.count() >= STOP_LIST_DEMAND_THRESHOLD)
        )).all())
        if not counts:
            continue
        overrides = await point_overrides(session, point.id)
        for _menu, _source, items in await point_menu_contents(session, point.id):
            for _section, item in items:
                count = counts.get(str(item.item_key))
                if not count:
                    continue
                override = overrides.get(item.item_key)
                available = (
                    override.available
                    if override is not None and override.available is not None
                    else item.is_available
                )
                if not available and (best is None or count > best[0]):
                    best = (count, point, item.name)
    if best is None:
        return 0
    count, point, name = best
    return await _notify_admins(
        session,
        venue_id=venue.id,
        point=point,
        kind="a5_stop_list_demand",
        key=f"a5:{venue.id}:{day.isoformat()}",
        body=(
            f"Сегодня {count} гостей открывали «{name}» в «{point.name}», "
            "а позиция в стоп-листе."
        ),
        button=app_button("Открыть позицию", manage_payload(point.public_id, "menu")),
        now=now,
    )


async def check_empty_searches(
    session: AsyncSession, venue: Venue, points: list[Restaurant], day: date, now: datetime
) -> int:
    """А6: a phrase guests searched ≥ 5 times in 7 days without a result."""
    row = (await session.execute(
        select(DemandSignalHit.key, func.count().label("hits"))
        .where(
            DemandSignalHit.point_id.in_([point.id for point in points]),
            DemandSignalHit.kind == "empty_search",
            DemandSignalHit.day > day - timedelta(days=7),
            DemandSignalHit.day <= day,
        )
        .group_by(DemandSignalHit.key)
        .having(func.count() >= EMPTY_SEARCH_THRESHOLD)
        .order_by(func.count().desc(), DemandSignalHit.key)
        .limit(1)
    )).first()
    if row is None:
        return 0
    point = points[0]
    return await _notify_admins(
        session,
        venue_id=venue.id,
        point=point,
        kind="a6_empty_searches",
        key=f"a6:{venue.id}:{_week(day)}",
        body=f"Гости искали «{row.key}» {row.hits} раз за неделю — такой позиции нет.",
        button=app_button("Добавить позицию", manage_payload(point.public_id, "menu")),
        now=now,
    )


async def weekly_numbers(
    session: AsyncSession, venue: Venue, points: list[Restaurant], day: date, now: datetime
) -> tuple[int, int, int]:
    point_ids = [point.id for point in points]
    guests = await session.scalar(
        select(func.count(func.distinct(DemandSignalHit.user_id))).where(
            DemandSignalHit.point_id.in_(point_ids),
            DemandSignalHit.day > day - timedelta(days=7),
        )
    ) or 0
    new_favorites = await session.scalar(
        select(func.count()).select_from(RestaurantFavorite).where(
            RestaurantFavorite.restaurant_id.in_(point_ids),
            RestaurantFavorite.created_at > now - timedelta(days=7),
        )
    ) or 0
    publications = await session.scalar(
        select(func.count(MenuVersion.id))
        .join(Menu, Menu.id == MenuVersion.menu_id)
        .where(
            Menu.venue_id == venue.id,
            MenuVersion.published_at > now - timedelta(days=7),
        )
    ) or 0
    return guests, new_favorites, publications


async def check_weekly_summary(
    session: AsyncSession, venue: Venue, points: list[Restaurant], day: date, now: datetime
) -> int:
    """А7: Monday 10:00 local, three numbers of the past week."""
    guests, new_favorites, publications = await weekly_numbers(
        session, venue, points, day, now
    )
    point = points[0]
    return await _notify_admins(
        session,
        venue_id=venue.id,
        point=point,
        kind="a7_weekly_summary",
        key=f"a7:{venue.id}:{_week(day)}",
        body=(
            f"«{venue.name}» за неделю: гостей открывали позиции — {guests}, "
            f"новых в избранном — {new_favorites}, публикаций меню — {publications}."
        ),
        button=app_button("Аналитика", manage_payload(point.public_id, "analytics")),
        now=now,
    )


async def run_scheduled_checks(session: AsyncSession, now: datetime) -> int:
    created = 0
    venues = (await session.scalars(select(Venue).order_by(Venue.created_at))).all()
    for venue in venues:
        points = list((await session.scalars(
            select(Restaurant)
            .where(Restaurant.venue_id == venue.id)
            .order_by(Restaurant.created_at, Restaurant.id)
        )).all())
        if not points:
            continue
        local = await to_local(session, points[0].timezone, now)
        day = local.date()
        created += await check_stale_drafts(session, venue, points[0], now)
        if local.hour >= DEMAND_CHECK_HOUR:
            created += await check_stop_list_demand(session, venue, points, day, now)
        if local.hour >= EMPTY_SEARCH_CHECK_HOUR:
            created += await check_empty_searches(session, venue, points, day, now)
        if local.weekday() == 0 and local.hour >= SUMMARY_HOUR:
            created += await check_weekly_summary(session, venue, points, day, now)
    return created
