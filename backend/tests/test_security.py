"""Unit tests for password hashing and verification in app/core/security.py."""
import pytest

from app.core.config import get_settings
from app.core.security import (
    hash_password,
    hash_password_async,
    verify_password,
    verify_password_async,
)


def test_hash_password_default_and_custom_rounds() -> None:
    """hash_password supports custom rounds and defaults to settings.bcrypt_rounds."""
    custom_hash = hash_password("secret_pass", rounds=4)
    assert custom_hash.startswith("$2b$04$")

    settings = get_settings()
    default_hash = hash_password("secret_pass", rounds=None)
    prefix = f"$2b${settings.bcrypt_rounds:02d}$"
    assert default_hash.startswith(prefix)


def test_hash_password_length_boundary_raises_value_error() -> None:
    """Passwords exceeding 72 UTF-8 bytes raise ValueError to prevent truncation."""
    # 72 single-byte characters: valid
    valid_72 = "a" * 72
    hashed = hash_password(valid_72, rounds=4)
    assert verify_password(valid_72, hashed) is True

    # 73 single-byte characters: raises ValueError
    too_long = "a" * 73
    with pytest.raises(ValueError, match="Password cannot exceed 72 bytes"):
        hash_password(too_long, rounds=4)

    # Multi-byte UTF-8 boundary (25 Euro symbols = 75 bytes)
    multibyte_too_long = "\u20ac" * 25
    with pytest.raises(ValueError, match="Password cannot exceed 72 bytes"):
        hash_password(multibyte_too_long, rounds=4)


def test_verify_password_matches() -> None:
    """verify_password returns True for matching plaintext and bcrypt hash."""
    pwd = "CorrectHorseBatteryStaple!"
    hashed = hash_password(pwd, rounds=4)
    assert verify_password(pwd, hashed) is True


def test_verify_password_mismatch() -> None:
    """verify_password returns False for incorrect password."""
    pwd = "CorrectHorseBatteryStaple!"
    hashed = hash_password(pwd, rounds=4)
    assert verify_password("IncorrectPassword123!", hashed) is False


def test_verify_password_exceeds_72_bytes_returns_false() -> None:
    """verify_password returns False without raising when plain exceeds 72 bytes."""
    hashed = hash_password("short", rounds=4)
    assert verify_password("a" * 73, hashed) is False
    assert verify_password("\u20ac" * 25, hashed) is False


def test_verify_password_malformed_and_none_returns_false() -> None:
    """verify_password handles malformed, empty, or non-hash inputs gracefully."""
    assert verify_password("pwd", "not-a-hash") is False
    assert verify_password("pwd", "") is False
    assert verify_password("pwd", "$2b$04$invalid") is False
    assert verify_password("pwd", None) is False  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_security_async_functions() -> None:
    """Async wrappers hash_password_async and verify_password_async execute in threadpool."""
    pwd = "async_security_test"
    hashed = await hash_password_async(pwd, rounds=4)
    assert hashed.startswith("$2b$04$")
    assert await verify_password_async(pwd, hashed) is True
    assert await verify_password_async("wrong", hashed) is False

    # Default rounds with rounds=None
    default_hashed = await hash_password_async(pwd, rounds=None)
    assert await verify_password_async(pwd, default_hashed) is True
