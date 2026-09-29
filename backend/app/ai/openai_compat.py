"""The AI provider: OpenAI-compatible chat completions (RouterAI and similar gateways).

One completion is forced to call a function; its arguments are validated by our code.
"""

import json
from typing import Any

import httpx
from pydantic import ValidationError

from app.ai.provider import (
    AIInvalidResponse,
    AITask,
    AIUnavailable,
    build_messages,
    function_spec,
)
from app.config import Settings
from app.menu_commands.schemas import MenuChangePlan


class OpenAICompatError(RuntimeError):
    pass


SYSTEM_PROMPT = """Ты создаёшь только план изменений меню кофейни.
Все суммы возвращай целыми копейками: 190 рублей = 19000.
Не выдумывай цены, состав и аллергены. Если данных нет, добавь предупреждение.
Размеры имеют абсолютную цену. Обязательная группа имеет min_quantity > 0.
Вызови функцию propose_menu_change и не добавляй свободный текст."""


def menu_plan_function() -> dict[str, Any]:
    return {
        "name": "propose_menu_change",
        "description": "Сформировать проверяемый план добавления карточек в черновик меню",
        "parameters": MenuChangePlan.model_json_schema(),
    }


def parse_menu_plan(arguments: Any) -> MenuChangePlan:
    try:
        if isinstance(arguments, str):
            arguments = json.loads(arguments)
        return MenuChangePlan.model_validate(arguments)
    except (json.JSONDecodeError, ValidationError, TypeError) as error:
        raise OpenAICompatError("ИИ вернул некорректный план меню") from error


def tool_arguments(payload: dict[str, Any], name: str) -> Any:
    """Arguments of the forced tool call, or ``AIInvalidResponse``."""
    try:
        message = payload["choices"][0]["message"]
        calls = message.get("tool_calls") or []
        for call in calls:
            function = call["function"]
            if function["name"] == name:
                return function["arguments"]
        legacy = message.get("function_call")
        if legacy and legacy["name"] == name:
            return legacy["arguments"]
        # Some models answer with the arguments as a JSON object in the text instead of a
        # tool call. Accept only a bare JSON object; the task schema still validates it.
        content = (message.get("content") or "").strip()
        if content.startswith("```"):
            content = content.strip("`").removeprefix("json").strip()
        if content.startswith("{") and content.endswith("}"):
            return content
        raise KeyError("no expected tool call")
    except (KeyError, IndexError, TypeError, AttributeError) as error:
        raise AIInvalidResponse("ИИ вернул ответ не по схеме") from error


class OpenAICompatClient:
    def __init__(self, settings: Settings):
        self.settings = settings

    async def chat(self, messages: list[dict[str, str]], function: dict[str, Any]) -> Any:
        """One completion forced to call ``function``; returns its raw arguments."""
        api_key = self.settings.ai_api_key.strip()
        if not api_key:
            raise OpenAICompatError("ИИ не настроен")
        timeout = httpx.Timeout(self.settings.ai_request_timeout_seconds)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                f"{self.settings.ai_base_url.rstrip('/')}/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
                json={
                    "model": self.settings.ai_model,
                    "messages": messages,
                    "tools": [{"type": "function", "function": function}],
                    "tool_choice": {"type": "function", "function": {"name": function["name"]}},
                    "temperature": 0,
                },
            )
        if response.is_error:
            raise OpenAICompatError(f"ИИ-сервис вернул {response.status_code}")
        return tool_arguments(response.json(), function["name"])


class OpenAICompatProvider:
    """Structured answers for the AI tasks (``app.ai.provider.AITask``)."""

    name = "openai"

    def __init__(self, settings: Settings):
        self.model = settings.ai_model
        self._client = OpenAICompatClient(settings)

    async def complete(self, task: AITask) -> Any:
        try:
            return await self._client.chat(build_messages(task), function_spec(task))
        except (OpenAICompatError, httpx.HTTPError, ValueError) as error:
            raise AIUnavailable("ИИ сейчас недоступен") from error


class OpenAICompatMenuPlanner:
    """The menu composer: a reviewable plan of draft changes."""

    def __init__(self, settings: Settings):
        self._client = OpenAICompatClient(settings)

    async def generate(self, prompt: str, menu_context: str) -> MenuChangePlan:
        try:
            arguments = await self._client.chat(
                [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {
                        "role": "user",
                        "content": f"Текущее меню:\n{menu_context}\n\nЗапрос владельца:\n{prompt}",
                    },
                ],
                menu_plan_function(),
            )
        except AIInvalidResponse as error:
            raise OpenAICompatError("ИИ вернул некорректный план меню") from error
        return parse_menu_plan(arguments)
