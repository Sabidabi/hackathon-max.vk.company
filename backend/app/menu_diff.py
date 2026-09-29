"""Differences between two contents of one menu, matched by the stable ``item_key``.

Used for «Что изменилось» between versions and for the draft-vs-published summary of the
publish panel. Row IDs are ignored: they are regenerated on every save.
"""

import json
import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.menus import (
    MenuItemResponse,
    MenuSectionPayload,
    MenuSectionResponse,
    name_key,
    read_versions_sections,
)
from app.models import Menu, MenuVersion, User


class FieldChange(BaseModel):
    field: str
    before: object
    after: object


class DiffItem(BaseModel):
    item_key: uuid.UUID
    name: str
    section: str


class ChangedItem(DiffItem):
    changes: list[FieldChange]


class MenuDiff(BaseModel):
    added: list[DiffItem]
    removed: list[DiffItem]
    changed: list[ChangedItem]
    sections_added: list[str]
    sections_removed: list[str]
    total_changes: int


DIFF_FIELDS = (
    "name",
    "price_minor",
    "is_available",
    "description",
    "weight_text",
    "ingredients",
    "allergens",
    "image_url",
)


def _index(sections: list[MenuSectionResponse]) -> dict[uuid.UUID, tuple[str, MenuItemResponse]]:
    return {item.item_key: (section.name, item) for section in sections for item in section.items}


def diff_sections(
    before: list[MenuSectionResponse], after: list[MenuSectionResponse]
) -> MenuDiff:
    """What changed from ``before`` to ``after``: positions matched by ``item_key``."""
    old, new = _index(before), _index(after)
    added = [
        DiffItem(item_key=key, name=item.name, section=section)
        for key, (section, item) in new.items() if key not in old
    ]
    removed = [
        DiffItem(item_key=key, name=item.name, section=section)
        for key, (section, item) in old.items() if key not in new
    ]
    changed = []
    for key, (section, item) in new.items():
        if key not in old:
            continue
        old_section, old_item = old[key]
        changes = [
            FieldChange(field=field, before=getattr(old_item, field), after=getattr(item, field))
            for field in DIFF_FIELDS
            if getattr(old_item, field) != getattr(item, field)
        ]
        if old_section != section:
            changes.append(FieldChange(field="section", before=old_section, after=section))
        old_config = old_item.configuration.model_dump(mode="json")
        new_config = item.configuration.model_dump(mode="json")
        if json.dumps(old_config, sort_keys=True) != json.dumps(new_config, sort_keys=True):
            changes.append(FieldChange(field="configuration", before=old_config, after=new_config))
        if changes:
            changed.append(ChangedItem(
                item_key=key, name=item.name, section=section, changes=changes
            ))
    old_sections = [section.name for section in before]
    new_sections = [section.name for section in after]
    sections_added = [name for name in new_sections if name not in old_sections]
    sections_removed = [name for name in old_sections if name not in new_sections]
    return MenuDiff(
        added=added,
        removed=removed,
        changed=changed,
        sections_added=sections_added,
        sections_removed=sections_removed,
        total_changes=len(added) + len(removed) + len(changed),
    )


class PublicationAuthor(BaseModel):
    id: uuid.UUID
    display_name: str


class LastPublication(BaseModel):
    version: int
    published_at: datetime | None
    author: PublicationAuthor | None


class RevisionConflict(BaseModel):
    """Body of ``detail`` of a 409 on a stale draft revision (publish, draft save, restore).

    ``changes`` answers «что изменилось с версии, которую вы видели»: from the published
    version the client last saw (``seen_version``) to the current draft, i.e. what other
    admins published or saved since. It is absent when the client sent no known version.
    """

    code: Literal["revision_conflict"] = "revision_conflict"
    message: str
    menu_id: uuid.UUID
    current_revision: str
    last_publication: LastPublication | None
    seen_version: int | None
    changes: MenuDiff | None


async def revision_conflict(
    session: AsyncSession,
    *,
    draft_id: uuid.UUID,
    draft_sections: list[MenuSectionResponse],
    current_revision: str,
    seen_version: int | None,
    message: str,
) -> RevisionConflict:
    draft = await session.get(MenuVersion, draft_id)
    menu = await session.get(Menu, draft.menu_id)
    last_publication = None
    if menu.current_published_version_id is not None:
        row = (await session.execute(
            select(MenuVersion, User)
            .outerjoin(User, User.id == MenuVersion.created_by_id)
            .where(MenuVersion.id == menu.current_published_version_id)
        )).one_or_none()
        if row is not None:
            published, author = row
            last_publication = LastPublication(
                version=published.version,
                published_at=published.published_at,
                author=(
                    PublicationAuthor(id=author.id, display_name=author.display_name)
                    if author else None
                ),
            )
    changes = None
    if seen_version is not None:
        seen = await session.scalar(
            select(MenuVersion.id).where(
                MenuVersion.menu_id == menu.id,
                MenuVersion.version == seen_version,
                MenuVersion.status.in_(("published", "archived")),
            )
        )
        if seen is not None:
            seen_sections = (await read_versions_sections(session, [seen]))[seen]
            changes = diff_sections(seen_sections, draft_sections)
    return RevisionConflict(
        message=message,
        menu_id=menu.id,
        current_revision=current_revision,
        last_publication=last_publication,
        seen_version=seen_version,
        changes=changes,
    )


def client_sections(
    payload: list[MenuSectionPayload], server: list[MenuSectionResponse]
) -> list[MenuSectionResponse]:
    """The client's unsaved sections in diff form, keyed the way a draft save would key
    them: a known, not yet used ``item_key`` is kept; otherwise the position takes the key
    of the same «section + name» on the server or a new one. Duplicates never collapse."""
    by_name: dict[tuple[str, str, int], uuid.UUID] = {}
    seen: dict[tuple[str, str], int] = {}
    for section in server:
        for item in section.items:
            base = name_key(section.name, item.name)
            by_name[(*base, seen.get(base, 0))] = item.item_key
            seen[base] = seen.get(base, 0) + 1
    known = set(by_name.values())
    used: set[uuid.UUID] = set()
    result = []
    taken: dict[tuple[str, str], int] = {}
    for section in payload:
        items = []
        for item in section.items:
            base = name_key(section.name, item.name)
            occurrence = taken.get(base, 0)
            taken[base] = occurrence + 1
            key = item.item_key
            if key is None or key in used or key not in known:
                key = by_name.get((*base, occurrence))
            if key is None or key in used:
                key = uuid.uuid4()
            used.add(key)
            items.append(MenuItemResponse(
                **item.model_dump(exclude={"item_key"}), id=uuid.uuid4(), item_key=key
            ))
        result.append(MenuSectionResponse(id=uuid.uuid4(), name=section.name, items=items))
    return result
