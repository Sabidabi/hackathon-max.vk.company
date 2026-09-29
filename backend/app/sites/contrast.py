"""WCAG contrast of the venue theme (P1-DOC-3 «Контраст»).

The same formula as ``frontend/src/features/site/contrast.ts``: text needs 4.5:1 on the
surface and on the page background, the accent (buttons, prices, icons) 3:1 on the surface.
An unreadable theme can be saved as a draft but not published.
"""

from typing import Literal

from pydantic import BaseModel

from app.sites.schemas import SiteConfig


def _channel(value: int) -> float:
    scaled = value / 255
    return scaled / 12.92 if scaled <= 0.03928 else ((scaled + 0.055) / 1.055) ** 2.4


def luminance(color: str) -> float:
    hex_value = color.lstrip("#")
    r, g, b = (int(hex_value[i : i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * _channel(r) + 0.7152 * _channel(g) + 0.0722 * _channel(b)


def contrast_ratio(a: str, b: str) -> float:
    light, dark = sorted((luminance(a), luminance(b)), reverse=True)
    return (light + 0.05) / (dark + 0.05)


class ContrastIssue(BaseModel):
    pair: Literal["text_surface", "text_background", "accent_surface"]
    label: str
    ratio: float
    required: float


PAIRS: tuple[tuple[str, str, str, str, float], ...] = (
    ("text_surface", "Текст на карточках", "text_color", "surface_color", 4.5),
    ("text_background", "Текст на фоне", "text_color", "background_color", 4.5),
    ("accent_surface", "Акцент на карточках", "primary_color", "surface_color", 3.0),
)


def contrast_issues(config: SiteConfig) -> list[ContrastIssue]:
    issues = []
    for pair, label, fg, bg, required in PAIRS:
        ratio = contrast_ratio(getattr(config, fg), getattr(config, bg))
        if ratio < required:
            issues.append(
                ContrastIssue(pair=pair, label=label, ratio=round(ratio, 2), required=required)
            )
    return issues
