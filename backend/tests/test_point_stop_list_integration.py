"""Point stop-list and own price without publication against the real API."""

import os
import uuid
from contextlib import AsyncExitStack

import pytest
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

from app.database import SessionFactory
from app.models import ImportJob

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_DB_INTEGRATION") != "1",
    reason="requires the migrated PostgreSQL integration database",
)


@pytest.mark.asyncio
async def test_point_stop_list_and_price_apply_without_publication() -> None:
    user_ids: list[uuid.UUID] = []
    try:
        async with AsyncExitStack() as stack:
            actors = await _actors(stack, ("admin",))
            user_ids = actors.user_ids
            [admin] = actors.clients
            pokrovka, basic = await _new_venue(admin, "Кофейня Север")
            venue_id = pokrovka["venue_id"]
            tverskaya = _ok(await admin.post(f"{API}/venues/{venue_id}/points", json={
                "name": "Тверская",
            }), 201)
            airport = _ok(await admin.post(f"{API}/venues/{venue_id}/points", json={
                "name": "Аэропорт",
            }), 201)
            empty_point = _ok(await admin.post(f"{API}/venues/{venue_id}/points", json={
                "name": "Без меню",
            }), 201)
            for point in (tverskaya, airport):
                await _assign(admin, point["id"], [{"menu_id": basic}])
            await _save_draft(admin, basic, BASIC_MENU)
            published = await _publish(
                admin, basic, [pokrovka["id"], tverskaya["id"], airport["id"]]
            )
            snapshot = await _public(admin, pokrovka["public_id"])
            croissant = _items(snapshot)["Круассан"]
            latte = _items(snapshot)["Латте"]

            # Scenario «Закончились круассаны на одной точке».
            stop = _ok(await admin.patch(
                f"{API}/points/{tverskaya['id']}/items/{croissant['item_key']}",
                json={"available": False},
            ))
            assert stop["available"] is False and stop["price_minor"] is None
            tver = await _public(admin, tverskaya["public_id"])
            assert _items(tver)["Круассан"]["is_available"] is False
            assert _items(await _public(admin, pokrovka["public_id"]))["Круассан"][
                "is_available"
            ] is True
            assert tver["version"] == published["version"]  # no new menu version
            versions = _ok(await admin.get(f"{API}/menus/{basic}/versions"))
            assert [entry["version"] for entry in versions] == [published["version"]]
            quote_url = "/menu/quote"
            refused = await admin.post(
                f"{API}/public/restaurants/{tverskaya['public_id']}{quote_url}",
                json={"item_id": croissant["id"]},
            )
            assert refused.status_code == 409
            _ok(await admin.post(
                f"{API}/public/restaurants/{pokrovka['public_id']}{quote_url}",
                json={"item_id": croissant["id"]},
            ))

            # Scenario «Точка в аэропорту»: own price for guests and the server quote.
            priced = _ok(await admin.patch(
                f"{API}/points/{airport['id']}/items/{latte['item_key']}",
                json={"price_minor": 26000},
            ))
            assert priced["price_minor"] == 26000
            assert _items(await _public(admin, airport["public_id"]))["Латте"][
                "price_minor"
            ] == 26000
            airport_quote = _ok(await admin.post(
                f"{API}/public/restaurants/{airport['public_id']}{quote_url}",
                json={"item_id": latte["id"], "quantity": 2},
            ))
            assert airport_quote["unit_price_minor"] == 26000
            assert airport_quote["total_price_minor"] == 52000
            base_quote = _ok(await admin.post(
                f"{API}/public/restaurants/{pokrovka['public_id']}{quote_url}",
                json={"item_id": latte["id"]},
            ))
            assert base_quote["unit_price_minor"] == 19000
            bad_price = await admin.patch(
                f"{API}/points/{airport['id']}/items/{latte['item_key']}",
                json={"price_minor": -1},
            )
            assert bad_price.status_code == 422
            unknown_size = await admin.patch(
                f"{API}/points/{airport['id']}/items/{latte['item_key']}",
                json={"variant_prices": {str(uuid.uuid4()): 100}},
            )
            assert unknown_size.status_code == 422

            items = _ok(await admin.get(f"{API}/points/{airport['id']}/items"))
            [menu_items] = items["menus"]
            assert menu_items["source"] == "published"
            airport_latte = next(i for i in menu_items["items"] if i["name"] == "Латте")
            assert airport_latte["menu_price_minor"] == 19000
            assert airport_latte["effective_price_minor"] == 26000
            cleared = _ok(await admin.patch(
                f"{API}/points/{airport['id']}/items/{latte['item_key']}",
                json={"price_minor": None},
            ))
            assert cleared["price_minor"] is None
            assert _items(await _public(admin, airport["public_id"]))["Латте"][
                "price_minor"
            ] == 19000

            # Scenario «Массовый стоп-лист»: one operation over all points with the item.
            bulk_url = f"{API}/venues/{venue_id}/items/{croissant['item_key']}/availability"
            atomic = await admin.post(bulk_url, json={
                "available": False, "point_ids": [pokrovka["id"], empty_point["id"]],
            })
            assert atomic.status_code == 409
            assert _items(await _public(admin, pokrovka["public_id"]))["Круассан"][
                "is_available"
            ] is True  # nothing applied: the whole operation was refused
            everywhere = _ok(await admin.post(bulk_url, json={"available": False}))
            assert sorted(everywhere["point_ids"]) == sorted(
                [pokrovka["id"], tverskaya["id"], airport["id"]]
            )
            for point in (pokrovka, tverskaya, airport):
                assert _items(await _public(admin, point["public_id"]))["Круассан"][
                    "is_available"
                ] is False
            restored = _ok(await admin.post(bulk_url, json={"available": None}))
            assert len(restored["point_ids"]) == 3
            for point in (pokrovka, tverskaya, airport):
                assert _items(await _public(admin, point["public_id"]))["Круассан"][
                    "is_available"
                ] is True

            # A renamed position keeps its key; the stop-list follows it into the next
            # publication, including through the legacy per-point draft route.
            _ok(await admin.patch(
                f"{API}/points/{tverskaya['id']}/items/{croissant['item_key']}",
                json={"available": False},
            ))
            legacy_url = f"{API}/restaurants/{pokrovka['id']}/menu/draft"
            legacy = _ok(await admin.get(legacy_url))
            sections = legacy["sections"]
            for section in sections:
                for item in section["items"]:
                    item.pop("id")
                    if item["name"] == "Круассан":
                        item["name"] = "Круассан с миндалём"
            _ok(await admin.put(legacy_url, json={
                "expected_revision": legacy["revision"], "sections": sections,
            }))
            for section in sections:  # an old client that drops unknown fields
                for item in section["items"]:
                    item.pop("item_key")
            legacy = _ok(await admin.get(legacy_url))
            saved = _ok(await admin.put(legacy_url, json={
                "expected_revision": legacy["revision"], "sections": sections,
            }))
            renamed = next(
                item for item in saved["sections"][0]["items"]
                if item["name"] == "Круассан с миндалём"
            )
            assert renamed["item_key"] == croissant["item_key"]
            await _publish(admin, basic, [pokrovka["id"], tverskaya["id"], airport["id"]])
            assert _items(await _public(admin, tverskaya["public_id"]))[
                "Круассан с миндалём"
            ]["is_available"] is False
    finally:
        await _cleanup(user_ids)


