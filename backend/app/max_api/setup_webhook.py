import asyncio
import json

from app.config import get_settings
from app.max_api.client import register_max_webhook


async def main() -> None:
    result = await register_max_webhook(get_settings())
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
