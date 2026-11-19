"""Tests for the Key Directory API: bundle upload, bundle fetch and key inventory."""
import asyncio
import base64
import json
import uuid
from pathlib import Path

import jsonschema
import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.tokens import create_access_token
from app.models.prekey import Prekey, PrekeyKind
from app.models.user import User

SCHEMA_PATH = (
    Path(__file__).resolve().parent.parent.parent
    / "docs"
    / "schemas"
    / "prekey-bundle.schema.json"
)

with open(SCHEMA_PATH, encoding="utf-8") as f:
    BUNDLE_SCHEMA = json.load(f)


def _make_key(byte_val: int = 1, length: int = 33) -> str:
    return base64.b64encode(bytes([byte_val] * length)).decode("ascii")


def _make_sig(byte_val: int = 2) -> str:
    return base64.b64encode(bytes([byte_val] * 64)).decode("ascii")


def _make_bundle_payload(
    user_id: str,
    identity_byte: int = 1,
    signed_id: int = 1,
    signed_pub_byte: int = 2,
    signed_sig_byte: int = 3,
    otpk_specs: list[tuple[int, int]] | None = None,
) -> dict:
    if otpk_specs is None:
        otpk_specs = [(1, 10), (2, 20)]
    return {
        "userId": user_id,
        "registrationId": 1234,
        "identityKey": _make_key(identity_byte, 33),
        "signedPreKey": {
            "keyId": signed_id,
            "publicKey": _make_key(signed_pub_byte, 33),
            "signature": _make_sig(signed_sig_byte),
        },
        "oneTimePreKeys": [
            {"keyId": kid, "publicKey": _make_key(bval, 33)}
            for kid, bval in otpk_specs
        ],
        "createdAt": "2026-11-19T12:00:00Z",
    }


