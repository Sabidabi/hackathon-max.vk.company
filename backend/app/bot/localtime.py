"""Local wall-clock time of a point, computed by PostgreSQL like the rest of the product
(``menu_library.local_time``): no tz database is needed in the Python image."""

from datetime import datetime, timedelta

from sqlalchemy import DateTime, func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import DEFAULT_TIMEZONE

QUIET_FROM_HOUR = 22
QUIET_TO_HOUR = 9


async def to_local(session: AsyncSession, timezone: str | None, at: datetime) -> datetime:
    """Naive local datetime of ``at`` in the zone."""
    value = await session.scalar(
        select(func.timezone(timezone or DEFAULT_TIMEZONE, literal(at, DateTime(timezone=True))))
    )
    assert value is not None
    return value


async def from_local(session: AsyncSession, timezone: str | None, local: datetime) -> datetime:
    """Aware UTC moment of a naive local datetime in the zone."""
    value = await session.scalar(
        select(func.timezone(timezone or DEFAULT_TIMEZONE, literal(local, DateTime())))
    )
    assert value is not None
    return value


async def after_quiet_hours(session: AsyncSession, timezone: str | None, at: datetime) -> datetime:
    """``at`` itself, or 09:00 local when ``at`` falls into the quiet hours 22:00–09:00."""
    local = await to_local(session, timezone, at)
    if local.hour >= QUIET_FROM_HOUR:
        morning = (local + timedelta(days=1)).replace(
            hour=QUIET_TO_HOUR, minute=0, second=0, microsecond=0
        )
    elif local.hour < QUIET_TO_HOUR:
        morning = local.replace(hour=QUIET_TO_HOUR, minute=0, second=0, microsecond=0)
    else:
        return at
    return await from_local(session, timezone, morning)
