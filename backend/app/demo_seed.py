import argparse
import asyncio
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.database import SessionFactory
from app.demo_data import (
    DEMO_PUBLIC_ID,
    DEMO_RESTAURANT_ADDRESS,
    DEMO_RESTAURANT_DESCRIPTION,
    DEMO_RESTAURANT_NAME,
    DEMO_SECTIONS,
    DEMO_SITE_CONFIG,
)
from app.models import (
    Menu,
    MenuItem,
    MenuSection,
    MenuVersion,
    Restaurant,
    RestaurantMember,
    RestaurantSite,
    User,
)
from app.sites.schemas import SiteConfig


class DemoSeedRefused(RuntimeError):
    pass


@dataclass(frozen=True)
class DemoSeedResult:
    restaurant_id: uuid.UUID
    public_id: str
    menu_version: int
    menu_changed: bool
    site_changed: bool


def _normalized_demo_sections() -> list[dict[str, Any]]:
    return [
        {
            "name": section["name"],
            "items": [
                {
                    "name": item["name"],
                    "description": item["description"],
                    "price_minor": item["price_minor"],
                    "currency": "RUB",
                    "weight_text": item["weight_text"],
                    "ingredients": item["ingredients"],
                    "allergens": item["allergens"],
                    "image_url": None,
                    "is_available": item["is_available"],
                    "source_confidence": None,
                }
                for item in section["items"]
            ],
        }
        for section in DEMO_SECTIONS
    ]


async def _read_sections(session: AsyncSession, version_id: uuid.UUID) -> list[dict[str, Any]]:
    sections = (
        await session.scalars(
            select(MenuSection)
            .where(MenuSection.menu_version_id == version_id)
            .order_by(MenuSection.sort_order)
        )
    ).all()
    if not sections:
        return []
    items = (
        await session.scalars(
            select(MenuItem)
            .where(MenuItem.section_id.in_([section.id for section in sections]))
            .order_by(MenuItem.section_id, MenuItem.sort_order)
        )
    ).all()
    by_section: dict[uuid.UUID, list[MenuItem]] = {section.id: [] for section in sections}
    for item in items:
        by_section[item.section_id].append(item)
    return [
        {
            "name": section.name,
            "items": [
                {
                    "name": item.name,
                    "description": item.description,
                    "price_minor": item.price_minor,
                    "currency": item.currency,
                    "weight_text": item.weight_text,
                    "ingredients": item.ingredients,
                    "allergens": item.allergens or [],
                    "image_url": item.image_path,
                    "is_available": item.is_available,
                    "source_confidence": (
                        float(item.source_confidence)
                        if isinstance(item.source_confidence, Decimal)
                        else item.source_confidence
                    ),
                }
                for item in by_section[section.id]
            ],
        }
        for section in sections
    ]


async def _write_sections(
    session: AsyncSession,
    version_id: uuid.UUID,
    sections: list[dict[str, Any]],
) -> None:
    await session.execute(delete(MenuSection).where(MenuSection.menu_version_id == version_id))
    await session.flush()
    for section_index, section_data in enumerate(sections):
        section = MenuSection(
            menu_version_id=version_id,
            name=section_data["name"],
            sort_order=section_index,
        )
        session.add(section)
        await session.flush()
        for item_index, item_data in enumerate(section_data["items"]):
            session.add(
                MenuItem(
                    section_id=section.id,
                    name=item_data["name"],
                    description=item_data["description"],
                    price_minor=item_data["price_minor"],
                    currency=item_data["currency"],
                    weight_text=item_data["weight_text"],
                    ingredients=item_data["ingredients"],
                    allergens=item_data["allergens"],
                    image_path=item_data["image_url"],
                    is_available=item_data["is_available"],
                    source_confidence=item_data["source_confidence"],
                    sort_order=item_index,
                )
            )


