import hashlib
import hmac
import json
from datetime import UTC, datetime
from urllib.parse import urlencode

import pytest

from app.auth.max_init_data import MaxInitDataError, validate_max_init_data

BOT_TOKEN = "test-bot-token"
NOW = datetime(2026, 9, 18, 12, 0, tzinfo=UTC)


def make_init_data(**overrides: str) -> str:
    values = {
        "auth_date": str(int(NOW.timestamp())),
        "query_id": "query-1",
        "start_param": "r_demo",
        "user": json.dumps(
            {
                "id": 12345,
                "first_name": "Max",
                "last_name": "User",
                "username": "max_user",
                "language_code": "ru",
            },
            separators=(",", ":"),
            ensure_ascii=False,
        ),
    }
    values.update(overrides)
    launch_params = "\n".join(f"{key}={values[key]}" for key in sorted(values))
    secret = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
    values["hash"] = hmac.new(secret, launch_params.encode(), hashlib.sha256).hexdigest()
    return urlencode(values)


def test_valid_init_data() -> None:
    result = validate_max_init_data(make_init_data(), BOT_TOKEN, 900, now=NOW)

    assert result.user.id == 12345
    assert result.user.display_name == "Max User"
    assert result.start_param == "r_demo"


def test_modified_init_data_is_rejected() -> None:
    init_data = make_init_data().replace("r_demo", "r_other")

    with pytest.raises(MaxInitDataError, match="signature"):
        validate_max_init_data(init_data, BOT_TOKEN, 900, now=NOW)


def test_expired_init_data_is_rejected() -> None:
    old_timestamp = str(int(NOW.timestamp()) - 901)

    with pytest.raises(MaxInitDataError, match="expired"):
        validate_max_init_data(
            make_init_data(auth_date=old_timestamp),
            BOT_TOKEN,
            900,
            now=NOW,
        )


def test_duplicate_hash_is_rejected() -> None:
    init_data = make_init_data()

    with pytest.raises(MaxInitDataError, match="duplicate"):
        validate_max_init_data(f"{init_data}&hash=duplicate", BOT_TOKEN, 900, now=NOW)
