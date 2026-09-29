"""Mock MAX Bot API and webhook helpers for the bot integration tests (not a test module).

Nothing here reaches the real MAX: every Bot API call goes to an ``httpx.MockTransport``
that records the JSON the product would send.
"""

import itertools
import json
import uuid
from functools import partial
from typing import Any

import httpx
import pytest

from app.api.routes import max_webhook
from app.bot.delivery import deliver_due
from app.config import Settings, get_settings
from app.database import SessionFactory
from app.main import app
from app.max_api import client as max_client

SUPPORT_CHAT = -7_000_000_001


def bot_settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "max_bot_token": "test-token",
        "max_bot_username": "@SinitsaBot",
        "max_webhook_secret": "test-secret",
        "max_api_base_url": "https://bot-api.test",
    }
    values.update(overrides)
    return Settings(**values)


class MockBotApi:
    """Records Bot API requests; answers /messages with a fresh message id."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self._ids = itertools.count(1)
        self.fail_with: int | None = None
        self.transport = httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.fail_with is not None:
            return httpx.Response(self.fail_with, json={"code": "error"})
        if request.url.path == "/messages":
            mid = f"mid.{next(self._ids)}"
            return httpx.Response(200, json={"message": {"body": {"mid": mid}}})
        return httpx.Response(200, json={"success": True})

    def messages(self) -> list[dict[str, Any]]:
        """Sent messages as {"params", "body"} in order."""
        return [
            {"params": dict(request.url.params), "body": json.loads(request.content)}
            for request in self.requests
            if request.url.path == "/messages"
        ]

    def clear(self) -> None:
        self.requests.clear()


def buttons_of(message: dict[str, Any]) -> list[dict[str, Any]]:
    for attachment in message["body"].get("attachments", []):
        if attachment["type"] == "inline_keyboard":
            return [button for row in attachment["payload"]["buttons"] for button in row]
    return []


def install(monkeypatch: pytest.MonkeyPatch, settings: Settings) -> MockBotApi:
    api = MockBotApi()
    monkeypatch.setattr(
        max_webhook,
        "send_bot_message",
        partial(max_client.send_bot_message, transport=api.transport),
    )
    monkeypatch.setattr(
        max_webhook,
        "answer_callback",
        partial(max_client.answer_callback, transport=api.transport),
    )
    app.dependency_overrides[get_settings] = lambda: settings
    return api


async def deliver(api: MockBotApi, settings: Settings, **kwargs: Any) -> int:
    return await deliver_due(
        SessionFactory,
        settings,
        sender=partial(max_client.send_bot_message, transport=api.transport),
        **kwargs,
    )


def message_update(
    max_user_id: int,
    text: str | None = None,
    *,
    chat_id: int | None = None,
    reply_to: str | None = None,
    attachments: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {"mid": f"in.{uuid.uuid4().hex[:12]}"}
    if text is not None:
        body["text"] = text
    if attachments:
        body["attachments"] = attachments
    message: dict[str, Any] = {
        "sender": {"user_id": max_user_id, "first_name": "Гость"},
        "recipient": {"chat_id": chat_id if chat_id is not None else max_user_id + 1},
        "body": body,
    }
    if reply_to:
        message["link"] = {"type": "reply", "message": {"mid": reply_to}}
    return {"update_type": "message_created", "timestamp": 1, "message": message}


def started_update(max_user_id: int, payload: str | None = None) -> dict[str, Any]:
    update: dict[str, Any] = {
        "update_type": "bot_started",
        "timestamp": 1,
        "chat_id": max_user_id + 1,
        "user": {"user_id": max_user_id, "first_name": "Гость"},
    }
    if payload:
        update["payload"] = payload
    return update


def callback_update(max_user_id: int, payload: str) -> dict[str, Any]:
    return {
        "update_type": "message_callback",
        "timestamp": 1,
        "callback": {
            "callback_id": f"cb.{uuid.uuid4().hex[:8]}",
            "payload": payload,
            "user": {"user_id": max_user_id, "first_name": "Гость"},
        },
        "message": {"recipient": {"chat_id": max_user_id + 1}},
    }


async def post_update(client: httpx.AsyncClient, update: dict[str, Any]) -> None:
    response = await client.post(
        "/webhooks/max", headers={"X-Max-Bot-Api-Secret": "test-secret"}, json=update
    )
    assert response.status_code == 200, response.text
