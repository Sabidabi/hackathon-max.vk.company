import argparse
import asyncio
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.database import SessionFactory
from app.demo_data import (
    DEMO_ASSIGNMENTS,
    DEMO_MENUS,
    DEMO_POINTS,
    DEMO_PUBLIC_ID,
    DEMO_RESTAURANT_DESCRIPTION,
    DEMO_SITE_CONFIG,
    DEMO_STOP_LIST,
    DEMO_VENUE_NAME,
)
from app.menu_configuration import ItemConfiguration
from app.models import (
    ADMIN_ROLE,
    Menu,
    MenuItem,
    MenuSection,
    MenuVersion,
    PointItemOverride,
    PointMenu,
    Restaurant,
    RestaurantSite,
    User,
    Venue,
    VenueMember,
)
from app.sites.schemas import SiteConfig

DEMO_ITEM_NAMESPACE = uuid.UUID("5b1d0c1e-3f55-4d0f-9a8e-6f1f5b8e2c11")


class DemoSeedRefused(RuntimeError):
    pass


@dataclass(frozen=True)
class DemoSeedResult:
    restaurant_id: uuid.UUID
    public_id: str
    menu_version: int
    menu_changed: bool
    site_changed: bool
    venue_id: uuid.UUID | None = None
    point_public_ids: tuple[str, ...] = ()


def _uuid(*parts: str) -> uuid.UUID:
    return uuid.uuid5(DEMO_ITEM_NAMESPACE, "|".join(parts))


def _item_key(menu_key: str, section: str, name: str) -> uuid.UUID:
    return _uuid(menu_key, section, name)


def _configuration(item_key: uuid.UUID, symbolic: dict[str, Any] | None) -> dict[str, Any]:
    """Turn the symbolic demo configuration into a validated one with stable UUIDs."""
    if not symbolic:
        return ItemConfiguration().model_dump(mode="json")
    key = str(item_key)
    variants = [
        {**variant, "id": _uuid(key, "variant", variant["name"])}
        for variant in symbolic.get("variants", [])
    ]
    groups = [
        {
            **group,
            "id": _uuid(key, "group", group["name"]),
            "options": [
                {**option, "id": _uuid(key, "group", group["name"], option["name"])}
                for option in group["options"]
            ],
        }
        for group in symbolic.get("groups", [])
    ]
    return ItemConfiguration.model_validate(
        {
            "variants": variants,
            "default_variant_id": variants[0]["id"] if variants else None,
            "modifier_groups": groups,
        }
    ).model_dump(mode="json")


def _normalized_sections(menu_key: str, sections: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    for section in sections:
        items = []
        for item in section["items"]:
            item_key = _item_key(menu_key, section["name"], item["name"])
            items.append(
                {
                    "item_key": item_key,
                    "name": item["name"],
                    "description": item["description"],
                    "price_minor": item["price_minor"],
                    "currency": "RUB",
                    "weight_text": item["weight_text"],
                    "ingredients": item["ingredients"],
                    "allergens": item["allergens"],
                    "configuration": _configuration(item_key, item["configuration"]),
                    "image_url": None,
                    "is_available": item["is_available"],
                    "source_confidence": None,
                }
            )
        result.append({"name": section["name"], "items": items})
    return result


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
                    "item_key": item.item_key,
                    "name": item.name,
                    "description": item.description,
                    "price_minor": item.price_minor,
                    "currency": item.currency,
                    "weight_text": item.weight_text,
                    "ingredients": item.ingredients,
                    "allergens": item.allergens or [],
                    "configuration": item.configuration or ItemConfiguration().model_dump(
                        mode="json"
                    ),
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
                    # Same key in the draft and every published demo version.
                    item_key=item_data["item_key"],
                    name=item_data["name"],
                    description=item_data["description"],
                    price_minor=item_data["price_minor"],
                    currency=item_data["currency"],
                    weight_text=item_data["weight_text"],
                    ingredients=item_data["ingredients"],
                    allergens=item_data["allergens"],
                    configuration=item_data["configuration"],
                    image_path=item_data["image_url"],
                    is_available=item_data["is_available"],
                    source_confidence=item_data["source_confidence"],
                    sort_order=item_index,
                )
            )


