"""Message model representing the top-level immutable container for a message."""
import enum
import uuid
from datetime import datetime

import sqlalchemy as sa
from sqlalchemy import (
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class MessageStatus(str, enum.Enum):
    SENT = "SENT"
    QUEUED = "QUEUED"
    DELIVERED = "DELIVERED"


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (
        UniqueConstraint("sender_id", "client_msg_id", name="uq_messages_sender_id_client_msg_id"),
        Index("ix_messages_conversation_id_created_at", "conversation_id", "created_at"),
        Index(
            "ix_messages_status_conversation_id_created_at",
            "status",
            "conversation_id",
            "created_at",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False
    )
    sender_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.user_id"), nullable=False
    )
    client_msg_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    current_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default=sa.text("1")
    )
    status: Mapped[MessageStatus] = mapped_column(
        Enum(
            MessageStatus,
            native_enum=False,
            create_constraint=True,
            name="message_status",
            length=16,
        ),
        nullable=False,
        default=MessageStatus.SENT,
        server_default=sa.text("'SENT'"),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
