import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.permissions import has_restaurant_role
from app.database import get_session
from app.models import Menu, MenuVersion, Restaurant, RestaurantMember, RestaurantSite, User
from app.sites.schemas import default_site_config

router = APIRouter(prefix="/restaurants", tags=["restaurants"])


class RestaurantCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=1000)
    address: str | None = Field(default=None, max_length=500)

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

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str | None) -> str | None:
        if value is None:
            raise ValueError("Restaurant name cannot be null")
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


class RestaurantResponse(BaseModel):
    id: uuid.UUID
    public_id: str
    name: str
    description: str | None
    address: str | None
    role: str
    menu_id: uuid.UUID
    draft_version_id: uuid.UUID | None
    current_published_version_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime


async def build_restaurant_response(
    session: AsyncSession,
    restaurant: Restaurant,
    role: str,
) -> RestaurantResponse:
    menu = await session.scalar(select(Menu).where(Menu.restaurant_id == restaurant.id))
    if menu is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Restaurant menu is missing",
        )

    draft_version_id = await session.scalar(
        select(MenuVersion.id)
        .where(MenuVersion.menu_id == menu.id, MenuVersion.status == "draft")
        .order_by(MenuVersion.version.desc())
        .limit(1)
    )
    return RestaurantResponse(
        id=restaurant.id,
        public_id=restaurant.public_id,
        name=restaurant.name,
        description=restaurant.description,
        address=restaurant.address,
        role=role,
        menu_id=menu.id,
        draft_version_id=draft_version_id,
        current_published_version_id=menu.current_published_version_id,
        created_at=restaurant.created_at,
        updated_at=restaurant.updated_at,
    )


async def get_accessible_restaurant(
    session: AsyncSession,
    user: User,
    restaurant_id: uuid.UUID,
) -> tuple[Restaurant, str]:
    statement = (
        select(Restaurant, RestaurantMember.role)
        .outerjoin(
            RestaurantMember,
            (RestaurantMember.restaurant_id == Restaurant.id)
            & (RestaurantMember.user_id == user.id),
        )
        .where(
            Restaurant.id == restaurant_id,
            or_(Restaurant.owner_id == user.id, RestaurantMember.user_id == user.id),
        )
    )
    row = (await session.execute(statement)).one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Restaurant not found")

    restaurant, member_role = row
    role = "owner" if restaurant.owner_id == user.id else member_role
    return restaurant, role


@router.get("", response_model=list[RestaurantResponse])
async def list_restaurants(
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[RestaurantResponse]:
    statement = (
        select(Restaurant, RestaurantMember.role)
        .outerjoin(
            RestaurantMember,
            (RestaurantMember.restaurant_id == Restaurant.id)
            & (RestaurantMember.user_id == current_user.id),
        )
        .where(
            or_(
                Restaurant.owner_id == current_user.id,
                RestaurantMember.user_id == current_user.id,
            )
        )
        .order_by(Restaurant.created_at)
    )
    rows = (await session.execute(statement)).all()
    return [
        await build_restaurant_response(
            session,
            restaurant,
            "owner" if restaurant.owner_id == current_user.id else member_role,
        )
        for restaurant, member_role in rows
    ]


@router.post("", response_model=RestaurantResponse, status_code=status.HTTP_201_CREATED)
async def create_restaurant(
    payload: RestaurantCreate,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> RestaurantResponse:
    restaurant = Restaurant(
        public_id=uuid.uuid4().hex[:12],
        owner_id=current_user.id,
        name=payload.name,
        description=payload.description,
        address=payload.address,
    )
    session.add(restaurant)
    await session.flush()

    session.add(
        RestaurantSite(
            restaurant_id=restaurant.id,
            draft_config=default_site_config(),
            published_version=0,
        )
    )

    session.add(
        RestaurantMember(
            restaurant_id=restaurant.id,
            user_id=current_user.id,
            role="owner",
        )
    )
    menu = Menu(restaurant_id=restaurant.id)
    session.add(menu)
    await session.flush()

    draft = MenuVersion(
        menu_id=menu.id,
        version=1,
        status="draft",
        created_by_id=current_user.id,
    )
    session.add(draft)
    await session.commit()
    await session.refresh(restaurant)

    return await build_restaurant_response(session, restaurant, "owner")


@router.get("/{restaurant_id}", response_model=RestaurantResponse)
async def get_restaurant(
    restaurant_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> RestaurantResponse:
    restaurant, role = await get_accessible_restaurant(session, current_user, restaurant_id)
    return await build_restaurant_response(session, restaurant, role)


@router.patch("/{restaurant_id}", response_model=RestaurantResponse)
async def update_restaurant(
    restaurant_id: uuid.UUID,
    payload: RestaurantUpdate,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> RestaurantResponse:
    restaurant, role = await get_accessible_restaurant(session, current_user, restaurant_id)
    if not await has_restaurant_role(
        session,
        current_user.id,
        restaurant_id,
        {"owner", "manager"},
    ):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient role")

    updates = payload.model_dump(exclude_unset=True)
    for field_name, value in updates.items():
        setattr(restaurant, field_name, value)

    await session.commit()
    await session.refresh(restaurant)
    return await build_restaurant_response(session, restaurant, role)
