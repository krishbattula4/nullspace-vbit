"""Comprehensive tests for JWT access and refresh authentication."""
import asyncio
import base64
import json
import logging
import uuid
from datetime import timedelta

import pytest
from httpx import AsyncClient
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.core.tokens import (
    TokenExpired,
    TokenInvalid,
    create_access_token,
    create_refresh_token,
    decode_token,
)
from app.models.refresh_token import RefreshToken


def _base64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


async def _register_user(
    client: AsyncClient,
    username: str = "alice",
    password: str = "P@ssword12345!",
) -> dict:
    res = await client.post(
        "/auth/register",
        json={"username": username, "password": password, "display_name": username.title()},
    )
    assert res.status_code == 201, res.text
    return res.json()


async def test_register_then_login_success(client: AsyncClient) -> None:
    """Register then login succeeds, returning access and refresh JWTs with valid claims."""
    user = await _register_user(client, "login_user", "ValidPassword123!")
    user_id = user["user_id"]
    settings = get_settings()

    res = await client.post(
        "/auth/login",
        json={"username": "login_user", "password": "ValidPassword123!"},
    )
    assert res.status_code == 200
    body = res.json()

    assert "access_token" in body
    assert "refresh_token" in body
    assert body["token_type"] == "bearer"
    assert body["expires_in"] == settings.jwt_access_minutes * 60

    # Validate access token claims
    access_claims = decode_token(body["access_token"], expected_type="access")
    assert access_claims["type"] == "access"
    assert access_claims["sub"] == user_id
    assert "jti" in access_claims

    # Validate refresh token claims
    refresh_claims = decode_token(body["refresh_token"], expected_type="refresh")
    assert refresh_claims["type"] == "refresh"
    assert refresh_claims["sub"] == user_id
    assert "jti" in refresh_claims


async def test_login_invalid_credentials_parity(client: AsyncClient) -> None:
    """Wrong password and unknown username return 401 with byte-identical response bodies."""
    await _register_user(client, "parity_user", "ValidPassword123!")

    # 1. Known user, wrong password
    res_wrong_pw = await client.post(
        "/auth/login",
        json={"username": "parity_user", "password": "WrongPassword999!"},
    )

    # 2. Unknown username
    res_unknown_user = await client.post(
        "/auth/login",
        json={"username": "non_existent_user", "password": "AnyPassword123!"},
    )

    assert res_wrong_pw.status_code == 401
    assert res_unknown_user.status_code == 401
    assert res_wrong_pw.json() == {"detail": "invalid_credentials"}
    assert res_unknown_user.json() == {"detail": "invalid_credentials"}
    assert res_wrong_pw.content == res_unknown_user.content


async def test_refresh_rotation_and_reuse_detection(client: AsyncClient) -> None:
    """Rotating a refresh token issues a new pair;
    presenting old token triggers reuse revocation.
    """
    await _register_user(client, "reuse_user", "ValidPassword123!")
    login_res = await client.post(
        "/auth/login",
        json={"username": "reuse_user", "password": "ValidPassword123!"},
    )
    assert login_res.status_code == 200
    token1 = login_res.json()["refresh_token"]

    # First refresh: success, returns token2
    ref1_res = await client.post("/auth/refresh", json={"refresh_token": token1})
    assert ref1_res.status_code == 200
    token2 = ref1_res.json()["refresh_token"]
    assert token2 != token1

    # Second refresh with token1 (reuse/theft attempt!): fails with refresh_reuse_detected
    reuse_res = await client.post("/auth/refresh", json={"refresh_token": token1})
    assert reuse_res.status_code == 401
    assert reuse_res.json() == {"detail": "refresh_reuse_detected"}

    # After reuse detection, token2 must ALSO fail because ALL user's tokens were revoked
    cascaded_res = await client.post("/auth/refresh", json={"refresh_token": token2})
    assert cascaded_res.status_code == 401
    assert cascaded_res.json() == {"detail": "refresh_reuse_detected"}


async def test_logout_idempotency_and_refresh_revocation(client: AsyncClient) -> None:
    """Logout revokes token, subsequent refresh fails; duplicate and garbage logouts return 204."""
    await _register_user(client, "logout_user", "ValidPassword123!")
    login_res = await client.post(
        "/auth/login",
        json={"username": "logout_user", "password": "ValidPassword123!"},
    )
    refresh_token = login_res.json()["refresh_token"]

    # Logout with active refresh token returns 204
    logout1 = await client.post("/auth/logout", json={"refresh_token": refresh_token})
    assert logout1.status_code == 204

    # Refresh with revoked token returns 401 refresh_reuse_detected
    refresh_after_logout = await client.post("/auth/refresh", json={"refresh_token": refresh_token})
    assert refresh_after_logout.status_code == 401
    assert refresh_after_logout.json() == {"detail": "refresh_reuse_detected"}

    # Logout again with same token returns 204 (idempotent)
    logout2 = await client.post("/auth/logout", json={"refresh_token": refresh_token})
    assert logout2.status_code == 204

    # Logout with garbage string returns 204
    logout_garbage = await client.post(
        "/auth/logout", json={"refresh_token": "garbage.jwt.payload"}
    )
    assert logout_garbage.status_code == 204


