"""Optional LLM step of the import.

The OCR / PDF text goes to the model strictly as data; the answer is validated by schema
and then by code: a price is kept only when the number literally occurs in the source text,
otherwise the field is empty and marked «Проверьте цену»; descriptions not found in the
source are dropped. The result only feeds the review screen — nothing is written to a menu
until the admin presses «Применить в черновик». Any failure → the heuristic parser.
"""

import logging
import re
import uuid
from typing import Any

from app.ai.provider import AIUnavailable
from app.ai.service import AILimitExceeded, run_task
from app.ai.tasks import ImportStructureAnswer, import_structure_task, price_to_minor
from app.config import Settings

logger = logging.getLogger(__name__)

# Longer documents are structured by the heuristic parser: one prompt must stay small.
MAX_TEXT_CHARS = 15_000
LOW_CONFIDENCE = 0.7


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text.casefold().replace("ё", "е")).strip()


def answer_to_structured_menu(
    answer: ImportStructureAnswer, source_text: str, provider: str
) -> dict[str, Any]:
    """Validated model answer → the ``structured_menu`` the review screen reads."""
    source_norm = _norm(source_text)
    sections: list[dict[str, Any]] = []
    for section in answer.sections:
        items: list[dict[str, Any]] = []
        for item in section.items:
            name = item.name.strip()
            if not name:
                continue
            variants = []
            for size in item.sizes:
                size_name = size.name.strip()
                if size_name:
                    variants.append({
                        "name": size_name[:100],
                        "price_minor": price_to_minor(size.price, source_text),
                    })
            priced_variants = [v["price_minor"] for v in variants if v["price_minor"] is not None]
            if len(variants) >= 2:
                price = min(priced_variants) if priced_variants else None
            else:
                variants = []
                price = price_to_minor(item.price, source_text)
            price_missing = price is None or any(v["price_minor"] is None for v in variants)
            name_confidence = item.confidence.name
            if _norm(name) not in source_norm:
                name_confidence = min(name_confidence, 0.5)
            price_confidence = 0.0 if price_missing else item.confidence.price
            description = (item.description or "").strip() or None
            if description and _norm(description) not in source_norm:
                description = None  # the model may copy text, never write it
            items.append({
                "name": name[:250],
                "price_minor": price or 0,
                "price_missing": price_missing,
                "currency": "RUB",
                "weight_text": (item.weight_text or "").strip()[:100] or None,
                "description": description,
                "variants": [
                    {"name": v["name"], "price_minor": v["price_minor"] or 0} for v in variants
                ],
                "sort_order": len(items),
                "source_line": None,
                "source_confidence": round(min(name_confidence, price_confidence), 4),
                "field_confidence": {
                    "name": round(name_confidence, 4), "price": round(price_confidence, 4),
                },
            })
        if items:
            sections.append({
                "name": section.name.strip()[:200] or "Меню",
                "sort_order": len(sections),
                "items": items,
            })
    return {
        "schema_version": 2,
        "parser": "llm-v1",
        "provider": provider,
        "sections": sections,
        "item_count": sum(len(section["items"]) for section in sections),
        "unparsed_lines": [],
    }


async def structure_with_ai(
    settings: Settings, text: str, venue_id: uuid.UUID
) -> tuple[dict[str, Any] | None, str | None]:
    """(structured menu, None) or (None, reason) for the heuristic fallback."""
    if not settings.ai_import_structuring:
        return None, "disabled"
    if not text.strip():
        return None, "empty"
    if len(text) > MAX_TEXT_CHARS:
        return None, "too_long"
    try:
        result = await run_task(
            settings, import_structure_task(text), venue_id=venue_id, subject="worker"
        )
    except AILimitExceeded:
        return None, "limit"
    except AIUnavailable as error:
        logger.info("AI import structuring unavailable: %s", error)
        return None, "unavailable"
    answer = result.value
    assert isinstance(answer, ImportStructureAnswer)
    structured = answer_to_structured_menu(answer, text, result.provider)
    if not structured["item_count"]:
        return None, "no_items"
    return structured, None
