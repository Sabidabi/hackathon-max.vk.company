"""Webhook updates of the bot: commands, callback buttons, free messages (P1-DOC-11).

``handle_update`` changes the database (dialog consent, subscriptions, conversations and
their outbox rows) and returns the immediate answers; the route commits and sends them.
"""

import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.bot import conversations as conv
from app.bot.events import disable_marketing, first_point
from app.bot.links import (
    SETTINGS_PAYLOAD,
    app_button,
    callback_button,
    manage_payload,
    menu_payload,
)
from app.config import Settings
from app.max_api.client import STARTAPP_PAYLOAD_PATTERN
from app.models import (
    BotDialog,
    BotMessageLink,
    Conversation,
    ItemSubscription,
    Restaurant,
    RestaurantFavorite,
    RestaurantVisit,
    User,
    Venue,
    VenueMember,
)

logger = logging.getLogger(__name__)

HELP_TEXT = (
    "Синица — меню кофеен и пекарен в MAX.\n\n"
    "/start — открыть Синицу\n"
    "/my — мои заведения и избранное\n"
    "/chat — написать в кофейню\n"
    "/settings — настройки уведомлений\n"
    "/support — написать в поддержку\n"
    "/stop — отписаться от рассылок\n"
    "/help — эта подсказка"
)
WELCOME_BODY = (
    "Я Синица 🐦\n\n"
    "Открой меню кофейни, выбери напиток с нужным молоком и добавками — "
    "готовый выбор покажешь на кассе.\n\n"
    "У тебя своя кофейня? Здесь же можно собрать меню и получить QR для гостей.\n\n"
    "Нажми «Открыть Синицу» — всё уже внутри."
)


def welcome_text(name: str = "") -> str:
    """The first message of the dialog: a friendly hello and a push to the mini app."""
    clean = " ".join(name.split())[:40]
    return f"Привет, {clean}! {WELCOME_BODY}" if clean else f"Привет! {WELCOME_BODY}"


WELCOME_TEXT = welcome_text()
MAX_LIST_BUTTONS = 8


@dataclass
class Incoming:
    kind: str  # started | stopped | message | callback | other
    max_user_id: int | None = None
    chat_id: int | None = None
    name: str = ""
    text: str | None = None
    payload: str | None = None
    callback_id: str | None = None
    message_id: str | None = None
    reply_to_id: str | None = None
    attachments: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class Reply:
    text: str
    buttons: list[list[dict[str, Any]]] = field(default_factory=list)
    chat_id: int | None = None
    user_id: int | None = None


@dataclass
class Outcome:
    replies: list[Reply] = field(default_factory=list)
    callback_id: str | None = None
    callback_notice: str | None = None


