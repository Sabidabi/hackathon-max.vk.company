import io

import pytest
from PIL import Image

from app.imports.storage import UploadValidationError
from app.sites.media import encode_site_image


def test_site_image_is_resized_and_converted_to_webp() -> None:
    source = io.BytesIO()
    Image.new("RGB", (2400, 1800), "orange").save(source, format="PNG")

    encoded, width, height = encode_site_image(source.getvalue(), "gallery")

    assert width <= 1600
    assert height <= 1200
    with Image.open(io.BytesIO(encoded)) as result:
        assert result.format == "WEBP"


def test_site_image_rejects_unknown_content() -> None:
    with pytest.raises(UploadValidationError, match="прочитать"):
        encode_site_image(b"not an image", "cover")


def test_background_image_is_bounded() -> None:
    source = io.BytesIO()
    Image.new("RGB", (3000, 2400), "black").save(source, format="JPEG")

    _, width, height = encode_site_image(source.getvalue(), "background")

    assert width <= 2000
    assert height <= 2000
