"""Message version model tracking Signal ciphertext and edit/delete/retract audit trail."""
import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    LargeBinary,
    SmallInteger,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class VersionAction(str, enum.Enum):
    CREATE = "CREATE"
    EDIT = "EDIT"
    DELETE = "DELETE"
    RETRACT = "RETRACT"


class MessageVersion(Base):
    __tablename__ = "message_versions"
    __table_args__ = (
        CheckConstraint("ctype IN (1, 3)", name="ctype_values"),
        UniqueConstraint(
            "message_id", "version_no", name="uq_message_versions_message_id_version_no"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    message_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("messages.id", ondelete="CASCADE"), nullable=False
    )
    version_no: Mapped[int] = mapped_column(Integer, nullable=False)
    ctype: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    ciphertext: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    action: Mapped[VersionAction] = mapped_column(
        Enum(
            VersionAction,
            native_enum=False,
            create_constraint=True,
            name="version_action",
            length=16,
        ),
        nullable=False,
    )
    actor_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.user_id"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    erased_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
