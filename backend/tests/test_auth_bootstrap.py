from app.api.routes.auth import get_auth_bootstrap
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
