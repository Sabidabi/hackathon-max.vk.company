"""Menu contents, drafts and publication; per-point routes kept for the current cabinet.

Menus belong to the venue library. The per-point routes under
``/restaurants/{id}/menu`` work with the point's *primary* menu — its first assignment —
so the existing cabinet keeps working until the frontend moves to the library API.
"""

import hashlib
import io
import json
import uuid
from collections.abc import Collection
from datetime import datetime
from typing import Annotated, Literal

import qrcode
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import ColumnElement, and_, delete, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.permissions import (
    is_venue_admin,
    require_admin_of_all,
    require_venue_admin,
)
from app.bot.events import on_menu_published
from app.config import Settings, get_settings
from app.database import get_session
from app.imports.storage import UploadValidationError
from app.max_api.client import build_max_deep_link
from app.media.images import clone_restaurant_image, media_url_restaurant_id, store_restaurant_image
from app.menu_configuration import ItemConfiguration, availability_error
from app.models import (
    Menu,
    MenuItem,
    MenuSection,
    MenuVersion,
    PointMenu,
    Restaurant,
    RestaurantSite,
    User,
    VenueMember,
)

router = APIRouter(tags=["menus"])


class MenuItemPayload(BaseModel):
    # Stable position identity; omitted for new positions. Unknown keys are replaced.
    item_key: uuid.UUID | None = None
    configuration: ItemConfiguration = Field(default_factory=ItemConfiguration)
    name: str = Field(min_length=1, max_length=250)
    description: str | None = Field(default=None, max_length=2000)
    price_minor: int = Field(strict=True, ge=0, le=100_000_000)
    currency: Literal["RUB"] = "RUB"
    weight_text: str | None = Field(default=None, max_length=100)
    ingredients: str | None = Field(default=None, max_length=4000)
    allergens: list[str] = Field(default_factory=list, max_length=50)
    image_url: str | None = Field(default=None, max_length=1000)
    is_available: bool = True
    source_confidence: float | None = Field(default=None, ge=0, le=1)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Item name cannot be empty")
        return value

    @field_validator("description", "weight_text", "ingredients")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        return value.strip() or None if value is not None else None

    @field_validator("allergens")
    @classmethod
    def normalize_allergens(cls, value: list[str]) -> list[str]:
        normalized: list[str] = []
        for allergen in value:
            cleaned = allergen.strip()[:100]
            if cleaned and cleaned not in normalized:
                normalized.append(cleaned)
        return normalized

    @field_validator("image_url")
    @classmethod
    def validate_image_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            return None
        if media_url_restaurant_id(value, "menu-items") is None:
            raise ValueError("Image URL must refer to an uploaded menu item image")
        return value


