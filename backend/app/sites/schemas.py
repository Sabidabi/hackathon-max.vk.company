import re
from typing import Any, Literal

from pydantic import BaseModel, Field, HttpUrl, field_validator, model_validator

SiteBlockKind = Literal["hero", "about", "menu", "gallery", "contacts"]
MEDIA_URL_PATTERN = re.compile(
    r"^/media/sites/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/"
    r"[0-9a-f]{32}\.webp$"
)


class SiteBlock(BaseModel):
    kind: SiteBlockKind
    visible: bool = True
    title: str | None = Field(default=None, max_length=80)

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str | None) -> str | None:
        return value.strip() or None if value is not None else None


def default_blocks() -> list[SiteBlock]:
    return [
        SiteBlock(kind="hero"),
        SiteBlock(kind="about", title="О ресторане"),
        SiteBlock(kind="menu", title="Меню"),
        SiteBlock(kind="gallery", title="Галерея"),
        SiteBlock(kind="contacts", title="Контакты"),
    ]


class SiteConfig(BaseModel):
    template: Literal["modern", "classic", "cafe", "noir"] = "modern"
    theme_mode: Literal["light", "dark"] = "light"
    primary_color: str = Field(default="#5F2BCE", pattern=r"^#[0-9A-Fa-f]{6}$")
    background_color: str = Field(default="#F7F4FB", pattern=r"^#[0-9A-Fa-f]{6}$")
    surface_color: str = Field(default="#FFFFFF", pattern=r"^#[0-9A-Fa-f]{6}$")
    text_color: str = Field(default="#28222F", pattern=r"^#[0-9A-Fa-f]{6}$")
    icon_color: str = Field(default="#5F2BCE", pattern=r"^#[0-9A-Fa-f]{6}$")
    background_image_url: str | None = None
    background_overlay: int = Field(default=12, ge=0, le=80)
    font_scale: float = Field(default=1, ge=0.9, le=1.15)
    tagline: str | None = Field(default=None, max_length=200)
    about: str | None = Field(default=None, max_length=2000)
    phone: str | None = Field(default=None, max_length=50)
    hours: str | None = Field(default=None, max_length=300)
    booking_url: HttpUrl | None = None
    logo_url: str | None = None
    cover_url: str | None = None
    gallery_urls: list[str] = Field(default_factory=list, max_length=8)
    blocks: list[SiteBlock] = Field(default_factory=default_blocks, min_length=5, max_length=5)

    @model_validator(mode="before")
    @classmethod
    def migrate_legacy_blocks(cls, value: Any) -> Any:
        if isinstance(value, dict) and isinstance(value.get("blocks"), list):
            blocks = list(value["blocks"])
            kinds = {block.get("kind") for block in blocks if isinstance(block, dict)}
            if "gallery" not in kinds:
                value = {**value, "blocks": [*blocks, SiteBlock(kind="gallery", title="Галерея")]}
        return value

    @field_validator("tagline", "about", "phone", "hours")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        return value.strip() or None if value is not None else None

    @field_validator(
        "primary_color",
        "background_color",
        "surface_color",
        "text_color",
        "icon_color",
    )
    @classmethod
    def normalize_color(cls, value: str) -> str:
        return value.upper()

    @field_validator("logo_url", "cover_url", "background_image_url")
    @classmethod
    def validate_media_url(cls, value: str | None) -> str | None:
        if value is not None and MEDIA_URL_PATTERN.fullmatch(value) is None:
            raise ValueError("Invalid site media URL")
        return value

    @field_validator("gallery_urls")
    @classmethod
    def validate_gallery_urls(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError("Gallery images must be unique")
        if any(MEDIA_URL_PATTERN.fullmatch(url) is None for url in value):
            raise ValueError("Invalid gallery media URL")
        return value

    @model_validator(mode="after")
    def validate_blocks(self) -> "SiteConfig":
        kinds = [block.kind for block in self.blocks]
        if len(set(kinds)) != len(kinds) or set(kinds) != {
            "hero",
            "about",
            "menu",
            "gallery",
            "contacts",
        }:
            raise ValueError("Site blocks must contain each supported block exactly once")
        if not next(block for block in self.blocks if block.kind == "menu").visible:
            raise ValueError("The menu block cannot be hidden")
        return self


def default_site_config() -> dict[str, object]:
    return SiteConfig().model_dump(mode="json")
