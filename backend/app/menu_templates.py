"""Starter menus for the «Как начнём?» wizard.

Templates carry names, sections and short descriptions only — never prices: a position
without a price blocks publication until the owner sets it, so a template can never reach
guests with invented prices.
"""

from typing import Literal

from app.api.routes.menus import MenuItemPayload, MenuSectionPayload

TemplateKey = Literal["coffee"]

COFFEE: list[tuple[str, list[tuple[str, str | None]]]] = [
    (
        "Кофе",
        [
            ("Эспрессо", "30 мл"),
            ("Американо", None),
            ("Капучино", None),
            ("Латте", None),
            ("Раф", "Ванильный"),
            ("Флэт уайт", None),
        ],
    ),
    ("Не кофе", [("Чай", "Чёрный или зелёный"), ("Какао", None)]),
    ("Выпечка", [("Круассан", None), ("Чизкейк", None)]),
]


def template_sections(key: TemplateKey) -> list[MenuSectionPayload]:
    """Sections of the template with every price at zero (= «нет цены»)."""
    return [
        MenuSectionPayload(
            name=section,
            items=[
                MenuItemPayload(name=name, description=description, price_minor=0)
                for name, description in items
            ],
        )
        for section, items in COFFEE
    ]
