import asyncio
import json

from app.config import get_settings
from app.max_api.client import register_bot_commands, register_max_webhook


async def main() -> None:
    """Subscribe the webhook and publish the command list (/start, /my, /settings, …)."""
    settings = get_settings()
    result = await register_max_webhook(settings)
    commands = await register_bot_commands(settings)
    print(json.dumps(
        {"subscription": result, "commands": commands.get("commands", [])},
        ensure_ascii=False,
        indent=2,
    ))


if __name__ == "__main__":
    asyncio.run(main())
