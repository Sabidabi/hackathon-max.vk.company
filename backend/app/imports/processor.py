import json
import re
import uuid
from decimal import Decimal, InvalidOperation
from pathlib import Path

from pypdf import PdfReader
from pypdf.errors import PdfReadError

from app.imports.storage import UploadValidationError

PRICE_PATTERN = re.compile(
    r"^(?P<name>.+?)\s+(?P<price>(?:\d{1,3}(?:\s\d{3})*|\d{1,6})(?:[.,]\d{1,2})?)\s*"
    r"(?P<currency>₽|руб(?:\.|лей)?|р\.)?$",
    re.IGNORECASE,
)
WEIGHT_PRICE_PATTERN = re.compile(
    r"^(?P<weight>[\d\s/.,]+\s*(?:г|гр|мл|л|шт\.?))\s*[–—-]\s*"
    r"(?P<price>(?:\d{1,3}(?:\s\d{3})*|\d{1,6})(?:[.,]\d{1,2})?)\s*"
    r"(?:₽|руб(?:\.|лей)?|р\.)?$",
    re.IGNORECASE,
)
BOILERPLATE_PREFIXES = (
    "Все цены указаны",
    "Данная информация является рекламой",
)


def resolve_data_path(data_root: Path, relative_path: str) -> Path:
    if Path(relative_path).is_absolute():
        raise ValueError("Stored path must be relative")
    resolved_root = data_root.resolve()
    resolved_path = (data_root / relative_path).resolve()
    if not resolved_path.is_relative_to(resolved_root):
        raise ValueError("Stored path is outside the data root")
    return resolved_path


def extract_pdf_text(path: Path) -> tuple[str, list[int]]:
    try:
        reader = PdfReader(path, strict=False)
        if reader.is_encrypted:
            raise UploadValidationError("Защищённые паролем PDF не поддерживаются")
        page_texts = [(page.extract_text() or "").strip() for page in reader.pages]
    except UploadValidationError:
        raise
    except (PdfReadError, OSError, ValueError) as error:
        raise UploadValidationError("Не удалось прочитать текст PDF") from error

    text = "\n\n".join(page_text for page_text in page_texts if page_text)
    return text, [len(page_text) for page_text in page_texts]


def parse_price(line: str) -> tuple[str, int] | None:
    match = PRICE_PATTERN.match(line)
    if match is None:
        return None
    name = match.group("name").strip(" .·-–—")
    if len(name) < 2:
        return None
    try:
        amount = Decimal(match.group("price").replace(" ", "").replace(",", "."))
    except InvalidOperation:
        return None
    return name, int(amount * 100)


def looks_like_heading(line: str) -> bool:
    letters = "".join(character for character in line if character.isalpha())
    is_uppercase = bool(letters) and letters == letters.upper()
    return len(line) <= 100 and (line.endswith(":") or is_uppercase)


def add_item(
    sections: list[dict[str, object]],
    current_section: dict[str, object] | None,
    name: str,
    price_minor: int,
    source_line: str,
    weight_text: str | None = None,
) -> dict[str, object]:
    if current_section is None:
        current_section = {"name": "Меню", "sort_order": 0, "items": []}
        sections.append(current_section)
    items = current_section["items"]
    assert isinstance(items, list)
    items.append(
        {
            "name": name.strip(" .·-–—"),
            "price_minor": price_minor,
            "currency": "RUB",
            "weight_text": weight_text,
            "sort_order": len(items),
            "source_line": source_line,
            "source_confidence": 0.75,
        }
    )
    return current_section


