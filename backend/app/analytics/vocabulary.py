"""Event dictionary of the spec and the rules that keep personal data out of ``props``."""

import re
from typing import Literal

GUEST_EVENTS = (
    "app_open",
    "menu_view",
    "category_view",
    "search",
    "search_empty",
    "item_view",
    "item_add",
    "item_remove",
    "choice_shown",
    "favorite_add",
    "rec_impression",
    "rec_click",
    "ai_ask",
    "ai_answer_click",
    "share_menu",
    "notification_open",
)
ADMIN_EVENTS = (
    "venue_created",
    "menu_published",
    "import_started",
    "import_applied",
    "ai_plan_applied",
)
EVENT_NAMES = GUEST_EVENTS + ADMIN_EVENTS
EventName = Literal[
    "app_open", "menu_view", "category_view", "search", "search_empty", "item_view",
    "item_add", "item_remove", "choice_shown", "favorite_add", "rec_impression", "rec_click",
    "ai_ask", "ai_answer_click", "share_menu", "notification_open",
    "venue_created", "menu_published", "import_started", "import_applied", "ai_plan_applied",
]
Platform = Literal["max_ios", "max_android", "max_web", "web"]

# Descriptive, non-personal keys only. Anything else is refused, so a new key is a
# deliberate change of this list, not an accident of the client.
ALLOWED_PROP_KEYS = frozenset({
    "menu_id",
    "item_key",
    "item_name",
    "section_id",
    "section_name",
    "query_len",
    "results",
    "source",
    "count",
    "items",
    "total_minor",
    "slot",
    "method",
    "kind",
    "available",
})
# Named explicitly so the refusal says why.
FORBIDDEN_PROP_KEYS = frozenset({
    "name",
    "first_name",
    "last_name",
    "username",
    "phone",
    "email",
    "query",
    "text",
    "message",
    "question",
    "answer",
    "init_data",
    "initData",
    "user_id",
    "max_user_id",
    "address",
})
MAX_PROPS = 12
MAX_PROP_STRING = 120

_SPACES = re.compile(r"\s+")


def normalize_query(value: str) -> str:
    """Lower-case, single spaces, ≤ 100 chars — the only stored form of a search phrase."""
    return _SPACES.sub(" ", value).strip().lower()[:100]


def validate_props(props: dict[str, object]) -> dict[str, object]:
    if len(props) > MAX_PROPS:
        raise ValueError("Слишком много свойств события")
    for key, value in props.items():
        if key in FORBIDDEN_PROP_KEYS:
            raise ValueError(f"Свойство «{key}» не допускается: персональные данные и тексты")
        if key not in ALLOWED_PROP_KEYS:
            raise ValueError(f"Неизвестное свойство события «{key}»")
        if value is not None and not isinstance(value, bool | int | float | str):
            raise ValueError(f"Свойство «{key}» должно быть простым значением")
        if isinstance(value, str) and len(value) > MAX_PROP_STRING:
            raise ValueError(f"Свойство «{key}» слишком длинное")
    return props
