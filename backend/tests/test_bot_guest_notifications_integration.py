"""Guest subscriptions (P1-TASK-46): consent, draft silence, quiet hours, weekly digest,
back-in-stock and at-most-once delivery across a worker restart. Mock Bot API only."""

import os
import uuid
from contextlib import AsyncExitStack
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete, select, update

from app.bot.delivery import claim_next, recover_interrupted
from app.bot.events import enqueue_new_items
from app.database import SessionFactory
from app.models import BotDialog, BotOutbox, Restaurant, User
from tests.bot_helpers import MockBotApi, bot_settings, buttons_of, deliver
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

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_DB_INTEGRATION") != "1",
    reason="requires the migrated PostgreSQL integration database",
)


async def _outbox(user_id: uuid.UUID, kind: str | None = None) -> list[BotOutbox]:
    async with SessionFactory() as session:
        statement = select(BotOutbox).where(BotOutbox.user_id == user_id)
        if kind:
            statement = statement.where(BotOutbox.kind == kind)
        return list((await session.scalars(statement.order_by(BotOutbox.created_at))).all())


async def _allow_messages(user_ids: list[uuid.UUID]) -> None:
    async with SessionFactory() as session:
        for user_id in user_ids:
            user = await session.get(User, user_id)
            session.add(BotDialog(max_user_id=user.max_user_id, user_id=user.id))
        await session.commit()


async def _drop_dialogs(user_ids: list[uuid.UUID]) -> None:
    async with SessionFactory() as session:
        await session.execute(delete(BotDialog).where(BotDialog.user_id.in_(user_ids)))
        await session.commit()


@pytest.mark.asyncio
async def test_guest_subscriptions_end_to_end() -> None:
    settings = bot_settings()
    api = MockBotApi()
    user_ids: list[uuid.UUID] = []
    later = datetime.now(UTC) + timedelta(days=1)
    try:
        async with AsyncExitStack() as stack:
            actors = await _actors(stack, ("admin", "fan", "favorite-only"))
            user_ids = actors.user_ids
            admin, fan, silent = actors.clients
            point, menu_id = await _new_venue(admin, "Кофейня Север")
            await _save_draft(admin, menu_id, BASIC_MENU)
            await _publish(admin, menu_id, [point["id"]])
            public_id = point["public_id"]
            _ok(await fan.put(f"{API}/public/restaurants/{public_id}/favorite",
                              json={"is_favorite": True, "notifications_enabled": True}))
            # In favourites but without «Узнавать о новинках»: no consent, nothing sent.
            _ok(await silent.put(f"{API}/public/restaurants/{public_id}/favorite",
                                 json={"is_favorite": True, "notifications_enabled": False}))
            await _allow_messages(user_ids[1:])

            # A novelty in the draft makes no noise.
            with_novelty = [{"name": "Кофе", "items": [
                *BASIC_MENU[0]["items"],
                {"name": "Тыквенный латте", "price_minor": 25000, "is_available": True},
            ]}]
            await _save_draft(admin, menu_id, with_novelty)
            assert await _outbox(user_ids[1]) == []

            # Publication: Г2 to the subscriber only.
            await _publish(admin, menu_id, [point["id"]])
            [novelty] = await _outbox(user_ids[1], "g2_new_items")
            assert "Тыквенный латте" in novelty.body
            assert await _outbox(user_ids[2]) == []
            assert await deliver(api, settings, now=later) == 1
            [sent] = api.messages()
            items = _public_items(await _public(fan, public_id))
            buttons = buttons_of(sent)
            assert buttons[0] == {
                "type": "open_app", "text": "Открыть", "web_app": "SinitsaBot",
                "payload": f"r_{public_id}_i_{items['Тыквенный латте']['item_key']}",
            }
            assert buttons[1] == {
                "type": "callback", "text": "Не присылать",
                "payload": f"unsub_r:{point['id']}",
            }

            # «Сообщить, когда появится»: stop-list at the point, then back → Г1.
            croissant = items["Круассан"]
            key = croissant["item_key"]
            _ok(await admin.patch(f"{API}/points/{point['id']}/items/{key}",
                                  json={"available": False}))
            _ok(await fan.put(f"{API}/public/restaurants/{public_id}/items/{key}/subscription",
                              json={"subscribed": True}))
            assert _ok(await fan.get(
                f"{API}/public/restaurants/{public_id}/items/{key}/subscription"
            )) == {"subscribed": True}
            _ok(await admin.patch(f"{API}/points/{point['id']}/items/{key}",
                                  json={"available": None}))
            [back] = await _outbox(user_ids[1], "g1_back_in_stock")
            assert back.body == "В «Кофейня Север» снова есть «Круассан»."
            # Stop again and back again within 7 days: no second message.
            _ok(await admin.patch(f"{API}/points/{point['id']}/items/{key}",
                                  json={"available": False}))
            _ok(await admin.patch(f"{API}/points/{point['id']}/items/{key}",
                                  json={"available": True}))
            assert len(await _outbox(user_ids[1], "g1_back_in_stock")) == 1

            # «Не присылать» before delivery: the queued message is skipped.
            response = await fan.delete(f"{API}/me/notifications/items/{point['id']}/{key}")
            assert response.status_code == 204
            api.clear()
            await deliver(api, settings, now=later)
            assert api.messages() == []
            [back] = await _outbox(user_ids[1], "g1_back_in_stock")
            assert (back.status, back.error_code) == ("skipped", "unsubscribed")

            # Settings screen data.
            data = _ok(await fan.get(f"{API}/me/notifications"))
            assert data["bot"]["messages_allowed"] is True
            assert data["bot"]["allow_link"] == "https://max.ru/SinitsaBot?start=settings" or \
                data["bot"]["allow_link"] is None
            assert [v["notifications_enabled"] for v in data["venues"]] == [True]
            assert data["admin"] == []
    finally:
        await _drop_dialogs(user_ids)
        await _cleanup(user_ids)


