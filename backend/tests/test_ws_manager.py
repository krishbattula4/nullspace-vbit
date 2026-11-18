"""Automated tests for WebSocket Connection Manager, heartbeat, and receive loop."""
import logging
import time
import uuid

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import app.api.ws as ws_module
from app.main import app
from app.ws.registry import ConnectionMeta, ConnectionRegistry, registry
from tests.helpers import wait_until


def _create_user_and_tokens(
    client: TestClient,
    username_prefix: str = "ws_mgr",
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


# ============================================================================
# Section A: Multiple Connections
# ============================================================================


def test_multiple_connections_per_user_isolation_and_cleanup() -> None:
    """Connect two WebSockets for the same user, verify both registered, and verify isolation."""
    with TestClient(app) as client:
        user_id, access_token, _ = _create_user_and_tokens(client, "multi_conn")

        with client.websocket_connect("/ws") as ws1:
            ws1.send_json({"type": "AUTH", "token": access_token})
            ack1 = ws1.receive_json()
            assert ack1 == {"type": "AUTH_OK", "user_id": user_id}

            with client.websocket_connect("/ws") as ws2:
                ws2.send_json({"type": "AUTH", "token": access_token})
                ack2 = ws2.receive_json()
                assert ack2 == {"type": "AUTH_OK", "user_id": user_id}

                # Both sockets registered
                assert len(registry.get(user_id)) == 2
                assert registry.count() == 2
                assert registry.is_online(user_id) is True

            # ws2 exited context and closed; ws1 must remain registered
            assert wait_until(lambda: len(registry.get(user_id)) == 1), (
                f"Expected user {user_id} sockets to be 1, got {len(registry.get(user_id))}"
            )
            assert wait_until(lambda: registry.count() == 1)
            assert registry.is_online(user_id) is True

        # Both sockets closed; user entry cleaned up
        assert wait_until(lambda: len(registry.get(user_id)) == 0)
        assert wait_until(lambda: registry.count() == 0)
        assert registry.is_online(user_id) is False


# ============================================================================
# Section B: Heartbeat
# ============================================================================


def test_heartbeat_server_sends_ping(monkeypatch: pytest.MonkeyPatch) -> None:
    """Verify that the server sends periodic PING frames to authenticated clients."""
    monkeypatch.setattr(ws_module, "HEARTBEAT_INTERVAL_SECONDS", 0.05)
    monkeypatch.setattr(ws_module, "HEARTBEAT_TIMEOUT_SECONDS", 2.0)

    with TestClient(app) as client:
        user_id, access_token, _ = _create_user_and_tokens(client, "hb_ping")

        with client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "AUTH", "token": access_token})
            ack = ws.receive_json()
            assert ack["type"] == "AUTH_OK"

            # Receive the heartbeat PING from the server
            ping_frame = ws.receive_json()
            assert ping_frame == {"type": "PING"}

        assert wait_until(lambda: registry.count() == 0)


def test_heartbeat_client_ping_receives_pong() -> None:
    """Verify that client PING frame receives a PONG frame response."""
    with TestClient(app) as client:
        user_id, access_token, _ = _create_user_and_tokens(client, "hb_pong")

        with client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "AUTH", "token": access_token})
            ack = ws.receive_json()
            assert ack["type"] == "AUTH_OK"

            # Client sends PING
            ws.send_json({"type": "PING"})
            pong_response = ws.receive_json()
            assert pong_response == {"type": "PONG"}

        assert wait_until(lambda: registry.count() == 0)


def test_heartbeat_received_frames_refresh_last_seen() -> None:
    """Verify that received frames refresh the connection's last_seen timestamp."""
    with TestClient(app) as client:
        user_id, access_token, _ = _create_user_and_tokens(client, "hb_refresh")

        with client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "AUTH", "token": access_token})
            ack = ws.receive_json()
            assert ack["type"] == "AUTH_OK"

            active_sockets = registry.get(user_id)
            assert len(active_sockets) == 1
            server_socket = active_sockets[0]

            t0 = registry.get_last_seen(server_socket)
            assert t0 is not None

            # Small delay to guarantee monotonic clock progress
            time.sleep(0.02)

            # Send a client frame to trigger touch()
            ws.send_json({"type": "PING"})
            pong = ws.receive_json()
            assert pong == {"type": "PONG"}

            t1 = registry.get_last_seen(server_socket)
            assert t1 is not None
            assert t1 > t0

        assert wait_until(lambda: registry.count() == 0)