@pytest.mark.asyncio
async def test_reimport_keeps_item_keys_so_the_stop_list_stays_attached() -> None:
    user_ids: list[uuid.UUID] = []
    try:
        async with AsyncExitStack() as stack:
            actors = await _actors(stack, ("importer",))
            user_ids = actors.user_ids
            [admin] = actors.clients
            point, basic = await _new_venue(admin, "Кофейня Импорт")
            await _save_draft(admin, basic, BASIC_MENU)
            published = await _publish(admin, basic, [point["id"]])
            croissant = _items(await _public(admin, point["public_id"]))["Круассан"]
            _ok(await admin.patch(
                f"{API}/points/{point['id']}/items/{croissant['item_key']}",
                json={"available": False},
            ))
            async with SessionFactory() as session:
                job = ImportJob(
                    restaurant_id=uuid.UUID(point["id"]), created_by_id=user_ids[0],
                    original_name="menu.pdf", stored_path="imports/none.pdf",
                    mime_type="application/pdf", size_bytes=0, sha256="0" * 64,
                    status="needs_review", progress=100,
                )
                session.add(job)
                await session.commit()
                job_id = job.id
            draft = _ok(await admin.get(f"{API}/menus/{basic}/draft"))
            applied = _ok(await admin.post(
                f"{API}/restaurants/{point['id']}/imports/{job_id}/apply",
                json={"expected_revision": draft["revision"], "sections": [
                    {"name": "Кофе", "items": [
                        {"name": "Круассан", "price_minor": 16000},
                        {"name": "Капучино", "price_minor": 18000},
                    ]},
                ]},
            ))
            assert applied["item_count"] == 2
            draft = _ok(await admin.get(f"{API}/menus/{basic}/draft"))
            keys = {item["name"]: item["item_key"] for item in draft["sections"][0]["items"]}
            assert keys["Круассан"] == croissant["item_key"]
            assert keys["Капучино"] != croissant["item_key"]
            second = await _publish(admin, basic, [point["id"]])
            assert second["version"] > published["version"]
            assert _items(await _public(admin, point["public_id"]))["Круассан"][
                "is_available"
            ] is False
    finally:
        await _cleanup(user_ids)


