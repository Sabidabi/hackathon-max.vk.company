import uuid

from app.menu_commands.schemas import MenuChangePlan
from app.menu_commands.service import apply_menu_change_plan


def test_ai_plan_creates_cappuccino_with_sizes_and_required_milk_choice():
    plan = MenuChangePlan.model_validate(
        {
            "summary": "Добавить капучино",
            "warnings": [],
            "operations": [
                {
                    "type": "create_item",
                    "section_name": "Кофе",
                    "item": {
                        "name": "Капучино",
                        "description": "Эспрессо и молоко",
                        "base_price_minor": 19000,
                        "variants": [
                            {
                                "name": "300 мл",
                                "price_minor": 19000,
                                "weight_text": "300 мл",
                                "is_default": True,
                            },
                            {
                                "name": "400 мл",
                                "price_minor": 23000,
                                "weight_text": "400 мл",
                            },
                        ],
                        "modifier_groups": [
                            {
                                "name": "Молоко",
                                "min_quantity": 1,
                                "max_quantity": 1,
                                "options": [
                                    {"name": "Обычное", "price_minor": 0},
                                    {"name": "Кокосовое", "price_minor": 6000},
                                ],
                            }
                        ],
                    },
                }
            ],
        }
    )
    ids = iter(uuid.UUID(int=value) for value in range(1, 20))

    sections = apply_menu_change_plan([], plan, lambda: next(ids))

    assert len(sections) == 1
    item = sections[0].items[0]
    assert item.name == "Капучино"
    assert item.price_minor == 19000
    assert [variant.weight_text for variant in item.configuration.variants] == [
        "300 мл",
        "400 мл",
    ]
    assert item.configuration.default_variant_id == item.configuration.variants[0].id
    group = item.configuration.modifier_groups[0]
    assert (group.min_quantity, group.max_quantity) == (1, 1)
    assert group.options[1].price_minor == 6000


def test_ai_plan_does_not_publish_or_mutate_existing_sections():
    from app.api.routes.menus import MenuItemResponse, MenuSectionResponse

    current = [
        MenuSectionResponse(
            id=uuid.uuid4(),
            name="Десерты",
            items=[MenuItemResponse(id=uuid.uuid4(), name="Кекс", price_minor=9000)],
        )
    ]
    plan = MenuChangePlan.model_validate(
        {
            "summary": "Добавить чай",
            "operations": [
                {
                    "section_name": "Чай",
                    "item": {"name": "Эрл Грей", "base_price_minor": 15000},
                }
            ],
        }
    )

    result = apply_menu_change_plan(current, plan)

    assert [section.name for section in result] == ["Десерты", "Чай"]
    assert [section.name for section in current] == ["Десерты"]
    assert current[0].items[0].name == "Кекс"
