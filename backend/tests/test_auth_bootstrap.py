from fastapi import Response

from app.api.routes.auth import get_auth_bootstrap, set_session_cookie
from app.config import Settings


async def test_bootstrap_exposes_safe_max_launch_configuration() -> None:
    result = await get_auth_bootstrap(
        Settings(
            app_env="production",
            max_bot_token="secret-token",
            max_bot_username="@MenuBot",
            dev_auth_enabled=True,
        )
    )

    assert result.max_auth_configured is True
    assert result.development_auth is False
    assert result.max_launch_url == "https://max.ru/MenuBot?startapp"
    assert "secret" not in result.model_dump_json()


async def test_development_bootstrap_enables_automatic_dev_session() -> None:
    result = await get_auth_bootstrap(Settings(app_env="development", dev_auth_enabled=True))

    assert result.development_auth is True
    assert result.max_auth_configured is False
    assert result.max_launch_url is None


async def test_bootstrap_includes_support_link_when_bot_configured() -> None:
    result = await get_auth_bootstrap(
        Settings(
            app_env="production",
            max_bot_token="secret-token",
            max_bot_username="@MenuBot",
            dev_auth_enabled=False,
        )
    )

    assert result.support_link == "https://max.ru/MenuBot?start=support"
    assert result.max_auth_configured is True


async def test_bootstrap_returns_null_support_link_without_bot() -> None:
    result = await get_auth_bootstrap(
        Settings(
            app_env="production",
            max_bot_token="",
            max_bot_username="",
            dev_auth_enabled=False,
        )
    )

    assert result.support_link is None
    assert result.max_auth_configured is False


def test_production_session_cookie_supports_embedded_max_client() -> None:
    response = Response()

    set_session_cookie(response, "session-token", Settings(app_env="production"))

    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie
    assert "secure" in cookie
    assert "samesite=none" in cookie


def test_development_session_cookie_remains_local_http_compatible() -> None:
    response = Response()

    set_session_cookie(response, "session-token", Settings(app_env="development"))

    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie
    assert "secure" not in cookie
    assert "samesite=lax" in cookie