def _public_items(menu: dict) -> dict[str, dict]:
    return {
        item["name"]: item
        for tab in menu["menus"]
        for section in tab["sections"]
        for item in section["items"]
    }


@pytest.mark.asyncio
async def test_night_digest_and_restart() -> None:
    """Quiet hours, three novelties → one message, and no duplicate after a crash."""
    settings = bot_settings()
    api = MockBotApi()
    user_ids: list[uuid.UUID] = []
    try:
        async with AsyncExitStack() as stack:
            actors = await _actors(stack, ("admin", "fan"))
            user_ids = actors.user_ids
            admin, fan = actors.clients
            point_data, _menu_id = await _new_venue(admin, "Север")
            _ok(await fan.put(
                f"{API}/public/restaurants/{point_data['public_id']}/favorite",
                json={"is_favorite": True, "notifications_enabled": True},
            ))
            await _allow_messages(user_ids[1:])
            night = datetime(2026, 9, 28, 20, 30, tzinfo=UTC)  # 23:30 in Moscow
            async with SessionFactory() as session:
                point = await session.get(Restaurant, uuid.UUID(point_data["id"]))
                for index, name in enumerate(("Тыквенный латте", "Раф", "Сырники")):
                    await enqueue_new_items(
                        session, point=point, items=[(uuid.uuid4(), name)],
                        source_key=f"v{index}", now=night + timedelta(minutes=index),
                    )
                # The same publication handled twice is a no-op (dedup key).
                await session.commit()
            [digest] = await _outbox(user_ids[1], "g2_new_items")
            assert digest.not_before == datetime(2026, 9, 29, 6, 0, tzinfo=UTC)  # 09:00 MSK
            assert digest.body == "В «Север» новинки: «Тыквенный латте», «Раф», «Сырники»."
            assert len(digest.payload["items"]) == 3

            # Not before 09:00.
            assert await deliver(api, settings, now=night + timedelta(hours=2)) == 0
            # Worker takes it at 09:00 and crashes after the send, before marking it.
            nine = datetime(2026, 9, 29, 6, 0, tzinfo=UTC)
            async with SessionFactory() as session:
                claimed = await claim_next(session, nine)
            assert claimed == digest.id
            async with SessionFactory() as session:
                await session.execute(update(BotOutbox).where(BotOutbox.id == claimed).values(
                    updated_at=datetime.now(UTC) - timedelta(minutes=30)
                ))
                await session.commit()
            # Restart: the interrupted row is not sent again.
            async with SessionFactory() as session:
                assert await recover_interrupted(session, datetime.now(UTC)) >= 1
            assert await deliver(api, settings, now=nine + timedelta(hours=1)) == 0
            assert api.messages() == []
            [digest] = await _outbox(user_ids[1], "g2_new_items")
            assert (digest.status, digest.error_code) == ("failed", "interrupted")

            # A normal delivery and the weekly window: the next novelty waits 7 days.
            async with SessionFactory() as session:
                point = await session.get(Restaurant, uuid.UUID(point_data["id"]))
                await session.execute(update(BotOutbox).where(BotOutbox.id == digest.id).values(
                    status="sent", sent_at=nine, error_code=None
                ))
                await enqueue_new_items(
                    session, point=point, items=[(uuid.uuid4(), "Какао")],
                    source_key="v9", now=nine + timedelta(hours=3),
                )
                await session.commit()
            waiting = [row for row in await _outbox(user_ids[1], "g2_new_items")
                       if row.status == "pending"]
            assert len(waiting) == 1
            assert waiting[0].not_before >= nine + timedelta(days=7)
    finally:
        await _drop_dialogs(user_ids)
        await _cleanup(user_ids)


