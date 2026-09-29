"""«Синица проверила меню»: deterministic checks of a draft (P1-DOC-8 «Проверка меню»).

The findings come from code only; the AI may later add a short summary and wording tips,
never new findings.
"""

import uuid
from statistics import median
from typing import Literal

from pydantic import BaseModel

from app.api.routes.menus import MenuItemResponse, MenuSectionResponse, item_has_price

FindingCode = Literal[
    "no_price", "price_outlier", "duplicate_name", "empty_section", "no_description", "no_photo"
]
ORDER: tuple[FindingCode, ...] = (
    "no_price", "price_outlier", "duplicate_name", "empty_section", "no_description", "no_photo"
)
OUTLIER_FACTOR = 10


class MenuFinding(BaseModel):
    code: FindingCode
    severity: Literal["warning", "info"]
    message: str
    item_key: uuid.UUID | None = None
    item_name: str | None = None
    section: str | None = None
    tip: str | None = None


def display_price(item: MenuItemResponse) -> int:
    """The «from» price a guest sees: the cheapest available size, else the item price."""
    prices = [v.price_minor for v in item.configuration.variants if v.is_available]
    return min(prices) if prices else item.price_minor


def _rub(minor: int) -> str:
    return f"{minor / 100:.0f} ₽" if minor % 100 == 0 else f"{minor / 100:.2f} ₽"


def _times(count: int) -> str:
    return "раза" if count % 10 in (2, 3, 4) and count % 100 not in (12, 13, 14) else "раз"


def check_menu(sections: list[MenuSectionResponse]) -> list[MenuFinding]:
    findings: list[MenuFinding] = []

    def add(code: FindingCode, severity, message, item=None, section=None):
        findings.append(MenuFinding(
            code=code,
            severity=severity,
            message=message,
            item_key=item.item_key if item is not None else None,
            item_name=item.name if item is not None else None,
            section=section,
        ))

    names: dict[str, list[tuple[MenuItemResponse, str]]] = {}
    for section in sections:
        if not section.items:
            add("empty_section", "warning", f"Раздел «{section.name}» пуст", section=section.name)
            continue
        priced = [display_price(item) for item in section.items if item_has_price(item)]
        middle = median(priced) if len(priced) >= 3 else None
        for item in section.items:
            names.setdefault(item.name.strip().casefold(), []).append((item, section.name))
            if item.is_available and not item_has_price(item):
                add("no_price", "warning", f"«{item.name}»: нет цены", item, section.name)
            elif middle and item_has_price(item):
                price = display_price(item)
                if price >= middle * OUTLIER_FACTOR or price * OUTLIER_FACTOR <= middle:
                    add(
                        "price_outlier", "warning",
                        f"«{item.name}»: цена {_rub(price)} сильно отличается от соседей "
                        f"(обычно {_rub(int(middle))})",
                        item, section.name,
                    )
            if not item.description:
                add("no_description", "info", f"«{item.name}»: нет описания", item, section.name)
            if not item.image_url:
                add("no_photo", "info", f"«{item.name}»: нет фото", item, section.name)
    for entries in names.values():
        if len(entries) > 1:
            for item, section_name in entries[1:]:
                add(
                    "duplicate_name", "warning",
                    f"«{item.name}» встречается в меню {len(entries)} {_times(len(entries))}",
                    item, section_name,
                )
    findings.sort(key=lambda finding: ORDER.index(finding.code))
    return findings
