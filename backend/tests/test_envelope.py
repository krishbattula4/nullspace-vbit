"""Tests for WebSocket envelope schema, builders, and validation rules."""
import base64
import json
from pathlib import Path

import pytest

from app.ws.envelope import (
    MAX_BODY_BYTES,
    PROTOCOL_VERSION,
    EnvelopeError,
    ack_frame,
    delete_frame,
    delivered_frame,
    edit_frame,
    error_frame,
    message_frame,
    parse_client_frame,
    presence_frame,
    read_frame,
    retract_frame,
    typing_frame,
)

EXAMPLES_PATH = (
    Path(__file__).resolve().parent.parent.parent
    / "docs"
    / "schemas"
    / "envelope-examples.json"
)

DOCS_PROTOCOL_PATH = (
    Path(__file__).resolve().parent.parent.parent
    / "docs"
    / "protocol.md"
)


@pytest.fixture(scope="module")
def examples() -> dict:
    with open(EXAMPLES_PATH, encoding="utf-8") as f:
        return json.load(f)


def test_a_client_frames_parse(examples: dict) -> None:
    """Every example in clientFrames parses and returns the right model with field values."""
    for frame in examples["clientFrames"]:
        parsed = parse_client_frame(frame)
        assert parsed.v == frame["v"]
        assert parsed.type == frame["type"]
        for k, v in frame.items():
            assert getattr(parsed, k) == v

        # Also test parsing from JSON-encoded string and UTF-8 bytes
        raw_str = json.dumps(frame)
        parsed_str = parse_client_frame(raw_str)
        assert parsed_str.type == frame["type"]

        raw_bytes = raw_str.encode("utf-8")
        parsed_bytes = parse_client_frame(raw_bytes)
        assert parsed_bytes.type == frame["type"]


def test_b_invalid_client_frames_raise(examples: dict) -> None:
    """Every entry in invalidClientFrames raises EnvelopeError with expected code."""
    for entry in examples["invalidClientFrames"]:
        name = entry["name"]
        frame = entry["frame"]
        expected_code = entry["code"]

        with pytest.raises(EnvelopeError) as exc_info:
            parse_client_frame(frame)

        assert (
            exc_info.value.code == expected_code
        ), f"Failed for {name}: expected {expected_code}, got {exc_info.value.code}"


def test_c_server_frames_match_builders(examples: dict) -> None:
    """Every example in serverFrames equals what matching builder function returns."""
    for frame in examples["serverFrames"]:
        frame_type = frame["type"]
        built: dict

        if frame_type == "MESSAGE":
            built = message_frame(
                message_id=frame["message_id"],
                conversation_id=frame["conversation_id"],
                sender_id=frame["sender_id"],
                version_no=frame["version_no"],
                ctype=frame["ctype"],
                body=frame["body"],
                created_at=frame["created_at"],
            )
        elif frame_type == "ACK":
            built = ack_frame(
                client_msg_id=frame["client_msg_id"],
                message_id=frame["message_id"],
                status=frame["status"],
            )
        elif frame_type == "DELIVERED":
            built = delivered_frame(
                message_id=frame["message_id"],
                delivered_at=frame["delivered_at"],
            )
        elif frame_type == "READ":
            built = read_frame(
                message_id=frame["message_id"],
                read_at=frame["read_at"],
            )
        elif frame_type == "EDIT":
            built = edit_frame(
                message_id=frame["message_id"],
                version_no=frame["version_no"],
                ctype=frame["ctype"],
                body=frame["body"],
                edited_at=frame["edited_at"],
            )
        elif frame_type == "DELETE":
            built = delete_frame(
                message_id=frame["message_id"],
            )
        elif frame_type == "RETRACT":
            built = retract_frame(
                message_id=frame["message_id"],
            )
        elif frame_type == "TYPING":
            built = typing_frame(
                conversation_id=frame["conversation_id"],
                user_id=frame["user_id"],
            )
        elif frame_type == "PRESENCE":
            built = presence_frame(
                user_id=frame["user_id"],
                online=frame["online"],
            )
        elif frame_type == "ERROR":
            err = EnvelopeError(frame["code"], frame.get("detail"))
            built = error_frame(err, client_msg_id=frame.get("client_msg_id"))
        else:
            pytest.fail(f"Unhandled server frame type: {frame_type}")

        assert built == frame


