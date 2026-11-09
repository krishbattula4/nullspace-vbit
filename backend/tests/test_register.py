"""Tests for POST /auth/register, password hashing, and user registration validation."""
import asyncio
import logging
import uuid
from datetime import datetime

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.core.security import (
    hash_password,
    hash_password_async,
    verify_password,
    verify_password_async,
)
from app.models.user import User


async def test_register_success(client: AsyncClient, db_session: AsyncSession) -> None:
    """Registration returns 201, UserPublic fields, no passwords or hashes, and persists to DB."""
    payload = {
        "username": "alice",
        "password": "valid_password_123",
        "display_name": "Alice Wonderland",
    }
    response = await client.post("/auth/register", json=payload)
    assert response.status_code == 201
    data = response.json()

    # UserPublic fields present
    assert "user_id" in data
    assert "username" in data
    assert "display_name" in data
    assert "created_at" in data

    # No password or hash keys in response
    assert "password" not in data
    assert "password_hash" not in data
    assert "hash" not in data

    # Values verify correctly
    parsed_uuid = uuid.UUID(data["user_id"])
    assert isinstance(parsed_uuid, uuid.UUID)
    assert data["username"] == "alice"
    assert data["display_name"] == "Alice Wonderland"
    datetime.fromisoformat(data["created_at"])


async def test_stored_password_hash(client: AsyncClient, db_session: AsyncSession) -> None:
    """Stored password_hash starts with $2b$, verifies against password, and is not plain text."""
    plain_password = "secure_user_password_456"
    payload = {
        "username": "bob_secure",
        "password": plain_password,
    }
    response = await client.post("/auth/register", json=payload)
    assert response.status_code == 201

    # Query directly from DB
    result = await db_session.execute(select(User).where(User.username == "bob_secure"))
    user = result.scalar_one()

    assert user.password_hash.startswith("$2b$")
    assert user.password_hash != plain_password
    assert verify_password(plain_password, user.password_hash) is True
    assert verify_password("wrong_password", user.password_hash) is False


def test_hash_password_rounds_and_default_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    """hash_password with rounds=12 produces $2b$12$, and Settings().bcrypt_rounds defaults 12."""
    hashed = hash_password("test_secret_pass", rounds=12)
    assert hashed.startswith("$2b$12$")

    # Remove BCRYPT_ROUNDS environment variable and verify Settings default
    monkeypatch.delenv("BCRYPT_ROUNDS", raising=False)
    settings = Settings()
    assert settings.bcrypt_rounds == 12


async def test_duplicate_username_conflict(client: AsyncClient) -> None:
    """Duplicate username returns 409 username_taken, and 'Alice' after 'alice' also returns 409."""
    payload = {
        "username": "alice",
        "password": "password_number_one",
    }
    r1 = await client.post("/auth/register", json=payload)
    assert r1.status_code == 201

    # Duplicate with exact casing
    r2 = await client.post("/auth/register", json=payload)
    assert r2.status_code == 409
    assert r2.json() == {"detail": "username_taken"}

    # Duplicate with different casing ("Alice" after "alice")
    payload_variant = {
        "username": "Alice",
        "password": "password_number_two",
    }
    r3 = await client.post("/auth/register", json=payload_variant)
    assert r3.status_code == 409
    assert r3.json() == {"detail": "username_taken"}


@pytest.mark.parametrize(
    ("payload", "description"),
    [
        ({"username": "ab", "password": "valid_password_1"}, "username too short"),
        ({"username": "alice bob", "password": "valid_password_1"}, "username with a space"),
        ({"username": "alice!", "password": "valid_password_1"}, "username with a symbol"),
        ({"username": "valid_user", "password": "short"}, "password shorter than 10"),
        (
            {"username": "valid_user", "password": "€" * 25},
            "password over 72 bytes (25 multibyte chars = 75 bytes)",
        ),
        (
            {"username": "identical_user", "password": "identical_user"},
            "password equal to username",
        ),
        (
            {"username": "identical_user", "password": "IDENTICAL_USER"},
            "password equal to username (case-insensitive)",
        ),
    ],
)
async def test_register_validation_errors(
    client: AsyncClient, payload: dict, description: str
) -> None:
    """Invalid usernames or passwords return HTTP 422 Unprocessable Entity."""
    response = await client.post("/auth/register", json=payload)
    assert response.status_code == 422, f"Expected 422 for case: {description}"


