"""Protection of the AI chat from prompt injection (P1-DOC-8, docs/03-ai-constitution.md).

Layers, from the model outwards:
1. The user's text and documents reach the model only as JSON *data* inside ``<data>`` markers
   (``app.ai.provider.data_block`` escapes ``<``/``>``), never as instructions.
2. Before that, ``sanitize_user_text`` removes invisible and control characters (a common way to
   hide instructions) and caps the length; ``injection_signals`` names suspicious phrases so the
   request is logged and the person sees a note. Phrases alone never decide anything: a real
   defence is the structure below.
3. The model can only answer with a typed plan (a fixed schema); unknown fields are refused,
   media, contacts and publication are outside the schema.
4. The plan is only shown to a person, who applies it to a *draft*; publishing stays manual.
5. Text that comes back from the model for the person (``summary``, warnings) passes
   ``clean_model_text``: no links, no markup, no addressing of other systems.
"""

import re
import unicodedata
from dataclasses import dataclass

MAX_USER_TEXT = 2000

# Invisible characters and bidi controls used to hide text from a human reader.
_HIDDEN = {
    "​", "‌", "‍", "⁠", "﻿", "­",
    "‪", "‫", "‬", "‭", "‮", "⁦", "⁧", "⁨", "⁩",
}

_SIGNALS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("override", re.compile(
        r"(игнорир\w*|забудь|отмени|не\s+учитывай|disregard|ignore|forget)\W+"
        r"(?:\w+\W+){0,4}(инструкц|правил|указани|prompt|instruction|rule)", re.I)),
    ("role_change", re.compile(
        r"(ты\s+теперь|с\s+этого\s+момента\s+ты|представь,?\s+что\s+ты|you\s+are\s+now|act\s+as|"
        r"pretend\s+to\s+be)", re.I)),
    ("prompt_leak", re.compile(
        r"(системн\w+\s+(промпт|инструкц|сообщени)|system\s+prompt|покажи\s+(свои\s+)?инструкц|"
        r"reveal\s+(your\s+)?(prompt|instructions))", re.I)),
    ("chat_markup", re.compile(
        r"(<\|.*?\|>|\[/?INST\]|<<SYS>>|(^|\n)\s*(system|assistant|user)\s*:)", re.I)),
    ("publish_or_secret", re.compile(
        r"(опубликуй\s+все|publish\s+everything|удали\s+все|delete\s+all|api[\s_-]?key|токен|"
        r"парол[ьяи])", re.I)),
)

_URL = re.compile(r"(?:https?://|www\.)\S+|\b[\w.-]+\.(?:com|ru|net|org|io|xyz)\b/?\S*", re.I)
_TAGS = re.compile(r"<[^>]{0,200}>")
_MD_LINK = re.compile(r"\[([^\]]{0,200})\]\([^)]{0,500}\)")


@dataclass(frozen=True)
class GuardReport:
    text: str
    signals: tuple[str, ...]

    @property
    def suspicious(self) -> bool:
        return bool(self.signals)


def sanitize_user_text(text: str, limit: int = MAX_USER_TEXT) -> str:
    """NFKC-normalised text without invisible/control characters, collapsed and capped."""
    normalized = unicodedata.normalize("NFKC", text)
    cleaned = "".join(
        char
        for char in normalized
        if char not in _HIDDEN
        and (char in "\n\t" or not unicodedata.category(char).startswith("C"))
    )
    cleaned = re.sub(r"[ \t]+", " ", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return cleaned[:limit]


def injection_signals(text: str) -> tuple[str, ...]:
    return tuple(name for name, pattern in _SIGNALS if pattern.search(text))


def inspect_user_text(text: str, limit: int = MAX_USER_TEXT) -> GuardReport:
    cleaned = sanitize_user_text(text, limit)
    return GuardReport(text=cleaned, signals=injection_signals(cleaned))


def clean_model_text(text: str, limit: int = 300) -> str:
    """Text the model wrote for the person: plain, no links, no markup, one line."""
    value = _MD_LINK.sub(r"\1", text)
    value = _TAGS.sub("", value)
    value = _URL.sub("", value)
    value = re.sub(r"[`*_#>|]+", "", value)
    value = re.sub(r"\s+", " ", sanitize_user_text(value, limit * 2)).strip()
    return value[:limit].rstrip()


NOTE_SUSPICIOUS = (
    "Похоже, в тексте есть указания для ИИ. Мы их не выполняем: ИИ только предлагает правки "
    "оформления или меню, а вы решаете, что применить."
)
