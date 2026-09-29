"""Version history of a library menu: list, «Что изменилось» and «Вернуть эту версию».

Restore only rewrites the draft (with a revision check); the history is never changed and
a restored version reaches guests only after an explicit publication.
"""

import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.library import draft_response
from app.api.routes.menus import (
    DraftMenuResponse,
    MenuSectionPayload,
    PublishProblem,
    SeenVersion,
    check_revision,
    get_draft,
    menu_revision,
    publish_problems,
    read_version_sections,
    read_versions_sections,
    sections_as_payload,
    write_version_sections,
)
from app.auth.dependencies import get_current_user
from app.auth.permissions import require_menu_admin
from app.database import get_session
from app.menu_diff import MenuDiff, client_sections, diff_sections
from app.menu_templates import TemplateKey, template_sections
from app.models import Menu, MenuVersion, User

router = APIRouter(tags=["menu versions"])


class RestorePayload(BaseModel):
    expected_revision: str = Field(pattern="^[a-f0-9]{64}$")
    seen_version: SeenVersion = None


class VersionAuthor(BaseModel):
    id: uuid.UUID
    display_name: str


class VersionEntry(BaseModel):
    version_id: uuid.UUID
    version: int
    status: Literal["published", "archived"]
    is_current: bool
    published_at: datetime | None
    author: VersionAuthor
    item_count: int


class VersionDiffResponse(BaseModel):
    menu_id: uuid.UUID
    from_version: str
    to_version: str
    diff: MenuDiff


