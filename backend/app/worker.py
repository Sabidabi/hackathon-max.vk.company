import asyncio
import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select, text

from app.analytics.rollup import purge_raw_events, rollup_days
from app.bot.checks import run_scheduled_checks
from app.bot.delivery import deliver_due, recover_interrupted
from app.bot.events import on_import_finished
from app.config import get_settings
from app.database import SessionFactory, engine
from app.imports.llm import structure_with_ai
from app.imports.ocr import OcrResult, ocr_source
from app.imports.processor import (
    extract_pdf_text,
    resolve_data_path,
    save_extracted_text,
    structure_menu_text,
)
from app.logging import configure_logging
from app.max_api.client import build_max_deep_link, send_max_message
from app.models import (
    ImportJob,
    NotificationCampaign,
    NotificationDelivery,
    Restaurant,
    RestaurantFavorite,
    User,
)

logger = logging.getLogger(__name__)


async def verify_dependencies() -> None:
    settings = get_settings()
    settings.ensure_data_directories()
    async with SessionFactory() as session:
        await session.execute(text("SELECT 1"))


async def claim_next_job() -> uuid.UUID | None:
    async with SessionFactory() as session:
        async with session.begin():
            job = await session.scalar(
                select(ImportJob)
                .where(ImportJob.status == "queued")
                .order_by(ImportJob.created_at)
                .with_for_update(skip_locked=True)
                .limit(1)
            )
            if job is None:
                return None
            job.status = "extracting"
            job.progress = 10
            job.started_at = datetime.now(UTC)
            job.error_code = None
            job.error_message = None
            return job.id


async def update_job(job_id: uuid.UUID, **values: object) -> None:
    async with SessionFactory() as session:
        job = await session.get(ImportJob, job_id)
        if job is None:
            return
        for field_name, value in values.items():
            setattr(job, field_name, value)
        await session.commit()


async def claim_next_notification() -> uuid.UUID | None:
    async with SessionFactory() as session:
        async with session.begin():
            delivery = await session.scalar(
                select(NotificationDelivery)
                .join(
                    NotificationCampaign,
                    NotificationCampaign.id == NotificationDelivery.campaign_id,
                )
                .where(
                    NotificationDelivery.status == "pending",
                    NotificationCampaign.status.in_(("queued", "sending")),
                )
                .order_by(NotificationDelivery.created_at)
                .with_for_update(skip_locked=True)
                .limit(1)
            )
            if delivery is None:
                return None
            campaign = await session.get(NotificationCampaign, delivery.campaign_id)
            if campaign is None:
                return None
            now = datetime.now(UTC)
            delivery.status = "processing"
            delivery.attempt_count += 1
            campaign.status = "sending"
            campaign.started_at = campaign.started_at or now
            return delivery.id


async def _finish_notification(
    delivery_id: uuid.UUID,
    status: str,
    error_code: str | None = None,
) -> None:
    async with SessionFactory() as session:
        delivery = await session.get(NotificationDelivery, delivery_id)
        if delivery is None:
            return
        delivery.status = status
        delivery.error_code = error_code
        if status == "sent":
            delivery.sent_at = datetime.now(UTC)
        await session.flush()
        campaign = await session.get(NotificationCampaign, delivery.campaign_id)
        if campaign is None:
            await session.commit()
            return
        counts = dict(
            (
                await session.execute(
                    select(NotificationDelivery.status, func.count(NotificationDelivery.id))
                    .where(NotificationDelivery.campaign_id == campaign.id)
                    .group_by(NotificationDelivery.status)
                )
            ).all()
        )
        campaign.sent_count = counts.get("sent", 0)
        campaign.failed_count = counts.get("failed", 0)
        if not counts.get("pending", 0) and not counts.get("processing", 0):
            campaign.status = "completed"
            campaign.completed_at = datetime.now(UTC)
        await session.commit()


