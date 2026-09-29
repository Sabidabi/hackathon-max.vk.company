"""One admin role: equal rights, a protected creator and a venue that never loses its last admin."""

import os
import uuid
from contextlib import AsyncExitStack

import httpx
import pytest
from sqlalchemy import delete

from app.api.routes.team import CREATOR_LEAVE_DETAIL, CREATOR_REMOVE_DETAIL, LAST_ADMIN_DETAIL
from app.auth.service import create_auth_session
from app.database import SessionFactory
from app.main import app
from app.models import User, Venue

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_DB_INTEGRATION") != "1",
    reason="requires the migrated PostgreSQL integration database",
)

LABELS = ("creator", "second-admin", "third-admin", "stranger")


async def _make_users() -> tuple[list[uuid.UUID], list[int], list[str]]:
    async with SessionFactory() as session:
        users = [User(
            max_user_id=6_000_000_000 + uuid.uuid4().int % 1_000_000_000,
            display_name=f"roles-{label}",
            first_name=label,
        ) for label in LABELS]
        session.add_all(users)
        await session.flush()
        ids = [user.id for user in users]
        max_ids = [user.max_user_id for user in users]
        tokens = [(await create_auth_session(session, user.id, 300))[0] for user in users]
    return ids, max_ids, tokens


async def _cleanup(user_ids: list[uuid.UUID]) -> None:
    async with SessionFactory() as session:
        await session.execute(delete(Venue).where(Venue.created_by_id.in_(user_ids)))
        for user_id in user_ids:
            user = await session.get(User, user_id)
            if user is not None:
                await session.delete(user)
        await session.commit()


async def _invite_and_accept(
    inviter: httpx.AsyncClient, invitee: httpx.AsyncClient, venue: str, max_user_id: int
) -> None:
    created = await inviter.post(
        f"/api/v1/restaurants/{venue}/invites", json={"max_user_id": max_user_id}
    )
    assert created.status_code == 201, created.text
    assert created.json()["role"] == "admin"
    link = created.json()["invite_url"]
    token = link.split("inv_")[-1] if "inv_" in link else link.rsplit("/", 1)[-1]
    accepted = await invitee.post("/api/v1/invites/accept", json={"token": token})
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["role"] == "admin"


@pytest.mark.asyncio
async def test_admins_are_equal_but_creator_and_last_admin_are_protected() -> None:
    user_ids: list[uuid.UUID] = []
    try:
        user_ids, max_ids, tokens = await _make_users()
        transport = httpx.ASGITransport(app=app)
        async with AsyncExitStack() as stack:
            creator, second, third, stranger = [
                await stack.enter_async_context(httpx.AsyncClient(
                    transport=transport, base_url="http://test",
                    cookies={"menu_session": token},
                ))
                for token in tokens
            ]
            created = await creator.post("/api/v1/restaurants", json={"name": "Кофейня Север"})
            assert created.status_code == 201, created.text
            venue = created.json()["id"]
            assert created.json()["role"] == "admin"
            assert created.json()["is_creator"] is True

            leave_url = f"/api/v1/restaurants/{venue}/leave"
            lonely = await creator.post(leave_url)
            assert lonely.status_code == 409
            assert lonely.json()["detail"] == LAST_ADMIN_DETAIL

            await _invite_and_accept(creator, second, venue, max_ids[1])
            await _invite_and_accept(second, third, venue, max_ids[2])

            members = (await second.get(f"/api/v1/restaurants/{venue}/members")).json()
            assert [m["is_creator"] for m in members] == [True, False, False]
            assert {m["role"] for m in members} == {"admin"}
            second_view = (await second.get(f"/api/v1/restaurants/{venue}")).json()
            assert second_view["role"] == "admin" and second_view["is_creator"] is False

            # Any admin publishes: rights are no longer split between owner/manager/editor.
            draft_url = f"/api/v1/restaurants/{venue}/menu/draft"
            draft = (await second.get(draft_url)).json()
            saved = await second.put(draft_url, json={
                "expected_revision": draft["revision"],
                "sections": [{"name": "Кофе", "items": [{
                    "name": "Раф", "price_minor": 31000, "is_available": True,
                }]}],
            })
            assert saved.status_code == 200, saved.text
            published = await second.post(f"/api/v1/restaurants/{venue}/menu/publish", json={
                "expected_revision": saved.json()["revision"],
            })
            assert published.status_code == 200, published.text
            renamed = await third.patch(f"/api/v1/restaurants/{venue}", json={"name": "Север"})
            assert renamed.status_code == 200, renamed.text

            # A stranger sees nothing of the cabinet.
            for method, path in (
                ("GET", f"/api/v1/restaurants/{venue}"),
                ("GET", f"/api/v1/restaurants/{venue}/members"),
                ("GET", draft_url),
                ("POST", f"/api/v1/restaurants/{venue}/invites"),
                ("POST", leave_url),
                ("DELETE", f"/api/v1/restaurants/{venue}/members/{user_ids[1]}"),
            ):
                body = {"max_user_id": max_ids[3]} if path.endswith("/invites") else None
                response = await stranger.request(method, path, json=body)
                assert response.status_code == 404, (method, path, response.text)
            assert (await stranger.get("/api/v1/restaurants")).json() == []

            creator_url = f"/api/v1/restaurants/{venue}/members/{user_ids[0]}"
            removal = await second.delete(creator_url)
            assert removal.status_code == 403
            assert removal.json()["detail"] == CREATOR_REMOVE_DETAIL
            creator_leave = await creator.post(leave_url)
            assert creator_leave.status_code == 409
            assert creator_leave.json()["detail"] == CREATOR_LEAVE_DETAIL

            removed = await second.delete(f"/api/v1/restaurants/{venue}/members/{user_ids[2]}")
            assert removed.status_code == 204
            assert (await third.get(draft_url)).status_code == 404
            assert (await third.get("/api/v1/restaurants")).json() == []

            assert (await second.post(leave_url)).status_code == 204
            assert (await second.get(draft_url)).status_code == 404
            last = await creator.post(leave_url)
            assert last.status_code == 409
            assert last.json()["detail"] == LAST_ADMIN_DETAIL
            remaining = (await creator.get(f"/api/v1/restaurants/{venue}/members")).json()
            assert [m["user_id"] for m in remaining] == [str(user_ids[0])]
    finally:
        await _cleanup(user_ids)
