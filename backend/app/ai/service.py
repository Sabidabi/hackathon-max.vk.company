"""One gate for every AI call: availability, daily limits, cache, timeout, validation and
per-venue accounting.
"""

import asyncio
import hashlib
import json
import logging
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel
from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert

from app.ai.provider import (
    AIProvider,
    AITask,
    AIUnavailable,
    get_provider,
    parse_answer,
)
from app.config import Settings
from app.database import SessionFactory
from app.models import AiUsage

logger = logging.getLogger(__name__)

Feature = Literal["guest_ask", "item_description", "menu_check", "import_structure", "menu_plan",
           "weekly_summary", "import_descriptions"]
GUEST_FEATURES = ("guest_ask",)


class AILimitExceeded(Exception):
    """Daily limit reached: the API answers 429 with ``code`` and a human message."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message

    def detail(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


@dataclass(frozen=True)
class AIResult:
    value: BaseModel
    provider: str
    cached: bool


class TTLCache:
    """Small in-process LRU with expiry for identical requests."""

    def __init__(self, max_entries: int = 512):
        self.max_entries = max_entries
        self._items: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()

    def get(self, key: str) -> dict[str, Any] | None:
        entry = self._items.get(key)
        if entry is None:
            return None
        expires, value = entry
        if expires < time.monotonic():
            self._items.pop(key, None)
            return None
        self._items.move_to_end(key)
        return value

    def set(self, key: str, value: dict[str, Any], ttl: float) -> None:
        if ttl <= 0:
            return
        self._items[key] = (time.monotonic() + ttl, value)
        self._items.move_to_end(key)
        while len(self._items) > self.max_entries:
            self._items.popitem(last=False)

    def clear(self) -> None:
        self._items.clear()


CACHE = TTLCache()


def cache_key(provider: AIProvider, task: AITask) -> str:
    content = json.dumps(
        [provider.name, getattr(provider, "model", ""), task.name, task.instructions, task.data],
        ensure_ascii=False,
        sort_keys=True,
    )
    return hashlib.sha256(content.encode()).hexdigest()


def today() -> Any:
    return datetime.now(UTC).date()


def ai_status(settings: Settings) -> tuple[bool, str | None]:
    """(available, provider name) without calling the provider."""
    provider = get_provider(settings)
    return (provider is not None, provider.name if provider else None)


def anonymous_subject(address: str, agent: str) -> str:
    """``guest:<address hash>:<agent hash>`` — one browser for the per-guest limit; the
    address part alone is the per-address ceiling that a new user agent does not reset."""
    address_hash = hashlib.sha256(f"ip|{address}".encode()).hexdigest()[:24]
    agent_hash = hashlib.sha256(f"ua|{address}|{agent}".encode()).hexdigest()[:24]
    return f"guest:{address_hash}:{agent_hash}"


def anonymous_address_prefix(subject: str) -> str | None:
    """The per-address part of an anonymous subject (``guest:<address hash>:``)."""
    parts = subject.split(":")
    if len(parts) == 3 and parts[0] == "guest":
        return f"guest:{parts[1]}:"
    return None


async def _sum_calls(session: Any, *conditions: Any) -> int:
    return int(await session.scalar(
        select(func.coalesce(func.sum(AiUsage.calls), 0)).where(*conditions)
    ))


async def consume_quota(
    settings: Settings,
    *,
    venue_id: uuid.UUID,
    feature: Feature,
    subject: str,
) -> None:
    """Count one request or raise ``AILimitExceeded``; its own short transaction.

    Limits: per subject (guest or admin), per client address for anonymous guests (any
    user agent, across venues), the guests' share of the venue budget (the rest is kept
    for admins) and the venue budget itself. Transaction-level advisory locks serialise
    concurrent requests, so the 21st request of a guest is refused even in parallel."""
    is_guest = feature in GUEST_FEATURES
    user_limit = settings.ai_guest_daily_limit if is_guest else settings.ai_admin_daily_limit
    address_prefix = anonymous_address_prefix(subject) if is_guest else None
    day = today()
    async with SessionFactory() as session, session.begin():
        keys = [f"ai:{subject}", f"ai:venue:{venue_id}"]
        if address_prefix is not None:
            keys.insert(0, f"ai:{address_prefix}")
        for key in keys:
            await session.execute(
                text("SELECT pg_advisory_xact_lock(hashtext(:key))"), {"key": key}
            )
        feature_filter = (
            AiUsage.feature.in_(GUEST_FEATURES) if is_guest
            else AiUsage.feature.not_in(GUEST_FEATURES)
        )
        used_by_subject = await _sum_calls(
            session, AiUsage.subject == subject, AiUsage.day == day, feature_filter
        )
        if subject != "worker" and used_by_subject >= user_limit:
            raise AILimitExceeded(
                "ai_limit_user",
                "Лимит запросов к ИИ на сегодня исчерпан. Попробуйте завтра.",
            )
        if address_prefix is not None:
            used_by_address = await _sum_calls(
                session,
                AiUsage.subject.startswith(address_prefix, autoescape=True),
                AiUsage.day == day,
                feature_filter,
            )
            if used_by_address >= settings.ai_guest_ip_daily_limit:
                raise AILimitExceeded(
                    "ai_limit_user",
                    "Лимит запросов к ИИ на сегодня исчерпан. Попробуйте завтра.",
                )
        venue_filter = (AiUsage.venue_id == venue_id, AiUsage.day == day)
        if is_guest:
            guest_budget = settings.ai_venue_daily_limit * settings.ai_guest_venue_share_percent
            used_by_guests = await _sum_calls(session, *venue_filter, feature_filter)
            if used_by_guests * 100 >= guest_budget:
                raise AILimitExceeded(
                    "ai_limit_venue",
                    "Лимит ИИ заведения на сегодня исчерпан. Попробуйте завтра.",
                )
        used_by_venue = await _sum_calls(session, *venue_filter)
        if used_by_venue >= settings.ai_venue_daily_limit:
            raise AILimitExceeded(
                "ai_limit_venue",
                "Лимит ИИ заведения на сегодня исчерпан. Попробуйте завтра.",
            )
        await session.execute(
            insert(AiUsage)
            .values(day=day, venue_id=venue_id, feature=feature, subject=subject, calls=1)
            .on_conflict_do_update(
                index_elements=["day", "venue_id", "feature", "subject"],
                set_={"calls": AiUsage.calls + 1, "updated_at": func.now()},
            )
        )


async def record_provider_call(
    *, venue_id: uuid.UUID, feature: Feature, subject: str
) -> None:
    async with SessionFactory() as session, session.begin():
        await session.execute(
            insert(AiUsage)
            .values(
                day=today(), venue_id=venue_id, feature=feature, subject=subject,
                calls=0, provider_calls=1,
            )
            .on_conflict_do_update(
                index_elements=["day", "venue_id", "feature", "subject"],
                set_={"provider_calls": AiUsage.provider_calls + 1, "updated_at": func.now()},
            )
        )


async def run_task(
    settings: Settings,
    task: AITask,
    *,
    venue_id: uuid.UUID,
    subject: str,
    provider: AIProvider | None = None,
    timeout_seconds: float | None = None,
) -> AIResult:
    """Limits → cache → provider with timeout → strict schema. Raises ``AIUnavailable``
    (no key, error, timeout, invalid answer) or ``AILimitExceeded``."""
    provider = provider or get_provider(settings)
    if provider is None:
        raise AIUnavailable("ИИ сейчас недоступен")
    feature: Feature = task.name
    await consume_quota(settings, venue_id=venue_id, feature=feature, subject=subject)

    if timeout_seconds:
        task = replace(task, timeout_seconds=timeout_seconds)
    key = cache_key(provider, task)
    cached = CACHE.get(key)
    if cached is not None:
        return AIResult(parse_answer(task, cached), provider.name, cached=True)

    started = time.monotonic()
    try:
        async with asyncio.timeout(timeout_seconds or settings.ai_request_timeout_seconds):
            raw = await provider.complete(task)
    except TimeoutError as error:
        raise AIUnavailable("ИИ не ответил вовремя") from error
    except AIUnavailable:
        raise
    except Exception as error:  # provider bugs and network errors are «unavailable»
        raise AIUnavailable("ИИ сейчас недоступен") from error
    finally:
        await record_provider_call(venue_id=venue_id, feature=feature, subject=subject)
    answer = parse_answer(task, raw)
    # Log the task and timing only: no prompt, no guest text, no secrets.
    logger.info(
        "AI task %s via %s in %.0f ms", task.name, provider.name,
        (time.monotonic() - started) * 1000,
    )
    CACHE.set(key, answer.model_dump(mode="json"), settings.ai_cache_ttl_seconds)
    return AIResult(answer, provider.name, cached=False)
