"""Points («точки») of venues, kept under ``/restaurants`` for the current cabinet.

Creating a restaurant here creates a new venue with its first point, the library menu
«Основное» assigned to it and the caller as the venue creator. Further points of the
same venue are added with ``POST /venues/{venue_id}/points``.
"""

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.menus import create_menu_with_draft
from app.auth.dependencies import get_current_user
from app.auth.permissions import VENUE_NOT_FOUND
from app.database import get_session
from app.menu_library import is_known_timezone
from app.models import (
    ADMIN_ROLE,
    DEFAULT_TIMEZONE,
    Menu,
    MenuVersion,
    PointMenu,
    Restaurant,
    RestaurantSite,
    User,
    Venue,
    VenueMember,
)
from app.sites.schemas import default_site_config

router = APIRouter(prefix="/restaurants", tags=["restaurants"])

DEFAULT_MENU_TITLE = "Основное"
TIMEZONE_PATTERN = r"^[A-Za-z0-9_+\-/]{1,64}$"


class RestaurantCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=1000)
    address: str | None = Field(default=None, max_length=500)
    timezone: str = Field(default=DEFAULT_TIMEZONE, pattern=TIMEZONE_PATTERN)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Restaurant name cannot be empty")
        return value

    @field_validator("description", "address")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip() or None


class RestaurantUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=1000)
    address: str | None = Field(default=None, max_length=500)
    timezone: str | None = Field(default=None, pattern=TIMEZONE_PATTERN)

    @field_validator("name", "timezone")
    @classmethod
    def validate_required(cls, value: str | None) -> str | None:
        if value is None:
            raise ValueError("Value cannot be null")
        value = value.strip()
        if not value:
            raise ValueError("Value cannot be empty")
        return value

    @field_validator("description", "address")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip() or None


class RestaurantResponse(BaseModel):
    id: uuid.UUID
    public_id: str
    venue_id: uuid.UUID
    venue_name: str
    name: str
    description: str | None
    address: str | None
    timezone: str
    role: str
    is_creator: bool
    # The point's primary (first assigned) menu, edited by the per-point cabinet routes.
    menu_id: uuid.UUID | None
    draft_version_id: uuid.UUID | None
    current_published_version_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime


async def build_restaurant_responses(
    session: AsyncSession,
    rows: list[tuple[Restaurant, VenueMember]],
) -> list[RestaurantResponse]:
    """Point responses in three queries whatever the number of points: venue names,
    primary (first assigned) menus and their drafts."""
    if not rows:
        return []
    point_ids = [restaurant.id for restaurant, _ in rows]
    venue_names = dict((await session.execute(
        select(Venue.id, Venue.name).where(
            Venue.id.in_({restaurant.venue_id for restaurant, _ in rows})
        )
    )).all())
    primary = {
        point_id: menu
        for point_id, menu in (await session.execute(
            select(PointMenu.point_id, Menu)
            .join(Menu, Menu.id == PointMenu.menu_id)
            .where(PointMenu.point_id.in_(point_ids))
            .order_by(PointMenu.point_id, PointMenu.sort_order)
            .distinct(PointMenu.point_id)
        )).all()
    }
    drafts = dict((await session.execute(
        select(MenuVersion.menu_id, MenuVersion.id)
        .where(
            MenuVersion.menu_id.in_({menu.id for menu in primary.values()}),
            MenuVersion.status == "draft",
        )
        .order_by(MenuVersion.menu_id, MenuVersion.version.desc())
        .distinct(MenuVersion.menu_id)
    )).all()) if primary else {}
    responses = []
    for restaurant, member in rows:
        menu = primary.get(restaurant.id)
        responses.append(RestaurantResponse(
            id=restaurant.id,
            public_id=restaurant.public_id,
            venue_id=restaurant.venue_id,
            venue_name=venue_names.get(restaurant.venue_id, ""),
            name=restaurant.name,
            description=restaurant.description,
            address=restaurant.address,
            timezone=restaurant.timezone,
            role=member.role,
            is_creator=member.is_creator,
            menu_id=menu.id if menu else None,
            draft_version_id=drafts.get(menu.id) if menu else None,
            current_published_version_id=menu.current_published_version_id if menu else None,
            created_at=restaurant.created_at,
            updated_at=restaurant.updated_at,
        ))
    return responses


