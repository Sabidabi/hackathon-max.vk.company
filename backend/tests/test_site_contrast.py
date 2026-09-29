from app.sites.contrast import contrast_issues, contrast_ratio
from app.sites.schemas import SiteConfig


def test_contrast_ratio_matches_wcag() -> None:
    assert round(contrast_ratio("#000000", "#FFFFFF"), 1) == 21.0
    assert contrast_ratio("#777777", "#FFFFFF") < 4.5


def test_default_theme_is_readable() -> None:
    assert contrast_issues(SiteConfig()) == []


def test_unreadable_pairs_are_reported() -> None:
    config = SiteConfig(text_color="#DDDDDD", surface_color="#FFFFFF", primary_color="#FFEEEE")
    pairs = {issue.pair for issue in contrast_issues(config)}
    assert {"text_surface", "accent_surface"} <= pairs
