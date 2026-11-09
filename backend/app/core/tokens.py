"""JWT token creation, validation and decoding utilities."""
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from jose import ExpiredSignatureError, JWTError, jwt

from app.core.config import get_settings

ALGORITHM = "HS256"


class TokenError(Exception):
    """Base exception for all token-related errors."""


class TokenExpired(TokenError):
    """Raised when a JWT has expired."""


class TokenInvalid(TokenError):
    """Raised when a JWT is invalid (bad signature, wrong type, malformed, missing claims)."""


def create_access_token(
    user_id: uuid.UUID | str,
    expires_delta: timedelta | None = None,
) -> str:
    """Create a signed HS256 access JWT."""
    settings = get_settings()
    now = datetime.now(UTC)
    delta = (
        expires_delta
        if expires_delta is not None
        else timedelta(minutes=settings.jwt_access_minutes)
    )
    exp = now + delta
    claims: dict[str, Any] = {
        "sub": str(user_id),
        "type": "access",
        "jti": str(uuid.uuid4()),
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    return jwt.encode(claims, settings.jwt_secret, algorithm=ALGORITHM)


def create_refresh_token(
    user_id: uuid.UUID | str,
    expires_delta: timedelta | None = None,
) -> tuple[str, uuid.UUID, datetime]:
    """Create a signed HS256 refresh JWT returning (token, jti, expires_at)."""
    settings = get_settings()
    now = datetime.now(UTC)
    delta = (
        expires_delta
        if expires_delta is not None
        else timedelta(days=settings.jwt_refresh_days)
    )
    exp = now + delta
    jti = uuid.uuid4()
    claims: dict[str, Any] = {
        "sub": str(user_id),
        "type": "refresh",
        "jti": str(jti),
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    token = jwt.encode(claims, settings.jwt_secret, algorithm=ALGORITHM)
    return token, jti, exp


def decode_token(token: str, expected_type: str) -> dict[str, Any]:
    """Decode and validate a JWT, enforcing algorithms=['HS256'] and expected type."""
    settings = get_settings()
    try:
        claims = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=[ALGORITHM],
            options={
                "verify_signature": True,
                "verify_exp": True,
                "require_exp": True,
                "require_sub": True,
            },
        )
    except ExpiredSignatureError as exc:
        raise TokenExpired("Token has expired") from exc
    except JWTError as exc:
        raise TokenInvalid(f"Invalid token: {exc}") from exc
    except Exception as exc:
        raise TokenInvalid(f"Invalid token: {exc}") from exc

    if not claims.get("sub"):
        raise TokenInvalid("Token missing required claim 'sub'")

    if not claims.get("exp"):
        raise TokenInvalid("Token missing required claim 'exp'")

    if not claims.get("jti"):
        raise TokenInvalid("Token missing required claim 'jti'")

    actual_type = claims.get("type")
    if actual_type != expected_type:
        raise TokenInvalid(f"Expected token type '{expected_type}', got '{actual_type}'")

    return claims
