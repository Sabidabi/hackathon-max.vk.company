"""Publish check, «Шаблон кофейни» and the no-price rule against the real API."""

import os
import uuid
from contextlib import AsyncExitStack

import pytest
from venue_api import API, BASIC_MENU, _actors, _cleanup, _new_venue, _ok, _publish, _save_draft

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_DB_INTEGRATION") != "1",
    reason="requires the migrated PostgreSQL integration database",
)


@pytest.mark.asyncio
async def test_template_is_draft_only_and_blocks_publication_until_priced() -> None:
    user_ids: list[uuid.UUID] = []
    try:
        async with AsyncExitStack() as stack:
            actors = await _actors(stack, ("admin", "stranger"))
            user_ids = actors.user_ids
            admin, stranger = actors.clients
            point, menu = await _new_venue(admin, "Кофейня Шаблон")
            draft = _ok(await admin.get(f"{API}/menus/{menu}/draft"))

            assert (await stranger.post(f"{API}/menus/{menu}/template", json={
                "expected_revision": draft["revision"],
            })).status_code == 404
            stale = await admin.post(f"{API}/menus/{menu}/template", json={
                "expected_revision": "0" * 64,
            })
            assert stale.status_code == 409

            filled = _ok(await admin.post(f"{API}/menus/{menu}/template", json={
                "expected_revision": draft["revision"],
            }))
            items = [item for section in filled["sections"] for item in section["items"]]
            assert len(items) >= 8
            assert all(item["price_minor"] == 0 for item in items)
            summary = _ok(await admin.get(f"{API}/menus/{menu}"))
            assert summary["current_published_version_id"] is None

            check = _ok(await admin.get(f"{API}/menus/{menu}/publish-check"))
            assert check["revision"] == filled["revision"]
            assert {p["code"] for p in check["problems"]} == {"no_price"}
            assert len(check["problems"]) == len(items)
            assert all(p["item_key"] for p in check["problems"])
            assert len(check["diff"]["added"]) == len(items)
            refused = await admin.post(f"{API}/menus/{menu}/publish", json={
                "expected_revision": filled["revision"], "point_ids": [point["id"]],
            })
            assert refused.status_code == 409
            assert "укажите цену" in refused.json()["detail"]

            # Priced positions publish; a hidden unpriced position does not block.
            await _save_draft(admin, menu, [*BASIC_MENU, {"name": "Скоро", "items": [
                {"name": "Какао", "price_minor": 0, "is_available": False},
            ]}])
            assert _ok(await admin.get(f"{API}/menus/{menu}/publish-check"))["problems"] == []
            published = await _publish(admin, menu, [point["id"]])
            assert published["published_version_id"]
            clean = _ok(await admin.get(f"{API}/menus/{menu}/publish-check"))
            assert clean["diff"]["total_changes"] == 0
    finally:
        await _cleanup(user_ids)
