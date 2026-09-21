import uuid

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Restaurant, RestaurantMember


async def has_restaurant_role(
    session: AsyncSession,
    user_id: uuid.UUID,
    restaurant_id: uuid.UUID,
    allowed_roles: set[str],
) -> bool:
    statement = (
        select(Restaurant.id)
        .outerjoin(
            RestaurantMember,
            (RestaurantMember.restaurant_id == Restaurant.id)
            & (RestaurantMember.user_id == user_id),
        )
        .where(
            Restaurant.id == restaurant_id,
            or_(
                Restaurant.owner_id == user_id,
                RestaurantMember.role.in_(allowed_roles),
            ),
        )
    )
    return await session.scalar(statement) is not None
