import argparse
import asyncio
import uuid
from datetime import UTC, datetime, timedelta

from app.auth.permissions import has_restaurant_role
from app.database import SessionFactory
from app.mcp_server.security import ALLOWED_SCOPES, create_secret, hash_secret
from app.models import McpAccessToken


async def issue(args) -> str:
    restaurant_id = uuid.UUID(args.restaurant_id)
    user_id = uuid.UUID(args.user_id)
    scopes = sorted(set(args.scopes.split(",")))
    if not scopes or any(scope not in ALLOWED_SCOPES for scope in scopes):
        raise ValueError("Scopes: menu:read,menu:propose,menu:write")
    async with SessionFactory() as session:
        if not await has_restaurant_role(
            session,
            user_id,
            restaurant_id,
            {"owner", "manager", "editor"},
        ):
            raise ValueError("User has no access to the restaurant")
        secret = create_secret()
        session.add(
            McpAccessToken(
                token_hash=hash_secret(secret),
                client_id=args.client_id,
                restaurant_id=restaurant_id,
                user_id=user_id,
                scopes=scopes,
                expires_at=datetime.now(UTC) + timedelta(days=args.days),
            )
        )
        await session.commit()
        return secret


def main() -> None:
    parser = argparse.ArgumentParser(description="Issue one scoped MCP bearer token")
    parser.add_argument("--restaurant-id", required=True)
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--client-id", required=True)
    parser.add_argument(
        "--scopes",
        default="menu:read,menu:propose,menu:write",
    )
    parser.add_argument("--days", type=int, default=7, choices=range(1, 31))
    token = asyncio.run(issue(parser.parse_args()))
    print("Save this token now; only its SHA-256 hash is stored:")
    print(token)


if __name__ == "__main__":
    main()
