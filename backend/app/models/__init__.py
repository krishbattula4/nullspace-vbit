"""Import every model module here so Alembic autogenerate sees all tables."""
from app.core.db import Base  # noqa: F401

# P1.1 adds: from app.models.user import User
# P1.5 adds: prekey, conversation, message, message_version, media