class MenuSectionPayload(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    items: list[MenuItemPayload] = Field(default_factory=list, max_length=300)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Section name cannot be empty")
        return value


# Published version the client last saw: a 409 then lists what changed since it.
SeenVersion = Annotated[int | None, Field(ge=1)]


class DraftMenuPayload(BaseModel):
    expected_revision: str = Field(pattern="^[a-f0-9]{64}$")
    seen_version: SeenVersion = None
    sections: list[MenuSectionPayload] = Field(default_factory=list, max_length=100)

    @field_validator("sections")
    @classmethod
    def limit_total_items(cls, value: list[MenuSectionPayload]) -> list[MenuSectionPayload]:
        if sum(len(section.items) for section in value) > 1000:
            raise ValueError("Menu cannot contain more than 1000 items")
        return value


class MenuItemResponse(MenuItemPayload):
    id: uuid.UUID
    # Always read from the database; the default only serves in-memory snapshots.
    item_key: uuid.UUID = Field(default_factory=uuid.uuid4)


class MenuSectionResponse(BaseModel):
    id: uuid.UUID
    name: str
    items: list[MenuItemResponse]


class DraftMenuResponse(BaseModel):
    menu_id: uuid.UUID
    draft_version_id: uuid.UUID
    sections: list[MenuSectionResponse]
    revision: str


class PublishPayload(BaseModel):
    expected_revision: str = Field(pattern="^[a-f0-9]{64}$")
    seen_version: SeenVersion = None
    # Required when the menu is shown at several points: exactly the assigned points.
    confirm_point_ids: list[uuid.UUID] | None = Field(default=None, max_length=200)


class CopyMenuPayload(BaseModel):
    source_version_id: uuid.UUID
    expected_revision: str = Field(pattern="^[a-f0-9]{64}$")


class MenuLibraryEntry(BaseModel):
    version_id: uuid.UUID
    restaurant_id: uuid.UUID
    restaurant_name: str
    menu_id: uuid.UUID
    menu_title: str
    version: int
    published_at: datetime | None


class AvailabilityTarget(BaseModel):
    restaurant_id: uuid.UUID
    expected_revision: str = Field(pattern="^[a-f0-9]{64}$")


class BulkAvailabilityPayload(BaseModel):
    source_item_id: uuid.UUID
    source_expected_revision: str = Field(pattern="^[a-f0-9]{64}$")
    is_available: bool
    targets: list[AvailabilityTarget] = Field(min_length=1, max_length=30)


class AvailabilityResult(BaseModel):
    restaurant_id: uuid.UUID
    revision: str


REVISION_CONFLICT_DETAIL = (
    "Меню изменилось в другой вкладке или после импорта. "
    "Сохраните копию и загрузите актуальный черновик."
)
POINTS_CONFIRMATION_DETAIL = (
    "Меню показывается в нескольких точках. Подтвердите актуальный список точек."
)


def menu_revision(sections: list[MenuSectionResponse]) -> str:
    # Include generated row IDs: each successful replacement advances the revision.
    content = [section.model_dump(mode="json") for section in sections]
    return hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()


async def check_revision(
    session: AsyncSession,
    draft_id: uuid.UUID,
    expected: str,
    *,
    seen_version: int | None = None,
) -> None:
    """409 on a stale draft revision with a structured ``detail`` (``RevisionConflict``):
    current revision, last publication and, when the client names the published version
    it last saw, what changed from it to the current draft. Nothing is written."""
    sections = await read_version_sections(session, draft_id)
    current = menu_revision(sections)
    if current == expected:
        return
    from app.menu_diff import revision_conflict  # menu_diff imports this module

    conflict = await revision_conflict(
        session,
        draft_id=draft_id,
        draft_sections=sections,
        current_revision=current,
        seen_version=seen_version,
        message=REVISION_CONFLICT_DETAIL,
    )
    raise HTTPException(status_code=409, detail=conflict.model_dump(mode="json"))


class PublishResponse(BaseModel):
    published_version_id: uuid.UUID
    version: int
    section_count: int
    item_count: int
    public_id: str
    published_at: datetime
    menu_id: uuid.UUID | None = None
    point_ids: list[uuid.UUID] = Field(default_factory=list)


class MenuLinksResponse(BaseModel):
    public_menu_url: str
    max_deep_link: str | None


class MenuMediaResponse(BaseModel):
    url: str
    width: int
    height: int
    size_bytes: int


async def require_menu_access(
    session: AsyncSession,
    user: User,
    restaurant_id: uuid.UUID,
) -> None:
    await require_venue_admin(session, user.id, restaurant_id)


async def get_draft(
    session: AsyncSession, menu_id: uuid.UUID, *, lock: bool = False
) -> MenuVersion:
    statement = (
        select(MenuVersion)
        .where(MenuVersion.menu_id == menu_id, MenuVersion.status == "draft")
        .order_by(MenuVersion.version.desc())
        .limit(1)
    )
    if lock:
        statement = statement.with_for_update()
    draft = await session.scalar(statement)
    if draft is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Draft is missing")
    return draft


async def create_menu_with_draft(
    session: AsyncSession, *, venue_id: uuid.UUID, title: str, actor_id: uuid.UUID
) -> tuple[Menu, MenuVersion]:
    menu = Menu(venue_id=venue_id, title=title, source="manual")
    session.add(menu)
    await session.flush()
    draft = MenuVersion(menu_id=menu.id, version=1, status="draft", created_by_id=actor_id)
    session.add(draft)
    await session.flush()
    return menu, draft


def primary_menu_statement(point_id: uuid.UUID):
    """The point's first assigned menu: the one the per-point cabinet routes edit."""
    return (
        select(Menu)
        .join(PointMenu, PointMenu.menu_id == Menu.id)
        .where(PointMenu.point_id == point_id)
        .order_by(PointMenu.sort_order)
        .limit(1)
    )


async def get_menu_and_draft(
    session: AsyncSession,
    restaurant_id: uuid.UUID,
    *,
    lock: bool = False,
) -> tuple[Menu, MenuVersion]:
    menu_statement = primary_menu_statement(restaurant_id)
    if lock:
        menu_statement = menu_statement.with_for_update(of=Menu)
    menu = await session.scalar(menu_statement)
    if menu is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Menu is missing")
    return menu, await get_draft(session, menu.id, lock=lock)


async def venue_point_ids(session: AsyncSession, venue_id: uuid.UUID) -> set[uuid.UUID]:
    return set(
        (await session.scalars(select(Restaurant.id).where(Restaurant.venue_id == venue_id))).all()
    )


async def menu_point_ids(session: AsyncSession, menu_id: uuid.UUID) -> list[uuid.UUID]:
    """Points showing this menu, oldest point first."""
    return list((await session.scalars(
        select(PointMenu.point_id)
        .join(Restaurant, Restaurant.id == PointMenu.point_id)
        .where(PointMenu.menu_id == menu_id)
        .order_by(Restaurant.created_at, Restaurant.id)
    )).all())


def validate_menu_image_ownership(
    allowed_point_ids: uuid.UUID | Collection[uuid.UUID],
    sections: list[MenuSectionPayload],
) -> None:
    """Images are stored per point; any point of the menu's venue may own them."""
    allowed = (
        {allowed_point_ids} if isinstance(allowed_point_ids, uuid.UUID) else set(allowed_point_ids)
    )
    for section in sections:
        for item in section.items:
            if item.image_url is None:
                continue
            if media_url_restaurant_id(item.image_url, "menu-items") not in allowed:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="Menu item image belongs to another restaurant",
                )


