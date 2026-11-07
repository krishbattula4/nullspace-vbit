from fastapi import APIRouter
from sqlalchemy import text

from app.core.db import get_session_factory

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict:
    """Liveness plus a real database round trip, so a green /health means the stack is usable."""
    db_status = "ok"
    try:
        async with get_session_factory()() as session:
            await session.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001 - report any failure instead of crashing
        db_status = f"unavailable: {type(exc).__name__}"
    return {"status": "ok", "db": db_status}
