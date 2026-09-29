"""Venue → points + menu library → assignments (P1-DOC-15) against the real API.

Scenarios: second point, shared menu published with confirmed points, independent copy,
show hours in the point's time zone, assignment revisions, archive rules, isolation of
venues and uniqueness of external IDs.
"""

import os
import uuid
from contextlib import AsyncExitStack
from datetime import UTC, datetime

import pytest
from sqlalchemy.exc import IntegrityError
from venue_api import (
    API,
    BASIC_MENU,
    _actors,
    _assign,
    _cleanup,
    _items,
    _new_venue,
    _ok,
    _public,
    _publish,
    _save_draft,
)

from app import menu_library
from app.database import SessionFactory
from app.models import ExternalRef

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_DB_INTEGRATION") != "1",
    reason="requires the migrated PostgreSQL integration database",
)


@pytest.mark.asyncio
async def test_library_assignments_publication_and_show_hours(monkeypatch) -> None:
    user_ids: list[uuid.UUID] = []
    try:
        async with AsyncExitStack() as stack:
            actors = await _actors(stack, ("admin",))
            user_ids = actors.user_ids
            [admin] = actors.clients
            pokrovka, basic = await _new_venue(admin, "Кофейня Север")
            venue_id = pokrovka["venue_id"]
            assert pokrovka["venue_name"] == "Кофейня Север"
            assert pokrovka["timezone"] == "Europe/Moscow"

            # Scenario «Вторая точка»: its own link, «Основное» assigned explicitly.
            tverskaya = _ok(await admin.post(f"{API}/venues/{venue_id}/points", json={
                "name": "Тверская", "address": "Тверская, 5",
            }), 201)
            assert tverskaya["venue_id"] == venue_id and tverskaya["menu_id"] is None
            assert tverskaya["public_id"] != pokrovka["public_id"]
            venue = _ok(await admin.get(f"{API}/venues/{venue_id}"))
            assert [point["name"] for point in venue["points"]] == ["Кофейня Север", "Тверская"]

            await _save_draft(admin, basic, BASIC_MENU)
            first = await _publish(admin, basic, [pokrovka["id"]])
            await _assign(admin, tverskaya["id"], [{"menu_id": basic}])
            tver_menu = await _public(admin, tverskaya["public_id"])
            assert tver_menu["version"] == first["version"]
            assert [tab["title"] for tab in tver_menu["menus"]] == ["Основное"]
            assert tver_menu["restaurant"]["venue_name"] == "Кофейня Север"

            # Scenario «Общее меню сети»: one publication, confirmed points, both updated.
            await _save_draft(admin, basic, [{"name": "Кофе", "items": [
                *BASIC_MENU[0]["items"], {"name": "Раф", "price_minor": 25000},
            ]}])
            draft = _ok(await admin.get(f"{API}/menus/{basic}/draft"))
            unconfirmed = await admin.post(f"{API}/menus/{basic}/publish", json={
                "expected_revision": draft["revision"], "point_ids": [pokrovka["id"]],
            })
            assert unconfirmed.status_code == 409
            legacy = await admin.post(f"{API}/restaurants/{pokrovka['id']}/menu/publish", json={
                "expected_revision": draft["revision"],
            })
            assert legacy.status_code == 409  # shared menu needs the point list
            second = await _publish(admin, basic, [tverskaya["id"], pokrovka["id"]])
            assert sorted(second["point_ids"]) == sorted([pokrovka["id"], tverskaya["id"]])
            for point in (pokrovka, tverskaya):
                snapshot = await _public(admin, point["public_id"])
                assert snapshot["version"] == second["version"]
                assert "Раф" in _items(snapshot)

            # Scenario «Сезонное меню»: an independent copy.
            autumn = _ok(await admin.post(f"{API}/menus/{basic}/copy", json={
                "title": "Осень-2026",
            }), 201)
            assert autumn["source"] == "manual" and autumn["point_ids"] == []
            assert autumn["published_version"] is None
            autumn_draft = _ok(await admin.get(f"{API}/menus/{autumn['id']}/draft"))
            basic_draft = _ok(await admin.get(f"{API}/menus/{basic}/draft"))
            autumn_keys = {i["item_key"] for s in autumn_draft["sections"] for i in s["items"]}
            basic_keys = {i["item_key"] for s in basic_draft["sections"] for i in s["items"]}
            assert len(autumn_keys) == 3 and not autumn_keys & basic_keys
            await _save_draft(admin, autumn["id"], [{"name": "Сезон", "items": [
                {"name": "Тыквенный латте", "price_minor": 32000},
            ]}])
            assert _ok(await admin.get(f"{API}/menus/{basic}/draft")) == basic_draft
            library = _ok(await admin.get(f"{API}/venues/{venue_id}/menus"))
            assert [menu["title"] for menu in library] == ["Основное", "Осень-2026"]

            # Scenario «Завтраки по утрам» in the point's time zone.
            breakfast = _ok(await admin.post(f"{API}/venues/{venue_id}/menus", json={
                "title": "Завтраки",
            }), 201)
            await _save_draft(admin, breakfast["id"], [{"name": "Завтраки", "items": [
                {"name": "Сырники", "price_minor": 39000},
            ]}])
            await _publish(admin, breakfast["id"], [])
            for point in (pokrovka, tverskaya):
                await _assign(admin, point["id"], [
                    {"menu_id": breakfast["id"], "show_from": "08:00", "show_to": "12:00"},
                    {"menu_id": basic},
                ])
            novosibirsk = _ok(await admin.patch(f"{API}/restaurants/{tverskaya['id']}", json={
                "timezone": "Asia/Novosibirsk",
            }))
            assert novosibirsk["timezone"] == "Asia/Novosibirsk"
            unknown_zone = await admin.patch(f"{API}/restaurants/{tverskaya['id']}", json={
                "timezone": "Mars/Olympus",
            })
            assert unknown_zone.status_code == 422

            # 06:00 UTC = 09:00 in Moscow and 13:00 in Novosibirsk.
            monkeypatch.setattr(
                menu_library, "utc_now", lambda: datetime(2026, 9, 28, 6, 0, tzinfo=UTC)
            )
            morning = await _public(admin, pokrovka["public_id"])
            assert [tab["title"] for tab in morning["menus"]] == ["Завтраки", "Основное"]
            assert morning["sections"][0]["name"] == "Завтраки"  # legacy field: first tab
            siberia = await _public(admin, tverskaya["public_id"])
            assert [tab["title"] for tab in siberia["menus"]] == ["Основное"]
            # 10:00 UTC = 13:00 in Moscow: breakfast is over.
            monkeypatch.setattr(
                menu_library, "utc_now", lambda: datetime(2026, 9, 28, 10, 0, tzinfo=UTC)
            )
            afternoon = await _public(admin, pokrovka["public_id"])
            assert [tab["title"] for tab in afternoon["menus"]] == ["Основное"]
            syrniki = _ok(await admin.get(f"{API}/menus/{breakfast['id']}/draft"))
            syrniki_id = next(
                item["id"] for item in _items(morning).values() if item["name"] == "Сырники"
            )
            assert syrniki["menu_id"] == breakfast["id"]
            out_of_hours = await admin.post(
                f"{API}/public/restaurants/{pokrovka['public_id']}/menu/quote",
                json={"item_id": syrniki_id},
            )
            assert out_of_hours.status_code == 409

            # Assignment revisions and archive rules.
            stale = await admin.put(f"{API}/points/{pokrovka['id']}/menus", json={
                "expected_revision": "0" * 64, "assignments": [{"menu_id": basic}],
            })
            assert stale.status_code == 409
            assigned_archive = await admin.patch(f"{API}/menus/{basic}", json={"archived": True})
            assert assigned_archive.status_code == 409
            archived = _ok(await admin.patch(f"{API}/menus/{autumn['id']}", json={
                "archived": True,
            }))
            assert archived["archived_at"] is not None
            current = _ok(await admin.get(f"{API}/points/{pokrovka['id']}/menus"))
            refused = await admin.put(f"{API}/points/{pokrovka['id']}/menus", json={
                "expected_revision": current["revision"],
                "assignments": [{"menu_id": autumn["id"]}],
            })
            assert refused.status_code == 409
            half_hours = await admin.put(f"{API}/points/{pokrovka['id']}/menus", json={
                "expected_revision": current["revision"],
                "assignments": [{"menu_id": basic, "show_from": "08:00"}],
            })
            assert half_hours.status_code == 422

            # Home shows one venue with both points; /me lists the venue and its points.
            home = _ok(await admin.get(f"{API}/me/home"))
            [card] = home["admin_venues"]
            assert card["venue_id"] == venue_id and card["id"] == pokrovka["id"]
            assert [point["id"] for point in card["points"]] == [pokrovka["id"], tverskaya["id"]]
            me = _ok(await admin.get(f"{API}/me"))
            assert me["admin_venue_ids"] == [venue_id]
            assert set(me["admin_restaurant_ids"]) == {pokrovka["id"], tverskaya["id"]}
    finally:
        await _cleanup(user_ids)


