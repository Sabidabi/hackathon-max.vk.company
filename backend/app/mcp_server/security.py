import hashlib
import secrets
import uuid
from datetime import UTC, datetime

from mcp.server.auth.provider import AccessToken, TokenVerifier
from pydantic import BaseModel
from sqlalchemy import select

from app.config import get_settings
from app.database import SessionFactory
from app.models import McpAccessToken

ALLOWED_SCOPES = frozenset(
    {
        "menu:read",
        "menu:propose",
        "menu:write",
        "design:read",
        "design:propose",
        "design:write",
    }
)


def hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def create_secret() -> str:
    return f"mcp_{secrets.token_urlsafe(32)}"


class McpActor(BaseModel):
    access_token_id: uuid.UUID
    restaurant_id: uuid.UUID
    user_id: uuid.UUID
    client_id: str
    scopes: set[str]

    def require(self, scope: str) -> None:
        if scope not in self.scopes:
            raise PermissionError(f"Требуется scope {scope}")


class DatabaseTokenVerifier(TokenVerifier):
    async def verify_token(self, token: str) -> AccessToken | None:
        now = datetime.now(UTC)
        async with SessionFactory() as session:
            record = await session.scalar(
                select(McpAccessToken).where(McpAccessToken.token_hash == hash_secret(token))
            )
        if record is None or record.revoked_at is not None or record.expires_at <= now:
            return None
        scopes = [scope for scope in record.scopes if scope in ALLOWED_SCOPES]
        settings = get_settings()
        return AccessToken(
            token="verified",
            client_id=record.client_id,
            subject=str(record.user_id),
            scopes=scopes,
            expires_at=int(record.expires_at.timestamp()),
            resource=settings.mcp_resource_url,
            claims={
                "access_token_id": str(record.id),
                "restaurant_id": str(record.restaurant_id),
                "user_id": str(record.user_id),
            },
        )


def actor_from_access_token(token: AccessToken | None) -> McpActor:
    if token is None or token.claims is None:
        raise PermissionError("MCP access token is required")
    try:
        return McpActor(
            access_token_id=uuid.UUID(token.claims["access_token_id"]),
            restaurant_id=uuid.UUID(token.claims["restaurant_id"]),
            user_id=uuid.UUID(token.claims["user_id"]),
            client_id=token.client_id,
            scopes=set(token.scopes),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise PermissionError("MCP token identity is incomplete") from error
