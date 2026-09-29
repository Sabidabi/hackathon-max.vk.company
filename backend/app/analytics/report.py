"""Analytics report of a venue or one point by local calendar days.

A period is ``[local midnight of the first day, local midnight after today)`` in the time zone
of every point, so an event at 21:30 UTC in UTC+3 belongs to the next local day. Raw events
are kept 180 days, so 30-day periods are always read from them.
"""

from dataclasses import dataclass
from datetime import date, datetime, timedelta

from sqlalchemy import and_, case, distinct, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.bot.localtime import from_local, to_local
from app.models import AnalyticsEmptySearch, AnalyticsEvent, Restaurant

PERIOD_DAYS = {"today": 1, "7d": 7, "30d": 30}
FUNNEL = ("menu_view", "item_view", "item_add", "choice_shown")
TOP_LIMIT = 5
LOOKED_MIN_VIEWS = 5
LOOKED_MAX_RATE = 0.1
EMPTY_SEARCH_LIMIT = 8


@dataclass(frozen=True)
class Window:
    point: Restaurant
    first_day: date
    last_day: date
    start: datetime
    end: datetime


async def point_window(
    session: AsyncSession, point: Restaurant, days: int, now: datetime
) -> Window:
    today = (await to_local(session, point.timezone, now)).date()
    first = today - timedelta(days=days - 1)
    start = await from_local(session, point.timezone, datetime.combine(first, datetime.min.time()))
    end = await from_local(
        session, point.timezone, datetime.combine(today + timedelta(days=1), datetime.min.time())
    )
    return Window(point, first, today, start, end)


def _scope(windows: list[Window]):
    return or_(*[
        and_(
            AnalyticsEvent.point_id == w.point.id,
            AnalyticsEvent.occurred_at >= w.start,
            AnalyticsEvent.occurred_at < w.end,
        )
        for w in windows
    ])


def _shifted(windows: list[Window], start_days: int, end_days: int) -> list[Window]:
    """Windows ending ``end_days`` and starting ``start_days`` before each period end."""
    return [
        Window(w.point, w.first_day, w.last_day, w.end - timedelta(days=start_days),
               w.end - timedelta(days=end_days))
        for w in windows
    ]


def _pct(part: int, whole: int) -> int | None:
    return round(part * 100 / whole) if whole else None