def test_d_server_builders_reject_invalid_arguments() -> None:
    """Each builder rejects bad argument with EnvelopeError."""
    u1 = "11111111-1111-1111-1111-111111111111"
    u2 = "22222222-2222-2222-2222-222222222222"
    u3 = "33333333-3333-3333-3333-333333333333"
    ts = "2026-11-18T12:00:00Z"

    # message_frame
    with pytest.raises(EnvelopeError) as exc:
        message_frame("NOT-A-UUID", u2, u3, 1, 1, "AQID", ts)
    assert exc.value.code == "invalid_frame"

    with pytest.raises(EnvelopeError) as exc:
        message_frame(u1, u2, u3, 0, 1, "AQID", ts)
    assert exc.value.code == "invalid_frame"

    with pytest.raises(EnvelopeError) as exc:
        message_frame(u1, u2, u3, 1, 2, "AQID", ts)  # ctype 2
    assert exc.value.code == "invalid_frame"

    with pytest.raises(EnvelopeError) as exc:
        message_frame(u1, u2, u3, 1, 1, "bad base64!", ts)
    assert exc.value.code == "invalid_frame"

    with pytest.raises(EnvelopeError) as exc:
        message_frame(u1, u2, u3, 1, 1, "AQID", "not-iso-ts")
    assert exc.value.code == "invalid_frame"

    # ack_frame
    with pytest.raises(EnvelopeError) as exc:
        ack_frame(u1, u2, "MAYBE")
    assert exc.value.code == "invalid_frame"

    with pytest.raises(EnvelopeError) as exc:
        ack_frame("UPPERCASE-1111-1111-1111-111111111111", u2, "SENT")
    assert exc.value.code == "invalid_frame"

    # delivered_frame
    with pytest.raises(EnvelopeError) as exc:
        delivered_frame(u1, "invalid-timestamp")
    assert exc.value.code == "invalid_frame"

    # read_frame
    with pytest.raises(EnvelopeError) as exc:
        read_frame("bad-uuid", ts)
    assert exc.value.code == "invalid_frame"

    # edit_frame
    with pytest.raises(EnvelopeError) as exc:
        edit_frame(u1, 1, 1, "AQID", ts)  # version_no must be >= 2
    assert exc.value.code == "invalid_frame"

    with pytest.raises(EnvelopeError) as exc:
        edit_frame(u1, 2, 2, "AQID", ts)  # ctype 2
    assert exc.value.code == "invalid_frame"

    # delete_frame
    with pytest.raises(EnvelopeError) as exc:
        delete_frame("11111111-1111-1111-1111-11111111111A")  # uppercase
    assert exc.value.code == "invalid_frame"

    # retract_frame
    with pytest.raises(EnvelopeError) as exc:
        retract_frame("11111111-1111-1111-1111-11111111111A")  # uppercase
    assert exc.value.code == "invalid_frame"

    # typing_frame
    with pytest.raises(EnvelopeError) as exc:
        typing_frame(u1, "invalid-user-id")
    assert exc.value.code == "invalid_frame"

    # presence_frame
    with pytest.raises(EnvelopeError) as exc:
        presence_frame(u1, "true")  # string instead of bool
    assert exc.value.code == "invalid_frame"

    with pytest.raises(EnvelopeError) as exc:
        presence_frame(u1, 1)  # int instead of bool
    assert exc.value.code == "invalid_frame"

    # error_frame
    with pytest.raises(EnvelopeError) as exc:
        error_frame(EnvelopeError("test_code"), client_msg_id="NOT-UUID")
    assert exc.value.code == "invalid_frame"


def test_e_parse_client_frame_50_hostile_inputs() -> None:
    """parse_client_frame never raises anything except EnvelopeError on 50 hostile values."""
    hostile_values = [
        None,
        42,
        -1,
        3.14159,
        True,
        False,
        [],
        [1, 2, 3],
        [[[]]],
        {},
        {"v": 1},
        {"type": "MESSAGE"},
        {"v": 2, "type": "MESSAGE"},
        {"v": "1", "type": "MESSAGE"},
        {"v": None, "type": "MESSAGE"},
        {"v": True, "type": "MESSAGE"},
        b"\xff\xfe\xfd",  # invalid utf-8
        b"\x00\x01\x02",
        b"",
        "",
        "   ",
        "null",
        "true",
        "false",
        "123",
        "[1, 2]",
        "{",
        "}",
        "{{}}",
        '{"v": 1, "type": "MESSAGE"',
        "{'single_quotes': 1}",
        "x" * 100000,
        b"x" * 100000,
        {"v": 1, "type": "MESSAGE", "body": None},
        {"v": 1, "type": "MESSAGE", "body": 123},
        {"v": 1, "type": "MESSAGE", "conversation_id": {}},
        {"v": 1, "type": "MESSAGE", "client_msg_id": []},
        {"v": 1, "type": "MESSAGE", "ctype": "1"},
        {"v": 1, "type": 123},
        {"v": 1, "type": None},
        {"v": 1, "type": ""},
        {"v": 1, "type": "PING", "token": "abc"},
        {"v": 1, "type": "AUTH", "token": "abc"},
        {"v": 1, "type": "AUTH_OK", "user_id": "11111111-1111-1111-1111-111111111111"},
        {"v": 1, "type": "PONG"},
        {"v": 1, "type": "MESSAGE", "conversation_id": None},
        {"v": 1, "type": "TYPING", "conversation_id": 12345},
        {"v": 1, "type": "DELIVERED", "message_id": ""},
        {"v": 1, "type": "READ", "message_id": None},
        {"v": 1, "type": "DELETE", "extra_field": "disallowed"},
        {"v": 1, "type": "RETRACT", "message_id": 999},
    ]

    assert len(hostile_values) >= 50

    for idx, val in enumerate(hostile_values):
        try:
            parse_client_frame(val)
        except EnvelopeError:
            pass  # Expected
        except Exception as exc:
            pytest.fail(
                f"Hostile value [{idx}] {val!r} raised unexpected {type(exc).__name__}: {exc}"
            )
        else:
            pytest.fail(f"Hostile value [{idx}] {val!r} did not raise EnvelopeError")


