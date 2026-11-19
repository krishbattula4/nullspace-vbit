"""Automated tests for WebSocket Message Router, persistence, delivery, and idempotency."""
import base64
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.testclient import TestClient

from app.main import app
from app.models.conversation import Conversation
from app.models.message import Message, MessageStatus
from app.models.message_version import MessageVersion, VersionAction
from app.ws.registry import registry


def _create_user_and_tokens(
    client: TestClient,
    username_prefix: str = "ws_router",
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


# ============================================================================
# Test 1 — Successful recipient delivery
# ============================================================================


async def test_message_routing_successful_recipient_delivery(
    db_session: AsyncSession,
) -> None:
    """Sender sends MESSAGE; recipient receives MESSAGE; sender gets ACK; DB stores bytes."""
    with TestClient(app) as client:
        uid_a, token_a, _ = _create_user_and_tokens(client, "alice_route")
        uid_b, token_b, _ = _create_user_and_tokens(client, "bob_route")

        conv = await _create_conversation(db_session, uuid.UUID(uid_a), uuid.UUID(uid_b))

        raw_payload = b"encrypted_secret_payload_alice_to_bob_v1"
        b64_body = base64.b64encode(raw_payload).decode("ascii")
        client_msg_id = str(uuid.uuid4())

        with client.websocket_connect("/ws") as ws_a:
            ws_a.send_json({"type": "AUTH", "token": token_a})
            assert ws_a.receive_json()["type"] == "AUTH_OK"

            with client.websocket_connect("/ws") as ws_b:
                ws_b.send_json({"type": "AUTH", "token": token_b})
                assert ws_b.receive_json()["type"] == "AUTH_OK"

                msg_frame = {
                    "v": 1,
                    "type": "MESSAGE",
                    "conversation_id": str(conv.id),
                    "client_msg_id": client_msg_id,
                    "ctype": 1,
                    "body": b64_body,
                }
                ws_a.send_json(msg_frame)

                # Sender A receives ACK
                ack = ws_a.receive_json()
                assert ack["type"] == "ACK"
                assert ack["v"] == 1
                assert ack["client_msg_id"] == client_msg_id
                assert ack["status"] == "SENT"
                server_msg_id = ack["message_id"]

                # Recipient B receives MESSAGE frame
                delivered = ws_b.receive_json()
                assert delivered["type"] == "MESSAGE"
                assert delivered["v"] == 1
                assert delivered["message_id"] == server_msg_id
                assert delivered["conversation_id"] == str(conv.id)
                assert delivered["sender_id"] == uid_a
                assert delivered["version_no"] == 1
                assert delivered["ctype"] == 1
                assert delivered["body"] == b64_body
                assert "created_at" in delivered

        # Verify DB records
        stmt_msg = select(Message).where(Message.id == uuid.UUID(server_msg_id))
        msg_rows = list((await db_session.execute(stmt_msg)).scalars().all())
        assert len(msg_rows) == 1
        msg = msg_rows[0]
        assert msg.conversation_id == conv.id
        assert msg.sender_id == uuid.UUID(uid_a)
        assert msg.client_msg_id == uuid.UUID(client_msg_id)
        assert msg.current_version == 1
        assert msg.status == MessageStatus.SENT

        stmt_ver = select(MessageVersion).where(MessageVersion.message_id == msg.id)
        ver_rows = list((await db_session.execute(stmt_ver)).scalars().all())
        assert len(ver_rows) == 1
        ver = ver_rows[0]
        assert ver.version_no == 1
        assert ver.ctype == 1
        assert ver.action == VersionAction.CREATE
        assert ver.actor_id == uuid.UUID(uid_a)
        assert ver.ciphertext == raw_payload


# ============================================================================
# Test 2 — Offline recipient
# ============================================================================


async def test_message_routing_offline_recipient_queued(
    db_session: AsyncSession,
) -> None:
    """Sender sends MESSAGE to offline recipient; ACK status is QUEUED; DB rows exist."""
    with TestClient(app) as client:
        uid_a, token_a, _ = _create_user_and_tokens(client, "alice_off")
        uid_b, _, _ = _create_user_and_tokens(client, "bob_off")

        conv = await _create_conversation(db_session, uuid.UUID(uid_a), uuid.UUID(uid_b))
        assert not registry.is_online(uid_b)

        client_msg_id = str(uuid.uuid4())
        raw_payload = b"queued_payload_for_offline_recipient"
        b64_body = base64.b64encode(raw_payload).decode("ascii")

        with client.websocket_connect("/ws") as ws_a:
            ws_a.send_json({"type": "AUTH", "token": token_a})
            assert ws_a.receive_json()["type"] == "AUTH_OK"

            msg_frame = {
                "v": 1,
                "type": "MESSAGE",
                "conversation_id": str(conv.id),
                "client_msg_id": client_msg_id,
                "ctype": 3,
                "body": b64_body,
            }
            ws_a.send_json(msg_frame)

            ack = ws_a.receive_json()
            assert ack["type"] == "ACK"
            assert ack["client_msg_id"] == client_msg_id
            assert ack["status"] == "QUEUED"
            server_msg_id = ack["message_id"]

        # Verify DB rows exist with QUEUED status
        stmt_msg = select(Message).where(Message.id == uuid.UUID(server_msg_id))
        msg = (await db_session.execute(stmt_msg)).scalar_one()
        assert msg.status == MessageStatus.QUEUED

        stmt_ver = select(MessageVersion).where(MessageVersion.message_id == msg.id)
        ver = (await db_session.execute(stmt_ver)).scalar_one()
        assert ver.ciphertext == raw_payload
        assert ver.version_no == 1
        assert ver.action == VersionAction.CREATE


# ============================================================================
# Test 3 — Duplicate client_msg_id
# ============================================================================


async def test_message_routing_duplicate_client_msg_id_idempotency(
    db_session: AsyncSession,
) -> None:
    """Same client_msg_id sent twice yields identical server message_id and no duplicate rows."""
    with TestClient(app) as client:
        uid_a, token_a, _ = _create_user_and_tokens(client, "alice_dup")
        uid_b, token_b, _ = _create_user_and_tokens(client, "bob_dup")

        conv = await _create_conversation(db_session, uuid.UUID(uid_a), uuid.UUID(uid_b))
        client_msg_id = str(uuid.uuid4())
        b64_body = base64.b64encode(b"idempotency_test_payload").decode("ascii")

        with client.websocket_connect("/ws") as ws_a:
            ws_a.send_json({"type": "AUTH", "token": token_a})
            assert ws_a.receive_json()["type"] == "AUTH_OK"

            with client.websocket_connect("/ws") as ws_b:
                ws_b.send_json({"type": "AUTH", "token": token_b})
                assert ws_b.receive_json()["type"] == "AUTH_OK"

                msg_frame = {
                    "v": 1,
                    "type": "MESSAGE",
                    "conversation_id": str(conv.id),
                    "client_msg_id": client_msg_id,
                    "ctype": 1,
                    "body": b64_body,
                }

                # First transmission
                ws_a.send_json(msg_frame)
                ack1 = ws_a.receive_json()
                assert ack1["type"] == "ACK"
                assert ack1["status"] == "SENT"
                server_msg_id_1 = ack1["message_id"]

                delivered = ws_b.receive_json()
                assert delivered["type"] == "MESSAGE"
                assert delivered["message_id"] == server_msg_id_1

                # Second transmission with exact same client_msg_id
                ws_a.send_json(msg_frame)
                ack2 = ws_a.receive_json()
                assert ack2["type"] == "ACK"
                assert ack2["status"] == "SENT"
                assert ack2["message_id"] == server_msg_id_1

                # Verify ws_b did NOT receive any second message (check with PING/PONG)
                ws_b.send_json({"type": "PING"})
                assert ws_b.receive_json() == {"type": "PONG"}

        # Verify only one Message and one MessageVersion row exist
        stmt_msg = select(Message).where(Message.sender_id == uuid.UUID(uid_a))
        msgs = list((await db_session.execute(stmt_msg)).scalars().all())
        assert len(msgs) == 1

        stmt_ver = select(MessageVersion).where(MessageVersion.message_id == msgs[0].id)
        vers = list((await db_session.execute(stmt_ver)).scalars().all())
        assert len(vers) == 1


# ============================================================================
# Test 4 — Sender outside conversation
# ============================================================================


async def test_message_routing_sender_outside_conversation_rejected(
    db_session: AsyncSession,
) -> None:
    """Non-participant sender receives ERROR conversation_not_found; no rows or delivery."""
    with TestClient(app) as client:
        uid_a, _, _ = _create_user_and_tokens(client, "alice_out")
        uid_b, token_b, _ = _create_user_and_tokens(client, "bob_out")
        uid_c, token_c, _ = _create_user_and_tokens(client, "charlie_out")

        # Conversation exists between Alice and Bob
        conv = await _create_conversation(db_session, uuid.UUID(uid_a), uuid.UUID(uid_b))
        client_msg_id = str(uuid.uuid4())
        b64_body = base64.b64encode(b"intruder_message_payload").decode("ascii")

        with client.websocket_connect("/ws") as ws_b:
            ws_b.send_json({"type": "AUTH", "token": token_b})
            assert ws_b.receive_json()["type"] == "AUTH_OK"

            with client.websocket_connect("/ws") as ws_c:
                ws_c.send_json({"type": "AUTH", "token": token_c})
                assert ws_c.receive_json()["type"] == "AUTH_OK"

                # Charlie (not participant) sends MESSAGE for Alice-Bob conv
                msg_frame = {
                    "v": 1,
                    "type": "MESSAGE",
                    "conversation_id": str(conv.id),
                    "client_msg_id": client_msg_id,
                    "ctype": 1,
                    "body": b64_body,
                }
                ws_c.send_json(msg_frame)

                # Charlie receives ERROR conversation_not_found
                err = ws_c.receive_json()
                assert err["type"] == "ERROR"
                assert err["code"] == "conversation_not_found"
                assert err.get("client_msg_id") == client_msg_id

                # Bob receives nothing: verify via PING
                ws_b.send_json({"type": "PING"})
                assert ws_b.receive_json() == {"type": "PONG"}

        # Verify no Message or MessageVersion was inserted
        stmt_msg = select(Message).where(Message.client_msg_id == uuid.UUID(client_msg_id))
        msgs = list((await db_session.execute(stmt_msg)).scalars().all())
        assert len(msgs) == 0


# ============================================================================
# Test 5 — Invalid envelope keeps connection alive
# ============================================================================


def test_message_routing_invalid_envelope_keeps_connection_alive() -> None:
    """Invalid text frame yields ERROR frame and connection remains open for PING/PONG."""
    with TestClient(app) as client:
        _, token, _ = _create_user_and_tokens(client, "alice_inv")

        with client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "AUTH", "token": token})
            assert ws.receive_json()["type"] == "AUTH_OK"

            # Send invalid envelope (invalid UUID and invalid ctype)
            bad_frame = {
                "v": 1,
                "type": "MESSAGE",
                "conversation_id": "not-a-valid-uuid",
                "client_msg_id": "not-a-valid-uuid",
                "ctype": 99,
                "body": "AQID",
            }
            ws.send_json(bad_frame)

            err = ws.receive_json()
            assert err["type"] == "ERROR"
            assert err["code"] == "invalid_frame"

            # Connection remains open and responds to PING
            ws.send_json({"type": "PING"})
            pong = ws.receive_json()
            assert pong == {"type": "PONG"}