async def seed_demo(
    session: AsyncSession,
    settings: Settings,
    *,
    replace_existing: bool = False,
    public_id: str = DEMO_PUBLIC_ID,
) -> DemoSeedResult:
    desired_sections = _normalized_demo_sections()
    desired_site = SiteConfig.model_validate(DEMO_SITE_CONFIG).model_dump(mode="json")
    now = datetime.now().astimezone()

    user = await session.scalar(select(User).where(User.max_user_id == settings.dev_max_user_id))
    if user is None:
        user = User(
            max_user_id=settings.dev_max_user_id,
            display_name="Локальный Разработчик",
            first_name="Локальный",
            last_name="Разработчик",
            username="dev_user",
            language_code="ru",
        )
        session.add(user)
        await session.flush()
    restaurant = await session.scalar(
        select(Restaurant).where(Restaurant.owner_id == user.id).limit(1)
    )
    if restaurant is not None and restaurant.public_id != public_id:
        if not replace_existing:
            raise DemoSeedRefused(
                "У локального пользователя уже есть ресторан. Запустите с "
                "--replace-existing, только если хотите заменить его текущий черновик и публикацию."
            )
        conflict = await session.scalar(
            select(Restaurant.id).where(
                Restaurant.public_id == public_id,
                Restaurant.id != restaurant.id,
            )
        )
        if conflict is not None:
            raise DemoSeedRefused(f"Публичный ID {public_id!r} уже занят")

    if restaurant is None:
        existing_demo = await session.scalar(
            select(Restaurant).where(Restaurant.public_id == public_id)
        )
        if existing_demo is not None:
            raise DemoSeedRefused(f"Публичный ID {public_id!r} уже занят")
        restaurant = Restaurant(
            public_id=public_id,
            owner_id=user.id,
            name=DEMO_RESTAURANT_NAME,
            description=DEMO_RESTAURANT_DESCRIPTION,
            address=DEMO_RESTAURANT_ADDRESS,
        )
        session.add(restaurant)
        await session.flush()
    else:
        restaurant.public_id = public_id
        restaurant.name = DEMO_RESTAURANT_NAME
        restaurant.description = DEMO_RESTAURANT_DESCRIPTION
        restaurant.address = DEMO_RESTAURANT_ADDRESS

    member = await session.get(RestaurantMember, (restaurant.id, user.id))
    if member is None:
        session.add(
            RestaurantMember(
                restaurant_id=restaurant.id,
                user_id=user.id,
                role="owner",
            )
        )
    else:
        member.role = "owner"

    menu = await session.scalar(select(Menu).where(Menu.restaurant_id == restaurant.id))
    if menu is None:
        menu = Menu(restaurant_id=restaurant.id)
        session.add(menu)
        await session.flush()

    draft = await session.scalar(
        select(MenuVersion)
        .where(MenuVersion.menu_id == menu.id, MenuVersion.status == "draft")
        .order_by(MenuVersion.version.desc())
        .limit(1)
    )
    if draft is None:
        next_version = (
            await session.scalar(
                select(func.max(MenuVersion.version)).where(MenuVersion.menu_id == menu.id)
            )
            or 0
        ) + 1
        draft = MenuVersion(
            menu_id=menu.id,
            version=next_version,
            status="draft",
            created_by_id=user.id,
        )
        session.add(draft)
        await session.flush()
    if await _read_sections(session, draft.id) != desired_sections:
        await _write_sections(session, draft.id, desired_sections)

    published = (
        await session.get(MenuVersion, menu.current_published_version_id)
        if menu.current_published_version_id is not None
        else None
    )
    menu_changed = (
        published is None or await _read_sections(session, published.id) != desired_sections
    )
    if menu_changed:
        if published is not None:
            published.status = "archived"
        next_version = (
            await session.scalar(
                select(func.max(MenuVersion.version)).where(MenuVersion.menu_id == menu.id)
            )
            or 0
        ) + 1
        published = MenuVersion(
            menu_id=menu.id,
            version=next_version,
            status="published",
            created_by_id=user.id,
            published_at=now,
        )
        session.add(published)
        await session.flush()
        await _write_sections(session, published.id, desired_sections)
        menu.current_published_version_id = published.id
    menu.updated_at = now

    site = await session.get(RestaurantSite, restaurant.id)
    if site is None:
        site = RestaurantSite(
            restaurant_id=restaurant.id,
            draft_config=desired_site,
            published_version=0,
        )
        session.add(site)
    else:
        site.draft_config = desired_site
    current_site = (
        SiteConfig.model_validate(site.published_config).model_dump(mode="json")
        if site.published_config is not None
        else None
    )
    site_changed = current_site != desired_site
    if site_changed:
        site.published_config = desired_site
        site.published_version += 1
        site.published_at = now
    site.updated_at = now

    await session.commit()
    return DemoSeedResult(
        restaurant_id=restaurant.id,
        public_id=restaurant.public_id,
        menu_version=published.version,
        menu_changed=menu_changed,
        site_changed=site_changed,
    )


async def _run(replace_existing: bool) -> DemoSeedResult:
    settings = get_settings()
    async with SessionFactory() as session:
        return await seed_demo(session, settings, replace_existing=replace_existing)


def main() -> int:
    parser = argparse.ArgumentParser(description="Создать идемпотентный демо-ресторан")
    parser.add_argument(
        "--replace-existing",
        action="store_true",
        help="заменить черновик и публикацию существующего локального ресторана",
    )
    args = parser.parse_args()
    try:
        result = asyncio.run(_run(args.replace_existing))
    except DemoSeedRefused as error:
        print(f"Демо-данные не применены: {error}", file=sys.stderr)
        return 2

    settings = get_settings()
    base_url = settings.public_app_url.rstrip("/")
    print("Демо-ресторан готов.")
    print(f"Кабинет: {base_url}")
    print(f"Публичная страница: {base_url}/r/{result.public_id}")
    print(f"Версия меню: {result.menu_version}")
    print(f"Меню обновлено: {'да' if result.menu_changed else 'нет'}")
    print(f"Сайт обновлён: {'да' if result.site_changed else 'нет'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