async def build_restaurant_response(
    session: AsyncSession,
    restaurant: Restaurant,
    member: VenueMember,
) -> RestaurantResponse:
    return (await build_restaurant_responses(session, [(restaurant, member)]))[0]


async def get_accessible_restaurant(
    session: AsyncSession,
    user: User,
    restaurant_id: uuid.UUID,
) -> tuple[Restaurant, VenueMember]:
    """Return the point and the caller's venue membership; non-admins get 404."""
    statement = (
        select(Restaurant, VenueMember)
        .join(VenueMember, VenueMember.venue_id == Restaurant.venue_id)
        .where(Restaurant.id == restaurant_id, VenueMember.user_id == user.id)
    )
    row = (await session.execute(statement)).one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=VENUE_NOT_FOUND)
    restaurant, member = row
    return restaurant, member


async def require_known_timezone(session: AsyncSession, timezone: str) -> None:
    if not await is_known_timezone(session, timezone):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Неизвестный часовой пояс",
        )


async def create_point(
    session: AsyncSession, *, venue_id: uuid.UUID, payload: RestaurantCreate, actor: User
) -> Restaurant:
    await require_known_timezone(session, payload.timezone)
    point = Restaurant(
        public_id=uuid.uuid4().hex[:12],
        venue_id=venue_id,
        owner_id=actor.id,
        name=payload.name,
        description=payload.description,
        address=payload.address,
        timezone=payload.timezone,
    )
    session.add(point)
    await session.flush()
    session.add(
        RestaurantSite(
            restaurant_id=point.id,
            draft_config=default_site_config(),
            published_version=0,
        )
    )
    await session.flush()
    return point


@router.get("", response_model=list[RestaurantResponse])
async def list_restaurants(
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[RestaurantResponse]:
    statement = (
        select(Restaurant, VenueMember)
        .join(VenueMember, VenueMember.venue_id == Restaurant.venue_id)
        .where(VenueMember.user_id == current_user.id)
        .order_by(Restaurant.created_at)
    )
    rows = (await session.execute(statement)).all()
    return await build_restaurant_responses(session, [tuple(row) for row in rows])


@router.post("", response_model=RestaurantResponse, status_code=status.HTTP_201_CREATED)
async def create_restaurant(
    payload: RestaurantCreate,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> RestaurantResponse:
    """«Подключить своё заведение»: a new venue, its first point and menu «Основное»."""
    venue = Venue(name=payload.name, created_by_id=current_user.id)
    session.add(venue)
    await session.flush()
    member = VenueMember(
        venue_id=venue.id,
        user_id=current_user.id,
        role=ADMIN_ROLE,
        is_creator=True,
    )
    session.add(member)
    restaurant = await create_point(
        session, venue_id=venue.id, payload=payload, actor=current_user
    )
    menu, _ = await create_menu_with_draft(
        session, venue_id=venue.id, title=DEFAULT_MENU_TITLE, actor_id=current_user.id
    )
    session.add(PointMenu(point_id=restaurant.id, menu_id=menu.id, venue_id=venue.id, sort_order=0))
    await session.commit()
    await session.refresh(restaurant)

    return await build_restaurant_response(session, restaurant, member)


@router.get("/{restaurant_id}", response_model=RestaurantResponse)
async def get_restaurant(
    restaurant_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> RestaurantResponse:
    restaurant, member = await get_accessible_restaurant(session, current_user, restaurant_id)
    return await build_restaurant_response(session, restaurant, member)


@router.patch("/{restaurant_id}", response_model=RestaurantResponse)
async def update_restaurant(
    restaurant_id: uuid.UUID,
    payload: RestaurantUpdate,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> RestaurantResponse:
    restaurant, member = await get_accessible_restaurant(session, current_user, restaurant_id)

    updates = payload.model_dump(exclude_unset=True)
    if "timezone" in updates:
        await require_known_timezone(session, updates["timezone"])
    for field_name, value in updates.items():
        setattr(restaurant, field_name, value)

    await session.commit()
    await session.refresh(restaurant)
    return await build_restaurant_response(session, restaurant, member)
