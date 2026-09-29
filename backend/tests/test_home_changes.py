import uuid

from app.api.routes.me import count_unpublished_changes
from app.api.routes.menus import MenuItemResponse, MenuSectionResponse


def _menu(section: str, *items: tuple[str, int]) -> list[MenuSectionResponse]:
    return [MenuSectionResponse(id=uuid.uuid4(), name=section, items=[
        MenuItemResponse(id=uuid.uuid4(), name=name, price_minor=price)
        for name, price in items
    ])]


def test_identical_menus_with_new_row_ids_have_no_changes():
    assert count_unpublished_changes(
        _menu("Кофе", ("Латте", 25000), ("Раф", 31000)),
        _menu("Кофе", ("Латте", 25000), ("Раф", 31000)),
    ) == 0


def test_added_removed_and_edited_positions_are_counted_once_each():
    published = _menu("Кофе", ("Латте", 25000), ("Раф", 31000), ("Мокко", 30000))
    draft = _menu("Кофе", ("Латте", 26000), ("Раф", 31000), ("Капучино", 24000))
    assert count_unpublished_changes(draft, published) == 3


def test_never_published_draft_counts_every_position():
    assert count_unpublished_changes(_menu("Кофе", ("Латте", 25000)), []) == 1
    assert count_unpublished_changes([], []) == 0


def test_duplicate_names_are_compared_by_occurrence():
    published = _menu("Кофе", ("Латте", 25000), ("Латте", 27000))
    draft = _menu("Кофе", ("Латте", 25000), ("Латте", 28000))
    assert count_unpublished_changes(draft, published) == 1