async def _seed_menu(
    session: AsyncSession,
    menu: Menu,
    user: User,
    desired_sections: list[dict[str, Any]],
    now: datetime,
) -> tuple[int, bool]:
    """Bring the menu's draft and publication to the demo content; returns (version, changed)."""
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
            menu_id=menu.id, version=next_version, status="draft", created_by_id=user.id
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
    changed = published is None or await _read_sections(session, published.id) != desired_sections
    if changed:
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
    return published.version, changed


async def seed_demo(
    session: AsyncSession,
    settings: Settings,
    *,
    replace_existing: bool = False,
    public_id: str = DEMO_PUBLIC_ID,
) -> DemoSeedResult:
    """Create or refresh «Кофейня Север»: two points, two published menus, one stop-list.

    ``public_id`` names the first point; the others get ``<public_id>-<key>``.
    ``replace_existing`` allows adding the demo venue for a user who already administers
    another venue (that venue is never touched).
    """
    desired_site = SiteConfig.model_validate(DEMO_SITE_CONFIG).model_dump(mode="json")
    now = datetime.now().astimezone()
    point_ids = {
        point["key"]: public_id if index == 0 else f"{public_id}-{point['key']}"
        for index, point in enumerate(DEMO_POINTS)
    }

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

    existing = {
        point.public_id: point
        for point in (
            await session.scalars(
                select(Restaurant).where(Restaurant.public_id.in_(point_ids.values()))
            )
        ).all()
    }
    venue_ids = {point.venue_id for point in existing.values()}
    if len(venue_ids) > 1:
        raise DemoSeedRefused("Публичные ID демо-точек заняты разными заведениями")
    venue: Venue | None = None
    if venue_ids:
        venue = await session.get(Venue, venue_ids.pop())
        member = (
            await session.get(VenueMember, (venue.id, user.id)) if venue is not None else None
        )
        if member is None:
            raise DemoSeedRefused(f"Публичный ID {public_id!r} занят чужим заведением")
    else:
        other_venue = await session.scalar(
            select(VenueMember.venue_id).where(VenueMember.user_id == user.id).limit(1)
        )
        if other_venue is not None and not replace_existing:
            raise DemoSeedRefused(
                "Локальный пользователь уже администрирует заведение. Запустите с "
                "--replace-existing, чтобы добавить демо-заведение рядом (своё не изменится)."
            )
        venue = Venue(name=DEMO_VENUE_NAME, created_by_id=user.id)
        session.add(venue)
        await session.flush()
    assert venue is not None
    venue.name = DEMO_VENUE_NAME
    if await session.get(VenueMember, (venue.id, user.id)) is None:
        session.add(
            VenueMember(venue_id=venue.id, user_id=user.id, role=ADMIN_ROLE, is_creator=True)
        )

    points: dict[str, Restaurant] = {}
    for point_data in DEMO_POINTS:
        point = existing.get(point_ids[point_data["key"]])
        if point is None:
            point = Restaurant(
                public_id=point_ids[point_data["key"]], venue_id=venue.id, owner_id=user.id
            )
            session.add(point)
        point.name = point_data["name"]
        point.address = point_data["address"]
        point.description = DEMO_RESTAURANT_DESCRIPTION
        points[point_data["key"]] = point
    await session.flush()

    menus: dict[str, Menu] = {}
    versions: dict[str, int] = {}
    menu_changed = False
    for index, menu_data in enumerate(DEMO_MENUS):
        menu = await session.scalar(
            select(Menu)
            .where(
                Menu.venue_id == venue.id,
                Menu.title == menu_data["title"],
                Menu.archived_at.is_(None),
            )
            .order_by(Menu.created_at)
            .limit(1)
        )
        if menu is None:
            # The library lists menus by creation time; one transaction shares ``now()``,
            # so the demo order («Основное» first) is set explicitly.
            menu = Menu(
                venue_id=venue.id,
                title=menu_data["title"],
                source="manual",
                created_at=now + timedelta(microseconds=index),
            )
            session.add(menu)
            await session.flush()
        version, changed = await _seed_menu(
            session,
            menu,
            user,
            _normalized_sections(menu_data["key"], menu_data["sections"]),
            now,
        )
        menus[menu_data["key"]] = menu
        versions[menu_data["key"]] = version
        menu_changed = menu_changed or changed

    for point_key, point in points.items():
        desired = [
            (menus[menu_key].id, index, show_from, show_to)
            for index, (menu_key, show_from, show_to) in enumerate(DEMO_ASSIGNMENTS[point_key])
        ]
        current = [
            (row.menu_id, row.sort_order, row.show_from, row.show_to)
            for row in (
                await session.scalars(
                    select(PointMenu)
                    .where(PointMenu.point_id == point.id)
                    .order_by(PointMenu.sort_order)
                )
            ).all()
        ]
        if current != desired:
            await session.execute(delete(PointMenu).where(PointMenu.point_id == point.id))
            await session.flush()
            for menu_id, index, show_from, show_to in desired:
                session.add(
                    PointMenu(
                        point_id=point.id,
                        menu_id=menu_id,
                        venue_id=venue.id,
                        sort_order=index,
                        show_from=show_from,
                        show_to=show_to,
                    )
                )

    menu_sections = {menu["key"]: menu["sections"] for menu in DEMO_MENUS}
    for point_key, menu_key, item_name in DEMO_STOP_LIST:
        section_name = next(
            section["name"]
            for section in menu_sections[menu_key]
            if any(item["name"] == item_name for item in section["items"])
        )
        key = _item_key(menu_key, section_name, item_name)
        override = await session.get(PointItemOverride, (points[point_key].id, key))
        if override is None:
            session.add(
                PointItemOverride(
                    point_id=points[point_key].id,
                    item_key=key,
                    available=False,
                    updated_by_id=user.id,
                )
            )
        else:
            override.available = False

    site_changed = False
    for point in points.values():
        site = await session.get(RestaurantSite, point.id)
        if site is None:
            site = RestaurantSite(
                restaurant_id=point.id, draft_config=desired_site, published_version=0
            )
            session.add(site)
        else:
            site.draft_config = desired_site
        current_site = (
            SiteConfig.model_validate(site.published_config).model_dump(mode="json")
            if site.published_config is not None
            else None
        )
        if current_site != desired_site:
            site_changed = True
            site.published_config = desired_site
            site.published_version = (site.published_version or 0) + 1
            site.published_at = now
            site.updated_at = now

    await session.commit()
    first = points[DEMO_POINTS[0]["key"]]
    return DemoSeedResult(
        restaurant_id=first.id,
        public_id=first.public_id,
        menu_version=versions[DEMO_MENUS[0]["key"]],
        menu_changed=menu_changed,
        site_changed=site_changed,
        venue_id=venue.id,
        point_public_ids=tuple(point.public_id for point in points.values()),
    )


