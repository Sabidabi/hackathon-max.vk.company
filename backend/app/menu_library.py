"""Point-level view of the venue menu library (P1-DOC-15).

- Which assigned menus a point shows right now: tab order and local show hours in the
  point's time zone. Local time comes from PostgreSQL's time zone database, so the
  backend needs no tzdata package.
- The point's operational layer (stop-list and own prices) applied to menu snapshots;
  the same transformation feeds the guest snapshot and the server-side price quote.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, time

from sqlalchemy import DateTime, Time, cast, func, literal, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.menus import MenuItemResponse, MenuSectionResponse, read_versions_sections
from app.menu_configuration import availability_error
from app.models import Menu, MenuVersion, PointItemOverride, PointMenu


def utc_now() -> datetime:
    """Single clock for show hours; tests replace it to check a given local time."""
    return datetime.now(UTC)


async def local_time(session: AsyncSession, timezone: str, at: datetime) -> time:
    value = await session.scalar(
        select(cast(func.timezone(timezone, literal(at, DateTime(timezone=True))), Time()))
    )
    if value is None:  # pragma: no cover - PostgreSQL always answers for a valid zone
        raise ValueError("Не удалось определить местное время точки")
    return value


async def is_known_timezone(session: AsyncSession, timezone: str) -> bool:
    """IANA names known to PostgreSQL, the same database that later converts the time."""
    return bool(await session.scalar(
        text("SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = :name)"),
        {"name": timezone},
    ))


def is_shown_at(show_from: time | None, show_to: time | None, moment: time) -> bool:
    """Show hours are local wall-clock time; ``show_from > show_to`` spans midnight."""
    if show_from is None or show_to is None:
        return True
    if show_from < show_to:
        return show_from <= moment < show_to
    return moment >= show_from or moment < show_to


@dataclass(frozen=True)
class PointTab:
    menu: Menu
    version: MenuVersion
    assignment: PointMenu
    sections: list[MenuSectionResponse]


async def published_tabs(
    session: AsyncSession, point_id: uuid.UUID
) -> list[tuple[PointMenu, Menu, MenuVersion]]:
    """Assigned live menus with a published version, in tab order (hours not applied)."""
    rows = (await session.execute(
        select(PointMenu, Menu, MenuVersion)
        .join(Menu, Menu.id == PointMenu.menu_id)
        .join(MenuVersion, MenuVersion.id == Menu.current_published_version_id)
        .where(
            PointMenu.point_id == point_id,
            Menu.archived_at.is_(None),
            MenuVersion.status == "published",
            MenuVersion.published_at.is_not(None),
        )
        .order_by(PointMenu.sort_order)
    )).all()
    return [tuple(row) for row in rows]


async def active_tabs(
    session: AsyncSession, point_id: uuid.UUID, timezone: str, at: datetime | None = None
) -> tuple[list[PointTab], bool]:
    """Tabs a guest sees now, with the point's overrides applied, and whether the point
    has any published menu at all (for the 404 visibility rule)."""
    rows = await published_tabs(session, point_id)
    if not rows:
        return [], False
    moment = await local_time(session, timezone, at or utc_now())
    shown = [row for row in rows if is_shown_at(row[0].show_from, row[0].show_to, moment)]
    sections = await read_versions_sections(session, [version.id for _, _, version in shown])
    overrides = await point_overrides(session, point_id)
    return [
        PointTab(
            menu=menu,
            version=version,
            assignment=assignment,
            sections=apply_overrides(sections[version.id], overrides),
        )
        for assignment, menu, version in shown
    ], True


async def point_overrides(
    session: AsyncSession, point_id: uuid.UUID
) -> dict[uuid.UUID, PointItemOverride]:
    rows = (await session.scalars(
        select(PointItemOverride).where(PointItemOverride.point_id == point_id)
    )).all()
    return {row.item_key: row for row in rows}


def apply_override(item: MenuItemResponse, override: PointItemOverride | None) -> MenuItemResponse:
    if override is None:
        return item
    update: dict[str, object] = {}
    if override.available is not None:
        # An override set while the position was sellable must not expose it after a
        # version without an available size / required modifier is published.
        update["is_available"] = (
            override.available and availability_error(item.configuration) is None
        )
    if override.price_minor is not None:
        update["price_minor"] = override.price_minor
    variant_prices = {
        uuid.UUID(key): value for key, value in (override.variant_prices or {}).items()
    }
    if variant_prices:
        update["configuration"] = item.configuration.model_copy(update={
            "variants": [
                variant.model_copy(update={"price_minor": variant_prices[variant.id]})
                if variant.id in variant_prices else variant
                for variant in item.configuration.variants
            ],
        })
    return item.model_copy(update=update) if update else item


def apply_overrides(
    sections: list[MenuSectionResponse], overrides: dict[uuid.UUID, PointItemOverride]
) -> list[MenuSectionResponse]:
    if not overrides:
        return sections
    return [
        section.model_copy(update={
            "items": [apply_override(item, overrides.get(item.item_key)) for item in section.items]
        })
        for section in sections
    ]
