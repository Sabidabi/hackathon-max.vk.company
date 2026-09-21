import uuid

import pytest
from pydantic import ValidationError

from app.menu_configuration import (
    ItemConfiguration,
    QuotePayload,
    availability_error,
    calculate_unit_price,
)


def configured_item() -> tuple[ItemConfiguration, dict[str, uuid.UUID]]:
    ids = {
        "small": uuid.uuid4(),
        "large": uuid.uuid4(),
        "milk_group": uuid.uuid4(),
        "regular": uuid.uuid4(),
        "oat": uuid.uuid4(),
        "syrup_group": uuid.uuid4(),
        "syrup": uuid.uuid4(),
    }
    config = ItemConfiguration.model_validate(
        {
            "variants": [
                {"id": ids["small"], "name": "250 мл", "price_minor": 19000},
                {"id": ids["large"], "name": "350 мл", "price_minor": 24000},
            ],
            "default_variant_id": ids["small"],
            "modifier_groups": [
                {
                    "id": ids["milk_group"],
                    "name": "Молоко",
                    "min_quantity": 1,
                    "max_quantity": 1,
                    "options": [
                        {
                            "id": ids["regular"],
                            "name": "Обычное",
                            "default_quantity": 1,
                        },
                        {
                            "id": ids["oat"],
                            "name": "Овсяное",
                            "price_minor": 4000,
                            "price_by_variant": {str(ids["large"]): 6000},
                        },
                    ],
                },
                {
                    "id": ids["syrup_group"],
                    "name": "Сироп",
                    "min_quantity": 0,
                    "max_quantity": 2,
                    "options": [
                        {
                            "id": ids["syrup"],
                            "name": "Ваниль",
                            "price_minor": 3000,
                            "max_quantity": 2,
                        }
                    ],
                },
            ],
        }
    )
    return config, ids


def test_calculates_variant_and_per_variant_modifier_price_in_kopecks() -> None:
    config, ids = configured_item()
    payload = QuotePayload(
        item_id=uuid.uuid4(),
        variant_id=ids["large"],
        modifiers=[
            {"option_id": ids["oat"], "quantity": 1},
            {"option_id": ids["syrup"], "quantity": 2},
        ],
    )

    assert calculate_unit_price(1, config, payload) == 36000


def test_requires_mandatory_group_and_enforces_group_maximum() -> None:
    config, ids = configured_item()

    with pytest.raises(ValueError, match="Молоко"):
        calculate_unit_price(
            19000,
            config,
            QuotePayload(item_id=uuid.uuid4(), variant_id=ids["small"]),
        )

    with pytest.raises(ValueError, match="Сироп"):
        calculate_unit_price(
            19000,
            config,
            QuotePayload(
                item_id=uuid.uuid4(),
                variant_id=ids["small"],
                modifiers=[
                    {"option_id": ids["regular"], "quantity": 1},
                    {"option_id": ids["syrup"], "quantity": 3},
                ],
            ),
        )


def test_rejects_unknown_duplicate_and_unavailable_selection() -> None:
    config, ids = configured_item()
    base = {"item_id": uuid.uuid4(), "variant_id": ids["small"]}

    with pytest.raises(ValueError, match="Неизвестная добавка"):
        calculate_unit_price(
            19000,
            config,
            QuotePayload(
                **base,
                modifiers=[
                    {"option_id": ids["regular"], "quantity": 1},
                    {"option_id": uuid.uuid4(), "quantity": 1},
                ],
            ),
        )

    with pytest.raises(ValueError, match="указана дважды"):
        calculate_unit_price(
            19000,
            config,
            QuotePayload(
                **base,
                modifiers=[
                    {"option_id": ids["regular"], "quantity": 1},
                    {"option_id": ids["regular"], "quantity": 1},
                ],
            ),
        )

    config.modifier_groups[0].options[0].is_available = False
    with pytest.raises(ValueError, match="недоступно"):
        calculate_unit_price(
            19000,
            config,
            QuotePayload(
                **base,
                modifiers=[{"option_id": ids["regular"], "quantity": 1}],
            ),
        )


def test_publication_guard_detects_impossible_required_choices() -> None:
    config, _ = configured_item()
    for option in config.modifier_groups[0].options:
        option.is_available = False

    assert availability_error(config) is not None


def test_schema_rejects_impossible_limits_bad_references_and_float_money() -> None:
    option_id = uuid.uuid4()
    with pytest.raises(ValidationError):
        ItemConfiguration.model_validate(
            {
                "modifier_groups": [
                    {
                        "id": uuid.uuid4(),
                        "name": "Выбор",
                        "min_quantity": 2,
                        "max_quantity": 2,
                        "options": [
                            {
                                "id": option_id,
                                "name": "Один вариант",
                                "max_quantity": 1,
                            }
                        ],
                    }
                ]
            }
        )

    with pytest.raises(ValidationError):
        ItemConfiguration.model_validate(
            {
                "variants": [
                    {"id": uuid.uuid4(), "name": "Маленький", "price_minor": 100.5}
                ]
            }
        )

    with pytest.raises(ValidationError):
        ItemConfiguration.model_validate(
            {
                "modifier_groups": [
                    {
                        "id": uuid.uuid4(),
                        "name": "Добавки",
                        "options": [
                            {
                                "id": uuid.uuid4(),
                                "name": "Сыр",
                                "price_by_variant": {str(uuid.uuid4()): 1000},
                            }
                        ],
                    }
                ]
            }
        )


def test_quote_payload_rejects_extra_fields_and_fractional_quantity() -> None:
    with pytest.raises(ValidationError):
        QuotePayload.model_validate(
            {"item_id": str(uuid.uuid4()), "quantity": 1.5, "client_price": 100}
        )