# ============================================================================
# Test 6 — Sender with multiple tabs
# ============================================================================


async def test_message_routing_sender_multiple_tabs_ack_isolation(
    db_session: AsyncSession,
) -> None:
    """When sender has 2 tabs, ACK is sent only to submitting tab; recipient gets MESSAGE."""
    with TestClient(app) as client:
        uid_a, token_a, _ = _create_user_and_tokens(client, "alice_tabs")
        uid_b, token_b, _ = _create_user_and_tokens(client, "bob_tabs")

        conv = await _create_conversation(db_session, uuid.UUID(uid_a), uuid.UUID(uid_b))
        client_msg_id = str(uuid.uuid4())
        b64_body = base64.b64encode(b"multi_tab_message_payload").decode("ascii")

        with client.websocket_connect("/ws") as ws_a1:
            ws_a1.send_json({"type": "AUTH", "token": token_a})
            assert ws_a1.receive_json()["type"] == "AUTH_OK"

            with client.websocket_connect("/ws") as ws_a2:
                ws_a2.send_json({"type": "AUTH", "token": token_a})
                assert ws_a2.receive_json()["type"] == "AUTH_OK"

                with client.websocket_connect("/ws") as ws_b:
                    ws_b.send_json({"type": "AUTH", "token": token_b})
                    assert ws_b.receive_json()["type"] == "AUTH_OK"

                    # Tab 1 sends MESSAGE
                    msg_frame = {
                        "v": 1,
                        "type": "MESSAGE",
                        "conversation_id": str(conv.id),
                        "client_msg_id": client_msg_id,
                        "ctype": 1,
                        "body": b64_body,
                    }
                    ws_a1.send_json(msg_frame)

                    # Tab 1 receives ACK
                    ack = ws_a1.receive_json()
                    assert ack["type"] == "ACK"
                    assert ack["client_msg_id"] == client_msg_id
                    server_msg_id = ack["message_id"]

                    # Tab 2 must NOT receive this ACK: verify via PING
                    ws_a2.send_json({"type": "PING"})
                    assert ws_a2.receive_json() == {"type": "PONG"}

                    # Recipient B receives MESSAGE frame
                    delivered = ws_b.receive_json()
                    assert delivered["type"] == "MESSAGE"
                    assert delivered["message_id"] == server_msg_id