@router.get("/menus/{menu_id}/versions", response_model=list[VersionEntry])
async def list_menu_versions(
    menu_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[VersionEntry]:
    """Published history, newest first: number, date, author and size."""
    menu = await require_menu_admin(session, current_user.id, menu_id)
    rows = (await session.execute(
        select(MenuVersion, User)
        .join(User, User.id == MenuVersion.created_by_id)
        .where(
            MenuVersion.menu_id == menu.id,
            MenuVersion.status.in_(("published", "archived")),
        )
        .order_by(MenuVersion.version.desc())
        .limit(100)
    )).all()
    sections = await read_versions_sections(session, [version.id for version, _ in rows])
    return [
        VersionEntry(
            version_id=version.id,
            version=version.version,
            status=version.status,
            is_current=version.id == menu.current_published_version_id,
            published_at=version.published_at,
            author=VersionAuthor(id=author.id, display_name=author.display_name),
            item_count=sum(len(section.items) for section in sections[version.id]),
        )
        for version, author in rows
    ]


async def resolve_version(session: AsyncSession, menu: Menu, ref: str) -> MenuVersion | None:
    """``draft``, ``published`` (may be absent: an empty menu) or a published number."""
    if ref == "draft":
        return await get_draft(session, menu.id)
    if ref == "published":
        if menu.current_published_version_id is None:
            return None
        return await session.get(MenuVersion, menu.current_published_version_id)
    if not ref.isdigit():
        raise HTTPException(status_code=422, detail="Версия: номер, draft или published")
    version = await session.scalar(
        select(MenuVersion).where(
            MenuVersion.menu_id == menu.id,
            MenuVersion.version == int(ref),
            MenuVersion.status.in_(("published", "archived")),
        )
    )
    if version is None:
        raise HTTPException(status_code=404, detail="Версия не найдена")
    return version


@router.get(
    "/menus/{menu_id}/versions/{from_ref}/diff/{to_ref}",
    response_model=VersionDiffResponse,
)
async def diff_menu_versions(
    menu_id: uuid.UUID,
    from_ref: Annotated[str, Path(max_length=12)],
    to_ref: Annotated[str, Path(max_length=12)],
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> VersionDiffResponse:
    """«Что изменилось»: e.g. ``6/diff/7`` or ``published/diff/draft`` for the publish panel."""
    menu = await require_menu_admin(session, current_user.id, menu_id)
    before = await resolve_version(session, menu, from_ref)
    after = await resolve_version(session, menu, to_ref)
    ids = [version.id for version in (before, after) if version is not None]
    sections = await read_versions_sections(session, ids)
    return VersionDiffResponse(
        menu_id=menu.id,
        from_version=from_ref,
        to_version=to_ref,
        diff=diff_sections(
            sections[before.id] if before else [], sections[after.id] if after else []
        ),
    )


@router.post("/menus/{menu_id}/versions/{version}/restore", response_model=DraftMenuResponse)
async def restore_menu_version(
    menu_id: uuid.UUID,
    version: int,
    payload: RestorePayload,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DraftMenuResponse:
    """«Вернуть эту версию»: its content becomes the draft; history stays untouched and
    guests see it only after the next explicit publication."""
    menu = await require_menu_admin(session, current_user.id, menu_id, lock=True)
    draft = await get_draft(session, menu.id, lock=True)
    await check_revision(
        session, draft.id, payload.expected_revision, seen_version=payload.seen_version
    )
    source = await resolve_version(session, menu, str(version))
    sections = await read_version_sections(session, source.id)
    await write_version_sections(session, draft.id, sections_as_payload(sections), trust_keys=True)
    menu.updated_at = datetime.now().astimezone()
    await session.flush()
    result = await read_version_sections(session, draft.id)
    await session.commit()
    return draft_response(menu, draft, result)


class ClientDiffPayload(BaseModel):
    """The client's unsaved sections, e.g. kept after a 409, compared with the server."""

    sections: list[MenuSectionPayload] = Field(default_factory=list, max_length=100)
    against: Literal["draft", "published"] = "draft"


class ClientDiffResponse(BaseModel):
    menu_id: uuid.UUID
    against: str
    revision: str | None
    # From the client's sections to the server content: what the others changed, or
    # what the client would overwrite.
    diff: MenuDiff


@router.post("/menus/{menu_id}/diff", response_model=ClientDiffResponse)
async def diff_client_sections(
    menu_id: uuid.UUID,
    payload: ClientDiffPayload,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> ClientDiffResponse:
    """«Сводка расхождений» after a 409: the client's copy against the current draft or
    publication. Read-only: nothing is saved."""
    if sum(len(section.items) for section in payload.sections) > 1000:
        raise HTTPException(status_code=422, detail="Меню не может содержать больше 1000 позиций")
    menu = await require_menu_admin(session, current_user.id, menu_id)
    target = await resolve_version(session, menu, payload.against)
    server = (await read_version_sections(session, target.id)) if target else []
    return ClientDiffResponse(
        menu_id=menu.id,
        against=payload.against,
        revision=menu_revision(server) if payload.against == "draft" else None,
        diff=diff_sections(client_sections(payload.sections, server), server),
    )


class PublishCheckResponse(BaseModel):
    menu_id: uuid.UUID
    revision: str
    problems: list[PublishProblem]
    # Draft against the current publication: «Что изменится».
    diff: MenuDiff


@router.get("/menus/{menu_id}/publish-check", response_model=PublishCheckResponse)
async def check_menu_publication(
    menu_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> PublishCheckResponse:
    """The publish panel asks the server what would change and what blocks it. Read-only."""
    menu = await require_menu_admin(session, current_user.id, menu_id)
    draft = await get_draft(session, menu.id)
    published = await resolve_version(session, menu, "published")
    ids = [version.id for version in (draft, published) if version is not None]
    sections = await read_versions_sections(session, ids)
    draft_sections = sections[draft.id]
    return PublishCheckResponse(
        menu_id=menu.id,
        revision=menu_revision(draft_sections),
        problems=publish_problems(draft_sections),
        diff=diff_sections(sections[published.id] if published else [], draft_sections),
    )


class TemplatePayload(BaseModel):
    template: TemplateKey = "coffee"
    expected_revision: str = Field(pattern="^[a-f0-9]{64}$")


@router.post("/menus/{menu_id}/template", response_model=DraftMenuResponse)
async def apply_menu_template(
    menu_id: uuid.UUID,
    payload: TemplatePayload,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DraftMenuResponse:
    """«Шаблон кофейни»: sections and positions without prices appended to the draft only.
    Nothing is published; positions without a price block publication."""
    menu = await require_menu_admin(session, current_user.id, menu_id, lock=True)
    if menu.archived_at is not None:
        raise HTTPException(status_code=409, detail="Архивное меню нельзя изменить")
    draft = await get_draft(session, menu.id, lock=True)
    await check_revision(session, draft.id, payload.expected_revision)
    current = await read_version_sections(session, draft.id)
    sections = sections_as_payload(current) + template_sections(payload.template)
    if len(sections) > 100:
        raise HTTPException(status_code=422, detail="Слишком много разделов")
    await write_version_sections(session, draft.id, sections, trust_keys=True)
    menu.updated_at = datetime.now().astimezone()
    await session.flush()
    result = await read_version_sections(session, draft.id)
    await session.commit()
    return draft_response(menu, draft, result)