def test_f_error_frame_format() -> None:
    """error_frame output has v 1, type ERROR, and includes client_msg_id only when given."""
    cid = "22222222-2222-2222-2222-222222222222"

    # With detail and client_msg_id
    err = EnvelopeError("custom_code", "some detail")
    frame = error_frame(err, client_msg_id=cid)
    assert frame == {
        "v": 1,
        "type": "ERROR",
        "code": "custom_code",
        "detail": "some detail",
        "client_msg_id": cid,
    }

    # Without client_msg_id
    frame_no_cid = error_frame(err)
    assert frame_no_cid == {
        "v": 1,
        "type": "ERROR",
        "code": "custom_code",
        "detail": "some detail",
    }
    assert "client_msg_id" not in frame_no_cid

    # Without detail
    err_simple = EnvelopeError("unsupported_version")
    frame_simple = error_frame(err_simple)
    assert frame_simple == {
        "v": 1,
        "type": "ERROR",
        "code": "unsupported_version",
    }
    assert "detail" not in frame_simple
    assert "client_msg_id" not in frame_simple


def test_g_docs_protocol_version_matches() -> None:
    """The protocol version in docs/protocol.md equals PROTOCOL_VERSION."""
    content = DOCS_PROTOCOL_PATH.read_text(encoding="utf-8")
    expected_phrase = f"`v` (protocol version, currently {PROTOCOL_VERSION})"
    assert (
        expected_phrase in content
    ), f"Expected phrase {expected_phrase!r} not found in docs/protocol.md"


def test_k_body_boundary_limits() -> None:
    """A body of MAX_BODY_BYTES decoded bytes is accepted; MAX_BODY_BYTES + 1 is rejected."""
    cid = "11111111-1111-1111-1111-111111111111"
    mid = "22222222-2222-2222-2222-222222222222"

    # Exactly MAX_BODY_BYTES (65536) bytes
    body_exact = base64.b64encode(b"Z" * MAX_BODY_BYTES).decode("ascii")
    frame_valid = {
        "v": 1,
        "type": "MESSAGE",
        "conversation_id": cid,
        "client_msg_id": mid,
        "ctype": 1,
        "body": body_exact,
    }
    parsed = parse_client_frame(frame_valid)
    assert parsed.body == body_exact

    # Builder accepts exact limit
    built = message_frame(
        message_id=mid,
        conversation_id=cid,
        sender_id=mid,
        version_no=1,
        ctype=1,
        body=body_exact,
        created_at="2026-11-18T12:00:00Z",
    )
    assert built["body"] == body_exact

    # MAX_BODY_BYTES + 1 (65537) bytes
    body_overflow = base64.b64encode(b"Z" * (MAX_BODY_BYTES + 1)).decode("ascii")
    frame_invalid = {
        "v": 1,
        "type": "MESSAGE",
        "conversation_id": cid,
        "client_msg_id": mid,
        "ctype": 1,
        "body": body_overflow,
    }
    with pytest.raises(EnvelopeError) as exc_info:
        parse_client_frame(frame_invalid)
    assert exc_info.value.code == "invalid_frame"

    # Builder rejects overflow
    with pytest.raises(EnvelopeError) as exc_builder:
        message_frame(
            message_id=mid,
            conversation_id=cid,
            sender_id=mid,
            version_no=1,
            ctype=1,
            body=body_overflow,
            created_at="2026-11-18T12:00:00Z",
        )
    assert exc_builder.value.code == "invalid_frame"
