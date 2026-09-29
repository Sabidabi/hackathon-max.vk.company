"""Guest ↔ point dialogs through the bot (P1-TASK-64): isolation, both directions over a
mock Bot API, antispam, blocking and closing."""

import os
import uuid
from contextlib import AsyncExitStack

import httpx
import pytest
from sqlalchemy import delete, select

from app.database import SessionFactory
from app.main import app
from app.models import BotDialog, BotOutbox, Conversation, User
from tests.bot_helpers import (
    bot_settings,
    buttons_of,
    callback_update,
    deliver,
    install,
    message_update,
    post_update,
    started_update,
)
from tests.venue_api import API, _actors, _cleanup, _new_venue, _ok

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_DB_INTEGRATION") != "1",
    reason="requires the migrated PostgreSQL integration database",
)


async def _max_ids(user_ids: list[uuid.UUID]) -> list[int]:
    async with SessionFactory() as session:
        return [(await session.get(User, user_id)).max_user_id for user_id in user_ids]


async def _dialog(user_id: uuid.UUID) -> Conversation | None:
    async with SessionFactory() as session:
        return await session.scalar(
            select(Conversation)
            .where(Conversation.user_id == user_id, Conversation.kind == "point")
            .order_by(Conversation.created_at.desc())
            .limit(1)
        )


