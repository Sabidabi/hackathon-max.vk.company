import uuid
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import ValidationError

from app.api.routes.notifications import (
    CampaignCreate,
    _quiet_hours_end,
    enqueue_menu_published_notification,
)
from app.models import NotificationCampaign, NotificationDelivery


@pytest.mark.parametrize(
    ("hour", "expected_hour", "expected_day"),
    [(5, 6, 21), (6, None, None), (18, 6, 22), (20, 6, 22)],
)
def test_moscow_quiet_hours(hour, expected_hour, expected_day):
    now = datetime(2026, 9, 21, hour, tzinfo=UTC)

    result = _quiet_hours_end(now)

    if expected_hour is None:
        assert result is None
    else:
        assert result is not None
        assert result.hour == expected_hour
        assert result.day == expected_day


async def test_publication_notification_uses_version_as_deduplication_key():
    session = AsyncMock()
    session.add = MagicMock()
    session.scalar.return_value = None
    restaurant = SimpleNamespace(
        id=uuid.uuid4(),
        owner_id=uuid.uuid4(),
        name="Север",
    )
    version_id = uuid.uuid4()

    await enqueue_menu_published_notification(
        session,
        restaurant=restaurant,
        menu_version_id=version_id,
        actor_id=uuid.uuid4(),
        item_count=12,
    )

    added = [call.args[0] for call in session.add.call_args_list]
    campaign = next(item for item in added if isinstance(item, NotificationCampaign))
    delivery = next(item for item in added if isinstance(item, NotificationDelivery))
    assert campaign.event_key == f"menu-published:{version_id}"
    assert campaign.recipient_count == 1
    assert delivery.user_id == restaurant.owner_id
    session.flush.assert_awaited_once()


async def test_publication_notification_is_not_enqueued_twice():
    session = AsyncMock()
    session.add = MagicMock()
    session.scalar.return_value = uuid.uuid4()

    await enqueue_menu_published_notification(
        session,
        restaurant=SimpleNamespace(id=uuid.uuid4(), owner_id=uuid.uuid4(), name="Север"),
        menu_version_id=uuid.uuid4(),
        actor_id=uuid.uuid4(),
        item_count=3,
    )

    session.add.assert_not_called()


def test_campaign_rejects_blank_or_too_long_messages():
    with pytest.raises(ValidationError):
        CampaignCreate(title=" ", body="Новость", idempotency_key=uuid.uuid4())
    with pytest.raises(ValidationError):
        CampaignCreate(title="Новость", body="x" * 501, idempotency_key=uuid.uuid4())
