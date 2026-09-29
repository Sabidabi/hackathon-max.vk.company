"""Weekly AI summary «Синица подводит неделю» (P1-TASK-44) against the API and PostgreSQL."""

import os
import uuid
from contextlib import AsyncExitStack
from typing import Any

import httpx
import pytest
from venue_api import (
    API,
    BASIC_MENU,
    _actors,
    _cleanup,
    _items,
    _new_venue,
    _ok,
    _public,
    _publish,
    _save_draft,
)

from app.ai import service as ai_service
from app.ai.provider import AIInvalidResponse
from app.ai.tasks import WeeklySummaryAnswer, check_summary
from app.analytics.ingest import rate_limiter
from app.config import Settings, get_settings
from app.main import app

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_DB_INTEGRATION") != "1",
    reason="requires the migrated PostgreSQL integration database",
)


class FakeProvider:
    name = "openai"
    model = "fake"

    def __init__(self, answer: Any):
        self.answer = answer
        self.calls = 0

    async def complete(self, task) -> Any:
        self.calls += 1
        return self.answer


@pytest.fixture
def use_provider(monkeypatch):
    def install(provider: FakeProvider | None, **values: Any) -> None:
        settings = Settings(**{**get_settings().model_dump(), **values})
        app.dependency_overrides[get_settings] = lambda: settings
        monkeypatch.setattr(ai_service, "get_provider", lambda _settings: provider)

    ai_service.CACHE.clear()
    monkeypatch.setattr(rate_limiter, "allow", lambda *a, **k: True)
    yield install
    app.dependency_overrides.pop(get_settings, None)
    ai_service.CACHE.clear()


def _event(name: str, **extra) -> dict:
    return {"client_event_id": str(uuid.uuid4()), "name": name, **extra}


async def _seed(stack: AsyncExitStack, admin, guests: int) -> dict:
    point, menu_id = await _new_venue(admin, f"Сводка {uuid.uuid4().hex[:6]}")
    await _save_draft(admin, menu_id, BASIC_MENU)
    await _publish(admin, menu_id, [point["id"]])
    latte = _items(await _public(admin, point["public_id"]))["Латте"]
    anonymous = await stack.enter_async_context(httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test",
    ))
    for n in range(guests):
        props = {"item_key": latte["item_key"], "item_name": "Латте"}
        events = [
            _event("menu_view", props={"menu_id": menu_id}),
            _event("item_view", props=props),
        ]
        if n % 2 == 0:
            events.append(_event("item_add", props=props))
        _ok(await anonymous.post(f"{API}/events", json={
            "point": point["public_id"], "session_id": str(uuid.uuid4()),
            "platform": "web", "events": events,
        }))
    return point


ANSWER = {"text": "За неделю у вас 25 гостей, Латте выбирали чаще всего.", "tips": []}


@pytest.mark.asyncio
async def test_summary_numbers_match_analytics_and_cache_header(use_provider) -> None:
    fake = FakeProvider(ANSWER)
    use_provider(fake, ai_api_key="k")
    user_ids: list[uuid.UUID] = []
    try:
        async with AsyncExitStack() as stack:
            actors = await _actors(stack, ("admin",))
            user_ids = actors.user_ids
            [admin] = actors.clients
            point = await _seed(stack, admin, 25)
            venue = point["venue_id"]
            report = _ok(await admin.get(f"{API}/venues/{venue}/analytics?period=7d"))
            response = await admin.get(f"{API}/venues/{venue}/analytics/ai-summary")
            body = _ok(response)
            assert response.headers["cache-control"] == "private, max-age=3600"
            assert body["state"] == "ok" and body["text"] == ANSWER["text"]
            assert body["period"] == "7d" and body["provider"] == "openai"
            assert body["metrics"]["guests"] == 25 == (
                report["guests"]["max_users"] + report["guests"]["web_sessions"]
            )
            assert body["metrics"]["choices"] == report["choices"]
            assert body["metrics"]["choice_rate_percent"] == report["choice_rate"]
            assert body["metrics"]["top_chosen"][0]["adds"] == report["top_chosen"][0]["adds"]
            _ok(await admin.get(f"{API}/venues/{venue}/analytics/ai-summary"))
            assert fake.calls == 1  # identical metrics come from the cache
    finally:
        await _cleanup(user_ids)


