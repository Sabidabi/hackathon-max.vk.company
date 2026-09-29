"""Design change plan for the MCP «оформление» tools (draft-only, confirmed by a person).

Only visual settings can be changed through it: colours, theme, font size, the tile constructor
and fonts. Media, blocks, contacts and publication stay out of reach of an AI client.
"""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

HEX = r"^#[0-9A-Fa-f]{6}$"

# The keys a plan may touch; everything else is refused by ``extra="forbid"``.
DESIGN_FIELDS = (
    "template",
    "theme_mode",
    "primary_color",
    "background_color",
    "surface_color",
    "text_color",
    "icon_color",
    "font_scale",
    "menu_layout",
    "card_style",
    "card_radius",
    "image_ratio",
    "add_button",
    "heading_font",
    "body_font",
    "show_description",
    "show_weight",
)


DESIGN_OPTIONS: dict[str, list[str]] = {
    "template": ["modern", "classic", "cafe", "noir"],
    "theme_mode": ["light", "dark"],
    "menu_layout": ["grid", "list", "large"],
    "card_style": ["soft", "outline", "flat"],
    "card_radius": ["sharp", "soft", "round"],
    "image_ratio": ["square", "landscape", "portrait"],
    "add_button": ["round", "pill"],
    "heading_font": ["sans", "humanist", "rounded", "serif", "elegant", "mono"],
    "body_font": ["sans", "humanist", "serif"],
}


class DesignPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    template: Literal["modern", "classic", "cafe", "noir"] | None = None
    theme_mode: Literal["light", "dark"] | None = None
    primary_color: str | None = Field(default=None, pattern=HEX)
    background_color: str | None = Field(default=None, pattern=HEX)
    surface_color: str | None = Field(default=None, pattern=HEX)
    text_color: str | None = Field(default=None, pattern=HEX)
    icon_color: str | None = Field(default=None, pattern=HEX)
    font_scale: float | None = Field(default=None, ge=0.9, le=1.15)
    menu_layout: Literal["grid", "list", "large"] | None = None
    card_style: Literal["soft", "outline", "flat"] | None = None
    card_radius: Literal["sharp", "soft", "round"] | None = None
    image_ratio: Literal["square", "landscape", "portrait"] | None = None
    add_button: Literal["round", "pill"] | None = None
    heading_font: Literal["sans", "humanist", "rounded", "serif", "elegant", "mono"] | None = None
    body_font: Literal["sans", "humanist", "serif"] | None = None
    show_description: bool | None = None
    show_weight: bool | None = None

    def changes(self) -> dict[str, Any]:
        """Only the fields the client actually set."""
        return self.model_dump(mode="json", exclude_none=True)


class DesignChangePlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary: str = Field(min_length=1, max_length=300)
    patch: DesignPatch
    warnings: list[str] = Field(default_factory=list, max_length=10)
