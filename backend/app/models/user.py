"""User account model for authentication, identity and messaging."""
import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Integer, LargeBinary, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column, validates

from app.core.db import Base


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("length(username) >= 3", name="username_length"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    username: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    password_hash: Mapped[str] = mapped_column(String(100), nullable=False)
    display_name: Mapped[str] = mapped_column(String(64), nullable=False)
    identity_key: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    registration_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    @validates("username")
    def validate_username(self, key: str, value: str) -> str:
        return value.lower() if value is not None else value
