from typing import Any

from fastapi.testclient import TestClient

from app.api.routes import max_webhook
from app.config import Settings, get_settings
from app.main import app
from app.max_api.client import build_max_deep_link, register_max_webhook


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


async def test_webhook_registration_requires_https() -> None:
    settings = webhook_settings()
    settings.max_webhook_url = "http://example.com/webhooks/max"

    try:
        await register_max_webhook(settings)
    except ValueError as error:
        assert "HTTPS" in str(error)
    else:
        raise AssertionError("HTTP webhook URL was accepted")