@pytest.mark.asyncio
async def test_point_cannot_switch_on_an_unsellable_position_and_shows_size_prices() -> None:
    """Regression: ``available: true`` at a point must not expose a position
    that cannot be sold (``availability_error``); sizes show what the guest pays."""
    user_ids: list[uuid.UUID] = []
    try:
        async with AsyncExitStack() as stack:
            actors = await _actors(stack, ("sizes",))
            user_ids = actors.user_ids
            [admin] = actors.clients
            point, basic = await _new_venue(admin, "Кофейня Размеры")
            venue_id = point["venue_id"]
            second = _ok(await admin.post(f"{API}/venues/{venue_id}/points", json={
                "name": "Вторая",
            }), 201)
            await _assign(admin, second["id"], [{"menu_id": basic}])
            small, large, gone = (str(uuid.uuid4()) for _ in range(3))
            await _save_draft(admin, basic, [{"name": "Кофе", "items": [
                {"name": "Раф", "price_minor": 20000, "is_available": True, "configuration": {
                    "variants": [
                        {"id": small, "name": "S", "price_minor": 20000},
                        {"id": large, "name": "L", "price_minor": 25000},
                    ],
                    "default_variant_id": small,
                }},
                # Switched off in the menu because it has no available size.
                {"name": "Какао", "price_minor": 18000, "is_available": False, "configuration": {
                    "variants": [
                        {"id": gone, "name": "M", "price_minor": 18000, "is_available": False},
                    ],
                }},
            ]}])
            await _publish(admin, basic, [point["id"], second["id"]])
            snapshot = _items(await _public(admin, point["public_id"]))
            cocoa, raf = snapshot["Какао"], snapshot["Раф"]

            refused = await admin.patch(
                f"{API}/points/{point['id']}/items/{cocoa['item_key']}",
                json={"available": True},
            )
            assert refused.status_code == 409
            assert "нет доступного размера" in refused.json()["detail"]
            bulk_url = f"{API}/venues/{venue_id}/items/{cocoa['item_key']}/availability"
            bulk = await admin.post(bulk_url, json={"available": True})
            assert bulk.status_code == 409
            assert "нет доступного размера" in bulk.json()["detail"]
            for public_id in (point["public_id"], second["public_id"]):
                assert _items(await _public(admin, public_id))["Какао"]["is_available"] is False
            # Switching off or returning to the menu value stays allowed.
            _ok(await admin.patch(
                f"{API}/points/{point['id']}/items/{cocoa['item_key']}",
                json={"available": False},
            ))
            _ok(await admin.post(bulk_url, json={"available": None}))

            # Own size price: the stop-list screen shows what the guest pays per size.
            _ok(await admin.patch(
                f"{API}/points/{point['id']}/items/{raf['item_key']}",
                json={"variant_prices": {large: 27000}},
            ))
            items = _ok(await admin.get(f"{API}/points/{point['id']}/items"))
            states = {item["name"]: item for item in items["menus"][0]["items"]}
            assert states["Какао"]["availability_error"] == "нет доступного размера"
            assert states["Раф"]["availability_error"] is None
            assert states["Раф"]["variants"] == [
                {"variant_id": small, "name": "S", "is_available": True,
                 "menu_price_minor": 20000, "effective_price_minor": 20000},
                {"variant_id": large, "name": "L", "is_available": True,
                 "menu_price_minor": 25000, "effective_price_minor": 27000},
            ]
            quote = _ok(await admin.post(
                f"{API}/public/restaurants/{point['public_id']}/menu/quote",
                json={"item_id": raf["id"], "variant_id": large},
            ))
            assert quote["unit_price_minor"] == 27000
    finally:
        await _cleanup(user_ids)


