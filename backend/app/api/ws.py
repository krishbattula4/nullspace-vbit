"""WebSocket endpoint, handshake authentication, and connection heartbeat."""
import asyncio
import json
import logging
import time
import uuid

from fastapi import APIRouter, WebSocket
from sqlalchemy import select
from starlette.websockets import WebSocketDisconnect

from app.core.config import get_settings
from app.core.db import get_session_factory
from app.core.tokens import TokenError, TokenExpired, TokenInvalid, decode_token
from app.models.user import User
from app.ws.registry import registry

AUTH_TIMEOUT_SECONDS: float = 5.0
HEARTBEAT_INTERVAL_SECONDS: float = 30.0
HEARTBEAT_TIMEOUT_SECONDS: float = 60.0

router = APIRouter(tags=["websocket"])
log = logging.getLogger("nullspace.ws")


async def _heartbeat_loop(websocket: WebSocket) -> None:
    """Send periodic PING frames to keep the connection alive.

    Reads HEARTBEAT_INTERVAL_SECONDS and HEARTBEAT_TIMEOUT_SECONDS at call time
    to support runtime monkeypatching in tests without cached values.
    """
    try:
        while True:
            interval = HEARTBEAT_INTERVAL_SECONDS
            await asyncio.sleep(interval)

            timeout = HEARTBEAT_TIMEOUT_SECONDS
            last_seen = registry.get_last_seen(websocket)
            if last_seen is not None and (time.monotonic() - last_seen) >= timeout:
                try:
                    await websocket.close(code=4408, reason="heartbeat_timeout")
                except Exception:
                    pass
                break

            await websocket.send_json({"type": "PING"})
    except asyncio.CancelledError:
        raise
    except Exception:
        # Socket was closed or disconnected during heartbeat send
        pass


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """Authenticate and maintain WebSocket connection.

    The connection is accepted immediately. Authentication credentials must be
    transmitted in the first frame within AUTH_TIMEOUT_SECONDS.

    Security Note: We do NOT accept the token in the URL query string (e.g. ?token=...),
    because URLs end up in web server access logs, reverse proxy logs, and browser
    history. Passing credentials in the query string is an anti-pattern.
    """
    await websocket.accept()

    try:
        raw_message = await asyncio.wait_for(
            websocket.receive_text(),
            timeout=AUTH_TIMEOUT_SECONDS,
        )
    except TimeoutError:
        await websocket.close(code=4401, reason="auth_timeout")
        return
    except WebSocketDisconnect:
        return
    except Exception:  # pragma: no cover - defensive catch for unexpected receive errors
        await websocket.close(code=4401, reason="invalid_token")
        return

    try:
        data = json.loads(raw_message)
    except Exception:
        await websocket.close(code=4401, reason="invalid_token")
        return

    if not isinstance(data, dict):
        await websocket.close(code=4401, reason="invalid_token")
        return

    if data.get("type") != "AUTH":
        await websocket.close(code=4401, reason="invalid_token")
        return

    token = data.get("token")
    if not isinstance(token, str) or not token:
        await websocket.close(code=4401, reason="invalid_token")
        return

    try:
        claims = decode_token(token, expected_type="access")
    except TokenExpired:
        await websocket.close(code=4401, reason="token_expired")
        return
    except (TokenInvalid, TokenError, Exception):
        await websocket.close(code=4401, reason="invalid_token")
        return

    try:
        sub = claims.get("sub")
        user_id = uuid.UUID(str(sub))
    except (ValueError, TypeError):
        await websocket.close(code=4401, reason="invalid_token")
        return

    # Do not hold a database session open for the lifetime of the connection:
    # open a session only to look the user up, then release it immediately.
    async with get_session_factory()() as db:
        stmt = select(User).where(User.user_id == user_id)
        res = await db.execute(stmt)
        user = res.scalar_one_or_none()

    if user is None:
        await websocket.close(code=4401, reason="invalid_token")
        return

    registry.add(user.user_id, websocket)
    heartbeat_task: asyncio.Task[None] | None = None
    try:
        await websocket.send_json({"type": "AUTH_OK", "user_id": str(user.user_id)})
        heartbeat_task = asyncio.create_task(_heartbeat_loop(websocket))
        websocket.state.heartbeat_task = heartbeat_task

        while True:
            timeout = HEARTBEAT_TIMEOUT_SECONDS
            try:
                message = await asyncio.wait_for(websocket.receive(), timeout=timeout)
            except TimeoutError:
                try:
                    await websocket.close(code=4408, reason="heartbeat_timeout")
                except Exception:
                    pass
                break

            if message["type"] == "websocket.disconnect":
                break

            # Refresh last_seen whenever any frame is received
            registry.touch(websocket)

            # Check incoming message size against max_message_bytes
            raw_text = message.get("text")
            raw_bytes = message.get("bytes")

            if raw_bytes is not None:
                frame_bytes_len = len(raw_bytes)
            elif raw_text is not None:
                frame_bytes_len = len(raw_text.encode("utf-8"))
            else:
                frame_bytes_len = 0

            max_bytes = get_settings().max_message_bytes
            if frame_bytes_len > max_bytes:
                try:
                    await websocket.close(code=1009, reason="message_too_big")
                except Exception:
                    pass
                break

            # Ignore binary frames
            if raw_bytes is not None:
                continue

            # Process text frame
            if raw_text is not None:
                try:
                    payload = json.loads(raw_text)
                except Exception:
                    # Ignore malformed non-JSON text frames
                    continue

                if not isinstance(payload, dict):
                    continue

                msg_type = payload.get("type")
                if msg_type == "PING":
                    await websocket.send_json({"type": "PONG"})
                elif msg_type == "PONG":
                    pass
                else:
                    # Ignore unknown message types
                    pass

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log.error("Unexpected error in WebSocket connection: %s", exc)
        try:
            await websocket.close(code=1011, reason="internal_error")
        except Exception:
            pass
    finally:
        if heartbeat_task is not None:
            heartbeat_task.cancel()
            try:
                await heartbeat_task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass
        registry.remove(user.user_id, websocket)
