"""WebSocket envelope schema and protocol validation for Nullspace."""
import base64
import binascii
import json
import re
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

PROTOCOL_VERSION: int = 1
MAX_BODY_BYTES: int = 65536

UUID_REGEX = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
TIMESTAMP_REGEX = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")
BASE64_REGEX = re.compile(
    r"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$"
)

CLIENT_FRAME_TYPES = {
    "MESSAGE",
    "DELIVERED",
    "READ",
    "EDIT",
    "DELETE",
    "RETRACT",
    "TYPING",
}


class EnvelopeError(Exception):
    """Protocol envelope parsing or validation error."""

    def __init__(self, code: str, detail: str | None = None) -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail


def validate_uuid_str(val: Any, field_name: str = "uuid") -> str:
    """Validate canonical lowercase hyphenated UUID string."""
    if not isinstance(val, str) or not UUID_REGEX.fullmatch(val):
        raise EnvelopeError("invalid_frame", f"Invalid canonical lowercase UUID for {field_name}")
    return val


def validate_ctype_val(val: Any) -> int:
    """Validate ctype is integer 1 or 3."""
    if type(val) is not int or isinstance(val, bool) or val not in (1, 3):
        raise EnvelopeError("invalid_frame", "ctype must be integer 1 or 3")
    return val


def validate_body_str(val: Any) -> str:
    """Validate standard base64 body with canonical padding, non-empty, <= MAX_BODY_BYTES."""
    if not isinstance(val, str) or len(val) == 0:
        raise EnvelopeError("invalid_frame", "body must be non-empty string")
    if len(val) % 4 != 0:
        raise EnvelopeError("invalid_frame", "body base64 length must be multiple of 4")
    if not BASE64_REGEX.fullmatch(val):
        raise EnvelopeError("invalid_frame", "body must be valid standard base64")

    try:
        decoded = base64.b64decode(val, validate=True)
    except (binascii.Error, ValueError) as e:
        raise EnvelopeError("invalid_frame", f"Invalid base64 payload: {e}") from e

    if len(decoded) == 0:
        raise EnvelopeError("invalid_frame", "decoded body cannot be empty")
    if len(decoded) > MAX_BODY_BYTES:
        raise EnvelopeError(
            "invalid_frame",
            f"decoded body {len(decoded)} bytes exceeds maximum {MAX_BODY_BYTES}",
        )

    # Reject non-canonical padding bits
    re_encoded = base64.b64encode(decoded).decode("ascii")
    if re_encoded != val:
        raise EnvelopeError("invalid_frame", "body contains non-canonical base64 padding")

    return val


def validate_timestamp_str(val: Any, field_name: str = "timestamp") -> str:
    """Validate ISO 8601 UTC timestamp string ending with Z."""
    if not isinstance(val, str) or not TIMESTAMP_REGEX.fullmatch(val):
        raise EnvelopeError(
            "invalid_frame",
            f"{field_name} must be ISO 8601 UTC string ending in Z",
        )
    try:
        datetime.fromisoformat(val[:-1] + "+00:00")
    except ValueError as e:
        raise EnvelopeError("invalid_frame", f"Invalid timestamp value for {field_name}") from e
    return val


class _ClientFrameBase(BaseModel):
    # strict=True: no silent coercion ("3" or true must not pass as ctype 3 or 1), so the
    # backend accepts exactly what the TypeScript parser accepts.
    model_config = ConfigDict(extra="forbid", strict=True)
    v: Literal[1] = PROTOCOL_VERSION


class ClientMessageFrame(_ClientFrameBase):
    type: Literal["MESSAGE"] = "MESSAGE"
    conversation_id: str
    client_msg_id: str
    ctype: int
    body: str

    def model_post_init(self, __context: Any) -> None:
        validate_uuid_str(self.conversation_id, "conversation_id")
        validate_uuid_str(self.client_msg_id, "client_msg_id")
        validate_ctype_val(self.ctype)
        validate_body_str(self.body)


class ClientDeliveredFrame(_ClientFrameBase):
    type: Literal["DELIVERED"] = "DELIVERED"
    message_id: str

    def model_post_init(self, __context: Any) -> None:
        validate_uuid_str(self.message_id, "message_id")


class ClientReadFrame(_ClientFrameBase):
    type: Literal["READ"] = "READ"
    message_id: str

    def model_post_init(self, __context: Any) -> None:
        validate_uuid_str(self.message_id, "message_id")


