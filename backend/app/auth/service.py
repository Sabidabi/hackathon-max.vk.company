import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.max_init_data import MaxUserData
from app.models import AuthSession, User


def hash_session_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


async def upsert_max_user(session: AsyncSession, max_user: MaxUserData) -> User:
    statement = (
        insert(User)
        .values(
            max_user_id=max_user.id,
            display_name=max_user.display_name,
            first_name=max_user.first_name,
            last_name=max_user.last_name,
            username=max_user.username,
            language_code=max_user.language_code,
            photo_url=max_user.photo_url,
        )
        .on_conflict_do_update(
            index_elements=[User.max_user_id],
            set_={
                "display_name": max_user.display_name,
                "first_name": max_user.first_name,
                "last_name": max_user.last_name,
                "username": max_user.username,
                "language_code": max_user.language_code,
                "photo_url": max_user.photo_url,
                "updated_at": func.now(),
            },
        )
        .returning(User)
    )
    user = (await session.execute(statement)).scalar_one()
    await session.commit()
    return user


async def create_auth_session(
    session: AsyncSession,
    user_id: uuid.UUID,
    ttl_seconds: int,
) -> tuple[str, datetime]:
    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(UTC) + timedelta(seconds=ttl_seconds)
    session.add(
        AuthSession(
            user_id=user_id,
            token_hash=hash_session_token(token),
            expires_at=expires_at,
        )
    )
    await session.commit()
    return token, expires_at


async def get_user_by_session_token(session: AsyncSession, token: str) -> User | None:
    statement = (
        select(User)
        .join(AuthSession, AuthSession.user_id == User.id)
        .where(
            AuthSession.token_hash == hash_session_token(token),
            AuthSession.expires_at > datetime.now(UTC),
        )
    )
    return await session.scalar(statement)


async def revoke_session(session: AsyncSession, token: str) -> None:
    await session.execute(
        delete(AuthSession).where(AuthSession.token_hash == hash_session_token(token))
    )
    await session.commit()
