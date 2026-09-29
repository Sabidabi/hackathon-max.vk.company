from pathlib import Path

import pytest

from app.imports.processor import parse_price, resolve_data_path, structure_menu_text


def test_structures_sections_and_items_without_inventing_fields() -> None:
    result = structure_menu_text(
        """
        САЛАТЫ
        Цезарь с курицей 590 ₽
        Греческий 450

        НАПИТКИ
        Морс 250,00 руб.
        Состав уточняйте у официанта
        """
    )

    assert result["item_count"] == 3
    sections = result["sections"]
    assert isinstance(sections, list)
    assert sections[0]["name"] == "САЛАТЫ"
    assert sections[0]["items"][0] == {
        "name": "Цезарь с курицей",
        "price_minor": 59000,
        "currency": "RUB",
        "weight_text": None,
        "sort_order": 0,
        "source_line": "Цезарь с курицей 590 ₽",
        "source_confidence": 0.75,
    }
    # A line after «название … цена» without a price is that item's description.
    assert sections[1]["items"][0]["description"] == "Состав уточняйте у официанта"
    assert result["unparsed_lines"] == []


def test_joins_wrapped_names_with_weight_and_price() -> None:
    result = structure_menu_text(
        """
        САЛАТЫ
        Салат с запечёнными баклажанами,
        томатами и сыром «Страчателла»
        200 г – 685
        """
    )

    sections = result["sections"]
    assert result["item_count"] == 1
    assert sections[0]["name"] == "САЛАТЫ"
    assert sections[0]["items"][0]["name"] == (
        "Салат с запечёнными баклажанами, томатами и сыром «Страчателла»"
    )
    assert sections[0]["items"][0]["weight_text"] == "200 г"
    assert sections[0]["items"][0]["price_minor"] == 68500


def test_parses_two_pdf_columns_and_merges_repeated_sections() -> None:
    result = structure_menu_text(
        """
        ГАРНИРЫ
        Овощи гриль   Картофель «Бэби»
        150 г – 495    150 г – 200
        ГАРНИРЫ
        Рис 150
        """
    )

    sections = result["sections"]
    assert len(sections) == 1
    assert result["item_count"] == 3
    assert [item["name"] for item in sections[0]["items"]] == [
        "Овощи гриль",
        "Картофель «Бэби»",
        "Рис",
    ]


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        ("Борщ 420", ("Борщ", 42000)),
        ("Кофе 199,50 руб.", ("Кофе", 19950)),
        ("Текст без цены", None),
    ],
)
def test_parse_price(line: str, expected: tuple[str, int] | None) -> None:
    assert parse_price(line) == expected


def test_resolve_data_path_rejects_escape(tmp_path: Path) -> None:
    assert resolve_data_path(tmp_path, "uploads/source.pdf").is_relative_to(tmp_path)
    with pytest.raises(ValueError, match="outside"):
        resolve_data_path(tmp_path, "../secret.txt")


def _items(text: str) -> dict[str, dict]:
    result = structure_menu_text(text)
    return {i["name"]: i for section in result["sections"] for i in section["items"]}


def test_description_on_the_next_line_is_not_part_of_the_next_name() -> None:
    items = _items(
        """
        ВЫПЕЧКА
        Сырники 290
        Со сметаной и джемом
        Круассан 150
        Сливочный, слоёный
        Эклер 180
        """
    )
    assert list(items) == ["Сырники", "Круассан", "Эклер"]
    assert items["Сырники"]["description"] == "Со сметаной и джемом"
    assert items["Круассан"]["description"] == "Сливочный, слоёный"
    assert "description" not in items["Эклер"] and items["Эклер"]["price_minor"] == 18000


def test_name_and_description_on_one_line() -> None:
    items = _items(
        """
        ВЫПЕЧКА
        Сырники со сметаной и джемом 290
        Круассан — сливочный, слоёный 150
        Эклер. Заварной крем и шоколад 180
        Чизкейк с ягодами, нежный творожный сыр и хрустящая основа 320
        """
    )
    assert "Круассан" in items and items["Круассан"]["description"] == "сливочный, слоёный"
    assert items["Круассан"]["price_minor"] == 15000
    assert items["Эклер"]["description"] == "Заварной крем и шоколад"
    assert items["Чизкейк с ягодами"]["description"] == (
        "нежный творожный сыр и хрустящая основа"
    )
    assert "Сырники со сметаной и джемом" in items  # short name without a separator


def test_description_before_the_price_line_and_weight_stays_apart() -> None:
    items = _items(
        """
        ВЫПЕЧКА
        Медовик
        Нежные коржи и сливочный крем
        250 г – 320
        Штрудель — яблоко и корица 150 г 210
        Маффин 90 г 130
        """
    )
    assert items["Медовик"]["description"] == "Нежные коржи и сливочный крем"
    assert items["Медовик"]["weight_text"] == "250 г" and items["Медовик"]["price_minor"] == 32000
    assert items["Штрудель"]["weight_text"] == "150 г"
    assert items["Штрудель"]["description"] == "яблоко и корица"
    assert items["Маффин"]["weight_text"] == "90 г" and items["Маффин"]["price_minor"] == 13000


def test_neighbouring_items_are_not_glued_together() -> None:
    result = structure_menu_text(
        """
        НАПИТКИ
        Латте 200
        Эспрессо с молоком
        Капучино 190
        Раф 250
        """
    )
    items = result["sections"][0]["items"]
    assert [i["name"] for i in items] == ["Латте", "Капучино", "Раф"]
    assert items[0]["description"] == "Эспрессо с молоком"
    assert "description" not in items[1] and "description" not in items[2]
