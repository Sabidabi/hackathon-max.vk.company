"""«Что изменилось»: positions are matched by ``item_key``, not by row ID or name."""

import uuid

from app.api.routes.menus import MenuItemResponse, MenuSectionPayload, MenuSectionResponse
from app.menu_diff import client_sections, diff_sections


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


def test_diff_matches_positions_by_item_key_not_by_row_or_name():
    latte, croissant, tea = uuid.UUID(int=10), uuid.UUID(int=11), uuid.UUID(int=12)
    before = [MenuSectionResponse(id=uuid.uuid4(), name="Кофе", items=[
        _item(item_key=latte, configuration={}),
        _item(item_key=croissant, name="Круассан", price_minor=15000, configuration={}),
    ])]
    after = [
        MenuSectionResponse(id=uuid.uuid4(), name="Кофе", items=[
            # New row ID and a new name: still the same position.
            _item(item_key=latte, name="Латте XL", price_minor=21000, configuration={}),
        ]),
        MenuSectionResponse(id=uuid.uuid4(), name="Чай", items=[
            _item(item_key=tea, name="Чай", price_minor=9000, configuration={}),
        ]),
    ]
    diff = diff_sections(before, after)
    assert [item.name for item in diff.added] == ["Чай"]
    assert [item.name for item in diff.removed] == ["Круассан"]
    [changed] = diff.changed
    assert changed.item_key == latte
    assert {change.field: (change.before, change.after) for change in changed.changes} == {
        "name": ("Латте", "Латте XL"),
        "price_minor": (19000, 21000),
    }
    assert diff.sections_added == ["Чай"] and diff.sections_removed == []
    assert diff.total_changes == 3
    assert diff_sections(after, after).total_changes == 0


def test_client_copy_with_a_duplicated_item_key_keeps_both_positions():
    """Review P1-PLAN-7: a duplicated ``item_key`` in the client's copy must not collapse
    two positions into one; the second counts as new, as a draft save would store it."""
    latte = uuid.UUID(int=10)
    server = [MenuSectionResponse(id=uuid.uuid4(), name="Кофе", items=[
        _item(item_key=latte, configuration={}),
    ])]
    payload = [MenuSectionPayload.model_validate({"name": "Кофе", "items": [
        {"item_key": str(latte), "name": "Латте", "price_minor": 19000},
        {"item_key": str(latte), "name": "Раф", "price_minor": 22000},
        {"item_key": str(uuid.UUID(int=99)), "name": "Какао", "price_minor": 17000},
    ]})]
    client = client_sections(payload, server)
    keys = [item.item_key for item in client[0].items]
    assert keys[0] == latte
    assert len(set(keys)) == 3
    # The endpoint reads «client copy → server»: both extra positions are missing there.
    diff = diff_sections(client, server)
    assert sorted(item.name for item in diff.removed) == ["Какао", "Раф"]
    assert diff.added == [] and diff.changed == []
