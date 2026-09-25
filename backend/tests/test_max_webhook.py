import json
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.api.routes import max_webhook
from app.config import Settings, get_settings
from app.main import app
from app.max_api import client as max_client
from app.max_api.client import build_max_deep_link, build_message_button, register_max_webhook


def webhook_settings() -> Settings:
    return Settings(
        max_bot_token="test-token",
        max_bot_username="@MenuBot",
        max_webhook_secret="test-secret",
    )


def test_build_max_deep_link() -> None:
    assert build_max_deep_link("@MenuBot") == "https://max.ru/MenuBot?startapp"
    assert (
        build_max_deep_link("MenuBot", "r_public123")
        == "https://max.ru/MenuBot?startapp=r_public123"
    )
    assert build_max_deep_link("  ", "r_public123") is None
    with pytest.raises(ValueError, match="startapp payload"):
        build_max_deep_link("MenuBot", "not allowed")
    with pytest.raises(ValueError, match="startapp payload"):
        build_max_deep_link("MenuBot", "a" * 513)


def test_bot_menu_button_opens_mini_app() -> None:
    settings = webhook_settings()
    assert build_message_button(
        settings, "Открыть меню", "https://max.ru/MenuBot?startapp=r_public123"
    ) == {
        "type": "open_app",
        "text": "Открыть меню",
        "web_app": "MenuBot",
        "payload": "r_public123",
    }
    assert build_message_button(
        settings, "Открыть меню", "https://max.ru/MenuBot?startapp"
    ) == {"type": "open_app", "text": "Открыть меню", "web_app": "MenuBot"}
    assert build_message_button(
        settings, "Сайт", "https://example.com"
    ) == {"type": "link", "text": "Сайт", "url": "https://example.com"}


def test_webhook_rejects_invalid_secret() -> None:
    app.dependency_overrides[get_settings] = webhook_settings
    try:
        with TestClient(app) as client:
            response = client.post(
                "/webhooks/max",
                headers={"X-Max-Bot-Api-Secret": "wrong-secret"},
                json={"update_type": "bot_started", "chat_id": 123},
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 401


def test_bot_started_sends_welcome_message(monkeypatch: Any) -> None:
    calls: list[dict[str, object]] = []

    async def fake_send_max_message(
        settings: Settings,
        **kwargs: object,
    ) -> bool:
        calls.append({"settings": settings, **kwargs})
        return True

    monkeypatch.setattr(max_webhook, "send_max_message", fake_send_max_message)
    app.dependency_overrides[get_settings] = webhook_settings
    try:
        with TestClient(app) as client:
            response = client.post(
                "/webhooks/max",
                headers={"X-Max-Bot-Api-Secret": "test-secret"},
                json={
                    "update_type": "bot_started",
                    "timestamp": 1_700_000_000_000,
                    "chat_id": 123456,
                    "user": {"user_id": 42, "name": "Тест"},
                },
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert len(calls) == 1
    assert calls[0]["chat_id"] == 123456
    assert calls[0]["button_url"] == "https://max.ru/MenuBot?startapp"


def test_message_text_extraction() -> None:
    update = max_webhook.MaxWebhookUpdate.model_validate(
        {
            "update_type": "message_created",
            "message": {"body": {"text": "  /menu  "}},
        }
    )
    assert max_webhook.extract_message_text(update) == "/menu"


def test_id_command_replies_with_sender_max_id(monkeypatch: Any) -> None:
    calls: list[dict[str, object]] = []

    async def fake_send_max_message(settings: Settings, **kwargs: object) -> bool:
        calls.append(kwargs)
        return True

    monkeypatch.setattr(max_webhook, "send_max_message", fake_send_max_message)
    app.dependency_overrides[get_settings] = webhook_settings
    try:
        with TestClient(app) as client:
            response = client.post(
                "/webhooks/max",
                headers={"X-Max-Bot-Api-Secret": "test-secret"},
                json={
                    "update_type": "message_created",
                    "chat_id": 123456,
                    "user": {"user_id": 42},
                    "message": {"body": {"text": "/id"}},
                },
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert calls == [{"text": "Ваш MAX ID: 42. Передайте его владельцу точки.", "chat_id": 123456}]


async def test_webhook_registration_requires_https() -> None:
    settings = webhook_settings()
    settings.max_webhook_url = "http://example.com/webhooks/max"

    try:
        await register_max_webhook(settings)
    except ValueError as error:
        assert "HTTPS" in str(error)
    else:
        raise AssertionError("HTTP webhook URL was accepted")


async def test_webhook_registration_checks_max_success_field(monkeypatch: Any) -> None:
    settings = webhook_settings()
    settings.max_webhook_url = "https://example.com/webhooks/max"
    requests: list[httpx.Request] = []
    original_client = httpx.AsyncClient

    def fake_client(**kwargs: Any) -> httpx.AsyncClient:
        async def handle(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, json={"success": False, "message": "rejected"})

        return original_client(transport=httpx.MockTransport(handle), **kwargs)

    monkeypatch.setattr(max_client.httpx, "AsyncClient", fake_client)
    with pytest.raises(ValueError, match="unexpected subscription response"):
        await register_max_webhook(settings)

    assert len(requests) == 1
    assert requests[0].url.path == "/subscriptions"
    assert requests[0].headers["Authorization"] == "test-token"
    assert json.loads(requests[0].content) == {
        "url": "https://example.com/webhooks/max",
        "update_types": ["bot_started", "message_created"],
        "secret": "test-secret",
    }


async def test_bot_message_uses_open_app_button(monkeypatch: Any) -> None:
    settings = webhook_settings()
    requests: list[httpx.Request] = []
    original_client = httpx.AsyncClient

    def fake_client(**kwargs: Any) -> httpx.AsyncClient:
        async def handle(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, json={"recipient": {"chat_id": 123}})

        return original_client(transport=httpx.MockTransport(handle), **kwargs)

    monkeypatch.setattr(max_client.httpx, "AsyncClient", fake_client)
    sent = await max_client.send_max_message(
        settings,
        text="Открыть меню",
        chat_id=123,
        button_text="Меню",
        button_url="https://max.ru/MenuBot?startapp=r_public123",
    )

    assert sent is True
    assert len(requests) == 1
    assert requests[0].url.path == "/messages"
    assert requests[0].url.params["chat_id"] == "123"
    assert requests[0].headers["Authorization"] == "test-token"
    body = json.loads(requests[0].content)
    assert body["attachments"][0]["payload"]["buttons"][0][0] == {
        "type": "open_app", "text": "Меню", "web_app": "MenuBot", "payload": "r_public123"
    }
