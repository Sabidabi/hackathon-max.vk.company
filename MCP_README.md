# MCP-редактор меню

Обновлено: 21.09.2026.

**Текущий статус:** MCP-сервер реализован на официальном Python SDK `mcp==2.2.0`; четыре инструмента зарегистрированы и проверяются contract-тестом. Для реального запуска нужны PostgreSQL с миграциями `0005–0007`, выданный bearer token и профиль Compose `mcp`. На локальной машине этого этапа сервер не запускался с реальной БД, поэтому tenant/replay integration-тесты ещё обязательны перед production.

## Зачем здесь MCP

MCP даёт GigaChat-агенту или другому совместимому ИИ стандартные инструменты работы с меню. Пользователь пишет:

> Добавь капучино 250 и 350 мл по 190 и 240 рублей. Молоко обязательно: обычное бесплатно, овсяное +60 рублей. Сиропы необязательные, максимум два.

Агент не получает доступ к SQL и не генерирует код. Он вызывает ограниченные инструменты: читает краткий контекст меню, предлагает типизированный план, показывает его владельцу и применяет только после подтверждения.

## GigaChat API и MCP — разные уровни

```text
Кнопка «Создать с ИИ» в нашем интерфейсе
        │
        ▼
Backend ── GigaChat REST API ──► MenuChangePlan
        │                              │
        └──── подтверждение владельца ─┘
                       │
                       ▼
              Menu Command Service

Внешний GigaChat-агент / MCP-клиент
        │
        ▼
      MCP Server ─────────────────────► Menu Command Service
```

- **GigaChat REST API** превращает естественный язык в структурированный `MenuChangePlan` внутри продукта.
- **MCP Server** позволяет внешнему агенту вызвать те же операции по стандартному протоколу.
- **Menu Command Service** — единственное место, где применяются изменения, проверяются роли, организация, ревизия, цены и модификаторы.

REST и MCP не должны иметь собственные копии бизнес-логики.

## Реализованная структура файлов

```text
backend/
  app/
    menu_commands/
      schemas.py          # MenuChangePlan и команды
      service.py          # preview/apply и ревизии
      confirmation.py     # одноразовые confirmation token
    ai/
      gigachat.py         # OAuth, chat/completions, structured output
      prompts.py          # системные правила без секретов
    api/routes/
      menu_ai.py          # UI endpoints plan/apply
    mcp_server/
      server.py           # MCPServer и четыре инструмента
      security.py         # bearer verifier, scopes и token-bound identity
      service.py          # операции с ревизией, подтверждением и audit log
      issue_token.py      # локальная выдача ограниченного токена
```

## Инструменты MCP первой версии

### `get_menu_context`

Возвращает только данные, необходимые модели:

- название точки;
- категории и краткие карточки текущего черновика;
- текущую `revision`;
- валюту RUB и лимиты;
- поддерживаемые операции.

Не возвращает cookie, токены MAX/GigaChat, персональные данные гостей, платежи и полный журнал.

Пример результата:

```json
{
  "restaurant": "Кофейня Север",
  "revision": "2f4c...64-hex",
  "currency": "RUB",
  "sections": [
    {
      "id": "section-uuid",
      "name": "Кофе",
      "items": [{ "id": "item-uuid", "name": "Латте", "from_price_minor": 19000 }]
    }
  ]
}
```

### `propose_menu_change`

Принимает `MenuChangePlan` и `expected_revision`, но ничего не записывает. Сервер нормализует данные и возвращает diff, предупреждения и короткоживущий одноразовый `confirmation_token`.

Основные поля плана:

```json
{
  "expected_revision": "2f4c...64-hex",
  "operations": [
    {
      "type": "create_item",
      "section": { "match_name": "Кофе", "create_if_missing": true },
      "item": {
        "name": "Капучино",
        "base_price_minor": 19000,
        "variants": [
          { "name": "250 мл", "price_minor": 19000, "is_default": true },
          { "name": "350 мл", "price_minor": 24000 }
        ],
        "modifier_groups": [
          {
            "name": "Молоко",
            "min_quantity": 1,
            "max_quantity": 1,
            "options": [
              { "name": "Обычное", "price_minor": 0, "default_quantity": 1 },
              { "name": "Овсяное", "price_minor": 6000 }
            ]
          }
        ]
      }
    }
  ]
}
```

Если пользователь не указал цену, объём или смысл обязательности, инструмент возвращает предупреждение и не подставляет выдуманное значение.

### `apply_menu_change`

Принимает:

- `confirmation_token` из `propose_menu_change`;
- ту же `expected_revision`;
- идентификатор подтверждающего пользователя/сессии из доверенного MCP auth context.

Токен одноразовый и имеет TTL. Он связан с организацией, пользователем, хешем плана и ревизией. Повтор, подмена плана или изменение черновика дают ошибку. Результат сохраняется только в черновик.

### `get_change_result`

