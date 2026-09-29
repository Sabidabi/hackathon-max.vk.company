"""Product analytics (P1-PLAN-10) against the real API and PostgreSQL."""

import os
import uuid
from contextlib import AsyncExitStack
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import delete, select
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

from app.analytics.report import build_report
from app.analytics.rollup import purge_raw_events, rollup_days
from app.database import SessionFactory
from app.main import app
from app.models import (
    AnalyticsDaily,
    AnalyticsEmptySearch,
    AnalyticsEvent,
    DemandSignalHit,
    Restaurant,
)

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_DB_INTEGRATION") != "1",
    reason="requires the migrated PostgreSQL integration database",
)


def _event(name: str, **extra) -> dict:
    return {"client_event_id": str(uuid.uuid4()), "name": name, **extra}


def _batch(point: str, events: list[dict], session_id: str | None = None) -> dict:
    return {"point": point, "session_id": session_id or str(uuid.uuid4()),
            "platform": "web", "events": events}


@pytest.mark.asyncio
async def test_events_ingestion_dedup_validation_and_demand_signals() -> None:
    user_ids: list[uuid.UUID] = []
    try:
        async with AsyncExitStack() as stack:
            actors = await _actors(stack, ("admin", "guest"))
            user_ids = actors.user_ids
            admin, guest = actors.clients
            point, menu_id = await _new_venue(admin, "Кофейня Аналитика")
            await _save_draft(admin, menu_id, BASIC_MENU)
            await _publish(admin, menu_id, [point["id"]])
            latte = _items(await _public(admin, point["public_id"]))["Латте"]
            anonymous = await stack.enter_async_context(httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test",
            ))
            public_id = point["public_id"]

            # A repeated batch (network dropped after sending) does not duplicate events.
            batch = _batch(public_id, [
                _event("menu_view", props={"menu_id": menu_id}),
                _event("item_view", props={"item_key": latte["item_key"], "item_name": "Латте"}),
            ])
            first = _ok(await anonymous.post(f"{API}/events", json=batch))
            again = _ok(await anonymous.post(f"{API}/events", json=batch))
            assert first == {"accepted": 2, "duplicates": 0}
            assert again == {"accepted": 0, "duplicates": 2}
            async with SessionFactory() as session:
                stored = (await session.scalars(select(AnalyticsEvent).where(
                    AnalyticsEvent.point_id == uuid.UUID(point["id"])
                ))).all()
                assert len(stored) == 2
                menu_view = next(e for e in stored if e.name == "menu_view")
                assert menu_view.menu_version_id is not None
                assert all(e.user_id is None for e in stored)

            # Unknown names, personal-data props and a query outside search_empty are refused.
            for bad in (
                _event("page_scroll"),
                _event("item_view", props={"phone": "+79990000000"}),
                _event("item_view", props={"first_name": "Анна"}),
                _event("item_view", props={"whatever": 1}),
                _event("search", query="раф"),
            ):
                response = await anonymous.post(f"{API}/events", json=_batch(public_id, [bad]))
                assert response.status_code == 422, bad
            too_many = _batch(public_id, [_event("menu_view") for _ in range(51)])
            assert (await anonymous.post(f"{API}/events", json=too_many)).status_code == 422
            unknown_point = _batch("no-such-point", [_event("menu_view")])
            assert (await anonymous.post(f"{API}/events", json=unknown_point)).status_code == 404

            # Admin events: only an admin of this venue.
            admin_batch = _batch(public_id, [_event("menu_published")])
            assert (await anonymous.post(f"{API}/events", json=admin_batch)).status_code == 403
            assert (await guest.post(f"{API}/events", json=admin_batch)).status_code == 403
            _ok(await admin.post(f"{API}/events", json=admin_batch))

            # Search: length and count in props; the phrase only in the empty-search aggregate.
            search = _batch(public_id, [
                _event("search", props={"query_len": 10, "results": 0}),
                _event("search_empty", props={"query_len": 10}, query="  Овсяный   РАФ "),
                _event("item_view", props={"item_key": latte["item_key"], "item_name": "Латте"}),
            ])
            _ok(await guest.post(f"{API}/events", json=search))
            async with SessionFactory() as session:
                empty = (await session.scalars(select(AnalyticsEmptySearch).where(
                    AnalyticsEmptySearch.point_id == uuid.UUID(point["id"])
                ))).all()
                assert [(row.query, row.hits) for row in empty] == [("овсяный раф", 1)]
                props = (await session.scalars(select(AnalyticsEvent.props).where(
                    AnalyticsEvent.point_id == uuid.UUID(point["id"]),
                    AnalyticsEvent.name.in_(("search", "search_empty")),
                ))).all()
                assert all("query" not in p and "раф" not in str(p).lower() for p in props)
                # Signed-in guest feeds А5 (item_open) and А6 (empty_search).
                hits = {(h.kind, h.key) for h in (await session.scalars(
                    select(DemandSignalHit).where(
                        DemandSignalHit.point_id == uuid.UUID(point["id"])
                    )
                )).all()}
                assert hits == {("item_open", latte["item_key"]), ("empty_search", "овсяный раф")}

            # Isolation: another user gets 404; the admin gets the report.
            venue_id = point["venue_id"]
            assert (await guest.get(f"{API}/venues/{venue_id}/analytics")).status_code == 404
            assert (await anonymous.get(f"{API}/venues/{venue_id}/analytics")).status_code == 401
            report = _ok(await admin.get(
                f"{API}/venues/{venue_id}/analytics", params={"period": "today",
                                                              "point": public_id},
            ))
            assert report["has_data"] is True
            assert report["empty_searches"] == [{"query": "овсяный раф", "hits": 1}]
            assert report["demo_venue"] is False and report["synthetic"] is False
            other = await admin.get(f"{API}/venues/{venue_id}/analytics",
                                    params={"point": "demo-sever"})
            assert other.status_code == 404
    finally:
        await _cleanup(user_ids)


