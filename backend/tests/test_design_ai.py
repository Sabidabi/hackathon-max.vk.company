import pytest

from app.ai.mock import MockAIProvider
from app.ai.provider import parse_answer
from app.ai.tasks import DesignPlanAnswer, design_plan_task
from app.sites.design_plan import DESIGN_OPTIONS, DesignChangePlan, DesignPatch
from app.sites.schemas import SiteConfig


def test_design_patch_fields_are_optional_and_strict() -> None:
    patch = DesignPatch.model_validate({"menu_layout": "list"})

    assert patch.changes() == {"menu_layout": "list"}
    with pytest.raises(ValueError):
        DesignPatch.model_validate({"menu_layout": "masonry"})
    with pytest.raises(ValueError):
        DesignPatch.model_validate({"logo_url": "/media/sites/x/y.webp"})
    with pytest.raises(ValueError):
        DesignPatch.model_validate({"primary_color": "red"})
    assert DesignChangePlan(summary="Тёмная тема", patch=patch).patch is patch


@pytest.mark.asyncio
async def test_mock_design_plan_understands_plain_words() -> None:
    task = design_plan_task(
        "Сделай тёмную тему, плитки списком и шрифт с засечками, углы круглые",
        current={},
        options=DESIGN_OPTIONS,
    )
    answer = parse_answer(task, await MockAIProvider().complete(task))

    assert isinstance(answer, DesignPlanAnswer)
    assert answer.patch.changes() == {
        "theme_mode": "dark",
        "menu_layout": "list",
        "heading_font": "serif",
        "card_radius": "round",
    }
    # The patch always produces a valid site config.
    merged = SiteConfig.model_validate(
        {**SiteConfig().model_dump(mode="json"), **answer.patch.changes()}
    )
    assert merged.menu_layout == "list"


@pytest.mark.asyncio
async def test_mock_design_plan_without_understood_words_changes_nothing() -> None:
    task = design_plan_task("Сделай красиво", current={}, options=DESIGN_OPTIONS)
    answer = parse_answer(task, await MockAIProvider().complete(task))

    assert isinstance(answer, DesignPlanAnswer)
    assert answer.patch.changes() == {}
