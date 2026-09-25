"""Point-scoped staff access through targeted MAX invitations."""

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.config import Settings, get_settings
from app.database import get_session
from app.max_api.client import build_max_deep_link
from app.models import Restaurant, RestaurantInvite, RestaurantMember, User

router = APIRouter(tags=["team"])
StaffRole = Literal["manager", "editor"]


class MemberResponse(BaseModel):
    user_id: uuid.UUID
    max_user_id: int
    display_name: str
    role: str


class InviteCreate(BaseModel):
    max_user_id: int = Field(gt=0, le=9_223_372_036_854_775_807)
    role: StaffRole


class InviteResponse(BaseModel):
    id: uuid.UUID
    max_user_id: int
    role: StaffRole
    expires_at: datetime
    accepted_at: datetime | None
    revoked_at: datetime | None


class InviteCreated(InviteResponse):
    invite_url: str


class InviteAccept(BaseModel):
    token: str = Field(min_length=30, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")


class MemberRoleUpdate(BaseModel):
    role: StaffRole


def invite_response(invite: RestaurantInvite) -> InviteResponse:
    return InviteResponse(
        id=invite.id,
        max_user_id=invite.target_max_user_id,
        role=invite.role,
        expires_at=invite.expires_at,
        accepted_at=invite.accepted_at,
        revoked_at=invite.revoked_at,
    )


async def require_owner(
    session: AsyncSession, user: User, restaurant_id: uuid.UUID
) -> Restaurant:
    restaurant = await session.scalar(select(Restaurant).where(
        Restaurant.id == restaurant_id, Restaurant.owner_id == user.id
    ))
    if restaurant is None:
        raise HTTPException(status_code=404, detail="Restaurant not found")
    return restaurant


@router.get("/restaurants/{restaurant_id}/members", response_model=list[MemberResponse])
async def list_members(
    restaurant_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[MemberResponse]:
    await require_owner(session, current_user, restaurant_id)
    rows = (await session.execute(
        select(RestaurantMember, User)
        .join(User, User.id == RestaurantMember.user_id)
        .where(RestaurantMember.restaurant_id == restaurant_id)
        .order_by(RestaurantMember.created_at)
    )).all()
    return [MemberResponse(
        user_id=user.id, max_user_id=user.max_user_id,
        display_name=user.display_name, role=member.role,
    ) for member, user in rows]


@router.patch("/restaurants/{restaurant_id}/members/{user_id}", response_model=MemberResponse)
async def change_member_role(
    restaurant_id: uuid.UUID,
    user_id: uuid.UUID,
    payload: MemberRoleUpdate,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> MemberResponse:
    restaurant = await require_owner(session, current_user, restaurant_id)
    if user_id == restaurant.owner_id:
        raise HTTPException(status_code=409, detail="Owner role cannot be changed")
    member = await session.get(RestaurantMember, (restaurant_id, user_id))
    user = await session.get(User, user_id)
    if member is None or user is None:
        raise HTTPException(status_code=404, detail="Member not found")
    member.role = payload.role
    await session.commit()
    return MemberResponse(
        user_id=user.id, max_user_id=user.max_user_id,
        display_name=user.display_name, role=member.role,
    )


@router.delete("/restaurants/{restaurant_id}/members/{user_id}", status_code=204)
async def remove_member(
    restaurant_id: uuid.UUID,
    user_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> None:
    restaurant = await require_owner(session, current_user, restaurant_id)
    if user_id == restaurant.owner_id:
        raise HTTPException(status_code=409, detail="Owner access cannot be revoked")
    member = await session.get(RestaurantMember, (restaurant_id, user_id))
    if member is None:
        raise HTTPException(status_code=404, detail="Member not found")
    await session.delete(member)
    await session.commit()


@router.get("/restaurants/{restaurant_id}/invites", response_model=list[InviteResponse])
async def list_invites(
    restaurant_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[InviteResponse]:
    await require_owner(session, current_user, restaurant_id)
    invites = (await session.scalars(
        select(RestaurantInvite)
        .where(RestaurantInvite.restaurant_id == restaurant_id)
        .order_by(RestaurantInvite.created_at.desc())
        .limit(50)
    )).all()
    return [invite_response(invite) for invite in invites]


@router.post("/restaurants/{restaurant_id}/invites", response_model=InviteCreated, status_code=201)
async def create_invite(
    restaurant_id: uuid.UUID,
    payload: InviteCreate,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> InviteCreated:
    restaurant = await require_owner(session, current_user, restaurant_id)
    owner = await session.get(User, restaurant.owner_id)
    if owner is not None and payload.max_user_id == owner.max_user_id:
        raise HTTPException(status_code=409, detail="Owner already has access")
    token = secrets.token_urlsafe(32)
    invite = RestaurantInvite(
        restaurant_id=restaurant_id,
        created_by_id=current_user.id,
        target_max_user_id=payload.max_user_id,
        token_hash=hashlib.sha256(token.encode()).hexdigest(),
        role=payload.role,
        expires_at=datetime.now(UTC) + timedelta(hours=24),
    )
    session.add(invite)
    await session.commit()
    url = build_max_deep_link(settings.max_bot_username, f"inv_{token}")
    if url is None:
        url = f"{settings.public_app_url.rstrip('/')}/invite/{token}"
    return InviteCreated(**invite_response(invite).model_dump(), invite_url=url)


@router.delete("/restaurants/{restaurant_id}/invites/{invite_id}", status_code=204)
async def revoke_invite(
    restaurant_id: uuid.UUID,
    invite_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> None:
    await require_owner(session, current_user, restaurant_id)
    invite = await session.scalar(select(RestaurantInvite).where(
        RestaurantInvite.id == invite_id,
        RestaurantInvite.restaurant_id == restaurant_id,
    ).with_for_update())
    if invite is None:
        raise HTTPException(status_code=404, detail="Invite not found")
    if invite.accepted_at is not None:
        raise HTTPException(status_code=409, detail="Invite already accepted")
    invite.revoked_at = datetime.now(UTC)
    await session.commit()


@router.post("/invites/accept", response_model=MemberResponse)
async def accept_invite(
    payload: InviteAccept,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> MemberResponse:
    token_hash = hashlib.sha256(payload.token.encode()).hexdigest()
    invite = await session.scalar(select(RestaurantInvite).where(
        RestaurantInvite.token_hash == token_hash
    ).with_for_update())
    if invite is None or invite.revoked_at is not None or invite.accepted_at is not None:
        raise HTTPException(status_code=404, detail="Invite not found")
    if invite.expires_at <= datetime.now(UTC):
        raise HTTPException(status_code=410, detail="Invite expired")
    if invite.target_max_user_id != current_user.max_user_id:
        raise HTTPException(status_code=403, detail="Invite is for another MAX account")
    restaurant = await session.get(Restaurant, invite.restaurant_id)
    if restaurant is None or restaurant.owner_id == current_user.id:
        raise HTTPException(status_code=409, detail="Invite cannot be accepted")
    member = await session.get(RestaurantMember, (invite.restaurant_id, current_user.id))
    if member is None:
        member = RestaurantMember(
            restaurant_id=invite.restaurant_id,
            user_id=current_user.id,
            role=invite.role,
        )
        session.add(member)
    else:
        member.role = invite.role
    invite.accepted_by_id = current_user.id
    invite.accepted_at = datetime.now(UTC)
    await session.commit()
    return MemberResponse(
        user_id=current_user.id,
        max_user_id=current_user.max_user_id,
        display_name=current_user.display_name,
        role=member.role,
    )
