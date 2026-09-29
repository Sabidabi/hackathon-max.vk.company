"""Bot commands: JSON contract of the Bot API calls, against a mock API."""

import json
import os
import uuid
from contextlib import AsyncExitStack

import httpx
import pytest
from sqlalchemy import select

from app.database import SessionFactory
from app.main import app
from app.max_api.client import STARTAPP_PAYLOAD_PATTERN, register_bot_commands
from app.models import BotDialog, ItemSubscription, RestaurantFavorite, User
from tests.bot_helpers import (
    bot_settings,
    buttons_of,
    callback_update,
    install,
    message_update,
    post_update,
    started_update,
)
from tests.venue_api import (
    API,
    BASIC_MENU,
    _actors,
    _cleanup,
    _new_venue,
    _ok,
    _publish,
    _save_draft,
)

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_DB_INTEGRATION") != "1",
    reason="requires the migrated PostgreSQL integration database",
)


async def max_id(user_id: uuid.UUID) -> int:
    async with SessionFactory() as session:
        return (await session.get(User, user_id)).max_user_id


def open_app_buttons(messages: list[dict]) -> list[dict]:
    return [b for m in messages for b in buttons_of(m) if b["type"] == "open_app"]


@pytest.mark.asyncio
async def test_commands_contract(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = bot_settings()
    api = install(monkeypatch, settings)
    user_ids: list[uuid.UUID] = []
    try:
        async with AsyncExitStack() as stack:
            actors = await _actors(stack, ("admin", "guest"))
            user_ids = actors.user_ids
            admin, guest = actors.clients
            point, menu_id = await _new_venue(admin, "Кофейня Север")
            await _save_draft(admin, menu_id, BASIC_MENU)
            await _publish(admin, menu_id, [point["id"]])
            _ok(await guest.put(
                f"{API}/public/restaurants/{point['public_id']}/favorite",
                json={"is_favorite": True, "notifications_enabled": True},
            ))
            admin_max, guest_max = await max_id(user_ids[0]), await max_id(user_ids[1])
            transport = httpx.ASGITransport(app=app)
            bot = await stack.enter_async_context(
                httpx.AsyncClient(transport=transport, base_url="http://test")
            )

            # /start without payload: welcome + «Открыть Синицу» without startapp payload,
            # and the dialog consent is recorded.
            await post_update(bot, message_update(guest_max, "/start"))
            [welcome] = api.messages()
            assert welcome["params"] == {"chat_id": str(guest_max + 1)}
            assert "Синица" in welcome["body"]["text"]
            assert buttons_of(welcome) == [
                {"type": "open_app", "text": "Открыть Синицу", "web_app": "SinitsaBot"}
            ]
            async with SessionFactory() as session:
                dialog = await session.get(BotDialog, guest_max)
                assert dialog is not None and dialog.user_id == user_ids[1]
                assert dialog.stopped_at is None

            # bot_started with a menu payload opens that menu.
            api.clear()
            await post_update(bot, started_update(guest_max, f"r_{point['public_id']}"))
            [menu_message] = api.messages()
            assert buttons_of(menu_message) == [{
                "type": "open_app", "text": "Открыть меню", "web_app": "SinitsaBot",
                "payload": f"r_{point['public_id']}",
            }]

            # /settings opens the notifications screen.
            api.clear()
            await post_update(bot, message_update(guest_max, "/settings"))
            assert open_app_buttons(api.messages())[0]["payload"] == "settings"

            # /my: the admin sees the cabinet, the guest sees the favourite.
            api.clear()
            await post_update(bot, message_update(admin_max, "/my"))
            assert open_app_buttons(api.messages())[0]["payload"] == (
                f"manage_{point['public_id']}"
            )
            api.clear()
            await post_update(bot, message_update(guest_max, "/my"))
            assert open_app_buttons(api.messages())[0]["payload"] == f"r_{point['public_id']}"

            # /help and an unknown command answer with the help text.
            for text in ("/help", "/unknown"):
                api.clear()
                await post_update(bot, message_update(guest_max, text))
                [help_message] = api.messages()
                assert "/settings" in help_message["body"]["text"]
                assert {"type": "callback", "text": "Написать в поддержку",
                        "payload": "support"} in buttons_of(help_message)

            # /stop switches every guest subscription off.
            async with SessionFactory() as session:
                item = (await _public_item(guest, point["public_id"]))
                session.add(ItemSubscription(
                    user_id=user_ids[1], point_id=uuid.UUID(point["id"]),
                    item_key=uuid.UUID(item["item_key"]), item_name=item["name"],
                ))
                await session.commit()
            api.clear()
            await post_update(bot, message_update(guest_max, "/stop"))
            assert "выключены" in api.messages()[0]["body"]["text"]
            async with SessionFactory() as session:
                favorite = await session.get(
                    RestaurantFavorite, (uuid.UUID(point["id"]), user_ids[1])
                )
                assert favorite is not None and favorite.notifications_enabled is False
                assert not (await session.scalars(select(ItemSubscription).where(
                    ItemSubscription.user_id == user_ids[1]
                ))).all()

            # «Не присылать» under a message: callback is answered and the point muted.
            _ok(await guest.put(
                f"{API}/public/restaurants/{point['public_id']}/favorite",
                json={"is_favorite": True, "notifications_enabled": True},
            ))
            api.clear()
            await post_update(bot, callback_update(guest_max, f"unsub_r:{point['id']}"))
            assert any(r.url.path == "/answers" for r in api.requests)
            async with SessionFactory() as session:
                favorite = await session.get(
                    RestaurantFavorite, (uuid.UUID(point["id"]), user_ids[1])
                )
                assert favorite.notifications_enabled is False

            # bot_stopped withdraws the consent.
            await post_update(bot, {
                "update_type": "bot_stopped", "timestamp": 1,
                "user": {"user_id": guest_max},
            })
            async with SessionFactory() as session:
                dialog = await session.get(BotDialog, guest_max)
                assert dialog.stopped_at is not None

            # Every open_app payload stays a valid startapp payload (≤ 512 safe chars).
            for request in api.requests:
                if request.url.path == "/messages":
                    for button in buttons_of({"body": json.loads(request.content)}):
                        if "payload" in button and button["type"] == "open_app":
                            assert STARTAPP_PAYLOAD_PATTERN.fullmatch(button["payload"])
    finally:
        app.dependency_overrides.clear()
        async with SessionFactory() as session:
            for user_id in user_ids:
                user = await session.get(User, user_id)
                if user is not None:
                    dialog = await session.get(BotDialog, user.max_user_id)
                    if dialog is not None:
                        await session.delete(dialog)
            await session.commit()
        await _cleanup(user_ids)


async def _public_item(client: httpx.AsyncClient, public_id: str) -> dict:
    menu = _ok(await client.get(f"{API}/public/restaurants/{public_id}/menu"))
    return menu["menus"][0]["sections"][0]["items"][0]


async def test_register_commands_contract() -> None:
    requests: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"user_id": 1, "commands": []})

    await register_bot_commands(bot_settings(), transport=httpx.MockTransport(handle))
    [request] = requests
    assert request.method == "PATCH" and request.url.path == "/me/commands"
    assert request.headers["Authorization"] == "test-token"
    names = [command["name"] for command in json.loads(request.content)["commands"]]
    assert names == ["start", "my", "chat", "settings", "support", "stop", "help"]
