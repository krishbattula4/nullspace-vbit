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

### User Login

Authenticates user credentials and issues short-lived access JWT and rotating single-use refresh JWT.

- **Method**: `POST`
- **Path**: `/auth/login`
- **Content-Type**: `application/json`

#### Request Body Schema

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `username` | string | Yes | Non-empty string | Account username (converted to lowercase). |
| `password` | string | Yes | Non-empty string | Account password. |

#### Request Example
```json
{
  "username": "alice",
  "password": "correct_horse_battery_staple"
}
```

#### Responses

##### 200 OK
Returned on successful authentication.

**Response Body**:
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "bearer",
  "expires_in": 900
}
```

##### 401 Unauthorized
Returned when username does not exist or password does not match.

> [!NOTE]
> Non-existent usernames and incorrect passwords both execute password verification against a dummy hash and return byte-identical responses to mitigate user enumeration timing attacks.

**Response Body**:
```json
{
  "detail": "invalid_credentials"
}
```

---

### Rotate Refresh Token

Rotates a single-use refresh token and issues a new access/refresh token pair.

- **Method**: `POST`
- **Path**: `/auth/refresh`
- **Content-Type**: `application/json`

#### Request Body Schema

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `refresh_token` | string | Yes | Valid HS256 refresh JWT | Current active refresh token. |

#### Request Example
```json
{
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

#### Responses

##### 200 OK
Returned when refresh token rotation succeeds.

**Response Body**:
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "bearer",
  "expires_in": 900
}
```

##### 401 Unauthorized
Returned under the following conditions:
- **`invalid_token`**: Token is malformed, has invalid signature, missing claims, algorithm other than `HS256`, or is not type `refresh`.
- **`token_expired`**: The refresh token has passed its expiration time.
- **`refresh_reuse_detected`**: An already-revoked refresh token was presented. The server treats this as theft, immediately revokes **all** refresh tokens belonging to the user, and returns this error.

**Example Response Body**:
```json
{
  "detail": "refresh_reuse_detected"
}
```

---

### Logout

Revokes the presented refresh token.

- **Method**: `POST`
- **Path**: `/auth/logout`
- **Content-Type**: `application/json`

#### Request Body Schema

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `refresh_token` | string | Yes | Non-empty string | The refresh token to revoke. |

#### Request Example
```json
{
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

#### Responses

##### 204 No Content
Returned on successful logout. Idempotent: returns 204 even if the token is already revoked, expired, unknown, or malformed.

---

## Security and Privacy Rules

1. **Password Hashing**: Passwords are hashed using standard bcrypt (`$2b$`) with cost factor configured via `BCRYPT_ROUNDS` (defaults to 12).
2. **Byte Limit**: Inputs exceeding 72 UTF-8 bytes are rejected with validation errors rather than silently truncated.
3. **Audit & Logging**: Registration and login events log user IDs only (`user registered: user_id=<uuid>`, `user logged in: user_id=<uuid>`). Passwords, hashes, and tokens are never written to log outputs or error messages.
4. **JWT Security**: All tokens are signed with `HS256` using `settings.jwt_secret`. Algorithm `"none"` and non-whitelisted algorithms are strictly rejected.
5. **Single-Use Rotation**: Refresh tokens are single-use with database-backed atomic rotation. Presentation of an already-revoked token triggers immediate cascade revocation of all active refresh tokens for that user.
6. **Timing Attack Mitigation**: Login requests for non-existent users compute a dummy bcrypt verification to maintain constant-time parity with invalid password attempts.
