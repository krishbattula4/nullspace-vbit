"""WebSocket Message Router for Nullspace.

Handles conversation validation, message persistence, recipient delivery,
and sender acknowledgment.
"""
import base64
import logging
import uuid
from datetime import UTC, datetime

from fastapi import WebSocket
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.db import get_session_factory
from app.models.conversation import Conversation
from app.models.message import Message, MessageStatus
from app.models.message_version import MessageVersion, VersionAction
from app.ws.envelope import (
    ClientMessageFrame,
    EnvelopeError,
    ack_frame,
    error_frame,
    message_frame,
)
from app.ws.registry import registry

log = logging.getLogger("nullspace.ws.router")


def _format_iso_z(dt: datetime) -> str:
    """Format datetime into ISO 8601 UTC string ending with Z."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    else:
        dt = dt.astimezone(UTC)
    iso = dt.isoformat()
    if iso.endswith("+00:00"):
        return iso[:-6] + "Z"
    if not iso.endswith("Z"):
        return iso + "Z"
    return iso


async def handle_message_frame(
    sender_id: uuid.UUID,
    websocket: WebSocket,
    frame: ClientMessageFrame,
) -> None:
    """Handle incoming client MESSAGE frame.

    1. Validates conversation membership for sender.
    2. Enforces idempotency on (sender_id, client_msg_id).
    3. Persists Message and initial MessageVersion (version_no=1, action=CREATE).
    4. Relays ciphertext to recipient via registry.send_to_user if online.
    5. Sends ACK frame strictly to the originating WebSocket.
    """
    try:
        conv_id = uuid.UUID(frame.conversation_id)
        client_msg_id = uuid.UUID(frame.client_msg_id)
    except (ValueError, TypeError):
        err = EnvelopeError("invalid_frame", "Invalid UUID")
        await websocket.send_json(error_frame(err, client_msg_id=frame.client_msg_id))
        return

    async with get_session_factory()() as session:
        # A. Validate conversation membership
        conv_stmt = select(Conversation).where(Conversation.id == conv_id)
        conv_res = await session.execute(conv_stmt)
        conversation = conv_res.scalar_one_or_none()

        if conversation is None or sender_id not in (
            conversation.user_a_id,
            conversation.user_b_id,
        ):
            err = EnvelopeError("conversation_not_found")
            await websocket.send_json(error_frame(err, client_msg_id=frame.client_msg_id))
            return

        # B. Implement idempotency
        stmt_existing = select(Message).where(
            Message.sender_id == sender_id,
            Message.client_msg_id == client_msg_id,
        )
        res_existing = await session.execute(stmt_existing)
        existing_msg = res_existing.scalar_one_or_none()

        if existing_msg is not None:
            ack_status = (
                "QUEUED"
                if existing_msg.status == MessageStatus.QUEUED
                else "SENT"
            )
            ack = ack_frame(
                client_msg_id=frame.client_msg_id,
                message_id=str(existing_msg.id),
                status=ack_status,
            )
            await websocket.send_json(ack)
            return

        # D (prep). Determine recipient
        recipient_id = (
            conversation.user_b_id
            if sender_id == conversation.user_a_id
            else conversation.user_a_id
        )
        is_recipient_online = registry.is_online(recipient_id)
        initial_status = (
            MessageStatus.SENT if is_recipient_online else MessageStatus.QUEUED
        )

        # C. Persist message and version 1
        ciphertext_bytes = base64.b64decode(frame.body, validate=True)
        msg_id = uuid.uuid4()
        now = datetime.now(UTC)

        msg = Message(
            id=msg_id,
            conversation_id=conversation.id,
            sender_id=sender_id,
            client_msg_id=client_msg_id,
            current_version=1,
            status=initial_status,
            created_at=now,
        )
        ver = MessageVersion(
            id=uuid.uuid4(),
            message_id=msg_id,
            version_no=1,
            ctype=frame.ctype,
            ciphertext=ciphertext_bytes,
            action=VersionAction.CREATE,
            actor_id=sender_id,
            created_at=now,
        )

        session.add(msg)
        session.add(ver)

        try:
            await session.commit()
            await session.refresh(msg)
        except IntegrityError:
            await session.rollback()
            # Handle concurrent duplicate creation race
            res_existing = await session.execute(stmt_existing)
            existing_msg = res_existing.scalar_one_or_none()
            if existing_msg is not None:
                ack_status = (
                    "QUEUED"
                    if existing_msg.status == MessageStatus.QUEUED
                    else "SENT"
                )
                ack = ack_frame(
                    client_msg_id=frame.client_msg_id,
                    message_id=str(existing_msg.id),
                    status=ack_status,
                )
                await websocket.send_json(ack)
                return
            raise

        # D. Deliver to recipient
        out_frame = message_frame(
            message_id=str(msg.id),
            conversation_id=str(conversation.id),
            sender_id=str(sender_id),
            version_no=1,
            ctype=frame.ctype,
            body=frame.body,
            created_at=_format_iso_z(msg.created_at),
        )

        sent_count = await registry.send_to_user(recipient_id, out_frame)
        delivery_status = "SENT" if sent_count > 0 else "QUEUED"

        if msg.status != MessageStatus(delivery_status):
            msg.status = MessageStatus(delivery_status)
            await session.commit()

        # E. Acknowledge the sender (originating socket only)
        ack = ack_frame(
            client_msg_id=frame.client_msg_id,
            message_id=str(msg.id),
            status=delivery_status,
        )
        await websocket.send_json(ack)