async def _run(replace_existing: bool, with_analytics: bool = False) -> DemoSeedResult:
    settings = get_settings()
    async with SessionFactory() as session:
        result = await seed_demo(session, settings, replace_existing=replace_existing)
        if with_analytics and result.venue_id is not None:
            from app.analytics.demo import seed_demo_events

            await seed_demo_events(session, result.venue_id)
            await session.commit()
        return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Демо-заведение «Кофейня Север»")
    parser.add_argument(
        "--replace-existing",
        action="store_true",
        help="добавить демо-заведение, даже если у локального пользователя уже есть своё",
    )
    parser.add_argument(
        "--with-analytics",
        action="store_true",
        help="сгенерировать синтетические события за 30 дней (метка «демо-данные»)",
    )
    args = parser.parse_args()
    try:
        result = asyncio.run(_run(args.replace_existing, args.with_analytics))
    except DemoSeedRefused as error:
        print(f"Демо-данные не применены: {error}", file=sys.stderr)
        return 2

    settings = get_settings()
    base_url = settings.public_app_url.rstrip("/")
    analytics = "с синтетической аналитикой" if args.with_analytics else "без аналитики"
    print(f"Демо-заведение «Кофейня Север» готово (демо-данные, без фото, {analytics}).")
    print(f"Кабинет (dev-вход): {base_url}/manage/{result.public_id}/menu")
    for point_id in result.point_public_ids:
        print(f"Гостевое меню: {base_url}/r/{point_id}")
    print(f"Версия меню «Основное»: {result.menu_version}")
    print(f"Меню обновлены: {'да' if result.menu_changed else 'нет'}")
    print(f"Оформление обновлено: {'да' if result.site_changed else 'нет'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
