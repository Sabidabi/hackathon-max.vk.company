import io
import uuid
from pathlib import Path

import pymupdf
from PIL import Image, ImageDraw, ImageFont

from app.imports.ocr import ocr_source, parse_tesseract_tsv, prepare_image


def test_parses_tesseract_words_into_lines_and_confidence() -> None:
    header = (
        "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\t"
        "left\ttop\twidth\theight\tconf\ttext"
    )
    rows = """5\t1\t1\t1\t1\t1\t0\t0\t20\t10\t90.0\tCoffee
5\t1\t1\t1\t1\t2\t21\t0\t20\t10\t80.0\t250
5\t1\t1\t1\t2\t1\t0\t12\t20\t10\t70.0\tTea
"""
    tsv = f"{header}\n{rows}"

    text, confidence = parse_tesseract_tsv(tsv)

    assert text == "Coffee 250\nTea"
    assert confidence == 0.8


def test_prepare_image_limits_pixels(tmp_path: Path) -> None:
    source_path = tmp_path / "source.png"
    target_path = tmp_path / "prepared.png"
    Image.new("RGB", (2000, 1000), "white").save(source_path)

    prepare_image(source_path, target_path, max_pixels=500_000)

    with Image.open(target_path) as prepared:
        assert prepared.width * prepared.height <= 500_000
        assert prepared.mode == "L"


def test_ocr_reads_image_only_pdf(tmp_path: Path) -> None:
    image = Image.new("RGB", (1200, 800), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=54)
    draw.multiline_text(
        (80, 100),
        "BREAKFAST\nOMELETTE 450\nCOFFEE 200",
        fill="black",
        font=font,
        spacing=30,
    )
    image_bytes = io.BytesIO()
    image.save(image_bytes, format="PNG")

    pdf_path = tmp_path / "scan.pdf"
    document = pymupdf.open()
    page = document.new_page(width=600, height=400)
    page.insert_image(page.rect, stream=image_bytes.getvalue())
    document.save(pdf_path)
    document.close()

    result = ocr_source(
        source_path=pdf_path,
        mime_type="application/pdf",
        data_root=tmp_path,
        restaurant_id=uuid.uuid4(),
        import_id=uuid.uuid4(),
        languages="eng",
        dpi=220,
        max_pixels=10_000_000,
        timeout_seconds=30,
    )

    assert "OMELETTE" in result.text.upper()
    assert "450" in result.text
    assert result.confidence is not None
    assert len(result.pages) == 1
