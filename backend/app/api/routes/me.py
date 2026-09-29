"""The signed-in user's own context: role summary and the Home screen lists.

Everything here is scoped to ``current_user``; nothing accepts a user ID from the client.
"""

import json
import uuid
from collections import Counter
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.menus import (
    MenuSectionResponse,
    published_restaurant_clause,
    read_versions_sections,
)
from app.auth.dependencies import get_current_user
from app.database import get_session
from app.models import (
    Menu,
    MenuVersion,
    Restaurant,
    RestaurantFavorite,
    RestaurantSite,
    RestaurantVisit,
    User,
    Venue,
    VenueMember,
)

router = APIRouter(prefix="/me", tags=["me"])

RECENT_LIMIT = 10


class MeResponse(BaseModel):
    id: uuid.UUID
    max_user_id: int
    display_name: str
    first_name: str
    is_admin: bool
    # Points of every venue the user administers (per-point cabinet routes).
    admin_restaurant_ids: list[uuid.UUID]
    admin_venue_ids: list[uuid.UUID]


class HomePoint(BaseModel):
    id: uuid.UUID
    public_id: str
    name: str
    address: str | None


class HomeAdminVenue(BaseModel):
    id: uuid.UUID  # first point of the venue
    venue_id: uuid.UUID
    public_id: str
    name: str
    is_creator: bool
    has_published_menu: bool
    unpublished_changes: int
    points: list[HomePoint]


class HomeVenue(BaseModel):
    public_id: str
    name: str
    address: str | None


class HomeRecentVenue(HomeVenue):
    last_opened_at: datetime


class HomeFavoriteVenue(HomeVenue):
    notifications_enabled: bool


class HomeResponse(BaseModel):
    display_name: str
    first_name: str
    is_admin: bool
    admin_venues: list[HomeAdminVenue]
    recent: list[HomeRecentVenue]
    favorites: list[HomeFavoriteVenue]


class RecentVisit(BaseModel):
    public_id: str = Field(min_length=1, max_length=32)


def _item_fingerprints(sections: list[MenuSectionResponse]) -> dict[tuple, str]:
    """Key items by section and name (with an occurrence index), ignoring row IDs."""
    seen: Counter[tuple[str, str]] = Counter()
    result: dict[tuple, str] = {}
    for section in sections:
        for item in section.items:
            base = (section.name, item.name)
            result[(*base, seen[base])] = json.dumps(
                item.model_dump(mode="json", exclude={"id", "item_key"}), sort_keys=True
            )
            seen[base] += 1
    return result


def count_unpublished_changes(
    draft: list[MenuSectionResponse], published: list[MenuSectionResponse]
) -> int:
    """Number of menu positions added, removed or edited in the draft since publication."""
    draft_items = _item_fingerprints(draft)
    published_items = _item_fingerprints(published)
    return sum(
        1
        for key in draft_items.keys() | published_items.keys()
        if draft_items.get(key) != published_items.get(key)
    )


async def _admin_venues(
    session: AsyncSession, memberships: list[tuple[Venue, VenueMember]]
) -> list[HomeAdminVenue]:
    """Admin cards in a fixed number of queries, however many venues the user runs."""
    if not memberships:
        return []
    venue_ids = [venue.id for venue, _ in memberships]
    points = (await session.scalars(
        select(Restaurant)
        .where(Restaurant.venue_id.in_(venue_ids))
        .order_by(Restaurant.created_at, Restaurant.id)
    )).all()
    points_by_venue: dict[uuid.UUID, list[Restaurant]] = {}
    for point in points:
        points_by_venue.setdefault(point.venue_id, []).append(point)
    menus = (await session.execute(
        select(Menu.venue_id, Menu.id, Menu.current_published_version_id)
        .where(Menu.venue_id.in_(venue_ids), Menu.archived_at.is_(None))
    )).all()
    drafts: dict[uuid.UUID, uuid.UUID] = {}
    if menus:
        drafts = {row.menu_id: row.id for row in (await session.execute(
            select(MenuVersion.menu_id, MenuVersion.id)
            .where(MenuVersion.menu_id.in_([menu.id for menu in menus]),
                   MenuVersion.status == "draft")
            .order_by(MenuVersion.menu_id, MenuVersion.version.desc())
            .distinct(MenuVersion.menu_id)
        )).all()}
    version_ids = {
        version_id
        for version_id in (*drafts.values(), *(m.current_published_version_id for m in menus))
        if version_id is not None
    }
    sections = await read_versions_sections(session, list(version_ids))
    sites = {
        site.restaurant_id: site
        for site in (await session.scalars(
            select(RestaurantSite).where(
                RestaurantSite.restaurant_id.in_([point.id for point in points])
            )
        )).all()
    }

    venues = []
    for venue, member in memberships:
        venue_points = points_by_venue.get(venue.id, [])
        if not venue_points:
            continue
        venue_menus = [menu for menu in menus if menu.venue_id == venue.id]
        changes = 0
        for menu in venue_menus:
            draft_id = drafts.get(menu.id)
            published_id = menu.current_published_version_id
            changes += count_unpublished_changes(
                sections[draft_id] if draft_id else [],
                sections[published_id] if published_id else [],
            )
        for point in venue_points:
            site = sites.get(point.id)
            if (
                site is not None
                and site.published_config is not None
                and site.draft_config != site.published_config
            ):
                changes += 1  # unpublished design counts as one change
        first = venue_points[0]
        venues.append(HomeAdminVenue(
            # The first point stays the card ID: the cabinet still opens /manage/<point>.
            id=first.id,
            venue_id=venue.id,
            public_id=first.public_id,
            name=venue.name,
            is_creator=member.is_creator,
            has_published_menu=any(
                menu.current_published_version_id is not None for menu in venue_menus
            ),
            unpublished_changes=changes,
            points=[HomePoint(
                id=point.id,
                public_id=point.public_id,
                name=point.name,
                address=point.address,
            ) for point in venue_points],
        ))
    return venues


