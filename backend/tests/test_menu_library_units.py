"""Pure rules of the venue menu library: show hours and point overrides."""

import uuid
from datetime import time
from types import SimpleNamespace

from app.api.routes.menus import MenuItemResponse, MenuSectionResponse
from app.menu_configuration import ItemConfiguration, QuotePayload, calculate_unit_price
from app.menu_library import apply_override, apply_overrides, is_shown_at


def test_show_hours_are_half_open_and_may_span_midnight():
    assert is_shown_at(None, None, time(3, 0))
    assert is_shown_at(time(8), time(12), time(8))
    assert is_shown_at(time(8), time(12), time(11, 59))
    assert not is_shown_at(time(8), time(12), time(12))
    assert not is_shown_at(time(8), time(12), time(13))
    assert is_shown_at(time(22), time(2), time(23, 30))
    assert is_shown_at(time(22), time(2), time(1, 59))
    assert not is_shown_at(time(22), time(2), time(12))


def _item(**changes) -> MenuItemResponse:
    small, large = uuid.UUID(int=1), uuid.UUID(int=2)
    base = {
        "id": uuid.uuid4(),
        "item_key": uuid.UUID(int=10),
        "name": "Латте",
        "price_minor": 19000,
        "configuration": {
            "variants": [
                {"id": str(small), "name": "S", "price_minor": 19000},
                {"id": str(large), "name": "L", "price_minor": 23000},
            ],
            "default_variant_id": str(small),
        },
    }
    return MenuItemResponse.model_validate(base | changes)


def test_point_override_replaces_availability_and_prices_for_the_quote():
    item = _item()
    override = SimpleNamespace(
        available=False, price_minor=26000, variant_prices={str(uuid.UUID(int=2)): 30000}
    )
    effective = apply_override(item, override)
    assert effective.is_available is False
    assert effective.price_minor == 26000
    prices = {variant.id: variant.price_minor for variant in effective.configuration.variants}
    assert prices == {uuid.UUID(int=1): 19000, uuid.UUID(int=2): 30000}
    quote = QuotePayload(item_id=item.id, variant_id=uuid.UUID(int=2))
    assert calculate_unit_price(effective.price_minor, effective.configuration, quote) == 30000
    # The menu snapshot itself is untouched.
    assert item.is_available is True and item.configuration.variants[1].price_minor == 23000


def test_override_with_only_availability_keeps_menu_prices():
    item = _item(configuration=ItemConfiguration().model_dump(mode="json"))
    effective = apply_override(
        item, SimpleNamespace(available=True, price_minor=None, variant_prices={})
    )
    assert effective.price_minor == 19000 and effective.is_available is True
    assert apply_override(item, None) is item
    section = MenuSectionResponse(id=uuid.uuid4(), name="Кофе", items=[item])
    assert apply_overrides([section], {}) == [section]
