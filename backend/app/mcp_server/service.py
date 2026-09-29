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
from app.api.routes.sites import get_site, site_revision
from app.auth.permissions import is_venue_admin
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
    RestaurantSite,
)
from app.sites.contrast import contrast_issues
from app.sites.design_plan import DESIGN_FIELDS, DESIGN_OPTIONS, DesignChangePlan
from app.sites.schemas import SiteConfig, default_site_config


def _argument_hash(value: object) -> str:
    payload = json.dumps(value, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(payload.encode()).hexdigest()


async def _authorize(session, actor: McpActor) -> Restaurant:
    allowed = await is_venue_admin(session, actor.user_id, actor.restaurant_id)
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
        if proposal.plan.get("kind") == "design":
            raise PermissionError("Это предложение по оформлению: используйте apply_design_change")
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
    if not ({"menu:read", "design:read"} & actor.scopes):
        raise PermissionError("Требуется scope menu:read или design:read")
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


# --- Design («Оформление») -------------------------------------------------------------------



def _design_view(config: SiteConfig) -> dict[str, object]:
    data = config.model_dump(mode="json")
    return {key: data[key] for key in DESIGN_FIELDS}


def _merged_config(raw: dict, changes: dict) -> SiteConfig:
    base = SiteConfig.model_validate(raw).model_dump(mode="json")
    return SiteConfig.model_validate({**base, **changes})


async def get_design_context(actor: McpActor) -> dict[str, object]:
    actor.require("design:read")
    async with SessionFactory() as session:
        restaurant = await _authorize(session, actor)
        site = await get_site(session, actor.restaurant_id)
        raw = site.draft_config if site else default_site_config()
        config = SiteConfig.model_validate(raw)
        revision = site_revision(raw)
        published_version = site.published_version if site else 0
        request_id = _audit(session, actor, "get_design_context", {}, "success")
        await session.commit()
    return {
        "request_id": str(request_id),
        "restaurant": restaurant.name,
        "revision": revision,
        "published_version": published_version,
        "design": _design_view(config),
        "options": DESIGN_OPTIONS,
        "rules": {
            "colors": "hex #RRGGBB",
            "font_scale": "0.9..1.15",
            "contrast": "text 4.5:1 on surface and background, accent 3:1 on surface",
            "publish": "not available through MCP: a person publishes in the cabinet",
        },
        "contrast_issues": [issue.model_dump() for issue in contrast_issues(config)],
    }


async def propose_design_change(
    actor: McpActor,
    expected_revision: str,
    plan: DesignChangePlan,
) -> dict[str, object]:
    actor.require("design:propose")
    settings = get_settings()
    changes = plan.patch.changes()
    if not changes:
        raise ValueError("В плане нет изменений оформления")
    async with SessionFactory() as session:
        await _authorize(session, actor)
        site = await get_site(session, actor.restaurant_id)
        raw = site.draft_config if site else default_site_config()
        if site_revision(raw) != expected_revision:
            raise ValueError("Оформление изменилось: перечитайте get_design_context")
        issues = contrast_issues(_merged_config(raw, changes))
        expires_at = datetime.now(UTC) + timedelta(seconds=settings.mcp_confirmation_ttl_seconds)
        proposal = MenuChangeProposal(
            restaurant_id=actor.restaurant_id,
            created_by_id=actor.user_id,
            expected_revision=expected_revision,
            plan={"kind": "design", "summary": plan.summary, "changes": changes},
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
            "propose_design_change",
            {"revision": expected_revision, "changes": changes},
            "success",
        )
        await session.commit()
    warnings = [*plan.warnings]
    warnings += [
        f"{issue.label}: контраст {issue.ratio}:1, нужно {issue.required}:1" for issue in issues
    ]
    return {
        "request_id": str(request_id),
        "proposal_id": str(proposal.id),
        "confirmation_token": confirmation_token,
        "expires_at": expires_at.isoformat(),
        "summary": plan.summary,
        "changes": changes,
        "warnings": warnings,
        "requires_user_confirmation": True,
    }


async def apply_design_change(
    actor: McpActor,
    confirmation_token: str,
    expected_revision: str,
) -> dict[str, object]:
    actor.require("design:write")
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
        if proposal.plan.get("kind") != "design":
            raise PermissionError("Это предложение по меню: используйте apply_menu_change")
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
        site = await get_site(session, actor.restaurant_id)
        raw = site.draft_config if site else default_site_config()
        if site_revision(raw) != expected_revision:
            raise ValueError("Оформление изменилось: создайте новое предложение")
        changes = {
            key: value for key, value in proposal.plan["changes"].items() if key in DESIGN_FIELDS
        }
        merged = _merged_config(raw, changes).model_dump(mode="json")
        if site is None:
            site = RestaurantSite(
                restaurant_id=actor.restaurant_id,
                draft_config=merged,
                published_version=0,
            )
            session.add(site)
        else:
            site.draft_config = merged
        site.updated_at = now
        revision = site_revision(merged)
        confirmation.used_at = now
        proposal.status = "applied"
        proposal.applied_at = now
        proposal.result_revision = revision
        request_id = _audit(
            session,
            actor,
            "apply_design_change",
            {"proposal_id": str(proposal.id), "revision": expected_revision},
            "success",
        )
        await session.commit()
    return {
        "request_id": str(request_id),
        "proposal_id": str(proposal.id),
        "revision": revision,
        "already_applied": False,
        "published": False,
        "note": "Изменения в черновике оформления. Опубликует человек в кабинете.",
    }
