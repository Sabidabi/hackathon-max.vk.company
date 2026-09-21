import uuid

from mcp.server import MCPServer
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.settings import AuthSettings
from pydantic import AnyHttpUrl

from app.config import get_settings
from app.mcp_server.security import DatabaseTokenVerifier, actor_from_access_token
from app.mcp_server.service import (
    apply_menu_change as apply_menu_change_service,
)
from app.mcp_server.service import (
    get_change_result as get_change_result_service,
)
from app.mcp_server.service import (
    get_menu_context as get_menu_context_service,
)
from app.mcp_server.service import (
    propose_menu_change as propose_menu_change_service,
)
from app.menu_commands.schemas import MenuChangePlan

settings = get_settings()
mcp = MCPServer(
    "MAX Menu Editor",
    description="Safe draft-only tools for restaurant menus",
    version="0.1.0",
    token_verifier=DatabaseTokenVerifier(),
    auth=AuthSettings(
        issuer_url=AnyHttpUrl(settings.mcp_issuer_url),
        resource_server_url=AnyHttpUrl(settings.mcp_resource_url),
        required_scopes=[],
        validate_token_resource=True,
    ),
)


def _actor():
    return actor_from_access_token(get_access_token())


@mcp.tool()
async def get_menu_context() -> dict[str, object]:
    """Read the token-bound restaurant draft, revision and editing limits."""
    return await get_menu_context_service(_actor())


@mcp.tool()
async def propose_menu_change(
    expected_revision: str,
    plan: MenuChangePlan,
) -> dict[str, object]:
    """Validate a draft change and return a short-lived confirmation token."""
    return await propose_menu_change_service(_actor(), expected_revision, plan)


@mcp.tool()
async def apply_menu_change(
    confirmation_token: str,
    expected_revision: str,
) -> dict[str, object]:
    """Apply one confirmed proposal to the draft. This tool cannot publish."""
    return await apply_menu_change_service(_actor(), confirmation_token, expected_revision)


@mcp.tool()
async def get_change_result(proposal_id: uuid.UUID) -> dict[str, object]:
    """Read the status and resulting revision of a token-bound proposal."""
    return await get_change_result_service(_actor(), proposal_id)


app = mcp.streamable_http_app(
    json_response=True,
    stateless_http=True,
    max_request_body_size=1_048_576,
    max_sessions=100,
)