async def _insert(point: Restaurant, rows: list[tuple[str, uuid.UUID, datetime, dict]]) -> None:
    async with SessionFactory() as session:
        session.add_all([
            AnalyticsEvent(
                client_event_id=uuid.uuid4(), occurred_at=at, venue_id=point.venue_id,
                point_id=point.id, session_id=sid, platform="web", name=name, props=props,
            )
            for name, sid, at, props in rows
        ])
        await session.commit()


@pytest.mark.asyncio
async def test_report_funnel_local_day_empty_and_rollup() -> None:
    user_ids: list[uuid.UUID] = []
    try:
        async with AsyncExitStack() as stack:
            actors = await _actors(stack, ("admin",))
            user_ids = actors.user_ids
            [admin] = actors.clients
            created, _ = await _new_venue(admin, "Кофейня Воронка")
            async with SessionFactory() as session:
                point = await session.get(Restaurant, uuid.UUID(created["id"]))
                assert point is not None and point.timezone == "Europe/Moscow"
                now = datetime(2026, 9, 29, 6, 0, tzinfo=UTC)  # 09:00 local
                # Empty period: zeros, no errors.
                empty = await build_report(session, [point], "7d", now)
                assert empty["has_data"] is False and empty["choices"] == 0
                assert [s["sessions"] for s in empty["funnel"]] == [0, 0, 0, 0]
                assert empty["choice_rate"] is None and len(empty["daily"]) == 7

            key = str(uuid.uuid4())
            at = datetime(2026, 9, 29, 5, 0, tzinfo=UTC)
            sessions = [uuid.uuid4() for _ in range(100)]
            rows = [("menu_view", s, at, {}) for s in sessions]
            rows += [("item_view", s, at, {"item_key": key, "item_name": "Раф"})
                     for s in sessions[:60]]
            rows += [("item_add", s, at, {"item_key": key, "item_name": "Раф"})
                     for s in sessions[:20]]
            rows += [("item_add", s, at, {"item_key": str(uuid.uuid4()), "item_name": "Чай"})
                     for s in sessions[:10]]
            rows += [("item_remove", s, at, {}) for s in sessions[:4]]
            rows += [("choice_shown", s, at, {}) for s in sessions[:8]]
            # Near midnight: 21:30 UTC is 00:30 of the next local day (UTC+3); 20:30 UTC is not.
            late = uuid.uuid4()
            rows.append(("app_open", late, datetime(2026, 9, 28, 21, 30, tzinfo=UTC), {}))
            rows.append(("app_open", uuid.uuid4(), datetime(2026, 9, 28, 20, 30, tzinfo=UTC), {}))
            await _insert(point, rows)

            async with SessionFactory() as session:
                point = await session.get(Restaurant, point.id)
                report = await build_report(session, [point], "today", now)
                assert [(s["sessions"], s["rate"]) for s in report["funnel"]] == [
                    (100, None), (60, 60), (20, 33), (8, 40),
                ]
                assert report["choices"] == 20 and report["choice_rate"] == 20
                # 10 sessions add twice, 4 of them remove once: (4·1 + 6·2 + 10·1) / 20.
                assert report["avg_choice_size"] == 1.3
                assert report["guests"]["web_sessions"] == 101  # 100 + the 00:30 one
                assert report["top_viewed"][0] == {
                    "item_key": key, "name": "Раф", "views": 60, "adds": 20,
                }
                assert report["daily"] == [{"day": "2026-09-29", "sessions": 100}]
                week = await build_report(session, [point], "7d", now)
                assert week["guests"]["web_sessions"] == 102

                assert await rollup_days(session, now + timedelta(days=1)) >= 1
                await session.commit()
                daily = await session.get(AnalyticsDaily, (point.id, now.date()))
                assert daily is not None
                assert daily.metrics["sessions_by_event"]["menu_view"] == 100
                # Second call recalculates last 2 days, so returns >= 2 (new behavior, P1-TASK-65)
                assert await rollup_days(session, now + timedelta(days=1)) >= 2
                assert await purge_raw_events(session, now + timedelta(days=181)) >= 102
                await session.rollback()
    finally:
        async with SessionFactory() as session:
            await session.execute(delete(AnalyticsEvent).where(
                AnalyticsEvent.venue_id.in_(select(Restaurant.venue_id).where(
                    Restaurant.owner_id.in_(user_ids)
                ))
            ))
            await session.commit()
        await _cleanup(user_ids)


