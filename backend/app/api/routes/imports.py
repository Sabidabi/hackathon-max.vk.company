import uuid
from datetime import datetime
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.menus import (
    _existing_keys,
    check_revision,
    get_menu_and_draft,
    menu_revision,
    name_key,
    read_version_sections,
)
from app.auth.dependencies import get_current_user
from app.auth.permissions import require_venue_admin
from app.config import Settings, get_settings
from app.database import get_session
from app.imports.storage import UploadValidationError, remove_stored_upload, store_upload
from app.menu_configuration import ItemConfiguration, Variant
from app.models import ImportJob, MenuItem, MenuSection, User

router = APIRouter(prefix="/restaurants/{restaurant_id}/imports", tags=["imports"])


class ImportJobResponse(BaseModel):
    id: uuid.UUID
    restaurant_id: uuid.UUID
    original_name: str
    mime_type: str
    size_bytes: int
    sha256: str
    status: str
    progress: int
    page_count: int | None
    item_count: int | None
    error_message: str | None
    error_code: str | None
    extraction_method: str | None
    ocr_confidence: float | None
    # How the review was structured: "llm-v1" (AI, checked by code) or "heuristic-v1".
    parser: str | None = None
    created_at: datetime

    @classmethod
    def from_job(cls, job: ImportJob) -> "ImportJobResponse":
        payload = job.extracted_payload or {}
        page_count = payload.get("page_count")
        structured_menu = payload.get("structured_menu")
        item_count = (
            structured_menu.get("item_count") if isinstance(structured_menu, dict) else None
        )
        return cls(
            id=job.id,
            restaurant_id=job.restaurant_id,
            original_name=job.original_name,
            mime_type=job.mime_type,
            size_bytes=job.size_bytes,
            sha256=job.sha256,
            status=job.status,
            progress=job.progress,
            page_count=page_count if isinstance(page_count, int) else None,
            item_count=item_count if isinstance(item_count, int) else None,
            error_message=job.error_message,
            error_code=job.error_code,
            extraction_method=(
                payload.get("extraction_method")
                if isinstance(payload.get("extraction_method"), str)
                else None
            ),
            ocr_confidence=(
                float(payload["ocr_confidence"])
                if isinstance(payload.get("ocr_confidence"), int | float)
                else None
            ),
            parser=(
                structured_menu.get("parser")
                if isinstance(structured_menu, dict)
                and isinstance(structured_menu.get("parser"), str)
                else None
            ),
            created_at=job.created_at,
        )


