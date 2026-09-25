import hashlib
import io
import json
import uuid
from datetime import datetime
from typing import Annotated, Literal

import qrcode
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.notifications import enqueue_menu_published_notification
from app.auth.dependencies import get_current_user
from app.auth.permissions import has_restaurant_role
from app.config import Settings, get_settings
from app.database import get_session
from app.imports.storage import UploadValidationError
from app.max_api.client import build_max_deep_link
from app.media.images import clone_restaurant_image, media_url_restaurant_id, store_restaurant_image
from app.menu_configuration import (
    ItemConfiguration,
    QuotePayload,
    availability_error,
    calculate_unit_price,
)
from app.models import (
    Menu,
    MenuItem,
    MenuSection,
    MenuVersion,
    Restaurant,
    RestaurantSite,
    User,
)
from app.sites.schemas import SiteConfig, default_site_config

router = APIRouter(tags=["menus"])


class MenuItemPayload(BaseModel):
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


class DraftMenuPayload(BaseModel):
    expected_revision: str = Field(pattern="^[a-f0-9]{64}$")
    sections: list[MenuSectionPayload] = Field(default_factory=list, max_length=100)

    @field_validator("sections")
    @classmethod
    def limit_total_items(cls, value: list[MenuSectionPayload]) -> list[MenuSectionPayload]:
        if sum(len(section.items) for section in value) > 1000:
            raise ValueError("Menu cannot contain more than 1000 items")
        return value


class MenuItemResponse(MenuItemPayload):
    id: uuid.UUID


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


class CopyMenuPayload(BaseModel):
    source_version_id: uuid.UUID
    expected_revision: str = Field(pattern="^[a-f0-9]{64}$")


class MenuLibraryEntry(BaseModel):
    version_id: uuid.UUID
    restaurant_id: uuid.UUID
    restaurant_name: str
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


def menu_revision(sections: list[MenuSectionResponse]) -> str:
    # Include generated row IDs: each successful replacement advances the revision.
    content = [section.model_dump(mode="json") for section in sections]
    return hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()


async def check_revision(session: AsyncSession, draft_id: uuid.UUID, expected: str) -> None:
    if menu_revision(await read_version_sections(session, draft_id)) != expected:
        raise HTTPException(
            status_code=409,
            detail=(
                "Меню изменилось в другой вкладке или после импорта. "
                "Сохраните копию и загрузите актуальный черновик."
            ),
        )


class PublishResponse(BaseModel):
    published_version_id: uuid.UUID
    version: int
    section_count: int
    item_count: int
    public_id: str
    published_at: datetime


class MenuLinksResponse(BaseModel):
    public_menu_url: str
    max_deep_link: str | None


class MenuMediaResponse(BaseModel):
    url: str
    width: int
    height: int
    size_bytes: int


class PublicRestaurantResponse(BaseModel):
    public_id: str
    name: str
    description: str | None
    address: str | None


class PublicMenuResponse(BaseModel):
    restaurant: PublicRestaurantResponse
    site: SiteConfig
    version: int | None
    published_at: datetime | None
    sections: list[MenuSectionResponse]


async def require_menu_access(
    session: AsyncSession,
    user: User,
    restaurant_id: uuid.UUID,
) -> None:
    if not await has_restaurant_role(
        session,
        user.id,
        restaurant_id,
        {"owner", "manager", "editor"},
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Restaurant not found")


async def get_menu_and_draft(
    session: AsyncSession,
    restaurant_id: uuid.UUID,
    *,
    lock: bool = False,
) -> tuple[Menu, MenuVersion]:
    menu_statement = select(Menu).where(Menu.restaurant_id == restaurant_id)
    if lock:
        menu_statement = menu_statement.with_for_update()
    menu = await session.scalar(menu_statement)
    if menu is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Menu is missing")

    draft_statement = (
        select(MenuVersion)
        .where(MenuVersion.menu_id == menu.id, MenuVersion.status == "draft")
        .order_by(MenuVersion.version.desc())
        .limit(1)
    )
    if lock:
        draft_statement = draft_statement.with_for_update()
    draft = await session.scalar(draft_statement)
    if draft is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Draft is missing")
    return menu, draft


def validate_menu_image_ownership(
    restaurant_id: uuid.UUID,
    sections: list[MenuSectionPayload],
) -> None:
    for section in sections:
        for item in section.items:
            if item.image_url is None:
                continue
            image_restaurant_id = media_url_restaurant_id(item.image_url, "menu-items")
            if image_restaurant_id != restaurant_id:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="Menu item image belongs to another restaurant",
                )


