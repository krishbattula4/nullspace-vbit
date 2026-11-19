"""Key directory endpoints for Signal Protocol public key bundles and inventory."""
import base64
import logging
import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.key_schemas import (
    BundleUploadResponse,
    KeyCountResponse,
    OneTimePreKeyPublic,
    PreKeyBundleUpload,
    PublicPreKeyBundleResponse,
    SignedPreKeyPublic,
)
from app.core.db import get_db
from app.core.deps import get_current_user
from app.models.prekey import Prekey, PrekeyKind
from app.models.user import User

router = APIRouter(prefix="/keys", tags=["keys"])
log = logging.getLogger("nullspace.keys")


@router.put(
    "/bundle",
    status_code=status.HTTP_200_OK,
    response_model=BundleUploadResponse,
)
async def upload_prekey_bundle(
    bundle: PreKeyBundleUpload,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_db)],
) -> BundleUploadResponse:
    """Upload or update a user's public prekey bundle.

    Validates key dimensions, enforces caller ownership, detects re-registration,
    prevents prekey ID conflicts, and ignores identical re-uploads.
    """
    # 1. Enforce userId matches the authenticated caller's user_id
    if bundle.userId != str(current_user.user_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="user_mismatch",
        )

    # Note on cryptographic verification:
    # The server cannot verify the XEdDSA signature because that requires
    # libsignal/curve25519-dalek, and verification happens client-side before session
    # establishment.

    identity_key_bytes = base64.b64decode(bundle.identityKey)
    signed_pub_bytes = base64.b64decode(bundle.signedPreKey.publicKey)
    signed_sig_bytes = base64.b64decode(bundle.signedPreKey.signature)

    # 2. Check for re-registration: if stored identity key differs, purge unconsumed OTPKs
    identity_changed = (
        current_user.identity_key is not None
        and current_user.identity_key != identity_key_bytes
    )

    try:
        if identity_changed:
            await session.execute(
                delete(Prekey).where(
                    Prekey.user_id == current_user.user_id,
                    Prekey.kind == PrekeyKind.ONE_TIME,
                    Prekey.consumed_at.is_(None),
                )
            )

        # 3. Fetch existing prekeys for conflict detection and idempotency
        stmt = select(Prekey).where(Prekey.user_id == current_user.user_id)
        result = await session.execute(stmt)
        existing_prekeys = {(p.kind, p.key_id): p for p in result.scalars().all()}

        new_prekeys: list[Prekey] = []

        # Check signed prekey
        signed_key_tuple = (PrekeyKind.SIGNED, bundle.signedPreKey.keyId)
        if signed_key_tuple in existing_prekeys:
            existing = existing_prekeys[signed_key_tuple]
            if existing.public_key != signed_pub_bytes:
                await session.rollback()
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="prekey_id_conflict",
                )
            # Identical signed prekey already exists; ignore duplicate
        else:
            new_prekeys.append(
                Prekey(
                    user_id=current_user.user_id,
                    kind=PrekeyKind.SIGNED,
                    key_id=bundle.signedPreKey.keyId,
                    public_key=signed_pub_bytes,
                    signature=signed_sig_bytes,
                )
            )

        # Check one-time prekeys
        for otpk in bundle.oneTimePreKeys:
            otpk_bytes = base64.b64decode(otpk.publicKey)
            otpk_tuple = (PrekeyKind.ONE_TIME, otpk.keyId)
            if otpk_tuple in existing_prekeys:
                existing = existing_prekeys[otpk_tuple]
                if existing.public_key != otpk_bytes:
                    await session.rollback()
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail="prekey_id_conflict",
                    )
                # Identical one-time prekey already exists; ignore duplicate
            else:
                new_prekeys.append(
                    Prekey(
                        user_id=current_user.user_id,
                        kind=PrekeyKind.ONE_TIME,
                        key_id=otpk.keyId,
                        public_key=otpk_bytes,
                        signature=None,
                    )
                )

        # 4. Update user record and persist new prekeys transactionally
        current_user.identity_key = identity_key_bytes
        current_user.registration_id = bundle.registrationId
        session.add(current_user)

        for p in new_prekeys:
            session.add(p)

        await session.commit()
    except HTTPException:
        raise
    except Exception:
        await session.rollback()
        raise

    log.info(
        "prekey bundle uploaded: user_id=%s identity_changed=%s new_prekeys=%d",
        current_user.user_id,
        identity_changed,
        len(new_prekeys),
    )
    return BundleUploadResponse(identity_changed=identity_changed)


