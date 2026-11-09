"""Authentication endpoints: registration, login, token refresh and logout."""
import logging
import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from jose import jwt
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas import (
    LoginRequest,
    LogoutRequest,
    RefreshRequest,
    RegisterRequest,
    TokenResponse,
    UserPublic,
)
from app.core.config import get_settings
from app.core.db import get_db
from app.core.security import hash_password, hash_password_async, verify_password_async
from app.core.tokens import (
    TokenExpired,
    TokenInvalid,
    create_access_token,
    create_refresh_token,
    decode_token,
)
from app.models.refresh_token import RefreshToken
from app.models.user import User

router = APIRouter(prefix="/auth", tags=["auth"])
log = logging.getLogger("nullspace.auth")

_DUMMY_PASSWORD_HASH: str | None = None


def _get_dummy_password_hash() -> str:
    """Return a precomputed bcrypt hash for constant-time dummy password checks."""
    global _DUMMY_PASSWORD_HASH
    if _DUMMY_PASSWORD_HASH is None:
        _DUMMY_PASSWORD_HASH = hash_password("dummy_password_for_timing_mitigation")
    return _DUMMY_PASSWORD_HASH


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


@router.post(
    "/login",
    status_code=status.HTTP_200_OK,
    response_model=TokenResponse,
)
async def login(
    request: LoginRequest,
    session: Annotated[AsyncSession, Depends(get_db)],
) -> TokenResponse:
    """Authenticate with username and password, returning access and refresh JWTs."""
    settings = get_settings()
    stmt = select(User).where(User.username == request.username)
    result = await session.execute(stmt)
    user = result.scalar_one_or_none()

    if user is None:
        # Constant-time dummy verification to mitigate username enumeration
        await verify_password_async(request.password, _get_dummy_password_hash())
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid_credentials",
        )

    valid = await verify_password_async(request.password, user.password_hash)
    if not valid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid_credentials",
        )

    access_token = create_access_token(user.user_id)
    refresh_token, jti, expires_at = create_refresh_token(user.user_id)

    rt = RefreshToken(
        jti=jti,
        user_id=user.user_id,
        expires_at=expires_at,
    )
    session.add(rt)
    await session.commit()

    log.info("user logged in: user_id=%s", user.user_id)
    return TokenResponse(
        access_token=access_token,
        refresh_token=refresh_token,
        token_type="bearer",
        expires_in=settings.jwt_access_minutes * 60,
    )


@router.post(
    "/refresh",
    status_code=status.HTTP_200_OK,
    response_model=TokenResponse,
)
async def refresh(
    request: RefreshRequest,
    session: Annotated[AsyncSession, Depends(get_db)],
) -> TokenResponse:
    """Rotate an existing single-use refresh token and return a new access/refresh pair."""
    settings = get_settings()
    try:
        claims = decode_token(request.refresh_token, expected_type="refresh")
    except TokenExpired as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="token_expired",
        ) from exc
    except TokenInvalid as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid_token",
        ) from exc

    try:
        jti = uuid.UUID(claims["jti"])
        user_id = uuid.UUID(claims["sub"])
    except (KeyError, ValueError, TypeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid_token",
        ) from exc

    now = datetime.now(UTC)
    # Atomically revoke presented refresh token
    stmt = (
        update(RefreshToken)
        .where(
            RefreshToken.jti == jti,
            RefreshToken.revoked_at.is_(None),
            RefreshToken.expires_at > now,
        )
        .values(revoked_at=now)
    )
    res = await session.execute(stmt)

    if res.rowcount == 1:
        new_access_token = create_access_token(user_id)
        new_refresh_token, new_jti, new_expires_at = create_refresh_token(user_id)

        new_rt = RefreshToken(
            jti=new_jti,
            user_id=user_id,
            expires_at=new_expires_at,
        )
        session.add(new_rt)

        await session.execute(
            update(RefreshToken)
            .where(RefreshToken.jti == jti)
            .values(replaced_by_jti=new_jti)
        )
        await session.commit()

        log.info("token refreshed: user_id=%s", user_id)
        return TokenResponse(
            access_token=new_access_token,
            refresh_token=new_refresh_token,
            token_type="bearer",
            expires_in=settings.jwt_access_minutes * 60,
        )

    # rowcount == 0: lookup row to diagnose reason
    lookup_stmt = select(RefreshToken).where(RefreshToken.jti == jti)
    lookup_res = await session.execute(lookup_stmt)
    row = lookup_res.scalar_one_or_none()

    if row is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid_token",
        )

    if row.revoked_at is not None:
        # Token reuse detected! Revoke all tokens for this user
        await session.execute(
            update(RefreshToken)
            .where(
                RefreshToken.user_id == row.user_id,
                RefreshToken.revoked_at.is_(None),
            )
            .values(revoked_at=now)
        )
        await session.commit()
        log.warning("refresh reuse detected: user_id=%s", row.user_id)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="refresh_reuse_detected",
        )

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="token_expired",
    )


@router.post(
    "/logout",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def logout(
    request: LogoutRequest,
    session: Annotated[AsyncSession, Depends(get_db)],
) -> Response:
    """Revoke a refresh token.

    Idempotent: returns 204 even if invalid, expired, or already revoked.
    """
    try:
        claims = jwt.decode(
            request.refresh_token,
            get_settings().jwt_secret,
            algorithms=["HS256"],
            options={"verify_exp": False, "verify_signature": True},
        )
        jti_raw = claims.get("jti")
        if jti_raw:
            jti = uuid.UUID(str(jti_raw))
            now = datetime.now(UTC)
            stmt = (
                update(RefreshToken)
                .where(
                    RefreshToken.jti == jti,
                    RefreshToken.revoked_at.is_(None),
                )
                .values(revoked_at=now)
            )
            await session.execute(stmt)
            await session.commit()
            log.info("token revoked on logout")
    except Exception:
        # Idempotent: garbage, expired, or malformed tokens still return 204
        pass

    return Response(status_code=status.HTTP_204_NO_CONTENT)
