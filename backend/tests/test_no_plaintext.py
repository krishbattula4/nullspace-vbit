"""Tests verifying server rejection of plaintext message fields and opaque wire format enforcement.

P3.9 — Reject Plaintext: Implementation and Verification.
"""
import base64
import uuid
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.types import (
    Date,
    DateTime,
    Enum,
    Integer,
    LargeBinary,
    Numeric,
    SmallInteger,
    String,
    Text,
    Time,
    Uuid,
)
from starlette.testclient import TestClient

from app.core.db import Base
from app.main import app
from app.models.conversation import Conversation
from app.models.media import Media
from app.models.message import Message, MessageStatus
from app.models.message_version import MessageVersion, VersionAction


def _create_user_and_tokens(
    client: TestClient,
    username_prefix: str = "no_plaintext",
    password: str = "P@ssword12345!",
) -> tuple[str, str, str]:
    """Register and login a unique test user synchronously via TestClient."""
    unique_user = f"{username_prefix}_{uuid.uuid4().hex[:8]}"
    reg_res = client.post(
        "/auth/register",
        json={"username": unique_user, "password": password, "display_name": unique_user.title()},
    )
    assert reg_res.status_code == 201
    user_id = reg_res.json()["user_id"]

    login_res = client.post(
        "/auth/login",
        json={"username": unique_user, "password": password},
    )
    assert login_res.status_code == 200
    tokens = login_res.json()
    return user_id, tokens["access_token"], tokens["refresh_token"]


async def _create_conversation(
    db: AsyncSession,
    user_a_id: uuid.UUID,
    user_b_id: uuid.UUID,
) -> Conversation:
    """Create a canonical conversation pair in the database."""
    ua, ub = sorted([user_a_id, user_b_id])
    conv = Conversation(user_a_id=ua, user_b_id=ub)
    db.add(conv)
    await db.commit()
    await db.refresh(conv)
    return conv


async def _get_table_counts(db: AsyncSession) -> tuple[int, int]:
    """Return current row count for (messages, message_versions)."""
    msg_res = await db.execute(select(func.count(Message.id)))
    msg_count = msg_res.scalar_one()
    ver_res = await db.execute(select(func.count(MessageVersion.id)))
    ver_count = ver_res.scalar_one()
    return msg_count, ver_count


# ============================================================================
# Section A: Unknown plaintext-field rejection
# ============================================================================


@pytest.mark.asyncio
async def test_unknown_plaintext_fields_rejected_over_websocket(
    db_session: AsyncSession,
) -> None:
    """Sending unknown plaintext fields (text, content, plaintext, message) in a MESSAGE frame

    returns ERROR invalid_frame, preserves the WebSocket connection, and leaves DB row counts
    completely unchanged.
    """
    with TestClient(app) as client:
        uid_a, token_a, _ = _create_user_and_tokens(client, "alice_pt")
        uid_b, token_b, _ = _create_user_and_tokens(client, "bob_pt")
        conv = await _create_conversation(db_session, uuid.UUID(uid_a), uuid.UUID(uid_b))

        base_msg_count, base_ver_count = await _get_table_counts(db_session)

        with client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "AUTH", "token": token_a})
            assert ws.receive_json()["type"] == "AUTH_OK"

            unknown_fields = ["text", "content", "plaintext", "message"]
            for field_name in unknown_fields:
                client_msg_id = str(uuid.uuid4())
                b64_body = base64.b64encode(b"valid_encrypted_payload").decode("ascii")

                frame: dict[str, Any] = {
                    "v": 1,
                    "type": "MESSAGE",
                    "conversation_id": str(conv.id),
                    "client_msg_id": client_msg_id,
                    "ctype": 1,
                    "body": b64_body,
                    field_name: "unexpected_plaintext_payload_leak",
                }

                ws.send_json(frame)

                # Assert ERROR frame returned with invalid_frame code
                err = ws.receive_json()
                assert err["type"] == "ERROR", (
                    f"Expected ERROR frame for field '{field_name}', got {err.get('type')}"
                )
                assert err["code"] == "invalid_frame", (
                    f"Expected code 'invalid_frame' for field '{field_name}', got {err.get('code')}"
                )

                # Assert WebSocket connection remains open and functional
                ws.send_json({"type": "PING"})
                pong = ws.receive_json()
                assert pong == {"type": "PONG"}, (
                    f"WebSocket connection dropped after testing field '{field_name}'"
                )

                # Explicitly verify DB counts remain identical after each attempt
                current_msg_count, current_ver_count = await _get_table_counts(db_session)
                assert current_msg_count == base_msg_count, (
                    f"Message row inserted when testing unexpected field '{field_name}'"
                )
                assert current_ver_count == base_ver_count, (
                    f"MessageVersion row inserted when testing unexpected field '{field_name}'"
                )

        # Final assertion on DB state across all attempts
        final_msg_count, final_ver_count = await _get_table_counts(db_session)
        assert final_msg_count == base_msg_count
        assert final_ver_count == base_ver_count


