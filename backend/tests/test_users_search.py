"""Tests for GET /users/search endpoint."""
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.tokens import create_access_token
from app.models.user import User


async def _create_user(db: AsyncSession, username: str, display_name: str | None = None) -> User:
    user = User(
        username=username,
        password_hash="$2b$12$dummyhashfordemonstratingusercreation",
        display_name=display_name or username.title(),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


@pytest.mark.asyncio
async def test_search_requires_authentication(client: AsyncClient) -> None:
    """GET /users/search requires a valid Bearer token."""
    res = await client.get("/users/search?q=alice")
    assert res.status_code == 401
    assert res.json()["detail"] == "not_authenticated"

    res_bad = await client.get("/users/search?q=alice", headers={"Authorization": "Bearer invalid"})
    assert res_bad.status_code == 401
    assert res_bad.json()["detail"] == "invalid_token"


@pytest.mark.asyncio
async def test_search_query_length_validation(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Query parameter 'q' must contain between 2 and 32 characters."""
    caller = await _create_user(db_session, "caller_val")
    token = create_access_token(caller.user_id)
    headers = {"Authorization": f"Bearer {token}"}

    # Too short (< 2)
    res_short = await client.get("/users/search?q=a", headers=headers)
    assert res_short.status_code == 422

    res_empty = await client.get("/users/search?q=", headers=headers)
    assert res_empty.status_code == 422

    # Too long (> 32)
    res_long = await client.get(f"/users/search?q={'a' * 33}", headers=headers)
    assert res_long.status_code == 422

    # Valid boundaries (2 and 32)
    res_min = await client.get("/users/search?q=ab", headers=headers)
    assert res_min.status_code == 200

    res_max = await client.get(f"/users/search?q={'a' * 32}", headers=headers)
    assert res_max.status_code == 200


@pytest.mark.asyncio
async def test_search_case_insensitive_prefix(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Search matches username prefix case-insensitively."""
    caller = await _create_user(db_session, "caller_case")
    await _create_user(db_session, "alex_ander")
    await _create_user(db_session, "alice_wonder")
    await _create_user(db_session, "bob_ross")

    token = create_access_token(caller.user_id)
    headers = {"Authorization": f"Bearer {token}"}

    # Uppercase query matching lowercase usernames
    res_upper = await client.get("/users/search?q=AL", headers=headers)
    assert res_upper.status_code == 200
    usernames = [u["username"] for u in res_upper.json()]
    assert "alex_ander" in usernames
    assert "alice_wonder" in usernames
    assert "bob_ross" not in usernames

    # Lowercase query
    res_lower = await client.get("/users/search?q=al", headers=headers)
    assert res_lower.status_code == 200
    assert [u["username"] for u in res_lower.json()] == usernames


@pytest.mark.asyncio
async def test_search_excludes_caller(client: AsyncClient, db_session: AsyncSession) -> None:
    """The authenticated caller is never returned in search results."""
    caller = await _create_user(db_session, "alice_caller")
    peer = await _create_user(db_session, "alice_peer")

    token = create_access_token(caller.user_id)
    headers = {"Authorization": f"Bearer {token}"}

    res = await client.get("/users/search?q=alice", headers=headers)
    assert res.status_code == 200
    users = res.json()
    assert len(users) == 1
    assert users[0]["username"] == peer.username
    assert users[0]["user_id"] == str(peer.user_id)


@pytest.mark.asyncio
async def test_search_max_20_results(client: AsyncClient, db_session: AsyncSession) -> None:
    """Search returns at most 20 matching users."""
    caller = await _create_user(db_session, "caller_limit")
    # Create 25 matching users
    for i in range(25):
        await _create_user(db_session, f"target_user_{i:02d}")

    token = create_access_token(caller.user_id)
    headers = {"Authorization": f"Bearer {token}"}

    res = await client.get("/users/search?q=target", headers=headers)
    assert res.status_code == 200
    results = res.json()
    assert len(results) == 20


@pytest.mark.asyncio
async def test_search_username_ordering(client: AsyncClient, db_session: AsyncSession) -> None:
    """Results are sorted alphabetically by username ascending."""
    caller = await _create_user(db_session, "caller_order")
    await _create_user(db_session, "sort_zebra")
    await _create_user(db_session, "sort_apple")
    await _create_user(db_session, "sort_mango")

    token = create_access_token(caller.user_id)
    headers = {"Authorization": f"Bearer {token}"}

    res = await client.get("/users/search?q=sort_", headers=headers)
    assert res.status_code == 200
    usernames = [u["username"] for u in res.json()]
    assert usernames == ["sort_apple", "sort_mango", "sort_zebra"]


@pytest.mark.asyncio
async def test_search_literal_wildcards(client: AsyncClient, db_session: AsyncSession) -> None:
    """Percent '%' and underscore '_' in q are treated as literal characters."""
    caller = await _create_user(db_session, "caller_wild")
    await _create_user(db_session, "test_prefix_user")
    await _create_user(db_session, "testxprefix_user")
    await _create_user(db_session, "test%prefix_user")

    token = create_access_token(caller.user_id)
    headers = {"Authorization": f"Bearer {token}"}

    # Literal '_' should NOT match 'testx'
    res_underscore = await client.get("/users/search?q=test_", headers=headers)
    assert res_underscore.status_code == 200
    under_names = [u["username"] for u in res_underscore.json()]
    assert "test_prefix_user" in under_names
    assert "testxprefix_user" not in under_names
    assert "test%prefix_user" not in under_names

    # Literal '%' should only match 'test%'
    res_percent = await client.get("/users/search?q=test%", headers=headers)
    assert res_percent.status_code == 200
    pct_names = [u["username"] for u in res_percent.json()]
    assert pct_names == ["test%prefix_user"]