@pytest.mark.asyncio
async def test_venue_isolation_and_external_ids() -> None:
    user_ids: list[uuid.UUID] = []
    try:
        async with AsyncExitStack() as stack:
            actors = await _actors(stack, ("north", "south"))
            user_ids = actors.user_ids
            north, south = actors.clients
            north_point, north_menu = await _new_venue(north, "Север")
            south_point, south_menu = await _new_venue(south, "Юг")
            await _save_draft(north, north_menu, BASIC_MENU)
            await _publish(north, north_menu, [north_point["id"]])
            item = _items(await _public(north, north_point["public_id"]))["Латте"]
            north_venue = north_point["venue_id"]

            foreign = [
                south.get(f"{API}/venues/{north_venue}"),
                south.get(f"{API}/venues/{north_venue}/menus"),
                south.post(f"{API}/venues/{north_venue}/points", json={"name": "X"}),
                south.get(f"{API}/menus/{north_menu}/draft"),
                south.get(f"{API}/menus/{north_menu}/versions"),
                south.post(f"{API}/menus/{north_menu}/copy", json={"title": "X"}),
                south.get(f"{API}/points/{north_point['id']}/menus"),
                south.get(f"{API}/points/{north_point['id']}/items"),
                south.patch(
                    f"{API}/points/{north_point['id']}/items/{item['item_key']}",
                    json={"available": False},
                ),
                south.post(
                    f"{API}/venues/{north_venue}/items/{item['item_key']}/availability",
                    json={"available": False},
                ),
                south.get(f"{API}/venues/{north_venue}/members"),
            ]
            for request in foreign:
                response = await request
                assert response.status_code == 404, (response.request.url, response.text)
            # A menu of another venue is never assigned, from either side.
            south_current = _ok(await south.get(f"{API}/points/{south_point['id']}/menus"))
            assert (await south.put(f"{API}/points/{south_point['id']}/menus", json={
                "expected_revision": south_current["revision"],
                "assignments": [{"menu_id": north_menu}],
            })).status_code == 404
            north_current = _ok(await north.get(f"{API}/points/{north_point['id']}/menus"))
            assert (await north.put(f"{API}/points/{north_point['id']}/menus", json={
                "expected_revision": north_current["revision"],
                "assignments": [{"menu_id": south_menu}],
            })).status_code == 404
            # Foreign item keys are not stop-listed at one's own point.
            assert (await south.patch(
                f"{API}/points/{south_point['id']}/items/{item['item_key']}",
                json={"available": False},
            )).status_code == 404
            assert _items(await _public(north, north_point["public_id"]))["Латте"][
                "is_available"
            ] is True
            assert [venue["name"] for venue in _ok(await south.get(f"{API}/venues"))] == ["Юг"]

        # One external ID never links entities of two venues.
        async with SessionFactory() as session:
            session.add(ExternalRef(
                provider="iiko", entity_type="item", entity_id=uuid.UUID(item["item_key"]),
                venue_id=uuid.UUID(north_venue), external_id="P-123",
            ))
            await session.commit()
        async with SessionFactory() as session:
            session.add(ExternalRef(
                provider="iiko", entity_type="item", entity_id=uuid.uuid4(),
                venue_id=uuid.UUID(south_point["venue_id"]), external_id="P-123",
            ))
            with pytest.raises(IntegrityError):
                await session.commit()
        async with SessionFactory() as session:
            session.add(ExternalRef(
                provider="iiko", entity_type="item", entity_id=uuid.UUID(item["item_key"]),
                venue_id=uuid.UUID(north_venue), external_id="P-456",
            ))
            with pytest.raises(IntegrityError):
                await session.commit()
        async with SessionFactory() as session:
            # Another entity type may reuse the external value (namespaces differ in iiko).
            session.add(ExternalRef(
                provider="iiko", entity_type="variant", entity_id=uuid.uuid4(),
                venue_id=uuid.UUID(north_venue), external_id="P-123",
            ))
            await session.commit()
    finally:
        await _cleanup(user_ids)
