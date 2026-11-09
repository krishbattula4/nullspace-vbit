"""Authentication endpoints."""
import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas import RegisterRequest, UserPublic
from app.core.db import get_db
from app.core.security import hash_password_async
from app.models.user import User

router = APIRouter(prefix="/auth", tags=["auth"])
log = logging.getLogger("nullspace.auth")


@router.post(
    "/register",
    status_code=status.HTTP_201_CREATED,
    response_model=UserPublic,
)
async def register(
    request: RegisterRequest,
    session: Annotated[AsyncSession, Depends(get_db)],
) -> User:
    """Register a new user account."""
    stmt = select(User).where(User.username == request.username)
    result = await session.execute(stmt)
    if result.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="username_taken",
        )

    password_hash = await hash_password_async(request.password)

    user = User(
        username=request.username,
        password_hash=password_hash,
        display_name=request.display_name,
    )
    session.add(user)

    try:
        await session.commit()
        await session.refresh(user)
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="username_taken",
        ) from exc

    log.info("user registered: user_id=%s", user.user_id)
    return user
