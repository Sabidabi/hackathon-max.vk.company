"""Venue admins: one equal role, a protected creator and one-time invitation links.

Admin rights cover the whole venue. The per-point routes (``/restaurants/{id}/…``) resolve
the point to its venue and stay for the current cabinet; ``/venues/{id}/…`` are the same
operations addressed by venue.
"""

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi import Path as PathParam
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.permissions import VENUE_NOT_FOUND, require_admin_of_venue
from app.bot.events import on_admin_joined
from app.config import Settings, get_settings
from app.database import get_session
from app.max_api.client import build_max_deep_link
from app.models import ADMIN_ROLE, Restaurant, RestaurantInvite, User, Venue, VenueMember

router = APIRouter(tags=["team"])
InviteRole = Literal["admin", "manager", "editor"]

LAST_ADMIN_DETAIL = "Назначьте другого администратора перед выходом"
CREATOR_LEAVE_DETAIL = "Создатель заведения не может выйти из него"
CREATOR_REMOVE_DETAIL = "Создателя заведения нельзя удалить"
ALREADY_ADMIN_DETAIL = "Этот пользователь уже администратор заведения"
INVALID_INVITE_DETAIL = "Приглашение недействительно. Попросите администратора прислать новое."
FOREIGN_INVITE_DETAIL = "Приглашение предназначено другому аккаунту MAX"
RATE_LIMIT_DETAIL = "Слишком много приглашений. Попробуйте позже."

INVITE_TTL = timedelta(hours=24)
INVITE_RATE_LIMIT = 20
INVITE_RATE_WINDOW = timedelta(hours=1)
TOKEN_PATTERN = r"^[A-Za-z0-9_-]+$"
InviteToken = Annotated[str, Field(min_length=30, max_length=128, pattern=TOKEN_PATTERN)]
InviteTokenPath = Annotated[
    str, PathParam(min_length=30, max_length=128, pattern=TOKEN_PATTERN)
]


class MemberResponse(BaseModel):
    user_id: uuid.UUID
    max_user_id: int
    display_name: str
    role: str
    is_creator: bool


class InviteCreate(BaseModel):
    # Optional since link invites: without it anyone who opens the link may accept it.
    max_user_id: int | None = Field(default=None, gt=0, le=9_223_372_036_854_775_807)
    # Legacy staff roles are accepted for compatibility and all become "admin".
    role: InviteRole = "admin"


class InviteResponse(BaseModel):
    id: uuid.UUID
    max_user_id: int | None
    role: str
    invited_by: str
    expires_at: datetime
    accepted_at: datetime | None
    revoked_at: datetime | None


class InviteCreated(InviteResponse):
    invite_url: str  # MAX deep link when the bot is configured, otherwise the web link
    max_deep_link: str | None
    web_url: str


class InviteAccept(BaseModel):
    token: InviteToken


class InvitePreview(BaseModel):
    restaurant_name: str  # the venue name; kept under the old key for existing clients
    venue_name: str
    invited_by: str
    expires_at: datetime
    already_admin: bool


def invite_response(invite: RestaurantInvite, invited_by: str) -> InviteResponse:
    return InviteResponse(
        id=invite.id,
        max_user_id=invite.target_max_user_id,
        role=invite.role,
        invited_by=invited_by,
        expires_at=invite.expires_at,
        accepted_at=invite.accepted_at,
        revoked_at=invite.revoked_at,
    )


def member_response(member: VenueMember, user: User) -> MemberResponse:
    return MemberResponse(
        user_id=user.id,
        max_user_id=user.max_user_id,
        display_name=user.display_name,
        role=member.role,
        is_creator=member.is_creator,
    )


def hash_invite_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def venue_of_point(
    session: AsyncSession, user: User, restaurant_id: uuid.UUID
) -> uuid.UUID:
    """The venue of a point the caller administers; anything else is 404."""
    venue_id = await session.scalar(
        select(Restaurant.venue_id)
        .join(VenueMember, VenueMember.venue_id == Restaurant.venue_id)
        .where(Restaurant.id == restaurant_id, VenueMember.user_id == user.id)
    )
    if venue_id is None:
        raise HTTPException(status_code=404, detail=VENUE_NOT_FOUND)
    return venue_id