@pytest.mark.asyncio
async def test_events_rejected_for_unpublished_point() -> None:
    """Events for points without published menus should return 404 (P1-TASK-65)."""
    user_ids: list[uuid.UUID] = []
    try:
        async with AsyncExitStack() as stack:
            actors = await _actors(stack, ("admin",))
            user_ids = actors.user_ids
            admin = actors.clients[0]
            point, menu_id = await _new_venue(admin, "Кофейня Неопубликованная")
            # Don't publish the menu
            anonymous = await stack.enter_async_context(httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test",
            ))
            public_id = point["public_id"]

            # Events to unpublished point should return 404
            batch = _batch(public_id, [_event("menu_view")])
            response = await anonymous.post(f"{API}/events", json=batch)
            assert response.status_code == 404, "unpublished point should reject events"
            assert response.json()["detail"] == "Restaurant not found"

            # After publishing, events should be accepted
            await _save_draft(admin, menu_id, BASIC_MENU)
            await _publish(admin, menu_id, [point["id"]])
            response = await anonymous.post(f"{API}/events", json=batch)
            assert response.status_code == 200
    finally:
        await _cleanup(user_ids)


@pytest.mark.asyncio
async def test_rollup_recalculates_last_two_days() -> None:
    """Rollup should recalculate last 2 days to include late-arriving events (P1-TASK-65)."""
    user_ids: list[uuid.UUID] = []
    try:
        async with AsyncExitStack() as stack:
            actors = await _actors(stack, ("admin",))
            user_ids = actors.user_ids
            [admin] = actors.clients
            created, _ = await _new_venue(admin, "Кофейня Пересчёт")
            async with SessionFactory() as session:
                point = await session.get(Restaurant, uuid.UUID(created["id"]))
                assert point is not None
                now = datetime(2026, 9, 29, 6, 0, tzinfo=UTC)  # 09:00 local

                # Insert events for 3 days
                key = str(uuid.uuid4())
                base_at = datetime(2026, 9, 26, 5, 0, tzinfo=UTC)  # 3 days ago
                for day_offset in range(3):
                    at = base_at + timedelta(days=day_offset)
                    sid = uuid.uuid4()
                    await _insert(point, [
                        ("menu_view", sid, at, {}),
                        ("item_view", sid, at, {"item_key": key, "item_name": "Раф"}),
                    ])

                # First rollup: write all 3 days
                written = await rollup_days(session, now)
                await session.commit()
                assert written >= 3, f"expected at least 3 days written, got {written}"

                # Verify all 3 days are rolled up
                for day_offset in range(3):
                    day = (now - timedelta(days=3-day_offset)).date()
                    daily = await session.get(AnalyticsDaily, (point.id, day))
                    assert daily is not None, f"day {day} should be rolled up"

                # Now add a late event to day 2 (yesterday)
                yesterday = (now - timedelta(days=1)).date()
                late_at = datetime(2026, 9, 28, 5, 30, tzinfo=UTC)
                late_sid = uuid.uuid4()
                await _insert(point, [
                    ("item_view", late_sid, late_at, {"item_key": key, "item_name": "Раф"})
                ])

                # Second rollup: should recalculate last 2 days
                written = await rollup_days(session, now)
                await session.commit()
                assert written >= 2, f"expected at least 2 days recalculated, got {written}"

                # Verify the late event was included in yesterday's aggregate
                yesterday_daily = await session.get(AnalyticsDaily, (point.id, yesterday))
                assert yesterday_daily is not None
                # The rollup should have included the new event
                assert yesterday_daily.metrics["sessions_by_event"]["item_view"] >= 2
    finally:
        async with SessionFactory() as session:
            await session.execute(delete(AnalyticsEvent).where(
                AnalyticsEvent.venue_id.in_(select(Restaurant.venue_id).where(
                    Restaurant.owner_id.in_(user_ids)
                ))
            ))
            await session.commit()
        await _cleanup(user_ids)