# ============================================================================
# Section B: Invalid Base64 rejection
# ============================================================================


@pytest.mark.asyncio
async def test_invalid_base64_body_rejected(
    db_session: AsyncSession,
) -> None:
    """Non-base64 body such as 'hello' is rejected with ERROR invalid_frame and adds 0 rows."""
    with TestClient(app) as client:
        uid_a, token_a, _ = _create_user_and_tokens(client, "alice_b64_inv")
        uid_b, token_b, _ = _create_user_and_tokens(client, "bob_b64_inv")
        conv = await _create_conversation(db_session, uuid.UUID(uid_a), uuid.UUID(uid_b))

        base_msg_count, base_ver_count = await _get_table_counts(db_session)

        with client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "AUTH", "token": token_a})
            assert ws.receive_json()["type"] == "AUTH_OK"

            client_msg_id = str(uuid.uuid4())
            bad_frame = {
                "v": 1,
                "type": "MESSAGE",
                "conversation_id": str(conv.id),
                "client_msg_id": client_msg_id,
                "ctype": 1,
                "body": "hello",  # Invalid Base64: length 5 is not a multiple of 4
            }

            ws.send_json(bad_frame)

            err = ws.receive_json()
            assert err["type"] == "ERROR"
            assert err["code"] == "invalid_frame"

            # Connection remains usable
            ws.send_json({"type": "PING"})
            assert ws.receive_json() == {"type": "PONG"}

        # Explicitly verify DB counts unchanged
        current_msg_count, current_ver_count = await _get_table_counts(db_session)
        assert current_msg_count == base_msg_count
        assert current_ver_count == base_ver_count


# ============================================================================
# Section C: Valid Base64 body acceptance (opaque payload)
# ============================================================================


@pytest.mark.asyncio
async def test_valid_base64_body_accepted_as_opaque_payload(
    db_session: AsyncSession,
) -> None:
    """Valid Base64 body (e.g. base64 of 'hello' -> 'aGVsbG8=') is accepted as an opaque payload.

    NOTE ON CRYPTOGRAPHIC LIMITATION:
    The server cannot distinguish legitimate end-to-end ciphertext from arbitrary binary bytes
    that happen to be valid Base64 (such as the ASCII bytes 'hello'). The server accepts valid
    Base64 as an opaque byte payload, stores the raw decoded bytes into the LargeBinary
    message_versions.ciphertext column, and relays the payload to the recipient. Cryptographic
    validation, key exchange, and decryption belong exclusively to client devices, not this
    server parser. This test demonstrates that the server faithfully preserves opaque wire bytes
    without inspecting or requiring plaintext contents.
    """
    with TestClient(app) as client:
        uid_a, token_a, _ = _create_user_and_tokens(client, "alice_b64_val")
        uid_b, token_b, _ = _create_user_and_tokens(client, "bob_b64_val")
        conv = await _create_conversation(db_session, uuid.UUID(uid_a), uuid.UUID(uid_b))

        base_msg_count, base_ver_count = await _get_table_counts(db_session)

        # Base64 encoding of literal string "hello"
        raw_payload = b"hello"
        b64_body = base64.b64encode(raw_payload).decode("ascii")  # "aGVsbG8="
        assert b64_body == "aGVsbG8="
        client_msg_id = str(uuid.uuid4())

        with client.websocket_connect("/ws") as ws_a:
            ws_a.send_json({"type": "AUTH", "token": token_a})
            assert ws_a.receive_json()["type"] == "AUTH_OK"

            with client.websocket_connect("/ws") as ws_b:
                ws_b.send_json({"type": "AUTH", "token": token_b})
                assert ws_b.receive_json()["type"] == "AUTH_OK"

                valid_frame = {
                    "v": 1,
                    "type": "MESSAGE",
                    "conversation_id": str(conv.id),
                    "client_msg_id": client_msg_id,
                    "ctype": 1,
                    "body": b64_body,
                }
                ws_a.send_json(valid_frame)

                # Sender receives ACK
                ack = ws_a.receive_json()
                assert ack["type"] == "ACK"
                assert ack["v"] == 1
                assert ack["client_msg_id"] == client_msg_id
                assert ack["status"] == "SENT"
                server_msg_id = ack["message_id"]

                # Recipient receives MESSAGE frame with matching opaque payload
                delivered = ws_b.receive_json()
                assert delivered["type"] == "MESSAGE"
                assert delivered["message_id"] == server_msg_id
                assert delivered["body"] == b64_body

        # Assert DB persistence: exactly 1 message and 1 version added
        msg_count, ver_count = await _get_table_counts(db_session)
        assert msg_count == base_msg_count + 1
        assert ver_count == base_ver_count + 1

        # Verify persisted ciphertext matches raw decoded bytes b"hello" in BYTEA column
        stmt_msg = select(Message).where(Message.id == uuid.UUID(server_msg_id))
        msg_row = (await db_session.execute(stmt_msg)).scalar_one()
        assert msg_row.sender_id == uuid.UUID(uid_a)
        assert msg_row.status == MessageStatus.SENT

        stmt_ver = select(MessageVersion).where(MessageVersion.message_id == msg_row.id)
        ver_row = (await db_session.execute(stmt_ver)).scalar_one()
        assert ver_row.version_no == 1
        assert ver_row.action == VersionAction.CREATE
        assert ver_row.ciphertext == raw_payload
        assert isinstance(ver_row.ciphertext, bytes)


