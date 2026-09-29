"""Admin invitation by a one-time link: no MAX ID, 24 h, hash-only storage, clear errors."""

import hashlib
import os
import uuid
from contextlib import AsyncExitStack
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import delete, select

from app.api.routes import team
from app.auth.service import create_auth_session
from app.database import SessionFactory
from app.main import app
from app.models import Restaurant, RestaurantInvite, User, Venue, VenueMember

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_DB_INTEGRATION") != "1",
    reason="requires the migrated PostgreSQL integration database",
)

LABELS = ("creator", "invitee", "late-comer", "stranger")


def _token(created: httpx.Response) -> str:
    return created.json()["web_url"].rsplit("/invite/", 1)[-1]


@pytest.mark.asyncio
async def test_link_invite_lifecycle(monkeypatch: pytest.MonkeyPatch) -> None:
    user_ids: list[uuid.UUID] = []
    try:
        async with SessionFactory() as session:
            users = [User(
                max_user_id=5_000_000_000 + uuid.uuid4().int % 1_000_000_000,
                display_name=f"invite-{label}",
                first_name=label,
            ) for label in LABELS]
            session.add_all(users)
            await session.flush()
            user_ids = [user.id for user in users]
            tokens = [(await create_auth_session(session, user.id, 300))[0] for user in users]

        transport = httpx.ASGITransport(app=app)
        async with AsyncExitStack() as stack:
            anonymous = await stack.enter_async_context(
                httpx.AsyncClient(transport=transport, base_url="http://test")
            )
            creator, invitee, late, stranger = [
                await stack.enter_async_context(httpx.AsyncClient(
                    transport=transport, base_url="http://test",
                    cookies={"menu_session": token},
                ))
                for token in tokens
            ]
            venue = (await creator.post(
                "/api/v1/restaurants", json={"name": "Кофейня Север"}
            )).json()["id"]
            invites_url = f"/api/v1/restaurants/{venue}/invites"

            assert (await stranger.post(invites_url)).status_code == 404

            created = await creator.post(invites_url)  # no body, no MAX ID
            assert created.status_code == 201, created.text
            body = created.json()
            assert body["max_user_id"] is None and body["role"] == "admin"
            assert body["invited_by"] == "invite-creator"
            expires_at = datetime.fromisoformat(body["expires_at"])
            assert timedelta(hours=23) < expires_at - datetime.now(UTC) <= timedelta(hours=24)
            token = _token(created)
            if body["max_deep_link"] is not None:
                assert body["max_deep_link"].endswith(f"startapp=inv_{token}")
                assert body["invite_url"] == body["max_deep_link"]
            else:
                assert body["invite_url"] == body["web_url"]

            async with SessionFactory() as session:
                stored = await session.get(RestaurantInvite, uuid.UUID(body["id"]))
                assert stored is not None
                assert stored.token_hash == hashlib.sha256(token.encode()).hexdigest()
                assert token not in {str(value) for value in vars(stored).values()}

            preview_url = f"/api/v1/invites/{token}/preview"
            assert (await anonymous.get(preview_url)).status_code == 401
            preview = await invitee.get(preview_url)
            assert preview.status_code == 200, preview.text
            assert preview.json() == {
                "restaurant_name": "Кофейня Север",
                "venue_name": "Кофейня Север",
                "invited_by": "invite-creator",
                "expires_at": preview.json()["expires_at"],
                "already_admin": False,
            }
            assert (await invitee.get(f"/api/v1/restaurants/{venue}")).status_code == 404

            # The creator opening their own link must not burn it.
            own = await creator.post(f"/api/v1/invites/{token}/accept")
            assert own.status_code == 409
            assert (await creator.get(preview_url)).json()["already_admin"] is True

            accepted = await invitee.post(f"/api/v1/invites/{token}/accept")
            assert accepted.status_code == 200, accepted.text
            assert accepted.json()["role"] == "admin"
            assert accepted.json()["is_creator"] is False
            assert (await invitee.get(f"/api/v1/restaurants/{venue}")).status_code == 200
            members = (await creator.get(f"/api/v1/restaurants/{venue}/members")).json()
            assert str(user_ids[1]) in {member["user_id"] for member in members}

            for response in (
                await late.post(f"/api/v1/invites/{token}/accept"),
                await late.get(preview_url),
                await late.post("/api/v1/invites/accept", json={"token": token}),
            ):
                assert response.status_code == 410
                assert response.json()["detail"] == team.INVALID_INVITE_DETAIL

            expired = await invitee.post(invites_url, json={})
            assert expired.status_code == 201
            async with SessionFactory() as session:
                row = await session.get(RestaurantInvite, uuid.UUID(expired.json()["id"]))
                row.expires_at = datetime.now(UTC) - timedelta(minutes=1)
                await session.commit()
            gone = await late.post(f"/api/v1/invites/{_token(expired)}/accept")
            assert gone.status_code == 410
            assert gone.json()["detail"] == team.INVALID_INVITE_DETAIL

            revoked = await creator.post(invites_url)
            assert (await creator.delete(
                f"{invites_url}/{revoked.json()['id']}"
            )).status_code == 204
            assert (await late.get(f"/api/v1/invites/{_token(revoked)}/preview")).status_code == 410

            unknown = await late.get(f"/api/v1/invites/{'x' * 43}/preview")
            assert unknown.status_code == 404
            assert unknown.json()["detail"] == team.INVALID_INVITE_DETAIL
            assert (await late.get("/api/v1/invites/short/preview")).status_code == 422

            # Legacy targeted invite still works and stays bound to its MAX account.
            async with SessionFactory() as session:
                late_max_id = (await session.get(User, user_ids[2])).max_user_id
            targeted = await creator.post(invites_url, json={
                "max_user_id": late_max_id, "role": "editor",
            })
            assert targeted.status_code == 201 and targeted.json()["role"] == "admin"
            targeted_accept = f"/api/v1/invites/{_token(targeted)}/accept"
            wrong = await stranger.post(targeted_accept)
            assert wrong.status_code == 403
            assert wrong.json()["detail"] == team.FOREIGN_INVITE_DETAIL
            assert (await late.post(targeted_accept)).status_code == 200

            async with SessionFactory() as session:
                recent = len((await session.scalars(select(RestaurantInvite.id).where(
                    RestaurantInvite.created_by_id == user_ids[0]
                ))).all())
            monkeypatch.setattr(team, "INVITE_RATE_LIMIT", recent + 1)
            assert (await creator.post(invites_url)).status_code == 201
            limited = await creator.post(invites_url)
            assert limited.status_code == 429
            assert limited.json()["detail"] == team.RATE_LIMIT_DETAIL
    finally:
        async with SessionFactory() as session:
            await session.execute(delete(Venue).where(Venue.created_by_id.in_(user_ids)))
            for user_id in user_ids:
                user = await session.get(User, user_id)
                if user is not None:
                    await session.delete(user)
            await session.commit()


