"""Writing to the bot outbox. The caller commits together with its own event, so a message
exists exactly when the event does; ``dedup_key`` turns a repeated event into a no-op."""

import uuid
from collections.abc import Iterable
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    ADMIN_NOTIFICATION_KINDS,
    AdminNotificationMute,
    BotOutbox,
    VenueMember,
)

MARKETING = "marketing"
SERVICE = "service"
REPLY = "reply"


async def enqueue(
    session: AsyncSession,
    *,
    dedup_key: str,
    kind: str,
    category: str,
    body: str,
    user_id: uuid.UUID | None = None,
    chat_id: int | None = None,
    restaurant_id: uuid.UUID | None = None,
    venue_id: uuid.UUID | None = None,
    conversation_id: uuid.UUID | None = None,
    buttons: list[list[dict[str, Any]]] | None = None,
    attachments: list[dict[str, Any]] | None = None,
    payload: dict[str, Any] | None = None,
    not_before: datetime | None = None,
) -> uuid.UUID | None:
    """Insert one message; returns its id, or None when the key was already used."""
    values: dict[str, Any] = {
        "id": uuid.uuid4(),
        "dedup_key": dedup_key[:200],
        "kind": kind,
        "category": category,
        "body": body[:4000],
        "user_id": user_id,
        "chat_id": chat_id,
        "restaurant_id": restaurant_id,
        "venue_id": venue_id,
        "conversation_id": conversation_id,
        "buttons": buttons or [],
        "attachments": attachments or [],
        "payload": payload or {},
        "status": "pending",
        "attempt_count": 0,
    }
    if not_before is not None:
        values["not_before"] = not_before
    return await session.scalar(
        insert(BotOutbox)
        .values(**values)
        .on_conflict_do_nothing(index_elements=[BotOutbox.dedup_key])
        .returning(BotOutbox.id)
    )


async def admin_recipients(
    session: AsyncSession,
    venue_id: uuid.UUID,
    kind: str,
    *,
    exclude: Iterable[uuid.UUID] = (),
) -> list[uuid.UUID]:
    """Admins of the venue who have not switched this notification type off."""
    assert kind in ADMIN_NOTIFICATION_KINDS
    muted = select(AdminNotificationMute.user_id).where(
        AdminNotificationMute.venue_id == venue_id, AdminNotificationMute.kind == kind
    )
    excluded = set(exclude)
    users = (await session.scalars(
        select(VenueMember.user_id)
        .where(VenueMember.venue_id == venue_id, VenueMember.user_id.not_in(muted))
        .order_by(VenueMember.created_at)
    )).all()
    return [user_id for user_id in users if user_id not in excluded]


async def is_muted(
    session: AsyncSession, user_id: uuid.UUID, venue_id: uuid.UUID, kind: str
) -> bool:
    return await session.get(AdminNotificationMute, (user_id, venue_id, kind)) is not None