async def read_version_sections(
    session: AsyncSession,
    version_id: uuid.UUID,
) -> list[MenuSectionResponse]:
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
    items_by_section: dict[uuid.UUID, list[MenuItemResponse]] = {
        section.id: [] for section in sections
    }
    for item in items:
        items_by_section[item.section_id].append(
            MenuItemResponse(
                id=item.id,
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
    return [
        MenuSectionResponse(
            id=section.id,
            name=section.name,
            items=items_by_section[section.id],
        )
        for section in sections
    ]


async def write_version_sections(
    session: AsyncSession,
    version_id: uuid.UUID,
    sections: list[MenuSectionPayload],
) -> None:
    await session.execute(delete(MenuSection).where(MenuSection.menu_version_id == version_id))
    await session.flush()
    for section_index, source_section in enumerate(sections):
        section = MenuSection(
            menu_version_id=version_id,
            name=source_section.name,
            sort_order=section_index,
        )
        session.add(section)
        await session.flush()
        for item_index, source_item in enumerate(source_section.items):
            session.add(
                MenuItem(
                    section_id=section.id,
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


@router.get("/menu/library", response_model=list[MenuLibraryEntry])
async def list_menu_library(
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[MenuLibraryEntry]:
    """Published snapshots owned by this user, reusable as menu templates."""
    rows = (await session.execute(
        select(MenuVersion, Restaurant)
        .join(Menu, MenuVersion.menu_id == Menu.id)
        .join(Restaurant, Menu.restaurant_id == Restaurant.id)
        .where(
            Restaurant.owner_id == current_user.id,
            MenuVersion.status.in_(("published", "archived")),
        )
        .order_by(MenuVersion.published_at.desc(), MenuVersion.version.desc())
        .limit(100)
    )).all()
    return [MenuLibraryEntry(
        version_id=version.id,
        restaurant_id=restaurant.id,
        restaurant_name=restaurant.name,
        version=version.version,
        published_at=version.published_at,
    ) for version, restaurant in rows]


@router.post("/restaurants/{restaurant_id}/menu/copy", response_model=DraftMenuResponse)
async def copy_menu_to_draft(
    restaurant_id: uuid.UUID,
    payload: CopyMenuPayload,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> DraftMenuResponse:
    target = await session.get(Restaurant, restaurant_id)
    if target is None or target.owner_id != current_user.id:
        raise HTTPException(status_code=404, detail="Restaurant not found")
    menu, draft = await get_menu_and_draft(session, restaurant_id, lock=True)
    await check_revision(session, draft.id, payload.expected_revision)
    source_row = (await session.execute(
        select(MenuVersion, Restaurant)
        .join(Menu, MenuVersion.menu_id == Menu.id)
        .join(Restaurant, Menu.restaurant_id == Restaurant.id)
        .where(
            MenuVersion.id == payload.source_version_id,
            MenuVersion.status.in_(("published", "archived")),
            Restaurant.owner_id == current_user.id,
        )
    )).one_or_none()
    if source_row is None:
        raise HTTPException(status_code=404, detail="Menu version not found")
    source_version, source_restaurant = source_row
    sections = await read_version_sections(session, source_version.id)
    copied_files = []
    try:
        copied_sections = []
        for section in sections:
            items = []
            for item in section.items:
                item_data = item.model_dump(mode="json", exclude={"id"})
                if item.image_url and source_restaurant.id != target.id:
                    item_data["image_url"], path = clone_restaurant_image(
                        item.image_url,
                        settings.data_root,
                        source_restaurant.id,
                        target.id,
                    )
                    copied_files.append(path)
                items.append(item_data)
            copied_sections.append(MenuSectionPayload.model_validate({
                "name": section.name, "items": items,
            }))
        validate_menu_image_ownership(restaurant_id, copied_sections)
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
    """Change matching items in selected draft menus as one transaction."""
    target_map = {target.restaurant_id: target for target in payload.targets}
    if len(target_map) != len(payload.targets):
        raise HTTPException(status_code=422, detail="Точка выбрана несколько раз")
    point_ids = set(target_map) | {restaurant_id}
    owned = (await session.scalars(select(Restaurant.id).where(
        Restaurant.id.in_(point_ids), Restaurant.owner_id == current_user.id,
    ))).all()
    if set(owned) != point_ids:
        raise HTTPException(status_code=404, detail="Restaurant not found")

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
        (section.name.strip().casefold(), item.name.strip().casefold())
        for section in source_sections for item in section.items
        if item.id == payload.source_item_id
    ), None)
    if source_key is None:
        raise HTTPException(status_code=404, detail="Позиция не найдена")

    matching_ids: dict[uuid.UUID, uuid.UUID] = {}
    for point_id in target_map:
        matches = [item.id for section in locked[point_id][2]
                   for item in section.items
                   if (section.name.strip().casefold(), item.name.strip().casefold()) == source_key]
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
    validate_menu_image_ownership(restaurant_id, payload.sections)
    menu, draft = await get_menu_and_draft(session, restaurant_id, lock=True)
    await check_revision(session, draft.id, payload.expected_revision)
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
    if not await has_restaurant_role(session, current_user.id, restaurant_id, {"owner", "manager"}):
        raise HTTPException(
            status_code=403, detail="Публиковать меню может владелец или управляющий"
        )
    restaurant = await session.scalar(select(Restaurant).where(Restaurant.id == restaurant_id))
    if restaurant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Restaurant not found")
    menu, draft = await get_menu_and_draft(session, restaurant_id, lock=True)
    await check_revision(session, draft.id, payload.expected_revision)
    source_sections = await read_version_sections(session, draft.id)
    item_count = sum(len(section.items) for section in source_sections)
    if not any(item.is_available for section in source_sections for item in section.items):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Добавьте хотя бы одну доступную позицию перед публикацией",
        )

    for section in source_sections:
        for item in section.items:
            error = availability_error(item.configuration)
            if item.is_available and error:
                raise HTTPException(status_code=409, detail=f"«{item.name}»: {error}")

    max_version_statement = select(func.max(MenuVersion.version)).where(
        MenuVersion.menu_id == menu.id
    )
    next_version = (await session.scalar(max_version_statement) or 0) + 1
    if menu.current_published_version_id is not None:
        previous = await session.get(MenuVersion, menu.current_published_version_id)
        if previous is not None:
            previous.status = "archived"

    published_at = datetime.now().astimezone()
    published = MenuVersion(
        menu_id=menu.id,
        version=next_version,
        status="published",
        created_by_id=current_user.id,
        published_at=published_at,
    )
    session.add(published)
    await session.flush()
    await write_version_sections(
        session,
        published.id,
        [
            MenuSectionPayload.model_validate(section.model_dump(exclude={"id"}))
            for section in source_sections
        ],
    )
    menu.current_published_version_id = published.id
    menu.updated_at = published_at
    await enqueue_menu_published_notification(
        session,
        restaurant=restaurant,
        menu_version_id=published.id,
        actor_id=current_user.id,
        item_count=item_count,
    )
    await session.commit()

    return PublishResponse(
        published_version_id=published.id,
        version=published.version,
        section_count=len(source_sections),
        item_count=item_count,
        public_id=restaurant.public_id,
        published_at=published_at,
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
    menu, _ = await get_menu_and_draft(session, restaurant_id)
    if menu.current_published_version_id is None:
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


@router.get("/public/restaurants/{public_id}/menu", response_model=PublicMenuResponse)
async def get_public_menu(
    public_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PublicMenuResponse:
    restaurant = await session.scalar(select(Restaurant).where(Restaurant.public_id == public_id))
    if restaurant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Menu not found")
    site = await session.get(RestaurantSite, restaurant.id)
    has_published_site = site is not None and site.published_config is not None
    menu = await session.scalar(select(Menu).where(Menu.restaurant_id == restaurant.id))
    version = (
        await session.get(MenuVersion, menu.current_published_version_id)
        if menu is not None and menu.current_published_version_id is not None
        else None
    )
    has_published_menu = (
        version is not None and version.status == "published" and version.published_at is not None
    )
    if not has_published_site and not has_published_menu:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Site not published")

    site_config = (
        site.published_config if has_published_site and site is not None else default_site_config()
    )
    return PublicMenuResponse(
        restaurant=PublicRestaurantResponse(
            public_id=restaurant.public_id,
            name=restaurant.name,
            description=restaurant.description,
            address=restaurant.address,
        ),
        site=SiteConfig.model_validate(site_config),
        version=version.version if has_published_menu and version is not None else None,
        published_at=(
            version.published_at
            if has_published_menu and version is not None
            else site.published_at
            if site is not None
            else None
        ),
        sections=(
            await read_version_sections(session, version.id)
            if has_published_menu and version is not None
            else []
        ),
    )


@router.post("/public/restaurants/{public_id}/menu/quote")
async def quote_menu_item(
    public_id: str, payload: QuotePayload, session: Annotated[AsyncSession, Depends(get_session)]
) -> dict:
    restaurant = await session.scalar(select(Restaurant).where(Restaurant.public_id == public_id))
    if restaurant is None:
        raise HTTPException(status_code=404, detail="Меню не найдено")
    menu = await session.scalar(select(Menu).where(Menu.restaurant_id == restaurant.id))
    if menu is None or menu.current_published_version_id is None:
        raise HTTPException(status_code=404, detail="Меню не опубликовано")
    item = await session.scalar(
        select(MenuItem)
        .join(MenuSection, MenuSection.id == MenuItem.section_id)
        .where(
            MenuSection.menu_version_id == menu.current_published_version_id,
            MenuItem.id == payload.item_id,
        )
    )
    if item is None or not item.is_available:
        raise HTTPException(status_code=409, detail="Позиция недоступна или меню обновилось")
    try:
        unit_price = calculate_unit_price(
            item.price_minor, ItemConfiguration.model_validate(item.configuration or {}), payload
        )
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return {
        "unit_price_minor": unit_price,
        "total_price_minor": unit_price * payload.quantity,
        "quantity": payload.quantity,
        "currency": "RUB",
        "published_version_id": str(menu.current_published_version_id),
    }
