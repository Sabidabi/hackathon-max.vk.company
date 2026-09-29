"""Support tickets (P1-TASK-63) and guest ↔ point dialogs (P1-TASK-64).

Messages are untrusted data: stored and forwarded as plain text, never interpreted. Every
outgoing copy goes through the outbox; replies are not subject to quiet hours.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.bot.links import app_button, callback_button, manage_payload
from app.bot.outbox import REPLY, SERVICE, admin_recipients, enqueue
from app.config import Settings
from app.models import (
    Conversation,
    ConversationBlock,
    ConversationMessage,
    Restaurant,
    User,
    Venue,
    VenueMember,
)

MINUTE_LIMIT = 5
DAY_LIMIT = 40
NEW_POINT_DIALOGS_PER_DAY = 5
MAX_TEXT = 2000
MAX_ATTACHMENTS = 5


class ConversationError(Exception):
    """A refusal the user should read (limits, block, closed dialog)."""


@dataclass
class Posted:
    conversation: Conversation
    message: ConversationMessage
    first: bool


def clean_attachments(raw: object) -> list[dict[str, Any]]:
    """Keep only photos (by URL/token) of the incoming message; everything else is dropped."""
    result: list[dict[str, Any]] = []
    if not isinstance(raw, list):
        return result
    for item in raw[:MAX_ATTACHMENTS]:
        if not isinstance(item, dict) or item.get("type") != "image":
            continue
        payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
        kept = {
            key: str(payload[key])[:2048]
            for key in ("url", "token")
            if isinstance(payload.get(key), str | int)
        }
        if kept:
            result.append({"type": "image", "payload": kept})
    return result


def as_outgoing_attachments(attachments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Re-send photos by token when MAX gave one, else by URL."""
    result = []
    for item in attachments:
        payload = item.get("payload", {})
        if payload.get("token"):
            result.append({"type": "image", "payload": {"token": payload["token"]}})
        elif payload.get("url"):
            result.append({"type": "image", "payload": {"url": payload["url"]}})
    return result


async def check_rate(session: AsyncSession, user_id: uuid.UUID, now: datetime) -> None:
    """Antispam: incoming messages of one person across all their conversations."""
    base = (
        select(func.count(ConversationMessage.id))
        .join(Conversation, Conversation.id == ConversationMessage.conversation_id)
        .where(Conversation.user_id == user_id, ConversationMessage.direction == "in")
    )
    if (await session.scalar(
        base.where(ConversationMessage.created_at > now - timedelta(minutes=1))
    ) or 0) >= MINUTE_LIMIT:
        raise ConversationError("Слишком много сообщений подряд. Подождите минуту.")
    if (await session.scalar(
        base.where(ConversationMessage.created_at > now - timedelta(days=1))
    ) or 0) >= DAY_LIMIT:
        raise ConversationError("Лимит сообщений на сегодня исчерпан. Напишите завтра.")


async def _add_message(
    session: AsyncSession,
    conversation: Conversation,
    *,
    direction: str,
    author_id: uuid.UUID | None,
    text: str,
    attachments: list[dict[str, Any]],
    now: datetime,
) -> ConversationMessage:
    message = ConversationMessage(
        id=uuid.uuid4(),
        conversation_id=conversation.id,
        direction=direction,
        author_user_id=author_id,
        body=text[:MAX_TEXT],
        attachments=attachments,
        created_at=now,
    )
    session.add(message)
    conversation.last_message_at = now
    await session.flush()
    return message


# --- Support ---


async def open_support_ticket(session: AsyncSession, user: User) -> tuple[Conversation, bool]:
    """The open ticket of the user, or a new one; ``True`` when it was created."""
    ticket = await session.scalar(
        select(Conversation).where(
            Conversation.kind == "support",
            Conversation.user_id == user.id,
            Conversation.status != "closed",
        )
    )
    if ticket is not None:
        return ticket, False
    is_admin = await session.scalar(
        select(VenueMember.user_id).where(VenueMember.user_id == user.id).limit(1)
    )
    ticket = Conversation(
        kind="support", user_id=user.id, requester_role="admin" if is_admin else "user"
    )
    session.add(ticket)
    await session.flush()
    await session.refresh(ticket)
    return ticket, True


