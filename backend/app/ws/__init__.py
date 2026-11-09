"""WebSocket package: connection registry and real-time endpoints."""
from app.ws.registry import ConnectionRegistry, registry

__all__ = ["ConnectionRegistry", "registry"]