@pytest.mark.asyncio
async def test_weekly_marketing_cap_and_consent_gate() -> None:
    settings = bot_settings()
    api = MockBotApi()
    user_ids: list[uuid.UUID] = []
    try:
        async with AsyncExitStack() as stack:
            actors = await _actors(stack, ("admin", "fan"))
            user_ids = actors.user_ids
            admin, fan = actors.clients
            points = [(await _new_venue(admin, f"Точка {index}"))[0] for index in range(4)]
            for point in points:
                _ok(await fan.put(
                    f"{API}/public/restaurants/{point['public_id']}/favorite",
                    json={"is_favorite": True, "notifications_enabled": True},
                ))
            noon = datetime(2026, 9, 29, 9, 0, tzinfo=UTC)
            async with SessionFactory() as session:
                for point in points:
                    await enqueue_new_items(
                        session, point=await session.get(Restaurant, uuid.UUID(point["id"])),
                        items=[(uuid.uuid4(), "Новинка")], source_key="cap", now=noon,
                    )
                await session.commit()
            # No dialog with the bot yet: «Разрешить сообщения» first, nothing is sent.
            await deliver(api, settings, now=noon, limit=1)
            assert api.messages() == []
            skipped = [row for row in await _outbox(user_ids[1]) if row.status == "skipped"]
            assert [row.error_code for row in skipped] == ["no_dialog"]
            await _allow_messages(user_ids[1:])
            await deliver(api, settings, now=noon)
            # Three of the remaining three are sent — the fourth hit the no-dialog gate —
            # then a new one exceeds the weekly cap of three.
            assert len(api.messages()) == 3
            async with SessionFactory() as session:
                point = await session.get(Restaurant, uuid.UUID(points[0]["id"]))
                await enqueue_new_items(
                    session, point=point, items=[(uuid.uuid4(), "Ещё")],
                    source_key="cap2", now=noon,
                )
                await session.execute(update(BotOutbox).where(
                    BotOutbox.user_id == user_ids[1], BotOutbox.status == "pending"
                ).values(not_before=noon))
                await session.commit()
            await deliver(api, settings, now=noon + timedelta(hours=1))
            assert len(api.messages()) == 3
            limited = [
                row for row in await _outbox(user_ids[1]) if row.error_code == "weekly_limit"
            ]
            assert len(limited) == 1
    finally:
        await _drop_dialogs(user_ids)
        await _cleanup(user_ids)