async def post_support_message(
    session: AsyncSession,
    settings: Settings,
    *,
    user: User,
    ticket: Conversation,
    text: str,
    attachments: list[dict[str, Any]],
    now: datetime,
) -> Posted:
    if ticket.status == "closed":
        raise ConversationError("Обращение закрыто. Нажмите /support, чтобы открыть новое.")
    await check_rate(session, user.id, now)
    first = not await session.scalar(
        select(ConversationMessage.id)
        .where(ConversationMessage.conversation_id == ticket.id)
        .limit(1)
    )
    message = await _add_message(
        session, ticket, direction="in", author_id=user.id, text=text,
        attachments=attachments, now=now,
    )
    ticket.status = "open"
    if settings.support_chat_id is not None:
        venues = (await session.scalars(
            select(Venue.name)
            .join(VenueMember, VenueMember.venue_id == Venue.id)
            .where(VenueMember.user_id == user.id)
            .limit(3)
        )).all()
        role = "админ «" + "», «".join(venues) + "»" if venues else "гость"
        await enqueue(
            session,
            dedup_key=f"sf:{message.id}",
            kind="support_forward",
            category=REPLY,
            chat_id=settings.support_chat_id,
            conversation_id=ticket.id,
            body=(
                f"Обращение №{ticket.number} · {user.display_name} · {role}\n"
                f"Ответьте на это сообщение, чтобы написать пользователю.\n\n{message.body}"
            ),
            attachments=as_outgoing_attachments(attachments),
            buttons=[[callback_button("Закрыть обращение", f"support_close:{ticket.id}")]],
        )
    return Posted(ticket, message, first)


async def answer_support(
    session: AsyncSession,
    *,
    ticket: Conversation,
    text: str,
    attachments: list[dict[str, Any]],
    now: datetime,
) -> ConversationMessage:
    """Operator's reply in the support chat → the requester, through the outbox."""
    message = await _add_message(
        session, ticket, direction="out", author_id=None, text=text,
        attachments=attachments, now=now,
    )
    if ticket.status != "closed":
        ticket.status = "answered"
    await enqueue(
        session,
        dedup_key=f"sr:{message.id}",
        kind="support_reply",
        category=REPLY,
        user_id=ticket.user_id,
        conversation_id=ticket.id,
        body=f"Поддержка «Синицы», обращение №{ticket.number}:\n{message.body}",
        attachments=as_outgoing_attachments(attachments),
        buttons=[[callback_button("Закрыть обращение", f"support_close:{ticket.id}")]],
    )
    return message


def close_conversation(conversation: Conversation, now: datetime) -> None:
    conversation.status = "closed"
    conversation.closed_at = now
    conversation.admin_unread = 0


# --- Guest ↔ point ---


async def open_point_dialog(
    session: AsyncSession, user: User, point: Restaurant, now: datetime
) -> Conversation:
    if await session.get(ConversationBlock, (point.venue_id, user.id)) is not None:
        raise ConversationError("Заведение ограничило сообщения от вас.")
    dialog = await session.scalar(
        select(Conversation).where(
            Conversation.kind == "point",
            Conversation.user_id == user.id,
            Conversation.point_id == point.id,
            Conversation.status != "closed",
        )
    )
    if dialog is not None:
        return dialog
    started_today = await session.scalar(
        select(func.count(Conversation.id)).where(
            Conversation.kind == "point",
            Conversation.user_id == user.id,
            Conversation.created_at > now - timedelta(days=1),
        )
    ) or 0
    if started_today >= NEW_POINT_DIALOGS_PER_DAY:
        raise ConversationError("Слишком много новых диалогов за сутки. Попробуйте завтра.")
    dialog = Conversation(
        kind="point", user_id=user.id, point_id=point.id, venue_id=point.venue_id,
        created_at=now, last_message_at=now,
    )
    session.add(dialog)
    await session.flush()
    await session.refresh(dialog)
    return dialog


