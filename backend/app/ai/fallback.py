"""Picks without AI: a small keyword matcher over the published menu.

Used when the AI is unavailable, over its limit or answered nothing usable, and by the labelled
mock provider. It only ever returns IDs of the candidates it was given.
"""

import re
from dataclasses import dataclass

COFFEE = (
    "кофе", "эспрессо", "латте", "капучино", "раф", "американо", "флэт", "флет", "мокко",
    "кортадо", "макиато", "лунго", "ристретто", "колд брю", "бамбл", "фильтр",
)
INTENTS: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    # intent: (words in the question, words in a matching position)
    "no_caffeine": (
        ("без кофеина", "не кофе", "без кофе", "декаф", "кофеин"),
        ("какао", "чай", "сок", "лимонад", "смузи", "молочн", "морс", "вода", "шоколад"),
    ),
    "sweet": (
        ("сладк", "десерт", "сладень", "к чаю"),
        (
            "десерт", "торт", "чизкейк", "пирож", "круассан", "сироп", "шоколад", "какао",
            "маффин", "эклер", "печень", "сладк", "мёд", "мед", "карамел", "раф", "брауни",
            "синнабон", "булочк", "макарон", "тирамису",
        ),
    ),
    "warm": (
        ("тёпл", "тепл", "горяч", "согре", "холодно"),
        ("кофе", "чай", "какао", "латте", "капучино", "раф", "суп", "глинтвейн", "шоколад"),
    ),
    "cold": (
        ("холодн", "освеж", "айс", "жарко", "прохлад"),
        ("айс", "лимонад", "холод", "смузи", "фраппе", "морожен", "колд", "тоник", "сок"),
    ),
    "food": (
        ("перекус", "сыт", "поесть", "голод", "завтрак", "обед", "еда"),
        (
            "сэндвич", "круассан", "салат", "суп", "боул", "панини", "сырник", "каша",
            "омлет", "тост", "завтрак", "блин", "киш", "бургер", "ролл", "паста",
        ),
    ),
}


@dataclass(frozen=True)
class Candidate:
    """One available published position, as shown to the model."""

    ref: str
    name: str
    section: str
    description: str = ""
    sizes: tuple[str, ...] = ()

    @property
    def text(self) -> str:
        return " ".join((self.name, self.section, self.description, *self.sizes)).casefold()


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.casefold().replace("ё", "е")).strip()


def is_coffee(candidate: Candidate) -> bool:
    """By name and description; «Не кофе» / «без кофеина» do not make a drink coffee."""
    text = normalize(f"{candidate.name} {candidate.description}")
    text = re.sub(r"(не|без) кофе\w*", " ", text)
    return any(word in text for word in COFFEE)


def keyword_picks(question: str, candidates: list[Candidate], limit: int = 3) -> list[str]:
    """Up to ``limit`` candidate refs matching the question; never an unknown ref."""
    query = normalize(question)
    scores: dict[str, float] = {candidate.ref: 0.0 for candidate in candidates}
    intents = [
        intent for intent, (triggers, _) in INTENTS.items()
        if any(trigger in query for trigger in triggers)
    ]
    for candidate in candidates:
        text = normalize(candidate.text)
        for intent in intents:
            if any(word in text for word in INTENTS[intent][1]):
                scores[candidate.ref] += 2
        if "no_caffeine" in intents and is_coffee(candidate):
            scores[candidate.ref] = -100
        for word in re.findall(r"[\wё-]{4,}", query):
            stem = word[:-2] if len(word) > 5 else word
            if stem in text:
                scores[candidate.ref] += 1
    ranked = sorted(
        (candidate for candidate in candidates if scores[candidate.ref] > 0),
        key=lambda candidate: -scores[candidate.ref],
    )
    if ranked:
        return [candidate.ref for candidate in ranked[:limit]]
    if "no_caffeine" in intents:
        candidates = [candidate for candidate in candidates if not is_coffee(candidate)]
    # Nothing matched: one position from each of the first sections, as a gentle start.
    picked: list[str] = []
    seen_sections: set[str] = set()
    for candidate in candidates:
        if candidate.section in seen_sections:
            continue
        seen_sections.add(candidate.section)
        picked.append(candidate.ref)
        if len(picked) == limit:
            break
    return picked