@router.get("", response_model=MeResponse)
async def get_me(
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> MeResponse:
    """Role context computed on the server; the client uses it for navigation only."""
    admin_rows = (await session.execute(
        select(Restaurant.id, Restaurant.venue_id)
        .join(VenueMember, VenueMember.venue_id == Restaurant.venue_id)
        .where(VenueMember.user_id == current_user.id)
        .order_by(VenueMember.created_at, Restaurant.created_at, Restaurant.id)
    )).all()
    admin_ids = [row.id for row in admin_rows]
    venue_ids = list(dict.fromkeys(row.venue_id for row in admin_rows))
    return MeResponse(
        id=current_user.id,
        max_user_id=current_user.max_user_id,
        display_name=current_user.display_name,
        first_name=current_user.first_name,
        is_admin=bool(admin_ids),
        admin_restaurant_ids=admin_ids,
        admin_venue_ids=venue_ids,
    )


@router.get("/home", response_model=HomeResponse)
async def get_home(
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> HomeResponse:
    admin_rows = (await session.execute(
        select(Venue, VenueMember)
        .join(VenueMember, VenueMember.venue_id == Venue.id)
        .where(VenueMember.user_id == current_user.id)
        .order_by(Venue.created_at, Venue.id)
    )).all()
    admin_venues = await _admin_venues(session, [tuple(row) for row in admin_rows])
    recent_rows = (await session.execute(
        select(Restaurant, RestaurantVisit.last_opened_at)
        .join(RestaurantVisit, RestaurantVisit.restaurant_id == Restaurant.id)
        .where(RestaurantVisit.user_id == current_user.id, published_restaurant_clause())
        .order_by(RestaurantVisit.last_opened_at.desc())
        .limit(RECENT_LIMIT)
    )).all()
    favorite_rows = (await session.execute(
        select(Restaurant, RestaurantFavorite.notifications_enabled)
        .join(RestaurantFavorite, RestaurantFavorite.restaurant_id == Restaurant.id)
        .where(RestaurantFavorite.user_id == current_user.id)
        .order_by(RestaurantFavorite.created_at.desc())
    )).all()
    return HomeResponse(
        display_name=current_user.display_name,
        first_name=current_user.first_name,
        is_admin=bool(admin_venues),
        admin_venues=admin_venues,
        recent=[HomeRecentVenue(
            public_id=restaurant.public_id,
            name=restaurant.name,
            address=restaurant.address,
            last_opened_at=opened_at,
        ) for restaurant, opened_at in recent_rows],
        favorites=[HomeFavoriteVenue(
            public_id=restaurant.public_id,
            name=restaurant.name,
            address=restaurant.address,
            notifications_enabled=notifications_enabled,
        ) for restaurant, notifications_enabled in favorite_rows],
    )


@router.post("/recent", status_code=status.HTTP_204_NO_CONTENT)
async def record_recent_visit(
    payload: RecentVisit,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> None:
    """Called when a signed-in user opens a venue menu; keeps the latest ten."""
    # Same visibility as the public menu: unpublished venues do not exist for guests.
    restaurant_id = await session.scalar(
        select(Restaurant.id).where(
            Restaurant.public_id == payload.public_id, published_restaurant_clause()
        )
    )
    if restaurant_id is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Restaurant not found")
    now = datetime.now(UTC)
    await session.execute(
        insert(RestaurantVisit)
        .values(user_id=current_user.id, restaurant_id=restaurant_id, last_opened_at=now)
        .on_conflict_do_update(
            index_elements=[RestaurantVisit.user_id, RestaurantVisit.restaurant_id],
            set_={"last_opened_at": now},
        )
    )
    keep = (
        select(RestaurantVisit.restaurant_id)
        .where(RestaurantVisit.user_id == current_user.id)
        .order_by(RestaurantVisit.last_opened_at.desc())
        .limit(RECENT_LIMIT)
    )
    await session.execute(
        delete(RestaurantVisit).where(
            RestaurantVisit.user_id == current_user.id,
            RestaurantVisit.restaurant_id.not_in(keep),
        )
    )
    await session.commit()
