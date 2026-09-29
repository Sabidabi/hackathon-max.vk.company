import hmac
from typing import Annotated, Any

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.bot.commands import handle_update, parse_update, split_command
from app.config import Settings, get_settings
from app.database import get_session
from app.max_api.client import answer_callback, send_bot_message, send_max_message

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

    raw = update.model_dump(mode="json")
    incoming = parse_update(raw)
    if (
        incoming.kind == "message"
        and split_command(incoming.text)[0] == "id"
        and incoming.chat_id is not None
        and incoming.max_user_id is not None
    ):
        # Service command kept from the MVP: the admin passes this ID when inviting.
        background_tasks.add_task(
            send_max_message,
            settings,
            text=f"Ваш MAX ID: {incoming.max_user_id}. Передайте его владельцу точки.",
            chat_id=incoming.chat_id,
        )
        return WebhookAccepted()

    outcome = await handle_update(session, settings, raw)
    await session.commit()
    for reply in outcome.replies:
        background_tasks.add_task(
            send_bot_message,
            settings,
            text=reply.text,
            buttons=reply.buttons,
            chat_id=reply.chat_id,
            user_id=None if reply.chat_id is not None else reply.user_id,
        )
    if outcome.callback_id:
        background_tasks.add_task(
            answer_callback, settings, outcome.callback_id, outcome.callback_notice or "Готово"
        )

    return WebhookAccepted()
