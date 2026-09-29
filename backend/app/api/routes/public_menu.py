"""Guest menu of a point (``/r/:public_id``) and the server-side price quote.

A point shows every assigned live menu with a published version as a tab, in the
assigned order, and a menu with show hours only during those local hours. The point's
stop-list and own prices are applied to the snapshot and to the quote alike.
"""

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.service import ai_status
from app.api.routes.menus import MenuSectionResponse, is_published_site
from app.config import Settings, get_settings
from app.database import get_session
from app.demo_data import DEMO_PARK_PUBLIC_ID, DEMO_PUBLIC_ID
from app.menu_configuration import QuotePayload, calculate_unit_price
from app.menu_library import active_tabs
from app.models import Restaurant, RestaurantSite, Venue
from app.sites.schemas import SiteConfig, default_site_config

router = APIRouter(tags=["menus"])
DEMO_PUBLIC_IDS = frozenset({DEMO_PUBLIC_ID, DEMO_PARK_PUBLIC_ID})


class PublicRestaurantResponse(BaseModel):
    public_id: str
    name: str
    description: str | None
    address: str | None
    venue_name: str
    timezone: str
    # Seeded demo venue: the guest page shows a «Демо» mark (demo data is labelled).
    is_demo: bool = False


class PublicMenuTab(BaseModel):
    menu_id: uuid.UUID
    title: str
    version: int
    published_at: datetime | None
    sections: list[MenuSectionResponse]


class PublicAssistant(BaseModel):
    """«Синица, что взять?»: whether the AI answers now (else picks without AI)."""

    available: bool
    provider: str | None = None


class PublicMenuResponse(BaseModel):
    restaurant: PublicRestaurantResponse
    site: SiteConfig
    # First visible tab, kept for clients that show one menu.
    version: int | None
    published_at: datetime | None
    sections: list[MenuSectionResponse]
    # Every menu the point shows right now, in tab order.
    menus: list[PublicMenuTab]
    assistant: PublicAssistant = PublicAssistant(available=False)


@router.get("/public/restaurants/{public_id}/menu", response_model=PublicMenuResponse)
async def get_public_menu(
    public_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> PublicMenuResponse:
    row = (await session.execute(
        select(Restaurant, Venue.name)
        .join(Venue, Venue.id == Restaurant.venue_id)
        .where(Restaurant.public_id == public_id)
    )).one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Menu not found")
    restaurant, venue_name = row
    site = await session.get(RestaurantSite, restaurant.id)
    has_published_site = is_published_site(site)
    tabs, has_published_menu = await active_tabs(session, restaurant.id, restaurant.timezone)
    if not has_published_site and not has_published_menu:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Site not published")

    site_config = (
        site.published_config if has_published_site and site is not None else default_site_config()
    )
    first = tabs[0] if tabs else None
    return PublicMenuResponse(
        restaurant=PublicRestaurantResponse(
            public_id=restaurant.public_id,
            name=restaurant.name,
            description=restaurant.description,
            address=restaurant.address,
            venue_name=venue_name,
            timezone=restaurant.timezone,
            is_demo=restaurant.public_id in DEMO_PUBLIC_IDS,
        ),
        site=SiteConfig.model_validate(site_config),
        version=first.version.version if first else None,
        published_at=(
            first.version.published_at
            if first
            else site.published_at
            if site is not None
            else None
        ),
        sections=first.sections if first else [],
        menus=[
            PublicMenuTab(
                menu_id=tab.menu.id,
                title=tab.menu.title,
                version=tab.version.version,
                published_at=tab.version.published_at,
                sections=tab.sections,
            )
            for tab in tabs
        ],
        assistant=PublicAssistant(
            available=ai_status(settings)[0], provider=ai_status(settings)[1]
        ),
    )


@router.post("/public/restaurants/{public_id}/menu/quote")
async def quote_menu_item(
    public_id: str, payload: QuotePayload, session: Annotated[AsyncSession, Depends(get_session)]
) -> dict:
    restaurant = await session.scalar(select(Restaurant).where(Restaurant.public_id == public_id))
    if restaurant is None:
        raise HTTPException(status_code=404, detail="Меню не найдено")
    tabs, has_published_menu = await active_tabs(session, restaurant.id, restaurant.timezone)
    if not has_published_menu:
        raise HTTPException(status_code=404, detail="Меню не опубликовано")
    found = next((
        (tab, item)
        for tab in tabs for section in tab.sections for item in section.items
        if item.id == payload.item_id
    ), None)
    if found is None or not found[1].is_available:
        raise HTTPException(status_code=409, detail="Позиция недоступна или меню обновилось")
    tab, item = found
    try:
        unit_price = calculate_unit_price(item.price_minor, item.configuration, payload)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return {
        "unit_price_minor": unit_price,
        "total_price_minor": unit_price * payload.quantity,
        "quantity": payload.quantity,
        "currency": "RUB",
        "published_version_id": str(tab.version.id),
        "menu_id": str(tab.menu.id),
    }
