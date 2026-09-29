"""Units of analytics ingestion: rate limit, props rules, phrase normalisation, clock."""

from datetime import UTC, datetime, timedelta

import pytest

from app.analytics.ingest import RateLimiter, clamp_occurred_at
from app.analytics.vocabulary import normalize_query, validate_props


def test_rate_limiter_window() -> None:
    limiter = RateLimiter(limit=2, window=60)
    assert limiter.allow("s", 0) and limiter.allow("s", 1)
    assert not limiter.allow("s", 2)
    assert limiter.allow("other", 2)
    assert limiter.allow("s", 62)


def test_props_rules() -> None:
    assert validate_props({"item_key": "x", "results": 0, "available": False})
    for bad in ({"phone": "1"}, {"query": "раф"}, {"unknown": 1}, {"items": [1]},
                {"item_name": "x" * 121}):
        with pytest.raises(ValueError):
            validate_props(bad)


def test_normalize_query() -> None:
    assert normalize_query("  Овсяный\t РАФ ") == "овсяный раф"
    assert len(normalize_query("а" * 300)) == 100


def test_clamp_occurred_at() -> None:
    now = datetime(2026, 9, 29, 12, tzinfo=UTC)
    recent = now - timedelta(minutes=3)
    assert clamp_occurred_at(recent, now) == recent
    assert clamp_occurred_at(now - timedelta(days=2), now) == now
    assert clamp_occurred_at(now + timedelta(hours=1), now) == now
    assert clamp_occurred_at(None, now) == now
