"""User search and discovery endpoints."""
import logging
from typing import Annotated

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas import UserPublic
from app.core.db import get_db
from app.core.deps import get_current_user
from app.models.user import User

router = APIRouter(prefix="/users", tags=["users"])
log = logging.getLogger("nullspace.users")


def _escape_like(val: str) -> str:
    """Escape SQL LIKE wildcards % and _ as well as backslash."""
    return val.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


@router.get(
    "/search",
    status_code=status.HTTP_200_OK,
    response_model=list[UserPublic],
)
async def search_users(
    q: Annotated[str, Query(min_length=2, max_length=32, description="Username prefix query")],
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_db)],
) -> list[User]:
    """Search users by username prefix (case-insensitive).

    - Requires authenticated user
    - Excludes the current user
    - Returns up to 20 users sorted by username
    - Escapes % and _ to treat them as literal characters
    """
    escaped_q = _escape_like(q.lower())
    pattern = f"{escaped_q}%"

    stmt = (
        select(User)
        .where(
            User.user_id != current_user.user_id,
            func.lower(User.username).like(pattern, escape="\\"),
        )
        .order_by(User.username.asc())
        .limit(20)
    )
    result = await session.execute(stmt)
    return list(result.scalars().all())