async def read_version_sections(
    session: AsyncSession,
    version_id: uuid.UUID,
) -> list[MenuSectionResponse]:
    return (await read_versions_sections(session, [version_id]))[version_id]


async def read_versions_sections(
    session: AsyncSession,
    version_ids: list[uuid.UUID],
) -> dict[uuid.UUID, list[MenuSectionResponse]]:
    """Sections with items of several versions in two queries, whatever their number."""
    result: dict[uuid.UUID, list[MenuSectionResponse]] = {
        version_id: [] for version_id in version_ids
    }
    if not version_ids:
        return result
    sections = (
        await session.scalars(
            select(MenuSection)
            .where(MenuSection.menu_version_id.in_(version_ids))
            .order_by(MenuSection.menu_version_id, MenuSection.sort_order)
        )
    ).all()
    if not sections:
        return result

    items = (
        await session.scalars(
            select(MenuItem)
            .where(MenuItem.section_id.in_([section.id for section in sections]))
            .order_by(MenuItem.section_id, MenuItem.sort_order)
        )
    ).all()
    items_by_section: dict[uuid.UUID, list[MenuItemResponse]] = {
        section.id: [] for section in sections
    }
    for item in items:
        items_by_section[item.section_id].append(
            MenuItemResponse(
                id=item.id,
                item_key=item.item_key,
                configuration=ItemConfiguration.model_validate(item.configuration or {}),
                name=item.name,
                description=item.description,
                price_minor=item.price_minor,
                currency=item.currency,
                weight_text=item.weight_text,
                ingredients=item.ingredients,
                allergens=item.allergens or [],
                image_url=item.image_path,
                is_available=item.is_available,
                source_confidence=(
                    float(item.source_confidence) if item.source_confidence is not None else None
                ),
            )
        )
    for section in sections:
        result[section.menu_version_id].append(
            MenuSectionResponse(
                id=section.id,
                name=section.name,
                items=items_by_section[section.id],
            )
        )
    return result


def name_key(section_name: str, item_name: str) -> tuple[str, str]:
    return section_name.strip().casefold(), item_name.strip().casefold()


