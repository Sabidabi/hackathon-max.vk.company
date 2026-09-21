from typing import Any

DEMO_PUBLIC_ID = "demo-sever"
DEMO_RESTAURANT_NAME = "Север — городское бистро"
DEMO_RESTAURANT_DESCRIPTION = (
    "Современное городское бистро с завтраками весь день, сезонной кухней "
    "и десертами собственной кондитерской."
)
DEMO_RESTAURANT_ADDRESS = "Москва, Петровский бульвар, 7"

DEMO_SECTIONS: list[dict[str, Any]] = [
    {
        "name": "Завтраки весь день",
        "items": [
            {
                "name": "Сырники с вишней",
                "description": "Творожные сырники, вишнёвый соус и ванильная сметана",
                "price_minor": 59000,
                "weight_text": "240 г",
                "ingredients": "творог, яйцо, мука, вишня, сметана",
                "allergens": ["молоко", "яйцо", "глютен"],
                "is_available": True,
            },
            {
                "name": "Бриошь с лососем",
                "description": "Слабосолёный лосось, яйцо пашот и крем из авокадо",
                "price_minor": 89000,
                "weight_text": "260 г",
                "ingredients": "бриошь, лосось, яйцо, авокадо",
                "allergens": ["рыба", "яйцо", "глютен"],
                "is_available": True,
            },
            {
                "name": "Зелёная шакшука",
                "description": "Шпинат, брокколи, яйца и домашняя фета",
                "price_minor": 69000,
                "weight_text": "310 г",
                "ingredients": "яйцо, шпинат, брокколи, фета",
                "allergens": ["молоко", "яйцо"],
                "is_available": True,
            },
        ],
    },
    {
        "name": "Закуски",
        "items": [
            {
                "name": "Печёная свёкла и страчателла",
                "description": "Смородиновый соус, фундук и ароматное масло",
                "price_minor": 65000,
                "weight_text": "190 г",
                "ingredients": "свёкла, страчателла, смородина, фундук",
                "allergens": ["молоко", "орехи"],
                "is_available": True,
            },
            {
                "name": "Тартар из говядины",
                "description": "Каперсы, маринованный огурец и хрустящий картофель",
                "price_minor": 79000,
                "weight_text": "170 г",
                "ingredients": "говядина, каперсы, огурец, картофель",
                "allergens": ["горчица"],
                "is_available": False,
            },
        ],
    },
    {
        "name": "Основные блюда",
        "items": [
            {
                "name": "Утиная грудка",
                "description": "Пюре из сельдерея, сезонные ягоды и демиглас",
                "price_minor": 119000,
                "weight_text": "290 г",
                "ingredients": "утка, сельдерей, ягоды, мясной соус",
                "allergens": ["сельдерей", "молоко"],
                "is_available": True,
            },
            {
                "name": "Орзо с лесными грибами",
                "description": "Паста орзо, грибной соус, пармезан и трюфельное масло",
                "price_minor": 85000,
                "weight_text": "300 г",
                "ingredients": "паста орзо, грибы, сливки, пармезан",
                "allergens": ["глютен", "молоко"],
                "is_available": True,
            },
            {
                "name": "Форель с зелёным горошком",
                "description": "Филе форели, крем из горошка и соус бер-блан",
                "price_minor": 105000,
                "weight_text": "280 г",
                "ingredients": "форель, зелёный горошек, сливочное масло",
                "allergens": ["рыба", "молоко"],
                "is_available": True,
            },
        ],
    },
    {
        "name": "Десерты и напитки",
        "items": [
            {
                "name": "Медовик Север",
                "description": "Тонкие медовые коржи, сметанный крем и солёная карамель",
                "price_minor": 49000,
                "weight_text": "150 г",
                "ingredients": "мёд, мука, сметана, сливки",
                "allergens": ["глютен", "молоко", "яйцо"],
                "is_available": True,
            },
            {
                "name": "Домашний лимонад",
                "description": "Юдзу, жасмин и содовая",
                "price_minor": 35000,
                "weight_text": "400 мл",
                "ingredients": "юдзу, жасмин, содовая",
                "allergens": [],
                "is_available": True,
            },
        ],
    },
]


DEMO_SITE_CONFIG: dict[str, Any] = {
    "template": "cafe",
    "primary_color": "#A4472B",
    "background_color": "#F7EEDC",
    "tagline": "Завтраки весь день и сезонная кухня",
    "about": (
        "Север — спокойное городское бистро для утреннего кофе, долгого обеда "
        "и ужина с друзьями. Меню строится вокруг локальных продуктов и меняется по сезону."
    ),
    "phone": "+7 495 555-27-27",
    "hours": "Ежедневно 08:00–23:00",
    "booking_url": None,
    "logo_url": None,
    "cover_url": None,
    "gallery_urls": [],
    "blocks": [
        {"kind": "hero", "visible": True, "title": None},
        {"kind": "about", "visible": True, "title": "Наша история"},
        {"kind": "menu", "visible": True, "title": "Меню"},
        {"kind": "gallery", "visible": True, "title": "Атмосфера"},
        {"kind": "contacts", "visible": True, "title": "Ждём вас"},
    ],
}
