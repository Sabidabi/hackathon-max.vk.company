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
    assert result["unparsed_lines"] == ["Состав уточняйте у официанта"]


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
