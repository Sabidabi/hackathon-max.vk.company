import io
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from PIL import Image
from pydantic import ValidationError

from app import menu_diff
from app.api.routes import menus, sites
from app.api.routes.imports import ApplyReviewPayload, MenuReviewPayload
from app.config import Settings


@pytest.mark.parametrize("name", [" ", "\t\n"])
def test_import_rejects_whitespace_names(name):
    with pytest.raises(ValidationError):
        MenuReviewPayload(
            sections=[{"name": "Кофе", "items": [{"name": name, "price_minor": 100}]}]
        )
    with pytest.raises(ValidationError):
        MenuReviewPayload(
            sections=[{"name": name, "items": [{"name": "Кофе", "price_minor": 100}]}]
        )


def test_writes_require_revision_and_rubles():
    with pytest.raises(ValidationError):
        menus.DraftMenuPayload(sections=[])
    with pytest.raises(ValidationError):
        menus.PublishPayload()
    with pytest.raises(ValidationError):
        ApplyReviewPayload(
            sections=[{"name": "Кофе", "items": [{"name": "Латте", "price_minor": 100}]}]
        )
    with pytest.raises(ValidationError):
        menus.MenuItemPayload(name="Latte", price_minor=100, currency="USD")


async def test_stale_revision_rejected_before_write(monkeypatch):
    monkeypatch.setattr(menus, "require_menu_access", AsyncMock())
    monkeypatch.setattr(
        menus,
        "get_menu_and_draft",
        AsyncMock(
            return_value=(SimpleNamespace(id=uuid.uuid4()), SimpleNamespace(id=uuid.uuid4()))
        ),
    )
    monkeypatch.setattr(menus, "read_version_sections", AsyncMock(return_value=[]))
    writer = AsyncMock()
    monkeypatch.setattr(menus, "write_version_sections", writer)
    # The conflict summary reads the database; its content is covered by integration tests.
    conflict = AsyncMock(side_effect=lambda session, **kwargs: menu_diff.RevisionConflict(
        message=kwargs["message"],
        menu_id=uuid.uuid4(),
        current_revision=kwargs["current_revision"],
        last_publication=None,
        seen_version=kwargs["seen_version"],
        changes=None,
    ))
    monkeypatch.setattr(menu_diff, "revision_conflict", conflict)
    session = AsyncMock()
    with pytest.raises(HTTPException) as error:
        await menus.save_draft_menu(
            uuid.uuid4(),
            menus.DraftMenuPayload(expected_revision="0" * 64, seen_version=3),
            session,
            SimpleNamespace(id=uuid.uuid4()),
        )
    assert error.value.status_code == 409
    assert error.value.detail["code"] == "revision_conflict"
    assert error.value.detail["current_revision"] == menus.menu_revision([])
    assert error.value.detail["seen_version"] == 3
    writer.assert_not_awaited()
    session.commit.assert_not_awaited()


async def test_no_access_to_other_restaurant():
    session = AsyncMock()
    session.scalar.return_value = None
    with pytest.raises(HTTPException) as error:
        await menus.require_menu_access(session, SimpleNamespace(id=uuid.uuid4()), uuid.uuid4())
    assert error.value.status_code == 404


async def test_qr_encodes_guest_link_and_requires_publication(monkeypatch):
    restaurant_id = uuid.uuid4()
    guest_url = "https://menu.example/r/cafe123"
    monkeypatch.setattr(
        menus,
        "get_menu_links",
        AsyncMock(
            return_value=menus.MenuLinksResponse(public_menu_url=guest_url, max_deep_link=None)
        ),
    )
    published = AsyncMock(return_value=False)
    monkeypatch.setattr(menus, "point_has_published_menu", published)
    with pytest.raises(HTTPException) as error:
        await menus.get_menu_qr(restaurant_id, AsyncMock(), SimpleNamespace(), Settings())
    assert error.value.status_code == 409
    published.return_value = True
    captured = []
    original = menus.qrcode.QRCode.add_data

    def capture(self, data, *args, **kwargs):
        captured.append(data)
        return original(self, data, *args, **kwargs)

    monkeypatch.setattr(menus.qrcode.QRCode, "add_data", capture)
    response = await menus.get_menu_qr(restaurant_id, AsyncMock(), SimpleNamespace(), Settings())
    assert captured == [guest_url]
    image = Image.open(io.BytesIO(response.body))
    assert image.format == "PNG" and image.width == image.height and image.width >= 300
    assert response.headers["cache-control"] == "private, no-store"
    with pytest.raises(HTTPException) as error:
        await menus.get_menu_qr(restaurant_id, AsyncMock(), SimpleNamespace(), Settings(), "max")
    assert error.value.status_code == 409


def test_site_revision_rejects_stale_configuration():
    revision = sites.site_revision({})
    sites.check_site_revision(None, revision)
    with pytest.raises(HTTPException) as error:
        sites.check_site_revision(SimpleNamespace(draft_config={"hours": "09:00–20:00"}), revision)
    assert error.value.status_code == 409


async def test_non_admin_cannot_publish():
    session = AsyncMock()
    session.scalar.return_value = None  # no restaurant_members row for this user
    with pytest.raises(HTTPException) as error:
        await menus.publish_menu(
            uuid.uuid4(),
            menus.PublishPayload(expected_revision="0" * 64),
            session,
            SimpleNamespace(id=uuid.uuid4()),
        )
    assert error.value.status_code == 404
    session.commit.assert_not_awaited()


async def test_cannot_publish_menu_with_every_item_unavailable(monkeypatch):
    sections = [
        menus.MenuSectionResponse(
            id=uuid.uuid4(),
            name="Кофе",
            items=[
                menus.MenuItemResponse(
                    id=uuid.uuid4(), name="Латте", price_minor=12990, is_available=False
                )
            ],
        )
    ]
    monkeypatch.setattr(menus, "require_menu_access", AsyncMock())
    monkeypatch.setattr(
        menus,
        "get_menu_and_draft",
        AsyncMock(return_value=(SimpleNamespace(), SimpleNamespace(id=uuid.uuid4()))),
    )
    monkeypatch.setattr(menus, "read_version_sections", AsyncMock(return_value=sections))
    session = AsyncMock()
    session.scalar.return_value = SimpleNamespace(id=uuid.uuid4())
    with pytest.raises(HTTPException) as error:
        await menus.publish_menu(
            uuid.uuid4(),
            menus.PublishPayload(expected_revision=menus.menu_revision(sections)),
            session,
            SimpleNamespace(id=uuid.uuid4()),
        )
    assert error.value.status_code == 409
    session.commit.assert_not_awaited()


async def test_site_cannot_use_another_points_image(monkeypatch):
    monkeypatch.setattr(sites, "require_site_access", AsyncMock())
    monkeypatch.setattr(sites, "get_site", AsyncMock(return_value=None))
    session = AsyncMock()
    payload = sites.SiteDraftPayload(
        expected_revision=sites.site_revision({}),
        logo_url=f"/media/sites/{uuid.uuid4()}/{uuid.uuid4().hex}.webp",
    )
    with pytest.raises(HTTPException) as error:
        await sites.save_site_draft(
            uuid.uuid4(), payload, session, SimpleNamespace(id=uuid.uuid4())
        )
    assert error.value.status_code == 422
    session.commit.assert_not_awaited()