def point_signature(venue_name: str | None, point: Restaurant) -> str:
    """How a point signs its answers: «Кофейня Север · Покровка», never the admin's name."""
    if venue_name and venue_name != point.name:
        return f"{venue_name} · {point.name}"
    return point.name


async def post_guest_message(
    session: AsyncSession,
    *,
    user: User,
    dialog: Conversation,
    text: str,
    attachments: list[dict[str, Any]],
    now: datetime,
) -> Posted:
    if dialog.status == "closed":
        raise ConversationError("Диалог закрыт. Откройте его снова из меню заведения.")
    if await session.get(ConversationBlock, (dialog.venue_id, user.id)) is not None:
        raise ConversationError("Заведение ограничило сообщения от вас.")
    await check_rate(session, user.id, now)
    first = not await session.scalar(
        select(ConversationMessage.id)
        .where(ConversationMessage.conversation_id == dialog.id)
        .limit(1)
    )
    message = await _add_message(
        session, dialog, direction="in", author_id=user.id, text=text,
        attachments=attachments, now=now,
    )
    dialog.status = "open"
    dialog.admin_unread += 1
    point = await session.get(Restaurant, dialog.point_id)
    assert point is not None and dialog.venue_id is not None
    preview = message.body or "Фото"
    for admin_id in await admin_recipients(session, dialog.venue_id, "a8_point_message"):
        await enqueue(
            session,
            dedup_key=f"a8:{message.id}:{admin_id}",
            kind="a8_point_message",
            category=SERVICE,
            user_id=admin_id,
            venue_id=dialog.venue_id,
            restaurant_id=point.id,
            conversation_id=dialog.id,
            body=(
                f"«{point.name}»: сообщение гостя {user.first_name or user.display_name} "
                f"(диалог №{dialog.number})\n\n{preview}"
            ),
            attachments=as_outgoing_attachments(attachments),
            buttons=[
                [callback_button("Ответить", f"reply:{dialog.id}")],
                [app_button("Все сообщения", manage_payload(point.public_id, "messages"))],
            ],
        )
    return Posted(dialog, message, first)


async def answer_guest(
    session: AsyncSession,
    *,
    dialog: Conversation,
    admin: User,
    text: str,
    attachments: list[dict[str, Any]],
    now: datetime,
) -> ConversationMessage:
    """An admin's answer (bot reply or cabinet) → the guest, signed by the point."""
    if dialog.kind != "point" or dialog.venue_id is None:
        raise ConversationError("Это не диалог точки.")
    if await session.get(VenueMember, (dialog.venue_id, admin.id)) is None:
        raise ConversationError("Диалог недоступен.")
    if dialog.status == "closed":
        raise ConversationError("Диалог закрыт.")
    point = await session.get(Restaurant, dialog.point_id)
    venue_name = await session.scalar(select(Venue.name).where(Venue.id == dialog.venue_id))
    assert point is not None
    message = await _add_message(
        session, dialog, direction="out", author_id=admin.id, text=text,
        attachments=attachments, now=now,
    )
    dialog.status = "answered"
    dialog.admin_unread = 0
    await enqueue(
        session,
        dedup_key=f"pr:{message.id}",
        kind="point_reply",
        category=REPLY,
        user_id=dialog.user_id,
        restaurant_id=point.id,
        venue_id=dialog.venue_id,
        conversation_id=dialog.id,
        body=f"{point_signature(venue_name, point)}:\n{message.body}",
        attachments=as_outgoing_attachments(attachments),
        buttons=[[callback_button("Закрыть диалог", f"chat_close:{dialog.id}")]],
    )
    return message


def utcnow() -> datetime:
    return datetime.now(UTC)
