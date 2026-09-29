"""Demo venue «Кофейня Север» (P1-TASK-49): real-looking data, clearly a demo.

No photos (there are no real ones), no synthetic analytics events or recommendations
(post-MVP by the owner's decision on P1-DOC-14). Every ID below is derived from a fixed
namespace so re-running the seed is idempotent.
"""

from datetime import time
from typing import Any

DEMO_VENUE_NAME = "Кофейня Север"
DEMO_RESTAURANT_DESCRIPTION = "Кофе, выпечка и завтраки. Демо-заведение «Синицы»."

# The landing's «Открыть демо-меню» opens the first point (frontend LandingSurface).
DEMO_PUBLIC_ID = "demo-sever"
DEMO_PARK_PUBLIC_ID = "demo-sever-park"

DEMO_POINTS: list[dict[str, Any]] = [
    {
        "key": "center",
        "public_id": DEMO_PUBLIC_ID,
        "name": "Север на Петровском",
        "address": "Москва, Петровский бульвар, 7",
    },
    {
        "key": "park",
        "public_id": DEMO_PARK_PUBLIC_ID,
        "name": "Север у парка",
        "address": "Москва, ул. Лесная, 12",
    },
]


def _item(name: str, price_minor: int, **extra: Any) -> dict[str, Any]:
    return {
        "name": name,
        "description": extra.get("description"),
        "price_minor": price_minor,
        "weight_text": extra.get("weight_text"),
        "ingredients": extra.get("ingredients"),
        "allergens": extra.get("allergens", []),
        "is_available": extra.get("is_available", True),
        # Symbolic configuration; demo_seed turns names into stable UUIDs.
        "configuration": extra.get("configuration"),
    }


MILK_REQUIRED = {
    "name": "Молоко",
    "min_quantity": 1,
    "max_quantity": 1,
    "options": [
        {"name": "Обычное", "price_minor": 0, "default_quantity": 1},
        {"name": "Овсяное", "price_minor": 5000},
        {"name": "Миндальное", "price_minor": 6000},
    ],
}
SYRUP = {
    "name": "Сироп",
    "min_quantity": 0,
    "max_quantity": 2,
    "options": [
        {"name": "Карамель", "price_minor": 3000, "max_quantity": 2},
        {"name": "Ваниль", "price_minor": 3000},
    ],
}


def _sizes(small: int, large: int) -> list[dict[str, Any]]:
    return [
        {"name": "250 мл", "price_minor": small, "weight_text": "250 мл"},
        {"name": "350 мл", "price_minor": large, "weight_text": "350 мл"},
    ]


MAIN_SECTIONS: list[dict[str, Any]] = [
    {
        "name": "Кофе",
        "items": [
            _item("Эспрессо", 12000, description="Двойной, зерно месяца", weight_text="40 мл"),
            _item(
                "Американо",
                14000,
                description="Эспрессо и горячая вода",
                weight_text="250 мл",
                configuration={"variants": _sizes(14000, 17000)},
            ),
            _item(
                "Капучино",
                18000,
                description="Классика на двойном эспрессо",
                weight_text="250 мл",
                allergens=["молоко"],
                configuration={"variants": _sizes(18000, 22000), "groups": [SYRUP]},
            ),
            _item(
                "Латте",
                19000,
                description="Эспрессо и молоко с нежной пеной",
                weight_text="250 мл",
                allergens=["молоко"],
                configuration={"variants": _sizes(19000, 23000), "groups": [MILK_REQUIRED, SYRUP]},
            ),
            _item(
                "Флэт уайт",
                21000,
                description="Двойной ристретто и бархатное молоко",
                weight_text="200 мл",
                allergens=["молоко"],
            ),
        ],
    },
    {
        "name": "Не кофе",
        "items": [
            _item("Чай улун", 16000, description="Молочный улун, чайник", weight_text="400 мл"),
            _item(
                "Какао",
                20000,
                description="Можно на овсяном молоке",
                weight_text="300 мл",
                allergens=["молоко"],
            ),
        ],
    },
    {
        "name": "Выпечка",
        "items": [
            _item(
                "Круассан",
                17000,
                description="Сливочное масло, хрустящие слои",
                weight_text="80 г",
                allergens=["глютен", "молоко"],
            ),
            _item(
                "Синнабон",
                22000,
                description="Булочка с корицей и сливочным кремом",
                weight_text="120 г",
                allergens=["глютен", "молоко", "яйцо"],
            ),
        ],
    },
]

BREAKFAST_SECTIONS: list[dict[str, Any]] = [
    {
        "name": "Завтраки",
        "items": [
            _item(
                "Сырники",
                32000,
                description="Со сметаной и ягодным соусом",
                weight_text="220 г",
                allergens=["молоко", "яйцо", "глютен"],
            ),
            _item("Омлет с сыром", 29000, weight_text="200 г", allergens=["молоко", "яйцо"]),
        ],
    },
]

DEMO_MENUS: list[dict[str, Any]] = [
    {"key": "main", "title": "Основное", "sections": MAIN_SECTIONS},
    {"key": "breakfast", "title": "Завтраки", "sections": BREAKFAST_SECTIONS},
]

# point key → [(menu key, show_from, show_to)] in tab order.
DEMO_ASSIGNMENTS: dict[str, list[tuple[str, time | None, time | None]]] = {
    "center": [("main", None, None), ("breakfast", time(8, 0), time(12, 0))],
    "park": [("main", None, None)],
}

# Stop-list of one point: (point key, menu key, item name).
DEMO_STOP_LIST: list[tuple[str, str, str]] = [("park", "main", "Круассан")]


DEMO_SITE_CONFIG: dict[str, Any] = {
    "template": "classic",
    "primary_color": "#234738",
    "background_color": "#ECEFE6",
    "surface_color": "#FFFEF8",
    "text_color": "#17231E",
    "icon_color": "#C66A3D",
    "tagline": "Кофе, выпечка и завтраки",
    "about": (
        "Север — кофейня у дома: эспрессо на зерне обжарки этого месяца, "
        "выпечка каждое утро и завтраки до полудня."
    ),
    "phone": "+7 495 555-27-27",
    "hours": "Ежедневно 08:00–21:00",
    "booking_url": None,
    "logo_url": None,
    "cover_url": None,
    "gallery_urls": [],
    "blocks": [
        {"kind": "hero", "visible": True, "title": None},
        {"kind": "menu", "visible": True, "title": "Меню"},
        {"kind": "about", "visible": True, "title": "Наша история"},
        {"kind": "gallery", "visible": True, "title": "Атмосфера"},
        {"kind": "contacts", "visible": True, "title": "Ждём вас"},
    ],
}
