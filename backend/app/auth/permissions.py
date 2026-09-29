"""Server-side venue authorization: membership in ``venue_members`` is the only source.

There is one management role, ``admin``, and it covers the whole venue: all its points,
its menu library, assignments and stop-lists. ``is_creator`` is an attribute that protects
the creator from removal; it grants no extra rights. Links, ``startapp`` and client state
are navigation only and never authorize anything. Foreign venues answer 404 so internal
IDs cannot be enumerated.
"""

import uuid
from collections.abc import Iterable

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Menu, Restaurant, VenueMember

VENUE_NOT_FOUND = "Restaurant not found"
MENU_NOT_FOUND = "Menu not found"


def _not_found(detail: str = VENUE_NOT_FOUND) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)


async def is_admin_of_venue(
    session: AsyncSession, user_id: uuid.UUID, venue_id: uuid.UUID
) -> bool:
    member = await session.scalar(
        select(VenueMember.user_id).where(
            VenueMember.venue_id == venue_id, VenueMember.user_id == user_id
        )
    )
    return member is not None


async def require_admin_of_venue(
    session: AsyncSession, user_id: uuid.UUID, venue_id: uuid.UUID
) -> VenueMember:
    member = await session.get(VenueMember, (venue_id, user_id))
    if member is None:
        raise _not_found()
    return member


async def is_venue_admin(
    session: AsyncSession,
    user_id: uuid.UUID,
    restaurant_id: uuid.UUID,
) -> bool:
    """Whether the user administers the venue that owns this point."""
    statement = (
        select(VenueMember.user_id)
        .join(Restaurant, Restaurant.venue_id == VenueMember.venue_id)
        .where(Restaurant.id == restaurant_id, VenueMember.user_id == user_id)
    )
    return await session.scalar(statement) is not None


async def require_venue_admin(
    session: AsyncSession,
    user_id: uuid.UUID,
    restaurant_id: uuid.UUID,
) -> None:
    """Point-scoped check kept for the per-point routes; non-admins get 404."""
    if not await is_venue_admin(session, user_id, restaurant_id):
        raise _not_found()


async def require_point_admin(
    session: AsyncSession, user_id: uuid.UUID, point_id: uuid.UUID, *, lock: bool = False
) -> Restaurant:
    statement = (
        select(Restaurant)
        .join(VenueMember, VenueMember.venue_id == Restaurant.venue_id)
        .where(Restaurant.id == point_id, VenueMember.user_id == user_id)
    )
    if lock:
        statement = statement.with_for_update(of=Restaurant)
    point = await session.scalar(statement)
    if point is None:
        raise _not_found()
    return point


async def require_menu_admin(
    session: AsyncSession, user_id: uuid.UUID, menu_id: uuid.UUID, *, lock: bool = False
) -> Menu:
    statement = (
        select(Menu)
        .join(VenueMember, VenueMember.venue_id == Menu.venue_id)
        .where(Menu.id == menu_id, VenueMember.user_id == user_id)
    )
    if lock:
        statement = statement.with_for_update(of=Menu)
    menu = await session.scalar(statement)
    if menu is None:
        raise _not_found(MENU_NOT_FOUND)
    return menu


async def require_admin_of_all(
    session: AsyncSession,
    user_id: uuid.UUID,
    restaurant_ids: Iterable[uuid.UUID],
) -> None:
    wanted = set(restaurant_ids)
    count = await session.scalar(
        select(func.count())
        .select_from(Restaurant)
        .join(VenueMember, VenueMember.venue_id == Restaurant.venue_id)
        .where(VenueMember.user_id == user_id, Restaurant.id.in_(wanted))
    )
    if count != len(wanted):
        raise _not_found()
