import os
import uuid

import httpx
import pytest
from sqlalchemy import delete, func, select

from app.api.routes import public_menu
from app.config import Settings
from app.database import SessionFactory
from app.demo_seed import seed_demo
from app.main import app
from app.models import ImportJob, MenuVersion, PointMenu, Restaurant, User, Venue

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_DB_INTEGRATION") != "1",
    reason="requires the migrated PostgreSQL integration database",
)


@pytest.mark.asyncio
async def test_demo_seed_is_idempotent_and_public(monkeypatch: pytest.MonkeyPatch) -> None:
    marker = uuid.uuid4().hex
    max_user_id = 7_000_000_000 + uuid.uuid4().int % 1_000_000_000
    public_id = f"demo-{marker[:10]}"
    monkeypatch.setattr(
        public_menu, "DEMO_PUBLIC_IDS", frozenset({public_id, f"{public_id}-park"})
    )
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
                select(PointMenu.menu_id).where(PointMenu.point_id == restaurant_id)
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
            park = await client.get(f"/api/v1/public/restaurants/{public_id}-park/menu")
        assert response.status_code == 200
        assert park.status_code == 200
        payload = response.json()
        assert payload["restaurant"]["name"] == "Север на Петровском"
        # The mark follows the fixed demo public IDs (patched to this run's IDs above).
        assert payload["restaurant"]["is_demo"] is True
        assert park.json()["restaurant"]["is_demo"] is True
        assert payload["site"]["template"] == "classic"
        main = payload["menus"][0]
        assert main["title"] == "Основное"
        items = {item["name"]: item for section in main["sections"] for item in section["items"]}
        latte = items["Латте"]["configuration"]
        assert [v["price_minor"] for v in latte["variants"]] == [19000, 23000]
        milk = next(g for g in latte["modifier_groups"] if g["name"] == "Молоко")
        assert milk["min_quantity"] == 1
        assert all(item["image_url"] is None for item in items.values()), "No stand-in photos"
        assert items["Круассан"]["is_available"] is True
        park_items = {
            item["name"]: item
            for menu in park.json()["menus"]
            for section in menu["sections"]
            for item in section["items"]
        }
        assert park_items["Круассан"]["is_available"] is False, "Stop-list of the second point"
        assert first.point_public_ids == (public_id, f"{public_id}-park")
    finally:
        async with SessionFactory() as session:
            if restaurant_id is not None:
                await session.execute(delete(Venue).where(
                    Venue.id == select(Restaurant.venue_id)
                    .where(Restaurant.id == restaurant_id)
                    .scalar_subquery()
                ))
                await session.commit()
            if user_id is not None:
                await session.execute(delete(User).where(User.id == user_id))
                await session.commit()


def test_demo_public_ids_are_the_seeded_points() -> None:
    assert public_menu.DEMO_PUBLIC_IDS == {"demo-sever", "demo-sever-park"}
