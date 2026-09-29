"""Venue, its points and the assignment of library menus to points (P1-DOC-15).

Every route checks venue admin rights on the server; foreign venues, points and menus
answer 404. Assignments are guarded by a revision (409 on a stale one).
"""

import hashlib
import json
import uuid
from datetime import datetime, time
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.restaurants import (
    RestaurantCreate,
    RestaurantResponse,
    build_restaurant_response,
    create_point,
)
from app.auth.dependencies import get_current_user
from app.auth.permissions import require_admin_of_venue, require_point_admin
from app.database import get_session
from app.models import Menu, PointMenu, Restaurant, User, Venue, VenueMember

router = APIRouter(tags=["venues"])

MAX_ASSIGNMENTS = 20


class PointResponse(BaseModel):
    id: uuid.UUID
    public_id: str
    name: str
    address: str | None
    timezone: str


class VenueResponse(BaseModel):
    id: uuid.UUID
    name: str
    is_creator: bool
    created_at: datetime
    points: list[PointResponse]


class VenueUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=200)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Название не может быть пустым")
        return value


class AssignmentPayload(BaseModel):
    menu_id: uuid.UUID
    show_from: time | None = None
    show_to: time | None = None

    @model_validator(mode="after")
    def hours(self):
        if (self.show_from is None) != (self.show_to is None):
            raise ValueError("Укажите оба времени показа или ни одного")
        if self.show_from is not None and self.show_from == self.show_to:
            raise ValueError("Время начала и окончания показа совпадают")
        return self


class AssignmentsPayload(BaseModel):
    expected_revision: str = Field(pattern="^[a-f0-9]{64}$")
    # List order is the tab order; the first menu is the point's primary menu.
    assignments: list[AssignmentPayload] = Field(max_length=MAX_ASSIGNMENTS)

    @field_validator("assignments")
    @classmethod
    def unique_menus(cls, value: list[AssignmentPayload]) -> list[AssignmentPayload]:
        if len({item.menu_id for item in value}) != len(value):
            raise ValueError("Меню назначено дважды")
        return value


class AssignmentResponse(BaseModel):
    menu_id: uuid.UUID
    title: str
    sort_order: int
    show_from: time | None
    show_to: time | None
    has_published_version: bool


class AssignmentsResponse(BaseModel):
    point_id: uuid.UUID
    revision: str
    assignments: list[AssignmentResponse]


def point_response(point: Restaurant) -> PointResponse:
    return PointResponse(
        id=point.id,
        public_id=point.public_id,
        name=point.name,
        address=point.address,
        timezone=point.timezone,
    )


async def venue_responses(
    session: AsyncSession, rows: list[tuple[Venue, VenueMember]]
) -> list[VenueResponse]:
    """Venues with their points in one extra query whatever the number of venues."""
    points: dict[uuid.UUID, list[PointResponse]] = {venue.id: [] for venue, _ in rows}
    if rows:
        for point in (await session.scalars(
            select(Restaurant)
            .where(Restaurant.venue_id.in_(list(points)))
            .order_by(Restaurant.created_at, Restaurant.id)
        )).all():
            points[point.venue_id].append(point_response(point))
    return [
        VenueResponse(
            id=venue.id,
            name=venue.name,
            is_creator=member.is_creator,
            created_at=venue.created_at,
            points=points[venue.id],
        )
        for venue, member in rows
    ]


async def venue_response(
    session: AsyncSession, venue: Venue, member: VenueMember
) -> VenueResponse:
    return (await venue_responses(session, [(venue, member)]))[0]


