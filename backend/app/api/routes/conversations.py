"""«Ещё → Сообщения»: guest dialogs of a point for the venue admins.

Only admins of the point's venue see its dialogs (404 otherwise). Answers go to the guest
through the bot outbox, signed with the point's name; the admin's identity is not shown.
Guest texts are untrusted data and are returned as plain strings.
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.bot_settings import bot_link
from app.auth.dependencies import get_current_user
from app.auth.permissions import require_point_admin
from app.bot import conversations as conv
from app.config import Settings, get_settings
from app.database import get_session
from app.models import (
    Conversation,
    ConversationBlock,
    ConversationMessage,
    Restaurant,
    User,
    VenueMember,
)

router = APIRouter(tags=["conversations"])
NOT_FOUND = "Диалог не найден"


class ConversationSummary(BaseModel):
    id: uuid.UUID
    number: int
    status: Literal["open", "answered", "closed"]
    guest_name: str
    last_message: str
    last_message_at: datetime
    unread: int
    blocked: bool


class ConversationMessageResponse(BaseModel):
    id: uuid.UUID
    direction: Literal["in", "out"]
    text: str
    photo_count: int
    created_at: datetime


class ConversationDetail(ConversationSummary):
    point_id: uuid.UUID
    point_name: str
    messages: list[ConversationMessageResponse]


class ReplyPayload(BaseModel):
    text: str = Field(min_length=1, max_length=conv.MAX_TEXT)

    @field_validator("text")
    @classmethod
    def not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Пустой ответ")
        return value.strip()


class BlockPayload(BaseModel):
    blocked: bool


class ChatLink(BaseModel):
    url: str | None


async def _admin_conversation(
    session: AsyncSession, user: User, conversation_id: uuid.UUID, *, lock: bool = False
) -> Conversation:
    statement = (
        select(Conversation)
        .join(VenueMember, VenueMember.venue_id == Conversation.venue_id)
        .where(
            Conversation.id == conversation_id,
            Conversation.kind == "point",
            VenueMember.user_id == user.id,
        )
    )
    if lock:
        statement = statement.with_for_update(of=Conversation)
    found = await session.scalar(statement)
    if found is None:
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    return found


async def _summaries(
    session: AsyncSession, conversations: list[Conversation]
) -> list[ConversationSummary]:
    if not conversations:
        return []
    ids = [item.id for item in conversations]
    last = {
        row.conversation_id: row.body
        for row in (await session.execute(
            select(ConversationMessage.conversation_id, ConversationMessage.body)
            .where(ConversationMessage.conversation_id.in_(ids))
            .order_by(ConversationMessage.conversation_id, ConversationMessage.created_at.desc())
            .distinct(ConversationMessage.conversation_id)
        )).all()
    }
    users = {
        user.id: user
        for user in (await session.scalars(
            select(User).where(User.id.in_({item.user_id for item in conversations}))
        )).all()
    }
    venue_ids = {item.venue_id for item in conversations}
    blocked = {
        (row.venue_id, row.user_id)
        for row in (await session.scalars(
            select(ConversationBlock).where(ConversationBlock.venue_id.in_(venue_ids))
        )).all()
    }
    return [
        ConversationSummary(
            id=item.id,
            number=item.number,
            status=item.status,
            guest_name=(users[item.user_id].first_name or users[item.user_id].display_name)
            if item.user_id in users else "Гость",
            last_message=(last.get(item.id) or "Фото")[:160],
            last_message_at=item.last_message_at,
            unread=item.admin_unread,
            blocked=(item.venue_id, item.user_id) in blocked,
        )
        for item in conversations
    ]


@router.get("/points/{point_id}/conversations", response_model=list[ConversationSummary])
async def list_point_conversations(
    point_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[ConversationSummary]:
    await require_point_admin(session, current_user.id, point_id)
    conversations = list((await session.scalars(
        select(Conversation)
        .where(
            Conversation.kind == "point",
            Conversation.point_id == point_id,
            # Opened in the bot but never written to — nothing to show.
            select(func.count(ConversationMessage.id))
            .where(ConversationMessage.conversation_id == Conversation.id)
            .scalar_subquery() > 0,
        )
        .order_by(Conversation.last_message_at.desc())
        .limit(100)
    )).all())
    return await _summaries(session, conversations)


@router.get("/conversations/{conversation_id}", response_model=ConversationDetail)
async def get_conversation(
    conversation_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> ConversationDetail:
    item = await _admin_conversation(session, current_user, conversation_id, lock=True)
    item.admin_unread = 0
    [summary] = await _summaries(session, [item])
    point = await session.get(Restaurant, item.point_id)
    messages = (await session.scalars(
        select(ConversationMessage)
        .where(ConversationMessage.conversation_id == item.id)
        .order_by(ConversationMessage.created_at)
        .limit(500)
    )).all()
    await session.commit()
    return ConversationDetail(
        **summary.model_dump(),
        point_id=item.point_id,
        point_name=point.name if point else "",
        messages=[
            ConversationMessageResponse(
                id=message.id,
                direction=message.direction,
                text=message.body,
                photo_count=len(message.attachments or []),
                created_at=message.created_at,
            )
            for message in messages
        ],
    )


@router.post("/conversations/{conversation_id}/reply", response_model=ConversationDetail)
async def reply_to_conversation(
    conversation_id: uuid.UUID,
    payload: ReplyPayload,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> ConversationDetail:
    item = await _admin_conversation(session, current_user, conversation_id, lock=True)
    try:
        await conv.answer_guest(
            session, dialog=item, admin=current_user, text=payload.text, attachments=[],
            now=datetime.now(UTC),
        )
    except conv.ConversationError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    await session.commit()
    return await get_conversation(conversation_id, session, current_user)


@router.post("/conversations/{conversation_id}/close", status_code=204)
async def close_point_conversation(
    conversation_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> Response:
    item = await _admin_conversation(session, current_user, conversation_id, lock=True)
    conv.close_conversation(item, datetime.now(UTC))
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/conversations/{conversation_id}/block", status_code=204)
async def block_guest(
    conversation_id: uuid.UUID,
    payload: BlockPayload,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> Response:
    """Block the guest for the whole venue; their open dialogs are closed."""
    item = await _admin_conversation(session, current_user, conversation_id, lock=True)
    if payload.blocked:
        await session.execute(
            insert(ConversationBlock)
            .values(venue_id=item.venue_id, user_id=item.user_id, created_by_id=current_user.id)
            .on_conflict_do_nothing()
        )
        conv.close_conversation(item, datetime.now(UTC))
    else:
        await session.execute(delete(ConversationBlock).where(
            ConversationBlock.venue_id == item.venue_id,
            ConversationBlock.user_id == item.user_id,
        ))
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/public/restaurants/{public_id}/chat-link", response_model=ChatLink)
async def point_chat_link(
    public_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> ChatLink:
    """«Написать в кофейню»: the bot dialog opened with ``chat_<public_id>``."""
    point_id = await session.scalar(select(Restaurant.id).where(Restaurant.public_id == public_id))
    if point_id is None:
        raise HTTPException(status_code=404, detail="Restaurant not found")
    return ChatLink(url=bot_link(settings, f"chat_{public_id}"))
