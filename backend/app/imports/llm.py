"""Optional LLM step of the import (P1-TASK-43, P1-DOC-8 «ИИ-импорт меню»).

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
from app.ai.tasks import (
    DESCRIPTION_LIMIT,
    ImportDescriptionsAnswer,
    ImportStructureAnswer,
    check_description,
    import_descriptions_task,
    import_structure_task,
    price_to_minor,
)
from app.config import Settings
from app.imports.processor import split_name_description

logger = logging.getLogger(__name__)

# Longer documents are structured by the heuristic parser: one prompt must stay small.
MAX_TEXT_CHARS = 15_000
LOW_CONFIDENCE = 0.7


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text.casefold().replace("ё", "е")).strip()


MAX_NAME_LENGTH = 80
MIN_WORD = 3
WORD_MATCH_SHARE = 0.85
ORDER_SHARE = 0.8


def _tokens(text: str) -> list[str]:
    """Words of a text for the fuzzy comparison: case, ё, punctuation, quotes and OCR
    hyphenation at a line break do not matter."""
    text = re.sub(r"(?<=\w)[-­]\s*\n\s*(?=\w)", "", text)
    text = text.casefold().replace("­", "").replace("ё", "е")
    return re.findall(r"\w+", text)


def description_in_source(description: str, source_text: str) -> bool:
    """The description is taken from the document, not written by the model.

    At least 85% of its words (3+ letters) occur in the document, mostly in the same order;
    every number of the description occurs in the document literally."""
    words = _tokens(description)
    if not words:
        return False
    source = _tokens(source_text)
    source_numbers = {w for w in source if w.isdigit()}
    if any(w.isdigit() and w not in source_numbers for w in words):
        return False
    long_words = [w for w in words if len(w) >= MIN_WORD and not w.isdigit()]
    if not long_words:
        return _norm(description) in _norm(source_text)
    positions: dict[str, list[int]] = {}
    for at, word in enumerate(source):
        positions.setdefault(word, []).append(at)
    found = [w for w in long_words if w in positions]
    if len(found) < WORD_MATCH_SHARE * len(long_words):
        return False
    ordered, last = 0, -1
    for word in found:
        later = next((at for at in positions[word] if at > last), None)
        if later is not None:
            ordered += 1
            last = later
    return ordered >= ORDER_SHARE * len(found)


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
            raw_description = (item.description or "").strip() or None
            if len(name) > MAX_NAME_LENGTH:  # the model put the description into the name
                name, tail = split_name_description(name)
                raw_description = raw_description or tail
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
            description = raw_description
            if description and not description_in_source(description, source_text):
                description = None  # the model may copy text, never write it
            items.append({
                "name": name[:250],
                "price_minor": price or 0,
                "price_missing": price_missing,
                "currency": "RUB",
                "weight_text": (item.weight_text or "").strip()[:100] or None,
                "description": description,
                "description_source": "document" if description else None,
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
            settings, import_structure_task(text), venue_id=venue_id, subject="worker",
            timeout_seconds=settings.ai_import_timeout_seconds,
        )
    except AILimitExceeded:
        return None, "limit"
    except AIUnavailable as error:
        cause = error.__cause__ or error  # class and HTTP code only, never a body or a key
        logger.warning(
            "AI import structuring unavailable: %s: %s", type(cause).__name__, cause
        )
        return None, "unavailable"
    answer = result.value
    assert isinstance(answer, ImportStructureAnswer)
    structured = answer_to_structured_menu(answer, text, result.provider)
    if not structured["item_count"]:
        return None, "no_items"
    return structured, None


BATCH = 40
MAX_DESCRIBED = 200


def template_description(item: dict[str, Any], section: str) -> str:
    """A neutral one-line draft made by code from the item's own fields (no AI, no invention)."""
    name = str(item["name"]).strip()
    parts = [f"{name}: {section.strip().lower()}" if section.strip() else name]
    if item.get("weight_text"):
        parts.append(str(item["weight_text"]).strip())
    else:
        sizes = [v["name"] for v in item.get("variants") or [] if v.get("name")]
        if sizes:
            parts.append("размеры: " + ", ".join(sizes[:3]))
    text = ". ".join(parts) + "."
    return text if len(text) <= DESCRIPTION_LIMIT else text[: DESCRIPTION_LIMIT - 1].rstrip() + "…"


async def add_ai_descriptions(
    settings: Settings, structured: dict[str, Any], venue_id: uuid.UUID, admin_id: uuid.UUID
) -> int:
    """A draft description for EVERY item without one, for the review screen.

    The AI writes them in batches; each is checked against its own item (no invented numbers
    or facts). Items the AI skipped, failed or could not reach get a neutral template made by
    code (``description_source = "auto"``). Nothing reaches a menu before «Применить»."""
    targets: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    sections: list[str] = []
    for section in structured["sections"]:
        for item in section["items"]:
            if item.get("description") or len(targets) >= MAX_DESCRIBED:
                continue
            sizes = [v["name"] for v in item.get("variants") or []]
            source: dict[str, Any] = {"name": item["name"], "section": section["name"]}
            if item.get("weight_text"):
                source["weight_text"] = item["weight_text"]
            if sizes:
                source["sizes"] = sizes
            targets.append(item)
            sources.append(source)
            sections.append(section["name"])
    if not targets:
        return 0

    added = 0
    ai_ok = True
    for start in range(0, len(targets), BATCH):
        if not ai_ok:
            break
        chunk = sources[start:start + BATCH]
        data = [{"index": at, **source} for at, source in enumerate(chunk)]
        try:
            result = await run_task(
                settings, import_descriptions_task(data), venue_id=venue_id,
                subject=f"user:{admin_id}", timeout_seconds=settings.ai_import_timeout_seconds,
            )
        except AILimitExceeded:
            ai_ok = False
            continue
        except AIUnavailable as error:
            cause = error.__cause__ or error
            logger.warning(
                "AI import descriptions unavailable: %s: %s", type(cause).__name__, cause
            )
            ai_ok = False
            continue
        answer = result.value
        assert isinstance(answer, ImportDescriptionsAnswer)
        for entry in answer.descriptions:
            at = start + entry.index
            if not 0 <= entry.index < len(chunk) or targets[at].get("description"):
                continue
            text = entry.description
            if not text or len(text) > DESCRIPTION_LIMIT:
                continue
            try:
                check_description(text, sources[at])
            except AIUnavailable:
                continue
            targets[at]["description"] = text
            targets[at]["description_source"] = "ai"
            added += 1
    for at, item in enumerate(targets):
        if not item.get("description"):
            item["description"] = template_description(item, sections[at])
            item["description_source"] = "auto"
            added += 1
    return added
