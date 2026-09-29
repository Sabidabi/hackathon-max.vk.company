"""Admin notifications А1–А7: thresholds, frequency, per-admin settings."""

import os
import uuid
from contextlib import AsyncExitStack
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update

from app.bot.checks import run_scheduled_checks
from app.bot.events import on_import_finished
from app.bot.localtime import to_local
from app.database import SessionFactory
from app.models import BotOutbox, ImportJob, Menu, Restaurant
from tests.venue_api import (
    API,
    BASIC_MENU,
    _actors,
    _cleanup,
    _new_venue,
    _ok,
    _public,
    _publish,
    _save_draft,
)

LATTE_ONLY = [{"name": "Кофе", "items": BASIC_MENU[0]["items"][:1]}]

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_DB_INTEGRATION") != "1",
    reason="requires the migrated PostgreSQL integration database",
)


async def _rows(user_id: uuid.UUID, kind: str) -> list[BotOutbox]:
    async with SessionFactory() as session:
        return list((await session.scalars(
            select(BotOutbox).where(BotOutbox.user_id == user_id, BotOutbox.kind == kind)
        )).all())


async def _checks(now: datetime) -> None:
    async with SessionFactory() as session:
        await run_scheduled_checks(session, now)
        await session.commit()


@pytest.mark.asyncio
async def test_admin_notifications() -> None:
    user_ids: list[uuid.UUID] = []
    guests_labels = tuple(f"guest{index}" for index in range(10))
    try:
        async with AsyncExitStack() as stack:
            actors = await _actors(stack, ("owner", "partner", *guests_labels))
            user_ids = actors.user_ids
            owner, partner, *guests = actors.clients
            owner_id, partner_id = user_ids[0], user_ids[1]
            point, menu_id = await _new_venue(owner, "Кофейня Север")
            await _save_draft(owner, menu_id, BASIC_MENU)
            await _publish(owner, menu_id, [point["id"]])
            async with SessionFactory() as session:
                venue_id = (await session.get(Restaurant, uuid.UUID(point["id"]))).venue_id

            # А2: the partner accepts an invitation → the owner learns, the partner does not.
            created = _ok(await owner.post(f"{API}/restaurants/{point['id']}/invites"), 201)
            token = created["web_url"].rsplit("/invite/", 1)[-1]
            _ok(await partner.post(f"{API}/invites/{token}/accept"))
            [joined] = await _rows(owner_id, "a2_admin_joined")
            assert "теперь администратор «Кофейня Север»" in joined.body
            assert await _rows(partner_id, "a2_admin_joined") == []

            # А3: the partner switched «опубликовал другой админ» off.
            response = await partner.put(
                f"{API}/me/notifications/admin/{venue_id}/a3_menu_published",
                json={"enabled": False},
            )
            assert response.status_code == 204
            await _save_draft(owner, menu_id, LATTE_ONLY)
            await _publish(owner, menu_id, [point["id"]])
            assert await _rows(owner_id, "a3_menu_published") == []  # the actor
            assert await _rows(partner_id, "a3_menu_published") == []  # switched off
            await _save_draft(partner, menu_id, BASIC_MENU)
            await _publish(partner, menu_id, [point["id"]])
            [published] = await _rows(owner_id, "a3_menu_published")
            assert "изменений — 1" in published.body
            settings = _ok(await partner.get(f"{API}/me/notifications"))
            kinds = {k["kind"]: k["enabled"] for k in settings["admin"][0]["kinds"]}
            assert kinds["a3_menu_published"] is False and kinds["a7_weekly_summary"] is True

            # А1: import finished → the admin who uploaded.
            async with SessionFactory() as session:
                job = ImportJob(
                    restaurant_id=uuid.UUID(point["id"]), created_by_id=partner_id,
                    original_name="menu.pdf", stored_path="x", mime_type="application/pdf",
                    size_bytes=1, sha256="0" * 64, status="needs_review",
                )
                session.add(job)
                await session.flush()
                await on_import_finished(session, job.id, "Меню распознано: 34 позиции.")
                await on_import_finished(session, job.id, "Меню распознано: 34 позиции.")
                await session.commit()
            assert len(await _rows(partner_id, "a1_import_ready")) == 1
            assert await _rows(owner_id, "a1_import_ready") == []

            # А5: the croissant is on the stop-list; 9 guests are below the threshold of 10.
            menu = await _public(owner, point["public_id"])
            croissant = next(
                item for item in menu["menus"][0]["sections"][0]["items"]
                if item["name"] == "Круассан"
            )
            _ok(await owner.patch(
                f"{API}/points/{point['id']}/items/{croissant['item_key']}",
                json={"available": False},
            ))
            for guest in guests[:9]:
                response = await guest.post(
                    f"{API}/public/restaurants/{point['public_id']}/signals",
                    json={"kind": "item_open", "key": croissant["item_key"]},
                )
                assert response.status_code == 204
            async with SessionFactory() as session:
                today = (await to_local(session, "Europe/Moscow", datetime.now(UTC))).date()
            evening = datetime(today.year, today.month, today.day, 16, 0, tzinfo=UTC)  # 19:00
            await _checks(evening)
            assert await _rows(owner_id, "a5_stop_list_demand") == []
            # The same guest twice counts once; the tenth guest reaches the threshold.
            await guests[0].post(
                f"{API}/public/restaurants/{point['public_id']}/signals",
                json={"kind": "item_open", "key": croissant["item_key"]},
            )
            await guests[9].post(
                f"{API}/public/restaurants/{point['public_id']}/signals",
                json={"kind": "item_open", "key": croissant["item_key"]},
            )
            await _checks(evening - timedelta(hours=6))  # 13:00 local: too early for А5
            assert await _rows(owner_id, "a5_stop_list_demand") == []
            await _checks(evening)
            await _checks(evening + timedelta(hours=1))  # once a day per venue
            [demand] = await _rows(owner_id, "a5_stop_list_demand")
            assert demand.body.startswith("Сегодня 10 гостей открывали «Круассан»")
            assert len(await _rows(partner_id, "a5_stop_list_demand")) == 1

            # А6: 5 guests searched «матча» without a result this week.
            for guest in guests[:5]:
                await guest.post(
                    f"{API}/public/restaurants/{point['public_id']}/signals",
                    json={"kind": "empty_search", "key": "  Матча "},
                )
            await _checks(evening)
            await _checks(evening + timedelta(days=1))
            [searches] = await _rows(owner_id, "a6_empty_searches")
            assert "«матча» 5 раз" in searches.body

            # А4: unpublished changes older than 24 hours.
            await _save_draft(owner, menu_id, LATTE_ONLY)
            await _checks(evening)
            assert await _rows(owner_id, "a4_draft_stale") == []
            async with SessionFactory() as session:
                await session.execute(update(Menu).where(Menu.id == uuid.UUID(menu_id)).values(
                    updated_at=datetime.now(UTC) - timedelta(hours=25)
                ))
                await session.commit()
            await _checks(datetime.now(UTC))
            await _checks(datetime.now(UTC))
            assert len(await _rows(owner_id, "a4_draft_stale")) == 1

            # А7: Monday 10:00 local; the partner switched the summary off.
            response = await partner.put(
                f"{API}/me/notifications/admin/{venue_id}/a7_weekly_summary",
                json={"enabled": False},
            )
            assert response.status_code == 204
            monday = today + timedelta(days=(7 - today.weekday()) % 7)
            sunday_evening = datetime(monday.year, monday.month, monday.day, 6, 0, tzinfo=UTC) - \
                timedelta(hours=12)
            await _checks(sunday_evening)
            assert await _rows(owner_id, "a7_weekly_summary") == []
            monday_ten = datetime(monday.year, monday.month, monday.day, 7, 0, tzinfo=UTC)
            await _checks(monday_ten - timedelta(minutes=5))  # 09:55 local
            assert await _rows(owner_id, "a7_weekly_summary") == []
            await _checks(monday_ten)
            await _checks(monday_ten + timedelta(hours=3))
            [summary] = await _rows(owner_id, "a7_weekly_summary")
            assert summary.body.startswith("«Кофейня Север» за неделю:")
            assert await _rows(partner_id, "a7_weekly_summary") == []
    finally:
        await _cleanup(user_ids)
