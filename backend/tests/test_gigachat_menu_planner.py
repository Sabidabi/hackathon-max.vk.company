import pytest

from app.ai.gigachat import GigaChatError, extract_menu_plan, menu_plan_function


def test_extracts_strict_function_plan():
    result = extract_menu_plan(
        {
            "choices": [
                {
                    "message": {
                        "function_call": {
                            "name": "propose_menu_change",
                            "arguments": (
                                '{"summary":"Добавить раф","warnings":[],'
                                '"operations":[{"type":"create_item",'
                                '"section_name":"Кофе","item":{"name":"Раф",'
                                '"base_price_minor":25000}}]}'
                            ),
                        }
                    }
                }
            ]
        }
    )

    assert result.operations[0].item.name == "Раф"
    assert result.operations[0].item.base_price_minor == 25000


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"choices": []},
        {
            "choices": [
                {"message": {"function_call": {"name": "other", "arguments": {}}}}
            ]
        },
        {
            "choices": [
                {
                    "message": {
                        "function_call": {
                            "name": "propose_menu_change",
                            "arguments": "not-json",
                        }
                    }
                }
            ]
        },
    ],
)
def test_rejects_invalid_gigachat_responses(payload):
    with pytest.raises(GigaChatError):
        extract_menu_plan(payload)


def test_function_schema_forbids_unreviewed_shapes():
    function = menu_plan_function()

    assert function["name"] == "propose_menu_change"
    assert function["parameters"]["additionalProperties"] is False
