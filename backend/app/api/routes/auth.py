from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.max_init_data import MaxInitDataError, MaxUserData, validate_max_init_data
from app.auth.service import create_auth_session, revoke_session, upsert_max_user
from app.config import Settings, get_settings
from app.database import get_session
from app.max_api.client import build_max_deep_link
from app.models import User

router = APIRouter(prefix="/auth", tags=["auth"])


class MaxLoginRequest(BaseModel):
    init_data: str = Field(min_length=1, max_length=16_384)


class UserResponse(BaseModel):
    id: str
    max_user_id: int
    display_name: str
    username: str | None
    language_code: str | None

    @classmethod
    def from_user(cls, user: User) -> "UserResponse":
        return cls(
            id=str(user.id),
            max_user_id=user.max_user_id,
            display_name=user.display_name,
            username=user.username,
            language_code=user.language_code,
        )


class AuthBootstrapResponse(BaseModel):
    max_auth_configured: bool
    development_auth: bool
    max_launch_url: str | None


@router.get("/bootstrap", response_model=AuthBootstrapResponse)
async def get_auth_bootstrap(
    settings: Annotated[Settings, Depends(get_settings)],
) -> AuthBootstrapResponse:
    """Return only public information needed to choose the login path."""
    return AuthBootstrapResponse(
        max_auth_configured=bool(settings.max_bot_token and settings.max_bot_username),
        development_auth=settings.app_env == "development" and settings.dev_auth_enabled,
        max_launch_url=build_max_deep_link(settings.max_bot_username),
    )


def set_session_cookie(
    response: Response,
    token: str,
    settings: Settings,
) -> None:
    response.set_cookie(
        key=settings.session_cookie_name,
        value=token,
        max_age=settings.session_ttl_seconds,
        httponly=True,
        secure=settings.app_env != "development",
        samesite="lax",
        path="/",
    )


@router.post("/max", response_model=UserResponse)
async def login_with_max(
    payload: MaxLoginRequest,
    response: Response,
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> UserResponse:
    if not settings.max_bot_token:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="MAX authentication is not configured",
        )

    try:
        validated = validate_max_init_data(
            payload.init_data,
            settings.max_bot_token,
            settings.max_init_data_max_age_seconds,
        )
    except MaxInitDataError as error:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid MAX authentication data",
        ) from error

    user = await upsert_max_user(session, validated.user)
    token, _ = await create_auth_session(session, user.id, settings.session_ttl_seconds)
    set_session_cookie(response, token, settings)
    return UserResponse.from_user(user)


@router.post("/dev", response_model=UserResponse)
async def login_for_development(
    response: Response,
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> UserResponse:
    if settings.app_env != "development" or not settings.dev_auth_enabled:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")

    user = await upsert_max_user(
        session,
        MaxUserData(
            id=settings.dev_max_user_id,
            first_name="Локальный",
            last_name="Разработчик",
            username="dev_user",
            language_code="ru",
        ),
    )
    token, _ = await create_auth_session(session, user.id, settings.session_ttl_seconds)
    set_session_cookie(response, token, settings)
    return UserResponse.from_user(user)


@router.get("/me", response_model=UserResponse)
async def get_me(current_user: Annotated[User, Depends(get_current_user)]) -> UserResponse:
    return UserResponse.from_user(current_user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    response: Response,
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    request: Request,
) -> None:
    session_token = request.cookies.get(settings.session_cookie_name)
    if session_token:
        await revoke_session(session, session_token)
    response.delete_cookie(settings.session_cookie_name, path="/")
