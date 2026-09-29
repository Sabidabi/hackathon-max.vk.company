"""Shared HTTP helpers for the venue library integration tests (not a test module)."""

import uuid
from contextlib import AsyncExitStack

import httpx
from sqlalchemy import delete

from app.auth.service import create_auth_session
from app.database import SessionFactory
from app.main import app
from app.models import User, Venue

API = "/api/v1"


class Actors:
    def __init__(self, user_ids: list[uuid.UUID], clients: list[httpx.AsyncClient]):
        self.user_ids = user_ids
        self.clients = clients


async def _actors(stack: AsyncExitStack, labels: tuple[str, ...]) -> Actors:
    async with SessionFactory() as session:
        users = [User(
            max_user_id=6_000_000_000 + uuid.uuid4().int % 1_000_000_000,
            display_name=f"library-{label}",
            first_name=label,
        ) for label in labels]
        session.add_all(users)
        await session.flush()
        user_ids = [user.id for user in users]
        tokens = [(await create_auth_session(session, user.id, 300))[0] for user in users]
    transport = httpx.ASGITransport(app=app)
    clients = [
        await stack.enter_async_context(httpx.AsyncClient(
            transport=transport, base_url="http://test", cookies={"menu_session": token},
        ))
        for token in tokens
    ]
    return Actors(user_ids, clients)


async def _cleanup(user_ids: list[uuid.UUID]) -> None:
    async with SessionFactory() as session:
        await session.execute(delete(Venue).where(Venue.created_by_id.in_(user_ids)))
        await session.execute(delete(User).where(User.id.in_(user_ids)))
        await session.commit()


def _ok(response: httpx.Response, code: int = 200) -> dict:
    assert response.status_code == code, response.text
    return response.json()


async def _new_venue(client: httpx.AsyncClient, name: str) -> tuple[dict, str]:
    """A venue with its first point; returns the point and the «Основное» menu ID."""
    point = _ok(await client.post(f"{API}/restaurants", json={"name": name}), 201)
    return point, point["menu_id"]


async def _save_draft(client: httpx.AsyncClient, menu_id: str, sections: list[dict]) -> dict:
    draft = _ok(await client.get(f"{API}/menus/{menu_id}/draft"))
    return _ok(await client.put(f"{API}/menus/{menu_id}/draft", json={
        "expected_revision": draft["revision"], "sections": sections,
    }))


async def _publish(client: httpx.AsyncClient, menu_id: str, point_ids: list[str]) -> dict:
    draft = _ok(await client.get(f"{API}/menus/{menu_id}/draft"))
    return _ok(await client.post(f"{API}/menus/{menu_id}/publish", json={
        "expected_revision": draft["revision"], "point_ids": point_ids,
    }))


async def _assign(client: httpx.AsyncClient, point_id: str, assignments: list[dict]) -> dict:
    current = _ok(await client.get(f"{API}/points/{point_id}/menus"))
    return _ok(await client.put(f"{API}/points/{point_id}/menus", json={
        "expected_revision": current["revision"], "assignments": assignments,
    }))


async def _public(client: httpx.AsyncClient, public_id: str) -> dict:
    return _ok(await client.get(f"{API}/public/restaurants/{public_id}/menu"))


def _items(public_menu: dict) -> dict[str, dict]:
    return {
        item["name"]: item
        for tab in public_menu["menus"]
        for section in tab["sections"]
        for item in section["items"]
    }


BASIC_MENU = [{"name": "Кофе", "items": [
    {"name": "Латте", "price_minor": 19000, "is_available": True},
    {"name": "Круассан", "price_minor": 15000, "is_available": True},
]}]