async def process_notification(delivery_id: uuid.UUID) -> None:
    settings = get_settings()
    async with SessionFactory() as session:
        row = (
            await session.execute(
                select(NotificationDelivery, NotificationCampaign, User, Restaurant)
                .join(
                    NotificationCampaign,
                    NotificationCampaign.id == NotificationDelivery.campaign_id,
                )
                .join(User, User.id == NotificationDelivery.user_id)
                .join(Restaurant, Restaurant.id == NotificationCampaign.restaurant_id)
                .where(NotificationDelivery.id == delivery_id)
            )
        ).one_or_none()
        if row is None:
            return
        delivery, campaign, recipient, restaurant = row
        if campaign.kind == "marketing":
            favorite = await session.get(
                RestaurantFavorite,
                (campaign.restaurant_id, delivery.user_id),
            )
            if favorite is None or not favorite.notifications_enabled:
                await _finish_notification(delivery_id, "skipped", "unsubscribed")
                return

    deep_link = build_max_deep_link(settings.max_bot_username, f"r_{restaurant.public_id}")
    footer = (
        "\n\nРассылку можно отключить в меню точки."
        if campaign.kind == "marketing"
        else ""
    )
    sent = await send_max_message(
        settings,
        user_id=recipient.max_user_id,
        text=f"{campaign.title}\n{campaign.body}{footer}",
        button_text="Открыть меню" if deep_link else None,
        button_url=deep_link,
    )
    await _finish_notification(
        delivery_id,
        "sent" if sent else "failed",
        None if sent else "max_delivery_failed",
    )


async def notify_import_owner(job_id: uuid.UUID, text: str) -> None:
    """А1 «импорт готов» to the admin who uploaded the file, through the bot outbox."""
    async with SessionFactory() as session:
        await on_import_finished(session, job_id, text)
        await session.commit()


async def run_bot_checks(now: datetime) -> None:
    """Daily admin signals (А4–А7); the outbox keys keep them to once per period."""
    try:
        async with SessionFactory() as session:
            created = await run_scheduled_checks(session, now)
            await session.commit()
        if created:
            logger.info("Bot checks queued %s admin notifications", created)
    except Exception:
        logger.exception("Bot checks failed")