async def lock_venue_admins(session: AsyncSession, venue_id: uuid.UUID) -> list[VenueMember]:
    """Serialize membership changes per venue so it can never drop to zero admins."""
    await session.execute(select(Venue.id).where(Venue.id == venue_id).with_for_update())
    return list((await session.scalars(
        select(VenueMember).where(VenueMember.venue_id == venue_id)
    )).all())


async def remove_admin(
    session: AsyncSession, actor: User, venue_id: uuid.UUID, user_id: uuid.UUID
) -> None:
    members = await lock_venue_admins(session, venue_id)
    if not any(member.user_id == actor.id for member in members):
        raise HTTPException(status_code=404, detail=VENUE_NOT_FOUND)
    target = next((member for member in members if member.user_id == user_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail="Member not found")
    if user_id == actor.id:
        if len(members) == 1:
            raise HTTPException(status_code=409, detail=LAST_ADMIN_DETAIL)
        if target.is_creator:
            raise HTTPException(status_code=409, detail=CREATOR_LEAVE_DETAIL)
    elif target.is_creator:
        raise HTTPException(status_code=403, detail=CREATOR_REMOVE_DETAIL)
    await session.delete(target)
    # A removed admin must not regain access through links they handed out earlier.
    await revoke_pending_invites(session, venue_id, user_id)
    await session.commit()


async def revoke_pending_invites(
    session: AsyncSession, venue_id: uuid.UUID, created_by_id: uuid.UUID
) -> None:
    await session.execute(
        update(RestaurantInvite)
        .where(
            RestaurantInvite.venue_id == venue_id,
            RestaurantInvite.created_by_id == created_by_id,
            RestaurantInvite.accepted_at.is_(None),
            RestaurantInvite.revoked_at.is_(None),
        )
        .values(revoked_at=func.now())
        .execution_options(synchronize_session=False)
    )


async def list_venue_members(session: AsyncSession, venue_id: uuid.UUID) -> list[MemberResponse]:
    rows = (await session.execute(
        select(VenueMember, User)
        .join(User, User.id == VenueMember.user_id)
        .where(VenueMember.venue_id == venue_id)
        .order_by(VenueMember.is_creator.desc(), VenueMember.created_at)
    )).all()
    return [member_response(member, user) for member, user in rows]


async def list_venue_invites(session: AsyncSession, venue_id: uuid.UUID) -> list[InviteResponse]:
    rows = (await session.execute(
        select(RestaurantInvite, User.display_name)
        .join(User, User.id == RestaurantInvite.created_by_id)
        .where(RestaurantInvite.venue_id == venue_id)
        .order_by(RestaurantInvite.created_at.desc())
        .limit(50)
    )).all()
    return [invite_response(invite, invited_by) for invite, invited_by in rows]


async def create_venue_invite(
    session: AsyncSession,
    *,
    venue_id: uuid.UUID,
    point_id: uuid.UUID | None,
    actor: User,
    settings: Settings,
    payload: InviteCreate,
) -> InviteCreated:
    """One-time admin link for 24 h; only the SHA-256 of the token is stored."""
    now = datetime.now(UTC)
    recent_count = await session.scalar(
        select(func.count()).select_from(RestaurantInvite).where(
            RestaurantInvite.created_by_id == actor.id,
            RestaurantInvite.created_at > now - INVITE_RATE_WINDOW,
        )
    )
    if (recent_count or 0) >= INVITE_RATE_LIMIT:
        raise HTTPException(status_code=429, detail=RATE_LIMIT_DETAIL)
    if payload.max_user_id is not None:
        already_admin = await session.scalar(
            select(VenueMember.user_id)
            .join(User, User.id == VenueMember.user_id)
            .where(VenueMember.venue_id == venue_id, User.max_user_id == payload.max_user_id)
        )
        if already_admin is not None:
            raise HTTPException(status_code=409, detail=ALREADY_ADMIN_DETAIL)
    token = secrets.token_urlsafe(32)
    invite = RestaurantInvite(
        venue_id=venue_id,
        restaurant_id=point_id,
        created_by_id=actor.id,
        target_max_user_id=payload.max_user_id,
        token_hash=hash_invite_token(token),
        role=ADMIN_ROLE,
        expires_at=now + INVITE_TTL,
    )
    session.add(invite)
    await session.commit()
    deep_link = build_max_deep_link(settings.max_bot_username, f"inv_{token}")
    web_url = f"{settings.public_app_url.rstrip('/')}/invite/{token}"
    return InviteCreated(
        **invite_response(invite, actor.display_name).model_dump(),
        invite_url=deep_link or web_url,
        max_deep_link=deep_link,
        web_url=web_url,
    )


async def revoke_venue_invite(
    session: AsyncSession, venue_id: uuid.UUID, invite_id: uuid.UUID
) -> None:
    invite = await session.scalar(select(RestaurantInvite).where(
        RestaurantInvite.id == invite_id,
        RestaurantInvite.venue_id == venue_id,
    ).with_for_update())
    if invite is None:
        raise HTTPException(status_code=404, detail="Invite not found")
    if invite.accepted_at is not None:
        raise HTTPException(status_code=409, detail="Invite already accepted")
    invite.revoked_at = datetime.now(UTC)
    await session.commit()


# Per-point routes (current cabinet): the point only selects its venue.


@router.get("/restaurants/{restaurant_id}/members", response_model=list[MemberResponse])
async def list_members(
    restaurant_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[MemberResponse]:
    venue_id = await venue_of_point(session, current_user, restaurant_id)
    return await list_venue_members(session, venue_id)


@router.delete("/restaurants/{restaurant_id}/members/{user_id}", status_code=204)
async def remove_member(
    restaurant_id: uuid.UUID,
    user_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> None:
    """Any admin removes another non-creator admin; removing yourself means leaving."""
    venue_id = await venue_of_point(session, current_user, restaurant_id)
    await remove_admin(session, current_user, venue_id, user_id)


@router.post("/restaurants/{restaurant_id}/leave", status_code=204)
async def leave_restaurant(
    restaurant_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> None:
    venue_id = await venue_of_point(session, current_user, restaurant_id)
    await remove_admin(session, current_user, venue_id, current_user.id)


@router.get("/restaurants/{restaurant_id}/invites", response_model=list[InviteResponse])
async def list_invites(
    restaurant_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[InviteResponse]:
    venue_id = await venue_of_point(session, current_user, restaurant_id)
    return await list_venue_invites(session, venue_id)


@router.post("/restaurants/{restaurant_id}/invites", response_model=InviteCreated, status_code=201)
async def create_invite(
    restaurant_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
    payload: InviteCreate | None = None,
) -> InviteCreated:
    venue_id = await venue_of_point(session, current_user, restaurant_id)
    return await create_venue_invite(
        session, venue_id=venue_id, point_id=restaurant_id, actor=current_user,
        settings=settings, payload=payload or InviteCreate(),
    )


@router.delete("/restaurants/{restaurant_id}/invites/{invite_id}", status_code=204)
async def revoke_invite(
    restaurant_id: uuid.UUID,
    invite_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> None:
    venue_id = await venue_of_point(session, current_user, restaurant_id)
    await revoke_venue_invite(session, venue_id, invite_id)


# Venue-addressed routes (library cabinet).


@router.get("/venues/{venue_id}/members", response_model=list[MemberResponse])
async def list_members_of_venue(
    venue_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[MemberResponse]:
    await require_admin_of_venue(session, current_user.id, venue_id)
    return await list_venue_members(session, venue_id)


@router.delete("/venues/{venue_id}/members/{user_id}", status_code=204)
async def remove_member_of_venue(
    venue_id: uuid.UUID,
    user_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> None:
    await remove_admin(session, current_user, venue_id, user_id)


@router.post("/venues/{venue_id}/leave", status_code=204)
async def leave_venue(
    venue_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> None:
    await remove_admin(session, current_user, venue_id, current_user.id)


@router.get("/venues/{venue_id}/invites", response_model=list[InviteResponse])
async def list_invites_of_venue(
    venue_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[InviteResponse]:
    await require_admin_of_venue(session, current_user.id, venue_id)
    return await list_venue_invites(session, venue_id)


@router.post("/venues/{venue_id}/invites", response_model=InviteCreated, status_code=201)
async def create_invite_of_venue(
    venue_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
    payload: InviteCreate | None = None,
) -> InviteCreated:
    await require_admin_of_venue(session, current_user.id, venue_id)
    return await create_venue_invite(
        session, venue_id=venue_id, point_id=None, actor=current_user, settings=settings,
        payload=payload or InviteCreate(),
    )


@router.delete("/venues/{venue_id}/invites/{invite_id}", status_code=204)
async def revoke_invite_of_venue(
    venue_id: uuid.UUID,
    invite_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> None:
    await require_admin_of_venue(session, current_user.id, venue_id)
    await revoke_venue_invite(session, venue_id, invite_id)


async def load_usable_invite(
    session: AsyncSession, token: str, user: User, *, lock: bool = False
) -> RestaurantInvite:
    """Used, revoked, expired and orphaned links get one answer: invalid, ask for a new one."""
    statement = select(RestaurantInvite).where(
        RestaurantInvite.token_hash == hash_invite_token(token)
    )
    if lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    invite = await session.scalar(statement)
    if invite is None:
        raise HTTPException(status_code=404, detail=INVALID_INVITE_DETAIL)
    if (
        invite.accepted_at is not None
        or invite.revoked_at is not None
        or invite.expires_at <= datetime.now(UTC)
    ):
        raise HTTPException(status_code=410, detail=INVALID_INVITE_DETAIL)
    # Second line of defence behind revocation on removal: a link is only as good as its
    # author's current admin rights in this venue.
    author_is_admin = await session.scalar(
        select(VenueMember.user_id).where(
            VenueMember.venue_id == invite.venue_id,
            VenueMember.user_id == invite.created_by_id,
        )
    )
    if author_is_admin is None:
        raise HTTPException(status_code=410, detail=INVALID_INVITE_DETAIL)
    if invite.target_max_user_id is not None and invite.target_max_user_id != user.max_user_id:
        raise HTTPException(status_code=403, detail=FOREIGN_INVITE_DETAIL)
    return invite


@router.get("/invites/{token}/preview", response_model=InvitePreview)
async def preview_invite(
    token: InviteTokenPath,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> InvitePreview:
    """What the invitee sees before accepting: venue name, inviter and expiry, nothing more."""
    invite = await load_usable_invite(session, token, current_user)
    venue_name = await session.scalar(select(Venue.name).where(Venue.id == invite.venue_id))
    invited_by = await session.scalar(
        select(User.display_name).where(User.id == invite.created_by_id)
    )
    member = await session.get(VenueMember, (invite.venue_id, current_user.id))
    return InvitePreview(
        restaurant_name=venue_name or "",
        venue_name=venue_name or "",
        invited_by=invited_by or "",
        expires_at=invite.expires_at,
        already_admin=member is not None,
    )


async def accept(session: AsyncSession, token: str, user: User) -> MemberResponse:
    # Lock order matches remove_admin (venue, then invites): peek, lock the venue, re-check.
    invite = await load_usable_invite(session, token, user)
    members = await lock_venue_admins(session, invite.venue_id)
    invite = await load_usable_invite(session, token, user, lock=True)
    if any(member.user_id == user.id for member in members):
        # Keep the link usable: it was probably opened by the wrong person.
        raise HTTPException(status_code=409, detail=ALREADY_ADMIN_DETAIL)
    member = VenueMember(
        venue_id=invite.venue_id,
        user_id=user.id,
        role=ADMIN_ROLE,
        is_creator=False,
    )
    session.add(member)
    invite.accepted_by_id = user.id
    invite.accepted_at = datetime.now(UTC)
    await session.flush()
    await on_admin_joined(session, venue_id=invite.venue_id, user=user)
    await session.commit()
    return member_response(member, user)


@router.post("/invites/{token}/accept", response_model=MemberResponse)
async def accept_invite_link(
    token: InviteTokenPath,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> MemberResponse:
    return await accept(session, token, current_user)


@router.post("/invites/accept", response_model=MemberResponse)
async def accept_invite(
    payload: InviteAccept,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> MemberResponse:
    """Legacy body-token variant kept for existing clients."""
    return await accept(session, payload.token, current_user)
