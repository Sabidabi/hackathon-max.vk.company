import csv
import io
import math
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path

import pymupdf
from PIL import Image, ImageOps

from app.imports.storage import UploadValidationError


class OcrError(RuntimeError):
    pass


@dataclass(frozen=True)
class OcrPage:
    text: str
    confidence: float | None
    image_path: str


@dataclass(frozen=True)
class OcrResult:
    text: str
    pages: list[OcrPage]

    @property
    def confidence(self) -> float | None:
        values = [page.confidence for page in self.pages if page.confidence is not None]
        return round(sum(values) / len(values), 4) if values else None


def parse_tesseract_tsv(content: str) -> tuple[str, float | None]:
    lines: dict[tuple[str, str, str, str], list[str]] = {}
    confidences: list[float] = []
    reader = csv.DictReader(io.StringIO(content), delimiter="\t")
    for row in reader:
        if row.get("level") != "5":
            continue
        word = (row.get("text") or "").strip()
        if not word:
            continue
        key = (
            row.get("page_num") or "0",
            row.get("block_num") or "0",
            row.get("par_num") or "0",
            row.get("line_num") or "0",
        )
        lines.setdefault(key, []).append(word)
        try:
            confidence = float(row.get("conf") or "-1")
        except ValueError:
            confidence = -1
        if confidence >= 0:
            confidences.append(confidence)

    text = "\n".join(" ".join(words) for words in lines.values())
    mean_confidence = (
        round(sum(confidences) / len(confidences) / 100, 4) if confidences else None
    )
    return text, mean_confidence


def run_tesseract(
    image_path: Path,
    languages: str,
    timeout_seconds: int,
) -> tuple[str, float | None]:
    try:
        result = subprocess.run(
            [
                "tesseract",
                str(image_path),
                "stdout",
                "-l",
                languages,
                "--psm",
                "6",
                "tsv",
            ],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
        )
    except FileNotFoundError as error:
        raise OcrError("OCR-движок не установлен на сервере") from error
    except subprocess.TimeoutExpired as error:
        raise OcrError("OCR не успел обработать страницу за отведённое время") from error

    if result.returncode != 0:
        message = result.stderr.strip().splitlines()
        detail = message[-1][:300] if message else "неизвестная ошибка"
        raise OcrError(f"OCR не смог обработать страницу: {detail}")
    return parse_tesseract_tsv(result.stdout)


def _fit_image(image: Image.Image, max_pixels: int) -> Image.Image:
    image = ImageOps.exif_transpose(image)
    pixel_count = image.width * image.height
    if pixel_count > max_pixels * 4:
        raise UploadValidationError("Разрешение изображения слишком большое для OCR")
    if pixel_count > max_pixels:
        scale = math.sqrt(max_pixels / pixel_count)
        target_size = (
            max(1, int(image.width * scale)),
            max(1, int(image.height * scale)),
        )
        image = image.resize(target_size, Image.Resampling.LANCZOS)
    return ImageOps.autocontrast(image.convert("L"))


def prepare_image(source_path: Path, target_path: Path, max_pixels: int) -> None:
    try:
        with Image.open(source_path) as source:
            image = _fit_image(source, max_pixels)
            target_path.parent.mkdir(parents=True, exist_ok=True)
            image.save(target_path, format="PNG", compress_level=3)
    except UploadValidationError:
        raise
    except (OSError, ValueError) as error:
        raise UploadValidationError("Не удалось подготовить изображение для OCR") from error


def render_pdf_pages(
    source_path: Path,
    target_dir: Path,
    dpi: int,
    max_pixels: int,
) -> list[Path]:
    target_dir.mkdir(parents=True, exist_ok=True)
    rendered: list[Path] = []
    try:
        with pymupdf.open(source_path) as document:
            if document.needs_pass:
                raise UploadValidationError("Защищённые паролем PDF не поддерживаются")
            for index, page in enumerate(document):
                width = math.ceil(page.rect.width * dpi / 72)
                height = math.ceil(page.rect.height * dpi / 72)
                page_dpi = dpi
                if width * height > max_pixels:
                    page_dpi = max(72, int(dpi * math.sqrt(max_pixels / (width * height))))
                pixmap = page.get_pixmap(dpi=page_dpi, colorspace=pymupdf.csGRAY, alpha=False)
                target_path = target_dir / f"page-{index + 1:03d}.png"
                pixmap.save(target_path)
                rendered.append(target_path)
    except UploadValidationError:
        raise
    except (OSError, RuntimeError, ValueError) as error:
        raise UploadValidationError("Не удалось отрисовать страницы PDF для OCR") from error
    return rendered


def ocr_source(
    source_path: Path,
    mime_type: str,
    data_root: Path,
    restaurant_id: uuid.UUID,
    import_id: uuid.UUID,
    languages: str,
    dpi: int,
    max_pixels: int,
    timeout_seconds: int,
) -> OcrResult:
    target_dir = data_root / "rendered" / str(restaurant_id) / str(import_id)
    if mime_type == "application/pdf":
        images = render_pdf_pages(source_path, target_dir, dpi, max_pixels)
    elif mime_type in {"image/jpeg", "image/png"}:
        target_path = target_dir / "page-001.png"
        prepare_image(source_path, target_path, max_pixels)
        images = [target_path]
    else:
        raise UploadValidationError("Этот формат не поддерживается OCR")

    pages: list[OcrPage] = []
    for image_path in images:
        text, confidence = run_tesseract(image_path, languages, timeout_seconds)
        pages.append(
            OcrPage(
                text=text.strip(),
                confidence=confidence,
                image_path=image_path.relative_to(data_root).as_posix(),
            )
        )
    return OcrResult(
        text="\n\n".join(page.text for page in pages if page.text),
        pages=pages,
    )
