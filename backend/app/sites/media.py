import uuid
from pathlib import Path
from typing import Literal

from fastapi import UploadFile

from app.media.images import (
    StoredRestaurantImage,
    encode_restaurant_image,
    store_restaurant_image,
)

SiteImageKind = Literal["logo", "cover", "gallery", "background"]
StoredSiteImage = StoredRestaurantImage


def encode_site_image(content: bytes, kind: SiteImageKind) -> tuple[bytes, int, int]:
    return encode_restaurant_image(content, kind)


async def store_site_image(
    upload: UploadFile,
    data_root: Path,
    restaurant_id: uuid.UUID,
    kind: SiteImageKind,
    max_bytes: int,
) -> StoredSiteImage:
    return await store_restaurant_image(upload, data_root, restaurant_id, kind, max_bytes)
