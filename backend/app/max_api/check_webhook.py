"""Read-only check of the MAX webhook subscription on the deployed server."""

import asyncio
import json
from typing import Any

import httpx

from app.config import get_settings

REQUIRED_EVENTS = {"bot_started", "message_created"}


def subscription_report(payload: dict[str, Any], expected_url: str) -> dict[str, Any]:
    subscriptions = payload.get("subscriptions")
    if not isinstance(subscriptions, list):
        raise ValueError("MAX API did not return a subscriptions list")
    matching = next(
        (item for item in subscriptions if isinstance(item, dict) and item.get("url") == expected_url),
        None,
    )
    events = matching.get("update_types") if matching else []
    event_names = {event for event in events if isinstance(event, str)} if isinstance(events, list) else set()
    return {
        "webhook_url": expected_url,
        "subscription_found": matching is not None,
        "bot_started": "bot_started" in event_names,
        "message_created": "message_created" in event_names,
        "ready": matching is not None and REQUIRED_EVENTS <= event_names,
    }


async def main() -> None:
    settings = get_settings()
    if not settings.max_bot_token or not settings.max_webhook_url:
        raise SystemExit("Set MAX_BOT_TOKEN and MAX_WEBHOOK_URL in the server environment")
    async with httpx.AsyncClient(base_url=settings.max_api_base_url.rstrip("/"), timeout=15) as client:
        response = await client.get(
            "/subscriptions", headers={"Authorization": settings.max_bot_token}
        )
        response.raise_for_status()
    report = subscription_report(response.json(), settings.max_webhook_url.strip())
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if not report["ready"]:
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