@pytest.mark.asyncio
async def test_point_chat(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = bot_settings()
    api = install(monkeypatch, settings)
    user_ids: list[uuid.UUID] = []
    try:
        async with AsyncExitStack() as stack:
            actors = await _actors(stack, ("owner", "stranger-admin", "guest", "other-guest"))
            user_ids = actors.user_ids
            owner, stranger, guest_client, _other = actors.clients
            owner_max, stranger_max, guest_max, other_max = await _max_ids(user_ids)
            point, _ = await _new_venue(owner, "Кофейня Север")
            foreign, _ = await _new_venue(stranger, "Чужая кофейня")
            assert _ok(await guest_client.get(
                f"{API}/public/restaurants/{point['public_id']}/chat-link"
            ))["url"] == f"https://max.ru/SinitsaBot?start=chat_{point['public_id']}"
            bot = await stack.enter_async_context(httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ))
            # Every participant has a dialog with the bot («Разрешить сообщения»).
            for max_user_id in (owner_max, stranger_max, other_max):
                await post_update(bot, message_update(max_user_id, "/help"))

            # Guest opens the chat from the menu button (bot_started with chat_<point>).
            api.clear()
            await post_update(bot, started_update(guest_max, f"chat_{point['public_id']}"))
            assert "Напишите вопрос для «Кофейня Север»" in api.messages()[0]["body"]["text"]
            api.clear()
            await post_update(bot, message_update(guest_max, "Будет ли раф к 9:00?"))
            assert "Сообщение передано в «Кофейня Север»" in api.messages()[0]["body"]["text"]
            dialog = await _dialog(user_ids[2])
            assert dialog is not None and dialog.status == "open"

            # А8 to the admins of this venue only, with «Ответить».
            api.clear()
            assert await deliver(api, settings) == 1
            [to_admin] = api.messages()
            assert to_admin["params"] == {"user_id": str(owner_max)}
            assert "Будет ли раф к 9:00?" in to_admin["body"]["text"]
            assert {"type": "callback", "text": "Ответить", "payload": f"reply:{dialog.id}"} in \
                buttons_of(to_admin)
            async with SessionFactory() as session:
                admin_copy = await session.scalar(select(BotOutbox.max_message_id).where(
                    BotOutbox.conversation_id == dialog.id, BotOutbox.kind == "a8_point_message"
                ))

            # Isolation: another venue's admin and another guest see nothing.
            assert (await stranger.get(f"{API}/points/{point['id']}/conversations")).status_code \
                == 404
            assert (await stranger.get(f"{API}/conversations/{dialog.id}")).status_code == 404
            assert (await stranger.post(
                f"{API}/conversations/{dialog.id}/reply", json={"text": "чужой"}
            )).status_code == 404
            assert _ok(await stranger.get(f"{API}/points/{foreign['id']}/conversations")) == []
            api.clear()
            await post_update(bot, callback_update(other_max, f"chat_close:{dialog.id}"))
            await post_update(bot, callback_update(stranger_max, f"reply:{dialog.id}"))
            assert (await _dialog(user_ids[2])).status == "open"
            await post_update(bot, message_update(stranger_max, "перехват", reply_to=admin_copy))
            assert await deliver(api, settings) == 0  # nothing reached the guest

            # Cabinet list: unread until opened.
            [summary] = _ok(await owner.get(f"{API}/points/{point['id']}/conversations"))
            assert summary["unread"] == 1 and summary["last_message"] == "Будет ли раф к 9:00?"
            detail = _ok(await owner.get(f"{API}/conversations/{dialog.id}"))
            assert [m["direction"] for m in detail["messages"]] == ["in"]
            assert _ok(await owner.get(f"{API}/points/{point['id']}/conversations"))[0][
                "unread"] == 0

            # Answer by a reply in the bot → the guest, signed by the point, not by the admin.
            api.clear()
            await post_update(bot, message_update(owner_max, "Да, с 8:00", reply_to=admin_copy))
            assert "Ответ отправлен" in api.messages()[0]["body"]["text"]
            api.clear()
            assert await deliver(api, settings) == 1
            [to_guest] = api.messages()
            assert to_guest["params"] == {"user_id": str(guest_max)}
            assert to_guest["body"]["text"] == "Кофейня Север:\nДа, с 8:00"
            assert "owner" not in to_guest["body"]["text"]

            # Answer from the cabinet and through the «Ответить» button.
            detail = _ok(await owner.post(
                f"{API}/conversations/{dialog.id}/reply", json={"text": "Ждём вас"}
            ))
            assert detail["status"] == "answered"
            await post_update(bot, callback_update(owner_max, f"reply:{dialog.id}"))
            await post_update(bot, message_update(owner_max, "И круассаны тоже"))
            api.clear()
            assert await deliver(api, settings) == 2
            assert [m["body"]["text"] for m in api.messages()] == [
                "Кофейня Север:\nЖдём вас", "Кофейня Север:\nИ круассаны тоже",
            ]

            # Antispam: 5 messages a minute per guest.
            api.clear()
            for index in range(6):
                await post_update(bot, message_update(guest_max, f"вопрос {index}"))
            assert "Подождите минуту" in api.messages()[-1]["body"]["text"]
            detail = _ok(await owner.get(f"{API}/conversations/{dialog.id}"))
            assert sum(1 for m in detail["messages"] if m["direction"] == "in") == 5

            # Block: the dialog closes, new messages and new dialogs are refused.
            response = await owner.put(
                f"{API}/conversations/{dialog.id}/block", json={"blocked": True}
            )
            assert response.status_code == 204
            assert (await _dialog(user_ids[2])).status == "closed"
            api.clear()
            await post_update(bot, started_update(guest_max, f"chat_{point['public_id']}"))
            assert "ограничило" in api.messages()[0]["body"]["text"]
            response = await owner.put(
                f"{API}/conversations/{dialog.id}/block", json={"blocked": False}
            )
            assert response.status_code == 204

            # A new dialog after unblocking; the admin closes it, the guest is told so.
            async with SessionFactory() as session:
                await session.execute(delete(Conversation).where(Conversation.id == dialog.id))
                await session.commit()
            await post_update(bot, started_update(guest_max, f"chat_{point['public_id']}"))
            fresh = await _dialog(user_ids[2])
            assert fresh.id != dialog.id and fresh.status == "open"
            response = await owner.post(f"{API}/conversations/{fresh.id}/close")
            assert response.status_code == 204
            api.clear()
            await post_update(bot, message_update(guest_max, "ещё вопрос"))
            assert "Диалог закрыт" in api.messages()[0]["body"]["text"]
    finally:
        app.dependency_overrides.clear()
        async with SessionFactory() as session:
            await session.execute(delete(BotDialog).where(BotDialog.user_id.in_(user_ids)))
            await session.commit()
        await _cleanup(user_ids)
