import io
import os
import uuid

import httpx
import pytest
from PIL import Image
from sqlalchemy import delete

from app.auth.service import create_auth_session
from app.config import get_settings
from app.database import SessionFactory
from app.main import app
from app.models import Menu, MenuVersion, Restaurant, RestaurantMember, User

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_DB_INTEGRATION") != "1",
    reason="requires the migrated PostgreSQL integration database",
)


@pytest.mark.asyncio
async def test_draft_publish_and_public_snapshot_flow() -> None:
    marker = uuid.uuid4().hex
    small_size_id = uuid.uuid4()
    large_size_id = uuid.uuid4()
    milk_group_id = uuid.uuid4()
    regular_milk_id = uuid.uuid4()
    oat_milk_id = uuid.uuid4()
    restaurant_id: uuid.UUID | None = None
    user_id: uuid.UUID | None = None
    stored_image_path = None

    try:
        async with SessionFactory() as session:
            user = User(
                max_user_id=8_000_000_000 + uuid.uuid4().int % 1_000_000_000,
                display_name="Menu integration test",
                first_name="Test",
            )
            session.add(user)
            await session.flush()
            user_id = user.id

            restaurant = Restaurant(
                public_id=marker[:12],
                owner_id=user.id,
                name="Тестовое кафе",
                address="Тестовая улица, 1",
            )
            session.add(restaurant)
            await session.flush()
            restaurant_id = restaurant.id
            session.add(
                RestaurantMember(
                    restaurant_id=restaurant.id,
                    user_id=user.id,
                    role="owner",
                )
            )
            menu = Menu(restaurant_id=restaurant.id)
            session.add(menu)
            await session.flush()
            session.add(
                MenuVersion(
                    menu_id=menu.id,
                    version=1,
                    status="draft",
                    created_by_id=user.id,
                )
            )
            await session.commit()
            token, _ = await create_auth_session(session, user.id, 300)

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://test",
            cookies={"menu_session": token},
        ) as client:
            source_image = io.BytesIO()
            Image.new("RGB", (1800, 1200), "tomato").save(source_image, format="PNG")
            media_url = f"/api/v1/restaurants/{restaurant_id}/menu/media"
            response = await client.post(
                media_url,
                files={"file": ("dish.png", source_image.getvalue(), "image/png")},
            )
            assert response.status_code == 201
            image_url = response.json()["url"]
            assert image_url.startswith(f"/media/menu-items/{restaurant_id}/")
            stored_image_path = get_settings().menu_images_dir / image_url.removeprefix("/media/")
            assert stored_image_path.is_file()

            draft_url = f"/api/v1/restaurants/{restaurant_id}/menu/draft"
            response = await client.put(
                draft_url,
                json={
                    "expected_revision": (await client.get(draft_url)).json()["revision"],
                    "sections": [
                        {
                            "name": "Завтраки",
                            "items": [
                                {
                                    "name": "Сырники",
                                    "description": "Со сметаной",
                                    "price_minor": 49000,
                                    "currency": "RUB",
                                    "weight_text": "220 г",
                                    "ingredients": None,
                                    "allergens": ["молоко"],
                                    "image_url": image_url,
                                    "is_available": True,
                                    "configuration": {
                                        "variants": [
                                            {
                                                "id": str(small_size_id),
                                                "name": "Маленькая",
                                                "price_minor": 49000,
                                                "is_available": True,
                                            },
                                            {
                                                "id": str(large_size_id),
                                                "name": "Большая",
                                                "price_minor": 59000,
                                                "is_available": True,
                                            },
                                        ],
                                        "default_variant_id": str(small_size_id),
                                        "modifier_groups": [
                                            {
                                                "id": str(milk_group_id),
                                                "name": "Соус",
                                                "min_quantity": 1,
                                                "max_quantity": 1,
                                                "options": [
                                                    {
                                                        "id": str(regular_milk_id),
                                                        "name": "Сметана",
                                                        "price_minor": 0,
                                                        "default_quantity": 1,
                                                    },
                                                    {
                                                        "id": str(oat_milk_id),
                                                        "name": "Варенье",
                                                        "price_minor": 5000,
                                                        "price_by_variant": {
                                                            str(large_size_id): 7000
                                                        },
                                                    },
                                                ],
                                            }
                                        ],
                                    },
                                }
                            ],
                        }
                    ],
                },
            )
            assert response.status_code == 200
            assert response.json()["sections"][0]["items"][0]["name"] == "Сырники"
            assert response.json()["sections"][0]["items"][0]["image_url"] == image_url
            site_url = f"/api/v1/restaurants/{restaurant_id}/site/draft"
            response = await client.put(
                site_url,
                json={
                    "expected_revision": (await client.get(site_url)).json()["revision"],
                    "template": "classic",
                    "primary_color": "#69492E",
                    "background_color": "#F7F1E7",
                    "tagline": "Завтраки весь день",
                    "about": "Тестовый сайт ресторана",
                    "phone": "+7 999 000-00-00",
                    "hours": "Ежедневно 09:00–22:00",
                    "booking_url": "https://example.com/reserve",
                    "blocks": [
                        {"kind": "hero", "visible": True, "title": None},
                        {"kind": "menu", "visible": True, "title": "Наше меню"},
                        {"kind": "about", "visible": True, "title": "О нас"},
                        {"kind": "contacts", "visible": True, "title": "Контакты"},
                    ],
                },
            )
            assert response.status_code == 200
            assert response.json()["config"]["template"] == "classic"

            publish_url = f"/api/v1/restaurants/{restaurant_id}/menu/publish"
            response = await client.post(
                publish_url,
                json={"expected_revision": (await client.get(draft_url)).json()["revision"]},
            )
            assert response.status_code == 200
            response = await client.post(
                f"/api/v1/restaurants/{restaurant_id}/site/publish",
                json={"expected_revision": (await client.get(site_url)).json()["revision"]},
            )
            assert response.status_code == 200
            assert response.json()["published_version"] == 1

            public_url = f"/api/v1/public/restaurants/{marker[:12]}/menu"
            response = await client.get(public_url)
            assert response.status_code == 200
            assert response.json()["version"] == 2
            assert response.json()["site"]["template"] == "classic"
            published_item_id = response.json()["sections"][0]["items"][0]["id"]

            response = await client.post(
                f"/api/v1/public/restaurants/{marker[:12]}/menu/quote",
                json={
                    "item_id": published_item_id,
                    "variant_id": str(large_size_id),
                    "modifiers": [{"option_id": str(oat_milk_id), "quantity": 1}],
                    "quantity": 2,
                },
            )
            assert response.status_code == 200
            assert response.json()["unit_price_minor"] == 66000
            assert response.json()["total_price_minor"] == 132000

            publish_url = f"/api/v1/restaurants/{restaurant_id}/menu/publish"
            response = await client.get(f"/api/v1/restaurants/{restaurant_id}/menu/qr")
            assert response.status_code == 200
            assert response.content.startswith(b"\x89PNG")

            response = await client.get(public_url)
            assert response.status_code == 200
            assert response.json()["sections"][0]["items"][0]["is_available"] is True
            assert response.json()["sections"][0]["items"][0]["image_url"] == image_url

            changed_payload = response.json()["sections"]
            changed_payload[0]["items"][0]["is_available"] = False
            response = await client.put(
                draft_url,
                json={
                    "sections": changed_payload,
                    "expected_revision": (await client.get(draft_url)).json()["revision"],
                },
            )
            assert response.status_code == 200

            response = await client.get(public_url)
            assert response.status_code == 200
            assert response.json()["sections"][0]["items"][0]["is_available"] is True

            response = await client.post(
                publish_url,
                json={"expected_revision": (await client.get(draft_url)).json()["revision"]},
            )
            assert response.status_code == 409

            response = await client.get(public_url)
            assert response.status_code == 200
            assert response.json()["sections"][0]["items"][0]["is_available"] is True
    finally:
        if stored_image_path is not None:
            stored_image_path.unlink(missing_ok=True)
        async with SessionFactory() as session:
            if restaurant_id is not None:
                await session.execute(delete(Restaurant).where(Restaurant.id == restaurant_id))
                await session.commit()
            if user_id is not None:
                await session.execute(delete(User).where(User.id == user_id))
                await session.commit()
