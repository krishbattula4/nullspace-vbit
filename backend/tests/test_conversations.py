"""Tests for conversation endpoints and message history."""
import base64
import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy import event
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_engine
from app.core.tokens import create_access_token
from app.models.conversation import Conversation
from app.models.message import Message
from app.models.message_version import MessageVersion, VersionAction
from app.models.user import User


async def _create_user(db: AsyncSession, username: str) -> User:
    user = User(
        username=username,
        password_hash="$2b$12$dummyhashfordemonstratingusercreation",
        display_name=username.title(),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


@pytest.mark.asyncio
async def test_conversations_auth_required(client: AsyncClient) -> None:
    """Endpoints under /conversations require valid authentication."""
    random_id = uuid.uuid4()

    res_post = await client.post("/conversations", json={"peer_id": str(random_id)})
    assert res_post.status_code == 401
    assert res_post.json()["detail"] == "not_authenticated"

    res_list = await client.get("/conversations")
    assert res_list.status_code == 401
    assert res_list.json()["detail"] == "not_authenticated"

    res_msgs = await client.get(f"/conversations/{random_id}/messages")
    assert res_msgs.status_code == 401
    assert res_msgs.json()["detail"] == "not_authenticated"


@pytest.mark.asyncio
async def test_create_conversation_self_chat(client: AsyncClient, db_session: AsyncSession) -> None:
    """POST /conversations rejects self-chat with HTTP 400 cannot_chat_with_self."""
    alice = await _create_user(db_session, "alice_self")
    token = create_access_token(alice.user_id)
    headers = {"Authorization": f"Bearer {token}"}

    res = await client.post(
        "/conversations", json={"peer_id": str(alice.user_id)}, headers=headers
    )
    assert res.status_code == 400
    assert res.json()["detail"] == "cannot_chat_with_self"


@pytest.mark.asyncio
async def test_create_conversation_unknown_peer(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """POST /conversations with an unknown peer returns HTTP 404 user_not_found."""
    alice = await _create_user(db_session, "alice_unk")
    token = create_access_token(alice.user_id)
    headers = {"Authorization": f"Bearer {token}"}

    res = await client.post(
        "/conversations", json={"peer_id": str(uuid.uuid4())}, headers=headers
    )
    assert res.status_code == 404
    assert res.json()["detail"] == "user_not_found"


@pytest.mark.asyncio
async def test_create_conversation_uuid_pair_sorting_and_idempotence(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Conversation creates sorted pair user_a_id < user_b_id; returns 201 then 200."""
    alice = await _create_user(db_session, "alice_pair")
    bob = await _create_user(db_session, "bob_pair")

    token_a = create_access_token(alice.user_id)
    headers_a = {"Authorization": f"Bearer {token_a}"}

    # Initial creation: returns 201 Created
    res1 = await client.post(
        "/conversations", json={"peer_id": str(bob.user_id)}, headers=headers_a
    )
    assert res1.status_code == 201
    body1 = res1.json()
    conv_id = body1["id"]
    ua = uuid.UUID(body1["user_a_id"])
    ub = uuid.UUID(body1["user_b_id"])
    assert ua < ub
    assert {ua, ub} == {alice.user_id, bob.user_id}
    assert body1["peer"]["user_id"] == str(bob.user_id)
    assert body1["peer"]["username"] == "bob_pair"
    assert body1["verified_by_me"] is False
    assert body1["verified_by_peer"] is False

    # Second creation from Alice: returns 200 OK with same conversation
    res2 = await client.post(
        "/conversations", json={"peer_id": str(bob.user_id)}, headers=headers_a
    )
    assert res2.status_code == 200
    assert res2.json()["id"] == conv_id

    # Creation attempt by Bob with Alice: returns 200 OK with same conversation
    token_b = create_access_token(bob.user_id)
    headers_b = {"Authorization": f"Bearer {token_b}"}
    res3 = await client.post(
        "/conversations", json={"peer_id": str(alice.user_id)}, headers=headers_b
    )
    assert res3.status_code == 200
    body3 = res3.json()
    assert body3["id"] == conv_id
    assert body3["peer"]["user_id"] == str(alice.user_id)
    assert body3["peer"]["username"] == "alice_pair"


@pytest.mark.asyncio
async def test_create_conversation_concurrent_integrity_error(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Simultaneous creation catches IntegrityError, rolls back, and returns existing row."""
    alice = await _create_user(db_session, "alice_race")
    bob = await _create_user(db_session, "bob_race")

    token = create_access_token(alice.user_id)
    headers = {"Authorization": f"Bearer {token}"}

    # First pre-insert conversation row directly to simulate a parallel transaction
    ua, ub = sorted([alice.user_id, bob.user_id])
    existing_conv = Conversation(user_a_id=ua, user_b_id=ub)
    db_session.add(existing_conv)
    await db_session.commit()
    await db_session.refresh(existing_conv)

    # When client requests POST /conversations, simulate commit encountering an IntegrityError
    orig_commit = AsyncSession.commit
    fail_once = True

    async def mock_commit(self):
        nonlocal fail_once
        if fail_once:
            fail_once = False
            raise IntegrityError(
                "mock unique violation",
                orig=Exception("unique constraint"),
                params={},
            )
        return await orig_commit(self)

    with patch.object(AsyncSession, "commit", new=mock_commit):
        res = await client.post(
            "/conversations", json={"peer_id": str(bob.user_id)}, headers=headers
        )
        assert res.status_code == 200
        assert res.json()["id"] == str(existing_conv.id)


@pytest.mark.asyncio
async def test_list_conversations_only_callers(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """GET /conversations only returns conversations involving the logged-in user."""
    alice = await _create_user(db_session, "alice_list")
    bob = await _create_user(db_session, "bob_list")
    charlie = await _create_user(db_session, "charlie_list")
    david = await _create_user(db_session, "david_list")

    # Conversation 1: Alice & Bob
    ua1, ub1 = sorted([alice.user_id, bob.user_id])
    c1 = Conversation(user_a_id=ua1, user_b_id=ub1)

    # Conversation 2: Charlie & David (Alice is not participant)
    ua2, ub2 = sorted([charlie.user_id, david.user_id])
    c2 = Conversation(user_a_id=ua2, user_b_id=ub2)

    db_session.add_all([c1, c2])
    await db_session.commit()

    token_a = create_access_token(alice.user_id)
    headers_a = {"Authorization": f"Bearer {token_a}"}

    res = await client.get("/conversations", headers=headers_a)
    assert res.status_code == 200
    convs = res.json()
    assert len(convs) == 1
    assert convs[0]["id"] == str(c1.id)
    assert convs[0]["peer"]["username"] == "bob_list"


@pytest.mark.asyncio
async def test_list_conversations_peer_and_verification_fields(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """verified_by_me and verified_by_peer map correctly for both participants."""
    alice = await _create_user(db_session, "alice_ver")
    bob = await _create_user(db_session, "bob_ver")

    ua, ub = sorted([alice.user_id, bob.user_id])
    # Alice verified Bob, Bob did not verify Alice
    v_a = (alice.user_id == ua)
    v_b = (alice.user_id == ub)
    conv = Conversation(user_a_id=ua, user_b_id=ub, verified_a=v_a, verified_b=v_b)
    db_session.add(conv)
    await db_session.commit()

    # Alice view
    token_a = create_access_token(alice.user_id)
    headers_a = {"Authorization": f"Bearer {token_a}"}
    res_a = await client.get("/conversations", headers=headers_a)
    assert res_a.status_code == 200
    a_conv = res_a.json()[0]
    assert a_conv["peer"]["username"] == "bob_ver"
    assert a_conv["verified_by_me"] is True
    assert a_conv["verified_by_peer"] is False

    # Bob view
    token_b = create_access_token(bob.user_id)
    headers_b = {"Authorization": f"Bearer {token_b}"}
    res_b = await client.get("/conversations", headers=headers_b)
    assert res_b.status_code == 200
    b_conv = res_b.json()[0]
    assert b_conv["peer"]["username"] == "alice_ver"
    assert b_conv["verified_by_me"] is False
    assert b_conv["verified_by_peer"] is True


@pytest.mark.asyncio
async def test_list_conversations_unread_count_and_last_message_at(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """unread_count counts incoming unread messages; last_message_at tracks latest message."""
    alice = await _create_user(db_session, "alice_stat")
    bob = await _create_user(db_session, "bob_stat")

    ua, ub = sorted([alice.user_id, bob.user_id])
    conv = Conversation(user_a_id=ua, user_b_id=ub)
    db_session.add(conv)
    await db_session.commit()

    t1 = datetime(2026, 11, 19, 10, 0, 0, tzinfo=UTC)
    t2 = datetime(2026, 11, 19, 10, 5, 0, tzinfo=UTC)
    t3 = datetime(2026, 11, 19, 10, 10, 0, tzinfo=UTC)

    # 1. Message from Bob to Alice (unread)
    m1 = Message(
        conversation_id=conv.id,
        sender_id=bob.user_id,
        client_msg_id=uuid.uuid4(),
        created_at=t1,
        read_at=None,
    )
    # 2. Message from Alice to Bob (unread by Bob)
    m2 = Message(
        conversation_id=conv.id,
        sender_id=alice.user_id,
        client_msg_id=uuid.uuid4(),
        created_at=t2,
        read_at=None,
    )
    # 3. Message from Bob to Alice (already read)
    m3 = Message(
        conversation_id=conv.id,
        sender_id=bob.user_id,
        client_msg_id=uuid.uuid4(),
        created_at=t3,
        read_at=datetime.now(UTC),
    )
    db_session.add_all([m1, m2, m3])
    await db_session.commit()

    # Alice view:
    # m1: from Bob, read_at is None -> unread for Alice
    # m2: from Alice herself -> NOT unread for Alice
    # m3: from Bob, but read_at is set -> NOT unread for Alice
    # Alice unread_count = 1
    token_a = create_access_token(alice.user_id)
    headers_a = {"Authorization": f"Bearer {token_a}"}
    res_a = await client.get("/conversations", headers=headers_a)
    assert res_a.status_code == 200
    a_conv = res_a.json()[0]
    assert a_conv["unread_count"] == 1
    assert "2026-11-19T10:10:00" in a_conv["last_message_at"]

    # Bob view:
    # m2: from Alice, read_at is None -> unread for Bob
    # Bob unread_count = 1
    token_b = create_access_token(bob.user_id)
    headers_b = {"Authorization": f"Bearer {token_b}"}
    res_b = await client.get("/conversations", headers=headers_b)
    assert res_b.status_code == 200
    b_conv = res_b.json()[0]
    assert b_conv["unread_count"] == 1


@pytest.mark.asyncio
async def test_list_conversations_newest_activity_ordering(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Conversations are ordered by newest activity (last message or creation time) descending."""
    me = await _create_user(db_session, "me_ordering")
    peer1 = await _create_user(db_session, "peer1_ordering")
    peer2 = await _create_user(db_session, "peer2_ordering")
    peer3 = await _create_user(db_session, "peer3_ordering")

    t_base = datetime(2026, 11, 19, 9, 0, 0, tzinfo=UTC)

    # c1 created at 9:00 with message at 9:10
    ua1, ub1 = sorted([me.user_id, peer1.user_id])
    c1 = Conversation(user_a_id=ua1, user_b_id=ub1, created_at=t_base)

    # c2 created at 9:05 with message at 9:30 (most recent message)
    ua2, ub2 = sorted([me.user_id, peer2.user_id])
    c2 = Conversation(user_a_id=ua2, user_b_id=ub2, created_at=t_base + timedelta(minutes=5))

    # c3 created at 9:20 with NO messages (activity is created_at 9:20)
    ua3, ub3 = sorted([me.user_id, peer3.user_id])
    c3 = Conversation(user_a_id=ua3, user_b_id=ub3, created_at=t_base + timedelta(minutes=20))

    db_session.add_all([c1, c2, c3])
    await db_session.commit()

    m1 = Message(
        conversation_id=c1.id,
        sender_id=peer1.user_id,
        client_msg_id=uuid.uuid4(),
        created_at=t_base + timedelta(minutes=10),
    )
    m2 = Message(
        conversation_id=c2.id,
        sender_id=peer2.user_id,
        client_msg_id=uuid.uuid4(),
        created_at=t_base + timedelta(minutes=30),
    )
    db_session.add_all([m1, m2])
    await db_session.commit()

    token = create_access_token(me.user_id)
    headers = {"Authorization": f"Bearer {token}"}

    res = await client.get("/conversations", headers=headers)
    assert res.status_code == 200
    convs = res.json()
    assert len(convs) == 3
    # Order should be c2 (activity 9:30), c3 (activity 9:20), c1 (activity 9:10)
    assert convs[0]["id"] == str(c2.id)
    assert convs[1]["id"] == str(c3.id)
    assert convs[2]["id"] == str(c1.id)


@pytest.mark.asyncio
async def test_message_history_non_participant_and_unknown_returns_404(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Unknown conversation or non-participant caller returns HTTP 404 (never 403)."""
    alice = await _create_user(db_session, "alice_msg_access")
    bob = await _create_user(db_session, "bob_msg_access")
    charlie = await _create_user(db_session, "charlie_msg_access")

    ua, ub = sorted([alice.user_id, bob.user_id])
    conv = Conversation(user_a_id=ua, user_b_id=ub)
    db_session.add(conv)
    await db_session.commit()

    token_charlie = create_access_token(charlie.user_id)
    headers_charlie = {"Authorization": f"Bearer {token_charlie}"}

    # Charlie is not participant in alice-bob conversation
    res_non_part = await client.get(
        f"/conversations/{conv.id}/messages", headers=headers_charlie
    )
    assert res_non_part.status_code == 404
    assert res_non_part.json()["detail"] == "conversation_not_found"

    # Completely unknown conversation ID
    unknown_id = uuid.uuid4()
    res_unk = await client.get(
        f"/conversations/{unknown_id}/messages", headers=headers_charlie
    )
    assert res_unk.status_code == 404
    assert res_unk.json()["detail"] == "conversation_not_found"


@pytest.mark.asyncio
async def test_message_history_newest_first_and_pagination_limits(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """GET /conversations/{id}/messages is ordered newest first and validates limit range."""
    alice = await _create_user(db_session, "alice_order_test")
    bob = await _create_user(db_session, "bob_order_test")

    ua, ub = sorted([alice.user_id, bob.user_id])
    conv = Conversation(user_a_id=ua, user_b_id=ub)
    db_session.add(conv)
    await db_session.commit()

    t_base = datetime(2026, 11, 19, 12, 0, 0, tzinfo=UTC)
    messages = []
    for i in range(10):
        m = Message(
            conversation_id=conv.id,
            sender_id=alice.user_id,
            client_msg_id=uuid.uuid4(),
            created_at=t_base + timedelta(minutes=i),
        )
        messages.append(m)
    db_session.add_all(messages)
    await db_session.commit()

    token = create_access_token(alice.user_id)
    headers = {"Authorization": f"Bearer {token}"}

    # Limit validation: < 1 and > 100 return 422
    url_0 = f"/conversations/{conv.id}/messages?limit=0"
    assert (await client.get(url_0, headers=headers)).status_code == 422
    url_101 = f"/conversations/{conv.id}/messages?limit=101"
    assert (await client.get(url_101, headers=headers)).status_code == 422

    # Default limit returns all 10 messages ordered newest first
    res = await client.get(f"/conversations/{conv.id}/messages", headers=headers)
    assert res.status_code == 200
    fetched = res.json()
    assert len(fetched) == 10
    # Newest message (created at 12:09) is first
    assert fetched[0]["id"] == str(messages[9].id)
    assert fetched[9]["id"] == str(messages[0].id)

    # Valid limit parameter
    res_lim5 = await client.get(
        f"/conversations/{conv.id}/messages?limit=5", headers=headers
    )
    assert res_lim5.status_code == 200
    assert len(res_lim5.json()) == 5


@pytest.mark.asyncio
async def test_message_history_keyset_pagination_no_duplicates_or_gaps(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Keyset pagination with before cursor returns all messages without gaps or duplicates."""
    alice = await _create_user(db_session, "alice_paging")
    bob = await _create_user(db_session, "bob_paging")

    ua, ub = sorted([alice.user_id, bob.user_id])
    conv = Conversation(user_a_id=ua, user_b_id=ub)
    db_session.add(conv)
    await db_session.commit()

    t_base = datetime(2026, 11, 19, 12, 0, 0, tzinfo=UTC)
    all_msgs = []
    # 25 messages, with some sharing timestamps
    for i in range(25):
        m = Message(
            conversation_id=conv.id,
            sender_id=alice.user_id,
            client_msg_id=uuid.uuid4(),
            created_at=t_base + timedelta(seconds=i // 3),
        )
        all_msgs.append(m)
    db_session.add_all(all_msgs)
    await db_session.commit()

    token = create_access_token(alice.user_id)
    headers = {"Authorization": f"Bearer {token}"}

    # Fetch with limit=10 across pages
    fetched_ids = []
    before = None

    while True:
        url = f"/conversations/{conv.id}/messages?limit=10"
        if before:
            url += f"&before={before}"
        res = await client.get(url, headers=headers)
        assert res.status_code == 200
        page = res.json()
        if not page:
            break
        fetched_ids.extend([m["id"] for m in page])
        before = page[-1]["id"]

    assert len(fetched_ids) == 25
    assert len(set(fetched_ids)) == 25  # No duplicates
    expected_ids = set(str(m.id) for m in all_msgs)
    assert set(fetched_ids) == expected_ids  # No gaps


@pytest.mark.asyncio
async def test_message_history_identical_timestamps_across_page_boundary(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Messages with identical timestamps are paginated deterministically using (created_at, id)."""
    alice = await _create_user(db_session, "alice_same_t")
    bob = await _create_user(db_session, "bob_same_t")

    ua, ub = sorted([alice.user_id, bob.user_id])
    conv = Conversation(user_a_id=ua, user_b_id=ub)
    db_session.add(conv)
    await db_session.commit()

    # 6 messages with the EXACT same timestamp
    t_exact = datetime(2026, 11, 19, 12, 0, 0, tzinfo=UTC)
    messages = [
        Message(
            conversation_id=conv.id,
            sender_id=alice.user_id,
            client_msg_id=uuid.uuid4(),
            created_at=t_exact,
        )
        for _ in range(6)
    ]
    db_session.add_all(messages)
    await db_session.commit()

    token = create_access_token(alice.user_id)
    headers = {"Authorization": f"Bearer {token}"}

    # Fetch with limit=2 across 3 pages
    all_fetched = []
    before = None
    for _ in range(4):
        url = f"/conversations/{conv.id}/messages?limit=2"
        if before:
            url += f"&before={before}"
        res = await client.get(url, headers=headers)
        assert res.status_code == 200
        page = res.json()
        if not page:
            break
        all_fetched.extend(page)
        before = page[-1]["id"]

    assert len(all_fetched) == 6
    fetched_ids = [m["id"] for m in all_fetched]
    assert len(set(fetched_ids)) == 6
    assert set(fetched_ids) == set(str(m.id) for m in messages)
    # Confirm deterministic descending id order among identical timestamps
    assert fetched_ids == sorted(fetched_ids, reverse=True)


@pytest.mark.asyncio
async def test_message_history_cursor_validation(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Ambiguous raw timestamps and malformed cursors return 422; unknown UUID returns 404."""
    alice = await _create_user(db_session, "alice_cursor_val")
    bob = await _create_user(db_session, "bob_cursor_val")

    ua, ub = sorted([alice.user_id, bob.user_id])
    conv = Conversation(user_a_id=ua, user_b_id=ub)
    db_session.add(conv)
    await db_session.commit()

    token = create_access_token(alice.user_id)
    headers = {"Authorization": f"Bearer {token}"}

    # Raw timestamp without message UUID is ambiguous and rejected with 422
    res_raw_t = await client.get(
        f"/conversations/{conv.id}/messages?before=2026-11-19T12:00:00Z", headers=headers
    )
    assert res_raw_t.status_code == 422
    assert res_raw_t.json()["detail"] == "invalid_cursor"

    # Malformed cursor string rejected with 422
    res_malformed = await client.get(
        f"/conversations/{conv.id}/messages?before=not_a_valid_cursor", headers=headers
    )
    assert res_malformed.status_code == 422
    assert res_malformed.json()["detail"] == "invalid_cursor"

    # Non-existent UUID cursor returns 404
    non_existent = uuid.uuid4()
    res_404 = await client.get(
        f"/conversations/{conv.id}/messages?before={non_existent}", headers=headers
    )
    assert res_404.status_code == 404
    assert res_404.json()["detail"] == "cursor_not_found"



@pytest.mark.asyncio
async def test_message_history_nested_versions_and_ciphertext(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Messages include nested versions in ascending order, base64 ciphertext, and tombstones."""
    alice = await _create_user(db_session, "alice_cipher")
    bob = await _create_user(db_session, "bob_cipher")

    ua, ub = sorted([alice.user_id, bob.user_id])
    conv = Conversation(user_a_id=ua, user_b_id=ub)
    db_session.add(conv)
    await db_session.commit()

    msg = Message(
        conversation_id=conv.id,
        sender_id=alice.user_id,
        client_msg_id=uuid.uuid4(),
        current_version=3,
    )
    db_session.add(msg)
    await db_session.commit()
    await db_session.refresh(msg)

    raw_payload_1 = b"original_whisper_ciphertext_payload"
    raw_payload_2 = b"edited_whisper_ciphertext_payload"

    # Version 1 (CREATE)
    v1 = MessageVersion(
        message_id=msg.id,
        version_no=1,
        ctype=3,
        ciphertext=raw_payload_1,
        action=VersionAction.CREATE,
        actor_id=alice.user_id,
    )
    # Version 2 (EDIT)
    v2 = MessageVersion(
        message_id=msg.id,
        version_no=2,
        ctype=1,
        ciphertext=raw_payload_2,
        action=VersionAction.EDIT,
        actor_id=alice.user_id,
    )
    # Version 3 (DELETE - tombstone erased)
    t_erased = datetime.now(UTC)
    v3 = MessageVersion(
        message_id=msg.id,
        version_no=3,
        ctype=1,
        ciphertext=b"",
        action=VersionAction.DELETE,
        actor_id=alice.user_id,
        erased_at=t_erased,
    )
    db_session.add_all([v1, v2, v3])
    await db_session.commit()

    token = create_access_token(alice.user_id)
    headers = {"Authorization": f"Bearer {token}"}

    res = await client.get(f"/conversations/{conv.id}/messages", headers=headers)
    assert res.status_code == 200
    data = res.json()
    assert len(data) == 1
    m_resp = data[0]

    versions = m_resp["versions"]
    assert len(versions) == 3
    # Ascending order: version 1, 2, 3
    assert [v["version_no"] for v in versions] == [1, 2, 3]

    # Version 1 base64 check
    assert base64.b64decode(versions[0]["ciphertext"]) == raw_payload_1
    assert versions[0]["action"] == "CREATE"
    assert versions[0]["ctype"] == 3
    assert versions[0]["erased_at"] is None

    # Version 2 base64 check
    assert base64.b64decode(versions[1]["ciphertext"]) == raw_payload_2
    assert versions[1]["action"] == "EDIT"
    assert versions[1]["ctype"] == 1
    assert versions[1]["erased_at"] is None

    # Version 3 erased representation
    assert versions[2]["ciphertext"] == ""
    assert versions[2]["erased_at"] is not None
    assert versions[2]["action"] == "DELETE"


@pytest.mark.asyncio
async def test_message_history_query_count_is_constant(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """A page of 50 messages uses a small constant number of SQL queries, not one per message."""
    alice = await _create_user(db_session, "alice_perf")
    bob = await _create_user(db_session, "bob_perf")

    ua, ub = sorted([alice.user_id, bob.user_id])
    conv = Conversation(user_a_id=ua, user_b_id=ub)
    db_session.add(conv)
    await db_session.commit()

    # Insert 50 messages with 2 versions each
    messages = []
    versions = []
    t_base = datetime(2026, 11, 19, 12, 0, 0, tzinfo=UTC)
    for i in range(50):
        m = Message(
            conversation_id=conv.id,
            sender_id=alice.user_id,
            client_msg_id=uuid.uuid4(),
            current_version=2,
            created_at=t_base + timedelta(seconds=i),
        )
        messages.append(m)

    db_session.add_all(messages)
    await db_session.commit()

    for m in messages:
        await db_session.refresh(m)
        v1 = MessageVersion(
            message_id=m.id,
            version_no=1,
            ctype=1,
            ciphertext=b"payload_1",
            action=VersionAction.CREATE,
            actor_id=alice.user_id,
        )
        v2 = MessageVersion(
            message_id=m.id,
            version_no=2,
            ctype=1,
            ciphertext=b"payload_2",
            action=VersionAction.EDIT,
            actor_id=alice.user_id,
        )
        versions.extend([v1, v2])

    db_session.add_all(versions)
    await db_session.commit()

    token = create_access_token(alice.user_id)
    headers = {"Authorization": f"Bearer {token}"}

    # Count SQL queries executed during the request
    engine = get_engine()
    query_count = 0

    def query_counter(conn, cursor, statement, parameters, context, executemany):
        nonlocal query_count
        query_count += 1

    event.listen(engine.sync_engine, "before_cursor_execute", query_counter)
    try:
        res = await client.get(f"/conversations/{conv.id}/messages?limit=50", headers=headers)
        assert res.status_code == 200
        data = res.json()
        assert len(data) == 50
        for m in data:
            assert len(m["versions"]) == 2
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", query_counter)

    # In a non-N+1 implementation:
    # 1 query for user auth lookup
    # 1 query for conversation existence & access check
    # 1 query for messages (page of 50)
    # 1 query for all versions (in message_ids)
    # Total queries should be <= 5, definitely NOT 50+
    assert query_count <= 5, f"Expected <= 5 queries, got {query_count}"
