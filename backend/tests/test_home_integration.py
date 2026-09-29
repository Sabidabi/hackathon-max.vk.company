"""Home screen API: only the caller's venues, recent visits and favorites."""

import os
import uuid
from contextlib import AsyncExitStack
from datetime import UTC, datetime

import httpx
import pytest
from sqlalchemy import delete, event, select

from app.api.routes.me import RECENT_LIMIT
from app.auth.service import create_auth_session
from app.database import SessionFactory, engine
from app.main import app
from app.models import RestaurantVisit, User, Venue

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_DB_INTEGRATION") != "1",
    reason="requires the migrated PostgreSQL integration database",
)


async def _publish_menu(client: httpx.AsyncClient, restaurant_id: str) -> None:
    draft_url = f"/api/v1/restaurants/{restaurant_id}/menu/draft"
    draft = (await client.get(draft_url)).json()
    saved = await client.put(draft_url, json={
        "expected_revision": draft["revision"],
        "sections": [{"name": "Кофе", "items": [
            {"name": "Латте", "price_minor": 25000, "is_available": True},
        ]}],
    })
    assert saved.status_code == 200, saved.text
    published = await client.post(f"/api/v1/restaurants/{restaurant_id}/menu/publish", json={
        "expected_revision": saved.json()["revision"],
    })
    assert published.status_code == 200, published.text


@pytest.mark.asyncio
async def test_home_lists_are_scoped_to_the_current_user() -> None:
    user_ids: list[uuid.UUID] = []
    try:
        async with SessionFactory() as session:
            users = [User(
                max_user_id=4_000_000_000 + uuid.uuid4().int % 1_000_000_000,
                display_name=f"home-{label}",
                first_name=label,
            ) for label in ("admin", "guest")]
            session.add_all(users)
            await session.flush()
            user_ids = [user.id for user in users]
            tokens = [(await create_auth_session(session, user.id, 300))[0] for user in users]

        transport = httpx.ASGITransport(app=app)
        async with AsyncExitStack() as stack:
            anonymous = await stack.enter_async_context(
                httpx.AsyncClient(transport=transport, base_url="http://test")
            )
            admin, guest = [
                await stack.enter_async_context(httpx.AsyncClient(
                    transport=transport, base_url="http://test",
                    cookies={"menu_session": token},
                ))
                for token in tokens
            ]
            assert (await anonymous.get("/api/v1/me/home")).status_code == 401
            assert (await anonymous.post(
                "/api/v1/me/recent", json={"public_id": "demo"}
            )).status_code == 401

            empty = await guest.get("/api/v1/me/home")
            assert empty.status_code == 200, empty.text
            assert empty.json() == {
                "display_name": "home-guest",
                "first_name": "guest",
                "is_admin": False,
                "admin_venues": [],
                "recent": [],
                "favorites": [],
            }
            me = (await guest.get("/api/v1/me")).json()
            assert me["is_admin"] is False and me["admin_restaurant_ids"] == []

            venue = (await admin.post(
                "/api/v1/restaurants", json={"name": "Кофейня Север", "address": "Ленина, 1"}
            )).json()
            draft_url = f"/api/v1/restaurants/{venue['id']}/menu/draft"
            draft = (await admin.get(draft_url)).json()
            saved = (await admin.put(draft_url, json={
                "expected_revision": draft["revision"],
                "sections": [{"name": "Кофе", "items": [
                    {"name": "Латте", "price_minor": 25000, "is_available": True},
                    {"name": "Раф", "price_minor": 31000, "is_available": True},
                ]}],
            })).json()

            home = (await admin.get("/api/v1/me/home")).json()
            assert home["is_admin"] is True
            [card] = home["admin_venues"]
            assert card["id"] == venue["id"] and card["is_creator"] is True
            assert card["has_published_menu"] is False and card["unpublished_changes"] == 2
            assert card["points"] == [{
                "id": venue["id"], "public_id": venue["public_id"],
                "name": "Кофейня Север", "address": "Ленина, 1",
            }]
            me = (await admin.get("/api/v1/me")).json()
            assert me["is_admin"] is True and me["admin_restaurant_ids"] == [venue["id"]]

            published = await admin.post(f"/api/v1/restaurants/{venue['id']}/menu/publish", json={
                "expected_revision": saved["revision"],
            })
            assert published.status_code == 200, published.text
            card = (await admin.get("/api/v1/me/home")).json()["admin_venues"][0]
            assert card["has_published_menu"] is True and card["unpublished_changes"] == 0
            current = (await admin.get(draft_url)).json()
            edited = await admin.put(draft_url, json={
                "expected_revision": current["revision"],
                "sections": [{"name": "Кофе", "items": [
                    {"name": "Латте", "price_minor": 26000, "is_available": True},
                    {"name": "Раф", "price_minor": 31000, "is_available": True},
                ]}],
            })
            assert edited.status_code == 200, edited.text
            card = (await admin.get("/api/v1/me/home")).json()["admin_venues"][0]
            assert card["unpublished_changes"] == 1

            # A guest's history and favorites never leak to another user, and vice versa.
            public_id = venue["public_id"]
            assert (await guest.post(
                "/api/v1/me/recent", json={"public_id": public_id}
            )).status_code == 204
            favorite = await guest.put(
                f"/api/v1/public/restaurants/{public_id}/favorite",
                json={"is_favorite": True, "notifications_enabled": True},
            )
            assert favorite.status_code == 200, favorite.text
            guest_home = (await guest.get("/api/v1/me/home")).json()
            assert guest_home["admin_venues"] == [] and guest_home["is_admin"] is False
            assert [v["public_id"] for v in guest_home["recent"]] == [public_id]
            assert guest_home["favorites"] == [{
                "public_id": public_id, "name": "Кофейня Север",
                "address": "Ленина, 1", "notifications_enabled": True,
            }]
            admin_home = (await admin.get("/api/v1/me/home")).json()
            assert admin_home["recent"] == [] and admin_home["favorites"] == []

            assert (await guest.post(
                "/api/v1/me/recent", json={"public_id": "no-such-venue"}
            )).status_code == 404

            # An unpublished venue does not exist for guests: no visit, no name or address leak.
            hidden = (await admin.post(
                "/api/v1/restaurants", json={"name": "Скрытая точка", "address": "Тайная, 7"}
            )).json()
            refused = await guest.post("/api/v1/me/recent", json={"public_id": hidden["public_id"]})
            assert refused.status_code == 404
            assert (await guest.get(
                f"/api/v1/public/restaurants/{hidden['public_id']}/menu"
            )).status_code == 404
            async with SessionFactory() as session:
                assert await session.scalar(select(RestaurantVisit.user_id).where(
                    RestaurantVisit.restaurant_id == uuid.UUID(hidden["id"])
                )) is None
                # Even a visit stored before the venue was hidden is not listed.
                session.add(RestaurantVisit(
                    user_id=user_ids[1], restaurant_id=uuid.UUID(hidden["id"]),
                    last_opened_at=datetime.now(UTC),
                ))
                await session.commit()
            listed = (await guest.get("/api/v1/me/home")).json()["recent"]
            assert [v["public_id"] for v in listed] == [public_id]

            # Recent keeps the latest ten; reopening moves a venue to the top.
            extra = []
            for index in range(RECENT_LIMIT + 1):
                created = await admin.post("/api/v1/restaurants", json={"name": f"Точка {index}"})
                await _publish_menu(admin, created.json()["id"])
                extra.append(created.json()["public_id"])
                assert (await guest.post(
                    "/api/v1/me/recent", json={"public_id": extra[-1]}
                )).status_code == 204
            recent = [v["public_id"] for v in (await guest.get("/api/v1/me/home")).json()["recent"]]
            assert recent == list(reversed(extra))[:RECENT_LIMIT]
            assert public_id not in recent
            await guest.post("/api/v1/me/recent", json={"public_id": extra[1]})
            recent = [v["public_id"] for v in (await guest.get("/api/v1/me/home")).json()["recent"]]
            assert recent[0] == extra[1] and len(recent) == RECENT_LIMIT
    finally:
        async with SessionFactory() as session:
            await session.execute(delete(Venue).where(Venue.created_by_id.in_(user_ids)))
            for user_id in user_ids:
                user = await session.get(User, user_id)
                if user is not None:
                    await session.delete(user)
            await session.commit()


