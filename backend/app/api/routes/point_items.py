"""Operational layer of a point: stop-list and own prices, applied without publishing.

The stop-list is keyed by the stable ``item_key`` of a position, so it survives renames,
new menu versions and restores. Changes are absolute values (set / clear): a repeated or
concurrent request cannot lose another edit, and guests of the point see them at once.
"""

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.menus import MenuItemResponse, read_versions_sections
from app.auth.dependencies import get_current_user
from app.auth.permissions import require_admin_of_venue, require_point_admin
from app.bot.events import on_point_availability_changed
from app.database import get_session
from app.menu_configuration import availability_error
from app.menu_library import apply_override, point_overrides
from app.models import (
    Menu,
    MenuItem,
    MenuSection,
    MenuVersion,
    PointItemOverride,
    PointMenu,
    Restaurant,
    User,
)

router = APIRouter(tags=["point stop-list"])

ITEM_NOT_ASSIGNED = "Позиции нет в меню этой точки"


class OverrideValues(BaseModel):
    available: bool | None
    price_minor: int | None
    variant_prices: dict[uuid.UUID, int]


class PointVariantState(BaseModel):
    variant_id: uuid.UUID
    name: str
    is_available: bool
    menu_price_minor: int
    # What the guest pays for this size at the point (own size price or the menu one).
    effective_price_minor: int


class PointItemState(BaseModel):
    item_key: uuid.UUID
    item_id: uuid.UUID
    name: str
    section: str
    # Base price; for a position with sizes the guest pays a size price, see ``variants``.
    menu_price_minor: int
    menu_is_available: bool
    effective_price_minor: int
    effective_is_available: bool
    # The position cannot be sold as configured (no available size, a required add-on
    # is off): it cannot be switched on at the point until the menu is fixed.
    availability_error: str | None
    variants: list[PointVariantState]
    override: OverrideValues | None


class PointMenuItems(BaseModel):
    menu_id: uuid.UUID
    title: str
    source: str  # "published" or "draft" (the menu was never published)
    items: list[PointItemState]


class PointItemsResponse(BaseModel):
    point_id: uuid.UUID
    menus: list[PointMenuItems]


Price = Annotated[int, Field(strict=True, ge=0, le=100_000_000)]


class OverridePatch(BaseModel):
    """Only the sent fields change; ``null`` returns a field to the menu value."""

    available: bool | None = None
    price_minor: int | None = Field(default=None, strict=True, ge=0, le=100_000_000)
    variant_prices: dict[uuid.UUID, Price] | None = Field(default=None, max_length=20)


class OverrideResponse(BaseModel):
    point_id: uuid.UUID
    item_key: uuid.UUID
    available: bool | None
    price_minor: int | None
    variant_prices: dict[uuid.UUID, int]


class BulkAvailability(BaseModel):
    # None clears the point-level availability and returns to the menu value.
    available: bool | None
    # Omitted: every point of the venue that has the position.
    point_ids: list[uuid.UUID] | None = Field(default=None, min_length=1, max_length=200)


class BulkAvailabilityResponse(BaseModel):
    item_key: uuid.UUID
    available: bool | None
    point_ids: list[uuid.UUID]


async def point_menu_contents(
    session: AsyncSession, point_id: uuid.UUID
) -> list[tuple[Menu, str, list[tuple[str, MenuItemResponse]]]]:
    """Assigned menus with the content guests see: the published version, or the draft
    for a menu not yet published (so a stop-list can be prepared before publication)."""
    menus = (await session.scalars(
        select(Menu)
        .join(PointMenu, PointMenu.menu_id == Menu.id)
        .where(PointMenu.point_id == point_id)
        .order_by(PointMenu.sort_order)
    )).all()
    if not menus:
        return []
    drafts = {row.menu_id: row.id for row in (await session.execute(
        select(MenuVersion.menu_id, MenuVersion.id)
        .where(MenuVersion.menu_id.in_([menu.id for menu in menus]), MenuVersion.status == "draft")
        .order_by(MenuVersion.menu_id, MenuVersion.version.desc())
        .distinct(MenuVersion.menu_id)
    )).all()}
    chosen = {
        menu.id: (menu.current_published_version_id, "published")
        if menu.current_published_version_id is not None
        else (drafts.get(menu.id), "draft")
        for menu in menus
    }
    sections = await read_versions_sections(
        session, [version_id for version_id, _ in chosen.values() if version_id is not None]
    )
    result = []
    for menu in menus:
        version_id, source = chosen[menu.id]
        items = [
            (section.name, item)
            for section in (sections.get(version_id, []) if version_id else [])
            for item in section.items
        ]
        result.append((menu, source, items))
    return result