class ClientEditFrame(_ClientFrameBase):
    type: Literal["EDIT"] = "EDIT"
    message_id: str
    ctype: int
    body: str

    def model_post_init(self, __context: Any) -> None:
        validate_uuid_str(self.message_id, "message_id")
        validate_ctype_val(self.ctype)
        validate_body_str(self.body)


class ClientDeleteFrame(_ClientFrameBase):
    type: Literal["DELETE"] = "DELETE"
    message_id: str

    def model_post_init(self, __context: Any) -> None:
        validate_uuid_str(self.message_id, "message_id")


class ClientRetractFrame(_ClientFrameBase):
    type: Literal["RETRACT"] = "RETRACT"
    message_id: str

    def model_post_init(self, __context: Any) -> None:
        validate_uuid_str(self.message_id, "message_id")


class ClientTypingFrame(_ClientFrameBase):
    type: Literal["TYPING"] = "TYPING"
    conversation_id: str

    def model_post_init(self, __context: Any) -> None:
        validate_uuid_str(self.conversation_id, "conversation_id")


ClientFrame = Annotated[
    ClientMessageFrame
    | ClientDeliveredFrame
    | ClientReadFrame
    | ClientEditFrame
    | ClientDeleteFrame
    | ClientRetractFrame
    | ClientTypingFrame,
    Field(discriminator="type"),
]

_CLIENT_FRAME_ADAPTER: TypeAdapter[ClientFrame] = TypeAdapter(ClientFrame)


def parse_client_frame(raw: str | bytes | dict[str, Any]) -> ClientFrame:
    """Parse and validate incoming client WebSocket data frame.

    Checks run in the strict order:
      1. valid JSON
      2. is an object
      3. 'v' present
      4. 'v' is an integer and not a boolean
      5. v == 1
      6. 'type' is a known CLIENT type
      7. field validation

    Never logs frame contents. Raises EnvelopeError only.
    """
    try:
        # Step 1: Decode JSON if string or bytes
        if isinstance(raw, str | bytes):
            try:
                data = json.loads(raw)
            except Exception as e:
                raise EnvelopeError("invalid_json", str(e)) from e
        elif isinstance(raw, dict):
            data = raw
        else:
            raise EnvelopeError("not_an_object", f"Expected JSON object, got {type(raw).__name__}")

        # Step 2: Ensure object
        if not isinstance(data, dict):
            raise EnvelopeError("not_an_object", f"Expected JSON object, got {type(data).__name__}")

        # Step 3: 'v' present
        if "v" not in data:
            raise EnvelopeError("missing_version", "Missing 'v' field")

        # Step 4: 'v' is integer and not boolean
        v = data["v"]
        if type(v) is not int or isinstance(v, bool):
            raise EnvelopeError(
                "unsupported_version",
                f"Version must be an integer, got {type(v).__name__}",
            )

        # Step 5: v == 1
        if v != PROTOCOL_VERSION:
            raise EnvelopeError(
                "unsupported_version",
                f"Unsupported protocol version {v}",
            )

        # Step 6: 'type' is a known CLIENT type
        msg_type = data.get("type")
        if not isinstance(msg_type, str) or msg_type not in CLIENT_FRAME_TYPES:
            raise EnvelopeError("unknown_type", f"Unknown client frame type: {msg_type}")

        # Step 7: Field validation
        try:
            return _CLIENT_FRAME_ADAPTER.validate_python(data)
        except ValidationError as e:
            raise EnvelopeError("invalid_frame", str(e)) from e

    except EnvelopeError:
        raise
    except Exception as e:
        raise EnvelopeError("invalid_frame", str(e)) from e


def error_frame(err: EnvelopeError, client_msg_id: str | None = None) -> dict[str, Any]:
    """Build an ERROR frame dictionary."""
    frame: dict[str, Any] = {
        "v": PROTOCOL_VERSION,
        "type": "ERROR",
        "code": err.code,
    }
    if err.detail is not None:
        frame["detail"] = err.detail
    if client_msg_id is not None:
        validate_uuid_str(client_msg_id, "client_msg_id")
        frame["client_msg_id"] = client_msg_id
    return frame


