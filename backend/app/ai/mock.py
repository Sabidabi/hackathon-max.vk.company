"""Labelled mock AI for CI and the keyless demo (``AI_PROVIDER=mock``).

Deterministic and offline. Every answer produced through it carries ``provider: "mock"``
up to the API response, and the UI marks it «Демо-ИИ», so it is never mistaken for
the real model. It follows the same schemas as the real provider and never sees secrets.
"""

from typing import Any

from app.ai.fallback import Candidate, keyword_picks
from app.ai.provider import AITask
from app.ai.tasks import DESCRIPTION_LIMIT


def _describe(data: dict[str, Any]) -> str:
    name = str(data.get("name") or "Позиция")
    parts = [f"{name} — {str(data.get('section') or 'позиция меню').lower()}"]
    ingredients = data.get("ingredients")
    if ingredients:
        parts.append(f"состав: {ingredients}")
    sizes = data.get("sizes") or []
    if sizes:
        parts.append("размеры: " + ", ".join(str(size) for size in sizes))
    modifiers = data.get("modifiers") or []
    if modifiers:
        parts.append("на выбор: " + ", ".join(str(group) for group in modifiers).lower())
    text = "; ".join(parts) + "."
    if len(text) > DESCRIPTION_LIMIT:
        text = text[: DESCRIPTION_LIMIT - 1].rsplit(" ", 1)[0].rstrip(",;:") + "…"
    return text


def _import(text: str) -> dict[str, Any]:
    from app.imports.processor import structure_menu_text

    parsed = structure_menu_text(text)
    sections = []
    for section in parsed["sections"]:
        assert isinstance(section, dict)
        items = []
        for item in section["items"]:
            assert isinstance(item, dict)
            price_minor = int(item["price_minor"])
            items.append({
                "name": item["name"],
                "price": f"{price_minor // 100}" if price_minor else None,
                "weight_text": item.get("weight_text"),
                "confidence": {"name": 0.8, "price": 0.8 if price_minor else 0.0},
            })
        sections.append({"name": section["name"], "items": items})
    return {"sections": sections}


_DESIGN_RULES: list[tuple[tuple[str, ...], dict[str, Any], str]] = [
    (("тёмн", "темн", "ночь", "ночн"), {"theme_mode": "dark"}, "тёмная тема"),
    (("светл", "дневн"), {"theme_mode": "light"}, "светлая тема"),
    (("списк", "строк", "файл"), {"menu_layout": "list"}, "плитки списком"),
    (("сетк", "два в ряд", "2 в ряд"), {"menu_layout": "grid"}, "плитки сеткой"),
    (("крупн", "больш", "одна в ряд"), {"menu_layout": "large"}, "крупные плитки"),
    (("засечк", "классическ"), {"heading_font": "serif"}, "шрифт с засечками"),
    (("изящн", "элегант"), {"heading_font": "elegant"}, "изящный шрифт"),
    (("округл", "мягкий шрифт"), {"heading_font": "rounded"}, "округлый шрифт"),
    (("печатн", "машинк"), {"heading_font": "mono"}, "печатный шрифт"),
    (("круглые", "скругл"), {"card_radius": "round"}, "круглые углы"),
    (("острые", "строг"), {"card_radius": "sharp"}, "острые углы"),
    (("контур", "рамк"), {"card_style": "outline"}, "карточки с контуром"),
    (("заливк", "плоск"), {"card_style": "flat"}, "плоские карточки"),
    (("подпис", "кнопка с текстом"), {"add_button": "pill"}, "кнопка «Добавить» с подписью"),
    (("без описан",), {"show_description": False}, "без описаний"),
    (("без веса", "без объём"), {"show_weight": False}, "без веса и объёма"),
]


def _design(data: dict[str, Any]) -> dict[str, Any]:
    request = str(data.get("request") or "").lower()
    patch: dict[str, Any] = {}
    notes: list[str] = []
    for words, values, note in _DESIGN_RULES:
        if any(word in request for word in words):
            patch.update(values)
            notes.append(note)
    if not patch:
        return {
            "summary": "Демо-ИИ не понял, что менять: назовите тему, раскладку, шрифт или углы.",
            "patch": {},
            "warnings": [],
        }
    return {"summary": "Демо-план: " + ", ".join(notes) + ".", "patch": patch, "warnings": []}


class MockAIProvider:
    name = "mock"
    model = "mock-v1"

    async def complete(self, task: AITask) -> Any:
        data = task.data
        if task.name == "guest_ask":
            candidates = [
                Candidate(
                    ref=item["id"],
                    name=item["name"],
                    section=item.get("section", ""),
                    description=item.get("description", ""),
                    sizes=tuple(item.get("sizes", ())),
                )
                for item in data["items"]
            ]
            picks = keyword_picks(data["question"], candidates)
            return {
                "item_ids": picks,
                "reason": "Демо-ответ без настоящего ИИ: подобрали по словам вашего запроса."
                if picks else "",
            }
        if task.name == "item_description":
            return {"description": _describe(data)}
        if task.name == "menu_check":
            count = len(data["findings"])
            return {
                "summary": (
                    f"Демо-итог: {count} замечаний — начните с цен и пустых разделов."
                    if count else "Демо-итог: замечаний нет."
                ),
                "tips": [],
            }
        if task.name == "import_structure":
            return _import(data["text"])
        if task.name == "import_descriptions":
            # The labelled demo writes a plain draft for every item (checked by the review).
            return {
                "descriptions": [
                    {"index": item["index"], "description": _describe(item)}
                    for item in data["items"]
                ]
            }
        if task.name == "design_plan":
            return _design(data)
        raise ValueError(f"unknown task {task.name}")
