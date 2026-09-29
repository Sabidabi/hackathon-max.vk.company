from app.api.routes.menus import MenuItemResponse, MenuSectionResponse, publish_problems
from app.menu_templates import template_sections


def test_coffee_template_has_no_prices() -> None:
    sections = template_sections("coffee")
    items = [item for section in sections for item in section.items]
    assert len(items) >= 8
    assert all(item.price_minor == 0 for item in items)


def test_unpriced_template_blocks_publication() -> None:
    import uuid

    sections = [
        MenuSectionResponse(
            id=uuid.uuid4(),
            name=section.name,
            items=[
                MenuItemResponse(id=uuid.uuid4(), **item.model_dump(exclude={"item_key"}))
                for item in section.items
            ],
        )
        for section in template_sections("coffee")
    ]
    problems = publish_problems(sections)
    assert problems and all(problem.code == "no_price" for problem in problems)
