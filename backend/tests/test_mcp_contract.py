import uuid

import pytest
from mcp.server.auth.provider import AccessToken

from app.mcp_server.security import (
    McpActor,
    actor_from_access_token,
    create_secret,
    hash_secret,
)
from app.mcp_server.server import mcp


def test_mcp_secret_is_random_and_only_hash_is_storage_safe():
    first = create_secret()
    second = create_secret()

    assert first.startswith("mcp_")
    assert first != second
    assert len(hash_secret(first)) == 64
    assert first not in hash_secret(first)


def test_actor_rejects_missing_scope():
    actor = McpActor(
        access_token_id=uuid.uuid4(),
        restaurant_id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        client_id="test",
        scopes={"menu:read"},
    )

    actor.require("menu:read")
    with pytest.raises(PermissionError):
        actor.require("menu:write")


def test_actor_identity_comes_from_verified_token_claims():
    token_id = uuid.uuid4()
    restaurant_id = uuid.uuid4()
    user_id = uuid.uuid4()
    token = AccessToken(
        token="verified",
        client_id="ai-agent",
        scopes=["menu:read", "menu:propose"],
        claims={
            "access_token_id": str(token_id),
            "restaurant_id": str(restaurant_id),
            "user_id": str(user_id),
        },
    )

    actor = actor_from_access_token(token)

    assert actor.access_token_id == token_id
    assert actor.restaurant_id == restaurant_id
    assert actor.user_id == user_id
    assert "menu:propose" in actor.scopes


async def test_mcp_exposes_only_draft_tools_with_strict_plan_schema():
    tools = {tool.name: tool for tool in await mcp.list_tools()}

    assert set(tools) == {
        "get_menu_context",
        "propose_menu_change",
        "apply_menu_change",
        "get_change_result",
    }
    assert "publish" not in " ".join(tools)
    plan_schema = tools["propose_menu_change"].input_schema["$defs"]["MenuChangePlan"]
    assert plan_schema["additionalProperties"] is False
