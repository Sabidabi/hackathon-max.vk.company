from tempfile import NamedTemporaryFile
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.database import get_session

router = APIRouter(prefix="/health", tags=["health"])


class HealthResponse(BaseModel):
    status: str
    service: str


@router.get("/live", response_model=HealthResponse)
async def liveness(
    settings: Annotated[Settings, Depends(get_settings)],
) -> HealthResponse:
    return HealthResponse(status="ok", service=settings.app_name)


@router.get("/ready", response_model=HealthResponse)
async def readiness(
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> HealthResponse:
    try:
        await session.execute(text("SELECT 1"))
        with NamedTemporaryFile(dir=settings.data_root) as probe:
            probe.write(b"ok")
            probe.flush()
    except Exception as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Service dependencies are not ready",
        ) from error

    return HealthResponse(status="ready", service=settings.app_name)
