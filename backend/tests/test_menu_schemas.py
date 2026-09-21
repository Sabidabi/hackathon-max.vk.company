import pytest
from pydantic import ValidationError

from app.api.routes.menus import DraftMenuPayload, MenuItemPayload, MenuSectionPayload


def test_menu_item_normalizes_optional_fields_and_allergens() -> None:
    item = MenuItemPayload(
        name="  Борщ  ",
        description="  Со сметаной  ",
        ingredients="   ",
        weight_text="  350 г ",
        price_minor=59000,
        allergens=[" молоко ", "молоко", "", " горчица "],
    )

    assert item.name == "Борщ"
    assert item.description == "Со сметаной"
    assert item.ingredients is None
    assert item.weight_text == "350 г"
    assert item.allergens == ["молоко", "горчица"]


def test_draft_rejects_more_than_one_thousand_items() -> None:
    item = MenuItemPayload(name="Позиция", price_minor=100)
    sections = [
        MenuSectionPayload(name=f"Раздел {index}", items=[item] * 101)
        for index in range(10)
    ]

    with pytest.raises(ValidationError, match="more than 1000"):
        DraftMenuPayload(sections=sections, expected_revision="0" * 64)


@pytest.mark.parametrize("name", ["", "   "])
def test_menu_rejects_empty_names(name: str) -> None:
    with pytest.raises(ValidationError):
        MenuItemPayload(name=name, price_minor=0)

    with pytest.raises(ValidationError):
        MenuSectionPayload(name=name)
