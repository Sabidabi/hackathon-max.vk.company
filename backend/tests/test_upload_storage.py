from pathlib import Path

import pytest
from pypdf import PdfWriter

from app.imports.storage import (
    UploadValidationError,
    count_pdf_pages,
    validate_file_header,
)


def test_validates_extension_mime_and_signature() -> None:
    assert validate_file_header("menu.PDF", "application/pdf", b"%PDF-1.7") == (
        "menu.PDF",
        ".pdf",
        "application/pdf",
    )
    assert validate_file_header("photo.jpeg", "image/jpeg", b"\xff\xd8\xffanything")[2] == (
        "image/jpeg"
    )


@pytest.mark.parametrize(
    ("filename", "mime_type", "header"),
    [
        ("menu.exe", "application/octet-stream", b"MZ"),
        ("menu.pdf", "image/png", b"%PDF-1.7"),
        ("menu.png", "image/png", b"not a png"),
    ],
)
def test_rejects_unsupported_or_mismatched_files(
    filename: str,
    mime_type: str,
    header: bytes,
) -> None:
    with pytest.raises(UploadValidationError):
        validate_file_header(filename, mime_type, header)


def test_counts_pdf_pages_and_enforces_limit(tmp_path: Path) -> None:
    pdf_path = tmp_path / "menu.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    writer.add_blank_page(width=100, height=100)
    with pdf_path.open("wb") as destination:
        writer.write(destination)

    assert count_pdf_pages(pdf_path, max_pages=2) == 2
    with pytest.raises(UploadValidationError, match="больше 1"):
        count_pdf_pages(pdf_path, max_pages=1)