def override_values(override: PointItemOverride | None) -> OverrideValues | None:
    if override is None:
        return None
    return OverrideValues(
        available=override.available,
        price_minor=override.price_minor,
        variant_prices={uuid.UUID(key): value for key, value in override.variant_prices.items()},
    )


@router.get("/points/{point_id}/items", response_model=PointItemsResponse)
async def get_point_items(
    point_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> PointItemsResponse:
    """The point's stop-list screen: menu values, point overrides and what guests get."""
    await require_point_admin(session, current_user.id, point_id)
    overrides = await point_overrides(session, point_id)
    menus = []
    for menu, source, items in await point_menu_contents(session, point_id):
        states = []
        for section, item in items:
            override = overrides.get(item.item_key)
            effective = apply_override(item, override)
            states.append(PointItemState(
                item_key=item.item_key,
                item_id=item.id,
                name=item.name,
                section=section,
                menu_price_minor=item.price_minor,
                menu_is_available=item.is_available,
                effective_price_minor=effective.price_minor,
                effective_is_available=effective.is_available,
                availability_error=availability_error(item.configuration),
                variants=[
                    PointVariantState(
                        variant_id=variant.id,
                        name=variant.name,
                        is_available=variant.is_available,
                        menu_price_minor=variant.price_minor,
                        effective_price_minor=effective_variant.price_minor,
                    )
                    for variant, effective_variant in zip(
                        item.configuration.variants,
                        effective.configuration.variants,
                        strict=True,
                    )
                ],
                override=override_values(override),
            ))
        menus.append(PointMenuItems(menu_id=menu.id, title=menu.title, source=source, items=states))
    return PointItemsResponse(point_id=point_id, menus=menus)


async def points_with_item(
    session: AsyncSession, point_ids: list[uuid.UUID], item_key: uuid.UUID
) -> dict[uuid.UUID, MenuItemResponse]:
    """Points (of the given ones) whose assigned menus contain the position, with the item
    as guests see it: the published version, else the draft."""
    rows = (await session.execute(
        select(PointMenu.point_id, MenuItem.id)
        .join(Menu, Menu.id == PointMenu.menu_id)
        .join(MenuVersion, MenuVersion.menu_id == Menu.id)
        .join(MenuSection, MenuSection.menu_version_id == MenuVersion.id)
        .join(MenuItem, MenuItem.section_id == MenuSection.id)
        .where(
            PointMenu.point_id.in_(point_ids),
            MenuItem.item_key == item_key,
            (MenuVersion.id == Menu.current_published_version_id)
            | ((Menu.current_published_version_id.is_(None)) & (MenuVersion.status == "draft")),
        )
    )).all()
    if not rows:
        return {}
    item_rows = {
        item.id: item
        for item in (await session.scalars(
            select(MenuItem).where(MenuItem.id.in_([row.id for row in rows]))
        )).all()
    }
    result: dict[uuid.UUID, MenuItemResponse] = {}
    for point_id, item_id in rows:
        item = item_rows[item_id]
        result.setdefault(point_id, MenuItemResponse(
            id=item.id,
            item_key=item.item_key,
            name=item.name,
            price_minor=item.price_minor,
            is_available=item.is_available,
            configuration=item.configuration or {},
        ))
    return result


def unsellable_detail(item: MenuItemResponse) -> str | None:
    error = availability_error(item.configuration)
    if error is None:
        return None
    return f"«{item.name}» нельзя включить: {error}. Исправьте позицию в меню и опубликуйте."


def check_variant_prices(item: MenuItemResponse, prices: dict[uuid.UUID, int]) -> None:
    known = {variant.id for variant in item.configuration.variants}
    if not set(prices) <= known:
        raise HTTPException(status_code=422, detail="Размер не найден у позиции")


def _available(item: MenuItemResponse, override: PointItemOverride | None) -> bool:
    """What the point's guests see: the point's own value, else the menu value."""
    if override is not None and override.available is not None:
        return override.available
    return item.is_available


async def effective_available(
    session: AsyncSession, point_id: uuid.UUID, item: MenuItemResponse
) -> bool:
    override = await session.get(PointItemOverride, (point_id, item.item_key))
    return _available(item, override)


async def write_override(
    session: AsyncSession,
    point_id: uuid.UUID,
    item_key: uuid.UUID,
    values: dict[str, object],
    actor_id: uuid.UUID,
) -> PointItemOverride | None:
    """Merge sent fields into the point's override (``None`` clears a field); a row left
    without any override is deleted, so the point falls back to the menu values."""
    current = await session.scalar(
        select(PointItemOverride)
        .where(PointItemOverride.point_id == point_id, PointItemOverride.item_key == item_key)
        .with_for_update()
    )
    merged: dict[str, object] = {
        "available": current.available if current else None,
        "price_minor": current.price_minor if current else None,
        "variant_prices": dict(current.variant_prices) if current else {},
    }
    for key, value in values.items():
        merged[key] = ({} if value is None else value) if key == "variant_prices" else value
    if merged["available"] is None and merged["price_minor"] is None and not merged[
        "variant_prices"
    ]:
        if current is not None:
            await session.delete(current)
            await session.flush()
        return None
    now = datetime.now().astimezone()
    # ON CONFLICT covers two admins creating the first override at the same moment.
    await session.execute(
        insert(PointItemOverride)
        .values(point_id=point_id, item_key=item_key, updated_by_id=actor_id, **merged)
        .on_conflict_do_update(
            index_elements=[PointItemOverride.point_id, PointItemOverride.item_key],
            set_={**merged, "updated_by_id": actor_id, "updated_at": now},
        )
    )
    return await session.get(PointItemOverride, (point_id, item_key), populate_existing=True)


@router.patch("/points/{point_id}/items/{item_key}", response_model=OverrideResponse)
async def patch_point_item(
    point_id: uuid.UUID,
    item_key: uuid.UUID,
    payload: OverridePatch,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> OverrideResponse:
    """Stop-list or own price of one point; guests of the point see it at once and the
    menu version does not change. Only the sent fields change."""
    await require_point_admin(session, current_user.id, point_id)
    values = payload.model_dump(exclude_unset=True, mode="json")
    if not values:
        raise HTTPException(status_code=422, detail="Нет изменений")
    item = (await points_with_item(session, [point_id], item_key)).get(point_id)
    if item is None:
        raise HTTPException(status_code=404, detail=ITEM_NOT_ASSIGNED)
    if payload.available is True and (detail := unsellable_detail(item)):
        raise HTTPException(status_code=409, detail=detail)
    if payload.variant_prices:
        check_variant_prices(item, payload.variant_prices)
    was_available = await effective_available(session, point_id, item)
    override = await write_override(session, point_id, item_key, values, current_user.id)
    await on_point_availability_changed(
        session,
        point_id=point_id,
        item_key=item_key,
        item_name=item.name,
        was_available=was_available,
        now_available=_available(item, override),
    )
    await session.commit()
    return OverrideResponse(
        point_id=point_id,
        item_key=item_key,
        available=override.available if override else None,
        price_minor=override.price_minor if override else None,
        variant_prices=(
            {uuid.UUID(key): value for key, value in override.variant_prices.items()}
            if override else {}
        ),
    )


@router.post(
    "/venues/{venue_id}/items/{item_key}/availability",
    response_model=BulkAvailabilityResponse,
)
async def set_venue_item_availability(
    venue_id: uuid.UUID,
    item_key: uuid.UUID,
    payload: BulkAvailability,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> BulkAvailabilityResponse:
    """«Нет в наличии → во всех точках»: one transaction over the chosen points."""
    await require_admin_of_venue(session, current_user.id, venue_id)
    venue_points = list((await session.scalars(
        select(Restaurant.id)
        .where(Restaurant.venue_id == venue_id)
        .order_by(Restaurant.created_at, Restaurant.id)
        .with_for_update()
    )).all())
    if payload.point_ids is not None:
        if len(set(payload.point_ids)) != len(payload.point_ids):
            raise HTTPException(status_code=422, detail="Точка выбрана несколько раз")
        if not set(payload.point_ids) <= set(venue_points):
            raise HTTPException(status_code=404, detail="Restaurant not found")
    candidates = payload.point_ids or venue_points
    having = await points_with_item(session, candidates, item_key)
    if payload.point_ids is not None and set(having) != set(payload.point_ids):
        raise HTTPException(status_code=409, detail=ITEM_NOT_ASSIGNED)
    targets = [point_id for point_id in candidates if point_id in having]
    if not targets:
        raise HTTPException(status_code=404, detail=ITEM_NOT_ASSIGNED)
    if payload.available is True:
        # The same position may differ between menus; any unsellable copy refuses all.
        for point_id in targets:
            if detail := unsellable_detail(having[point_id]):
                raise HTTPException(status_code=409, detail=detail)
    for point_id in targets:
        item = having[point_id]
        was_available = await effective_available(session, point_id, item)
        override = await write_override(
            session, point_id, item_key, {"available": payload.available}, current_user.id
        )
        await on_point_availability_changed(
            session,
            point_id=point_id,
            item_key=item_key,
            item_name=item.name,
            was_available=was_available,
            now_available=_available(item, override),
        )
    await session.commit()
    return BulkAvailabilityResponse(
        item_key=item_key, available=payload.available, point_ids=targets
    )
