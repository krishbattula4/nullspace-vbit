"""Pydantic schemas for the Key Directory API."""
import base64
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator


def _validate_base64_length(v: str, expected_length: int, field_name: str) -> str:
    if not isinstance(v, str) or not v:
        raise ValueError(f"{field_name} must be a non-empty base64 string")
    try:
        raw = base64.b64decode(v, validate=True)
    except Exception as exc:
        raise ValueError(f"{field_name} must be valid base64") from exc
    if len(raw) != expected_length:
        raise ValueError(
            f"{field_name} must decode to exactly {expected_length} bytes, got {len(raw)}"
        )
    return v


class SignedPreKeyUpload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    keyId: int = Field(ge=1, strict=True, description="Signed prekey ID.")
    publicKey: str = Field(description="Base64 33-byte Curve25519 signed prekey.")
    signature: str = Field(description="Base64 64-byte Ed25519 signature.")

    @field_validator("publicKey")
    @classmethod
    def validate_public_key(cls, v: str) -> str:
        return _validate_base64_length(v, 33, "publicKey")

    @field_validator("signature")
    @classmethod
    def validate_signature(cls, v: str) -> str:
        return _validate_base64_length(v, 64, "signature")


class OneTimePreKeyUpload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    keyId: int = Field(ge=1, strict=True, description="One-time prekey ID.")
    publicKey: str = Field(description="Base64 33-byte Curve25519 one-time prekey.")

    @field_validator("publicKey")
    @classmethod
    def validate_public_key(cls, v: str) -> str:
        return _validate_base64_length(v, 33, "publicKey")


class PreKeyBundleUpload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    userId: str = Field(min_length=1, strict=True, description="User UUID string.")
    registrationId: int = Field(ge=1, le=16380, strict=True, description="Registration ID.")
    identityKey: str = Field(description="Base64 33-byte Curve25519 identity key.")
    signedPreKey: SignedPreKeyUpload
    oneTimePreKeys: list[OneTimePreKeyUpload] = Field(
        default_factory=list,
        max_length=200,
        description="List of one-time prekeys (maximum 200).",
    )
    createdAt: str = Field(description="ISO 8601 UTC timestamp of bundle creation.")

    @field_validator("identityKey")
    @classmethod
    def validate_identity_key(cls, v: str) -> str:
        return _validate_base64_length(v, 33, "identityKey")

    @field_validator("oneTimePreKeys")
    @classmethod
    def validate_unique_key_ids(cls, v: list[OneTimePreKeyUpload]) -> list[OneTimePreKeyUpload]:
        if len(v) > 200:
            raise ValueError("Maximum 200 one-time prekeys per upload")
        key_ids = [item.keyId for item in v]
        if len(key_ids) != len(set(key_ids)):
            raise ValueError("Duplicate keyId found in oneTimePreKeys")
        return v

    @field_validator("createdAt")
    @classmethod
    def validate_created_at(cls, v: str) -> str:
        try:
            datetime.fromisoformat(v.replace("Z", "+00:00"))
        except Exception as exc:
            raise ValueError("createdAt must be a valid ISO 8601 timestamp") from exc
        return v


class BundleUploadResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    identity_changed: bool


class SignedPreKeyPublic(BaseModel):
    model_config = ConfigDict(extra="forbid")

    keyId: int
    publicKey: str
    signature: str


class OneTimePreKeyPublic(BaseModel):
    model_config = ConfigDict(extra="forbid")

    keyId: int
    publicKey: str


class PublicPreKeyBundleResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    userId: str
    registrationId: int
    identityKey: str
    signedPreKey: SignedPreKeyPublic
    oneTimePreKeys: list[OneTimePreKeyPublic]
    createdAt: str


class KeyCountResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    one_time_prekeys: int
    signed_prekey_id: int | None
