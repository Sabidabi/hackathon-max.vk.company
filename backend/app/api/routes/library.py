"""Menu library of a venue: menus, their drafts, copies and publication to the assigned
points (P1-DOC-15). Publishing requires the admin to confirm exactly the points that will
show the new version; a stale draft revision answers 409 and nothing is lost.
"""

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.me import count_unpublished_changes
from app.api.routes.menus import (
    DraftMenuPayload,
    DraftMenuResponse,
    MenuSectionResponse,
    SeenVersion,
    check_revision,
    create_menu_with_draft,
    get_draft,
    menu_point_ids,
    menu_revision,
    publish_draft,
    read_version_sections,
    read_versions_sections,
    sections_as_payload,
    validate_menu_image_ownership,
    venue_point_ids,
    write_version_sections,
)
from app.auth.dependencies import get_current_user
from app.auth.permissions import require_admin_of_venue, require_menu_admin
from app.database import get_session
from app.models import Menu, MenuVersion, PointMenu, User

router = APIRouter(tags=["menu library"])

MAX_MENUS_PER_VENUE = 50


class MenuTitle(BaseModel):
    title: str = Field(min_length=1, max_length=120)

    @field_validator("title")
    @classmethod
    def strip_title(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Название меню не может быть пустым")
        return value


class MenuUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    archived: bool | None = None

    @field_validator("title")
    @classmethod
    def strip_title(cls, value: str | None) -> str | None:
        if value is None:
            raise ValueError("Название меню не может быть пустым")
        value = value.strip()
        if not value:
            raise ValueError("Название меню не может быть пустым")
        return value


class MenuSummary(BaseModel):
    id: uuid.UUID
    venue_id: uuid.UUID
    title: str
    source: str
    archived_at: datetime | None
    point_ids: list[uuid.UUID]
    draft_version_id: uuid.UUID | None
    current_published_version_id: uuid.UUID | None
    published_version: int | None
    published_at: datetime | None
    unpublished_changes: int
    updated_at: datetime


class MenuPublishPayload(BaseModel):
    expected_revision: str = Field(pattern="^[a-f0-9]{64}$")
    seen_version: SeenVersion = None
    # Confirmation: exactly the points that will show the new version (may be empty).
    point_ids: list[uuid.UUID] = Field(max_length=200)


class MenuPublishResponse(BaseModel):
    menu_id: uuid.UUID
    published_version_id: uuid.UUID
    version: int
    section_count: int
    item_count: int
    published_at: datetime
    point_ids: list[uuid.UUID]


async def menu_summaries(session: AsyncSession, menus: list[Menu]) -> list[MenuSummary]:
    """Summaries in a fixed number of queries, however many menus the venue has."""
    if not menus:
        return []
    menu_ids = [menu.id for menu in menus]
    drafts = {row.menu_id: row.id for row in (await session.execute(
        select(MenuVersion.menu_id, MenuVersion.id)
        .where(MenuVersion.menu_id.in_(menu_ids), MenuVersion.status == "draft")
        .order_by(MenuVersion.menu_id, MenuVersion.version.desc())
        .distinct(MenuVersion.menu_id)
    )).all()}
    published = {
        version.id: version
        for version in (await session.scalars(
            select(MenuVersion).where(
                MenuVersion.id.in_([
                    menu.current_published_version_id for menu in menus
                    if menu.current_published_version_id is not None
                ])
            )
        )).all()
    }
    points: dict[uuid.UUID, list[uuid.UUID]] = {}
    for row in (await session.execute(
        select(PointMenu.menu_id, PointMenu.point_id)
        .where(PointMenu.menu_id.in_(menu_ids))
        .order_by(PointMenu.menu_id, PointMenu.created_at)
    )).all():
        points.setdefault(row.menu_id, []).append(row.point_id)
    sections = await read_versions_sections(session, [*drafts.values(), *published])
    summaries = []
    for menu in menus:
        draft_id = drafts.get(menu.id)
        version = published.get(menu.current_published_version_id)
        summaries.append(MenuSummary(
            id=menu.id,
            venue_id=menu.venue_id,
            title=menu.title,
            source=menu.source,
            archived_at=menu.archived_at,
            point_ids=points.get(menu.id, []),
            draft_version_id=draft_id,
            current_published_version_id=menu.current_published_version_id,
            published_version=version.version if version else None,
            published_at=version.published_at if version else None,
            unpublished_changes=count_unpublished_changes(
                sections[draft_id] if draft_id else [],
                sections[version.id] if version else [],
            ),
            updated_at=menu.updated_at,
        ))
    return summaries


async def menu_summary(session: AsyncSession, menu: Menu) -> MenuSummary:
    return (await menu_summaries(session, [menu]))[0]


@router.get("/venues/{venue_id}/menus", response_model=list[MenuSummary])
async def list_venue_menus(
    venue_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
    include_archived: Annotated[bool, Query()] = False,
) -> list[MenuSummary]:
    await require_admin_of_venue(session, current_user.id, venue_id)
    statement = select(Menu).where(Menu.venue_id == venue_id).order_by(Menu.created_at, Menu.id)
    if not include_archived:
        statement = statement.where(Menu.archived_at.is_(None))
    return await menu_summaries(session, list((await session.scalars(statement)).all()))


@router.post(
    "/venues/{venue_id}/menus",
    response_model=MenuSummary,
    status_code=status.HTTP_201_CREATED,
)
async def create_venue_menu(
    venue_id: uuid.UUID,
    payload: MenuTitle,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> MenuSummary:
    await require_admin_of_venue(session, current_user.id, venue_id)
    await ensure_menu_capacity(session, venue_id)
    menu, _ = await create_menu_with_draft(
        session, venue_id=venue_id, title=payload.title, actor_id=current_user.id
    )
    await session.commit()
    await session.refresh(menu)
    return await menu_summary(session, menu)


async def ensure_menu_capacity(session: AsyncSession, venue_id: uuid.UUID) -> None:
    count = await session.scalar(
        select(func.count()).select_from(Menu).where(Menu.venue_id == venue_id)
    )
    if (count or 0) >= MAX_MENUS_PER_VENUE:
        raise HTTPException(status_code=409, detail="В заведении слишком много меню")


@router.get("/menus/{menu_id}", response_model=MenuSummary)
async def get_menu(
    menu_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> MenuSummary:
    return await menu_summary(session, await require_menu_admin(session, current_user.id, menu_id))


@router.patch("/menus/{menu_id}", response_model=MenuSummary)
async def update_menu(
    menu_id: uuid.UUID,
    payload: MenuUpdate,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> MenuSummary:
    """Rename or archive. An assigned menu is not archived: unassign it first."""
    menu = await require_menu_admin(session, current_user.id, menu_id, lock=True)
    updates = payload.model_dump(exclude_unset=True)
    if "title" in updates:
        menu.title = updates["title"]
    if updates.get("archived") is True and menu.archived_at is None:
        if await menu_point_ids(session, menu.id):
            raise HTTPException(
                status_code=409, detail="Меню показывается в точках. Сначала снимите назначение."
            )
        menu.archived_at = datetime.now().astimezone()
    elif updates.get("archived") is False:
        menu.archived_at = None
    await session.commit()
    await session.refresh(menu)
    return await menu_summary(session, menu)


@router.post(
    "/menus/{menu_id}/copy",
    response_model=MenuSummary,
    status_code=status.HTTP_201_CREATED,
)
async def copy_menu(
    menu_id: uuid.UUID,
    payload: MenuTitle,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> MenuSummary:
    """«Сделать копию»: an independent manual menu whose draft copies the source draft.

    Positions get new keys, so the copy shares no stop-list or external IDs with the
    source; images stay (they belong to points of the same venue).
    """
    source = await require_menu_admin(session, current_user.id, menu_id)
    await ensure_menu_capacity(session, source.venue_id)
    source_sections = await read_version_sections(session, (await get_draft(session, source.id)).id)
    copy, draft = await create_menu_with_draft(
        session, venue_id=source.venue_id, title=payload.title, actor_id=current_user.id
    )
    await write_version_sections(
        session, draft.id, sections_as_payload(source_sections, keep_keys=False)
    )
    await session.commit()
    await session.refresh(copy)
    return await menu_summary(session, copy)


def draft_response(
    menu: Menu, draft: MenuVersion, sections: list[MenuSectionResponse]
) -> DraftMenuResponse:
    return DraftMenuResponse(
        menu_id=menu.id,
        draft_version_id=draft.id,
        sections=sections,
        revision=menu_revision(sections),
    )


@router.get("/menus/{menu_id}/draft", response_model=DraftMenuResponse)
async def get_menu_draft(
    menu_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DraftMenuResponse:
    menu = await require_menu_admin(session, current_user.id, menu_id)
    draft = await get_draft(session, menu.id)
    return draft_response(menu, draft, await read_version_sections(session, draft.id))


@router.put("/menus/{menu_id}/draft", response_model=DraftMenuResponse)
async def save_menu_draft(
    menu_id: uuid.UUID,
    payload: DraftMenuPayload,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DraftMenuResponse:
    menu = await require_menu_admin(session, current_user.id, menu_id, lock=True)
    draft = await get_draft(session, menu.id, lock=True)
    validate_menu_image_ownership(await venue_point_ids(session, menu.venue_id), payload.sections)
    await check_revision(
        session, draft.id, payload.expected_revision, seen_version=payload.seen_version
    )
    await write_version_sections(session, draft.id, payload.sections)
    menu.updated_at = datetime.now().astimezone()
    await session.flush()
    sections = await read_version_sections(session, draft.id)
    await session.commit()
    return draft_response(menu, draft, sections)


@router.post("/menus/{menu_id}/publish", response_model=MenuPublishResponse)
async def publish_library_menu(
    menu_id: uuid.UUID,
    payload: MenuPublishPayload,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> MenuPublishResponse:
    """One publication updates every assigned point, after the admin confirmed them."""
    menu = await require_menu_admin(session, current_user.id, menu_id, lock=True)
    if menu.archived_at is not None:
        raise HTTPException(status_code=409, detail="Архивное меню нельзя опубликовать")
    draft = await get_draft(session, menu.id, lock=True)
    published, sections, point_ids = await publish_draft(
        session,
        menu=menu,
        draft=draft,
        actor=current_user,
        expected_revision=payload.expected_revision,
        confirm_point_ids=payload.point_ids,
        seen_version=payload.seen_version,
    )
    await session.commit()
    return MenuPublishResponse(
        menu_id=menu.id,
        published_version_id=published.id,
        version=published.version,
        section_count=len(sections),
        item_count=sum(len(section.items) for section in sections),
        published_at=published.published_at,
        point_ids=point_ids,
    )
