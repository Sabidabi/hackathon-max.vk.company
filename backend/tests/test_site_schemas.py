import pytest
from pydantic import ValidationError

from app.sites.schemas import SiteBlock, SiteConfig


def test_site_config_normalizes_content_and_colors() -> None:
    config = SiteConfig(
        primary_color="#aabbcc",
        tagline="  Ужин с видом  ",
        about="   ",
    )

    assert config.primary_color == "#AABBCC"
    assert config.tagline == "Ужин с видом"
    assert config.about is None


def test_legacy_site_config_gets_safe_design_tokens() -> None:
    config = SiteConfig.model_validate(
        {
            "template": "modern",
            "primary_color": "#5F2BCE",
            "background_color": "#F7F4FB",
        }
    )

    assert config.theme_mode == "light"
    assert config.surface_color == "#FFFFFF"
    assert config.text_color == "#28222F"
    assert config.icon_color == "#5F2BCE"
    assert config.background_image_url is None
    assert config.font_scale == 1


def test_dark_template_and_background_are_validated() -> None:
    config = SiteConfig(
        template="noir",
        theme_mode="dark",
        background_image_url=(
            "/media/sites/00000000-0000-0000-0000-000000000001/"
            "11111111111111111111111111111111.webp"
        ),
        background_overlay=45,
    )

    assert config.theme_mode == "dark"
    assert config.background_overlay == 45

    with pytest.raises(ValidationError):
        SiteConfig(background_image_url="https://example.com/background.jpg")


def test_site_config_requires_unique_blocks_and_visible_menu() -> None:
    with pytest.raises(ValidationError, match="exactly once"):
        SiteConfig(
            blocks=[
                SiteBlock(kind="hero"),
                SiteBlock(kind="hero"),
                SiteBlock(kind="menu"),
                SiteBlock(kind="contacts"),
            ]
        )

    with pytest.raises(ValidationError, match="cannot be hidden"):
        SiteConfig(
            blocks=[
                SiteBlock(kind="hero"),
                SiteBlock(kind="about"),
                SiteBlock(kind="menu", visible=False),
                SiteBlock(kind="contacts"),
            ]
        )
