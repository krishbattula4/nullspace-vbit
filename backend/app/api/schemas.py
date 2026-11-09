"""Pydantic schemas for request validation and public API responses."""
import uuid
from datetime import datetime
from typing import Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=32, pattern=r"^[A-Za-z0-9_]+$")
    password: str = Field(min_length=10)
    display_name: str | None = None

    @field_validator("username")
    @classmethod
    def lowercase_username(cls, v: str) -> str:
        return v.lower()

    @field_validator("password")
    @classmethod
    def validate_password_bytes(cls, v: str) -> str:
        if len(v.encode("utf-8")) > 72:
            raise ValueError("Password must not exceed 72 UTF-8 bytes")
        return v

    @model_validator(mode="after")
    def validate_and_default(self) -> Self:
        if self.password.lower() == self.username.lower():
            raise ValueError("Password cannot be equal to username")

        if self.display_name is None:
            self.display_name = self.username
        else:
            stripped = self.display_name.strip()
            if not (1 <= len(stripped) <= 64):
                raise ValueError("Display name must be between 1 and 64 characters")
            self.display_name = stripped

        return self


class UserPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    user_id: uuid.UUID
    username: str
    display_name: str
    created_at: datetime
