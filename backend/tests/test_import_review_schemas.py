import pytest
from pydantic import ValidationError

from app.api.routes.imports import MenuReviewPayload


def test_review_payload_validates_menu_shape() -> None:
    payload = MenuReviewPayload.model_validate(
        {
            "sections": [
                {
                    "name": "Супы",
                    "items": [
                        {
                            "name": "Борщ",
                            "price_minor": 45000,
                            "weight_text": "350 г",
                        }
                    ],
                }
            ]
        }
    )

    assert payload.sections[0].items[0].currency == "RUB"


@pytest.mark.parametrize(
    "data",
    [
        {"sections": []},
        {"sections": [{"name": "", "items": [{"name": "Борщ", "price_minor": 1}]}]},
        {"sections": [{"name": "Супы", "items": []}]},
        {"sections": [{"name": "Супы", "items": [{"name": "", "price_minor": 1}]}]},
        {"sections": [{"name": "Супы", "items": [{"name": "Борщ", "price_minor": -1}]}]},
    ],
)
def test_review_payload_rejects_invalid_menu(data: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        MenuReviewPayload.model_validate(data)