def message_frame(
    message_id: str,
    conversation_id: str,
    sender_id: str,
    version_no: int,
    ctype: int,
    body: str,
    created_at: str,
) -> dict[str, Any]:
    """Build and validate a server MESSAGE frame."""
    validate_uuid_str(message_id, "message_id")
    validate_uuid_str(conversation_id, "conversation_id")
    validate_uuid_str(sender_id, "sender_id")

    if type(version_no) is not int or isinstance(version_no, bool) or version_no < 1:
        raise EnvelopeError("invalid_frame", "version_no must be integer >= 1")

    validate_ctype_val(ctype)
    validate_body_str(body)
    validate_timestamp_str(created_at, "created_at")

    return {
        "v": PROTOCOL_VERSION,
        "type": "MESSAGE",
        "message_id": message_id,
        "conversation_id": conversation_id,
        "sender_id": sender_id,
        "version_no": version_no,
        "ctype": ctype,
        "body": body,
        "created_at": created_at,
    }


def ack_frame(client_msg_id: str, message_id: str, status: str) -> dict[str, Any]:
    """Build and validate a server ACK frame."""
    validate_uuid_str(client_msg_id, "client_msg_id")
    validate_uuid_str(message_id, "message_id")

    if status not in ("SENT", "QUEUED"):
        raise EnvelopeError("invalid_frame", "status must be SENT or QUEUED")

    return {
        "v": PROTOCOL_VERSION,
        "type": "ACK",
        "client_msg_id": client_msg_id,
        "message_id": message_id,
        "status": status,
    }


def delivered_frame(message_id: str, delivered_at: str) -> dict[str, Any]:
    """Build and validate a server DELIVERED frame."""
    validate_uuid_str(message_id, "message_id")
    validate_timestamp_str(delivered_at, "delivered_at")

    return {
        "v": PROTOCOL_VERSION,
        "type": "DELIVERED",
        "message_id": message_id,
        "delivered_at": delivered_at,
    }


def read_frame(message_id: str, read_at: str) -> dict[str, Any]:
    """Build and validate a server READ frame."""
    validate_uuid_str(message_id, "message_id")
    validate_timestamp_str(read_at, "read_at")

    return {
        "v": PROTOCOL_VERSION,
        "type": "READ",
        "message_id": message_id,
        "read_at": read_at,
    }


def edit_frame(
    message_id: str,
    version_no: int,
    ctype: int,
    body: str,
    edited_at: str,
) -> dict[str, Any]:
    """Build and validate a server EDIT frame."""
    validate_uuid_str(message_id, "message_id")

    if type(version_no) is not int or isinstance(version_no, bool) or version_no < 2:
        raise EnvelopeError("invalid_frame", "version_no must be integer >= 2")

    validate_ctype_val(ctype)
    validate_body_str(body)
    validate_timestamp_str(edited_at, "edited_at")

    return {
        "v": PROTOCOL_VERSION,
        "type": "EDIT",
        "message_id": message_id,
        "version_no": version_no,
        "ctype": ctype,
        "body": body,
        "edited_at": edited_at,
    }


def delete_frame(message_id: str) -> dict[str, Any]:
    """Build and validate a server DELETE frame."""
    validate_uuid_str(message_id, "message_id")
    return {
        "v": PROTOCOL_VERSION,
        "type": "DELETE",
        "message_id": message_id,
    }


def retract_frame(message_id: str) -> dict[str, Any]:
    """Build and validate a server RETRACT frame."""
    validate_uuid_str(message_id, "message_id")
    return {
        "v": PROTOCOL_VERSION,
        "type": "RETRACT",
        "message_id": message_id,
    }


def typing_frame(conversation_id: str, user_id: str) -> dict[str, Any]:
    """Build and validate a server TYPING frame."""
    validate_uuid_str(conversation_id, "conversation_id")
    validate_uuid_str(user_id, "user_id")
    return {
        "v": PROTOCOL_VERSION,
        "type": "TYPING",
        "conversation_id": conversation_id,
        "user_id": user_id,
    }


def presence_frame(user_id: str, online: bool) -> dict[str, Any]:
    """Build and validate a server PRESENCE frame."""
    validate_uuid_str(user_id, "user_id")
    if type(online) is not bool:
        raise EnvelopeError("invalid_frame", "online must be boolean")
    return {
        "v": PROTOCOL_VERSION,
        "type": "PRESENCE",
        "user_id": user_id,
        "online": online,
    }
