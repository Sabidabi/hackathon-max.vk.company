from fastapi import APIRouter

from app.api.routes import (
    ai,
    analytics,
    auth,
    bot_settings,
    conversations,
    health,
    imports,
    library,
    me,
    menu_ai,
    menu_versions,
    menus,
    notifications,
    point_items,
    public_menu,
    restaurants,
    sites,
    team,
    venues,
)

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(me.router)
api_router.include_router(restaurants.router)
api_router.include_router(team.router)
api_router.include_router(imports.router)
api_router.include_router(menus.router)
api_router.include_router(public_menu.router)
api_router.include_router(venues.router)
api_router.include_router(library.router)
api_router.include_router(menu_versions.router)
api_router.include_router(point_items.router)
api_router.include_router(menu_ai.router)
api_router.include_router(ai.router)
api_router.include_router(notifications.router)
api_router.include_router(bot_settings.router)
api_router.include_router(conversations.router)
api_router.include_router(sites.router)
api_router.include_router(analytics.router)
