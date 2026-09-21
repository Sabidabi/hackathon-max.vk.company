import hmac
from typing import Annotated, Any

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.database import get_session
from app.max_api.client import build_max_deep_link, send_max_message
from app.models import Menu, Restaurant

router = APIRouter(prefix="/webhooks/max", tags=["MAX webhook"])


class MaxWebhookUpdate(BaseModel):
    model_config = ConfigDict(extra="allow")

    update_type: str = Field(min_length=1, max_length=100)
    timestamp: int | None = None
    chat_id: int | None = None
    user: dict[str, Any] | None = None
    payload: str | None = Field(default=None, max_length=512)
    message: dict[str, Any] | None = None


class WebhookAccepted(BaseModel):
    ok: bool = True


def extract_message_text(update: MaxWebhookUpdate) -> str | None:
    if not update.message:
        return None
    body = update.message.get("body")
    if not isinstance(body, dict):
        return None
    text = body.get("text")
    return text.strip() if isinstance(text, str) else None


async def resolve_restaurant(
    session: AsyncSession,
    payload: str | None,
) -> Restaurant | None:
    if not payload or not payload.startswith("r_"):
        return None
    public_id = payload[2:]
    if not public_id:
        return None
    return await session.scalar(
        select(Restaurant)
        .join(Menu, Menu.restaurant_id == Restaurant.id)
        .where(
            Restaurant.public_id == public_id,
            Menu.current_published_version_id.is_not(None),
        )
    )


@router.post("", response_model=WebhookAccepted)
async def receive_max_webhook(
    update: MaxWebhookUpdate,
    background_tasks: BackgroundTasks,
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    webhook_secret: Annotated[
        str | None,
        Header(alias="X-Max-Bot-Api-Secret"),
    ] = None,
) -> WebhookAccepted:
    if not settings.max_webhook_secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="MAX webhook is not configured",
        )
    if webhook_secret is None or not hmac.compare_digest(
        webhook_secret,
        settings.max_webhook_secret,
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid webhook secret",
        )

    message_text = extract_message_text(update)
    should_greet = update.update_type == "bot_started" or (
        update.update_type == "message_created"
        and message_text is not None
        and message_text.lower().split(maxsplit=1)[0] in {"/start", "/menu"}
    )
    if should_greet and update.chat_id is not None:
        restaurant = await resolve_restaurant(session, update.payload)
        payload = f"r_{restaurant.public_id}" if restaurant is not None else None
        deep_link = build_max_deep_link(settings.max_bot_username, payload)
        text = (
            f"Открывайте актуальное меню ресторана «{restaurant.name}»."
            if restaurant is not None
            else "Открывайте меню ресторана в мини-приложении MAX."
        )
        background_tasks.add_task(
            send_max_message,
            settings,
            text=text,
            chat_id=update.chat_id,
            button_text="Открыть меню" if deep_link else None,
            button_url=deep_link,
        )

    return WebhookAccepted()