# ============================================================================
# Section D: SQLAlchemy model metadata test
# ============================================================================


def test_models_have_no_plaintext_content_columns() -> None:
    """Inspect SQLAlchemy metadata for messages, message_versions, and media tables.

    Asserts that no column uses a plain String or Text type for message content:
    - messages: strictly UUID, Integer, DateTime, and Enum (status).
    - message_versions: strictly UUID, Integer, SmallInteger, DateTime, LargeBinary (ciphertext),
      and Enum (action).
    - media: sha256 is LargeBinary; storage_path (Text) and mime_type (String) are strictly
      file metadata, not message content.
    - None of the three tables has any column named 'text', 'content', 'plaintext', 'body',
      or 'message'.
    """
    # Ensure models are imported and registered in Base.metadata
    assert Message.__tablename__ in Base.metadata.tables
    assert MessageVersion.__tablename__ in Base.metadata.tables
    assert Media.__tablename__ in Base.metadata.tables

    allowed_scalar_types = (
        Uuid,
        Integer,
        SmallInteger,
        Numeric,
        DateTime,
        Date,
        Time,
        LargeBinary,
    )

    # 1. Inspect messages table: zero String or Text columns; only Enum, UUID, Integer, DateTime
    messages_table = Base.metadata.tables["messages"]
    for col in messages_table.columns:
        col_type = col.type
        is_enum = isinstance(col_type, Enum)
        is_allowed_scalar = isinstance(col_type, allowed_scalar_types)
        is_plain_text = isinstance(col_type, String | Text) and not is_enum

        assert not is_plain_text, (
            f"Plain string/text column '{col.name}' found in table 'messages'. "
            f"Nullspace requires zero plaintext content on the server."
        )
        assert is_enum or is_allowed_scalar, (
            f"Unexpected type {col_type!r} for column '{col.name}' in 'messages'"
        )

    # 2. Inspect message_versions table: ciphertext must be LargeBinary; zero String/Text columns
    versions_table = Base.metadata.tables["message_versions"]
    assert isinstance(versions_table.c.ciphertext.type, LargeBinary), (
        "message_versions.ciphertext must be LargeBinary (BYTEA)"
    )
    for col in versions_table.columns:
        col_type = col.type
        is_enum = isinstance(col_type, Enum)
        is_allowed_scalar = isinstance(col_type, allowed_scalar_types)
        is_plain_text = isinstance(col_type, String | Text) and not is_enum

        assert not is_plain_text, (
            f"Plain string/text column '{col.name}' found in table 'message_versions'. "
            f"Nullspace requires zero plaintext content on the server."
        )
        assert is_enum or is_allowed_scalar, (
            f"Unexpected type {col_type!r} for column '{col.name}' in 'message_versions'"
        )

    # 3. Inspect media table: sha256 must be LargeBinary;
    # storage_path and mime_type are file metadata
    media_table = Base.metadata.tables["media"]
    assert isinstance(media_table.c.sha256.type, LargeBinary), (
        "media.sha256 must be LargeBinary (BYTEA)"
    )
    allowed_media_text_columns = {"storage_path", "mime_type"}
    for col in media_table.columns:
        col_type = col.type
        is_enum = isinstance(col_type, Enum)
        is_allowed_scalar = isinstance(col_type, allowed_scalar_types)
        if isinstance(col_type, String | Text) and not is_enum:
            assert col.name in allowed_media_text_columns, (
                f"Unexpected plain string/text column '{col.name}' in table 'media'. "
                f"Only non-content file metadata ({allowed_media_text_columns}) is allowed."
            )
        else:
            assert is_enum or is_allowed_scalar, (
                f"Unexpected type {col_type!r} for column '{col.name}' in 'media'"
            )

    # 4. Across all three tables, assert no column is named after plaintext content keywords
    forbidden_content_column_names = {"text", "content", "plaintext", "body", "message"}
    for table_name in ["messages", "message_versions", "media"]:
        table = Base.metadata.tables[table_name]
        for col in table.columns:
            assert col.name.lower() not in forbidden_content_column_names, (
                f"Table '{table_name}' contains a column named '{col.name}', "
                f"which violates the zero-plaintext content rule."
            )
