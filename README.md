# MAX Menu

Мини-приложение для кофеен и пекарен: владелец создаёт точку, собирает меню, оформляет публичную страницу и открывает её гостям по ссылке или QR-коду внутри MAX.

## Что уже работает

- автоматический вход через MAX `initData` и изолированный dev-вход для локальной разработки;
- создание точки и черновика меню;
- категории, товары, фото, стоп-лист, размеры и обязательные/необязательные группы добавок;
- импорт PDF/JPG/PNG с OCR и обязательной ручной проверкой;
- создание карточки товара через GigaChat: запрос → план → подтверждение → черновик;
- светлая/тёмная тема, четыре шаблона, цвета, фон и масштаб шрифта;
- публикация версии меню, публичная ссылка и PNG QR-код;
- избранное, согласие на уведомления и ограниченные рассылки через MAX;
- защищённый MCP-контур для чтения контекста и изменения черновика без публикации.

Текущий этап ещё не включает заказы и реальные платежи. Фактический статус и следующий порядок работ находятся в [docs/implementation-status.md](docs/implementation-status.md).

## Запуск

```bash
cp .env.example .env
docker compose up --build
```

Откройте `http://localhost:8080`. В development-режиме фронтенд входит автоматически. В MAX он передаёт `window.WebApp.initData` на сервер для проверки.

Полезные адреса:

- `http://localhost:8000/api/v1/health/live`
- `http://localhost:8000/api/v1/health/ready`
- `http://localhost:8000/docs`

Демо-точка создаётся идемпотентной командой:

```bash
docker compose exec backend python -m app.demo_seed
```

## MAX, GigaChat и MCP

Секреты задаются только в локальном `.env`; он исключён из Git. Переменные и безопасные пустые значения перечислены в `.env.example`.

Для регистрации MAX webhook после развёртывания на HTTPS:

```bash
docker compose exec backend python -m app.max_api.setup_webhook
```

MCP запускается отдельным профилем:

```bash
docker compose --profile mcp up --build
```

Устройство MCP, выдача локального токена и модель подтверждений описаны в [MCP_README.md](MCP_README.md).

## Проверки

```bash
cd backend
ruff check app tests migrations
pytest -q

cd ../frontend
npm run build
npm run test:browser
```

Browser smoke использует отдельный in-memory fixture server и не совершает реальные вызовы MAX, GigaChat или платежей.

## Документы команды

- [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) — краткий контекст продукта и границы этапа;
- [docs/01-product-brief.md](docs/01-product-brief.md) — проблема, аудитория и цель;
- [docs/02-mvp-specification.md](docs/02-mvp-specification.md) — требования и приёмка;
- [docs/03-ai-constitution.md](docs/03-ai-constitution.md) — правила для ИИ-разработчика;
- [docs/04-execution-backlog.md](docs/04-execution-backlog.md) — очередь реализации;
- [docs/product-design-guide.md](docs/product-design-guide.md) — правила продуктового дизайна.

## Сервисы

| Сервис | Назначение |
|---|---|
| `frontend` | React-приложение, собранное и отданное через Nginx |
| `backend` | FastAPI, авторизация, меню, публикация, MAX webhook и AI API |
| `worker` | OCR/import jobs и очередь MAX-уведомлений |
| `postgres` | данные приложения, сессии и очередь |
| `mcp` | опциональный Streamable HTTP MCP server |

Загруженные файлы и результаты OCR хранятся в Docker volume `menu_data`. `docker compose down` сохраняет данные; флаг `--volumes` удалит их.
