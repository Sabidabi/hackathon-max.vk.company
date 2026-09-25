import logging
import re
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

from app.config import Settings

logger = logging.getLogger(__name__)
WEBHOOK_SECRET_PATTERN = re.compile(r"^[A-Za-z0-9_-]{5,256}$")
STARTAPP_PAYLOAD_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,512}$")


def build_max_deep_link(bot_username: str, payload: str | None = None) -> str | None:
    username = bot_username.strip().lstrip("@")
    if not username:
        return None
    if payload is not None and not STARTAPP_PAYLOAD_PATTERN.fullmatch(payload):
        raise ValueError("MAX startapp payload must contain 1-512 safe characters")
    query = "startapp"
    if payload:
        query = urlencode({"startapp": payload})
    return f"https://max.ru/{username}?{query}"


def build_message_button(settings: Settings, text: str, url: str) -> dict[str, Any]:
    """Launch this bot's mini-app inside MAX; keep external URLs as normal links."""
    username = settings.max_bot_username.strip().lstrip("@")
    parsed = urlparse(url)
    query = parse_qs(parsed.query, keep_blank_values=True)
    if (
        username
        and parsed.scheme == "https"
        and parsed.netloc.lower() == "max.ru"
        and parsed.path.strip("/").casefold() == username.casefold()
        and not parsed.fragment
        and set(query) == {"startapp"}
        and len(query["startapp"]) == 1
    ):
        button: dict[str, Any] = {"type": "open_app", "text": text, "web_app": username}
        start_payload = query["startapp"][0]
        if start_payload:
            button["payload"] = start_payload
        return button
    return {"type": "link", "text": text, "url": url}


async def send_max_message(
    settings: Settings,
    *,
    text: str,
    user_id: int | None = None,
    chat_id: int | None = None,
    button_text: str | None = None,
    button_url: str | None = None,
) -> bool:
    if not settings.max_bot_token:
        logger.info("MAX message skipped: bot token is not configured")
        return False
    if (user_id is None) == (chat_id is None):
        raise ValueError("Exactly one of user_id and chat_id must be provided")

    payload: dict[str, Any] = {"text": text}
    if button_text and button_url:
        payload["attachments"] = [
            {
                "type": "inline_keyboard",
                "payload": {
                    "buttons": [
                        [
                            build_message_button(settings, button_text, button_url)
                        ]
                    ]
                },
            }
        ]

    params = {"user_id": user_id} if user_id is not None else {"chat_id": chat_id}
    try:
        async with httpx.AsyncClient(
            base_url=settings.max_api_base_url.rstrip("/"),
            timeout=10,
        ) as client:
            response = await client.post(
                "/messages",
                params=params,
                headers={"Authorization": settings.max_bot_token},
                json=payload,
            )
            response.raise_for_status()
        return True
    except httpx.HTTPError:
        logger.exception("Could not send a message through MAX Bot API")
        return False


async def register_max_webhook(settings: Settings) -> dict[str, Any]:
    if not settings.max_bot_token:
        raise ValueError("MAX_BOT_TOKEN is required")
    if not WEBHOOK_SECRET_PATTERN.fullmatch(settings.max_webhook_secret):
        raise ValueError("MAX_WEBHOOK_SECRET must contain 5-256 safe characters")
    webhook_url = settings.max_webhook_url.strip()
    if not webhook_url.startswith("https://"):
        raise ValueError("MAX_WEBHOOK_URL must be an HTTPS URL")

    async with httpx.AsyncClient(
        base_url=settings.max_api_base_url.rstrip("/"),
        timeout=15,
    ) as client:
        response = await client.post(
            "/subscriptions",
            headers={"Authorization": settings.max_bot_token},
            json={
                "url": webhook_url,
                "update_types": ["bot_started", "message_created"],
                "secret": settings.max_webhook_secret,
            },
        )
        response.raise_for_status()
        payload = response.json()
    if not isinstance(payload, dict) or payload.get("success") is not True:
        raise ValueError("MAX API returned an unexpected subscription response")
    return payload
