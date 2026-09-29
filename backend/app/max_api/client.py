import logging
import re
from dataclasses import dataclass
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
                "update_types": [
                    "bot_started",
                    "bot_stopped",
                    "message_created",
                    "message_callback",
                ],
                "secret": settings.max_webhook_secret,
            },
        )
        response.raise_for_status()
        payload = response.json()
    if not isinstance(payload, dict) or payload.get("success") is not True:
        raise ValueError("MAX API returned an unexpected subscription response")
    return payload


# --- Bot API used by the bot outbox and commands ---

BOT_COMMANDS: tuple[tuple[str, str], ...] = (
    ("start", "Открыть Синицу"),
    ("my", "Мои заведения и избранное"),
    ("chat", "Написать в кофейню"),
    ("settings", "Настройки уведомлений"),
    ("support", "Написать в поддержку"),
    ("stop", "Отписаться от рассылок"),
    ("help", "Что умеет бот"),
)
# Transient answers worth another attempt; any other 4xx is final (e.g. the user has no
# dialog with the bot or blocked it).
RETRYABLE_STATUS = frozenset({408, 409, 425, 429, 500, 502, 503, 504})


@dataclass(frozen=True)
class SendResult:
    ok: bool
    message_id: str | None = None
    retryable: bool = False
    error: str | None = None


def build_bot_buttons(settings: Settings, rows: list[list[dict[str, Any]]]) -> list[list[dict]]:
    """Stored button specs → MAX inline keyboard buttons.

    ``open_app`` launches this bot's mini-app with a ``startapp`` payload (≤ 512 safe
    characters); ``callback`` comes back to the webhook as ``message_callback``.
    """
    username = settings.max_bot_username.strip().lstrip("@")
    result: list[list[dict]] = []
    for row in rows:
        built: list[dict] = []
        for spec in row:
            text = str(spec["text"])[:64]
            if spec["type"] == "open_app":
                if not username:
                    continue
                button: dict[str, Any] = {"type": "open_app", "text": text, "web_app": username}
                payload = spec.get("payload")
                if payload:
                    if not STARTAPP_PAYLOAD_PATTERN.fullmatch(payload):
                        raise ValueError("open_app payload must contain 1-512 safe characters")
                    button["payload"] = payload
                built.append(button)
            elif spec["type"] == "callback":
                built.append({"type": "callback", "text": text, "payload": str(spec["payload"])})
            elif spec["type"] == "link":
                built.append({"type": "link", "text": text, "url": str(spec["url"])})
        if built:
            result.append(built)
    return result


def message_request_body(
    settings: Settings,
    text: str,
    buttons: list[list[dict[str, Any]]] | None = None,
    attachments: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {"text": text[:4000]}
    items: list[dict[str, Any]] = [dict(item) for item in attachments or []]
    keyboard = build_bot_buttons(settings, buttons or [])
    if keyboard:
        items.append({"type": "inline_keyboard", "payload": {"buttons": keyboard}})
    if items:
        body["attachments"] = items
    return body


async def send_bot_message(
    settings: Settings,
    *,
    text: str,
    user_id: int | None = None,
    chat_id: int | None = None,
    buttons: list[list[dict[str, Any]]] | None = None,
    attachments: list[dict[str, Any]] | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> SendResult:
    """POST /messages; returns the MAX message id so replies to the copy can be routed."""
    if not settings.max_bot_token:
        return SendResult(ok=False, retryable=True, error="bot_token_missing")
    if (user_id is None) == (chat_id is None):
        raise ValueError("Exactly one of user_id and chat_id must be provided")
    params = {"user_id": user_id} if user_id is not None else {"chat_id": chat_id}
    try:
        async with httpx.AsyncClient(
            base_url=settings.max_api_base_url.rstrip("/"), timeout=10, transport=transport
        ) as client:
            response = await client.post(
                "/messages",
                params=params,
                headers={"Authorization": settings.max_bot_token},
                json=message_request_body(settings, text, buttons, attachments),
            )
    except httpx.HTTPError:
        logger.warning("MAX Bot API is unreachable")
        return SendResult(ok=False, retryable=True, error="network")
    if response.status_code >= 400:
        logger.warning("MAX Bot API refused a message: HTTP %s", response.status_code)
        return SendResult(
            ok=False,
            retryable=response.status_code in RETRYABLE_STATUS,
            error=f"http_{response.status_code}",
        )
    message_id = None
    try:
        data = response.json()
        body = (data.get("message") or {}).get("body") or {}
        mid = body.get("mid")
        message_id = str(mid) if mid else None
    except (ValueError, AttributeError):
        message_id = None
    return SendResult(ok=True, message_id=message_id)


async def answer_callback(
    settings: Settings,
    callback_id: str,
    notification: str,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> bool:
    """POST /answers: the short toast MAX shows after a callback button."""
    if not settings.max_bot_token or not callback_id:
        return False
    try:
        async with httpx.AsyncClient(
            base_url=settings.max_api_base_url.rstrip("/"), timeout=10, transport=transport
        ) as client:
            response = await client.post(
                "/answers",
                params={"callback_id": callback_id},
                headers={"Authorization": settings.max_bot_token},
                json={"notification": notification[:200]},
            )
            response.raise_for_status()
        return True
    except httpx.HTTPError:
        logger.warning("Could not answer a MAX callback")
        return False


async def register_bot_commands(
    settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None
) -> dict[str, Any]:
    """PATCH /me/commands with the command list shown in the MAX chat menu."""
    if not settings.max_bot_token:
        raise ValueError("MAX_BOT_TOKEN is required")
    async with httpx.AsyncClient(
        base_url=settings.max_api_base_url.rstrip("/"), timeout=15, transport=transport
    ) as client:
        response = await client.patch(
            "/me/commands",
            headers={"Authorization": settings.max_bot_token},
            json={
                "commands": [
                    {"name": name, "description": description}
                    for name, description in BOT_COMMANDS
                ]
            },
        )
        response.raise_for_status()
        payload = response.json()
    if not isinstance(payload, dict):
        raise ValueError("MAX API returned an unexpected /me response")
    return payload
