import json
import uuid
from typing import Any

import httpx
from pydantic import ValidationError

from app.config import Settings
from app.menu_commands.schemas import MenuChangePlan


class GigaChatError(RuntimeError):
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


def extract_menu_plan(payload: dict[str, Any]) -> MenuChangePlan:
    try:
        call = payload["choices"][0]["message"]["function_call"]
        if call["name"] != "propose_menu_change":
            raise KeyError("unexpected function")
        arguments = call["arguments"]
        if isinstance(arguments, str):
            arguments = json.loads(arguments)
        return MenuChangePlan.model_validate(arguments)
    except (KeyError, IndexError, TypeError, json.JSONDecodeError, ValidationError) as error:
        raise GigaChatError("GigaChat вернул некорректный план меню") from error


class GigaChatMenuPlanner:
    def __init__(self, settings: Settings):
        self.settings = settings

    async def _access_token(self, client: httpx.AsyncClient) -> str:
        authorization = self.settings.gigachat_auth_key.strip()
        if not authorization:
            raise GigaChatError("GigaChat не настроен")
        if not authorization.lower().startswith("basic "):
            authorization = f"Basic {authorization}"
        response = await client.post(
            self.settings.gigachat_oauth_url,
            headers={
                "Authorization": authorization,
                "RqUID": str(uuid.uuid4()),
                "Accept": "application/json",
            },
            data={"scope": self.settings.gigachat_scope},
        )
        if response.is_error:
            raise GigaChatError(f"GigaChat OAuth вернул {response.status_code}")
        token = response.json().get("access_token")
        if not isinstance(token, str) or not token:
            raise GigaChatError("GigaChat OAuth не вернул токен")
        return token

    async def generate(self, prompt: str, menu_context: str) -> MenuChangePlan:
        timeout = httpx.Timeout(self.settings.gigachat_timeout_seconds)
        async with httpx.AsyncClient(timeout=timeout) as client:
            token = await self._access_token(client)
            response = await client.post(
                f"{self.settings.gigachat_base_url.rstrip('/')}/v1/chat/completions",
                headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
                json={
                    "model": self.settings.gigachat_model,
                    "messages": [
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {
                            "role": "user",
                            "content": (
                                f"Текущее меню:\n{menu_context}\n\n"
                                f"Запрос владельца:\n{prompt}"
                            ),
                        },
                    ],
                    "functions": [menu_plan_function()],
                    "function_call": {"name": "propose_menu_change"},
                    "temperature": 0,
                },
            )
            if response.is_error:
                raise GigaChatError(f"GigaChat API вернул {response.status_code}")
            return extract_menu_plan(response.json())