def test_heartbeat_inactive_connection_closes_with_4408(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify that an inactive connection closes with close code 4408."""
    monkeypatch.setattr(ws_module, "HEARTBEAT_TIMEOUT_SECONDS", 0.08)
    monkeypatch.setattr(ws_module, "HEARTBEAT_INTERVAL_SECONDS", 0.04)

    with TestClient(app) as client:
        user_id, access_token, _ = _create_user_and_tokens(client, "hb_stale_close")

        with pytest.raises(WebSocketDisconnect) as exc_info:
            with client.websocket_connect("/ws") as ws:
                ws.send_json({"type": "AUTH", "token": access_token})
                ack = ws.receive_json()
                assert ack["type"] == "AUTH_OK"

                # Do not send any frames; wait for server timeout
                while True:
                    ws.receive_json()

        assert exc_info.value.code == 4408
        assert exc_info.value.reason == "heartbeat_timeout"
        assert wait_until(lambda: registry.count() == 0)


def test_heartbeat_task_cancelled_on_connection_close() -> None:
    """Verify that the per-connection heartbeat task is cancelled on connection close."""
    with TestClient(app) as client:
        user_id, access_token, _ = _create_user_and_tokens(client, "hb_cancel")

        with client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "AUTH", "token": access_token})
            ack = ws.receive_json()
            assert ack["type"] == "AUTH_OK"

            server_socket = registry.get(user_id)[0]
            heartbeat_task = getattr(server_socket.state, "heartbeat_task", None)
            assert heartbeat_task is not None
            assert not heartbeat_task.done()

        # After client context exit, heartbeat task must be finished / cancelled
        assert wait_until(lambda: heartbeat_task.done())
        assert heartbeat_task.done()
        assert wait_until(lambda: registry.count() == 0)


# ============================================================================
# Section C: Stale Connections
# ============================================================================


def test_stale_identifies_inactive_sockets_unit() -> None:
    """Verify stale(timeout) identifies inactive sockets and ignores active ones."""
    reg = ConnectionRegistry()
    uid = uuid.uuid4()
    ws_active = object()  # type: ignore[assignment]
    ws_inactive = object()  # type: ignore[assignment]

    reg.add(uid, ws_active)
    reg.add(uid, ws_inactive)

    now = time.monotonic()
    # Active socket seen just now
    reg.touch(ws_active, timestamp=now)
    # Inactive socket seen 100 seconds ago
    reg.touch(ws_inactive, timestamp=now - 100.0)

    stale_connections = reg.stale(timeout=30.0)
    assert ws_inactive in stale_connections
    assert ws_active not in stale_connections

    # Refresh inactive socket; it should no longer be marked stale
    reg.touch(ws_inactive, timestamp=time.monotonic())
    assert ws_inactive not in reg.stale(timeout=30.0)


def test_dead_connections_cleaned_up_within_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    """Verify dead connections are cleaned up within the configured timeout."""
    monkeypatch.setattr(ws_module, "HEARTBEAT_TIMEOUT_SECONDS", 0.08)
    monkeypatch.setattr(ws_module, "HEARTBEAT_INTERVAL_SECONDS", 0.04)

    with TestClient(app) as client:
        user_id, access_token, _ = _create_user_and_tokens(client, "dead_conn")

        with pytest.raises(WebSocketDisconnect) as exc_info:
            with client.websocket_connect("/ws") as ws:
                ws.send_json({"type": "AUTH", "token": access_token})
                ack = ws.receive_json()
                assert ack["type"] == "AUTH_OK"
                assert registry.count() == 1

                # Wait for timeout disconnect
                while True:
                    ws.receive_json()

        assert exc_info.value.code == 4408
        # Dead connection must be cleaned up from registry
        assert wait_until(lambda: registry.count() == 0)
        assert wait_until(lambda: not registry.is_online(user_id))


# ============================================================================
# Section D: Broadcast (send_to_user)
# ============================================================================


@pytest.mark.asyncio
async def test_send_to_user_broadcast_and_failure_resilience() -> None:
    """Verify send_to_user broadcasts to all user sockets and handles single-socket failure."""
    reg = ConnectionRegistry()
    uid = uuid.uuid4()

    class MockAsyncSocket:
        def __init__(self, should_fail: bool = False) -> None:
            self.should_fail = should_fail
            self.received_messages: list[dict[str, str]] = []
            self.closed = False

        async def send_json(self, payload: dict[str, str]) -> None:
            if self.should_fail:
                raise RuntimeError("Socket transmission pipe broken")
            self.received_messages.append(payload)

        async def close(self, code: int = 1000, reason: str = "") -> None:
            self.closed = True

    ws_healthy_1 = MockAsyncSocket(should_fail=False)
    ws_failing = MockAsyncSocket(should_fail=True)
    ws_healthy_2 = MockAsyncSocket(should_fail=False)

    reg.add(uid, ws_healthy_1)  # type: ignore[arg-type]
    reg.add(uid, ws_failing)  # type: ignore[arg-type]
    reg.add(uid, ws_healthy_2)  # type: ignore[arg-type]

    assert len(reg.get(uid)) == 3
    assert reg.is_online(uid) is True

    payload = {"type": "BROADCAST", "message": "hello everyone"}
    successful_sends = await reg.send_to_user(uid, payload)

    # 2 out of 3 sockets succeeded
    assert successful_sends == 2

    # Failed socket was removed and closed
    current_sockets = reg.get(uid)
    assert ws_failing not in current_sockets
    assert ws_failing.closed is True

    # Other sockets remain registered and received payload
    assert ws_healthy_1 in current_sockets
    assert ws_healthy_2 in current_sockets
    assert ws_healthy_1.received_messages == [payload]
    assert ws_healthy_2.received_messages == [payload]
    assert reg.is_online(uid) is True


@pytest.mark.asyncio
async def test_send_to_user_nonexistent_or_invalid_user() -> None:
    """Verify send_to_user returns 0 for non-existent or invalid user ID."""
    reg = ConnectionRegistry()
    assert await reg.send_to_user(uuid.uuid4(), {"type": "PING"}) == 0
    assert await reg.send_to_user("invalid-uuid", {"type": "PING"}) == 0


# ============================================================================
# Section E: Message Handling
# ============================================================================


def test_message_handling_oversized_frame_closes_1009() -> None:
    """Verify that an oversized frame closes the connection with code 1009."""
    with TestClient(app) as client:
        user_id, access_token, _ = _create_user_and_tokens(client, "oversized")

        with pytest.raises(WebSocketDisconnect) as exc_info:
            with client.websocket_connect("/ws") as ws:
                ws.send_json({"type": "AUTH", "token": access_token})
                ack = ws.receive_json()
                assert ack["type"] == "AUTH_OK"

                # Send frame larger than 65536 bytes
                oversized_payload = "A" * 70000
                ws.send_text(oversized_payload)
                ws.receive_json()

        assert exc_info.value.code == 1009
        assert exc_info.value.reason == "message_too_big"
        assert wait_until(lambda: registry.count() == 0)


def test_message_handling_binary_frames_ignored() -> None:
    """Verify that binary frames are ignored without closing or crashing the socket."""
    with TestClient(app) as client:
        user_id, access_token, _ = _create_user_and_tokens(client, "binary_ignore")

        with client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "AUTH", "token": access_token})
            ack = ws.receive_json()
            assert ack["type"] == "AUTH_OK"

            # Send binary frame
            ws.send_bytes(b"\x00\x01\x02\x03\x04")

            # Verify connection is still alive by sending client PING and getting PONG
            ws.send_json({"type": "PING"})
            pong = ws.receive_json()
            assert pong == {"type": "PONG"}

        assert wait_until(lambda: registry.count() == 0)


def test_message_handling_unknown_message_types_ignored() -> None:
    """Verify that unknown message types and non-JSON text are safely ignored."""
    with TestClient(app) as client:
        user_id, access_token, _ = _create_user_and_tokens(client, "unknown_type")

        with client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "AUTH", "token": access_token})
            ack = ws.receive_json()
            assert ack["type"] == "AUTH_OK"

            # Send unknown message type
            ws.send_json({"type": "FUTURE_UNKNOWN_TYPE", "payload": "xyz"})

            # Send non-JSON text
            ws.send_text("this is not json at all")

            # Send non-dict JSON
            ws.send_text("[1, 2, 3]")

            # Connection remains open; PING returns PONG
            ws.send_json({"type": "PING"})
            pong = ws.receive_json()
            assert pong == {"type": "PONG"}

        assert wait_until(lambda: registry.count() == 0)


def test_message_handling_disconnect_event_handled_cleanly() -> None:
    """Verify normal client disconnect events are handled cleanly without error."""
    with TestClient(app) as client:
        user_id, access_token, _ = _create_user_and_tokens(client, "normal_disc")

        with client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "AUTH", "token": access_token})
            ack = ws.receive_json()
            assert ack["type"] == "AUTH_OK"
            assert registry.count() == 1
            ws.close()

        assert wait_until(lambda: registry.count() == 0)
        assert registry.is_online(user_id) is False


def test_message_handling_unexpected_exception_closes_1011(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify that unexpected exceptions close connection with code 1011."""
    with TestClient(app) as client:
        user_id, access_token, _ = _create_user_and_tokens(client, "unexpected_err")

        with pytest.raises(WebSocketDisconnect) as exc_info:
            with client.websocket_connect("/ws") as ws:
                ws.send_json({"type": "AUTH", "token": access_token})
                ack = ws.receive_json()
                assert ack["type"] == "AUTH_OK"

                # Monkeypatch registry.touch to trigger an unexpected exception in receive loop
                def _broken_touch(*args: object, **kwargs: object) -> None:
                    raise RuntimeError("Simulated internal catastrophic error")

                monkeypatch.setattr(registry, "touch", _broken_touch)

                # Send a frame to trigger the unexpected exception
                ws.send_json({"type": "PING"})
                ws.receive_json()

        assert exc_info.value.code == 1011
        assert exc_info.value.reason == "internal_error"
        assert wait_until(lambda: registry.count() == 0)


def test_message_handling_no_frame_contents_written_to_logs(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Verify that WebSocket frame contents and plaintext payloads are never written to logs."""
    sensitive_token = f"CANARY_SECRET_DATA_{uuid.uuid4().hex}"

    with caplog.at_level(logging.DEBUG):
        with TestClient(app) as client:
            user_id, access_token, _ = _create_user_and_tokens(client, "no_log")

            with client.websocket_connect("/ws") as ws:
                ws.send_json({"type": "AUTH", "token": access_token})
                ack = ws.receive_json()
                assert ack["type"] == "AUTH_OK"

                # Send secret payload
                ws.send_json({"type": "SECRET_FRAME", "payload": sensitive_token})

                # Normal ping/pong
                ws.send_json({"type": "PING"})
                ws.receive_json()

    # Verify sensitive token is completely absent from all captured log output
    assert sensitive_token not in caplog.text
    assert "SECRET_FRAME" not in caplog.text


def test_connection_registry_additional_metadata_coverage() -> None:
    """Test get_metadata, get_connected_at, get_user_id, and ConnectionMeta properties."""
    reg = ConnectionRegistry()
    uid = uuid.uuid4()
    mock_ws = object()  # type: ignore[assignment]

    assert reg.get_metadata(mock_ws) is None
    assert reg.get_last_seen(mock_ws) is None
    assert reg.get_connected_at(mock_ws) is None
    assert reg.get_user_id(mock_ws) is None

    reg.add(uid, mock_ws)

    meta = reg.get_metadata(mock_ws)
    assert isinstance(meta, ConnectionMeta)
    assert meta.user_id == uid
    assert isinstance(meta.connected_at, float)
    assert isinstance(meta.last_seen, float)
    assert reg.get_connected_at(mock_ws) == meta.connected_at
    assert reg.get_last_seen(mock_ws) == meta.last_seen
    assert reg.get_user_id(mock_ws) == uid

    # Test single-argument removal: reg.remove(mock_ws)
    reg.remove(mock_ws)
    assert reg.get(uid) == []
    assert reg.count() == 0
    assert reg.get_metadata(mock_ws) is None
