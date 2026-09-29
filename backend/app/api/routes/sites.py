import hashlib
import json
import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.menus import point_has_published_menu_clause
from app.auth.dependencies import get_current_user
from app.auth.permissions import require_venue_admin
from app.config import Settings, get_settings
from app.database import get_session
from app.imports.storage import UploadValidationError
from app.media.images import media_url_restaurant_id
from app.models import Restaurant, RestaurantSite, User
from app.sites.contrast import ContrastIssue, contrast_issues
from app.sites.media import SiteImageKind, store_site_image
from app.sites.schemas import SiteConfig, default_site_config

router = APIRouter(tags=["site builder"])


class SiteDraftPayload(SiteConfig):
    expected_revision: str = Field(pattern="^[a-f0-9]{64}$", exclude=True)


class SitePublishPayload(BaseModel):
    expected_revision: str = Field(pattern="^[a-f0-9]{64}$")


def site_revision(config: dict) -> str:
    normalized = SiteConfig.model_validate(config).model_dump(mode="json")
    return hashlib.sha256(json.dumps(normalized, sort_keys=True).encode()).hexdigest()


def check_site_revision(site: RestaurantSite | None, expected: str) -> None:
    if site_revision(site.draft_config if site else default_site_config()) != expected:
        raise HTTPException(
            status_code=409,
            detail=("Оформление изменилось в другой вкладке. "
                    "Сохраните копию и загрузите актуальные данные."),
        )


class SiteDraftResponse(BaseModel):
    revision: str
    restaurant_id: uuid.UUID
    config: SiteConfig
    published_version: int
    published_at: datetime | None
    # Unreadable colour pairs: the draft is saved, publication is refused until fixed.
    contrast_issues: list[ContrastIssue] = Field(default_factory=list)


class SitePublishResponse(BaseModel):
    restaurant_id: uuid.UUID
    published_version: int
    published_at: datetime


class SiteMediaResponse(BaseModel):
    url: str
    width: int
    height: int
    size_bytes: int


async def require_site_access(
    session: AsyncSession,
    user: User,
    restaurant_id: uuid.UUID,
) -> None:
    await require_venue_admin(session, user.id, restaurant_id)


async def get_site(session: AsyncSession, restaurant_id: uuid.UUID) -> RestaurantSite | None:
    return await session.scalar(
        select(RestaurantSite).where(RestaurantSite.restaurant_id == restaurant_id)
    )


@router.post(
    "/restaurants/{restaurant_id}/site/media/{kind}",
    response_model=SiteMediaResponse,
    status_code=status.HTTP_201_CREATED,
)
async def upload_site_media(
    restaurant_id: uuid.UUID,
    kind: SiteImageKind,
    file: Annotated[UploadFile, File()],
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> SiteMediaResponse:
    await require_site_access(session, current_user, restaurant_id)
    try:
        stored = await store_site_image(
            file,
            settings.data_root,
            restaurant_id,
            kind,
            settings.max_site_image_bytes,
        )
    except UploadValidationError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(error),
        ) from error
    return SiteMediaResponse(
        url=stored.url,
        width=stored.width,
        height=stored.height,
        size_bytes=stored.size_bytes,
    )


@router.get("/restaurants/{restaurant_id}/site/draft", response_model=SiteDraftResponse)
async def get_site_draft(
    restaurant_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> SiteDraftResponse:
    await require_site_access(session, current_user, restaurant_id)
    site = await get_site(session, restaurant_id)
    return SiteDraftResponse(
        revision=site_revision(site.draft_config if site else default_site_config()),
        restaurant_id=restaurant_id,
        config=(config := SiteConfig.model_validate(
            site.draft_config if site else default_site_config()
        )),
        published_version=site.published_version if site else 0,
        published_at=site.published_at if site else None,
        contrast_issues=contrast_issues(config),
    )


@router.put("/restaurants/{restaurant_id}/site/draft", response_model=SiteDraftResponse)
async def save_site_draft(
    restaurant_id: uuid.UUID,
    payload: SiteDraftPayload,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> SiteDraftResponse:
    await require_site_access(session, current_user, restaurant_id)
    await session.scalar(select(Restaurant).where(Restaurant.id == restaurant_id).with_for_update())
    site = await get_site(session, restaurant_id)
    check_site_revision(site, payload.expected_revision)
    for url in [
        payload.logo_url,
        payload.cover_url,
        payload.background_image_url,
        *payload.gallery_urls,
    ]:
        if url and media_url_restaurant_id(url, "sites") != restaurant_id:
            raise HTTPException(status_code=422, detail="Изображение принадлежит другой точке")
    if site is None:
        site = RestaurantSite(
            restaurant_id=restaurant_id,
            draft_config=payload.model_dump(mode="json"),
            published_version=0,
        )
        session.add(site)
    else:
        site.draft_config = payload.model_dump(mode="json")
    site.updated_at = datetime.now().astimezone()
    await session.commit()
    await session.refresh(site)
    return SiteDraftResponse(
        revision=site_revision(site.draft_config if site else default_site_config()),
        restaurant_id=restaurant_id,
        config=(config := SiteConfig.model_validate(site.draft_config)),
        published_version=site.published_version,
        published_at=site.published_at,
        contrast_issues=contrast_issues(config),
    )


@router.post("/restaurants/{restaurant_id}/site/publish", response_model=SitePublishResponse)
async def publish_site(
    restaurant_id: uuid.UUID,
    payload: SitePublishPayload,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> SitePublishResponse:
    await require_site_access(session, current_user, restaurant_id)
    restaurant = await session.scalar(
        select(Restaurant).where(Restaurant.id == restaurant_id).with_for_update()
    )
    if restaurant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Restaurant not found")
    has_menu = await session.scalar(
        select(Restaurant.id).where(
            Restaurant.id == restaurant_id, point_has_published_menu_clause(Restaurant.id)
        )
    )
    if has_menu is None:
        raise HTTPException(status_code=409, detail="Сначала опубликуйте меню")
    site = await get_site(session, restaurant_id)
    if site is None:
        site = RestaurantSite(
            restaurant_id=restaurant_id,
            draft_config=default_site_config(),
            published_version=0,
        )
        session.add(site)
        await session.flush()

    check_site_revision(site, payload.expected_revision)
    config = SiteConfig.model_validate(site.draft_config)
    issues = contrast_issues(config)
    if issues:
        raise HTTPException(
            status_code=409,
            detail=f"Исправьте контраст: {issues[0].label.lower()} плохо читается",
        )
    published_at = datetime.now().astimezone()
    site.published_config = config.model_dump(mode="json")
    site.published_version += 1
    site.published_at = published_at
    await session.commit()
    return SitePublishResponse(
        restaurant_id=restaurant_id,
        published_version=site.published_version,
        published_at=published_at,
    )