@pytest.mark.asyncio
async def test_demo_events_only_for_demo_venue(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.analytics.demo import NotDemoVenue, seed_demo_events
    from app.config import get_settings
    from app.demo_seed import seed_demo

    user_ids: list[uuid.UUID] = []
    try:
        async with AsyncExitStack() as stack:
            actors = await _actors(stack, ("admin",))
            user_ids = actors.user_ids
            created, _ = await _new_venue(actors.clients[0], "Не демо")
            async with SessionFactory() as session:
                with pytest.raises(NotDemoVenue):
                    await seed_demo_events(session, uuid.UUID(created["venue_id"]))
        async with SessionFactory() as session:
            result = await seed_demo(session, get_settings(), replace_existing=True)
            assert result.venue_id is not None
            count = await seed_demo_events(session, result.venue_id, days=7)
            await session.commit()
            assert count > 0
            points = (await session.scalars(select(Restaurant).where(
                Restaurant.venue_id == result.venue_id
            ))).all()
            report = await build_report(session, list(points), "7d", datetime.now(UTC))
            assert report["synthetic"] is True and report["has_data"] is True
            assert report["empty_searches"]
            again = await seed_demo_events(session, result.venue_id, days=7)
            await session.commit()
            stored = len((await session.scalars(select(AnalyticsEvent.id).where(
                AnalyticsEvent.venue_id == result.venue_id
            ))).all())
            assert stored == again
    finally:
        await _cleanup(user_ids)


@pytest.mark.asyncio
async def test_admin_events_accepted_for_unpublished_point_with_admin() -> None:
    """Admin events from a venue admin should be accepted for unpublished points (P1-TASK-65)."""
    user_ids: list[uuid.UUID] = []
    try:
        async with AsyncExitStack() as stack:
            actors = await _actors(stack, ("admin", "guest"))
            user_ids = actors.user_ids
            admin, guest = actors.clients
            point, menu_id = await _new_venue(admin, "Кофейня Админ События")
            # Don't publish the menu
            public_id = point["public_id"]

            # Admin event from admin should be accepted for unpublished point
            admin_batch = _batch(public_id, [_event("venue_created")])
            response = await admin.post(f"{API}/events", json=admin_batch)
            assert response.status_code == 200, "admin event from admin should be accepted"
            result = response.json()
            assert result["accepted"] == 1

            # Verify event was stored
            async with SessionFactory() as session:
                stored = (await session.scalars(select(AnalyticsEvent).where(
                    AnalyticsEvent.point_id == uuid.UUID(point["id"]),
                    AnalyticsEvent.name == "venue_created"
                ))).all()
                assert len(stored) == 1, "venue_created should be stored"

            # Guest event should still be rejected for unpublished point
            guest_batch = _batch(public_id, [_event("menu_view")])
            response = await guest.post(f"{API}/events", json=guest_batch)
            msg = "guest event should be rejected for unpublished point"
            assert response.status_code == 404, msg
    finally:
        await _cleanup(user_ids)
