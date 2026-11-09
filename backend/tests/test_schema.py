"""Schema integrity, constraint, type safety and cascade tests for task P1.5."""
import uuid

import pytest
from sqlalchemy import Enum, LargeBinary, String, Text, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import Base
from app.models.conversation import Conversation
from app.models.media import Media
from app.models.message import Message, MessageStatus
from app.models.message_version import MessageVersion, VersionAction
from app.models.prekey import Prekey, PrekeyKind
from app.models.user import User


async def _create_test_user(db: AsyncSession, username: str) -> tuple[User, uuid.UUID]:
    user = User(
        username=username,
        password_hash="test_password_hash",
        display_name=f"User {username}",
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user, user.user_id


async def _create_test_conversation(
    db: AsyncSession, u1_id: uuid.UUID, u2_id: uuid.UUID
) -> tuple[Conversation, uuid.UUID]:
    ua, ub = sorted([u1_id, u2_id])
    conv = Conversation(user_a_id=ua, user_b_id=ub)
    db.add(conv)
    await db.commit()
    await db.refresh(conv)
    return conv, conv.id


def test_no_plaintext_columns() -> None:
    """Base.metadata asserts that sensitive and cryptographic columns are binary BYTEA.

    Also asserts that the ONLY String, Text or Enum columns in messages and message_versions
    are the whitelisted status and action metadata columns.
    """
    # 1. Assert cryptographic columns are LargeBinary (BYTEA on PostgreSQL)
    assert isinstance(Base.metadata.tables["message_versions"].c.ciphertext.type, LargeBinary)
    assert isinstance(Base.metadata.tables["prekeys"].c.public_key.type, LargeBinary)
    assert isinstance(Base.metadata.tables["prekeys"].c.signature.type, LargeBinary)
    assert isinstance(Base.metadata.tables["users"].c.identity_key.type, LargeBinary)
    assert isinstance(Base.metadata.tables["media"].c.sha256.type, LargeBinary)

    # 2. Assert whitelist for textual / enum columns in messages and message_versions
    whitelists = {
        "messages": {"status"},
        "message_versions": {"action"},
    }
    for table_name, allowed_cols in whitelists.items():
        table = Base.metadata.tables[table_name]
        for col in table.columns:
            if isinstance(col.type, String | Text | Enum):
                assert col.name in allowed_cols, (
                    f"Unexpected plaintext/text column '{col.name}' found in table '{table_name}'. "
                    f"Nullspace requires zero plaintext content on the server."
                )


async def test_foreign_keys_enforced(db_session: AsyncSession) -> None:
    """Foreign keys are enforced for messages, versions, and prekeys."""
    _, user_id = await _create_test_user(db_session, "fk_user")
    _, peer_id = await _create_test_user(db_session, "fk_peer")
    _, conv_id = await _create_test_conversation(db_session, user_id, peer_id)
    unknown_id = uuid.uuid4()

    # Message with unknown conversation_id
    bad_msg = Message(
        conversation_id=unknown_id,
        sender_id=user_id,
        client_msg_id=uuid.uuid4(),
    )
    db_session.add(bad_msg)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()

    # Valid message to anchor version test
    valid_msg = Message(
        conversation_id=conv_id,
        sender_id=user_id,
        client_msg_id=uuid.uuid4(),
    )
    db_session.add(valid_msg)
    await db_session.commit()
    await db_session.refresh(valid_msg)
    msg_id = valid_msg.id

    # Version with unknown message_id
    bad_ver = MessageVersion(
        message_id=unknown_id,
        version_no=1,
        ctype=1,
        ciphertext=b"encrypted_data",
        action=VersionAction.CREATE,
        actor_id=user_id,
    )
    db_session.add(bad_ver)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()

    # Prekey with unknown user_id
    bad_prekey = Prekey(
        user_id=unknown_id,
        kind=PrekeyKind.SIGNED,
        key_id=1,
        public_key=b"public_key_33_bytes",
        signature=b"sig_64_bytes",
    )
    db_session.add(bad_prekey)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()

    # Ensure valid message can be cleaned up
    assert msg_id is not None


async def test_conversations_constraints(db_session: AsyncSession) -> None:
    """Conversations enforce ordered_pair and uniqueness constraints."""
    _, u1_id = await _create_test_user(db_session, "conv_u1")
    _, u2_id = await _create_test_user(db_session, "conv_u2")
    u_min, u_max = sorted([u1_id, u2_id])

    # Valid canonical ordered pair
    c1 = Conversation(user_a_id=u_min, user_b_id=u_max)
    db_session.add(c1)
    await db_session.commit()

    # Duplicate pair violates unique constraint
    c_dup = Conversation(user_a_id=u_min, user_b_id=u_max)
    db_session.add(c_dup)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()

    # Inverted pair (user_a_id > user_b_id) violates ordered_pair
    c_rev = Conversation(user_a_id=u_max, user_b_id=u_min)
    db_session.add(c_rev)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()

    # Equal pair (user_a_id == user_b_id) violates ordered_pair
    c_eq = Conversation(user_a_id=u_min, user_b_id=u_min)
    db_session.add(c_eq)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


async def test_messages_constraints_and_defaults(db_session: AsyncSession) -> None:
    """Messages enforce idempotency uniqueness and default status / version."""
    _, u1_id = await _create_test_user(db_session, "msg_u1")
    _, u2_id = await _create_test_user(db_session, "msg_u2")
    _, conv_id = await _create_test_conversation(db_session, u1_id, u2_id)

    client_msg_id = uuid.uuid4()
    msg = Message(
        conversation_id=conv_id,
        sender_id=u1_id,
        client_msg_id=client_msg_id,
    )
    db_session.add(msg)
    await db_session.commit()
    await db_session.refresh(msg)

    # Defaults check
    assert msg.status == MessageStatus.SENT
    assert msg.current_version == 1
    assert msg.delivered_at is None
    assert msg.read_at is None

    # Duplicate (sender_id, client_msg_id) violates uniqueness
    dup_msg = Message(
        conversation_id=conv_id,
        sender_id=u1_id,
        client_msg_id=client_msg_id,
    )
    db_session.add(dup_msg)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


async def test_message_versions_constraints(db_session: AsyncSession) -> None:
    """Message versions enforce ctype check, uniqueness and accept empty ciphertext on DELETE."""
    _, u1_id = await _create_test_user(db_session, "ver_u1")
    _, u2_id = await _create_test_user(db_session, "ver_u2")
    _, conv_id = await _create_test_conversation(db_session, u1_id, u2_id)

    msg = Message(
        conversation_id=conv_id,
        sender_id=u1_id,
        client_msg_id=uuid.uuid4(),
    )
    db_session.add(msg)
    await db_session.commit()
    await db_session.refresh(msg)
    msg_id = msg.id

    # Version 1 valid
    v1 = MessageVersion(
        message_id=msg_id,
        version_no=1,
        ctype=1,
        ciphertext=b"initial_ciphertext",
        action=VersionAction.CREATE,
        actor_id=u1_id,
    )
    db_session.add(v1)
    await db_session.commit()

    # Duplicate (message_id, version_no) is rejected
    v1_dup = MessageVersion(
        message_id=msg_id,
        version_no=1,
        ctype=3,
        ciphertext=b"duplicate_v1",
        action=VersionAction.EDIT,
        actor_id=u1_id,
    )
    db_session.add(v1_dup)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()

    # ctype 2 is rejected (only 1 and 3 are valid)
    v_bad_ctype = MessageVersion(
        message_id=msg_id,
        version_no=2,
        ctype=2,
        ciphertext=b"bad_ctype",
        action=VersionAction.EDIT,
        actor_id=u1_id,
    )
    db_session.add(v_bad_ctype)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()

    # DELETE row with empty ciphertext is accepted (tombstone / delete-before-read)
    v_del = MessageVersion(
        message_id=msg_id,
        version_no=2,
        ctype=1,
        ciphertext=b"",
        action=VersionAction.DELETE,
        actor_id=u1_id,
    )
    db_session.add(v_del)
    await db_session.commit()
    await db_session.refresh(v_del)
    assert v_del.ciphertext == b""


async def test_prekeys_constraints(db_session: AsyncSession) -> None:
    """Prekeys enforce signature_rule and (user_id, kind, key_id) uniqueness."""
    _, u_id = await _create_test_user(db_session, "prekey_user")

    # SIGNED without a signature is rejected
    bad_signed = Prekey(
        user_id=u_id,
        kind=PrekeyKind.SIGNED,
        key_id=1,
        public_key=b"curve25519_pk",
        signature=None,
    )
    db_session.add(bad_signed)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()

    # ONE_TIME with a signature is rejected
    bad_one_time = Prekey(
        user_id=u_id,
        kind=PrekeyKind.ONE_TIME,
        key_id=1,
        public_key=b"curve25519_pk",
        signature=b"unexpected_sig",
    )
    db_session.add(bad_one_time)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()

    # Valid signed and one-time keys
    ok_signed = Prekey(
        user_id=u_id,
        kind=PrekeyKind.SIGNED,
        key_id=1,
        public_key=b"curve25519_pk",
        signature=b"valid_sig",
    )
    ok_one_time = Prekey(
        user_id=u_id,
        kind=PrekeyKind.ONE_TIME,
        key_id=1,
        public_key=b"curve25519_pk",
        signature=None,
    )
    db_session.add_all([ok_signed, ok_one_time])
    await db_session.commit()

    # Duplicate (user_id, kind, key_id) is rejected
    dup_signed = Prekey(
        user_id=u_id,
        kind=PrekeyKind.SIGNED,
        key_id=1,
        public_key=b"different_pk",
        signature=b"different_sig",
    )
    db_session.add(dup_signed)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


async def test_media_constraints(db_session: AsyncSession) -> None:
    """Media enforces size_range (<= 5MB) and sha256_length (32 bytes)."""
    _, u_id = await _create_test_user(db_session, "media_user")

    # size > 5242880 bytes is rejected
    m_too_big = Media(
        uploader_id=u_id,
        storage_path="media/big.bin",
        mime_type="application/octet-stream",
        size_bytes=5242881,
        sha256=b"x" * 32,
    )
    db_session.add(m_too_big)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()

    # size 0 is rejected
    m_zero = Media(
        uploader_id=u_id,
        storage_path="media/zero.bin",
        mime_type="application/octet-stream",
        size_bytes=0,
        sha256=b"x" * 32,
    )
    db_session.add(m_zero)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()

    # Valid size (5 MB boundary)
    m_ok = Media(
        uploader_id=u_id,
        storage_path="media/ok.bin",
        mime_type="application/octet-stream",
        size_bytes=5242880,
        sha256=b"x" * 32,
    )
    db_session.add(m_ok)
    await db_session.commit()

    # sha256 not 32 bytes (31 bytes) is rejected
    m_short_sha = Media(
        uploader_id=u_id,
        storage_path="media/short.bin",
        mime_type="application/octet-stream",
        size_bytes=100,
        sha256=b"x" * 31,
    )
    db_session.add(m_short_sha)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()

    # sha256 not 32 bytes (33 bytes) is rejected
    m_long_sha = Media(
        uploader_id=u_id,
        storage_path="media/long.bin",
        mime_type="application/octet-stream",
        size_bytes=100,
        sha256=b"x" * 33,
    )
    db_session.add(m_long_sha)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


async def test_cascades(db_session: AsyncSession) -> None:
    """Deleting user cascades to prekeys; deleting conversation cascades to messages and versions;

    deleting message sets media.message_id to NULL and preserves media.
    """
    # 1. Deleting a user removes their prekeys
    user_pre, u_pre_id = await _create_test_user(db_session, "cascade_pre_u")
    pk = Prekey(
        user_id=u_pre_id,
        kind=PrekeyKind.SIGNED,
        key_id=1,
        public_key=b"k" * 33,
        signature=b"s" * 64,
    )
    db_session.add(pk)
    await db_session.commit()

    await db_session.delete(user_pre)
    await db_session.commit()
    db_session.expire_all()

    res_pk = await db_session.execute(select(Prekey).where(Prekey.user_id == u_pre_id))
    assert res_pk.scalar_one_or_none() is None

    # 2. Deleting a conversation removes its messages and versions
    _, u1_id = await _create_test_user(db_session, "cascade_u1")
    _, u2_id = await _create_test_user(db_session, "cascade_u2")
    conv, conv_id = await _create_test_conversation(db_session, u1_id, u2_id)

    msg = Message(
        conversation_id=conv_id,
        sender_id=u1_id,
        client_msg_id=uuid.uuid4(),
    )
    db_session.add(msg)
    await db_session.commit()
    await db_session.refresh(msg)
    msg_id = msg.id

    ver = MessageVersion(
        message_id=msg_id,
        version_no=1,
        ctype=1,
        ciphertext=b"ciphertext_bytes",
        action=VersionAction.CREATE,
        actor_id=u1_id,
    )
    db_session.add(ver)
    await db_session.commit()
    await db_session.refresh(ver)
    ver_id = ver.id

    await db_session.delete(conv)
    await db_session.commit()
    db_session.expire_all()

    res_msg = await db_session.execute(select(Message).where(Message.id == msg_id))
    assert res_msg.scalar_one_or_none() is None

    res_ver = await db_session.execute(select(MessageVersion).where(MessageVersion.id == ver_id))
    assert res_ver.scalar_one_or_none() is None

    # 3. Deleting a message sets media.message_id to NULL and keeps the media row
    _, u3_id = await _create_test_user(db_session, "cascade_u3")
    _, u4_id = await _create_test_user(db_session, "cascade_u4")
    _, conv2_id = await _create_test_conversation(db_session, u3_id, u4_id)

    msg2 = Message(
        conversation_id=conv2_id,
        sender_id=u3_id,
        client_msg_id=uuid.uuid4(),
    )
    db_session.add(msg2)
    await db_session.commit()
    await db_session.refresh(msg2)
    msg2_id = msg2.id

    med = Media(
        message_id=msg2_id,
        uploader_id=u3_id,
        storage_path="media/attachment.bin",
        mime_type="application/pdf",
        size_bytes=4096,
        sha256=b"h" * 32,
    )
    db_session.add(med)
    await db_session.commit()
    await db_session.refresh(med)
    med_id = med.id

    await db_session.delete(msg2)
    await db_session.commit()
    db_session.expire_all()

    res_med = await db_session.execute(select(Media).where(Media.id == med_id))
    preserved_media = res_med.scalar_one_or_none()
    assert preserved_media is not None
    assert preserved_media.message_id is None


async def test_ciphertext_round_trip(db_session: AsyncSession) -> None:
    """Ciphertext containing every byte value 0 to 255 reads back identical."""
    _, u1_id = await _create_test_user(db_session, "rt_u1")
    _, u2_id = await _create_test_user(db_session, "rt_u2")
    _, conv_id = await _create_test_conversation(db_session, u1_id, u2_id)

    msg = Message(
        conversation_id=conv_id,
        sender_id=u1_id,
        client_msg_id=uuid.uuid4(),
    )
    db_session.add(msg)
    await db_session.commit()
    await db_session.refresh(msg)

    all_256_bytes = bytes(range(256))
    ver = MessageVersion(
        message_id=msg.id,
        version_no=1,
        ctype=1,
        ciphertext=all_256_bytes,
        action=VersionAction.CREATE,
        actor_id=u1_id,
    )
    db_session.add(ver)
    await db_session.commit()
    await db_session.refresh(ver)

    result = await db_session.execute(select(MessageVersion).where(MessageVersion.id == ver.id))
    fetched_ver = result.scalar_one()

    assert fetched_ver.ciphertext == all_256_bytes
    assert len(fetched_ver.ciphertext) == 256