async def build_report(
    session: AsyncSession, points: list[Restaurant], period: str, now: datetime
) -> dict:
    days = PERIOD_DAYS[period]
    windows = [await point_window(session, point, days, now) for point in points]
    scope = _scope(windows)
    event = AnalyticsEvent

    counts = dict((await session.execute(
        select(event.name, func.count(distinct(event.session_id)))
        .where(scope, event.name.in_(FUNNEL + ("rec_impression", "rec_click")))
        .group_by(event.name)
    )).all())
    funnel = []
    previous: int | None = None
    for name in FUNNEL:
        value = int(counts.get(name, 0))
        funnel.append({
            "step": name,
            "sessions": value,
            "rate": None if previous is None else _pct(value, previous),
        })
        previous = value

    guests = (await session.execute(
        select(
            func.count(distinct(event.user_id)),
            func.count(distinct(case((event.user_id.is_(None), event.session_id)))),
            func.bool_or(event.is_synthetic),
        ).where(scope)
    )).one()
    max_guests, web_sessions, synthetic = int(guests[0]), int(guests[1]), bool(guests[2])

    per_session = (
        select(
            event.session_id,
            func.sum(case((event.name == "item_add", 1), else_=0)).label("adds"),
            func.sum(case((event.name == "item_remove", 1), else_=0)).label("removes"),
        )
        .where(scope, event.name.in_(("item_add", "item_remove")))
        .group_by(event.session_id)
        .subquery()
    )
    choice = (await session.execute(
        select(
            func.count(),
            func.avg(func.greatest(per_session.c.adds - per_session.c.removes, 1)),
        ).where(per_session.c.adds > 0)
    )).one()
    choices = int(choice[0] or 0)
    avg_size = round(float(choice[1]), 1) if choice[1] is not None else None
    opened = int(counts.get("menu_view", 0))

    item_key = event.props["item_key"].astext
    item_rows = (await session.execute(
        select(
            item_key.label("key"),
            func.max(event.props["item_name"].astext).label("name"),
            func.count(distinct(case((event.name == "item_view", event.session_id))))
            .label("views"),
            func.count(distinct(case((event.name == "item_add", event.session_id))))
            .label("adds"),
        )
        .where(scope, event.name.in_(("item_view", "item_add")), item_key.is_not(None))
        .group_by(item_key)
    )).all()
    items = [
        {"item_key": row.key, "name": row.name or "Позиция", "views": int(row.views),
         "adds": int(row.adds)}
        for row in item_rows
    ]
    top_viewed = sorted(
        (i for i in items if i["views"]), key=lambda i: (-i["views"], i["name"])
    )[:TOP_LIMIT]
    top_chosen = sorted(
        (i for i in items if i["adds"]), key=lambda i: (-i["adds"], i["name"])
    )[:TOP_LIMIT]
    looked_not_chosen = sorted(
        (
            i for i in items
            if i["views"] >= LOOKED_MIN_VIEWS and i["adds"] / i["views"] < LOOKED_MAX_RATE
        ),
        key=lambda i: (-i["views"], i["name"]),
    )[:TOP_LIMIT]

    search = AnalyticsEmptySearch
    search_scope = or_(*[
        and_(search.point_id == w.point.id, search.day >= w.first_day, search.day <= w.last_day)
        for w in windows
    ])
    empty_searches = [
        {"query": row[0], "hits": int(row[1])}
        for row in (await session.execute(
            select(search.query, func.sum(search.hits))
            .where(search_scope)
            .group_by(search.query)
            .order_by(func.sum(search.hits).desc(), search.query)
            .limit(EMPTY_SEARCH_LIMIT)
        )).all()
    ]

    rec_adds = await session.scalar(
        select(func.count(distinct(event.session_id)))
        .where(scope, event.name == "item_add", event.props["source"].astext == "rec")
    ) or 0

    local_day = func.date(func.timezone(Restaurant.timezone, event.occurred_at))
    daily_rows = dict((await session.execute(
        select(local_day, func.count(distinct(event.session_id)))
        .join(Restaurant, Restaurant.id == event.point_id)
        .where(scope, event.name == "menu_view")
        .group_by(local_day)
    )).all())
    first_day = min(w.first_day for w in windows)
    last_day = max(w.last_day for w in windows)
    daily = [
        {"day": (first_day + timedelta(days=n)).isoformat(),
         "sessions": int(daily_rows.get(first_day + timedelta(days=n), 0))}
        for n in range((last_day - first_day).days + 1)
    ]

    # D7 return: MAX guests active 7–13 days before the period end who came back in the
    # last 7 days (anonymous web sessions cannot be followed across launches).
    base_users = (
        select(event.user_id)
        .where(_scope(_shifted(windows, 14, 7)), event.user_id.is_not(None))
        .distinct()
    )
    base = int(await session.scalar(select(func.count()).select_from(base_users.subquery())) or 0)
    returned = int(await session.scalar(
        select(func.count(distinct(event.user_id)))
        .where(_scope(_shifted(windows, 7, 0)), event.user_id.in_(base_users))
    ) or 0)

    return {
        "period": period,
        "from_day": first_day.isoformat(),
        "to_day": last_day.isoformat(),
        "has_data": bool(max_guests or web_sessions),
        "synthetic": synthetic,
        "guests": {"max_users": max_guests, "web_sessions": web_sessions},
        "choices": choices,
        "choice_rate": _pct(choices, opened),
        "avg_choice_size": avg_size,
        "funnel": funnel,
        "daily": daily,
        "top_viewed": top_viewed,
        "top_chosen": top_chosen,
        "looked_not_chosen": looked_not_chosen,
        "empty_searches": empty_searches,
        "recommendations": {
            "impressions": int(counts.get("rec_impression", 0)),
            "clicks": int(counts.get("rec_click", 0)),
            "adds": int(rec_adds),
        },
        "d7_return": {"base": base, "returned": returned, "rate": _pct(returned, base)},
    }


async def day_metrics(session: AsyncSession, point: Restaurant, day: date) -> dict:
    """Counts of one closed local day of a point, for the long-term roll-up."""
    start = await from_local(session, point.timezone, datetime.combine(day, datetime.min.time()))
    end = await from_local(
        session, point.timezone, datetime.combine(day + timedelta(days=1), datetime.min.time())
    )
    event = AnalyticsEvent
    scope = and_(event.point_id == point.id, event.occurred_at >= start, event.occurred_at < end)
    sessions = dict((await session.execute(
        select(event.name, func.count(distinct(event.session_id)))
        .where(scope).group_by(event.name)
    )).all())
    guests = (await session.execute(
        select(
            func.count(distinct(event.user_id)),
            func.count(distinct(case((event.user_id.is_(None), event.session_id)))),
        ).where(scope)
    )).one()
    return {
        "sessions_by_event": {name: int(value) for name, value in sessions.items()},
        "max_users": int(guests[0]),
        "web_sessions": int(guests[1]),
    }
