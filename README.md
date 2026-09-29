# Синица

«Синица» — мини-приложение MAX для кофеен и пекарен. Гость открывает меню заведения по QR, собирает «Мой выбор» и показывает его на кассе. Администратор ведёт точки, меню, стоп-лист, оформление и QR прямо в MAX. Онлайн-оплаты нет: заказ оформляется на кассе.

## Возможности

**Гость**
- Меню точки по QR или ссылке `/r/<id>` в теме заведения: разделы, поиск с опечатками, карточка позиции с размерами и добавками.
- «Мой выбор» → «Показать на кассе»; цену считает сервер.
- «Синица, что взять?» — ИИ-подборка до трёх доступных позиций. Без ИИ показывается подборка по ключевым словам.

**Администратор**
- Заведение с несколькими точками, библиотека меню, часы показа, стоп-лист точки.
- Черновик и публикация раздельно, «Что изменится», история версий; конфликт ревизии даёт 409 без потери правок.
- Оформление с контролем контраста, QR и тейбл-тент A6, приглашение администратора по ссылке.
- Импорт PDF и фото в черновик (OCR), «Синица проверила меню», ИИ-описание позиции, создание позиций текстом.

**Бот MAX**: вход в мини-приложение, уведомления и рассылки по согласию через очередь (идемпотентно), обращения в поддержку.

**ИИ**: подборка для гостя, описания, проверка меню, структурирование импорта, недельная сводка. Подробности: [docs/ai-and-mcp.md](docs/ai-and-mcp.md).

**Аналитика**: продуктовые события гостей и недельная сводка для администратора.

## Стек

- Backend: Python, FastAPI, SQLAlchemy, Alembic, PostgreSQL (`backend/`).
- Frontend: React 19, TypeScript, Vite, TanStack Query, `@maxhub/max-ui` (`frontend/`).
- Worker: OCR и фоновые задачи (`python -m app.worker`), Tesseract для изображений.
- MCP-сервер меню (опционально), Docker Compose.
- Бренд и токены дизайна: `brandbook-sinitsa/`.

## Запуск локально

Docker:

```bash
cp .env.example .env
docker compose up -d --build
docker compose exec backend python -m app.demo_seed   # демо-заведение «Кофейня Север»
```

Приложение: http://localhost:8080, API: http://localhost:8000. Сценарий демо: [docs/DEMO.md](docs/DEMO.md). В браузере вход для разработки — dev-вход (`APP_ENV=development`, `DEV_AUTH_ENABLED=true`).

Без Docker (нужна PostgreSQL, `DATABASE_URL` в `.env`):

```bash
# backend
cd backend
pip install -r requirements-dev.txt
alembic upgrade head
uvicorn app.main:app --reload --port 8000
python -m app.worker            # отдельным процессом

# frontend
cd frontend
npm ci
npm run dev
```

## Переменные окружения

Полный список со значениями по умолчанию — `.env.example`. Секреты задаются только в `.env` или окружении, не в коде и не в Git.

| Группа | Переменные |
| --- | --- |
| Приложение | `APP_ENV`, `LOG_LEVEL`, `PUBLIC_APP_URL`, `DEV_AUTH_ENABLED`, `DEV_MAX_USER_ID` |
| База | `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `DATABASE_URL` |
| Сессии | `SESSION_TTL_SECONDS`, `SESSION_COOKIE_NAME`, `MAX_INIT_DATA_MAX_AGE_SECONDS` |
| Бот MAX | `MAX_BOT_TOKEN`, `MAX_BOT_USERNAME`, `MAX_WEBHOOK_SECRET`, `MAX_WEBHOOK_URL`, `MAX_API_BASE_URL`, `SUPPORT_CHAT_ID` |
| Файлы и OCR | `DATA_ROOT`, `MAX_UPLOAD_BYTES`, `MAX_PDF_PAGES`, `OCR_*`, `WORKER_POLL_SECONDS` |
| ИИ | `AI_PROVIDER`, `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, лимиты `AI_*` |
| MCP | `MCP_ENABLED`, `MCP_RESOURCE_URL`, `MCP_ISSUER_URL`, `MCP_CONFIRMATION_TTL_SECONDS` |

## Продакшн-развёртывание

1. Публичный HTTPS-адрес для приложения; тот же адрес укажите в настройках бота на платформе MAX и в `PUBLIC_APP_URL`.
2. В `.env`: `APP_ENV=production`, `DEV_AUTH_ENABLED=false`, боевые `MAX_BOT_TOKEN` и `MAX_BOT_USERNAME`, свои значения `POSTGRES_PASSWORD` и `DATABASE_URL`.
3. Webhook MAX: HTTPS-адрес на порту 443 (`MAX_WEBHOOK_URL`, путь `/api/v1/webhooks/max`) и случайный `MAX_WEBHOOK_SECRET`.
4. Миграции: `alembic upgrade head` (в Compose выполняются при старте backend).
5. Запустите worker (сервис `worker` в Compose): OCR, уведомления, аналитика.
6. `docker compose up -d --build`, затем проверьте `/api/v1/health/ready` и `/api/v1/auth/bootstrap` (`max_auth_configured: true`, `development_auth: false`).
7. Не заменяйте рабочий `.env` примером из репозитория.

Порядок обновления и ручная проверка в MAX: [docs/max-production-check.md](docs/max-production-check.md).

## Проверки

```bash
# backend
cd backend && ruff check app tests migrations && pytest -q

# frontend
cd frontend && npm run build && npm run test:unit && npm run test:browser

# compose
docker compose config --quiet
```

Интеграционные тесты с БД запускайте только на отдельной тестовой PostgreSQL: `RUN_DB_INTEGRATION=1 pytest -q`. Не указывайте рабочую базу. Браузерные тесты используют фикстуры и не доказывают работу внутри MAX.

## Безопасность и инварианты

- Авторизация и изоляция заведений — на сервере. Роль вычисляет сервер; ссылка, `startapp` и `/manage` — только навигация.
- Деньги — целые копейки, цену считает сервер.
- Черновик и публикация раздельны; конфликт ревизии — 409 без потери правок.
- ИИ, OCR и MCP пишут только в проверяемый черновик и не публикуют.
- Недоверенный ввод (вопрос гостя, текст OCR) — данные, не инструкции.
- Секреты только в `.env`; в логах нет промптов и текстов гостей.
- Уведомления — через очередь, идемпотентно, по согласию.

## Ограничения

- Работу в реальном клиенте MAX (mobile и web) проверяйте по [docs/max-production-check.md](docs/max-production-check.md).
- OCR изображений требует установленного Tesseract (в Docker-образе есть).
- Без `AI_API_KEY` ИИ недоступен; режим `mock` помечается «Демо-ИИ».
- Онлайн-оплаты и заказы не реализованы.