@pytest.mark.asyncio
async def test_home_query_count_does_not_grow_with_venues() -> None:
    """1 and 5 venues (each with a published menu, an edited draft and a site) cost the
    same number of SQL statements: no per-venue queries on the first screen."""
    user_ids: list[uuid.UUID] = []
    statements: list[str] = []

    def count(conn, cursor, statement, parameters, context, executemany) -> None:  # noqa: ANN001
        statements.append(statement)

    try:
        async with SessionFactory() as session:
            users = [User(
                max_user_id=4_000_000_000 + uuid.uuid4().int % 1_000_000_000,
                display_name=f"home-count-{label}",
                first_name=label,
            ) for label in ("one", "five")]
            session.add_all(users)
            await session.flush()
            user_ids = [user.id for user in users]
            tokens = [(await create_auth_session(session, user.id, 300))[0] for user in users]

        transport = httpx.ASGITransport(app=app)
        counts = []
        async with AsyncExitStack() as stack:
            clients = [
                await stack.enter_async_context(httpx.AsyncClient(
                    transport=transport, base_url="http://test",
                    cookies={"menu_session": token},
                ))
                for token in tokens
            ]
            for client, venues in zip(clients, (1, 5), strict=True):
                for index in range(venues):
                    venue = (await client.post(
                        "/api/v1/restaurants", json={"name": f"Точка {index}"}
                    )).json()
                    await _publish_menu(client, venue["id"])
                    draft_url = f"/api/v1/restaurants/{venue['id']}/menu/draft"
                    draft = (await client.get(draft_url)).json()
                    assert (await client.put(draft_url, json={
                        "expected_revision": draft["revision"],
                        "sections": [{"name": "Кофе", "items": [
                            {"name": "Латте", "price_minor": 27000, "is_available": True},
                        ]}],
                    })).status_code == 200
                    site = (await client.get(
                        f"/api/v1/restaurants/{venue['id']}/site/draft"
                    )).json()
                    assert (await client.post(
                        f"/api/v1/restaurants/{venue['id']}/site/publish",
                        json={"expected_revision": site["revision"]},
                    )).status_code == 200
                await client.get("/api/v1/me/home")  # warm up connection-level setup
                statements.clear()
                event.listen(engine.sync_engine, "before_cursor_execute", count)
                try:
                    home = await client.get("/api/v1/me/home")
                finally:
                    event.remove(engine.sync_engine, "before_cursor_execute", count)
                assert home.status_code == 200, home.text
                cards = home.json()["admin_venues"]
                assert len(cards) == venues
                assert all(card["unpublished_changes"] == 1 for card in cards)
                assert all(card["has_published_menu"] for card in cards)
                counts.append(len(statements))
        assert counts[0] == counts[1], counts
    finally:
        async with SessionFactory() as session:
            await session.execute(delete(Venue).where(Venue.created_by_id.in_(user_ids)))
            for user_id in user_ids:
                user = await session.get(User, user_id)
                if user is not None:
                    await session.delete(user)
            await session.commit()
