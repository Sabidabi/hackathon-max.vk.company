import uuid
from collections.abc import Callable
from typing import TYPE_CHECKING

from app.menu_commands.schemas import MenuChangePlan, ProposedMenuItem
from app.menu_configuration import ItemConfiguration, ModifierGroup, ModifierOption, Variant

if TYPE_CHECKING:
    from app.api.routes.menus import MenuSectionPayload, MenuSectionResponse


def _configuration(
    item: ProposedMenuItem,
    id_factory: Callable[[], uuid.UUID],
) -> ItemConfiguration:
    variants: list[Variant] = []
    default_variant_id: uuid.UUID | None = None
    for index, source in enumerate(item.variants):
        variant_id = id_factory()
        variants.append(
            Variant(
                id=variant_id,
                name=source.name,
                price_minor=source.price_minor,
                weight_text=source.weight_text,
                is_available=source.is_available,
            )
        )
        if source.is_default or (default_variant_id is None and index == 0):
            default_variant_id = variant_id

    groups = [
        ModifierGroup(
            id=id_factory(),
            name=group.name,
            min_quantity=group.min_quantity,
            max_quantity=group.max_quantity,
            options=[
                ModifierOption(
                    id=id_factory(),
                    name=option.name,
                    price_minor=option.price_minor,
                    min_quantity=option.min_quantity,
                    max_quantity=option.max_quantity,
                    default_quantity=option.default_quantity,
                    is_available=option.is_available,
                )
                for option in group.options
            ],
        )
        for group in item.modifier_groups
    ]
    return ItemConfiguration(
        variants=variants,
        default_variant_id=default_variant_id,
        modifier_groups=groups,
    )


def apply_menu_change_plan(
    current: list["MenuSectionResponse"],
    plan: MenuChangePlan,
    id_factory: Callable[[], uuid.UUID] = uuid.uuid4,
) -> list["MenuSectionPayload"]:
    """Apply a validated AI/MCP plan in memory. This function never publishes."""
    # Imported lazily so the command layer can also be reused by the MCP server
    # without creating an import cycle with FastAPI route registration.
    from app.api.routes.menus import MenuItemPayload, MenuSectionPayload

    sections = [
        MenuSectionPayload(
            name=section.name,
            items=[MenuItemPayload.model_validate(item.model_dump()) for item in section.items],
        )
        for section in current
    ]
    for operation in plan.operations:
        section = next(
            (
                candidate
                for candidate in sections
                if candidate.name.casefold() == operation.section_name.casefold()
            ),
            None,
        )
        if section is None:
            if not operation.create_section_if_missing:
                raise ValueError(f"Раздел «{operation.section_name}» не найден")
            section = MenuSectionPayload(name=operation.section_name, items=[])
            sections.append(section)
        section.items.append(
            MenuItemPayload(
                name=operation.item.name,
                description=operation.item.description,
                price_minor=operation.item.base_price_minor,
                weight_text=operation.item.weight_text,
                configuration=_configuration(operation.item, id_factory),
            )
        )
    return sections