@router.get(
    "/bundle/{user_id}",
    status_code=status.HTTP_200_OK,
    response_model=PublicPreKeyBundleResponse,
)
async def get_prekey_bundle(
    user_id: uuid.UUID,
    _: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_db)],
) -> PublicPreKeyBundleResponse:
    """Retrieve a user's public prekey bundle to establish an E2EE session.

    Returns the newest signed prekey and atomically consumes at most one unconsumed
    one-time prekey. If one-time prekeys are exhausted, returns an empty array.
    """
    # 1. Verify user exists and has published a bundle
    stmt = select(User).where(User.user_id == user_id)
    result = await session.execute(stmt)
    target_user = result.scalar_one_or_none()

    if (
        target_user is None
        or target_user.identity_key is None
        or target_user.registration_id is None
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="bundle_not_found",
        )

    # 2. Retrieve newest signed prekey
    signed_stmt = (
        select(Prekey)
        .where(
            Prekey.user_id == user_id,
            Prekey.kind == PrekeyKind.SIGNED,
        )
        .order_by(Prekey.created_at.desc(), Prekey.key_id.desc())
        .limit(1)
    )
    signed_res = await session.execute(signed_stmt)
    signed_prekey = signed_res.scalar_one_or_none()

    if signed_prekey is None or signed_prekey.signature is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="bundle_not_found",
        )

    # 3. Atomically consume at most one unconsumed OTPK (optimistic retry loop)
    claimed_otpk: Prekey | None = None
    for _ in range(5):
        cand_stmt = (
            select(Prekey)
            .where(
                Prekey.user_id == user_id,
                Prekey.kind == PrekeyKind.ONE_TIME,
                Prekey.consumed_at.is_(None),
            )
            .order_by(Prekey.key_id.asc())
            .limit(1)
        )
        cand_res = await session.execute(cand_stmt)
        candidate = cand_res.scalar_one_or_none()
        if candidate is None:
            # OTPKs exhausted
            break

        now = datetime.now(UTC)
        upd = (
            update(Prekey)
            .where(
                Prekey.id == candidate.id,
                Prekey.consumed_at.is_(None),
            )
            .values(consumed_at=now)
        )
        upd_res = await session.execute(upd)
        if upd_res.rowcount == 1:
            await session.commit()
            claimed_otpk = candidate
            break
        else:
            await session.rollback()

    one_time_list: list[OneTimePreKeyPublic] = []
    if claimed_otpk is not None:
        one_time_list.append(
            OneTimePreKeyPublic(
                keyId=claimed_otpk.key_id,
                publicKey=base64.b64encode(claimed_otpk.public_key).decode("ascii"),
            )
        )

    return PublicPreKeyBundleResponse(
        userId=str(target_user.user_id),
        registrationId=target_user.registration_id,
        identityKey=base64.b64encode(target_user.identity_key).decode("ascii"),
        signedPreKey=SignedPreKeyPublic(
            keyId=signed_prekey.key_id,
            publicKey=base64.b64encode(signed_prekey.public_key).decode("ascii"),
            signature=base64.b64encode(signed_prekey.signature).decode("ascii"),
        ),
        oneTimePreKeys=one_time_list,
        createdAt=datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )


@router.get(
    "/count",
    status_code=status.HTTP_200_OK,
    response_model=KeyCountResponse,
)
async def get_key_count(
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_db)],
) -> KeyCountResponse:
    """Return inventory of available one-time prekeys and active signed prekey ID."""
    otpk_count_stmt = (
        select(func.count())
        .select_from(Prekey)
        .where(
            Prekey.user_id == current_user.user_id,
            Prekey.kind == PrekeyKind.ONE_TIME,
            Prekey.consumed_at.is_(None),
        )
    )
    otpk_res = await session.execute(otpk_count_stmt)
    one_time_prekeys = otpk_res.scalar() or 0

    signed_stmt = (
        select(Prekey.key_id)
        .where(
            Prekey.user_id == current_user.user_id,
            Prekey.kind == PrekeyKind.SIGNED,
        )
        .order_by(Prekey.created_at.desc(), Prekey.key_id.desc())
        .limit(1)
    )
    signed_res = await session.execute(signed_stmt)
    signed_prekey_id = signed_res.scalar_one_or_none()

    return KeyCountResponse(
        one_time_prekeys=one_time_prekeys,
        signed_prekey_id=signed_prekey_id,
    )