@pytest.mark.asyncio
async def test_few_data_does_not_call_ai(use_provider) -> None:
    fake = FakeProvider(ANSWER)
    use_provider(fake, ai_api_key="k")
    user_ids: list[uuid.UUID] = []
    try:
        async with AsyncExitStack() as stack:
            actors = await _actors(stack, ("admin",))
            user_ids = actors.user_ids
            [admin] = actors.clients
            point = await _seed(stack, admin, 3)
            body = _ok(await admin.get(f"{API}/venues/{point['venue_id']}/analytics/ai-summary"))
            assert body["state"] == "few_data" and body["text"] is None
            assert body["metrics"]["guests"] == 3
            assert fake.calls == 0
    finally:
        await _cleanup(user_ids)


@pytest.mark.asyncio
async def test_no_key_is_unavailable_with_metrics(use_provider) -> None:
    use_provider(None, ai_api_key="", ai_provider="auto")
    user_ids: list[uuid.UUID] = []
    try:
        async with AsyncExitStack() as stack:
            actors = await _actors(stack, ("admin",))
            user_ids = actors.user_ids
            [admin] = actors.clients
            point = await _seed(stack, admin, 22)
            body = _ok(await admin.get(f"{API}/venues/{point['venue_id']}/analytics/ai-summary"))
            assert body["state"] == "ai_unavailable" and body["text"] is None
            assert body["metrics"]["guests"] == 22
    finally:
        await _cleanup(user_ids)


@pytest.mark.asyncio
async def test_invented_number_drops_the_text_but_keeps_metrics(use_provider) -> None:
    fake = FakeProvider({"text": "Вы выросли на 47% за неделю, отличный результат!", "tips": []})
    use_provider(fake, ai_api_key="k")
    user_ids: list[uuid.UUID] = []
    try:
        async with AsyncExitStack() as stack:
            actors = await _actors(stack, ("admin",))
            user_ids = actors.user_ids
            [admin] = actors.clients
            point = await _seed(stack, admin, 25)
            body = _ok(await admin.get(f"{API}/venues/{point['venue_id']}/analytics/ai-summary"))
            assert fake.calls == 1
            assert body["state"] == "ai_unavailable" and body["text"] is None
            assert body["tips"] == [] and body["metrics"]["guests"] == 25
    finally:
        await _cleanup(user_ids)


@pytest.mark.asyncio
async def test_foreign_venue_is_404(use_provider) -> None:
    use_provider(FakeProvider(ANSWER), ai_api_key="k")
    user_ids: list[uuid.UUID] = []
    try:
        async with AsyncExitStack() as stack:
            actors = await _actors(stack, ("admin", "stranger"))
            user_ids = actors.user_ids
            admin, stranger = actors.clients
            point, _ = await _new_venue(admin, f"Чужая {uuid.uuid4().hex[:6]}")
            url = f"{API}/venues/{point['venue_id']}/analytics/ai-summary"
            assert (await stranger.get(url)).status_code == 404
    finally:
        await _cleanup(user_ids)


def test_check_summary_number_forms() -> None:
    metrics = {"guests": 1250, "choice_rate_percent": 12.5, "top": [{"name": "Раф 3"}]}
    good = WeeklySummaryAnswer(text="Гостей 1 250, доля 12,5% (12.50).", tips=["Раф 3 в топе"])
    assert check_summary(good, metrics) is good
    bad = WeeklySummaryAnswer(text="Гостей 1250, доля 13%.", tips=[])
    with pytest.raises(AIInvalidResponse):
        check_summary(bad, metrics)
