from fastapi import APIRouter

from app.api.routes import auth, health, imports, menu_ai, menus, notifications, restaurants, sites

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(restaurants.router)
api_router.include_router(imports.router)
api_router.include_router(menus.router)
api_router.include_router(menu_ai.router)
api_router.include_router(notifications.router)
api_router.include_router(sites.router)
