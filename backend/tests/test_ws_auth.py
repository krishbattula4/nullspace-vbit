"""Tests for WebSocket handshake authentication and connection registry."""
import uuid
from datetime import timedelta

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import app.api.ws as ws_module
from app.core.tokens import create_access_token
from app.main import app
from app.ws.registry import registry


def _create_user_and_tokens(
    client: TestClient,
    username: str = "ws_test_user",
    password: str = "P@ssword12345!",
) -> tuple[str, str, str]:
    """Register and login a test user synchronously via TestClient."""
    reg_res = client.post(
        "/auth/register",
        json={"username": username, "password": password, "display_name": username.title()},
    )
    assert reg_res.status_code == 201
    user_id = reg_res.json()["user_id"]

    login_res = client.post(
        "/auth/login",
        json={"username": username, "password": password},
    )
    assert login_res.status_code == 200
    tokens = login_res.json()
    return user_id, tokens["access_token"], tokens["refresh_token"]


def test_valid_auth_frame_registers_and_unregisters() -> None:
    """A valid AUTH frame yields AUTH_OK and registers socket; closing empties registry."""
    with TestClient(app) as client:
        user_id, access_token, _ = _create_user_and_tokens(client, "ws_user_valid")

        with client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "AUTH", "token": access_token})
            response = ws.receive_json()

            assert response == {"type": "AUTH_OK", "user_id": user_id}
            assert len(registry.get(user_id)) == 1
            assert registry.count() == 1
            assert uuid.UUID(user_id) in registry.connected_user_ids()

        # After closing the socket, registry must be empty
        assert len(registry.get(user_id)) == 0
        assert registry.count() == 0


def test_two_sockets_for_same_user_are_both_registered() -> None:
    """Two sockets for the same user are both registered; closing one leaves the other."""
    with TestClient(app) as client:
        user_id, access_token, _ = _create_user_and_tokens(client, "ws_user_multi")

        with client.websocket_connect("/ws") as ws1:
            ws1.send_json({"type": "AUTH", "token": access_token})
            ack1 = ws1.receive_json()
            assert ack1["type"] == "AUTH_OK"

            with client.websocket_connect("/ws") as ws2:
                ws2.send_json({"type": "AUTH", "token": access_token})
                ack2 = ws2.receive_json()
                assert ack2["type"] == "AUTH_OK"

                assert len(registry.get(user_id)) == 2
                assert registry.count() == 2

            # Socket 2 closed; socket 1 still active
            assert len(registry.get(user_id)) == 1
            assert registry.count() == 1

        # Both sockets closed
        assert len(registry.get(user_id)) == 0
        assert registry.count() == 0


def test_no_frame_within_timeout_closes_with_4401(monkeypatch: pytest.MonkeyPatch) -> None:
    """No frame sent within AUTH_TIMEOUT_SECONDS closes with 4401 auth_timeout."""
    monkeypatch.setattr(ws_module, "AUTH_TIMEOUT_SECONDS", 0.2)

    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect) as exc_info:
            with client.websocket_connect("/ws") as ws:
                ws.receive_json()

        assert exc_info.value.code == 4401
        assert exc_info.value.reason == "auth_timeout"
        assert registry.count() == 0


@pytest.mark.parametrize(
    ("frame_action", "expected_code", "expected_reason"),
    [
        ("non_json", 4401, "invalid_token"),
        ("wrong_type", 4401, "invalid_token"),
        ("missing_token", 4401, "invalid_token"),
        ("expired_token", 4401, "token_expired"),
        ("refresh_token", 4401, "invalid_token"),
        ("garbage_token", 4401, "invalid_token"),
        ("unknown_user_token", 4401, "invalid_token"),
    ],
)
def test_invalid_frames_close_with_4401_and_leave_registry_empty(
    frame_action: str,
    expected_code: int,
    expected_reason: str,
) -> None:
    """Non-JSON, wrong type, missing/bad/expired/refresh tokens close with 4401."""
    with TestClient(app) as client:
        user_id, access_token, refresh_token = _create_user_and_tokens(
            client, f"ws_bad_{frame_action}"
        )
        uid = uuid.UUID(user_id)

        with pytest.raises(WebSocketDisconnect) as exc_info:
            with client.websocket_connect("/ws") as ws:
                if frame_action == "non_json":
                    ws.send_text("this is not valid json")
                elif frame_action == "wrong_type":
                    ws.send_json({"type": "MESSAGE", "token": access_token})
                elif frame_action == "missing_token":
                    ws.send_json({"type": "AUTH"})
                elif frame_action == "expired_token":
                    expired = create_access_token(uid, expires_delta=timedelta(seconds=-10))
                    ws.send_json({"type": "AUTH", "token": expired})
                elif frame_action == "refresh_token":
                    ws.send_json({"type": "AUTH", "token": refresh_token})
                elif frame_action == "garbage_token":
                    ws.send_json({"type": "AUTH", "token": "not.a.real.jwt"})
                elif frame_action == "unknown_user_token":
                    orphan_token = create_access_token(uuid.uuid4())
                    ws.send_json({"type": "AUTH", "token": orphan_token})

                ws.receive_json()

        assert exc_info.value.code == expected_code
        assert exc_info.value.reason == expected_reason
        assert registry.count() == 0
        assert len(registry.get(user_id)) == 0


def test_url_query_token_is_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    """Token passed as ?token= in the URL is ignored and does not authenticate."""
    monkeypatch.setattr(ws_module, "AUTH_TIMEOUT_SECONDS", 0.2)

    with TestClient(app) as client:
        user_id, access_token, _ = _create_user_and_tokens(client, "ws_query_token_user")

        with pytest.raises(WebSocketDisconnect) as exc_info:
            with client.websocket_connect(f"/ws?token={access_token}") as ws:
                # Do not send an AUTH frame; server must ignore query string and timeout
                ws.receive_json()

        assert exc_info.value.code == 4401
        assert exc_info.value.reason == "auth_timeout"
        assert registry.count() == 0
        assert len(registry.get(user_id)) == 0