async def _create_test_user(db: AsyncSession, username: str) -> User:
    user = User(
        username=username,
        password_hash="$2b$12$dummyhashfordemonstratingusercreation",
        display_name=username.title(),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


def _auth_header(user: User) -> dict[str, str]:
    token = create_access_token(user.user_id)
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_keys_endpoints_auth_required(client: AsyncClient) -> None:
    """All /keys endpoints require authentication."""
    random_user_id = uuid.uuid4()

    res_put = await client.put("/keys/bundle", json={})
    assert res_put.status_code == 401
    assert res_put.json()["detail"] == "not_authenticated"

    res_get_bundle = await client.get(f"/keys/bundle/{random_user_id}")
    assert res_get_bundle.status_code == 401
    assert res_get_bundle.json()["detail"] == "not_authenticated"

    res_count = await client.get("/keys/count")
    assert res_count.status_code == 401
    assert res_count.json()["detail"] == "not_authenticated"


@pytest.mark.asyncio
async def test_bundle_upload_success(client: AsyncClient, db_session: AsyncSession) -> None:
    """Successful bundle upload sets identity_changed: false on initial provisioning."""
    alice = await _create_test_user(db_session, "alice_upload")
    headers = _auth_header(alice)

    payload = _make_bundle_payload(str(alice.user_id))
    res = await client.put("/keys/bundle", json=payload, headers=headers)
    assert res.status_code == 200
    assert res.json() == {"identity_changed": False}

    # Verify user record updated in database
    await db_session.refresh(alice)
    assert alice.registration_id == 1234
    assert alice.identity_key == bytes([1] * 33)

    # Verify prekeys in database
    prekeys_res = await db_session.execute(
        select(Prekey).where(Prekey.user_id == alice.user_id)
    )
    prekeys = prekeys_res.scalars().all()
    assert len(prekeys) == 3  # 1 signed + 2 one-time


@pytest.mark.asyncio
async def test_bundle_upload_user_mismatch_forbidden(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Uploading a bundle with userId not matching authenticated caller returns 403."""
    alice = await _create_test_user(db_session, "alice_mismatch")
    bob = await _create_test_user(db_session, "bob_mismatch")
    alice_headers = _auth_header(alice)

    # Alice attempts to upload bundle with Bob's user_id
    payload = _make_bundle_payload(str(bob.user_id))
    res = await client.put("/keys/bundle", json=payload, headers=alice_headers)
    assert res.status_code == 403
    assert res.json()["detail"] == "user_mismatch"


@pytest.mark.asyncio
async def test_bundle_upload_invalid_key_sizes(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Invalid decoded byte sizes for public keys or signatures return HTTP 422."""
    alice = await _create_test_user(db_session, "alice_sizes")
    headers = _auth_header(alice)

    # 1. Identity key not 33 bytes (e.g. 32 bytes)
    bad_id = _make_bundle_payload(str(alice.user_id))
    bad_id["identityKey"] = _make_key(1, 32)
    res = await client.put("/keys/bundle", json=bad_id, headers=headers)
    assert res.status_code == 422

    # 2. Signed prekey public key not 33 bytes (e.g. 34 bytes)
    bad_signed_pub = _make_bundle_payload(str(alice.user_id))
    bad_signed_pub["signedPreKey"]["publicKey"] = _make_key(2, 34)
    res = await client.put("/keys/bundle", json=bad_signed_pub, headers=headers)
    assert res.status_code == 422

    # 3. Signed prekey signature not 64 bytes (e.g. 63 bytes)
    bad_sig = _make_bundle_payload(str(alice.user_id))
    bad_sig["signedPreKey"]["signature"] = _make_key(3, 63)
    res = await client.put("/keys/bundle", json=bad_sig, headers=headers)
    assert res.status_code == 422

    # 4. One-time prekey public key not 33 bytes (e.g. 16 bytes)
    bad_otpk = _make_bundle_payload(str(alice.user_id))
    bad_otpk["oneTimePreKeys"][0]["publicKey"] = _make_key(4, 16)
    res = await client.put("/keys/bundle", json=bad_otpk, headers=headers)
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_bundle_upload_validation_rules(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Validation rejects duplicate keyId, >200 OTPKs, and unknown fields."""
    alice = await _create_test_user(db_session, "alice_validation")
    headers = _auth_header(alice)

    # 1. Duplicate OTPK keyId
    dup_payload = _make_bundle_payload(
        str(alice.user_id),
        otpk_specs=[(1, 10), (1, 11)],
    )
    res_dup = await client.put("/keys/bundle", json=dup_payload, headers=headers)
    assert res_dup.status_code == 422

    # 2. More than 200 OTPKs
    too_many_specs = [(i, 1) for i in range(1, 202)]
    too_many_payload = _make_bundle_payload(str(alice.user_id), otpk_specs=too_many_specs)
    res_many = await client.put("/keys/bundle", json=too_many_payload, headers=headers)
    assert res_many.status_code == 422

    # 3. Unknown field rejected
    extra_payload = _make_bundle_payload(str(alice.user_id))
    extra_payload["unknownField"] = "malicious"
    res_extra = await client.put("/keys/bundle", json=extra_payload, headers=headers)
    assert res_extra.status_code == 422


@pytest.mark.asyncio
async def test_bundle_upload_re_registration_purges_unconsumed_otpks(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Re-registration with a new identity key deletes unconsumed OTPKs and sets flag."""
    alice = await _create_test_user(db_session, "alice_rereg")
    headers = _auth_header(alice)

    # Initial bundle with identity byte 1 and OTPKs 1, 2
    p1 = _make_bundle_payload(str(alice.user_id), identity_byte=1, otpk_specs=[(1, 10), (2, 20)])
    res1 = await client.put("/keys/bundle", json=p1, headers=headers)
    assert res1.status_code == 200
    assert res1.json()["identity_changed"] is False

    # Second bundle with NEW identity byte 99 and fresh OTPKs 3, 4
    p2 = _make_bundle_payload(
        str(alice.user_id),
        identity_byte=99,
        signed_id=2,
        otpk_specs=[(3, 30), (4, 40)],
    )
    res2 = await client.put("/keys/bundle", json=p2, headers=headers)
    assert res2.status_code == 200
    assert res2.json()["identity_changed"] is True

    # Confirm user's identity_key is updated
    await db_session.refresh(alice)
    assert alice.identity_key == bytes([99] * 33)

    # Confirm old unconsumed OTPKs (1, 2) were deleted, only new OTPKs (3, 4) exist
    otpk_res = await db_session.execute(
        select(Prekey).where(
            Prekey.user_id == alice.user_id,
            Prekey.kind == PrekeyKind.ONE_TIME,
        )
    )
    remaining_otpks = otpk_res.scalars().all()
    remaining_ids = {p.key_id for p in remaining_otpks}
    assert remaining_ids == {3, 4}


@pytest.mark.asyncio
async def test_bundle_identical_reupload_idempotent(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Identical re-upload is accepted without duplicating rows or raising conflict."""
    alice = await _create_test_user(db_session, "alice_idempotent")
    headers = _auth_header(alice)

    payload = _make_bundle_payload(str(alice.user_id), otpk_specs=[(1, 10), (2, 20)])
    res1 = await client.put("/keys/bundle", json=payload, headers=headers)
    assert res1.status_code == 200
    assert res1.json()["identity_changed"] is False

    # Upload identical bundle again
    res2 = await client.put("/keys/bundle", json=payload, headers=headers)
    assert res2.status_code == 200
    assert res2.json()["identity_changed"] is False

    # Verify no duplicate prekeys were created
    all_prekeys = (
        (await db_session.execute(select(Prekey).where(Prekey.user_id == alice.user_id)))
        .scalars()
        .all()
    )
    assert len(all_prekeys) == 3


@pytest.mark.asyncio
async def test_bundle_conflict_prekey_id_different_key(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Uploading a prekey ID that already exists with a different public key returns 409."""
    alice = await _create_test_user(db_session, "alice_conflict")
    headers = _auth_header(alice)

    # Initial bundle has OTPK keyId=1 with public key byte 10
    payload1 = _make_bundle_payload(str(alice.user_id), otpk_specs=[(1, 10)])
    res1 = await client.put("/keys/bundle", json=payload1, headers=headers)
    assert res1.status_code == 200

    # Conflicting bundle has OTPK keyId=1 with DIFFERENT public key byte 99
    payload2 = _make_bundle_payload(str(alice.user_id), otpk_specs=[(1, 99)])
    res2 = await client.put("/keys/bundle", json=payload2, headers=headers)
    assert res2.status_code == 409
    assert res2.json()["detail"] == "prekey_id_conflict"

    # Transactional rollback check: DB still contains original OTPK
    original_otpk = (
        await db_session.execute(
            select(Prekey).where(
                Prekey.user_id == alice.user_id,
                Prekey.kind == PrekeyKind.ONE_TIME,
                Prekey.key_id == 1,
            )
        )
    ).scalar_one()
    assert original_otpk.public_key == bytes([10] * 33)


@pytest.mark.asyncio
async def test_get_bundle_not_found(client: AsyncClient, db_session: AsyncSession) -> None:
    """Requesting non-existent user or user without bundle returns HTTP 404."""
    alice = await _create_test_user(db_session, "alice_caller")
    bob = await _create_test_user(db_session, "bob_nobundle")
    headers = _auth_header(alice)

    # Non-existent user UUID
    random_user_id = uuid.uuid4()
    res_missing = await client.get(f"/keys/bundle/{random_user_id}", headers=headers)
    assert res_missing.status_code == 404
    assert res_missing.json()["detail"] == "bundle_not_found"

    # Bob exists but has no prekey bundle
    res_no_bundle = await client.get(f"/keys/bundle/{bob.user_id}", headers=headers)
    assert res_no_bundle.status_code == 404
    assert res_no_bundle.json()["detail"] == "bundle_not_found"


@pytest.mark.asyncio
async def test_get_bundle_malformed_uuid(client: AsyncClient, db_session: AsyncSession) -> None:
    """Non-UUID user_id path parameter returns HTTP 422."""
    alice = await _create_test_user(db_session, "alice_malformed")
    headers = _auth_header(alice)

    res = await client.get("/keys/bundle/not-a-valid-uuid", headers=headers)
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_get_bundle_success_and_atomic_consumption(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Fetching bundle returns newest signed prekey, burns at most one OTPK, validates schema."""
    alice = await _create_test_user(db_session, "alice_provider")
    bob = await _create_test_user(db_session, "bob_fetcher")
    alice_headers = _auth_header(alice)
    bob_headers = _auth_header(bob)

    # Alice uploads signed prekey 1 and OTPKs 10, 20
    payload = _make_bundle_payload(
        str(alice.user_id),
        signed_id=1,
        otpk_specs=[(10, 1), (20, 2)],
    )
    up_res = await client.put("/keys/bundle", json=payload, headers=alice_headers)
    assert up_res.status_code == 200

    # Rotate Alice's signed prekey to keyId 2
    rotate_payload = _make_bundle_payload(
        str(alice.user_id),
        signed_id=2,
        signed_pub_byte=5,
        otpk_specs=[(10, 1), (20, 2)],  # identical OTPKs
    )
    up_res2 = await client.put("/keys/bundle", json=rotate_payload, headers=alice_headers)
    assert up_res2.status_code == 200

    # Fetch 1: Bob requests Alice's bundle. Should get newest signedPreKey (2) and OTPK 10
    res1 = await client.get(f"/keys/bundle/{alice.user_id}", headers=bob_headers)
    assert res1.status_code == 200
    data1 = res1.json()
    jsonschema.validate(instance=data1, schema=BUNDLE_SCHEMA)
    assert data1["userId"] == str(alice.user_id)
    assert data1["signedPreKey"]["keyId"] == 2
    assert len(data1["oneTimePreKeys"]) == 1
    assert data1["oneTimePreKeys"][0]["keyId"] == 10

    # Fetch 2: Next request consumes OTPK 20
    res2 = await client.get(f"/keys/bundle/{alice.user_id}", headers=bob_headers)
    assert res2.status_code == 200
    data2 = res2.json()
    jsonschema.validate(instance=data2, schema=BUNDLE_SCHEMA)
    assert len(data2["oneTimePreKeys"]) == 1
    assert data2["oneTimePreKeys"][0]["keyId"] == 20

    # Fetch 3: OTPKs exhausted -> oneTimePreKeys is empty array []
    res3 = await client.get(f"/keys/bundle/{alice.user_id}", headers=bob_headers)
    assert res3.status_code == 200
    data3 = res3.json()
    jsonschema.validate(instance=data3, schema=BUNDLE_SCHEMA)
    assert data3["signedPreKey"]["keyId"] == 2
    assert data3["oneTimePreKeys"] == []


@pytest.mark.asyncio
async def test_get_keys_count(client: AsyncClient, db_session: AsyncSession) -> None:
    """GET /keys/count returns unconsumed OTPK count and active signed prekey ID."""
    alice = await _create_test_user(db_session, "alice_inventory")
    bob = await _create_test_user(db_session, "bob_peer")
    alice_headers = _auth_header(alice)
    bob_headers = _auth_header(bob)

    # Empty user inventory
    res0 = await client.get("/keys/count", headers=alice_headers)
    assert res0.status_code == 200
    assert res0.json() == {"one_time_prekeys": 0, "signed_prekey_id": None}

    # Alice uploads signed prekey 5 and 3 OTPKs
    payload = _make_bundle_payload(
        str(alice.user_id),
        signed_id=5,
        otpk_specs=[(1, 10), (2, 20), (3, 30)],
    )
    await client.put("/keys/bundle", json=payload, headers=alice_headers)

    res1 = await client.get("/keys/count", headers=alice_headers)
    assert res1.status_code == 200
    assert res1.json() == {"one_time_prekeys": 3, "signed_prekey_id": 5}

    # Bob fetches a bundle from Alice (burns 1 OTPK)
    await client.get(f"/keys/bundle/{alice.user_id}", headers=bob_headers)

    # Alice's unconsumed count drops to 2
    res2 = await client.get("/keys/count", headers=alice_headers)
    assert res2.status_code == 200
    assert res2.json() == {"one_time_prekeys": 2, "signed_prekey_id": 5}


@pytest.mark.asyncio
async def test_concurrent_bundle_consumption_atomic(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Concurrent bundle fetches atomically consume distinct OTPKs (requires PostgreSQL)."""
    settings = get_settings()
    if not settings.sqlalchemy_url.startswith("postgresql"):
        pytest.skip("requires PostgreSQL")

    alice = await _create_test_user(db_session, "alice_concurrent")
    headers = _auth_header(alice)

    # Upload 100 OTPKs
    otpk_specs = [(i, i % 255) for i in range(1, 101)]
    payload = _make_bundle_payload(str(alice.user_id), otpk_specs=otpk_specs)
    await client.put("/keys/bundle", json=payload, headers=headers)

    # 101 concurrent fetches
    tasks = [client.get(f"/keys/bundle/{alice.user_id}", headers=headers) for _ in range(101)]
    responses = await asyncio.gather(*tasks)

    claimed_keys = []
    empty_responses = 0

    for r in responses:
        assert r.status_code == 200
        otpks = r.json()["oneTimePreKeys"]
        if len(otpks) == 1:
            claimed_keys.append(otpks[0]["keyId"])
        else:
            empty_responses += 1

    assert len(claimed_keys) == 100
    assert len(set(claimed_keys)) == 100
    assert empty_responses == 1


@pytest.mark.asyncio
async def test_concurrent_two_fetches_never_duplicate(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Two simultaneous bundle fetches never return the same OTPK twice (requires PostgreSQL)."""
    settings = get_settings()
    if not settings.sqlalchemy_url.startswith("postgresql"):
        pytest.skip("requires PostgreSQL")

    alice = await _create_test_user(db_session, "alice_two_fetch")
    bob = await _create_test_user(db_session, "bob_two_fetch")
    alice_headers = _auth_header(alice)
    bob_headers = _auth_header(bob)

    # Deterministic bundle with 2 available one-time prekeys
    payload = _make_bundle_payload(
        str(alice.user_id),
        signed_id=1,
        otpk_specs=[(101, 11), (102, 22)],
    )
    up_res = await client.put("/keys/bundle", json=payload, headers=alice_headers)
    assert up_res.status_code == 200

    # Two simultaneous GET requests
    res1, res2 = await asyncio.gather(
        client.get(f"/keys/bundle/{alice.user_id}", headers=bob_headers),
        client.get(f"/keys/bundle/{alice.user_id}", headers=bob_headers),
    )

    # Assert both requests succeed
    assert res1.status_code == 200
    assert res2.status_code == 200

    data1 = res1.json()
    data2 = res2.json()

    # Each response contains at most one one-time prekey
    otpks1 = data1["oneTimePreKeys"]
    otpks2 = data2["oneTimePreKeys"]
    assert len(otpks1) <= 1
    assert len(otpks2) <= 1

    # Extract returned key IDs
    returned_keys = [item["keyId"] for item in otpks1 + otpks2]

    # If both responses contain a one-time prekey, their key IDs are different
    if len(otpks1) == 1 and len(otpks2) == 1:
        assert otpks1[0]["keyId"] != otpks2[0]["keyId"]

    # No one-time prekey is returned twice
    assert len(returned_keys) == len(set(returned_keys))

    # The database records the correct consumed state
    db_otpks = (
        (
            await db_session.execute(
                select(Prekey).where(
                    Prekey.user_id == alice.user_id,
                    Prekey.kind == PrekeyKind.ONE_TIME,
                )
            )
        )
        .scalars()
        .all()
    )
    for p in db_otpks:
        if p.key_id in returned_keys:
            assert p.consumed_at is not None
        else:
            assert p.consumed_at is None