# ============================================================================
# Additional Coverage Tests
# ============================================================================


async def test_message_routing_unknown_conversation_uuid_returns_error() -> None:
    """MESSAGE for completely non-existent conversation returns conversation_not_found."""
    with TestClient(app) as client:
        _, token, _ = _create_user_and_tokens(client, "alice_unk_c")

        with client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "AUTH", "token": token})
            assert ws.receive_json()["type"] == "AUTH_OK"

            random_conv_id = str(uuid.uuid4())
            msg_frame = {
                "v": 1,
                "type": "MESSAGE",
                "conversation_id": random_conv_id,
                "client_msg_id": str(uuid.uuid4()),
                "ctype": 1,
                "body": base64.b64encode(b"payload").decode("ascii"),
            }
            ws.send_json(msg_frame)

            err = ws.receive_json()
            assert err["type"] == "ERROR"
            assert err["code"] == "conversation_not_found"


def test_message_routing_unsupported_protocol_version() -> None:
    """Envelope with unsupported version returns unsupported_version and socket stays open."""
    with TestClient(app) as client:
        _, token, _ = _create_user_and_tokens(client, "alice_bad_v")

        with client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "AUTH", "token": token})
            assert ws.receive_json()["type"] == "AUTH_OK"

            bad_version_frame = {
                "v": 2,
                "type": "MESSAGE",
                "conversation_id": str(uuid.uuid4()),
                "client_msg_id": str(uuid.uuid4()),
                "ctype": 1,
                "body": "AQID",
            }
            ws.send_json(bad_version_frame)

            err = ws.receive_json()
            assert err["type"] == "ERROR"
            assert err["code"] == "unsupported_version"

            # Verify connection stays alive
            ws.send_json({"type": "PING"})
            assert ws.receive_json() == {"type": "PONG"}
