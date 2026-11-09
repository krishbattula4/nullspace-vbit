"""Tests default to SQLite (aiosqlite) so no PostgreSQL is needed locally; CI sets DATABASE_URL."""
import os
from collections.abc import AsyncIterator
from pathlib import Path

os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("BCRYPT_ROUNDS", "4")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./test.db")
os.environ.setdefault("JWT_SECRET", "test-secret")

import pytest  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession  # noqa: E402

from app.core.db import Base, dispose_engine, get_engine, get_session_factory  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(autouse=True)
async def setup_database() -> AsyncIterator[None]:
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await dispose_engine()


@pytest.fixture(scope="session", autouse=True)
def cleanup_test_db():
    yield
    db_file = Path("test.db")
    if db_file.exists():
        try:
            db_file.unlink()
        except OSError:
            pass


@pytest.fixture
async def db_session() -> AsyncIterator[AsyncSession]:
    async with get_session_factory()() as session:
        yield session


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