Возвращает выполненные операции, новые UUID карточек и новую ревизию. Инструмент нужен агенту, чтобы корректно продолжить диалог без повторного создания позиции.

## Что MCP первой версии делать не может

- публиковать меню или оформление;
- принимать платежи и делать возвраты;
- менять роли и доступ сотрудников;
- читать другую организацию по переданному UUID;
- загружать произвольные URL;
- выполнять SQL, shell или сгенерированный Python;
- тихо применять план без пользовательского подтверждения.

## Аутентификация и изоляция

`restaurant_id` из аргументов модели не является доказательством доступа. MCP auth layer сопоставляет токен со своим `organization_id`, разрешёнными точками и scopes:

- `menu:read` — контекст и результат;
- `menu:propose` — проверка плана;
- `menu:write` — применение подтверждённого плана.

Минимальный production-вариант использует короткоживущий сервисный токен из secret storage. Статический общий ключ для всех клиентов запрещён. Каждый tool call журналирует actor, organization, tool, request ID, хеш аргументов и результат без секретов и полного промпта.

## Переменные окружения

Параметры:

```dotenv
# GigaChat вызывается только backend-сервисом
GIGACHAT_AUTH_KEY=
GIGACHAT_SCOPE=GIGACHAT_API_B2B
GIGACHAT_MODEL=GigaChat
GIGACHAT_BASE_URL=https://api.giga.chat
GIGACHAT_OAUTH_URL=https://ngw.devices.sberbank.ru:9443/api/v2/oauth
GIGACHAT_TIMEOUT_SECONDS=30

# Отдельный MCP process / Streamable HTTP
MCP_ENABLED=false
MCP_RESOURCE_URL=http://127.0.0.1:8010/mcp
MCP_ISSUER_URL=http://127.0.0.1:8010
MCP_CONFIRMATION_TTL_SECONDS=600
```

Секреты не должны попадать в frontend, git, ответы MCP, логи и примеры фикстур.

## Локальный запуск

1. Примените миграции и узнайте UUID точки и пользователя.

2. Выдайте ограниченный токен; он показывается один раз, в БД хранится только SHA-256:

```powershell
cd backend
python -m app.mcp_server.issue_token --restaurant-id RESTAURANT_UUID --user-id USER_UUID --client-id gigachat-agent
```

3. Запустите отдельный Streamable HTTP процесс:

```powershell
uvicorn app.mcp_server.server:app --host 127.0.0.1 --port 8010
```

Или используйте Compose profile:

```powershell
docker compose --profile mcp up --build
```

Клиент подключается к `http://127.0.0.1:8010/mcp` и передаёт `Authorization: Bearer <token>`. В production endpoint должен работать по HTTPS, а локальную выдачу opaque token нужно заменить полноценным OAuth 2.1 authorization server или introspection провайдером. Stream `stdio` намеренно не включён: в официальном SDK HTTP bearer verifier на него не распространяется.

## Как подключается GigaChat-агент

Вариант A — наш backend сам вызывает GigaChat REST API и передаёт модели функцию `propose_menu_change`. Это основной путь для кнопки в редакторе.

Вариант B — отдельный GigaChat-агент подключается к MCP Server как клиент и получает его инструменты. Агент сначала вызывает `get_menu_context`, затем `propose_menu_change`, показывает diff пользователю и только после подтверждения вызывает `apply_menu_change`.

GigaChat поддерживает пользовательские функции и сценарии с MCP-агентом. Конкретный клиент может отличаться, но серверный контракт инструментов остаётся тем же.

## Обязательные тесты

- JSON schema одинаково трактуется Pydantic и TypeScript;
- пример с капучино создаёт два размера и обязательную группу молока;
- цена 190 ₽ становится `19000`, а 60 ₽ — `6000` копеек;
- отсутствующая цена не превращается в ноль;
- чужая организация получает отказ;
- просроченная ревизия даёт conflict;
- confirmation token нельзя применить дважды;
- изменение одного байта плана делает confirmation token недействительным;
- MCP disconnect после записи не приводит к повторному созданию карточки;
- публикация недоступна через набор инструментов первой версии;
- токены и промпты не появляются в логах.

Сейчас unit/contract тесты покрывают список инструментов, отсутствие инструмента публикации, строгую JSON Schema, scopes, token-bound identity и хеширование секретов. Проверки реальной миграции, HTTP 401, tenant isolation, expiry и конкурентного replay требуют тестовой PostgreSQL.

## Ссылки

- [GigaChat: агент с MCP-сервером](https://developers.sber.ru/docs/ru/gigachain/tutorials/agent-gigachat-mcp)
- [GigaChat: пользовательские функции](https://developers.sber.ru/docs/ru/gigachat/guides/functions/overview)
- [GigaChat: структурированный вывод](https://developers.sber.ru/docs/ru/gigachat/guides/structured-output)
- [Официальный MCP Python SDK](https://py.sdk.modelcontextprotocol.io/)
- [Общий план реализации](docs/04-execution-backlog.md)