async def _existing_keys(
    session: AsyncSession, version_id: uuid.UUID
) -> tuple[set[uuid.UUID], dict[tuple[str, str, int], uuid.UUID]]:
    rows = (await session.execute(
        select(MenuSection.name, MenuItem.name, MenuItem.item_key)
        .join(MenuItem, MenuItem.section_id == MenuSection.id)
        .where(MenuSection.menu_version_id == version_id)
        .order_by(MenuSection.sort_order, MenuItem.sort_order)
    )).all()
    by_name: dict[tuple[str, str, int], uuid.UUID] = {}
    seen: dict[tuple[str, str], int] = {}
    for section_name, item_name, key in rows:
        base = name_key(section_name, item_name)
        by_name[(*base, seen.get(base, 0))] = key
        seen[base] = seen.get(base, 0) + 1
    return {key for *_, key in rows}, by_name


async def write_version_sections(
    session: AsyncSession,
    version_id: uuid.UUID,
    sections: list[MenuSectionPayload],
    *,
    trust_keys: bool = False,
) -> None:
    """Replace a version's content, keeping each position's ``item_key``.

    A client key is kept only when the version already has it (``trust_keys`` is for
    internal copies such as publication and restore). A position without a usable key
    inherits the key of the same «section + name» in the previous content, otherwise
    gets a new one, so AI, MCP and the legacy cabinet keep stop-lists attached.
    """
    known_keys, keys_by_name = await _existing_keys(session, version_id)
    await session.execute(delete(MenuSection).where(MenuSection.menu_version_id == version_id))
    await session.flush()
    used: set[uuid.UUID] = set()
    seen: dict[tuple[str, str], int] = {}
    for section_index, source_section in enumerate(sections):
        section = MenuSection(
            menu_version_id=version_id,
            name=source_section.name,
            sort_order=section_index,
        )
        session.add(section)
        await session.flush()
        for item_index, source_item in enumerate(source_section.items):
            base = name_key(source_section.name, source_item.name)
            occurrence = seen.get(base, 0)
            seen[base] = occurrence + 1
            key = source_item.item_key
            if key is None or key in used or not (trust_keys or key in known_keys):
                key = keys_by_name.get((*base, occurrence))
            if key is None or key in used:
                key = uuid.uuid4()
            used.add(key)
            session.add(
                MenuItem(
                    section_id=section.id,
                    item_key=key,
                    name=source_item.name,
                    configuration=source_item.configuration.model_dump(mode="json"),
                    description=source_item.description,
                    price_minor=source_item.price_minor,
                    currency=source_item.currency,
                    weight_text=source_item.weight_text,
                    ingredients=source_item.ingredients,
                    allergens=source_item.allergens,
                    image_path=source_item.image_url,
                    is_available=source_item.is_available,
                    source_confidence=source_item.source_confidence,
                    sort_order=item_index,
                )
            )


def sections_as_payload(
    sections: list[MenuSectionResponse], *, keep_keys: bool = True
) -> list[MenuSectionPayload]:
    exclude = {"id"} if keep_keys else {"id", "item_key"}
    return [
        MenuSectionPayload.model_validate({
            "name": section.name,
            "items": [item.model_dump(exclude=exclude) for item in section.items],
        })
        for section in sections
    ]


class PublishProblem(BaseModel):
    """One reason the draft cannot be published; ``item_key`` points at the position."""

    code: Literal["empty", "no_price", "unavailable_config"]
    message: str
    item_key: uuid.UUID | None = None
    item_name: str | None = None
    section: str | None = None


NO_AVAILABLE_ITEMS = "Добавьте хотя бы одну доступную позицию перед публикацией"


def item_has_price(item: MenuItemPayload) -> bool:
    """A price is set on the position itself or on at least one available size."""
    if item.configuration.variants:
        return any(v.price_minor > 0 for v in item.configuration.variants if v.is_available)
    return item.price_minor > 0


