"""Menu version history, «Что изменилось» and «Вернуть эту версию» against the real API."""

import os
import uuid
from contextlib import AsyncExitStack

import pytest
from venue_api import (
    API,
    BASIC_MENU,
    _actors,
    _cleanup,
    _items,
    _new_venue,
    _ok,
    _public,
    _publish,
    _save_draft,
)

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_DB_INTEGRATION") != "1",
    reason="requires the migrated PostgreSQL integration database",
)


@pytest.mark.asyncio
async def test_version_history_diff_and_restore() -> None:
    user_ids: list[uuid.UUID] = []
    try:
        async with AsyncExitStack() as stack:
            actors = await _actors(stack, ("admin",))
            user_ids = actors.user_ids
            [admin] = actors.clients
            point, basic = await _new_venue(admin, "Кофейня Север")
            await _save_draft(admin, basic, BASIC_MENU)
            good = await _publish(admin, basic, [point["id"]])
            await _save_draft(admin, basic, [{"name": "Кофе", "items": [
                {"name": "Латте", "price_minor": 1900, "is_available": True},
                {"name": "Круассан", "price_minor": 15000, "is_available": True},
            ]}])
            panel = _ok(await admin.get(f"{API}/menus/{basic}/versions/published/diff/draft"))
            assert panel["diff"]["total_changes"] == 1
            bad = await _publish(admin, basic, [point["id"]])
            assert _items(await _public(admin, point["public_id"]))["Латте"]["price_minor"] == 1900

            history = _ok(await admin.get(f"{API}/menus/{basic}/versions"))
            assert [entry["version"] for entry in history] == [bad["version"], good["version"]]
            assert [entry["is_current"] for entry in history] == [True, False]
            assert history[0]["author"]["display_name"] == "library-admin"
            assert history[1]["status"] == "archived" and history[1]["item_count"] == 2

            diff = _ok(await admin.get(
                f"{API}/menus/{basic}/versions/{good['version']}/diff/{bad['version']}"
            ))["diff"]
            assert diff["added"] == [] and diff["removed"] == []
            [changed] = diff["changed"]
            assert changed["name"] == "Латте"
            assert changed["changes"] == [
                {"field": "price_minor", "before": 19000, "after": 1900}
            ]
            assert (await admin.get(
                f"{API}/menus/{basic}/versions/999/diff/draft"
            )).status_code == 404
            assert (await admin.get(
                f"{API}/menus/{basic}/versions/latest/diff/draft"
            )).status_code == 422

            # Scenario «Ошибка в ценах»: restore into the draft, publish explicitly.
            restore_url = f"{API}/menus/{basic}/versions/{good['version']}/restore"
            stale = await admin.post(restore_url, json={"expected_revision": "0" * 64})
            assert stale.status_code == 409
            draft = _ok(await admin.get(f"{API}/menus/{basic}/draft"))
            before_keys = {i["name"]: i["item_key"] for i in draft["sections"][0]["items"]}
            restored = _ok(await admin.post(restore_url, json={
                "expected_revision": draft["revision"],
            }))
            restored_items = {i["name"]: i for i in restored["sections"][0]["items"]}
            assert restored_items["Латте"]["price_minor"] == 19000
            assert {n: i["item_key"] for n, i in restored_items.items()} == before_keys
            # Guests still see version «bad» until the admin publishes.
            assert _items(await _public(admin, point["public_id"]))["Латте"]["price_minor"] == 1900
            assert len(_ok(await admin.get(f"{API}/menus/{basic}/versions"))) == 2
            again = await _publish(admin, basic, [point["id"]])
            assert again["version"] > bad["version"]
            assert _items(await _public(admin, point["public_id"]))["Латте"][
                "price_minor"
            ] == 19000
            history = _ok(await admin.get(f"{API}/menus/{basic}/versions"))
            assert [entry["version"] for entry in history] == [
                again["version"], bad["version"], good["version"]
            ]
    finally:
        await _cleanup(user_ids)
