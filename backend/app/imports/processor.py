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
PRICE_ONLY_PATTERN = re.compile(
    r"^(?:\d{1,3}(?:\s\d{3})*|\d{1,6})(?:[.,]\d{1,2})?\s*(?:₽|руб(?:\.|лей)?|р\.)?$",
    re.IGNORECASE,
)
WEIGHT_PATTERN = re.compile(
    r"(?<![\w/])(?P<weight>\d+(?:[.,]\d+)?(?:\s*/\s*\d+(?:[.,]\d+)?)*\s*(?:г|гр|мл|л|шт)\.?)"
    r"(?![\w])",
    re.IGNORECASE,
)
NAME_SEPARATORS = (" — ", " – ", " - ", ". ", ": ")
MAX_NAME_WORDS = 6
MAX_NAME_CHARS = 60
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


def extract_weight(text: str) -> tuple[str, str | None]:
    """A weight or volume («150 г», «250 мл», «250/350 мл») is neither a name nor a description."""
    matches = list(WEIGHT_PATTERN.finditer(text))
    if not matches:
        return text, None
    match = matches[-1]
    rest = (text[: match.start()] + " " + text[match.end():]).strip(" ,;·-–—")
    return re.sub(r"\s+", " ", rest), re.sub(r"\s+", " ", match.group("weight")).strip()


def split_name_description(text: str) -> tuple[str, str | None]:
    """One line «Название — описание» / «Название. Описание» → (name, description).

    A long line without a separator is split at the first comma: the words before it are
    the name. A short name stays as it is."""
    text = re.sub(r"\s+", " ", text).strip()
    found: list[tuple[int, str]] = []
    for separator in NAME_SEPARATORS:
        at = text.find(separator)
        if at > 0:
            found.append((at, separator))
    for at, separator in sorted(found):
        left, right = text[:at].strip(), text[at + len(separator):].strip()
        left_words = left.split()
        if not left_words or len(left_words) > MAX_NAME_WORDS:
            continue
        if len(right.split()) < 2 and "," not in right:
            continue
        if separator == ". " and len(left_words[-1]) <= 2:
            continue  # «0,5 л. » and other abbreviations
        return left.strip(" .·-–—:"), right
    words = text.split()
    if (len(words) > MAX_NAME_WORDS or len(text) > MAX_NAME_CHARS) and "," in text:
        head, _, tail = text.partition(",")
        if 1 <= len(head.split()) <= MAX_NAME_WORDS and tail.strip():
            return head.strip(), tail.strip()
    return text, None


def continues(previous: str, following: str) -> bool:
    """The following line is the rest of the name: the previous one is unfinished."""
    previous = previous.rstrip()
    if previous.endswith((",", "-", "–", "—")):
        return True
    last = re.findall(r"[^\W\d_]+", previous)
    if last and len(last[-1]) <= 2:
        return True  # ends with a preposition or a conjunction
    return previous.count("«") > previous.count("»") or previous.count("(") > previous.count(")")


def split_lines(lines: list[str]) -> tuple[str, str | None]:
    """Lines before a price: the first (with its unfinished continuations) is the name,
    the rest is the description."""
    end = 1
    while end < len(lines) and continues(lines[end - 1], lines[end]):
        end += 1
    name = " ".join(lines[:end])
    description = " ".join(lines[end:]) or None
    if end == 1 and description is None:
        return split_name_description(name)
    return name, description


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
    description: str | None = None,
) -> dict[str, object]:
    if current_section is None:
        current_section = {"name": "Меню", "sort_order": 0, "items": []}
        sections.append(current_section)
    items = current_section["items"]
    assert isinstance(items, list)
    item: dict[str, object] = {
        "name": name.strip(" .·-–—"),
        "price_minor": price_minor,
        "currency": "RUB",
        "weight_text": weight_text,
        "sort_order": len(items),
        "source_line": source_line,
        "source_confidence": 0.75,
    }
    if description:
        item["description"] = description
    items.append(item)
    return current_section


def describe_item(item: dict[str, object] | None, lines: list[str]) -> bool:
    """Lines after «название … цена» without a price are that item's description."""
    if item is None or not lines:
        return False
    text = " ".join(lines)
    existing = item.get("description")
    item["description"] = f"{existing} {text}" if existing else text
    return True


def name_parts(
    lines: list[str], weight: str | None = None
) -> tuple[str, str | None, str | None]:
    """Lines before a price → (name, description, weight): no price, weight or volume
    stays in the name or the description."""
    name, description = split_lines(lines)
    name, name_weight = extract_weight(name)
    if description:
        description, description_weight = extract_weight(description)
        description = description or None
    else:
        description_weight = None
    return name, description, weight or name_weight or description_weight


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
    last_item: dict[str, object] | None = None  # the item that may get a description

    def flush_pending() -> None:
        nonlocal pending_name_lines
        if pending_name_lines and not describe_item(last_item, pending_name_lines):
            unparsed_lines.append(" ".join(pending_name_lines))
        pending_name_lines = []

    def newest(section: dict[str, object] | None) -> dict[str, object] | None:
        if section is None:
            return None
        items = section["items"]
        assert isinstance(items, list)
        return items[-1] if items else None

    for line, columns in line_entries:
        parsed_price = parse_price(line)
        weight_price = WEIGHT_PRICE_PATTERN.match(line)
        if parsed_price is None and weight_price is None and looks_like_heading(line):
            flush_pending()
            last_item = None
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
            last_item = None
            continue

        if weight_price is not None:
            if not pending_name_lines:
                unparsed_lines.append(line)
                continue
            name, description, weight = name_parts(
                pending_name_lines, re.sub(r"\s+", " ", weight_price.group("weight")).strip()
            )
            source_name = " ".join(pending_name_lines)
            pending_name_lines = []
            pending_name_columns = None
            price_minor = int(Decimal(weight_price.group("price").replace(" ", "")) * 100)
            current_section = add_item(
                sections, current_section, name, price_minor, f"{source_name} {line}",
                weight, description,
            )
            last_item = newest(current_section)
            continue

        if PRICE_ONLY_PATTERN.match(line) and pending_name_lines:
            # «Название» / «описание» / «290» on separate lines.
            name, description, weight = name_parts(pending_name_lines)
            source_name = " ".join(pending_name_lines)
            pending_name_lines = []
            pending_name_columns = None
            amount = Decimal(re.sub(r"[^\d.,]", "", line).replace(",", "."))
            current_section = add_item(
                sections, current_section, name, int(amount * 100), f"{source_name} {line}",
                weight, description,
            )
            last_item = newest(current_section)
            continue

        if parsed_price is not None:
            name, price_minor = parsed_price
            # Finished lines after the previous item are its description; an unfinished
            # line («…, » / «…с») is the beginning of this name.
            if (
                pending_name_lines
                and last_item is not None
                and not continues(pending_name_lines[-1], name)
            ):
                describe_item(last_item, pending_name_lines)
                pending_name_lines = []
            if pending_name_lines:  # a name wrapped over lines stays one name
                name, weight = extract_weight(" ".join([*pending_name_lines, name]))
                description = None
            else:
                name, description, weight = name_parts([name])
            pending_name_lines = []
            pending_name_columns = None
            current_section = add_item(
                sections, current_section, name, price_minor, line, weight, description,
            )
            last_item = newest(current_section)
            continue

        pending_name_lines.append(line)
        pending_name_columns = columns if len(columns) > 1 else None

    flush_pending()

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