def publish_problems(sections: list[MenuSectionResponse]) -> list[PublishProblem]:
    """Everything that blocks publication.

    Hidden positions (``is_available=False``) never block: the guest does not see them.
    """
    problems: list[PublishProblem] = []
    if not any(item.is_available for section in sections for item in section.items):
        problems.append(PublishProblem(code="empty", message=NO_AVAILABLE_ITEMS))
    for section in sections:
        for item in section.items:
            if not item.is_available:
                continue
            where = {"item_key": item.item_key, "item_name": item.name, "section": section.name}
            if not item_has_price(item):
                problems.append(
                    PublishProblem(code="no_price", message=f"«{item.name}»: укажите цену", **where)
                )
            error = availability_error(item.configuration)
            if error:
                problems.append(
                    PublishProblem(
                        code="unavailable_config", message=f"«{item.name}»: {error}", **where
                    )
                )
    return problems


def validate_publishable(sections: list[MenuSectionResponse]) -> None:
    problems = publish_problems(sections)
    if problems:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=problems[0].message)


async def publish_draft(
    session: AsyncSession,
    *,
    menu: Menu,
    draft: MenuVersion,
    actor: User,
    expected_revision: str,
    confirm_point_ids: list[uuid.UUID] | None,
    seen_version: int | None = None,
) -> tuple[MenuVersion, list[MenuSectionResponse], list[uuid.UUID]]:
    """Publish the draft as a new immutable version for every assigned point.

    The caller holds the lock on the menu and its draft. When the menu is shown at more
    than one point, ``confirm_point_ids`` must name exactly those points.
    """
    await check_revision(session, draft.id, expected_revision, seen_version=seen_version)
    source_sections = await read_version_sections(session, draft.id)
    validate_publishable(source_sections)
    point_ids = await menu_point_ids(session, menu.id)
    if confirm_point_ids is None:
        if len(point_ids) > 1:
            raise HTTPException(status_code=409, detail=POINTS_CONFIRMATION_DETAIL)
    elif set(confirm_point_ids) != set(point_ids) or len(confirm_point_ids) != len(point_ids):
        raise HTTPException(status_code=409, detail=POINTS_CONFIRMATION_DETAIL)

    next_version = (
        await session.scalar(
            select(func.max(MenuVersion.version)).where(MenuVersion.menu_id == menu.id)
        )
        or 0
    ) + 1
    previous_version_id = menu.current_published_version_id
    if menu.current_published_version_id is not None:
        previous = await session.get(MenuVersion, menu.current_published_version_id)
        if previous is not None:
            previous.status = "archived"

    published_at = datetime.now().astimezone()
    published = MenuVersion(
        menu_id=menu.id,
        version=next_version,
        status="published",
        created_by_id=actor.id,
        published_at=published_at,
    )
    session.add(published)
    await session.flush()
    await write_version_sections(
        session, published.id, sections_as_payload(source_sections), trust_keys=True
    )
    menu.current_published_version_id = published.id
    menu.updated_at = published_at
    # Guests (Г1, Г2) and the other admins (А3) learn about the publication, never a draft.
    await on_menu_published(
        session,
        menu=menu,
        previous_version_id=previous_version_id,
        published_version_id=published.id,
        actor=actor,
        point_ids=point_ids,
    )
    return published, source_sections, point_ids