@pytest.mark.asyncio
async def test_point_override_does_not_revive_a_position_published_without_a_size() -> None:
    """Regression: ``available: true`` saved while the position was
    sellable must not expose it once a version without an available size is published."""
    user_ids: list[uuid.UUID] = []
    try:
        async with AsyncExitStack() as stack:
            actors = await _actors(stack, ("revive",))
            user_ids = actors.user_ids
            [admin] = actors.clients
            point, basic = await _new_venue(admin, "Кофейня Возврат")
            small = str(uuid.uuid4())
            espresso = {"name": "Эспрессо", "price_minor": 12000, "is_available": True}
            await _save_draft(admin, basic, [{"name": "Кофе", "items": [
                espresso,
                # Off in the menu but sellable: the point may switch it on.
                {"name": "Латте", "price_minor": 20000, "is_available": False,
                 "configuration": {"variants": [
                     {"id": small, "name": "S", "price_minor": 20000},
                 ]}},
            ]}])
            await _publish(admin, basic, [point["id"]])
            latte = _items(await _public(admin, point["public_id"]))["Латте"]
            _ok(await admin.patch(
                f"{API}/points/{point['id']}/items/{latte['item_key']}",
                json={"available": True},
            ))
            assert _items(await _public(admin, point["public_id"]))["Латте"]["is_available"]

            # The menu drops the last available size; the point override stays.
            await _save_draft(admin, basic, [{"name": "Кофе", "items": [
                espresso,
                {"item_key": latte["item_key"], "name": "Латте", "price_minor": 20000,
                 "is_available": False, "configuration": {"variants": [
                     {"id": small, "name": "S", "price_minor": 20000, "is_available": False},
                 ]}},
            ]}])
            await _publish(admin, basic, [point["id"]])
            latte = _items(await _public(admin, point["public_id"]))["Латте"]
            assert latte["is_available"] is False
            quote = await admin.post(
                f"{API}/public/restaurants/{point['public_id']}/menu/quote",
                json={"item_id": latte["id"], "variant_id": small},
            )
            assert quote.status_code == 409
            items = _ok(await admin.get(f"{API}/points/{point['id']}/items"))
            state = {item["name"]: item for item in items["menus"][0]["items"]}["Латте"]
            assert state["item_key"] == latte["item_key"]
            assert state["override"]["available"] is True
            assert state["availability_error"] == "нет доступного размера"
            assert state["effective_is_available"] is False
    finally:
        await _cleanup(user_ids)
