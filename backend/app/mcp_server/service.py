import hashlib
import json
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.api.routes.menus import (
    check_revision,
    get_menu_and_draft,
    menu_revision,
    read_version_sections,
    write_version_sections,
)
from app.auth.permissions import has_restaurant_role
from app.config import get_settings
from app.database import SessionFactory
from app.mcp_server.security import McpActor, hash_secret
from app.menu_commands.schemas import MenuChangePlan
from app.menu_commands.service import apply_menu_change_plan
from app.models import (
    McpAuditEvent,
    McpConfirmation,
    MenuChangeProposal,
    Restaurant,
)


def _argument_hash(value: object) -> str:
    payload = json.dumps(value, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(payload.encode()).hexdigest()


async def _authorize(session, actor: McpActor) -> Restaurant:
    allowed = await has_restaurant_role(
        session,
        actor.user_id,
        actor.restaurant_id,
        {"owner", "manager", "editor"},
    )
    if not allowed:
        raise PermissionError("Точка недоступна этому токену")
    restaurant = await session.get(Restaurant, actor.restaurant_id)
    if restaurant is None:
        raise PermissionError("Точка не найдена")
    return restaurant


def _audit(
    session,
    actor: McpActor,
    tool: str,
    arguments: object,
    outcome: str,
) -> uuid.UUID:
    request_id = uuid.uuid4()
    event = McpAuditEvent(
        access_token_id=actor.access_token_id,
        restaurant_id=actor.restaurant_id,
        user_id=actor.user_id,
        tool=tool,
        argument_hash=_argument_hash(arguments),
        outcome=outcome,
        request_id=request_id,
    )
    session.add(event)
    return request_id


async def get_menu_context(actor: McpActor) -> dict[str, object]:
    actor.require("menu:read")
    async with SessionFactory() as session:
        restaurant = await _authorize(session, actor)
        _, draft = await get_menu_and_draft(session, actor.restaurant_id)
        sections = await read_version_sections(session, draft.id)
        request_id = _audit(session, actor, "get_menu_context", {}, "success")
        await session.commit()
    return {
        "request_id": str(request_id),
        "restaurant": restaurant.name,
        "revision": menu_revision(sections),
        "currency": "RUB",
        "limits": {"sections": 100, "items": 1000, "operations_per_plan": 20},
        "supported_operations": ["create_item"],
        "sections": [
            {
                "id": str(section.id),
                "name": section.name,
                "items": [
                    {
                        "id": str(item.id),
                        "name": item.name,
                        "from_price_minor": min(
                            [item.price_minor]
                            + [variant.price_minor for variant in item.configuration.variants]
                        ),
                    }
                    for item in section.items
                ],
            }
            for section in sections
        ],
    }


async def propose_menu_change(
    actor: McpActor,
    expected_revision: str,
    plan: MenuChangePlan,
) -> dict[str, object]:
    actor.require("menu:propose")
    settings = get_settings()
    async with SessionFactory() as session:
        await _authorize(session, actor)
        _, draft = await get_menu_and_draft(session, actor.restaurant_id)
        await check_revision(session, draft.id, expected_revision)
        current = await read_version_sections(session, draft.id)
        preview = apply_menu_change_plan(current, plan)
        expires_at = datetime.now(UTC) + timedelta(
            seconds=settings.mcp_confirmation_ttl_seconds
        )
        proposal = MenuChangeProposal(
            restaurant_id=actor.restaurant_id,
            created_by_id=actor.user_id,
            expected_revision=expected_revision,
            plan=plan.model_dump(mode="json"),
            status="pending",
            expires_at=expires_at,
        )
        session.add(proposal)
        await session.flush()
        confirmation_token = f"confirm_{secrets.token_urlsafe(32)}"
        session.add(
            McpConfirmation(
                proposal_id=proposal.id,
                token_hash=hash_secret(confirmation_token),
                expires_at=expires_at,
            )
        )
        request_id = _audit(
            session,
            actor,
            "propose_menu_change",
            {"revision": expected_revision, "plan": plan.model_dump(mode="json")},
            "success",
        )
        await session.commit()
    return {
        "request_id": str(request_id),
        "proposal_id": str(proposal.id),
        "confirmation_token": confirmation_token,
        "expires_at": expires_at.isoformat(),
        "summary": plan.summary,
        "warnings": plan.warnings,
        "result": {
            "section_count": len(preview),
            "item_count": sum(len(section.items) for section in preview),
        },
        "requires_user_confirmation": True,
    }


async def apply_menu_change(
    actor: McpActor,
    confirmation_token: str,
    expected_revision: str,
) -> dict[str, object]:
    actor.require("menu:write")
    now = datetime.now(UTC)
    async with SessionFactory() as session:
        await _authorize(session, actor)
        row = (
            await session.execute(
                select(McpConfirmation, MenuChangeProposal)
                .join(MenuChangeProposal, MenuChangeProposal.id == McpConfirmation.proposal_id)
                .where(
                    McpConfirmation.token_hash == hash_secret(confirmation_token),
                    MenuChangeProposal.restaurant_id == actor.restaurant_id,
                    MenuChangeProposal.created_by_id == actor.user_id,
                )
                .with_for_update()
            )
        ).one_or_none()
        if row is None:
            raise PermissionError("Подтверждение недействительно")
        confirmation, proposal = row
        if confirmation.used_at is not None and proposal.result_revision:
            return {
                "proposal_id": str(proposal.id),
                "revision": proposal.result_revision,
                "already_applied": True,
            }
        if confirmation.expires_at <= now or proposal.expires_at <= now:
            proposal.status = "expired"
            await session.commit()
            raise ValueError("Подтверждение устарело")
        if proposal.expected_revision != expected_revision:
            raise ValueError("Предложение создано для другой ревизии")
        menu, draft = await get_menu_and_draft(session, actor.restaurant_id, lock=True)
        await check_revision(session, draft.id, expected_revision)
        current = await read_version_sections(session, draft.id)
        plan = MenuChangePlan.model_validate(proposal.plan)
        await write_version_sections(session, draft.id, apply_menu_change_plan(current, plan))
        await session.flush()
        sections = await read_version_sections(session, draft.id)
        revision = menu_revision(sections)
        confirmation.used_at = now
        proposal.status = "applied"
        proposal.applied_at = now
        proposal.result_revision = revision
        menu.updated_at = now
        request_id = _audit(
            session,
            actor,
            "apply_menu_change",
            {"proposal_id": str(proposal.id), "revision": expected_revision},
            "success",
        )
        await session.commit()
    return {
        "request_id": str(request_id),
        "proposal_id": str(proposal.id),
        "revision": revision,
        "already_applied": False,
        "section_count": len(sections),
        "item_count": sum(len(section.items) for section in sections),
    }


async def get_change_result(actor: McpActor, proposal_id: uuid.UUID) -> dict[str, object]:
    actor.require("menu:read")
    async with SessionFactory() as session:
        await _authorize(session, actor)
        proposal = await session.scalar(
            select(MenuChangeProposal).where(
                MenuChangeProposal.id == proposal_id,
                MenuChangeProposal.restaurant_id == actor.restaurant_id,
                MenuChangeProposal.created_by_id == actor.user_id,
            )
        )
        if proposal is None:
            raise PermissionError("Предложение не найдено")
        request_id = _audit(
            session,
            actor,
            "get_change_result",
            {"proposal_id": str(proposal_id)},
            "success",
        )
        await session.commit()
    return {
        "request_id": str(request_id),
        "proposal_id": str(proposal.id),
        "status": proposal.status,
        "revision": proposal.result_revision,
        "expires_at": proposal.expires_at.isoformat(),
    }
