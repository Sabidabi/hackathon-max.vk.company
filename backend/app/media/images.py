import io
import re
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from fastapi import UploadFile
from PIL import Image, ImageOps, UnidentifiedImageError

from app.imports.storage import UploadValidationError

RestaurantImageKind = Literal["logo", "cover", "gallery", "background", "menu-item"]
MediaNamespace = Literal["sites", "menu-items"]

ALLOWED_IMAGE_MIMES = {"image/jpeg", "image/png"}
EXPECTED_FORMAT_BY_MIME = {
    "image/jpeg": "JPEG",
    "image/png": "PNG",
}
TARGET_SIZES: dict[RestaurantImageKind, tuple[int, int]] = {
    "logo": (512, 512),
    "cover": (2000, 1400),
    "gallery": (1600, 1200),
    "background": (2000, 2000),
    "menu-item": (1600, 1600),
}
STORAGE_NAMESPACE: dict[RestaurantImageKind, MediaNamespace] = {
    "logo": "sites",
    "cover": "sites",
    "gallery": "sites",
    "background": "sites",
    "menu-item": "menu-items",
}
MAX_SOURCE_PIXELS = 40_000_000
MEDIA_URL_PATTERN = re.compile(
    r"^/media/(?P<namespace>sites|menu-items)/"
    r"(?P<restaurant_id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
    r"[0-9a-f]{4}-[0-9a-f]{12})/(?P<image_id>[0-9a-f]{32})\.webp$"
)


@dataclass(frozen=True)
class StoredRestaurantImage:
    url: str
    width: int
    height: int
    size_bytes: int


def encode_restaurant_image(
    content: bytes,
    kind: RestaurantImageKind,
    *,
    claimed_mime: str | None = None,
) -> tuple[bytes, int, int]:
    try:
        with Image.open(io.BytesIO(content)) as source:
            if source.format not in {"JPEG", "PNG"}:
                raise UploadValidationError("Поддерживаются только JPG и PNG")
            mime_does_not_match = (
                claimed_mime is not None
                and EXPECTED_FORMAT_BY_MIME.get(claimed_mime) != source.format
            )
            if mime_does_not_match:
                raise UploadValidationError("Тип файла не соответствует содержимому")
            if source.width * source.height > MAX_SOURCE_PIXELS:
                raise UploadValidationError("Разрешение изображения слишком большое")

            image = ImageOps.exif_transpose(source)
            image.thumbnail(TARGET_SIZES[kind], Image.Resampling.LANCZOS)
            if image.mode not in {"RGB", "RGBA"}:
                image = image.convert("RGBA" if "transparency" in image.info else "RGB")

            destination = io.BytesIO()
            image.save(destination, format="WEBP", quality=86, method=4)
            return destination.getvalue(), image.width, image.height
    except UploadValidationError:
        raise
    except (UnidentifiedImageError, OSError, ValueError) as error:
        raise UploadValidationError("Не удалось прочитать изображение") from error


async def store_restaurant_image(
    upload: UploadFile,
    data_root: Path,
    restaurant_id: uuid.UUID,
    kind: RestaurantImageKind,
    max_bytes: int,
) -> StoredRestaurantImage:
    try:
        claimed_mime = (upload.content_type or "").lower().split(";", maxsplit=1)[0]
        if claimed_mime not in ALLOWED_IMAGE_MIMES:
            raise UploadValidationError("Поддерживаются только JPG и PNG")

        content = await upload.read(max_bytes + 1)
        if not content:
            raise UploadValidationError("Файл пуст")
        if len(content) > max_bytes:
            raise UploadValidationError(
                f"Размер изображения превышает {max_bytes // (1024 * 1024)} МБ"
            )

        encoded, width, height = encode_restaurant_image(
            content,
            kind,
            claimed_mime=claimed_mime,
        )
        image_id = uuid.uuid4().hex
        namespace = STORAGE_NAMESPACE[kind]
        relative_path = Path(namespace) / str(restaurant_id) / f"{image_id}.webp"
        target_path = data_root / "menu-images" / relative_path
        target_path.parent.mkdir(parents=True, exist_ok=True)
        target_path.write_bytes(encoded)
        return StoredRestaurantImage(
            url=f"/media/{relative_path.as_posix()}",
            width=width,
            height=height,
            size_bytes=len(encoded),
        )
    finally:
        await upload.close()


def media_url_restaurant_id(url: str, namespace: MediaNamespace) -> uuid.UUID | None:
    match = MEDIA_URL_PATTERN.fullmatch(url)
    if match is None or match.group("namespace") != namespace:
        return None
    try:
        restaurant_id = uuid.UUID(match.group("restaurant_id"))
    except ValueError:
        return None
    return restaurant_id if str(restaurant_id) == match.group("restaurant_id") else None


def clone_restaurant_image(
    url: str,
    data_root: Path,
    source_restaurant_id: uuid.UUID,
    target_restaurant_id: uuid.UUID,
) -> tuple[str, Path]:
    """Give the target point its own file; menu image URLs never cross tenants."""
    match = MEDIA_URL_PATTERN.fullmatch(url)
    if match is None or match.group("namespace") != "menu-items":
        raise ValueError("Invalid menu image URL")
    if match.group("restaurant_id") != str(source_restaurant_id):
        raise ValueError("Menu image belongs to another restaurant")
    root = data_root / "menu-images" / "menu-items"
    source = root / str(source_restaurant_id) / f"{match.group('image_id')}.webp"
    if not source.is_file():
        raise FileNotFoundError("Source menu image is missing")
    target_name = f"{uuid.uuid4().hex}.webp"
    target = root / str(target_restaurant_id) / target_name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    return f"/media/menu-items/{target_restaurant_id}/{target_name}", target
