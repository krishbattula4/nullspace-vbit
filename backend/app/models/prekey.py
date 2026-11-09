"""Prekey model for Signal Protocol cryptographic key bundles."""
import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class PrekeyKind(str, enum.Enum):
    SIGNED = "SIGNED"
    ONE_TIME = "ONE_TIME"


class Prekey(Base):
    __tablename__ = "prekeys"
    __table_args__ = (
        UniqueConstraint("user_id", "kind", "key_id", name="uq_prekeys_user_id_kind_key_id"),
        CheckConstraint(
            "(kind = 'SIGNED' AND signature IS NOT NULL) OR "
            "(kind = 'ONE_TIME' AND signature IS NULL)",
            name="signature_rule",
        ),
        Index("ix_prekeys_user_id_kind_consumed_at", "user_id", "kind", "consumed_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.user_id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[PrekeyKind] = mapped_column(
        Enum(
            PrekeyKind,
            native_enum=False,
            create_constraint=True,
            name="prekey_kind",
            length=16,
        ),
        nullable=False,
    )
    key_id: Mapped[int] = mapped_column(Integer, nullable=False)
    public_key: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    signature: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
