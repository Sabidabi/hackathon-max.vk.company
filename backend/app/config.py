from functools import lru_cache
from pathlib import Path

from pydantic import Field
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
    public_app_url: str = "http://localhost:8080"
    max_init_data_max_age_seconds: int = Field(default=900, gt=0)
    session_ttl_seconds: int = Field(default=24 * 60 * 60, gt=0)
    session_cookie_name: str = "menu_session"
    dev_auth_enabled: bool = False
    dev_max_user_id: int = 900000001
    gigachat_auth_key: str = ""
    gigachat_scope: str = "GIGACHAT_API_B2B"
    gigachat_model: str = "GigaChat"
    gigachat_base_url: str = "https://api.giga.chat"
    gigachat_oauth_url: str = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth"
    gigachat_timeout_seconds: int = Field(default=30, ge=5, le=180)
    ai_proposal_ttl_seconds: int = Field(default=600, ge=60, le=3600)
    mcp_enabled: bool = False
    mcp_resource_url: str = "http://127.0.0.1:8010/mcp"
    mcp_issuer_url: str = "http://127.0.0.1:8010"
    mcp_confirmation_ttl_seconds: int = Field(default=600, ge=60, le=3600)

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
