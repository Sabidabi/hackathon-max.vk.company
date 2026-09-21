"""Menu configuration and exact, server-side price calculation (no payment side effects)."""

import uuid
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Money = Annotated[int, Field(strict=True, ge=0, le=100_000_000)]
Quantity = Annotated[int, Field(strict=True, ge=0, le=20)]


class NamedOption(BaseModel):
    id: uuid.UUID
    name: str = Field(min_length=1, max_length=100)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Укажите название")
        return value.strip()


class Variant(NamedOption):
    price_minor: Money
    weight_text: str | None = Field(default=None, max_length=100)
    is_available: bool = True


class ModifierOption(NamedOption):
    price_minor: Money = 0
    min_quantity: Quantity = 0
    max_quantity: Quantity = 1
    default_quantity: Quantity = 0
    is_available: bool = True
    price_by_variant: dict[uuid.UUID, Money] = Field(default_factory=dict, max_length=20)

    @model_validator(mode="after")
    def quantities(self):
        if not self.min_quantity <= self.default_quantity <= self.max_quantity:
            raise ValueError("Добавка: минимум ≤ по умолчанию ≤ максимум")
        return self


class ModifierGroup(NamedOption):
    min_quantity: Quantity = 0
    max_quantity: Quantity = 1
    options: list[ModifierOption] = Field(min_length=1, max_length=30)

    @model_validator(mode="after")
    def quantities(self):
        if self.min_quantity > self.max_quantity:
            raise ValueError("Минимум группы не может превышать максимум")
        if max(self.min_quantity, sum(o.min_quantity for o in self.options)) > min(
            self.max_quantity, sum(o.max_quantity for o in self.options)
        ):
            raise ValueError("Ограничения группы нельзя выполнить")
        if sum(o.default_quantity for o in self.options) > self.max_quantity:
            raise ValueError("Выбор по умолчанию превышает максимум группы")
        return self


class ItemConfiguration(BaseModel):
    variants: list[Variant] = Field(default_factory=list, max_length=20)
    default_variant_id: uuid.UUID | None = None
    modifier_groups: list[ModifierGroup] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def references(self):
        variant_ids = {v.id for v in self.variants}
        ids = (
            [v.id for v in self.variants]
            + [g.id for g in self.modifier_groups]
            + [o.id for g in self.modifier_groups for o in g.options]
        )
        if len(ids) != len(set(ids)):
            raise ValueError("Идентификаторы размеров, групп и добавок должны быть уникальны")
        if self.default_variant_id is not None and self.default_variant_id not in variant_ids:
            raise ValueError("Размер по умолчанию отсутствует")
        for group in self.modifier_groups:
            for option in group.options:
                if not set(option.price_by_variant).issubset(variant_ids):
                    raise ValueError("Доплата ссылается на неизвестный размер")
        return self


def availability_error(config: ItemConfiguration) -> str | None:
    if config.variants and not any(v.is_available for v in config.variants):
        return "нет доступного размера"
    for group in config.modifier_groups:
        if any(o.min_quantity and not o.is_available for o in group.options):
            return f"обязательная добавка в группе «{group.name}» недоступна"
        if sum(o.max_quantity for o in group.options if o.is_available) < group.min_quantity:
            return f"нельзя выполнить обязательный выбор «{group.name}»"
    return None


class ModifierSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    option_id: uuid.UUID
    quantity: Annotated[int, Field(strict=True, ge=1, le=20)]


class QuotePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    item_id: uuid.UUID
    variant_id: uuid.UUID | None = None
    modifiers: list[ModifierSelection] = Field(default_factory=list, max_length=600)
    quantity: Annotated[int, Field(strict=True, ge=1, le=99)] = 1


def calculate_unit_price(
    base_price: int, config: ItemConfiguration, selection: QuotePayload
) -> int:
    variants = {v.id: v for v in config.variants}
    if variants:
        variant = variants.get(selection.variant_id)
        if variant is None or not variant.is_available:
            raise ValueError("Выберите доступный размер")
        price = variant.price_minor
    else:
        if selection.variant_id is not None:
            raise ValueError("У позиции нет такого размера")
        price = base_price
    quantities = {s.option_id: s.quantity for s in selection.modifiers}
    if len(quantities) != len(selection.modifiers):
        raise ValueError("Добавка указана дважды")
    known_ids = {o.id for g in config.modifier_groups for o in g.options}
    if not quantities.keys() <= known_ids:
        raise ValueError("Неизвестная добавка")
    for group in config.modifier_groups:
        total = sum(quantities.get(o.id, 0) for o in group.options)
        if not group.min_quantity <= total <= group.max_quantity:
            raise ValueError(
                f"«{group.name}»: выберите от {group.min_quantity} до {group.max_quantity}"
            )
        for option in group.options:
            quantity = quantities.get(option.id, 0)
            if quantity and not option.is_available:
                raise ValueError(f"«{option.name}» недоступно")
            if not option.min_quantity <= quantity <= option.max_quantity:
                raise ValueError(f"«{option.name}»: неверное количество")
            price += quantity * option.price_by_variant.get(
                selection.variant_id, option.price_minor
            )
    return price
