import os
import uuid

import httpx
import pytest
from sqlalchemy import delete, func, select

from app.config import Settings
from app.database import SessionFactory
from app.demo_seed import seed_demo
from app.main import app
from app.models import ImportJob, Menu, MenuVersion, Restaurant, User

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_DB_INTEGRATION") != "1",
    reason="requires the migrated PostgreSQL integration database",
)


@pytest.mark.asyncio
async def test_demo_seed_is_idempotent_and_public() -> None:
    marker = uuid.uuid4().hex
    max_user_id = 7_000_000_000 + uuid.uuid4().int % 1_000_000_000
    public_id = f"demo-{marker[:10]}"
    user_id: uuid.UUID | None = None
    restaurant_id: uuid.UUID | None = None
    settings = Settings(
        _env_file=None,
        dev_max_user_id=max_user_id,
        public_app_url="http://test",
    )

    try:
        async with SessionFactory() as session:
            first = await seed_demo(session, settings, public_id=public_id)
            user_id = await session.scalar(
                select(User.id).where(User.max_user_id == max_user_id)
            )
            restaurant_id = first.restaurant_id
            menu_id = await session.scalar(
                select(Menu.id).where(Menu.restaurant_id == restaurant_id)
            )
            first_version_count = await session.scalar(
                select(func.count(MenuVersion.id)).where(MenuVersion.menu_id == menu_id)
            )
            assert first.menu_changed is True
            assert first.site_changed is True

            second = await seed_demo(session, settings, public_id=public_id)
            second_version_count = await session.scalar(
                select(func.count(MenuVersion.id)).where(MenuVersion.menu_id == menu_id)
            )
            fake_import_count = await session.scalar(
                select(func.count(ImportJob.id)).where(ImportJob.restaurant_id == restaurant_id)
            )

            assert second.restaurant_id == first.restaurant_id
            assert second.menu_version == first.menu_version
            assert second.menu_changed is False
            assert second.site_changed is False
            assert second_version_count == first_version_count
            assert fake_import_count == 0

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"/api/v1/public/restaurants/{public_id}/menu")
        assert response.status_code == 200
        payload = response.json()
        assert payload["restaurant"]["name"] == "Север — городское бистро"
        assert payload["site"]["template"] == "classic"
        assert len(payload["sections"]) == 4
        assert sum(len(section["items"]) for section in payload["sections"]) == 10
        assert any(
            not item["is_available"]
            for section in payload["sections"]
            for item in section["items"]
        )
    finally:
        async with SessionFactory() as session:
            if restaurant_id is not None:
                await session.execute(delete(Restaurant).where(Restaurant.id == restaurant_id))
                await session.commit()
            if user_id is not None:
                await session.execute(delete(User).where(User.id == user_id))
                await session.commit()
