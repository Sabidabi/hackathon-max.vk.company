"""Support chat in the bot, against a mock Bot API — no real messages."""

import os
import uuid
from contextlib import AsyncExitStack

import httpx
import pytest
from sqlalchemy import delete, select

from app.database import SessionFactory
from app.main import app
from app.models import BotDialog, BotOutbox, Conversation, ConversationMessage, User
from tests.bot_helpers import (
    SUPPORT_CHAT,
    bot_settings,
    buttons_of,
    callback_update,
    deliver,
    install,
    message_update,
    post_update,
)

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_DB_INTEGRATION") != "1",
    reason="requires the migrated PostgreSQL integration database",
)


async def _user(label: str) -> User:
    async with SessionFactory() as session:
        user = User(
            max_user_id=8_000_000_000 + uuid.uuid4().int % 1_000_000_000,
            display_name=f"support-{label}",
            first_name=label,
        )
        session.add(user)
        await session.commit()
        return user


async def _drop(users: list[User]) -> None:
    async with SessionFactory() as session:
        await session.execute(
            delete(BotDialog).where(BotDialog.max_user_id.in_([u.max_user_id for u in users]))
        )
        await session.execute(delete(User).where(User.id.in_([u.id for u in users])))
        await session.commit()


@pytest.mark.asyncio
async def test_support_ticket_lifecycle(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = bot_settings(support_chat_id=SUPPORT_CHAT)
    api = install(monkeypatch, settings)
    user = await _user("guest")
    try:
        async with AsyncExitStack() as stack:
            bot = await stack.enter_async_context(httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ))
            await post_update(bot, message_update(user.max_user_id, "/support"))
            [opened] = api.messages()
            assert "Обращение №" in opened["body"]["text"]
            async with SessionFactory() as session:
                ticket = await session.scalar(select(Conversation).where(
                    Conversation.user_id == user.id, Conversation.kind == "support"
                ))
                assert ticket is not None and ticket.status == "open"
                assert ticket.requester_role == "user"

            # The first message: stored, confirmed, queued for the support chat.
            api.clear()
            await post_update(bot, message_update(
                user.max_user_id, "Не открывается меню",
                attachments=[{"type": "image", "payload": {"url": "https://i.test/p.jpg"}},
                             {"type": "file", "payload": {"url": "https://i.test/x.exe"}}],
            ))
            [ack] = api.messages()
            assert f"№{ticket.number}" in ack["body"]["text"]
            assert "ответим здесь" in ack["body"]["text"]
            api.clear()
            assert await deliver(api, settings) == 1
            [forwarded] = api.messages()
            assert forwarded["params"] == {"chat_id": str(SUPPORT_CHAT)}
            assert "Не открывается меню" in forwarded["body"]["text"]
            images = [a for a in forwarded["body"]["attachments"] if a["type"] == "image"]
            assert images == [{"type": "image", "payload": {"url": "https://i.test/p.jpg"}}]
            async with SessionFactory() as session:
                forwarded_mid = await session.scalar(select(BotOutbox.max_message_id).where(
                    BotOutbox.conversation_id == ticket.id, BotOutbox.kind == "support_forward"
                ))
            assert forwarded_mid

            # /support again continues the open ticket.
            api.clear()
            await post_update(bot, message_update(user.max_user_id, "/support"))
            assert f"Продолжаем обращение №{ticket.number}" in api.messages()[0]["body"]["text"]

            # The operator replies to the forwarded copy in the support chat → the user.
            api.clear()
            operator = message_update(
                9_000_000_001, "Обновите приложение MAX", chat_id=SUPPORT_CHAT,
                reply_to=forwarded_mid,
            )
            await post_update(bot, operator)
            assert api.messages() == []  # nothing is said in the support chat itself
            assert await deliver(api, settings) == 1
            [answer] = api.messages()
            assert answer["params"] == {"user_id": str(user.max_user_id)}
            assert "Обновите приложение MAX" in answer["body"]["text"]
            async with SessionFactory() as session:
                ticket = await session.get(Conversation, ticket.id)
                assert ticket.status == "answered"

            # Close from the button.
            api.clear()
            await post_update(bot, callback_update(user.max_user_id, f"support_close:{ticket.id}"))
            async with SessionFactory() as session:
                ticket = await session.get(Conversation, ticket.id)
                assert ticket.status == "closed" and ticket.closed_at is not None
            assert "закрыто" in api.messages()[0]["body"]["text"]
            # A free message after closing is not added to the closed ticket.
            api.clear()
            await post_update(bot, message_update(user.max_user_id, "ещё вопрос"))
            async with SessionFactory() as session:
                count = len((await session.scalars(select(ConversationMessage).where(
                    ConversationMessage.conversation_id == ticket.id
                ))).all())
            assert count == 2
            assert "/settings" in api.messages()[0]["body"]["text"]  # help, not the ticket
    finally:
        app.dependency_overrides.clear()
        await _drop([user])


@pytest.mark.asyncio
async def test_support_antispam_and_missing_chat(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = bot_settings()  # SUPPORT_CHAT_ID is not configured
    api = install(monkeypatch, settings)
    user = await _user("spammer")
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as bot:
            await post_update(bot, message_update(user.max_user_id, "/support"))
            for index in range(7):
                await post_update(bot, message_update(user.max_user_id, f"сообщение {index}"))
            async with SessionFactory() as session:
                ticket = await session.scalar(select(Conversation).where(
                    Conversation.user_id == user.id, Conversation.kind == "support"
                ))
                stored = (await session.scalars(select(ConversationMessage).where(
                    ConversationMessage.conversation_id == ticket.id
                ))).all()
                forwards = (await session.scalars(select(BotOutbox).where(
                    BotOutbox.conversation_id == ticket.id
                ))).all()
            # 5 per minute are accepted, the rest is refused with a visible reason.
            assert len(stored) == 5
            assert any("Подождите минуту" in m["body"]["text"] for m in api.messages())
            # Without SUPPORT_CHAT_ID tickets are only stored, nothing is forwarded.
            assert forwards == []
            assert all(
                m["params"] == {"chat_id": str(user.max_user_id + 1)} for m in api.messages()
            )
            assert buttons_of(api.messages()[0])[0]["payload"].startswith("support_close:")
    finally:
        app.dependency_overrides.clear()
        await _drop([user])
