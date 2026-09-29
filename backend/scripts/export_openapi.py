"""Export the committed OpenAPI contract from the running FastAPI application code.

Run from backend/: python scripts/export_openapi.py
The exporter imports the app but does not start a server or connect to the database.
"""

import json
from pathlib import Path

from app.main import app


def main() -> None:
    contract = app.openapi()
    contract["servers"] = [
        {
            "url": "https://max.nii-mvus.ru",
            "description": "Публичный адрес приложения и API",
        }
    ]
    target = Path(__file__).resolve().parents[2] / "openapi.json"
    target.write_text(json.dumps(contract, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{target}: {len(contract['paths'])} paths")


if __name__ == "__main__":
    main()
