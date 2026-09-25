# Сверка интеграции с API MAX

Проверено 25.09.2026 по официальной документации и [OpenAPI-схеме MAX](https://github.com/max-messenger/api-schema/blob/main/schema.yaml). Это сверка кода и локальных контрактных тестов; доступ к настройкам production-бота и его серверу не предоставлен.

| Контракт MAX | Реализация | Итог |
| --- | --- | --- |
| [Bridge](https://dev.max.ru/docs/webapps/bridge): `window.WebApp.initData` и CDN-скрипт | `frontend/index.html`, `frontend/src/max/bridge.ts` | Соответствует. Читается также `WebAppData` из URL fragment при позднем/отсутствующем мосте. |
| [Подпись](https://dev.max.ru/docs/webapps/validation): HMAC-SHA256 от сортированных полей, `auth_date` в секундах, уникальные параметры | `backend/app/auth/max_init_data.py`, `frontend/src/max/bridge.ts` | Соответствует: подпись и срок проверяются на сервере, повторяющиеся поля отвергаются. `initDataUnsafe` используется только для выбора публичной витрины, не для входа. |
| [Диплинк](https://dev.max.ru/docs/webapps/introduction): `?startapp=<payload>`, до 512 символов из `[A-Za-z0-9_-]`, передача также через `WebAppStartParam` | `backend/app/max_api/client.py`, `frontend/src/max/bridge.ts`, `frontend/src/App.tsx` | Исправлено: сервер ограничивает payload, клиент читает все документированные варианты. Стартовый параметр не даёт прав. |
| [Bot API](https://dev.max.ru/docs-api): `platform-api2.max.ru`, сырой токен в `Authorization` | `backend/app/config.py`, `backend/app/max_api/client.py` | Соответствует. |
| [Клавиатура](https://dev.max.ru/docs-api/use-cases/sending-messages/keyboard): `link` открывает вкладку, `open_app` — mini app; [схема](https://github.com/max-messenger/api-schema/blob/main/schema.yaml) требует `web_app` и допускает `payload` | `backend/app/max_api/client.py` | Исправлено: сообщения бота со ссылкой на своё mini app отправляют кнопку `open_app`. Внешние URL остаются `link`. |
| [Webhook](https://dev.max.ru/docs-api/methods/POST/subscriptions): HTTPS, `bot_started`/`message_created`, секрет в `X-Max-Bot-Api-Secret`, возможен HTTP 200 при `success: false` | `backend/app/max_api/client.py`, `backend/app/api/routes/max_webhook.py` | Исправлено: регистрация проверяет поле `success`; входящий секрет сравнивается без утечки значения. |

Локально проверены фронтенд-сборка, browser smoke с фикстурой MAX, backend-тесты с изолированной PostgreSQL, Ruff и конфигурация Compose. Контрактный тест проверяет реальный JSON тела `POST /messages` и `POST /subscriptions` без отправки запросов в MAX. Продуктовый путь на мобильном клиенте MAX и настройки бота нужно проверить после обновления Docker по `docs/max-production-check.md`; без публичного HTTPS-адреса и доступа к серверу это нельзя подтвердить локальным тестом.