def structure_menu_text(text: str) -> dict[str, object]:
    line_entries: list[tuple[str, list[str]]] = []
    for raw_line in text.splitlines():
        stripped = raw_line.strip()
        line = re.sub(r"\s+", " ", stripped)
        if not line or any(line.startswith(prefix) for prefix in BOILERPLATE_PREFIXES):
            continue
        columns = [
            re.sub(r"\s+", " ", part).strip()
            for part in re.split(r"\s{3,}", stripped)
            if part.strip()
        ]
        line_entries.append((line, columns))

    sections: list[dict[str, object]] = []
    sections_by_name: dict[str, dict[str, object]] = {}
    unparsed_lines: list[str] = []
    current_section: dict[str, object] | None = None
    pending_name_lines: list[str] = []
    pending_name_columns: list[str] | None = None

    for line, columns in line_entries:
        parsed_price = parse_price(line)
        weight_price = WEIGHT_PRICE_PATTERN.match(line)
        if parsed_price is None and weight_price is None and looks_like_heading(line):
            if pending_name_lines:
                unparsed_lines.append(" ".join(pending_name_lines))
                pending_name_lines = []
            if "МЕНЮ РЕСТОРАНА" in line:
                continue
            section_name = line.rstrip(":")
            section_key = section_name.casefold()
            current_section = sections_by_name.get(section_key)
            if current_section is None:
                current_section = {
                    "name": section_name,
                    "sort_order": len(sections),
                    "items": [],
                }
                sections.append(current_section)
                sections_by_name[section_key] = current_section
            continue

        column_prices = [WEIGHT_PRICE_PATTERN.match(column) for column in columns]
        if (
            len(column_prices) > 1
            and all(match is not None for match in column_prices)
            and pending_name_columns
            and len(pending_name_columns) == len(column_prices)
        ):
            for name, match in zip(pending_name_columns, column_prices, strict=True):
                assert match is not None
                price_minor = int(Decimal(match.group("price").replace(" ", "")) * 100)
                current_section = add_item(
                    sections,
                    current_section,
                    name,
                    price_minor,
                    f"{name} {match.group(0)}",
                    re.sub(r"\s+", " ", match.group("weight")).strip(),
                )
            pending_name_lines = []
            pending_name_columns = None
            continue

        if weight_price is not None:
            if not pending_name_lines:
                unparsed_lines.append(line)
                continue
            name = " ".join(pending_name_lines)
            pending_name_lines = []
            pending_name_columns = None
            price_minor = int(Decimal(weight_price.group("price").replace(" ", "")) * 100)
            current_section = add_item(
                sections,
                current_section,
                name,
                price_minor,
                f"{name} {line}",
                re.sub(r"\s+", " ", weight_price.group("weight")).strip(),
            )
            continue

        if parsed_price is not None:
            name, price_minor = parsed_price
            full_name = " ".join([*pending_name_lines, name])
            pending_name_lines = []
            pending_name_columns = None
            current_section = add_item(
                sections,
                current_section,
                full_name,
                price_minor,
                line,
            )
            continue

        pending_name_lines.append(line)
        pending_name_columns = columns if len(columns) > 1 else None

    if pending_name_lines:
        unparsed_lines.append(" ".join(pending_name_lines))

    sections = [section for section in sections if section["items"]]
    for section_index, section in enumerate(sections):
        section["sort_order"] = section_index

    item_count = sum(len(section["items"]) for section in sections)  # type: ignore[arg-type]
    return {
        "schema_version": 1,
        "parser": "heuristic-v1",
        "sections": sections,
        "item_count": item_count,
        "unparsed_lines": unparsed_lines,
    }


def save_extracted_text(
    data_root: Path,
    restaurant_id: uuid.UUID,
    import_id: uuid.UUID,
    text: str,
    structured_menu: dict[str, object],
) -> tuple[str, str]:
    target_dir = data_root / "extracted" / str(restaurant_id) / str(import_id)
    target_dir.mkdir(parents=True, exist_ok=True)
    text_path = target_dir / "content.txt"
    structure_path = target_dir / "menu.json"
    text_path.write_text(text, encoding="utf-8")
    structure_path.write_text(
        json.dumps(structured_menu, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return (
        text_path.relative_to(data_root).as_posix(),
        structure_path.relative_to(data_root).as_posix(),
    )
