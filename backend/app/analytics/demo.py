"""Synthetic events for the demo venue only.

Refuses any venue that does not own a demo point. Every row is ``is_synthetic`` — the
cabinet shows «демо-данные» — and all sessions are anonymous web sessions (no fake MAX
users). Regenerating replaces the previous synthetic rows; real events are never touched.
"""

import random
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.analytics.vocabulary import normalize_query
from app.api.routes.point_items import point_menu_contents
from app.bot.localtime import to_local
from app.demo_data import DEMO_POINTS
from app.models import AnalyticsEmptySearch, AnalyticsEvent, Restaurant

DEMO_POINT_IDS = frozenset(point["public_id"] for point in DEMO_POINTS)
DEMO_EMPTY_SEARCHES = ("овсяный раф", "матча", "без глютена", "сырники", "какао")


class NotDemoVenue(RuntimeError):
    pass


async def seed_demo_events(
    session: AsyncSession, venue_id: uuid.UUID, *, days: int = 30, seed: int = 42,
    now: datetime | None = None,
) -> int:
    points = (await session.scalars(
        select(Restaurant).where(Restaurant.venue_id == venue_id)
    )).all()
    if not points or not any(point.public_id in DEMO_POINT_IDS for point in points):
        raise NotDemoVenue("Синтетические события — только для демо-заведения")
    now = now or datetime.now(UTC)
    rng = random.Random(seed)
    await session.execute(delete(AnalyticsEvent).where(
        AnalyticsEvent.venue_id == venue_id, AnalyticsEvent.is_synthetic.is_(True)
    ))
    await session.execute(delete(AnalyticsEmptySearch).where(
        AnalyticsEmptySearch.point_id.in_([point.id for point in points])
    ))
    rows: list[AnalyticsEvent] = []
    searches: dict[tuple[uuid.UUID, object, str], int] = {}
    for point in points:
        catalog = [
            (menu.id, item)
            for menu, _source, items in await point_menu_contents(session, point.id)
            for _section, item in items
            if item.item_key is not None
        ]
        if not catalog:
            continue
        # A few favourites draw most attention; the tail is long.
        weights = [1 / (index + 1) for index in range(len(catalog))]
        for back in range(days):
            day_start = now - timedelta(days=back)
            for _ in range(rng.randint(12, 38) if back else rng.randint(3, 9)):
                sid = uuid.uuid4()
                at = day_start - timedelta(minutes=rng.randint(0, 600))
                if at > now:
                    at = now

                def add(name: str, props: dict, minute: int, *, _sid=sid, _at=at, _p=point) -> None:
                    rows.append(AnalyticsEvent(
                        client_event_id=uuid.uuid4(), occurred_at=_at + timedelta(seconds=minute),
                        venue_id=_p.venue_id, point_id=_p.id, session_id=_sid,
                        platform="web", name=name, props=props, is_synthetic=True,
                    ))

                menu_id = catalog[0][0]
                add("app_open", {}, 0)
                add("menu_view", {"menu_id": str(menu_id)}, 1)
                if rng.random() < 0.18:
                    phrase = rng.choice(DEMO_EMPTY_SEARCHES)
                    add("search", {"query_len": len(phrase), "results": 0}, 5)
                    add("search_empty", {"query_len": len(phrase)}, 6)
                    day = (await to_local(session, point.timezone, at)).date()
                    key = (point.id, day, normalize_query(phrase))
                    searches[key] = searches.get(key, 0) + 1
                if rng.random() > 0.62:
                    continue
                viewed = rng.choices(catalog, weights=weights, k=rng.randint(1, 3))
                for offset, (item_menu, item) in enumerate(viewed):
                    props = {"menu_id": str(item_menu), "item_key": str(item.item_key),
                             "item_name": item.name}
                    add("item_view", props, 10 + offset)
                chosen = [pair for pair in viewed if rng.random() < 0.45]
                for offset, (item_menu, item) in enumerate(chosen):
                    add("item_add", {"menu_id": str(item_menu), "item_key": str(item.item_key),
                                     "item_name": item.name}, 20 + offset)
                if chosen and rng.random() < 0.45:
                    add("choice_shown", {"items": len(chosen)}, 40)
    session.add_all(rows)
    for (point_id, day, query), hits in searches.items():
        session.add(AnalyticsEmptySearch(point_id=point_id, day=day, query=query, hits=hits))
    await session.flush()
    return len(rows)
