import pytest
from pydantic import ValidationError

from app.api.routes.restaurants import RestaurantCreate, RestaurantUpdate


def test_restaurant_create_strips_fields() -> None:
    payload = RestaurantCreate(
        name="  Лес  ",
        address="  Невский проспект, 1  ",
        description="   ",
    )

    assert payload.name == "Лес"
    assert payload.address == "Невский проспект, 1"
    assert payload.description is None


def test_restaurant_name_cannot_be_blank() -> None:
    with pytest.raises(ValidationError):
        RestaurantCreate(name="   ")

    with pytest.raises(ValidationError):
        RestaurantUpdate(name="   ")

    with pytest.raises(ValidationError):
        RestaurantUpdate(name=None)

    assert RestaurantUpdate().model_dump(exclude_unset=True) == {}