@router.get("/venues", response_model=list[VenueResponse])
async def list_venues(
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[VenueResponse]:
    rows = (await session.execute(
        select(Venue, VenueMember)
        .join(VenueMember, VenueMember.venue_id == Venue.id)
        .where(VenueMember.user_id == current_user.id)
        .order_by(Venue.created_at, Venue.id)
    )).all()
    return await venue_responses(session, [tuple(row) for row in rows])


@router.get("/venues/{venue_id}", response_model=VenueResponse)
async def get_venue(
    venue_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> VenueResponse:
    member = await require_admin_of_venue(session, current_user.id, venue_id)
    venue = await session.get(Venue, venue_id)
    return await venue_response(session, venue, member)


@router.patch("/venues/{venue_id}", response_model=VenueResponse)
async def update_venue(
    venue_id: uuid.UUID,
    payload: VenueUpdate,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> VenueResponse:
    member = await require_admin_of_venue(session, current_user.id, venue_id)
    venue = await session.get(Venue, venue_id)
    venue.name = payload.name
    await session.commit()
    await session.refresh(venue)
    return await venue_response(session, venue, member)


@router.post(
    "/venues/{venue_id}/points",
    response_model=RestaurantResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_venue_point(
    venue_id: uuid.UUID,
    payload: RestaurantCreate,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> RestaurantResponse:
    """A new point with its own public link and QR; menus are assigned separately."""
    member = await require_admin_of_venue(session, current_user.id, venue_id)
    point = await create_point(session, venue_id=venue_id, payload=payload, actor=current_user)
    await session.commit()
    await session.refresh(point)
    return await build_restaurant_response(session, point, member)


def assignments_revision(rows: list[PointMenu]) -> str:
    content = [
        [
            str(row.menu_id),
            row.show_from.isoformat() if row.show_from else None,
            row.show_to.isoformat() if row.show_to else None,
        ]
        for row in sorted(rows, key=lambda row: row.sort_order)
    ]
    return hashlib.sha256(json.dumps(content).encode()).hexdigest()


async def read_assignments(session: AsyncSession, point_id: uuid.UUID) -> AssignmentsResponse:
    rows = (await session.execute(
        select(PointMenu, Menu)
        .join(Menu, Menu.id == PointMenu.menu_id)
        .where(PointMenu.point_id == point_id)
        .order_by(PointMenu.sort_order)
    )).all()
    return AssignmentsResponse(
        point_id=point_id,
        revision=assignments_revision([assignment for assignment, _ in rows]),
        assignments=[
            AssignmentResponse(
                menu_id=menu.id,
                title=menu.title,
                sort_order=assignment.sort_order,
                show_from=assignment.show_from,
                show_to=assignment.show_to,
                has_published_version=menu.current_published_version_id is not None,
            )
            for assignment, menu in rows
        ],
    )


@router.get("/points/{point_id}/menus", response_model=AssignmentsResponse)
async def get_point_menus(
    point_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> AssignmentsResponse:
    await require_point_admin(session, current_user.id, point_id)
    return await read_assignments(session, point_id)


@router.put("/points/{point_id}/menus", response_model=AssignmentsResponse)
async def set_point_menus(
    point_id: uuid.UUID,
    payload: AssignmentsPayload,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> AssignmentsResponse:
    """Replace the point's menu tabs: order, and optional local show hours."""
    point = await require_point_admin(session, current_user.id, point_id, lock=True)
    current = (await session.scalars(
        select(PointMenu).where(PointMenu.point_id == point_id)
    )).all()
    if assignments_revision(list(current)) != payload.expected_revision:
        raise HTTPException(
            status_code=409, detail="Назначения точки изменились. Обновите и повторите."
        )
    menu_ids = [item.menu_id for item in payload.assignments]
    menus = {
        menu.id: menu
        for menu in (await session.scalars(
            select(Menu).where(Menu.id.in_(menu_ids), Menu.venue_id == point.venue_id)
        )).all()
    } if menu_ids else {}
    if len(menus) != len(menu_ids):
        raise HTTPException(status_code=404, detail="Menu not found")
    if any(menus[menu_id].archived_at is not None for menu_id in menu_ids):
        raise HTTPException(status_code=409, detail="Архивное меню нельзя назначить точке")
    await session.execute(delete(PointMenu).where(PointMenu.point_id == point_id))
    await session.flush()
    for index, item in enumerate(payload.assignments):
        session.add(PointMenu(
            point_id=point_id,
            menu_id=item.menu_id,
            venue_id=point.venue_id,
            sort_order=index,
            show_from=item.show_from,
            show_to=item.show_to,
        ))
    await session.flush()
    result = await read_assignments(session, point_id)
    await session.commit()
    return result