async def process_job(job_id: uuid.UUID) -> None:
    settings = get_settings()
    async with SessionFactory() as session:
        job = await session.get(ImportJob, job_id)
        if job is None:
            return
        stored_path = job.stored_path
        mime_type = job.mime_type
        restaurant_id = job.restaurant_id
        existing_payload = dict(job.extracted_payload or {})
        venue_id = await session.scalar(
            select(Restaurant.venue_id).where(Restaurant.id == restaurant_id)
        )

    try:
        source_path = resolve_data_path(settings.data_root, stored_path)
        if not source_path.is_file():
            raise FileNotFoundError("Uploaded source file is missing")

        text_content = ""
        page_char_counts: list[int] = []
        extraction_method = "ocr"
        ocr_result: OcrResult | None = None
        if mime_type == "application/pdf":
            text_content, page_char_counts = await asyncio.to_thread(
                extract_pdf_text, source_path
            )
            if len(text_content.strip()) >= 20:
                extraction_method = "embedded_text"

        if extraction_method == "ocr":
            await update_job(job_id, status="ocr", progress=30)
            ocr_result = await asyncio.to_thread(
                ocr_source,
                source_path,
                mime_type,
                settings.data_root,
                restaurant_id,
                job_id,
                settings.ocr_languages,
                settings.ocr_dpi,
                settings.ocr_max_pixels,
                settings.ocr_timeout_seconds,
            )
            text_content = ocr_result.text
            page_char_counts = [len(page.text) for page in ocr_result.pages]

        await update_job(job_id, status="structuring", progress=70)
        # Optional LLM step: the text is data; any failure falls back to the heuristic parser.
        structured_menu, fallback_reason = (
            await structure_with_ai(settings, text_content, venue_id)
            if venue_id is not None
            else (None, "no_venue")
        )
        if structured_menu is None:
            structured_menu = await asyncio.to_thread(structure_menu_text, text_content)
            structured_menu["ai_fallback"] = fallback_reason
        if ocr_result is not None and ocr_result.confidence is not None:
            for section in structured_menu["sections"]:
                assert isinstance(section, dict)
                for item in section["items"]:
                    assert isinstance(item, dict)
                    parser_confidence = float(item.get("source_confidence") or 0)
                    item["source_confidence"] = round(
                        min(parser_confidence, ocr_result.confidence), 4
                    )
        text_path, structure_path = await asyncio.to_thread(
            save_extracted_text,
            settings.data_root,
            restaurant_id,
            job_id,
            text_content,
            structured_menu,
        )
        item_count = structured_menu["item_count"]
        await update_job(
            job_id,
            status="needs_review",
            progress=100,
            error_code=None if item_count else "no_items_detected",
            error_message=(
                None
                if item_count
                else "Текст извлечён, но блюда не распознаны автоматически."
            ),
            extracted_payload={
                **existing_payload,
                "page_char_counts": page_char_counts,
                "text_char_count": len(text_content),
                "extraction_method": extraction_method,
                "ocr_confidence": ocr_result.confidence if ocr_result else None,
                "ocr_pages": (
                    [
                        {
                            "text_char_count": len(page.text),
                            "confidence": page.confidence,
                            "image_path": page.image_path,
                        }
                        for page in ocr_result.pages
                    ]
                    if ocr_result
                    else []
                ),
                "text_path": text_path,
                "structure_path": structure_path,
                "structured_menu": structured_menu,
            },
            finished_at=datetime.now(UTC),
        )
        await notify_import_owner(
            job_id,
            (
                f"Меню распознано: {item_count} позиций. Проверьте результат в кабинете."
                if item_count
                else "Файл обработан, но позиции не распознаны. Проверьте результат в кабинете."
            ),
        )
        logger.info("Import job %s prepared %s menu items", job_id, item_count)
    except Exception as error:
        logger.exception("Import job %s failed", job_id)
        await update_job(
            job_id,
            status="failed",
            progress=100,
            error_code="processing_failed",
            error_message=str(error)[:1000] or "Не удалось обработать файл",
            finished_at=datetime.now(UTC),
        )
        await notify_import_owner(
            job_id,
            "Не удалось обработать меню. Откройте кабинет, чтобы увидеть причину ошибки.",
        )


async def run_analytics_maintenance(now: datetime) -> None:
    """Daily roll-up of closed local days and the 180-day retention of raw events."""
    try:
        async with SessionFactory() as session:
            rolled = await rollup_days(session, now)
            purged = await purge_raw_events(session, now)
            await session.commit()
        if rolled or purged:
            logger.info("Analytics: %s days rolled up, %s raw events purged", rolled, purged)
    except Exception:
        logger.exception("Analytics maintenance failed")


async def run() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    await verify_dependencies()
    logger.info("Worker is ready to process menu imports")
    async with SessionFactory() as session:
        interrupted = await recover_interrupted(session, datetime.now(UTC))
    if interrupted:
        logger.warning("Bot messages interrupted by a restart, not resent: %s", interrupted)
    next_checks_at = datetime.now(UTC)

    try:
        while True:
            job_id = await claim_next_job()
            if job_id is not None:
                await process_job(job_id)
                continue
            now = datetime.now(UTC)
            if now >= next_checks_at:
                next_checks_at = now + timedelta(seconds=settings.bot_checks_interval_seconds)
                await run_bot_checks(now)
                await run_analytics_maintenance(now)
            # Keep the outboxes intact in local/test environments. A missing bot token is
            # a configuration state, not a permanent delivery failure.
            if not settings.max_bot_token:
                await asyncio.sleep(settings.worker_poll_seconds)
                continue
            if await deliver_due(SessionFactory, settings, limit=20):
                continue
            delivery_id = await claim_next_notification()
            if delivery_id is None:
                await asyncio.sleep(settings.worker_poll_seconds)
                continue
            await process_notification(delivery_id)
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(run())
