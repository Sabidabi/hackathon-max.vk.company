"""Buttons and ``startapp`` payloads of bot messages.

A payload is navigation only (P1-DOC-12): the mini-app still checks every right on the
server. Payloads use only ``[A-Za-z0-9_-]`` and stay within 512 characters.
"""

import uuid
from typing import Any

from app.max_api.client import STARTAPP_PAYLOAD_PATTERN

SETTINGS_PAYLOAD = "settings"
# Cabinet screens a button may open: ``manage_<public_id>_s_<section>``.
MANAGE_SECTIONS = ("menu", "analytics", "team", "import", "messages", "notifications")


def _checked(payload: str) -> str:
    if not STARTAPP_PAYLOAD_PATTERN.fullmatch(payload):
        raise ValueError("startapp payload must contain 1-512 safe characters")
    return payload


def menu_payload(public_id: str) -> str:
    return _checked(f"r_{public_id}")


def item_payload(public_id: str, item_key: uuid.UUID | str) -> str:
    return _checked(f"r_{public_id}_i_{item_key}")


def manage_payload(public_id: str, section: str | None = None) -> str:
    if section is None:
        return _checked(f"manage_{public_id}")
    if section not in MANAGE_SECTIONS:
        raise ValueError(f"Unknown cabinet section: {section}")
    return _checked(f"manage_{public_id}_s_{section}")


def app_button(text: str, payload: str | None = None) -> dict[str, Any]:
    button: dict[str, Any] = {"type": "open_app", "text": text}
    if payload:
        button["payload"] = _checked(payload)
    return button


def callback_button(text: str, payload: str) -> dict[str, Any]:
    if len(payload) > 128:
        raise ValueError("callback payload is too long")
    return {"type": "callback", "text": text, "payload": payload}
