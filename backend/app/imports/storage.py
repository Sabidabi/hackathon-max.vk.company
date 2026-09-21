import hashlib
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path

from fastapi import UploadFile
from pypdf import PdfReader
from pypdf.errors import PdfReadError


class UploadValidationError(ValueError):
    pass


@dataclass(frozen=True)
class StoredUpload:
    original_name: str
    stored_path: str
    mime_type: str
    size_bytes: int
    sha256: str
    page_count: int | None


ALLOWED_FILES = {
    ".pdf": ("application/pdf", b"%PDF-"),
    ".jpg": ("image/jpeg", b"\xff\xd8\xff"),
    ".jpeg": ("image/jpeg", b"\xff\xd8\xff"),
    ".png": ("image/png", b"\x89PNG\r\n\x1a\n"),
}


def normalize_filename(filename: str | None) -> tuple[str, str, bytes]:
    original_name = (filename or "").replace("\\", "/").split("/")[-1].strip()
    if not original_name or original_name in {".", ".."}:
        raise UploadValidationError("У файла отсутствует имя")
    if len(original_name) > 500:
        raise UploadValidationError("Имя файла слишком длинное")

    extension = Path(original_name).suffix.lower()
    allowed = ALLOWED_FILES.get(extension)
    if allowed is None:
        raise UploadValidationError("Поддерживаются только PDF, JPG, JPEG и PNG")
    expected_mime, signature = allowed
    return original_name, expected_mime, signature


def validate_file_header(
    filename: str | None,
    content_type: str | None,
    header: bytes,
) -> tuple[str, str, str]:
    original_name, expected_mime, signature = normalize_filename(filename)
    claimed_mime = (content_type or "").lower().split(";", maxsplit=1)[0].strip()
    if claimed_mime != expected_mime:
        raise UploadValidationError("Тип файла не соответствует его расширению")
    if not header.startswith(signature):
        raise UploadValidationError("Содержимое файла не соответствует заявленному формату")
    return original_name, Path(original_name).suffix.lower(), expected_mime


def count_pdf_pages(path: Path, max_pages: int) -> int:
    try:
        reader = PdfReader(path, strict=False)
        if reader.is_encrypted:
            raise UploadValidationError("Защищённые паролем PDF не поддерживаются")
        page_count = len(reader.pages)
    except UploadValidationError:
        raise
    except (PdfReadError, OSError, ValueError) as error:
        raise UploadValidationError("PDF повреждён или имеет неподдерживаемый формат") from error

    if page_count == 0:
        raise UploadValidationError("PDF не содержит страниц")
    if page_count > max_pages:
        raise UploadValidationError(f"В PDF не должно быть больше {max_pages} страниц")
    return page_count


async def store_upload(
    upload: UploadFile,
    data_root: Path,
    restaurant_id: uuid.UUID,
    import_id: uuid.UUID,
    max_bytes: int,
    max_pdf_pages: int,
) -> StoredUpload:
    target_dir = data_root / "uploads" / str(restaurant_id) / str(import_id)
    target_path: Path | None = None

    try:
        first_chunk = await upload.read(min(64 * 1024, max_bytes + 1))
        if not first_chunk:
            raise UploadValidationError("Файл пуст")

        original_name, extension, mime_type = validate_file_header(
            upload.filename,
            upload.content_type,
            first_chunk,
        )
        target_dir.mkdir(parents=True, exist_ok=False)
        target_path = target_dir / f"source{extension}"

        size_bytes = 0
        digest = hashlib.sha256()
        with target_path.open("xb") as destination:
            chunk = first_chunk
            while chunk:
                size_bytes += len(chunk)
                if size_bytes > max_bytes:
                    raise UploadValidationError(
                        f"Размер файла превышает {max_bytes // (1024 * 1024)} МБ"
                    )
                digest.update(chunk)
                destination.write(chunk)
                chunk = await upload.read(64 * 1024)

        page_count = (
            count_pdf_pages(target_path, max_pdf_pages) if mime_type == "application/pdf" else None
        )
        return StoredUpload(
            original_name=original_name,
            stored_path=target_path.relative_to(data_root).as_posix(),
            mime_type=mime_type,
            size_bytes=size_bytes,
            sha256=digest.hexdigest(),
            page_count=page_count,
        )
    except Exception:
        if target_dir.exists():
            shutil.rmtree(target_dir)
        raise
    finally:
        await upload.close()


def remove_stored_upload(data_root: Path, stored_path: str) -> None:
    resolved_root = data_root.resolve()
    file_path = (data_root / stored_path).resolve()
    if not file_path.is_relative_to(resolved_root):
        raise ValueError("Stored path is outside the data root")
    import_dir = file_path.parent
    if import_dir.exists():
        shutil.rmtree(import_dir)
