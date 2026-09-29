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
            return {"descriptions": []}  # the demo never writes descriptions
        raise ValueError(f"unknown task {task.name}")
