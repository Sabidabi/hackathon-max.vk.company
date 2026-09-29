"""Worker duties of analytics: daily roll-up of closed local days and the 180-day retention
of raw events (P1-DOC-10: raw events 180 days, daily aggregates kept indefinitely)."""

from datetime import datetime, timedelta

from sqlalchemy import delete, distinct, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.analytics.report import day_metrics
from app.bot.localtime import to_local
from app.models import AnalyticsDaily, AnalyticsEvent, Restaurant

RAW_RETENTION = timedelta(days=180)
ROLLUP_LOOKBACK_DAYS = 3


async def rollup_days(session: AsyncSession, now: datetime) -> int:
    """Rolls up the last closed local days of every point that has recent events.

    Recalculates the last 2 closed days to include late-arriving events.
    Older days are only written if not already present.
    """
    recent = now - timedelta(days=ROLLUP_LOOKBACK_DAYS + 1)
    point_ids = (await session.scalars(
        select(distinct(AnalyticsEvent.point_id)).where(AnalyticsEvent.occurred_at >= recent)
    )).all()
    written = 0
    for point_id in point_ids:
        point = await session.get(Restaurant, point_id)
        if point is None:
            continue
        today = (await to_local(session, point.timezone, now)).date()
        for back in range(1, ROLLUP_LOOKBACK_DAYS + 1):
            day = today - timedelta(days=back)
            # Recalculate the last 2 days (delete and rebuild)
            if back <= 2:
                await session.execute(
                    delete(AnalyticsDaily).where(
                        AnalyticsDaily.point_id == point.id,
                        AnalyticsDaily.day == day,
                    )
                )
            elif await session.get(AnalyticsDaily, (point.id, day)) is not None:
                # For older days, skip if already present
                continue
            metrics = await day_metrics(session, point, day)
            await session.execute(
                insert(AnalyticsDaily)
                .values(point_id=point.id, day=day, metrics=metrics)
                .on_conflict_do_nothing()
            )
            written += 1
    return written


async def purge_raw_events(session: AsyncSession, now: datetime) -> int:
    result = await session.execute(
        delete(AnalyticsEvent).where(AnalyticsEvent.occurred_at < now - RAW_RETENTION)
    )
    return result.rowcount or 0