def _dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _int(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def parse_update(update: dict[str, Any]) -> Incoming:
    """MAX update → the fields the bot needs; anything unexpected is ignored."""
    update_type = update.get("update_type")
    message = _dict(update.get("message"))
    body = _dict(message.get("body"))
    sender = _dict(message.get("sender"))
    recipient = _dict(message.get("recipient"))
    user = _dict(update.get("user")) or sender
    chat_id = _int(update.get("chat_id")) or _int(recipient.get("chat_id"))
    name = str(user.get("first_name") or user.get("name") or "")[:100]
    if update_type == "bot_started":
        payload = update.get("payload")
        return Incoming(
            kind="started",
            max_user_id=_int(user.get("user_id")),
            chat_id=chat_id,
            name=name,
            payload=payload if isinstance(payload, str) else None,
        )
    if update_type == "bot_stopped":
        return Incoming(kind="stopped", max_user_id=_int(user.get("user_id")), chat_id=chat_id)
    if update_type == "message_callback":
        callback = _dict(update.get("callback"))
        callback_user = _dict(callback.get("user")) or user
        payload = callback.get("payload")
        return Incoming(
            kind="callback",
            max_user_id=_int(callback_user.get("user_id")),
            chat_id=chat_id,
            name=str(callback_user.get("first_name") or callback_user.get("name") or "")[:100],
            payload=payload if isinstance(payload, str) else None,
            callback_id=str(callback.get("callback_id") or "") or None,
        )
    if update_type == "message_created":
        text = body.get("text")
        link = _dict(message.get("link"))
        reply_to = None
        if link.get("type") == "reply":
            reply_to = _dict(link.get("message")).get("mid")
        return Incoming(
            kind="message",
            max_user_id=_int(sender.get("user_id")) or _int(user.get("user_id")),
            chat_id=chat_id,
            name=name,
            text=text.strip() if isinstance(text, str) else None,
            message_id=str(body["mid"]) if body.get("mid") else None,
            reply_to_id=str(reply_to) if reply_to else None,
            attachments=conv.clean_attachments(body.get("attachments")),
        )
    return Incoming(kind="other")


def split_command(text: str | None) -> tuple[str | None, str]:
    if not text or not text.startswith("/"):
        return None, ""
    head, _, rest = text.partition(" ")
    command = head[1:].split("@", 1)[0].lower()
    return command, rest.strip()


# --- consent («Разрешить сообщения») ---


async def touch_dialog(session: AsyncSession, incoming: Incoming, now: datetime) -> BotDialog:
    """Any message or button from the user means the dialog with the bot exists."""
    assert incoming.max_user_id is not None
    user_id = await session.scalar(select(User.id).where(User.max_user_id == incoming.max_user_id))
    values = {
        "max_user_id": incoming.max_user_id,
        "user_id": user_id,
        "chat_id": incoming.chat_id,
        "stopped_at": None,
        "updated_at": now,
    }
    update_values = {key: value for key, value in values.items() if key != "max_user_id"}
    if incoming.chat_id is None:
        update_values.pop("chat_id")
    await session.execute(
        insert(BotDialog)
        .values(**values, started_at=now)
        .on_conflict_do_update(index_elements=[BotDialog.max_user_id], set_=update_values)
    )
    dialog = await session.get(BotDialog, incoming.max_user_id, populate_existing=True)
    assert dialog is not None
    return dialog


def set_mode(dialog: BotDialog, mode: str, conversation_id: uuid.UUID | None = None) -> None:
    dialog.mode = mode
    dialog.mode_conversation_id = conversation_id


# --- commands ---


def open_app_reply(text: str, button: str = "Открыть Синицу", payload: str | None = None) -> Reply:
    return Reply(text, [[app_button(button, payload)]])


def help_reply() -> Reply:
    return Reply(
        HELP_TEXT,
        [[app_button("Открыть Синицу")], [callback_button("Написать в поддержку", "support")]],
    )


async def start_reply(
    session: AsyncSession, dialog: BotDialog, user: User | None, payload: str | None,
    now: datetime, name: str = "",
) -> Reply:
    if payload and STARTAPP_PAYLOAD_PATTERN.fullmatch(payload):
        if payload == "support":
            return await start_support(session, dialog, user)
        if payload.startswith("chat_"):
            return await start_point_chat(session, dialog, user, payload[5:], now)
        if payload == SETTINGS_PAYLOAD:
            return open_app_reply(
                "Сообщения от бота разрешены. Выберите, о чём сообщать.",
                "Настройки уведомлений", SETTINGS_PAYLOAD,
            )
        if payload.startswith("r_"):
            point = await session.scalar(
                select(Restaurant).where(Restaurant.public_id == payload[2:].split("_i_")[0])
            )
            if point is not None:
                return open_app_reply(
                    f"Открывайте меню «{point.name}».", "Открыть меню", payload
                )
        if payload.startswith(("inv_", "manage_")):
            return open_app_reply("Откройте Синицу, чтобы продолжить.", "Открыть", payload)
    return open_app_reply(welcome_text(name))


async def my_reply(session: AsyncSession, user: User | None) -> Reply:
    if user is None:
        return open_app_reply("Откройте Синицу один раз — и здесь появятся ваши заведения.")
    rows: list[list[dict[str, Any]]] = []
    venues = (await session.execute(
        select(Venue.id, Venue.name)
        .join(VenueMember, VenueMember.venue_id == Venue.id)
        .where(VenueMember.user_id == user.id)
        .order_by(VenueMember.created_at)
        .limit(MAX_LIST_BUTTONS)
    )).all()
    for venue_id, venue_name in venues:
        point = await first_point(session, venue_id)
        if point is not None:
            rows.append([app_button(f"Кабинет · {venue_name}", manage_payload(point.public_id))])
    favorites = (await session.execute(
        select(Restaurant.name, Restaurant.public_id)
        .join(RestaurantFavorite, RestaurantFavorite.restaurant_id == Restaurant.id)
        .where(RestaurantFavorite.user_id == user.id)
        .order_by(RestaurantFavorite.created_at.desc())
        .limit(MAX_LIST_BUTTONS)
    )).all()
    for name, public_id in favorites:
        rows.append([app_button(f"♡ {name}", menu_payload(public_id))])
    if not rows:
        return open_app_reply("Пока пусто: добавьте заведение в избранное или создайте своё.")
    parts = []
    if venues:
        parts.append(f"Ваши заведения: {len(venues)}")
    if favorites:
        parts.append(f"Избранное: {len(favorites)}")
    return Reply(". ".join(parts) + ".", rows)


async def chat_choice_reply(session: AsyncSession, user: User | None) -> Reply:
    if user is None:
        return open_app_reply("Откройте меню кофейни в Синице и нажмите «Написать в кофейню».")
    recent = (await session.execute(
        select(Restaurant.name, Restaurant.public_id)
        .join(RestaurantVisit, RestaurantVisit.restaurant_id == Restaurant.id)
        .where(RestaurantVisit.user_id == user.id)
        .order_by(RestaurantVisit.last_opened_at.desc())
        .limit(MAX_LIST_BUTTONS)
    )).all()
    favorites = (await session.execute(
        select(Restaurant.name, Restaurant.public_id)
        .join(RestaurantFavorite, RestaurantFavorite.restaurant_id == Restaurant.id)
        .where(RestaurantFavorite.user_id == user.id)
        .limit(MAX_LIST_BUTTONS)
    )).all()
    seen: set[str] = set()
    rows = []
    for name, public_id in [*favorites, *recent]:
        if public_id in seen or len(rows) >= MAX_LIST_BUTTONS:
            continue
        seen.add(public_id)
        rows.append([callback_button(name[:60], f"chat:{public_id}")])
    if not rows:
        return open_app_reply("Откройте меню кофейни в Синице и нажмите «Написать в кофейню».")
    return Reply("Кому написать?", rows)


async def start_point_chat(
    session: AsyncSession, dialog: BotDialog, user: User | None, public_id: str, now: datetime
) -> Reply:
    point = await session.scalar(select(Restaurant).where(Restaurant.public_id == public_id))
    if point is None:
        return help_reply()
    if user is None:
        return open_app_reply(
            "Откройте меню в Синице один раз, затем вернитесь сюда.", "Открыть меню",
            menu_payload(point.public_id),
        )
    try:
        dialog_row = await conv.open_point_dialog(session, user, point, now)
    except conv.ConversationError as error:
        return Reply(str(error))
    set_mode(dialog, "point_chat", dialog_row.id)
    return Reply(
        f"Напишите вопрос для «{point.name}» — ответ придёт сюда.",
        [[callback_button("Закрыть диалог", f"chat_close:{dialog_row.id}")]],
    )


async def start_support(session: AsyncSession, dialog: BotDialog, user: User | None) -> Reply:
    if user is None:
        return open_app_reply("Откройте Синицу один раз, затем напишите /support.")
    ticket, created = await conv.open_support_ticket(session, user)
    set_mode(dialog, "support", ticket.id)
    lead = (
        f"Обращение №{ticket.number}. Опишите вопрос одним или несколькими сообщениями, "
        "можно с фото."
        if created
        else f"Продолжаем обращение №{ticket.number}. Напишите, что добавить."
    )
    return Reply(lead, [[callback_button("Закрыть обращение", f"support_close:{ticket.id}")]])


# --- callbacks ---


async def handle_callback(
    session: AsyncSession, dialog: BotDialog, user: User | None, payload: str, now: datetime
) -> tuple[str, list[Reply]]:
    action, _, argument = payload.partition(":")
    if action == "support":
        return "Поддержка", [await start_support(session, dialog, user)]
    if user is None:
        return "Откройте Синицу", [help_reply()]
    if action == "support_close":
        ticket = await _own_conversation(session, argument, user, "support")
        if ticket is None:
            return "Обращение не найдено", []
        conv.close_conversation(ticket, now)
        set_mode(dialog, "idle")
        return "Закрыто", [Reply(f"Обращение №{ticket.number} закрыто. Спасибо!")]
    if action == "chat":
        return "Диалог", [await start_point_chat(session, dialog, user, argument, now)]
    if action == "chat_close":
        chat = await _own_conversation(session, argument, user, "point")
        if chat is None:
            return "Диалог не найден", []
        conv.close_conversation(chat, now)
        set_mode(dialog, "idle")
        return "Закрыто", [Reply("Диалог закрыт.")]
    if action == "unsub_r":
        point_id = _uuid(argument)
        favorite = point_id and await session.get(RestaurantFavorite, (point_id, user.id))
        if favorite:
            favorite.notifications_enabled = False
        return "Больше не пришлём", [Reply(
            "Уведомления о новинках этого заведения выключены.",
            [[app_button("Настройки уведомлений", SETTINGS_PAYLOAD)]],
        )]
    if action == "unsub_i":
        point_raw, _, key_raw = argument.partition(":")
        point_id, item_key = _uuid(point_raw), _uuid(key_raw)
        if point_id and item_key:
            await session.execute(delete(ItemSubscription).where(
                ItemSubscription.user_id == user.id,
                ItemSubscription.point_id == point_id,
                ItemSubscription.item_key == item_key,
            ))
        return "Больше не пришлём", [Reply("Больше не сообщим об этой позиции.")]
    if action == "reply":
        chat = await _admin_conversation(session, argument, user)
        if chat is None:
            return "Диалог недоступен", []
        set_mode(dialog, "admin_reply", chat.id)
        return "Напишите ответ", [Reply(
            f"Ответ гостю (диалог №{chat.number}): напишите следующее сообщение. "
            "Гость увидит название точки, не ваше имя."
        )]
    return "Неизвестная кнопка", []


def _uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except ValueError:
        return None


async def _own_conversation(
    session: AsyncSession, raw_id: str, user: User, kind: str
) -> Conversation | None:
    conversation_id = _uuid(raw_id)
    if conversation_id is None:
        return None
    return await session.scalar(select(Conversation).where(
        Conversation.id == conversation_id,
        Conversation.user_id == user.id,
        Conversation.kind == kind,
    ))


async def _admin_conversation(
    session: AsyncSession, raw_id: str | uuid.UUID, user: User
) -> Conversation | None:
    conversation_id = raw_id if isinstance(raw_id, uuid.UUID) else _uuid(raw_id)
    if conversation_id is None:
        return None
    return await session.scalar(
        select(Conversation)
        .join(VenueMember, VenueMember.venue_id == Conversation.venue_id)
        .where(
            Conversation.id == conversation_id,
            Conversation.kind == "point",
            VenueMember.user_id == user.id,
        )
    )


# --- free messages ---


async def handle_free_message(
    session: AsyncSession,
    settings: Settings,
    dialog: BotDialog,
    user: User | None,
    incoming: Incoming,
    now: datetime,
) -> list[Reply]:
    text = incoming.text or ""
    if not text and not incoming.attachments:
        return []
    if user is None:
        return [help_reply()]
    try:
        # A reply to the copy of a guest message answers that guest.
        if incoming.reply_to_id:
            linked = await session.scalar(select(BotMessageLink.conversation_id).where(
                BotMessageLink.max_message_id == incoming.reply_to_id
            ))
            chat = linked and await _admin_conversation(session, linked, user)
            if chat:
                await conv.answer_guest(
                    session, dialog=chat, admin=user, text=text,
                    attachments=incoming.attachments, now=now,
                )
                return [Reply("Ответ отправлен гостю.")]
        if dialog.mode == "admin_reply" and dialog.mode_conversation_id:
            chat = await _admin_conversation(session, dialog.mode_conversation_id, user)
            set_mode(dialog, "idle")
            if chat is None:
                return [Reply("Диалог недоступен.")]
            await conv.answer_guest(
                session, dialog=chat, admin=user, text=text,
                attachments=incoming.attachments, now=now,
            )
            return [Reply("Ответ отправлен гостю.")]
        if dialog.mode == "support" and dialog.mode_conversation_id:
            ticket = await session.get(Conversation, dialog.mode_conversation_id)
            if ticket is None or ticket.user_id != user.id or ticket.status == "closed":
                set_mode(dialog, "idle")
                return [Reply("Обращение закрыто. Нажмите /support, чтобы открыть новое.")]
            posted = await conv.post_support_message(
                session, settings, user=user, ticket=ticket, text=text,
                attachments=incoming.attachments, now=now,
            )
            if posted.first:
                return [Reply(
                    f"Мы получили обращение №{ticket.number}, ответим здесь.",
                    [[callback_button("Закрыть обращение", f"support_close:{ticket.id}")]],
                )]
            return []
        if dialog.mode == "point_chat" and dialog.mode_conversation_id:
            chat = await session.get(Conversation, dialog.mode_conversation_id)
            if chat is None or chat.user_id != user.id or chat.status == "closed":
                set_mode(dialog, "idle")
                return [Reply("Диалог закрыт. Откройте его снова из меню заведения.")]
            posted = await conv.post_guest_message(
                session, user=user, dialog=chat, text=text,
                attachments=incoming.attachments, now=now,
            )
            if posted.first:
                point = await session.get(Restaurant, chat.point_id)
                return [Reply(
                    f"Сообщение передано в «{point.name if point else 'кофейню'}». "
                    "Ответ придёт сюда.",
                    [[callback_button("Закрыть диалог", f"chat_close:{chat.id}")]],
                )]
            return []
    except conv.ConversationError as error:
        return [Reply(str(error))]
    return [help_reply()]


# --- support chat of the team ---


async def handle_support_chat(
    session: AsyncSession, incoming: Incoming, now: datetime
) -> None:
    """An operator's reply (to the forwarded copy) in the support chat → the requester."""
    if not incoming.reply_to_id or not (incoming.text or incoming.attachments):
        return
    ticket = await session.scalar(
        select(Conversation)
        .join(BotMessageLink, BotMessageLink.conversation_id == Conversation.id)
        .where(
            BotMessageLink.max_message_id == incoming.reply_to_id,
            Conversation.kind == "support",
        )
    )
    if ticket is None:
        return
    await conv.answer_support(
        session, ticket=ticket, text=incoming.text or "", attachments=incoming.attachments,
        now=now,
    )


# --- entry point ---


async def handle_update(
    session: AsyncSession,
    settings: Settings,
    update: dict[str, Any],
    now: datetime | None = None,
) -> Outcome:
    now = now or datetime.now(UTC)
    incoming = parse_update(update)
    outcome = Outcome(callback_id=incoming.callback_id)
    if incoming.kind == "other":
        return outcome
    if (
        incoming.kind == "message"
        and settings.support_chat_id is not None
        and incoming.chat_id == settings.support_chat_id
    ):
        await handle_support_chat(session, incoming, now)
        return outcome
    if incoming.max_user_id is None:
        return outcome
    if incoming.kind == "stopped":
        dialog = await session.get(BotDialog, incoming.max_user_id)
        if dialog is not None:
            dialog.stopped_at = now
        return outcome

    dialog = await touch_dialog(session, incoming, now)
    user = await session.get(User, dialog.user_id) if dialog.user_id else None
    target = (
        {"chat_id": incoming.chat_id} if incoming.chat_id else {"user_id": incoming.max_user_id}
    )

    replies: list[Reply] = []
    if incoming.kind == "started":
        replies = [
            await start_reply(session, dialog, user, incoming.payload, now, incoming.name)
        ]
    elif incoming.kind == "callback":
        notice, replies = await handle_callback(
            session, dialog, user, incoming.payload or "", now
        )
        outcome.callback_notice = notice
    else:
        command, argument = split_command(incoming.text)
        if command in {"start", "menu"}:
            replies = [
                await start_reply(session, dialog, user, argument or None, now, incoming.name)
            ]
        elif command == "my":
            replies = [await my_reply(session, user)]
        elif command == "settings":
            replies = [open_app_reply(
                "Настройки уведомлений — в Синице.", "Настройки уведомлений", SETTINGS_PAYLOAD
            )]
        elif command == "stop":
            if user is not None:
                await disable_marketing(session, user.id)
            replies = [open_app_reply(
                "Готово: рассылки и уведомления о новинках выключены. Вернуть — в настройках.",
                "Настройки уведомлений", SETTINGS_PAYLOAD,
            )]
        elif command == "support":
            replies = [await start_support(session, dialog, user)]
        elif command == "chat":
            replies = [await chat_choice_reply(session, user)]
        elif command is not None:
            replies = [help_reply()]
        else:
            replies = await handle_free_message(session, settings, dialog, user, incoming, now)

    for reply in replies:
        if reply.chat_id is None and reply.user_id is None:
            reply.chat_id = target.get("chat_id")
            reply.user_id = target.get("user_id")
    outcome.replies = replies
    return outcome
