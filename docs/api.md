# Nullspace REST API Specification

This document specifies the REST API endpoints provided by the Nullspace backend server.

---

## Authentication

### Register Account

Creates a new user account with secure bcrypt password hashing and username uniqueness enforcement.

- **Method**: `POST`
- **Path**: `/auth/register`
- **Content-Type**: `application/json`

#### Request Body Schema

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `username` | string | Yes | 3 to 32 characters; regex `^[A-Za-z0-9_]+$` | Account username. Automatically converted to lowercase. |
| `password` | string | Yes | 10 to 72 UTF-8 bytes; must not equal `username` (case-insensitive) | User password. Enforces bcrypt 72-byte limit. |
| `display_name` | string | No | 1 to 64 characters (after whitespace stripping) | Public display name. Defaults to `username` if omitted or `null`. |

#### Request Examples

##### Minimal Request
```json
{
  "username": "alice",
  "password": "correct_horse_battery_staple"
}
```

##### Full Request with Custom Display Name
```json
{
  "username": "bob_99",
  "password": "my_super_secret_password_123",
  "display_name": "Bob Builder"
}
```

---

#### Responses

##### 201 Created
Returned when registration succeeds.

**Response Body**:
```json
{
  "user_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "username": "alice",
  "display_name": "alice",
  "created_at": "2026-11-09T12:00:00Z"
}
```

> [!NOTE]
> The response body never includes the user's password, password hash, or intermediate security tokens.

##### 409 Conflict
Returned when the requested username is already registered (case-insensitive match), or when a concurrent registration race condition occurs on commit.

**Response Body**:
```json
{
  "detail": "username_taken"
}
```

##### 422 Unprocessable Entity
Returned when request parameters fail schema validation rules.

Common reasons:
- `username` is shorter than 3 characters, longer than 32 characters, or contains non-alphanumeric/underscore characters (such as spaces or punctuation).
- `password` is shorter than 10 characters or exceeds 72 UTF-8 bytes.
- `password` matches `username` (case-insensitive).
- `display_name` (if provided) is empty after whitespace stripping or exceeds 64 characters.

**Example Response Body**:
```json
{
  "detail": [
    {
      "type": "string_too_short",
      "loc": ["body", "password"],
      "msg": "String should have at least 10 characters",
      "input": "short"
    }
  ]
```

---

## Security and Privacy Rules

1. **Password Hashing**: Passwords are hashed using standard bcrypt (`$2b$`) with cost factor configured via `BCRYPT_ROUNDS` (defaults to 12).
2. **Byte Limit**: Inputs exceeding 72 UTF-8 bytes are rejected with validation errors rather than silently truncated.
3. **Audit & Logging**: Registration actions log `user registered: user_id=<uuid>` only. Passwords, hashes, and raw request bodies are never written to log outputs or error messages.
