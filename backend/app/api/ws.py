"""WebSocket endpoint and handshake authentication."""
import asyncio
import json
import logging
import uuid

from fastapi import APIRouter, WebSocket
from sqlalchemy import select
from starlette.websockets import WebSocketDisconnect

from app.core.db import get_session_factory
from app.core.tokens import TokenError, TokenExpired, TokenInvalid, decode_token
from app.models.user import User
from app.ws.registry import registry

AUTH_TIMEOUT_SECONDS: float = 5.0

router = APIRouter(tags=["websocket"])
log = logging.getLogger("nullspace.ws")


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
    except Exception:
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
    try:
        await websocket.send_json({"type": "AUTH_OK", "user_id": str(user.user_id)})
        while True:
            # Message handling arrives in task P2.3; frames are ignored for now
            await websocket.receive()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        registry.remove(user.user_id, websocket)
