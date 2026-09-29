"""Batch ingestion of product events (P1-TASK-33).

A batch is idempotent by ``client_event_id``: a repeated batch inserts nothing and has no
side effects. Side effects of a *new* event: the normalised phrase of ``search_empty`` goes
into the empty-search aggregate (the phrase never enters ``props``), and for a signed-in
guest ``item_view`` / ``search_empty`` feed the bot demand signals А5/А6
(``demand_signal_hits``, distinct guests per local day).
"""

import time
import uuid
from collections import deque
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.analytics.vocabulary import normalize_query
from app.bot.localtime import to_local
from app.models import (
    AnalyticsEmptySearch,
    AnalyticsEvent,
    DemandSignalHit,
    Menu,
    Restaurant,
    User,
)

PAST_TOLERANCE = timedelta(hours=24)
FUTURE_TOLERANCE = timedelta(minutes=5)
RATE_WINDOW_SECONDS = 60.0
RATE_LIMIT_BATCHES = 30


class RateLimiter:
    """Sliding-window limit per key within one API process (a guard against a runaway
    client, not a security boundary)."""

    def __init__(self, limit: int = RATE_LIMIT_BATCHES, window: float = RATE_WINDOW_SECONDS):
        self.limit = limit
        self.window = window
        self._hits: dict[str, deque[float]] = {}

    def allow(self, key: str, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        hits = self._hits.setdefault(key, deque())
        while hits and now - hits[0] > self.window:
            hits.popleft()
        if len(hits) >= self.limit:
            return False
        hits.append(now)
        if len(self._hits) > 10_000:
            self._hits = {k: v for k, v in self._hits.items() if v and now - v[-1] <= self.window}
        return True


rate_limiter = RateLimiter()


def clamp_occurred_at(value: datetime | None, now: datetime) -> datetime:
    if value is None:
        return now
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    if value < now - PAST_TOLERANCE or value > now + FUTURE_TOLERANCE:
        return now
    return value


async def _published_versions(
    session: AsyncSession, venue_id: uuid.UUID, menu_ids: set[uuid.UUID]
) -> dict[uuid.UUID, uuid.UUID | None]:
    if not menu_ids:
        return {}
    rows = (await session.execute(
        select(Menu.id, Menu.current_published_version_id)
        .where(Menu.venue_id == venue_id, Menu.id.in_(menu_ids))
    )).all()
    return {row[0]: row[1] for row in rows}


def _uuid_or_none(value: object) -> uuid.UUID | None:
    if not isinstance(value, str):
        return None
    try:
        return uuid.UUID(value)
    except ValueError:
        return None


async def ingest_events(
    session: AsyncSession,
    *,
    point: Restaurant,
    user: User | None,
    session_id: uuid.UUID,
    platform: str,
    events: list,
    now: datetime | None = None,
) -> tuple[int, int]:
    """Stores new events of one batch; returns (accepted, duplicates). Caller commits."""
    now = now or datetime.now(UTC)
    menu_ids = {m for m in (_uuid_or_none(e.props.get("menu_id")) for e in events) if m}
    versions = await _published_versions(session, point.venue_id, menu_ids)
    accepted = 0
    for event in events:
        occurred_at = clamp_occurred_at(event.occurred_at, now)
        menu_id = _uuid_or_none(event.props.get("menu_id"))
        inserted = await session.scalar(
            insert(AnalyticsEvent)
            .values(
                client_event_id=event.client_event_id,
                occurred_at=occurred_at,
                venue_id=point.venue_id,
                point_id=point.id,
                menu_version_id=versions.get(menu_id) if menu_id else None,
                session_id=session_id,
                user_id=user.id if user else None,
                platform=platform,
                name=event.name,
                props=event.props,
            )
            .on_conflict_do_nothing(index_elements=["client_event_id"])
            .returning(AnalyticsEvent.id)
        )
        if inserted is None:
            continue
        accepted += 1
        if event.name not in ("item_view", "search_empty"):
            continue
        day = (await to_local(session, point.timezone, occurred_at)).date()
        if event.name == "search_empty":
            phrase = normalize_query(event.query or "")
            if not phrase:
                continue
            await session.execute(
                insert(AnalyticsEmptySearch)
                .values(point_id=point.id, day=day, query=phrase, hits=1)
                .on_conflict_do_update(
                    index_elements=["point_id", "day", "query"],
                    set_={"hits": AnalyticsEmptySearch.hits + 1},
                )
            )
            signal = ("empty_search", phrase)
        else:
            item_key = _uuid_or_none(event.props.get("item_key"))
            if item_key is None:
                continue
            signal = ("item_open", str(item_key))
        # А5/А6 count distinct guests: only a signed-in MAX user is a known guest.
        if user is not None:
            await session.execute(
                insert(DemandSignalHit)
                .values(point_id=point.id, day=day, kind=signal[0], key=signal[1],
                        user_id=user.id)
                .on_conflict_do_nothing()
            )
    return accepted, len(events) - accepted
