"""Import every model module here so Alembic autogenerate sees all tables."""
from app.core.db import Base  # noqa: F401
from app.models.conversation import Conversation  # noqa: F401
from app.models.media import Media  # noqa: F401
from app.models.message import Message  # noqa: F401
from app.models.message_version import MessageVersion  # noqa: F401
from app.models.prekey import Prekey  # noqa: F401
from app.models.refresh_token import RefreshToken  # noqa: F401
from app.models.user import User  # noqa: F401
