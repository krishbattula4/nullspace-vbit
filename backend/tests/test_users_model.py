import uuid
from datetime import datetime

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User


async def test_insert_and_read_user(db_session: AsyncSession) -> None:
    user = User(
        username="Alice",
        password_hash="test_password_hash_value",
        display_name="Alice User",
    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)

    result = await db_session.execute(select(User).where(User.username == "alice"))
    fetched = result.scalar_one()

    assert isinstance(fetched.user_id, uuid.UUID)
    assert fetched.user_id == user.user_id
    assert fetched.username == "alice"
    assert fetched.display_name == "Alice User"
    assert fetched.password_hash == "test_password_hash_value"
    assert fetched.created_at is not None
    assert isinstance(fetched.created_at, datetime)


async def test_duplicate_username_raises_integrity_error(db_session: AsyncSession) -> None:
    user1 = User(
        username="bob",
        password_hash="hash_bob_1",
        display_name="Bob Original",
    )
    db_session.add(user1)
    await db_session.commit()

    user2 = User(
        username="BOB",
        password_hash="hash_bob_2",
        display_name="Bob Duplicate",
    )
    db_session.add(user2)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


def test_only_password_hash_column() -> None:
    table = User.__table__
    password_columns = [
        col.name
        for col in table.columns
        if "password" in col.name.lower() or "pwd" in col.name.lower()
    ]
    assert password_columns == ["password_hash"]
    assert "password" not in table.columns
    assert "plain_password" not in table.columns
