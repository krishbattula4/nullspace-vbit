"""In-memory WebSocket connection registry."""
from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass
from typing import Any

from starlette.websockets import WebSocket


@dataclass
class ConnectionMeta:
    """Metadata tracked per active WebSocket connection."""

    connected_at: float
    last_seen: float
    user_id: uuid.UUID | None = None


class ConnectionRegistry:
    """Tracks active WebSocket connections keyed by user ID."""

    def __init__(self) -> None:
        self._connections: dict[uuid.UUID, set[WebSocket]] = {}
        self._meta: dict[WebSocket, ConnectionMeta] = {}
        self._socket_to_user: dict[WebSocket, uuid.UUID] = {}

    def _normalize(self, user_id: uuid.UUID | str) -> uuid.UUID:
        if isinstance(user_id, uuid.UUID):
            return user_id
        return uuid.UUID(str(user_id))

    def add(self, user_id: uuid.UUID | str, websocket: WebSocket) -> None:
        """Register a websocket connection for a user."""
        uid = self._normalize(user_id)
        if uid not in self._connections:
            self._connections[uid] = set()
        self._connections[uid].add(websocket)

        now = time.monotonic()
        if websocket not in self._meta:
            self._meta[websocket] = ConnectionMeta(
                connected_at=now,
                last_seen=now,
                user_id=uid,
            )
        self._socket_to_user[websocket] = uid

    def remove(
        self,
        user_id: uuid.UUID | str | WebSocket | None,
        websocket: WebSocket | None = None,
    ) -> None:
        """Remove a websocket connection for a user."""
        # Support single-argument call: remove(websocket)
        if websocket is None and user_id is not None:
            target_ws = user_id  # type: ignore[assignment]
            target_uid = self._socket_to_user.get(target_ws)  # type: ignore[arg-type]
            if target_uid is not None:
                self.remove(target_uid, target_ws)
            else:
                self._meta.pop(target_ws, None)  # type: ignore[call-overload]
            return

        if websocket is None:
            return

        try:
            uid = self._normalize(user_id)  # type: ignore[arg-type]
        except (ValueError, TypeError):
            return

        if uid in self._connections:
            self._connections[uid].discard(websocket)
            if not self._connections[uid]:
                del self._connections[uid]

        self._meta.pop(websocket, None)
        self._socket_to_user.pop(websocket, None)

    def get(self, user_id: uuid.UUID | str) -> list[WebSocket]:
        """Return a copy of active sockets for a user."""
        try:
            uid = self._normalize(user_id)
        except (ValueError, TypeError):
            return []
        return list(self._connections.get(uid, set()))

    def count(self) -> int:
        """Return the total number of connected sockets across all users."""
        return sum(len(sockets) for sockets in self._connections.values())

    def connected_user_ids(self) -> set[uuid.UUID]:
        """Return the set of user IDs with at least one active connection."""
        return set(self._connections.keys())

    def is_online(self, user_id: uuid.UUID | str) -> bool:
        """Check whether a user has at least one active connection."""
        try:
            uid = self._normalize(user_id)
        except (ValueError, TypeError):
            return False
        return uid in self._connections and len(self._connections[uid]) > 0

    def touch(
        self,
        websocket_or_user_id: Any,
        websocket: WebSocket | None = None,
        timestamp: float | None = None,
    ) -> None:
        """Refresh last_seen timestamp for an active connection."""
        if websocket is not None:
            target_ws = websocket
        elif isinstance(websocket_or_user_id, WebSocket) or websocket_or_user_id in self._meta:
            target_ws = websocket_or_user_id
        else:
            target_ws = websocket_or_user_id

        now = time.monotonic() if timestamp is None else timestamp
        if target_ws in self._meta:
            self._meta[target_ws].last_seen = now

    def stale(self, timeout: float) -> list[WebSocket]:
        """Identify connections that have exceeded the specified inactivity timeout."""
        now = time.monotonic()
        return [ws for ws, meta in self._meta.items() if (now - meta.last_seen) > timeout]

    def get_last_seen(self, websocket: WebSocket) -> float | None:
        """Return last_seen timestamp for a socket, or None if not registered."""
        meta = self._meta.get(websocket)
        return meta.last_seen if meta else None

    def get_connected_at(self, websocket: WebSocket) -> float | None:
        """Return connected_at timestamp for a socket, or None if not registered."""
        meta = self._meta.get(websocket)
        return meta.connected_at if meta else None

    def get_metadata(self, websocket: WebSocket) -> ConnectionMeta | None:
        """Return metadata for a socket, or None if not registered."""
        return self._meta.get(websocket)

    def get_user_id(self, websocket: WebSocket) -> uuid.UUID | None:
        """Return user_id associated with a socket, or None if not registered."""
        return self._socket_to_user.get(websocket)

    async def send_to_user(self, user_id: uuid.UUID | str, payload: Any) -> int:
        """Send payload to every active socket belonging to the specified user.

        Returns the number of sockets that successfully received the message.
        If one socket fails to send, removes that socket but continues sending
        to all remaining sockets.
        """
        try:
            uid = self._normalize(user_id)
        except (ValueError, TypeError):
            return 0

        sockets = self.get(uid)
        if not sockets:
            return 0

        successful_sends = 0
        failed_sockets: list[WebSocket] = []

        for ws in sockets:
            try:
                if isinstance(payload, str):
                    await ws.send_text(payload)
                elif isinstance(payload, bytes):
                    await ws.send_bytes(payload)
                else:
                    await ws.send_json(payload)
                successful_sends += 1
            except Exception:
                failed_sockets.append(ws)

        for ws in failed_sockets:
            self.remove(uid, ws)
            try:
                if hasattr(ws, "close"):
                    close_coro = ws.close()
                    if asyncio.iscoroutine(close_coro):
                        await close_coro
            except Exception:
                pass

        return successful_sends


registry = ConnectionRegistry()
