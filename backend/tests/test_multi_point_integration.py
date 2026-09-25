"""Tenant boundaries for multiple points, menu copies and MAX team invites."""

import os
import uuid

import httpx
import pytest
from sqlalchemy import delete

from app.auth.service import create_auth_session
from app.database import SessionFactory
from app.main import app
from app.models import Restaurant, User

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_DB_INTEGRATION") != "1",
    reason="requires the migrated PostgreSQL integration database",
)


@pytest.mark.asyncio
async def test_multiple_points_copy_and_targeted_invite() -> None:
    owner_id = invited_id = other_id = None
    try:
        async with SessionFactory() as session:
            users = [User(
                max_user_id=9_000_000_000 + uuid.uuid4().int % 1_000_000_000,
                display_name=label,
                first_name=label,
            ) for label in ("owner-test", "invited-test", "other-test")]
            session.add_all(users)
            await session.flush()
            owner_id, invited_id, other_id = (user.id for user in users)
            owner_max_id, invited_max_id = users[0].max_user_id, users[1].max_user_id
            tokens = [(await create_auth_session(session, user.id, 300))[0] for user in users]

        transport = httpx.ASGITransport(app=app)
        clients = [httpx.AsyncClient(
            transport=transport, base_url="http://test", cookies={"menu_session": token}
        ) for token in tokens]
        async with clients[0] as owner, clients[1] as invited, clients[2] as other:
            point_ids = []
            for label in ("Точка 1", "Точка 2"):
                created = await owner.post("/api/v1/restaurants", json={
                    "name": label, "description": None, "address": None,
                })
                assert created.status_code == 201, created.text
                point_ids.append(created.json()["id"])
            first, second = point_ids
            assert len((await owner.get("/api/v1/restaurants")).json()) == 2
            assert (await invited.get("/api/v1/restaurants")).json() == []

            first_draft = f"/api/v1/restaurants/{first}/menu/draft"
            current = (await owner.get(first_draft)).json()
            saved = await owner.put(first_draft, json={
                "expected_revision": current["revision"],
                "sections": [{"name": "Кофе", "items": [{
                    "name": "Капучино", "price_minor": 29000, "is_available": True,
                }]}],
            })
            assert saved.status_code == 200, saved.text
            published = await owner.post(f"/api/v1/restaurants/{first}/menu/publish", json={
                "expected_revision": saved.json()["revision"],
            })
            assert published.status_code == 200, published.text
            library = (await owner.get("/api/v1/menu/library")).json()
            assert library[0]["restaurant_id"] == first
            assert (await invited.get("/api/v1/menu/library")).json() == []

            target_draft = (await owner.get(f"/api/v1/restaurants/{second}/menu/draft")).json()
            copy_payload = {
                "source_version_id": library[0]["version_id"],
                "expected_revision": target_draft["revision"],
            }
            copy_url = f"/api/v1/restaurants/{second}/menu/copy"
            assert (await invited.post(copy_url, json=copy_payload)).status_code == 404
            copied = await owner.post(copy_url, json=copy_payload)
            assert copied.status_code == 200, copied.text
            assert copied.json()["sections"][0]["items"][0]["name"] == "Капучино"
            assert (await owner.post(copy_url, json=copy_payload)).status_code == 409
            second_draft = (await owner.get(f"/api/v1/restaurants/{second}/menu/draft")).json()
            assert second_draft["revision"] == copied.json()["revision"]

            source_now = (await owner.get(first_draft)).json()
            bulk_url = f"/api/v1/restaurants/{first}/menu/availability/bulk"
            bulk_payload = {
                "source_item_id": source_now["sections"][0]["items"][0]["id"],
                "source_expected_revision": source_now["revision"],
                "is_available": False,
                "targets": [
                    {"restaurant_id": first, "expected_revision": source_now["revision"]},
                    {"restaurant_id": second, "expected_revision": copied.json()["revision"]},
                ],
            }
            assert (await invited.post(bulk_url, json=bulk_payload)).status_code == 404
            changed = await owner.post(bulk_url, json=bulk_payload)
            assert changed.status_code == 200, changed.text
            assert len(changed.json()) == 2
            assert (await owner.post(bulk_url, json=bulk_payload)).status_code == 409
            for point in (first, second):
                draft = (await owner.get(f"/api/v1/restaurants/{point}/menu/draft")).json()
                assert draft["sections"][0]["items"][0]["is_available"] is False

            invite_url = f"/api/v1/restaurants/{second}/invites"
            assert (await invited.post(invite_url, json={
                "max_user_id": owner_max_id, "role": "editor",
            })).status_code == 404
            created_invite = await owner.post(invite_url, json={
                "max_user_id": invited_max_id, "role": "editor",
            })
            assert created_invite.status_code == 201, created_invite.text
            link = created_invite.json()["invite_url"]
            token = link.split("inv_")[-1] if "inv_" in link else link.rsplit("/", 1)[-1]
            accept_path = "/api/v1/invites/accept"
            assert (await other.post(accept_path, json={"token": token})).status_code == 403
            accepted = await invited.post(accept_path, json={"token": token})
            assert accepted.status_code == 200, accepted.text
            assert accepted.json()["role"] == "editor"
            assert (await invited.post(accept_path, json={"token": token})).status_code == 404
            invited_points = (await invited.get("/api/v1/restaurants")).json()
            assert [point["id"] for point in invited_points] == [second]
            assert (await invited.get(first_draft)).status_code == 404
            assert (await invited.post(copy_url, json={
                "source_version_id": library[0]["version_id"],
                "expected_revision": copied.json()["revision"],
            })).status_code == 404
            assert (await owner.delete(
                f"/api/v1/restaurants/{second}/members/{invited_id}"
            )).status_code == 204
            revoked_draft = await invited.get(f"/api/v1/restaurants/{second}/menu/draft")
            assert revoked_draft.status_code == 404
    finally:
        async with SessionFactory() as session:
            if owner_id is not None:
                await session.execute(delete(Restaurant).where(Restaurant.owner_id == owner_id))
            for user_id in (owner_id, invited_id, other_id):
                if user_id is not None:
                    user = await session.get(User, user_id)
                    if user is not None:
                        await session.delete(user)
            await session.commit()