@pytest.mark.asyncio
async def test_removed_or_departed_admin_cannot_return_through_own_links() -> None:
    """Links outlive their author's rights only until removal: removal and leaving revoke them,
    and accepting a link whose author is no longer an admin is refused even if it slipped by."""
    labels = ("creator", "removed", "departed", "friend", "outsider")
    user_ids: list[uuid.UUID] = []
    try:
        async with SessionFactory() as session:
            users = [User(
                max_user_id=5_000_000_000 + uuid.uuid4().int % 1_000_000_000,
                display_name=f"revoke-{label}",
                first_name=label,
            ) for label in labels]
            session.add_all(users)
            await session.flush()
            user_ids = [user.id for user in users]
            tokens = [(await create_auth_session(session, user.id, 300))[0] for user in users]

        transport = httpx.ASGITransport(app=app)
        async with AsyncExitStack() as stack:
            creator, removed, departed, friend, outsider = [
                await stack.enter_async_context(httpx.AsyncClient(
                    transport=transport, base_url="http://test",
                    cookies={"menu_session": token},
                ))
                for token in tokens
            ]
            venue = (await creator.post(
                "/api/v1/restaurants", json={"name": "Кофейня Юг"}
            )).json()["id"]
            venue_url = f"/api/v1/restaurants/{venue}"
            invites_url = f"{venue_url}/invites"

            for client in (removed, departed):
                link = _token(await creator.post(invites_url))
                assert (await client.post(f"/api/v1/invites/{link}/accept")).status_code == 200
                assert (await client.get(venue_url)).status_code == 200

            # Each future ex-admin prepares one link for themselves and one for a friend.
            removed_links = [_token(await removed.post(invites_url)) for _ in range(2)]
            departed_links = [_token(await departed.post(invites_url)) for _ in range(2)]
            creator_link = _token(await creator.post(invites_url))

            assert (await creator.delete(
                f"{venue_url}/members/{user_ids[1]}"
            )).status_code == 204
            assert (await departed.post(f"{venue_url}/leave")).status_code == 204

            for client, links in ((removed, removed_links), (departed, departed_links)):
                assert (await client.get(venue_url)).status_code == 404
                own, handed = links
                for who, token in ((client, own), (friend, handed)):
                    preview = await who.get(f"/api/v1/invites/{token}/preview")
                    assert preview.status_code == 410
                    refused = await who.post(f"/api/v1/invites/{token}/accept")
                    assert refused.status_code == 410
                    assert refused.json()["detail"] == team.INVALID_INVITE_DETAIL
                    legacy = await who.post("/api/v1/invites/accept", json={"token": token})
                    assert legacy.status_code == 410
                assert (await client.get(venue_url)).status_code == 404
                assert (await friend.get(venue_url)).status_code == 404

            async with SessionFactory() as session:
                stored = (await session.scalars(select(RestaurantInvite).where(
                    RestaurantInvite.restaurant_id == uuid.UUID(venue),
                    RestaurantInvite.created_by_id.in_(user_ids[1:3]),
                ))).all()
                # The two acceptance invites were created by the creator, not the ex-admins.
                assert len(stored) == 4
                assert all(
                    row.revoked_at is not None and row.accepted_at is None for row in stored
                )
                creator_invite = await session.scalar(select(RestaurantInvite).where(
                    RestaurantInvite.token_hash == hashlib.sha256(
                        creator_link.encode()
                    ).hexdigest()
                ))
                assert creator_invite is not None and creator_invite.revoked_at is None

            # The remaining admins' links are untouched by someone else's removal.
            assert (await friend.post(f"/api/v1/invites/{creator_link}/accept")).status_code == 200

            # Defence in depth: a link whose author lost membership without revocation.
            orphan = _token(await friend.post(invites_url))
            async with SessionFactory() as session:
                await session.execute(delete(VenueMember).where(
                    VenueMember.venue_id == select(Restaurant.venue_id).where(
                        Restaurant.id == uuid.UUID(venue)
                    ).scalar_subquery(),
                    VenueMember.user_id == user_ids[3],
                ))
                await session.commit()
            refused = await outsider.post(f"/api/v1/invites/{orphan}/accept")
            assert refused.status_code == 410
            assert refused.json()["detail"] == team.INVALID_INVITE_DETAIL
            assert (await outsider.get(venue_url)).status_code == 404
    finally:
        async with SessionFactory() as session:
            await session.execute(delete(Venue).where(Venue.created_by_id.in_(user_ids)))
            for user_id in user_ids:
                user = await session.get(User, user_id)
                if user is not None:
                    await session.delete(user)
            await session.commit()
