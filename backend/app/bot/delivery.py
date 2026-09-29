"""Worker side of the bot outbox: claim, re-check consent and limits, send, record.

Delivery is at most once: a row is marked ``processing`` in its own transaction before the
Bot API call. A worker that crashed after sending leaves the row ``processing``; recovery
marks such rows ``failed`` (``interrupted``) instead of sending them again, so a restart
never duplicates a message. Transient API errors are retried with exponential backoff.
"""

import logging
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.bot.outbox import MARKETING, is_muted
from app.config import Settings
from app.max_api.client import SendResult, send_bot_message
from app.models import (
    ADMIN_NOTIFICATION_KINDS,
    BotDialog,
    BotMessageLink,
    BotOutbox,
    ItemSubscription,
    NotificationCampaign,
    NotificationDelivery,
    RestaurantFavorite,
    User,
    VenueMember,
)

logger = logging.getLogger(__name__)
MAX_ATTEMPTS = 5
BASE_RETRY_DELAY = timedelta(seconds=30)
STALE_PROCESSING = timedelta(minutes=10)
GUEST_WEEKLY_MARKETING_LIMIT = 3
LINKED_KINDS = ("support_forward", "a8_point_message")

Sender = Callable[..., Awaitable[SendResult]]


async def recover_interrupted(session: AsyncSession, now: datetime) -> int:
    """Rows left ``processing`` by a crashed worker: the send may have happened — never
    resend, mark failed so the admin sees it."""
    result = await session.execute(
        update(BotOutbox)
        .where(BotOutbox.status == "processing", BotOutbox.updated_at < now - STALE_PROCESSING)
        .values(status="failed", error_code="interrupted", updated_at=now)
    )
    await session.commit()
    return result.rowcount or 0


async def claim_next(session: AsyncSession, now: datetime) -> uuid.UUID | None:
    async with session.begin():
        row = await session.scalar(
            select(BotOutbox)
            .where(BotOutbox.status == "pending", BotOutbox.not_before <= now)
            .order_by(BotOutbox.not_before, BotOutbox.created_at)
            .with_for_update(skip_locked=True)
            .limit(1)
        )
        if row is None:
            return None
        row.status = "processing"
        row.attempt_count += 1
        row.updated_at = now
        return row.id


async def guest_marketing_sent(session: AsyncSession, user_id: uuid.UUID, now: datetime) -> int:
    """Marketing messages the guest got in 7 days: bot notifications and admin mailings."""
    since = now - timedelta(days=7)
    bot = await session.scalar(
        select(func.count(BotOutbox.id)).where(
            BotOutbox.user_id == user_id,
            BotOutbox.category == MARKETING,
            BotOutbox.status == "sent",
            BotOutbox.sent_at >= since,
        )
    ) or 0
    mailings = await session.scalar(
        select(func.count(NotificationDelivery.id))
        .join(NotificationCampaign, NotificationCampaign.id == NotificationDelivery.campaign_id)
        .where(
            NotificationDelivery.user_id == user_id,
            NotificationCampaign.kind == "marketing",
            NotificationDelivery.status == "sent",
            NotificationDelivery.sent_at >= since,
        )
    ) or 0
    return bot + mailings


async def _skip_reason(
    session: AsyncSession, row: BotOutbox, settings: Settings, now: datetime
) -> tuple[str | None, int | None]:
    """(reason to skip, MAX user id) for a row addressed to a user."""
    user = await session.get(User, row.user_id)
    if user is None:
        return "no_user", None
    if settings.max_bot_require_dialog:
        dialog = await session.get(BotDialog, user.max_user_id)
        if dialog is None or dialog.stopped_at is not None:
            return "no_dialog", None
    if row.kind == "g2_new_items":
        favorite = await session.get(RestaurantFavorite, (row.restaurant_id, row.user_id))
        if favorite is None or not favorite.notifications_enabled:
            return "unsubscribed", None
    if row.kind == "g1_back_in_stock":
        subscription = await session.get(
            ItemSubscription,
            (row.user_id, row.restaurant_id, uuid.UUID(row.payload["item_key"])),
        )
        if subscription is None:
            return "unsubscribed", None
    if row.category == MARKETING and (
        await guest_marketing_sent(session, row.user_id, now) >= GUEST_WEEKLY_MARKETING_LIMIT
    ):
        return "weekly_limit", None
    if row.kind in ADMIN_NOTIFICATION_KINDS and row.venue_id is not None:
        if await session.get(VenueMember, (row.venue_id, row.user_id)) is None:
            return "not_admin", None
        if await is_muted(session, row.user_id, row.venue_id, row.kind):
            return "muted", None
    return None, user.max_user_id


async def deliver(
    session_factory: async_sessionmaker[AsyncSession],
    outbox_id: uuid.UUID,
    settings: Settings,
    *,
    sender: Sender = send_bot_message,
    now: datetime | None = None,
) -> str:
    """Send one claimed row; returns its final status for this attempt."""
    now = now or datetime.now(UTC)
    async with session_factory() as session:
        row = await session.get(BotOutbox, outbox_id)
        if row is None or row.status != "processing":
            return "missing"
        target: dict[str, Any]
        if row.user_id is not None:
            reason, max_user_id = await _skip_reason(session, row, settings, now)
            if reason is not None:
                row.status, row.error_code, row.updated_at = "skipped", reason, now
                await session.commit()
                return "skipped"
            target = {"user_id": max_user_id}
        else:
            target = {"chat_id": row.chat_id}
        text, buttons, attachments = row.body, list(row.buttons), list(row.attachments)
        await session.commit()

    result = await sender(
        settings, text=text, buttons=buttons, attachments=attachments, **target
    )

    async with session_factory() as session:
        row = await session.get(BotOutbox, outbox_id)
        assert row is not None
        row.updated_at = datetime.now(UTC)
        if result.ok:
            row.status, row.sent_at, row.error_code = "sent", row.updated_at, None
            row.max_message_id = result.message_id
            if result.message_id and row.conversation_id and row.kind in LINKED_KINDS:
                await session.execute(
                    insert(BotMessageLink)
                    .values(max_message_id=result.message_id, conversation_id=row.conversation_id)
                    .on_conflict_do_nothing()
                )
        elif result.retryable and row.attempt_count < MAX_ATTEMPTS:
            row.status, row.error_code = "pending", result.error
            row.not_before = row.updated_at + BASE_RETRY_DELAY * (2 ** (row.attempt_count - 1))
        else:
            row.status, row.error_code = "failed", result.error
        status = row.status
        await session.commit()
    if status == "failed":
        logger.warning("Bot message %s failed: %s", outbox_id, result.error)
    return status


async def deliver_due(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
    *,
    sender: Sender = send_bot_message,
    now: datetime | None = None,
    limit: int = 50,
) -> int:
    """Deliver up to ``limit`` due rows; used by the worker loop and by tests."""
    count = 0
    while count < limit:
        moment = now or datetime.now(UTC)
        async with session_factory() as session:
            outbox_id = await claim_next(session, moment)
        if outbox_id is None:
            break
        await deliver(session_factory, outbox_id, settings, sender=sender, now=moment)
        count += 1
    return count