async def test_expired_tokens(client: AsyncClient, db_session: AsyncSession) -> None:
    """Expired refresh token returns token_expired; expired access token raises TokenExpired."""
    user = await _register_user(client, "expired_user", "ValidPassword123!")
    uid = uuid.UUID(user["user_id"])

    # 1. Expired access token raises TokenExpired in decode_token
    exp_access = create_access_token(uid, expires_delta=timedelta(seconds=-10))
    with pytest.raises(TokenExpired):
        decode_token(exp_access, expected_type="access")

    # 2. Expired refresh token with row in DB returns 401 token_expired
    exp_refresh, jti, expires_at = create_refresh_token(uid, expires_delta=timedelta(seconds=-10))
    db_session.add(RefreshToken(jti=jti, user_id=uid, expires_at=expires_at))
    await db_session.commit()

    res = await client.post("/auth/refresh", json={"refresh_token": exp_refresh})
    assert res.status_code == 401
    assert res.json() == {"detail": "token_expired"}


async def test_token_type_mismatch(client: AsyncClient) -> None:
    """Access token to /auth/refresh returns invalid_token; refresh token raises TokenInvalid."""
    uid = uuid.uuid4()
    access_token = create_access_token(uid)
    refresh_token, _, _ = create_refresh_token(uid)

    # Sending access token to refresh endpoint
    res = await client.post("/auth/refresh", json={"refresh_token": access_token})
    assert res.status_code == 401
    assert res.json() == {"detail": "invalid_token"}

    # Passing refresh token to decode_token with expected_type="access"
    with pytest.raises(TokenInvalid, match="Expected token type 'access', got 'refresh'"):
        decode_token(refresh_token, expected_type="access")


async def test_tampered_and_algorithm_none(client: AsyncClient) -> None:
    """Tampered token and algorithm 'none' are rejected."""
    uid = uuid.uuid4()
    valid_token = create_access_token(uid)

    # Tampered signature
    parts = valid_token.split(".")
    tampered_sig = parts[0] + "." + parts[1] + "." + ("a" * len(parts[2]))
    with pytest.raises(TokenInvalid):
        decode_token(tampered_sig, expected_type="access")

    # Algorithm "none" token
    header = _base64url(json.dumps({"alg": "none", "typ": "JWT"}).encode("utf-8"))
    payload = _base64url(
        json.dumps(
            {
                "sub": str(uid),
                "type": "refresh",
                "jti": str(uuid.uuid4()),
                "exp": 2000000000,
            }
        ).encode("utf-8")
    )
    none_token = f"{header}.{payload}."

    with pytest.raises(TokenInvalid):
        decode_token(none_token, expected_type="refresh")

    res = await client.post("/auth/refresh", json={"refresh_token": none_token})
    assert res.status_code == 401
    assert res.json() == {"detail": "invalid_token"}


def test_settings_production_secret_validation() -> None:
    """Settings with app_env='production' and default or short jwt_secret raises ValidationError."""
    with pytest.raises(ValidationError, match="jwt_secret must be at least 32 characters"):
        Settings(app_env="production", jwt_secret="change-me")

    with pytest.raises(ValidationError, match="jwt_secret must be at least 32 characters"):
        Settings(app_env="production", jwt_secret="short-secret-less-than-32")

    # Valid in production with 32+ characters
    valid_prod = Settings(app_env="production", jwt_secret="a" * 32)
    assert valid_prod.jwt_secret == "a" * 32

    # In development or test, 'change-me' is allowed
    dev_settings = Settings(app_env="development", jwt_secret="change-me")
    assert dev_settings.jwt_secret == "change-me"


async def test_tokens_never_logged(client: AsyncClient, caplog: pytest.LogCaptureFixture) -> None:
    """Access and refresh tokens never appear in log records across login, refresh, and logout."""
    caplog.set_level(logging.DEBUG)
    user = await _register_user(client, "logging_user", "ValidPassword123!")

    # Login
    login_res = await client.post(
        "/auth/login",
        json={"username": "logging_user", "password": "ValidPassword123!"},
    )
    tokens = login_res.json()
    acc1 = tokens["access_token"]
    ref1 = tokens["refresh_token"]

    # Refresh
    ref_res = await client.post("/auth/refresh", json={"refresh_token": ref1})
    tokens2 = ref_res.json()
    acc2 = tokens2["access_token"]
    ref2 = tokens2["refresh_token"]

    # Logout
    await client.post("/auth/logout", json={"refresh_token": ref2})

    # Assert tokens never appear in caplog
    for secret in (acc1, ref1, acc2, ref2):
        for rec in caplog.records:
            assert secret not in rec.message
        assert secret not in caplog.text

    # Confirm user login event is logged with user_id
    records = [rec for rec in caplog.records if "nullspace.auth" in rec.name]
    assert any(
        "user logged in: user_id=" in rec.message and user["user_id"] in rec.message
        for rec in records
    )


async def test_concurrent_refreshes_atomic(client: AsyncClient) -> None:
    """Two simultaneous refreshes give one 200 and one 401 (skipped on SQLite)."""
    settings = get_settings()
    if not settings.sqlalchemy_url.startswith("postgresql"):
        pytest.skip("SQLite locking makes concurrent refresh test flaky; requires PostgreSQL")

    await _register_user(client, "concurrent_user", "ValidPassword123!")
    login_res = await client.post(
        "/auth/login",
        json={"username": "concurrent_user", "password": "ValidPassword123!"},
    )
    refresh_token = login_res.json()["refresh_token"]

    res1, res2 = await asyncio.gather(
        client.post("/auth/refresh", json={"refresh_token": refresh_token}),
        client.post("/auth/refresh", json={"refresh_token": refresh_token}),
    )

    statuses = [res1.status_code, res2.status_code]
    assert sorted(statuses) == [200, 401]
