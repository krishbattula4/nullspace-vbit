"""Tests for the REST authentication dependency get_current_user and /auth/me."""
import uuid
from datetime import timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import delete

from app.core.db import get_session_factory
from app.core.tokens import create_access_token, create_refresh_token
from app.models.user import User


async def _register_and_login(
    client: AsyncClient,
    username: str = "dep_user",
    password: str = "P@ssword12345!",
) -> tuple[dict, str]:
    """Helper to register and login a test user, returning (user_dict, access_token)."""
    reg_res = await client.post(
        "/auth/register",
        json={"username": username, "password": password, "display_name": username.title()},
    )
    assert reg_res.status_code == 201
    user_data = reg_res.json()

    login_res = await client.post(
        "/auth/login",
        json={"username": username, "password": password},
    )
    assert login_res.status_code == 200
    access_token = login_res.json()["access_token"]
    return user_data, access_token


@pytest.mark.asyncio
async def test_auth_me_valid_access_token(client: AsyncClient) -> None:
    """GET /auth/me with a valid access token returns the user profile."""
    user_data, access_token = await _register_and_login(client, "alice_me")
    headers = {"Authorization": f"Bearer {access_token}"}
    res = await client.get("/auth/me", headers=headers)

    assert res.status_code == 200
    body = res.json()
    assert body["user_id"] == user_data["user_id"]
    assert body["username"] == "alice_me"
    assert body["display_name"] == "Alice_Me"
    assert "created_at" in body


@pytest.mark.asyncio
async def test_auth_me_missing_header_returns_not_authenticated(client: AsyncClient) -> None:
    """GET /auth/me without an Authorization header returns 401 not_authenticated and challenge."""
    res = await client.get("/auth/me")
    assert res.status_code == 401
    assert res.json()["detail"] == "not_authenticated"
    assert res.headers.get("WWW-Authenticate") == "Bearer"


@pytest.mark.asyncio
async def test_auth_me_malformed_header_returns_not_authenticated(client: AsyncClient) -> None:
    """GET /auth/me with non-Bearer or malformed header returns 401 not_authenticated."""
    res = await client.get("/auth/me", headers={"Authorization": "Basic dXNlcjpwYXNz"})
    assert res.status_code == 401
    assert res.json()["detail"] == "not_authenticated"
    assert res.headers.get("WWW-Authenticate") == "Bearer"

    res_empty_bearer = await client.get("/auth/me", headers={"Authorization": "Bearer "})
    assert res_empty_bearer.status_code == 401
    assert res_empty_bearer.json()["detail"] == "not_authenticated"


@pytest.mark.asyncio
async def test_auth_me_garbage_token_returns_invalid_token(client: AsyncClient) -> None:
    """GET /auth/me with a garbage token returns 401 invalid_token."""
    res = await client.get("/auth/me", headers={"Authorization": "Bearer not.a.valid.jwt"})
    assert res.status_code == 401
    assert res.json()["detail"] == "invalid_token"
    assert res.headers.get("WWW-Authenticate") == "Bearer"


@pytest.mark.asyncio
async def test_auth_me_expired_token_returns_token_expired(client: AsyncClient) -> None:
    """GET /auth/me with an expired access token returns 401 token_expired."""
    user_data, _ = await _register_and_login(client, "expired_user")
    user_id = uuid.UUID(user_data["user_id"])
    expired_token = create_access_token(user_id, expires_delta=timedelta(seconds=-10))

    res = await client.get("/auth/me", headers={"Authorization": f"Bearer {expired_token}"})
    assert res.status_code == 401
    assert res.json()["detail"] == "token_expired"
    assert res.headers.get("WWW-Authenticate") == "Bearer"


@pytest.mark.asyncio
async def test_auth_me_refresh_token_in_auth_header_returns_invalid_token(
    client: AsyncClient,
) -> None:
    """GET /auth/me with a refresh token in Authorization header returns 401 invalid_token."""
    user_data, _ = await _register_and_login(client, "refresh_header_user")
    user_id = uuid.UUID(user_data["user_id"])
    refresh_token, _, _ = create_refresh_token(user_id)

    res = await client.get("/auth/me", headers={"Authorization": f"Bearer {refresh_token}"})
    assert res.status_code == 401
    assert res.json()["detail"] == "invalid_token"
    assert res.headers.get("WWW-Authenticate") == "Bearer"


@pytest.mark.asyncio
async def test_auth_me_deleted_user_returns_invalid_token(client: AsyncClient) -> None:
    """GET /auth/me with token for a deleted user returns 401 invalid_token."""
    user_data, access_token = await _register_and_login(client, "deleted_user")
    user_id = uuid.UUID(user_data["user_id"])

    # Delete the user from the database
    async with get_session_factory()() as db:
        await db.execute(delete(User).where(User.user_id == user_id))
        await db.commit()

    res = await client.get("/auth/me", headers={"Authorization": f"Bearer {access_token}"})
    assert res.status_code == 401
    assert res.json()["detail"] == "invalid_token"
    assert res.headers.get("WWW-Authenticate") == "Bearer"
