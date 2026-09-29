"""P1-DOC-15 «Безопасность правок»: two admins of one venue edit and publish one menu.

The one who is late gets 409 with a structured ``detail`` (current revision, the last
publication and its author, what changed since the version the client saw) and loses
nothing: the server content is untouched and the client can compare its copy.
"""

import os
import uuid
from contextlib import AsyncExitStack

import pytest
from venue_api import API, BASIC_MENU, _actors, _cleanup, _new_venue, _ok, _publish, _save_draft

from app.database import SessionFactory
from app.models import VenueMember

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_DB_INTEGRATION") != "1",
    reason="requires the migrated PostgreSQL integration database",
)

PRICE_CHANGE = [{"name": "Кофе", "items": [
    {"name": "Латте", "price_minor": 21000, "is_available": True},
    {"name": "Круассан", "price_minor": 15000, "is_available": True},
]}]


def _conflict(response) -> dict:
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "revision_conflict"
    assert detail["message"]
    return detail


@pytest.mark.asyncio
async def test_concurrent_publication_by_two_admins_returns_conflict_summary() -> None:
    user_ids: list[uuid.UUID] = []
    try:
        async with AsyncExitStack() as stack:
            actors = await _actors(stack, ("anna", "boris"))
            user_ids = actors.user_ids
            anna, boris = actors.clients
            point, menu_id = await _new_venue(anna, "Кофейня Север")
            async with SessionFactory() as session:
                session.add(VenueMember(
                    venue_id=uuid.UUID(point["venue_id"]),
                    user_id=user_ids[1],
                    role="admin",
                    is_creator=False,
                ))
                await session.commit()
            await _save_draft(anna, menu_id, BASIC_MENU)
            first = (await _publish(anna, menu_id, [point["id"]]))["version"]

            # Both admins open the same draft after the first publication.
            boris_draft = _ok(await boris.get(f"{API}/menus/{menu_id}/draft"))
            stale_revision = boris_draft["revision"]

            # Anna changes a price and publishes the next version first.
            await _save_draft(anna, menu_id, PRICE_CHANGE)
            second = (await _publish(anna, menu_id, [point["id"]]))["version"]
            assert second > first
            current = _ok(await anna.get(f"{API}/menus/{menu_id}/draft"))

            # Boris publishes with his stale revision: 409 with the summary.
            late = await boris.post(f"{API}/menus/{menu_id}/publish", json={
                "expected_revision": stale_revision,
                "point_ids": [point["id"]],
                "seen_version": first,
            })
            detail = _conflict(late)
            assert detail["menu_id"] == menu_id
            assert detail["current_revision"] == current["revision"]
            assert detail["seen_version"] == first
            publication = detail["last_publication"]
            assert publication["version"] == second
            assert publication["author"]["display_name"] == "library-anna"
            assert publication["published_at"]
            changes = detail["changes"]
            assert changes["total_changes"] == 1
            [changed] = changes["changed"]
            assert changed["name"] == "Латте"
            assert changed["changes"] == [
                {"field": "price_minor", "before": 19000, "after": 21000}
            ]
            versions = _ok(await boris.get(f"{API}/menus/{menu_id}/versions"))
            assert [entry["version"] for entry in versions] == [second, first]  # unchanged

            # Saving over Anna's draft is refused the same way; the draft is untouched.
            boris_sections = boris_draft["sections"]
            for section in boris_sections:
                for item in section["items"]:
                    item.pop("id")
                    if item["name"] == "Круассан":
                        item["price_minor"] = 16000
            overwrite = await boris.put(f"{API}/menus/{menu_id}/draft", json={
                "expected_revision": stale_revision,
                "sections": boris_sections,
                "seen_version": first,
            })
            assert _conflict(overwrite)["changes"]["total_changes"] == 1
            assert _ok(await anna.get(f"{API}/menus/{menu_id}/draft"))["revision"] == current[
                "revision"
            ]

            # Without a seen version the summary is omitted, the rest stays.
            restore = await boris.post(f"{API}/menus/{menu_id}/versions/{first}/restore", json={
                "expected_revision": stale_revision,
            })
            restore_detail = _conflict(restore)
            assert restore_detail["changes"] is None
            assert restore_detail["last_publication"]["version"] == second

            # The legacy per-point routes answer with the same structure.
            legacy = await boris.post(f"{API}/restaurants/{point['id']}/menu/publish", json={
                "expected_revision": stale_revision, "seen_version": second,
            })
            legacy_detail = _conflict(legacy)
            assert legacy_detail["changes"]["total_changes"] == 0  # draft == last publication
            legacy_save = await boris.put(f"{API}/restaurants/{point['id']}/menu/draft", json={
                "expected_revision": stale_revision, "sections": boris_sections,
            })
            assert _conflict(legacy_save)["current_revision"] == current["revision"]

            # Boris compares his unsaved copy with the current draft: nothing is lost.
            compared = _ok(await boris.post(f"{API}/menus/{menu_id}/diff", json={
                "sections": boris_sections,
            }))
            assert compared["against"] == "draft"
            assert compared["revision"] == current["revision"]
            changed_names = {
                item["name"]: item["changes"] for item in compared["diff"]["changed"]
            }
            assert changed_names == {
                "Латте": [{"field": "price_minor", "before": 19000, "after": 21000}],
                "Круассан": [{"field": "price_minor", "before": 16000, "after": 15000}],
            }
            # A copy without item_key (old client) is matched by section and name.
            for section in boris_sections:
                for item in section["items"]:
                    item.pop("item_key")
            by_name = _ok(await boris.post(f"{API}/menus/{menu_id}/diff", json={
                "sections": boris_sections, "against": "published",
            }))["diff"]
            assert by_name["added"] == [] and by_name["removed"] == []
            assert by_name["total_changes"] == 2

            # After reloading, Boris publishes his change on top of Anna's version.
            fresh = _ok(await boris.get(f"{API}/menus/{menu_id}/draft"))
            sections = fresh["sections"]
            for section in sections:
                for item in section["items"]:
                    item.pop("id")
                    if item["name"] == "Круассан":
                        item["price_minor"] = 16000
            _ok(await boris.put(f"{API}/menus/{menu_id}/draft", json={
                "expected_revision": fresh["revision"], "sections": sections,
            }))
            third = await _publish(boris, menu_id, [point["id"]])
            assert third["version"] > second

            # A foreign admin cannot read the summary of this menu.
            outsiders = await _actors(stack, ("outsider",))
            user_ids = [*user_ids, *outsiders.user_ids]
            [outsider] = outsiders.clients
            foreign = await outsider.post(f"{API}/menus/{menu_id}/diff", json={"sections": []})
            assert foreign.status_code == 404
    finally:
        await _cleanup(user_ids)
