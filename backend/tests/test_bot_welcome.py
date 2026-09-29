from app.bot.commands import WELCOME_TEXT, welcome_text


def test_welcome_greets_by_name_and_points_to_the_app() -> None:
    text = welcome_text("Анна")

    assert text.startswith("Привет, Анна!")
    assert "Открыть Синицу" in text
    assert len(text) < 1000


def test_welcome_without_name_and_with_hostile_name() -> None:
    assert welcome_text("").startswith("Привет! ")
    assert WELCOME_TEXT == welcome_text()
    # Whitespace is collapsed and a long name is cut, so the message never breaks.
    long_name = "А" * 200
    assert welcome_text(f"  {long_name}\n\n").count("А") <= 40 + welcome_text().count("А")
