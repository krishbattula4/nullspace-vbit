"""In-memory WebSocket connection registry."""
import uuid

from starlette.websockets import WebSocket


class ConnectionRegistry:
    """Tracks active WebSocket connections keyed by user ID."""

    def __init__(self) -> None:
        self._connections: dict[uuid.UUID, list[WebSocket]] = {}

    def _normalize(self, user_id: uuid.UUID | str) -> uuid.UUID:
        if isinstance(user_id, uuid.UUID):
            return user_id
        return uuid.UUID(str(user_id))

    def add(self, user_id: uuid.UUID | str, websocket: WebSocket) -> None:
        """Register a websocket connection for a user."""
        uid = self._normalize(user_id)
        if uid not in self._connections:
            self._connections[uid] = []
        if websocket not in self._connections[uid]:
            self._connections[uid].append(websocket)

    def remove(self, user_id: uuid.UUID | str, websocket: WebSocket) -> None:
        """Remove a websocket connection for a user."""
        try:
            uid = self._normalize(user_id)
        except (ValueError, TypeError):
            return
        if uid in self._connections:
            try:
                self._connections[uid].remove(websocket)
            except ValueError:
                pass
            if not self._connections[uid]:
                del self._connections[uid]

    def get(self, user_id: uuid.UUID | str) -> list[WebSocket]:
        """Return a copy of active sockets for a user."""
        try:
            uid = self._normalize(user_id)
        except (ValueError, TypeError):
            return []
        return list(self._connections.get(uid, []))

    def count(self) -> int:
        """Return the total number of connected sockets across all users."""
        return sum(len(sockets) for sockets in self._connections.values())

    def connected_user_ids(self) -> set[uuid.UUID]:
        """Return the set of user IDs with at least one active connection."""
        return set(self._connections.keys())


registry = ConnectionRegistry()