@router.get("/menu/library", response_model=list[MenuLibraryEntry])
async def list_menu_library(
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[MenuLibraryEntry]:
    """Legacy: published snapshots of assigned menus in the user's venues, as templates."""
    first_point = (
        select(PointMenu.menu_id, PointMenu.point_id)
        .join(Restaurant, Restaurant.id == PointMenu.point_id)
        .order_by(PointMenu.menu_id, Restaurant.created_at, Restaurant.id)
        .distinct(PointMenu.menu_id)
        .subquery()
    )
    rows = (await session.execute(
        select(MenuVersion, Menu, Restaurant)
        .join(Menu, MenuVersion.menu_id == Menu.id)
        .join(first_point, first_point.c.menu_id == Menu.id)
        .join(Restaurant, Restaurant.id == first_point.c.point_id)
        .join(VenueMember, VenueMember.venue_id == Menu.venue_id)
        .where(
            VenueMember.user_id == current_user.id,
            MenuVersion.status.in_(("published", "archived")),
        )
        .order_by(MenuVersion.published_at.desc(), MenuVersion.version.desc())
        .limit(100)
    )).all()
    return [MenuLibraryEntry(
        version_id=version.id,
        restaurant_id=restaurant.id,
        restaurant_name=restaurant.name,
        menu_id=menu.id,
        menu_title=menu.title,
        version=version.version,
        published_at=version.published_at,
    ) for version, menu, restaurant in rows]


def clone_foreign_images(
    sections: list[MenuSectionPayload],
    allowed_point_ids: set[uuid.UUID],
    target_point_id: uuid.UUID,
    data_root,
) -> tuple[list[MenuSectionPayload], list]:
    """Copy images owned by points outside the target venue into the target point."""
    copied_files = []
    result = []
    for section in sections:
        items = []
        for item in section.items:
            item_data = item.model_dump(mode="json")
            owner = (
                media_url_restaurant_id(item.image_url, "menu-items") if item.image_url else None
            )
            if item.image_url and owner is not None and owner not in allowed_point_ids:
                item_data["image_url"], path = clone_restaurant_image(
                    item.image_url, data_root, owner, target_point_id
                )
                copied_files.append(path)
            items.append(item_data)
        result.append(MenuSectionPayload.model_validate({"name": section.name, "items": items}))
    return result, copied_files


@router.post("/restaurants/{restaurant_id}/menu/copy", response_model=DraftMenuResponse)
async def copy_menu_to_draft(
    restaurant_id: uuid.UUID,
    payload: CopyMenuPayload,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> DraftMenuResponse:
    """Legacy: replace the point's primary draft with a published version of any menu of
    the user's venues. Positions get new keys: the copy is an independent menu content."""
    target = await session.get(Restaurant, restaurant_id)
    if target is None or not await is_venue_admin(session, current_user.id, restaurant_id):
        raise HTTPException(status_code=404, detail="Restaurant not found")
    menu, draft = await get_menu_and_draft(session, restaurant_id, lock=True)
    await check_revision(session, draft.id, payload.expected_revision)
    source_version = await session.scalar(
        select(MenuVersion)
        .join(Menu, MenuVersion.menu_id == Menu.id)
        .join(VenueMember, VenueMember.venue_id == Menu.venue_id)
        .where(
            MenuVersion.id == payload.source_version_id,
            MenuVersion.status.in_(("published", "archived")),
            VenueMember.user_id == current_user.id,
        )
    )
    if source_version is None:
        raise HTTPException(status_code=404, detail="Menu version not found")
    sections = await read_version_sections(session, source_version.id)
    allowed = await venue_point_ids(session, target.venue_id)
    copied_files = []
    try:
        copied_sections, copied_files = clone_foreign_images(
            sections_as_payload(sections, keep_keys=False), allowed, target.id,
            settings.data_root,
        )
        validate_menu_image_ownership(allowed, copied_sections)
        await write_version_sections(session, draft.id, copied_sections)
        menu.updated_at = datetime.now().astimezone()
        await session.flush()
        result_sections = await read_version_sections(session, draft.id)
        await session.commit()
    except (FileNotFoundError, ValueError) as error:
        await session.rollback()
        for path in copied_files:
            path.unlink(missing_ok=True)
        raise HTTPException(status_code=409, detail=str(error)) from error
    except Exception:
        await session.rollback()
        for path in copied_files:
            path.unlink(missing_ok=True)
        raise
    return DraftMenuResponse(
        menu_id=menu.id,
        draft_version_id=draft.id,
        sections=result_sections,
        revision=menu_revision(result_sections),
    )


@router.post(
    "/restaurants/{restaurant_id}/menu/availability/bulk",
    response_model=list[AvailabilityResult],
)
async def set_bulk_availability(
    restaurant_id: uuid.UUID,
    payload: BulkAvailabilityPayload,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[AvailabilityResult]:
    """Legacy: change matching items in the selected points' primary drafts at once.

    The library API replaces this with the per-point stop-list, which needs no publish.
    """
    target_map = {target.restaurant_id: target for target in payload.targets}
    if len(target_map) != len(payload.targets):
        raise HTTPException(status_code=422, detail="Точка выбрана несколько раз")
    point_ids = set(target_map) | {restaurant_id}
    await require_admin_of_all(session, current_user.id, point_ids)

    locked: dict[uuid.UUID, tuple[Menu, MenuVersion, list[MenuSectionResponse]]] = {}
    for point_id in sorted(point_ids):
        menu, draft = await get_menu_and_draft(session, point_id, lock=True)
        sections = await read_version_sections(session, draft.id)
        expected = (
            target_map[point_id].expected_revision
            if point_id in target_map else payload.source_expected_revision
        )
        if point_id == restaurant_id and expected != payload.source_expected_revision:
            raise HTTPException(status_code=409, detail="Черновик исходной точки изменился")
        if menu_revision(sections) != expected:
            raise HTTPException(
                status_code=409, detail="Черновик изменился. Обновите меню и повторите."
            )
        locked[point_id] = menu, draft, sections

    source_sections = locked[restaurant_id][2]
    source_key = next((
        name_key(section.name, item.name)
        for section in source_sections for item in section.items
        if item.id == payload.source_item_id
    ), None)
    if source_key is None:
        raise HTTPException(status_code=404, detail="Позиция не найдена")

    matching_ids: dict[uuid.UUID, uuid.UUID] = {}
    for point_id in target_map:
        matches = [item.id for section in locked[point_id][2]
                   for item in section.items
                   if name_key(section.name, item.name) == source_key]
        if len(matches) != 1:
            raise HTTPException(
                status_code=409,
                detail=(
                    "В каждой выбранной точке должна быть ровно одна позиция "
                    "с этим названием и разделом"
                ),
            )
        matching_ids[point_id] = matches[0]

    for point_id, item_id in matching_ids.items():
        item = await session.get(MenuItem, item_id)
        if item is None:
            raise HTTPException(status_code=409, detail="Позиция изменилась. Обновите меню.")
        item.is_available = payload.is_available
        locked[point_id][0].updated_at = datetime.now().astimezone()
    await session.flush()
    results = [AvailabilityResult(
        restaurant_id=point_id,
        revision=menu_revision(await read_version_sections(session, locked[point_id][1].id)),
    ) for point_id in target_map]
    await session.commit()
    return results


@router.post(
    "/restaurants/{restaurant_id}/menu/media",
    response_model=MenuMediaResponse,
    status_code=status.HTTP_201_CREATED,
)
async def upload_menu_item_media(
    restaurant_id: uuid.UUID,
    file: Annotated[UploadFile, File()],
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> MenuMediaResponse:
    await require_menu_access(session, current_user, restaurant_id)
    try:
        stored = await store_restaurant_image(
            file,
            settings.data_root,
            restaurant_id,
            "menu-item",
            settings.max_site_image_bytes,
        )
    except UploadValidationError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(error),
        ) from error
    return MenuMediaResponse(
        url=stored.url,
        width=stored.width,
        height=stored.height,
        size_bytes=stored.size_bytes,
    )


@router.get(
    "/restaurants/{restaurant_id}/menu/draft",
    response_model=DraftMenuResponse,
)
async def get_draft_menu(
    restaurant_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DraftMenuResponse:
    await require_menu_access(session, current_user, restaurant_id)
    menu, draft = await get_menu_and_draft(session, restaurant_id, lock=True)
    sections = await read_version_sections(session, draft.id)
    return DraftMenuResponse(
        menu_id=menu.id,
        draft_version_id=draft.id,
        sections=sections,
        revision=menu_revision(sections),
    )


@router.put(
    "/restaurants/{restaurant_id}/menu/draft",
    response_model=DraftMenuResponse,
)
async def save_draft_menu(
    restaurant_id: uuid.UUID,
    payload: DraftMenuPayload,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DraftMenuResponse:
    await require_menu_access(session, current_user, restaurant_id)
    menu, draft = await get_menu_and_draft(session, restaurant_id, lock=True)
    await check_revision(
        session, draft.id, payload.expected_revision, seen_version=payload.seen_version
    )
    validate_menu_image_ownership(
        await venue_point_ids(session, menu.venue_id), payload.sections
    )
    await write_version_sections(session, draft.id, payload.sections)
    menu.updated_at = datetime.now().astimezone()
    await session.flush()
    sections = await read_version_sections(session, draft.id)
    await session.commit()
    return DraftMenuResponse(
        menu_id=menu.id,
        draft_version_id=draft.id,
        sections=sections,
        revision=menu_revision(sections),
    )


@router.post(
    "/restaurants/{restaurant_id}/menu/publish",
    response_model=PublishResponse,
)
async def publish_menu(
    restaurant_id: uuid.UUID,
    payload: PublishPayload,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> PublishResponse:
    await require_menu_access(session, current_user, restaurant_id)
    restaurant = await session.scalar(select(Restaurant).where(Restaurant.id == restaurant_id))
    if restaurant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Restaurant not found")
    menu, draft = await get_menu_and_draft(session, restaurant_id, lock=True)
    published, sections, point_ids = await publish_draft(
        session,
        menu=menu,
        draft=draft,
        actor=current_user,
        expected_revision=payload.expected_revision,
        confirm_point_ids=payload.confirm_point_ids,
        seen_version=payload.seen_version,
    )
    await session.commit()
    return PublishResponse(
        published_version_id=published.id,
        version=published.version,
        section_count=len(sections),
        item_count=sum(len(section.items) for section in sections),
        public_id=restaurant.public_id,
        published_at=published.published_at or datetime.now().astimezone(),
        menu_id=menu.id,
        point_ids=point_ids,
    )


@router.get(
    "/restaurants/{restaurant_id}/menu/links",
    response_model=MenuLinksResponse,
)
async def get_menu_links(
    restaurant_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> MenuLinksResponse:
    await require_menu_access(session, current_user, restaurant_id)
    restaurant = await session.scalar(select(Restaurant).where(Restaurant.id == restaurant_id))
    if restaurant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Restaurant not found")
    payload = f"r_{restaurant.public_id}"
    return MenuLinksResponse(
        public_menu_url=f"{settings.public_app_url.rstrip('/')}/r/{restaurant.public_id}",
        max_deep_link=build_max_deep_link(settings.max_bot_username, payload),
    )


@router.get("/restaurants/{restaurant_id}/menu/qr")
async def get_menu_qr(
    restaurant_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
    target: Literal["web", "max"] = "web",
) -> Response:
    links = await get_menu_links(restaurant_id, session, current_user, settings)
    if not await point_has_published_menu(session, restaurant_id):
        raise HTTPException(status_code=409, detail="Сначала опубликуйте меню")
    url = links.max_deep_link if target == "max" else links.public_menu_url
    if not url:
        raise HTTPException(status_code=409, detail="Ссылка MAX ещё не настроена")
    output = io.BytesIO()
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=12, border=4)
    qr.add_data(url)
    qr.make(fit=True)
    qr.make_image(fill_color="black", back_color="white").save(output, format="PNG")
    return Response(
        content=output.getvalue(),
        media_type="image/png",
        headers={
            "Content-Disposition": f'attachment; filename="menu-{restaurant_id}-{target}.png"',
            "Cache-Control": "private, no-store",
        },
    )


def is_published_menu_version(version: MenuVersion | None) -> bool:
    return (
        version is not None and version.status == "published" and version.published_at is not None
    )


def is_published_site(site: RestaurantSite | None) -> bool:
    return site is not None and site.published_config is not None


def point_has_published_menu_clause(point_id_column) -> ColumnElement[bool]:
    """A live (not archived) menu with a published version is assigned to the point."""
    return exists().where(
        PointMenu.point_id == point_id_column,
        Menu.id == PointMenu.menu_id,
        Menu.archived_at.is_(None),
        MenuVersion.id == Menu.current_published_version_id,
        and_(MenuVersion.status == "published", MenuVersion.published_at.is_not(None)),
    )


async def point_has_published_menu(session: AsyncSession, point_id: uuid.UUID) -> bool:
    found = await session.scalar(
        select(Restaurant.id).where(
            Restaurant.id == point_id, point_has_published_menu_clause(Restaurant.id)
        )
    )
    return found is not None


def published_restaurant_clause() -> ColumnElement[bool]:
    """SQL twin of the visibility rule of the public menu: a point is public once it has a
    published assigned menu or a published design. Everything else answers 404."""
    has_published_site = exists().where(
        RestaurantSite.restaurant_id == Restaurant.id,
        func.jsonb_typeof(RestaurantSite.published_config) != "null",
    )
    return or_(has_published_site, point_has_published_menu_clause(Restaurant.id))
