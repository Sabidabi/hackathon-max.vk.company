import io
import uuid

import pytest
from fastapi import HTTPException, UploadFile
from PIL import Image
from starlette.datastructures import Headers

from app.api.routes.menus import (
    MenuItemPayload,
    MenuSectionPayload,
    validate_menu_image_ownership,
)
from app.imports.storage import UploadValidationError
from app.media.images import clone_restaurant_image, media_url_restaurant_id, store_restaurant_image


def make_png(size: tuple[int, int] = (2400, 1800)) -> bytes:
    source = io.BytesIO()
    Image.new("RGB", size, "tomato").save(source, format="PNG")
    return source.getvalue()


def make_upload(content: bytes, content_type: str) -> UploadFile:
    return UploadFile(
        file=io.BytesIO(content),
        filename="dish.png",
        headers=Headers({"content-type": content_type}),
    )


@pytest.mark.asyncio
async def test_menu_item_image_is_resized_converted_and_scoped(tmp_path) -> None:
    restaurant_id = uuid.uuid4()

    stored = await store_restaurant_image(
        make_upload(make_png(), "image/png"),
        tmp_path,
        restaurant_id,
        "menu-item",
        8 * 1024 * 1024,
    )

    assert stored.url.startswith(f"/media/menu-items/{restaurant_id}/")
    assert media_url_restaurant_id(stored.url, "menu-items") == restaurant_id
    stored_path = tmp_path / "menu-images" / stored.url.removeprefix("/media/")
    assert stored_path.is_file()
    assert stored.size_bytes == stored_path.stat().st_size
    with Image.open(stored_path) as image:
        assert image.format == "WEBP"
        assert image.width <= 1600
        assert image.height <= 1600


@pytest.mark.asyncio
async def test_menu_item_image_rejects_mime_content_mismatch(tmp_path) -> None:
    with pytest.raises(UploadValidationError, match="не соответствует"):
        await store_restaurant_image(
            make_upload(make_png((100, 100)), "image/jpeg"),
            tmp_path,
            uuid.uuid4(),
            "menu-item",
            1024 * 1024,
        )


def test_menu_item_image_url_must_be_local_and_belong_to_restaurant() -> None:
    restaurant_id = uuid.uuid4()
    other_restaurant_id = uuid.uuid4()
    foreign_url = f"/media/menu-items/{other_restaurant_id}/{uuid.uuid4().hex}.webp"
    section = MenuSectionPayload(
        name="Основное",
        items=[MenuItemPayload(name="Паста", price_minor=75000, image_url=foreign_url)],
    )

    with pytest.raises(HTTPException) as error:
        validate_menu_image_ownership(restaurant_id, [section])

    assert error.value.status_code == 422
    assert media_url_restaurant_id("https://example.com/dish.webp", "menu-items") is None
    assert media_url_restaurant_id(foreign_url, "sites") is None


@pytest.mark.asyncio
async def test_menu_photo_copy_gets_target_point_storage(tmp_path) -> None:
    source_id, target_id = uuid.uuid4(), uuid.uuid4()
    stored = await store_restaurant_image(
        make_upload(make_png((200, 120)), "image/png"),
        tmp_path,
        source_id,
        "menu-item",
        1024 * 1024,
    )
    copied_url, copied_path = clone_restaurant_image(
        stored.url, tmp_path, source_id, target_id,
    )
    assert media_url_restaurant_id(copied_url, "menu-items") == target_id
    assert copied_path.is_file()
    assert copied_path.read_bytes() == (
        tmp_path / "menu-images" / stored.url.removeprefix("/media/")
    ).read_bytes()
    with pytest.raises(ValueError, match="another restaurant"):
        clone_restaurant_image(stored.url, tmp_path, target_id, source_id)
