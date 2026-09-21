import hashlib
import hmac
import json
from collections import Counter
from datetime import UTC, datetime
from urllib.parse import parse_qsl

from pydantic import BaseModel, ConfigDict, Field, ValidationError


class MaxInitDataError(ValueError):
    """Raised when MAX init data cannot be trusted or parsed."""


class MaxUserData(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str | None = Field(default=None, max_length=100)
    username: str | None = Field(default=None, max_length=100)
    language_code: str | None = Field(default=None, max_length=16)
    photo_url: str | None = Field(default=None, max_length=2048)

    @property
    def display_name(self) -> str:
        full_name = " ".join(part for part in (self.first_name, self.last_name) if part)
        return full_name or self.username or str(self.id)


class ValidatedMaxInitData(BaseModel):
    user: MaxUserData
    auth_date: datetime
    query_id: str | None = None
    start_param: str | None = None


def _parse_unique_pairs(init_data: str) -> list[tuple[str, str]]:
    if not init_data or len(init_data) > 16_384:
        raise MaxInitDataError("MAX init data is empty or too large")

    try:
        pairs = parse_qsl(init_data, keep_blank_values=True, strict_parsing=True)
    except ValueError as error:
        raise MaxInitDataError("MAX init data is malformed") from error

    counts = Counter(key for key, _ in pairs)
    if any(count != 1 for count in counts.values()) or counts.get("hash") != 1:
        raise MaxInitDataError("MAX init data contains duplicate or missing parameters")

    return pairs


def validate_max_init_data(
    init_data: str,
    bot_token: str,
    max_age_seconds: int,
    now: datetime | None = None,
) -> ValidatedMaxInitData:
    if not bot_token:
        raise MaxInitDataError("MAX bot token is not configured")

    pairs = _parse_unique_pairs(init_data)
    values = dict(pairs)
    original_hash = values.pop("hash")
    launch_params = "\n".join(f"{key}={values[key]}" for key in sorted(values))

    secret_key = hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()
    calculated_hash = hmac.new(
        secret_key,
        launch_params.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    if not hmac.compare_digest(calculated_hash, original_hash):
        raise MaxInitDataError("MAX init data signature is invalid")

    try:
        auth_timestamp = int(values["auth_date"])
        auth_date = datetime.fromtimestamp(auth_timestamp, tz=UTC)
        user = MaxUserData.model_validate(json.loads(values["user"]))
    except (KeyError, TypeError, ValueError, json.JSONDecodeError, ValidationError) as error:
        raise MaxInitDataError("MAX init data payload is invalid") from error

    current_time = now or datetime.now(UTC)
    age_seconds = (current_time - auth_date).total_seconds()
    if age_seconds < -60 or age_seconds > max_age_seconds:
        raise MaxInitDataError("MAX init data has expired")

    return ValidatedMaxInitData(
        user=user,
        auth_date=auth_date,
        query_id=values.get("query_id"),
        start_param=values.get("start_param"),
    )
