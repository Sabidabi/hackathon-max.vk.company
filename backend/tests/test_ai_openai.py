import httpx
import pytest

from app.ai import openai_compat
from app.ai.openai_compat import (
    OpenAICompatError,
    OpenAICompatMenuPlanner,
    menu_plan_function,
    parse_menu_plan,
    tool_arguments,
)
from app.ai.provider import AIInvalidResponse, configured_provider_name
from app.config import Settings

PLAN = (
    '{"summary":"Добавить раф","warnings":[],"operations":[{"type":"create_item",'
    '"section_name":"Кофе","item":{"name":"Раф","base_price_minor":25000}}]}'
)


def tool_payload(name: str, arguments: str) -> dict:
    return {"choices": [{"message": {"tool_calls": [
        {"type": "function", "function": {"name": name, "arguments": arguments}}
    ]}}]}


def test_provider_selected_only_with_key():
    assert configured_provider_name(Settings(ai_api_key="", ai_provider="auto")) is None
    assert configured_provider_name(Settings(ai_api_key="k", ai_provider="auto")) == "openai"
    assert configured_provider_name(Settings(ai_api_key="k", ai_provider="off")) is None
    assert configured_provider_name(Settings(ai_api_key="", ai_provider="openai")) is None


def test_tool_arguments_and_plan():
    arguments = tool_arguments(tool_payload("propose_menu_change", PLAN), "propose_menu_change")
    plan = parse_menu_plan(arguments)
    assert plan.operations[0].item.base_price_minor == 25000


@pytest.mark.parametrize(
    "payload",
    [{}, {"choices": []}, tool_payload("other", "{}"), {"choices": [{"message": {}}]}],
)
def test_rejects_missing_tool_call(payload):
    with pytest.raises(AIInvalidResponse):
        tool_arguments(payload, "propose_menu_change")


@pytest.mark.parametrize("content", [PLAN, f"```json\n{PLAN}\n```"])
def test_accepts_json_object_in_text_instead_of_tool_call(content):
    payload = {"choices": [{"message": {"content": content}}]}
    arguments = tool_arguments(payload, "propose_menu_change")
    assert parse_menu_plan(arguments).operations[0].item.name == "Раф"


def test_rejects_free_text_answer():
    payload = {"choices": [{"message": {"content": "Добавьте раф за 250 рублей"}}]}
    with pytest.raises(AIInvalidResponse):
        tool_arguments(payload, "propose_menu_change")


def test_rejects_invalid_plan():
    with pytest.raises(OpenAICompatError):
        parse_menu_plan("not-json")


def test_function_schema_forbids_unreviewed_shapes():
    assert menu_plan_function()["parameters"]["additionalProperties"] is False


async def test_planner_repairs_one_invalid_answer(monkeypatch):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        body = json.loads(request.read())
        seen.append(body)
        arguments = '{"summary":"Без операций","operations":[]}' if len(seen) == 1 else PLAN
        return httpx.Response(200, json=tool_payload("propose_menu_change", arguments))

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        openai_compat.httpx, "AsyncClient",
        lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw),
    )
    plan = await OpenAICompatMenuPlanner(Settings(ai_api_key="test-key")).generate(
        "Добавь раф 250 ₽", "[]"
    )
    assert plan.operations[0].item.base_price_minor == 25000
    assert len(seen) == 2
    assert "request" in seen[0]["messages"][1]["content"]
    assert "Добавь раф 250 ₽" in seen[0]["messages"][1]["content"]
    assert "не прошёл проверку" in seen[1]["messages"][-1]["content"]


async def test_planner_does_not_retry_provider_error(monkeypatch):
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(503)

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        openai_compat.httpx, "AsyncClient",
        lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw),
    )
    with pytest.raises(OpenAICompatError):
        await OpenAICompatMenuPlanner(Settings(ai_api_key="k")).generate("Раф", "[]")
    assert calls == 1


async def test_planner_sends_forced_tool_call(monkeypatch):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["Authorization"]
        seen["body"] = request.read().decode()
        return httpx.Response(200, json=tool_payload("propose_menu_change", PLAN))

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        openai_compat.httpx, "AsyncClient",
        lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw),
    )
    settings = Settings(ai_api_key="test-key", ai_base_url="https://gw.test/api/v1/")
    plan = await OpenAICompatMenuPlanner(settings).generate("Добавь раф", "[]")

    assert plan.operations[0].item.name == "Раф"
    assert seen["url"] == "https://gw.test/api/v1/chat/completions"
    assert seen["auth"] == "Bearer test-key"
    assert '"tool_choice"' in seen["body"]


async def test_planner_http_error_is_unavailable(monkeypatch):
    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        openai_compat.httpx, "AsyncClient",
        lambda **kw: real_client(
            transport=httpx.MockTransport(lambda r: httpx.Response(500)), **kw
        ),
    )
    with pytest.raises(OpenAICompatError):
        await OpenAICompatMenuPlanner(Settings(ai_api_key="k")).generate("x", "[]")
