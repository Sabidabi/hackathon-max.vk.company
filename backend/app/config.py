from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    app_name: str = "MAX Menu API"
    app_env: str = "development"
    log_level: str = "INFO"
    database_url: str = "postgresql+asyncpg://menu:menu@postgres:5432/menu"
    data_root: Path = Path("/data")
    max_upload_bytes: int = Field(default=20 * 1024 * 1024, gt=0)
    max_pdf_pages: int = Field(default=30, gt=0)
    max_site_image_bytes: int = Field(default=8 * 1024 * 1024, gt=0)
    worker_poll_seconds: float = Field(default=2.0, gt=0)
    ocr_languages: str = Field(default="rus+eng", pattern=r"^[a-zA-Z0-9_+-]+$")
    ocr_dpi: int = Field(default=220, ge=150, le=300)
    ocr_max_pixels: int = Field(default=30_000_000, ge=1_000_000, le=100_000_000)
    ocr_timeout_seconds: int = Field(default=120, ge=10, le=600)
    max_bot_token: str = ""
    max_bot_username: str = ""
    max_webhook_secret: str = ""
    max_webhook_url: str = ""
    max_api_base_url: str = "https://platform-api2.max.ru"
    # Team support chat the bot forwards tickets to; empty — tickets are only stored.
    support_chat_id: int | None = None
    # Send a user nothing until they started a dialog with the bot.
    max_bot_require_dialog: bool = True
    bot_checks_interval_seconds: int = Field(default=900, ge=60, le=86400)
    public_app_url: str = "http://localhost:8080"
    max_init_data_max_age_seconds: int = Field(default=900, gt=0)
    session_ttl_seconds: int = Field(default=24 * 60 * 60, gt=0)
    session_cookie_name: str = "menu_session"
    dev_auth_enabled: bool = False
    dev_max_user_id: int = 900000001
    ai_proposal_ttl_seconds: int = Field(default=600, ge=60, le=3600)
    # AI features. "auto"/"openai" = the OpenAI-compatible gateway when
    # AI_API_KEY is set, otherwise the AI is honestly unavailable;
    # "mock" = the labelled demo/CI adapter; "off" = always unavailable.
    ai_provider: Literal["auto", "openai", "mock", "off"] = "auto"
    ai_base_url: str = "https://routerai.ru/api/v1"
    ai_api_key: str = ""
    ai_model: str = "qwen/qwen3.8-omni-flash"
    ai_request_timeout_seconds: float = Field(default=20, ge=1, le=180)
    # Background import (structuring a whole menu, batch descriptions) takes longer than a click.
    ai_import_timeout_seconds: float = Field(default=120, ge=10, le=600)
    ai_cache_ttl_seconds: int = Field(default=600, ge=0, le=86_400)
    ai_guest_daily_limit: int = Field(default=20, ge=1, le=10_000)
    ai_admin_daily_limit: int = Field(default=100, ge=1, le=10_000)
    ai_venue_daily_limit: int = Field(default=500, ge=1, le=1_000_000)
    # Anonymous guests: a ceiling per client address regardless of the user agent, and the
    # share of the venue's daily budget guests may spend (the rest is kept for admins).
    ai_guest_ip_daily_limit: int = Field(default=100, ge=1, le=100_000)
    ai_guest_venue_share_percent: int = Field(default=70, ge=1, le=100)
    ai_import_structuring: bool = True
    mcp_enabled: bool = False
    mcp_resource_url: str = "http://127.0.0.1:8010/mcp"
    mcp_issuer_url: str = "http://127.0.0.1:8010"
    mcp_confirmation_ttl_seconds: int = Field(default=600, ge=60, le=3600)

    @field_validator("support_chat_id", mode="before")
    @classmethod
    def empty_chat_id(cls, value: object) -> object:
        return None if isinstance(value, str) and not value.strip() else value

    @property
    def upload_dir(self) -> Path:
        return self.data_root / "uploads"

    @property
    def rendered_dir(self) -> Path:
        return self.data_root / "rendered"

    @property
    def extracted_dir(self) -> Path:
        return self.data_root / "extracted"

    @property
    def menu_images_dir(self) -> Path:
        return self.data_root / "menu-images"

    def ensure_data_directories(self) -> None:
        for path in (
            self.upload_dir,
            self.rendered_dir,
            self.extracted_dir,
            self.menu_images_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    return Settings()
