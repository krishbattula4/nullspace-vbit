"""Password hashing and verification using bcrypt."""
import asyncio
import re

import bcrypt

from app.core.config import get_settings

# A bcrypt hash is exactly 60 characters: $2b$ + 2-digit cost + $ + 53 chars of salt and digest.
# Some bcrypt builds panic (a BaseException that "except Exception" does not catch) on a
# truncated hash, so the format is checked before the library is called.
_BCRYPT_HASH_RE = re.compile(r"^\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{53}$")


def hash_password(plain: str, rounds: int | None = None) -> str:
    """Hash a plaintext password using bcrypt.

    Raises ValueError if plain exceeds 72 UTF-8 bytes to prevent silent truncation.
    """
    plain_bytes = plain.encode("utf-8")
    if len(plain_bytes) > 72:
        raise ValueError("Password cannot exceed 72 bytes")
    cost = rounds if rounds is not None else get_settings().bcrypt_rounds
    salt = bcrypt.gensalt(rounds=cost)
    hashed = bcrypt.hashpw(plain_bytes, salt)
    return hashed.decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    """Verify a plaintext password against a bcrypt hash.

    Returns False and never raises on a malformed hash or invalid input.
    """
    try:
        plain_bytes = plain.encode("utf-8")
        if len(plain_bytes) > 72:
            return False
        if not _BCRYPT_HASH_RE.match(hashed):
            return False
        return bcrypt.checkpw(plain_bytes, hashed.encode("utf-8"))
    except Exception:
        return False


async def hash_password_async(plain: str, rounds: int | None = None) -> str:
    """Run CPU-bound password hashing in a thread pool."""
    return await asyncio.to_thread(hash_password, plain, rounds)


async def verify_password_async(plain: str, hashed: str) -> bool:
    """Run CPU-bound password verification in a thread pool."""
    return await asyncio.to_thread(verify_password, plain, hashed)