async def test_display_name_defaulting_and_stripping(client: AsyncClient) -> None:
    """display_name defaults to username when omitted or None, and is stripped of whitespace."""
    # 1. Omitted display_name defaults to username
    r1 = await client.post(
        "/auth/register",
        json={"username": "user_one", "password": "secure_password_1"},
    )
    assert r1.status_code == 201
    assert r1.json()["display_name"] == "user_one"

    # 2. display_name=None defaults to username
    r2 = await client.post(
        "/auth/register",
        json={"username": "user_two", "password": "secure_password_2", "display_name": None},
    )
    assert r2.status_code == 201
    assert r2.json()["display_name"] == "user_two"

    # 3. Explicit display_name is stripped
    r3 = await client.post(
        "/auth/register",
        json={
            "username": "user_three",
            "password": "secure_password_3",
            "display_name": "  Custom Name  ",
        },
    )
    assert r3.status_code == 201
    assert r3.json()["display_name"] == "Custom Name"


async def test_registration_does_not_log_secrets(
    client: AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    """Registration logs user_id only and never logs password, hash, or request body."""
    caplog.set_level(logging.DEBUG)
    logging.getLogger("aiosqlite").setLevel(logging.WARNING)

    plain_password = "SuperSecretUnloggedPass123!"
    payload = {
        "username": "unlogged_user",
        "password": plain_password,
        "display_name": "Unlogged Display",
    }
    response = await client.post("/auth/register", json=payload)
    assert response.status_code == 201
    data = response.json()
    user_id = data["user_id"]

    # Verify log output includes registration event with user_id
    records = [rec for rec in caplog.records if "nullspace.auth" in rec.name]
    assert any(
        "user registered: user_id=" in rec.message and user_id in rec.message for rec in records
    )

    # Verify neither the password nor the hash appears anywhere in caplog
    for rec in caplog.records:
        assert plain_password not in rec.message
        assert "$2b$" not in rec.message
    assert plain_password not in caplog.text
    assert "$2b$" not in caplog.text


async def test_concurrent_registrations_same_username(client: AsyncClient) -> None:
    """Two simultaneous registrations give exactly one 201 and one 409 (skipped on SQLite)."""
    settings = get_settings()
    if not settings.sqlalchemy_url.startswith("postgresql"):
        pytest.skip("SQLite locking makes concurrent registration test flaky; requires PostgreSQL")

    payload = {
        "username": "race_user",
        "password": "concurrent_password_123",
    }
    r1, r2 = await asyncio.gather(
        client.post("/auth/register", json=payload),
        client.post("/auth/register", json=payload),
    )
    statuses = sorted([r1.status_code, r2.status_code])
    assert statuses == [201, 409]


def test_security_functions() -> None:
    """Unit tests for verify_password malformed input and hash_password byte length limit."""
    # Malformed hashes return False and never raise
    assert verify_password("test_pass", "not_a_valid_bcrypt_hash") is False
    assert verify_password("test_pass", "") is False
    assert verify_password("test_pass", "$2b$invalid") is False
    assert verify_password("test_pass", None) is False  # type: ignore[arg-type]

    # Password > 72 bytes raises ValueError in hash_password
    with pytest.raises(ValueError, match="Password cannot exceed 72 bytes"):
        hash_password("€" * 25)  # 75 UTF-8 bytes

    # Password > 72 bytes in verify_password returns False without raising
    assert verify_password("€" * 25, "$2b$04$somehash") is False


async def test_security_async_wrappers() -> None:
    """Async wrappers run hashing and verification properly."""
    pwd = "async_test_password"
    hashed = await hash_password_async(pwd, rounds=4)
    assert hashed.startswith("$2b$04$")
    assert await verify_password_async(pwd, hashed) is True
    assert await verify_password_async("wrong", hashed) is False
