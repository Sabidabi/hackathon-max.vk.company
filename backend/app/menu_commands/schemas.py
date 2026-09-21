from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Money = Annotated[int, Field(strict=True, ge=0, le=100_000_000)]
Quantity = Annotated[int, Field(strict=True, ge=0, le=20)]


class ProposedVariant(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=100)
    price_minor: Money
    weight_text: str | None = Field(default=None, max_length=100)
    is_available: bool = True
    is_default: bool = False

    @field_validator("name", "weight_text")
    @classmethod
    def clean_text(cls, value: str | None) -> str | None:
        return value.strip() or None if value is not None else None


class ProposedModifierOption(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=100)
    price_minor: Money = 0
    min_quantity: Quantity = 0
    max_quantity: Quantity = 1
    default_quantity: Quantity = 0
    is_available: bool = True

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Укажите название добавки")
        return value.strip()

    @model_validator(mode="after")
    def valid_quantities(self):
        if not self.min_quantity <= self.default_quantity <= self.max_quantity:
            raise ValueError("Минимум ≤ значение по умолчанию ≤ максимум")
        return self


class ProposedModifierGroup(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=100)
    min_quantity: Quantity = 0
    max_quantity: Quantity = 1
    options: list[ProposedModifierOption] = Field(min_length=1, max_length=30)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Укажите название группы")
        return value.strip()

    @model_validator(mode="after")
    def valid_quantities(self):
        if self.min_quantity > self.max_quantity:
            raise ValueError("Минимум группы не может превышать максимум")
        if sum(option.max_quantity for option in self.options) < self.min_quantity:
            raise ValueError("Обязательный выбор группы невозможно выполнить")
        if sum(option.default_quantity for option in self.options) > self.max_quantity:
            raise ValueError("Выбор по умолчанию превышает максимум группы")
        return self


class ProposedMenuItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=250)
    description: str | None = Field(default=None, max_length=2000)
    base_price_minor: Money
    weight_text: str | None = Field(default=None, max_length=100)
    variants: list[ProposedVariant] = Field(default_factory=list, max_length=20)
    modifier_groups: list[ProposedModifierGroup] = Field(default_factory=list, max_length=20)

    @field_validator("name", "description", "weight_text")
    @classmethod
    def clean_text(cls, value: str | None) -> str | None:
        return value.strip() or None if value is not None else None

    @model_validator(mode="after")
    def one_default_variant(self):
        if sum(variant.is_default for variant in self.variants) > 1:
            raise ValueError("Только один размер может быть выбран по умолчанию")
        return self


class CreateItemOperation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["create_item"] = "create_item"
    section_name: str = Field(min_length=1, max_length=200)
    create_section_if_missing: bool = True
    item: ProposedMenuItem

    @field_validator("section_name")
    @classmethod
    def clean_section(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Укажите раздел")
        return value.strip()


class MenuChangePlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary: str = Field(min_length=1, max_length=500)
    warnings: list[str] = Field(default_factory=list, max_length=20)
    operations: list[CreateItemOperation] = Field(min_length=1, max_length=20)

    @field_validator("summary")
    @classmethod
    def clean_summary(cls, value: str) -> str:
        return value.strip()

    @field_validator("warnings")
    @classmethod
    def clean_warnings(cls, value: list[str]) -> list[str]:
        return [warning.strip() for warning in value if warning.strip()]