class ReviewVariant(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    # 0 = not recognised: the size is saved unavailable until the admin enters a price.
    price_minor: int = Field(ge=0, le=100_000_000)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Укажите размер")
        return value.strip()


class FieldConfidence(BaseModel):
    name: float | None = Field(default=None, ge=0, le=1)
    price: float | None = Field(default=None, ge=0, le=1)


class ReviewItem(BaseModel):
    name: str = Field(min_length=1, max_length=250)
    price_minor: int = Field(ge=0, le=100_000_000)
    currency: str = Field(default="RUB", pattern="^RUB$")
    weight_text: str | None = Field(default=None, max_length=100)
    description: str | None = Field(default=None, max_length=2000)
    source_line: str | None = Field(default=None, max_length=2000)
    source_confidence: float | None = Field(default=None, ge=0, le=1)
    # The price was not readable in the source: shown as «Проверьте цену»; with price 0 the
    # position lands in the draft and publication stays blocked until a price is entered.
    price_missing: bool = False
    field_confidence: FieldConfidence | None = None
    variants: list[ReviewVariant] = Field(default_factory=list, max_length=10)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Укажите название позиции")
        return value.strip()


class ReviewSection(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    items: list[ReviewItem] = Field(min_length=1, max_length=300)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Укажите название раздела")
        return value.strip()


class MenuReviewPayload(BaseModel):
    sections: list[ReviewSection] = Field(min_length=1, max_length=100)


class ImportReviewResponse(MenuReviewPayload):
    draft_revision: str
    import_id: uuid.UUID
    status: str
    unparsed_lines: list[str]
    # "llm-v1" — structured by the AI (checked by code), "heuristic-v1" — by the parser.
    parser: str
    provider: str | None = None


class ApplyReviewPayload(MenuReviewPayload):
    expected_revision: str = Field(pattern="^[a-f0-9]{64}$")


class ApplyReviewResponse(BaseModel):
    import_id: uuid.UUID
    draft_version_id: uuid.UUID
    section_count: int
    item_count: int
    status: str


async def require_import_access(
    session: AsyncSession,
    user: User,
    restaurant_id: uuid.UUID,
) -> None:
    await require_venue_admin(session, user.id, restaurant_id)


async def get_import_job(
    session: AsyncSession,
    restaurant_id: uuid.UUID,
    import_id: uuid.UUID,
) -> ImportJob:
    job = await session.scalar(
        select(ImportJob).where(
            ImportJob.id == import_id,
            ImportJob.restaurant_id == restaurant_id,
        )
    )
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Import not found")
    return job


@router.get("", response_model=list[ImportJobResponse])
async def list_imports(
    restaurant_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[ImportJobResponse]:
    await require_import_access(session, current_user, restaurant_id)
    jobs = (
        await session.scalars(
            select(ImportJob)
            .where(ImportJob.restaurant_id == restaurant_id)
            .order_by(ImportJob.created_at.desc())
            .limit(20)
        )
    ).all()
    return [ImportJobResponse.from_job(job) for job in jobs]


@router.post("", response_model=ImportJobResponse, status_code=status.HTTP_201_CREATED)
async def upload_menu_source(
    restaurant_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
    file: Annotated[UploadFile, File()],
) -> ImportJobResponse:
    await require_import_access(session, current_user, restaurant_id)
    import_id = uuid.uuid4()

    try:
        stored = await store_upload(
            file,
            settings.data_root,
            restaurant_id,
            import_id,
            settings.max_upload_bytes,
            settings.max_pdf_pages,
        )
    except UploadValidationError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(error),
        ) from error

    job = ImportJob(
        id=import_id,
        restaurant_id=restaurant_id,
        created_by_id=current_user.id,
        original_name=stored.original_name,
        stored_path=stored.stored_path,
        mime_type=stored.mime_type,
        size_bytes=stored.size_bytes,
        sha256=stored.sha256,
        status="queued",
        progress=0,
        extracted_payload={"page_count": stored.page_count},
    )
    session.add(job)
    try:
        await session.commit()
        await session.refresh(job)
    except Exception:
        await session.rollback()
        remove_stored_upload(settings.data_root, stored.stored_path)
        raise

    return ImportJobResponse.from_job(job)


@router.get("/{import_id}/review", response_model=ImportReviewResponse)
async def get_import_review(
    restaurant_id: uuid.UUID,
    import_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> ImportReviewResponse:
    await require_import_access(session, current_user, restaurant_id)
    job = await get_import_job(session, restaurant_id, import_id)
    payload = job.extracted_payload or {}
    structured_menu = payload.get("structured_menu")
    if not isinstance(structured_menu, dict):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This import has no structured menu to review",
        )

    review = MenuReviewPayload.model_validate(structured_menu)
    raw_unparsed = structured_menu.get("unparsed_lines", [])
    unparsed_lines = [line[:1000] for line in raw_unparsed if isinstance(line, str)][:100]
    _, draft = await get_menu_and_draft(session, restaurant_id, lock=True)
    return ImportReviewResponse(
        draft_revision=menu_revision(await read_version_sections(session, draft.id)),
        import_id=job.id,
        status=job.status,
        sections=review.sections,
        unparsed_lines=unparsed_lines,
        parser=str(structured_menu.get("parser") or "heuristic-v1"),
        provider=(
            structured_menu["provider"] if isinstance(structured_menu.get("provider"), str)
            else None
        ),
    )


@router.post("/{import_id}/retry", response_model=ImportJobResponse)
async def retry_import(
    restaurant_id: uuid.UUID,
    import_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> ImportJobResponse:
    await require_import_access(session, current_user, restaurant_id)
    job = await get_import_job(session, restaurant_id, import_id)
    if job.status not in {"failed", "needs_review"}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Only failed or review-required imports can be retried",
        )
    if job.status == "needs_review" and job.error_code != "ocr_required":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This import already has a review result",
        )

    job.status = "queued"
    job.progress = 0
    job.error_code = None
    job.error_message = None
    job.started_at = None
    job.finished_at = None
    await session.commit()
    await session.refresh(job)
    return ImportJobResponse.from_job(job)


@router.post("/{import_id}/apply", response_model=ApplyReviewResponse)
async def apply_import_review(
    restaurant_id: uuid.UUID,
    import_id: uuid.UUID,
    payload: ApplyReviewPayload,
    session: Annotated[AsyncSession, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> ApplyReviewResponse:
    await require_import_access(session, current_user, restaurant_id)
    menu, draft = await get_menu_and_draft(session, restaurant_id, lock=True)
    job = await get_import_job(session, restaurant_id, import_id)
    if job.status != "needs_review":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Import is not ready for review",
        )

    item_count = sum(len(section.items) for section in payload.sections)
    if item_count > 1000:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Menu cannot contain more than 1000 items",
        )

    await check_revision(session, draft.id, payload.expected_revision)
    menu.updated_at = datetime.now().astimezone()

    # Positions that keep their «section + name» keep their item_key, so the point
    # stop-lists stay attached after a re-import.
    _, keys_by_name = await _existing_keys(session, draft.id)
    used_keys: set[uuid.UUID] = set()
    seen: dict[tuple[str, str], int] = {}
    await session.execute(delete(MenuSection).where(MenuSection.menu_version_id == draft.id))
    await session.flush()
    for section_index, review_section in enumerate(payload.sections):
        menu_section = MenuSection(
            menu_version_id=draft.id,
            name=review_section.name.strip(),
            sort_order=section_index,
        )
        session.add(menu_section)
        await session.flush()
        for item_index, review_item in enumerate(review_section.items):
            base = name_key(review_section.name, review_item.name)
            occurrence = seen.get(base, 0)
            seen[base] = occurrence + 1
            key = keys_by_name.get((*base, occurrence))
            if key is None or key in used_keys:
                key = uuid.uuid4()
            used_keys.add(key)
            configuration = ItemConfiguration()
            price_minor = review_item.price_minor
            if len(review_item.variants) >= 2:
                variants = [
                    Variant(
                        id=uuid.uuid4(), name=variant.name, price_minor=variant.price_minor,
                        is_available=variant.price_minor > 0,
                    )
                    for variant in review_item.variants
                ]
                default = next((v for v in variants if v.is_available), variants[0])
                configuration = ItemConfiguration(
                    variants=variants, default_variant_id=default.id
                )
                priced = [v.price_minor for v in variants if v.price_minor > 0]
                price_minor = min(priced) if priced else 0
            session.add(
                MenuItem(
                    section_id=menu_section.id,
                    item_key=key,
                    name=review_item.name.strip(),
                    configuration=configuration.model_dump(mode="json"),
                    description=review_item.description,
                    price_minor=price_minor,
                    currency=review_item.currency,
                    weight_text=review_item.weight_text,
                    ingredients=None,
                    allergens=[],
                    is_available=True,
                    source_confidence=(
                        Decimal(str(review_item.source_confidence))
                        if review_item.source_confidence is not None
                        else None
                    ),
                    sort_order=item_index,
                )
            )

    job.status = "completed"
    job.progress = 100
    job.error_code = None
    job.error_message = None
    job.extracted_payload = {
        **(job.extracted_payload or {}),
        "approved_menu": payload.model_dump(mode="json"),
        "applied_draft_version_id": str(draft.id),
        "applied_at": datetime.now().astimezone().isoformat(),
    }
    await session.commit()
    return ApplyReviewResponse(
        import_id=job.id,
        draft_version_id=draft.id,
        section_count=len(payload.sections),
        item_count=item_count,
        status=job.status,
    )
