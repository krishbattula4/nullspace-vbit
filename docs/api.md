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

### Get Current User Profile

Retrieves the public profile of the currently authenticated user.

- **Method**: `GET`
- **Path**: `/auth/me`
- **Headers**:
  - `Authorization: Bearer <access_token>` (Required)

#### Responses

##### 200 OK
Returned when the access token is valid and the user account exists.

**Response Body**:
```json
{
  "user_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "username": "alice",
  "display_name": "Alice",
  "created_at": "2026-11-09T12:00:00Z"
}
```

##### 401 Unauthorized
Returned when authentication fails. Always includes response header `WWW-Authenticate: Bearer`.

Error details:
- **`not_authenticated`**: The `Authorization` header is missing, malformed, does not use the `Bearer` scheme, or has an empty token value.
- **`token_expired`**: The presented access token has passed its expiration timestamp (`exp`).
- **`invalid_token`**: The token is invalid, has an invalid signature, is missing required claims, has an algorithm other than `HS256`, is a refresh token instead of an access token, or the user referenced in `sub` no longer exists.

**Example Response Body**:
```json
{
  "detail": "not_authenticated"
}
```

---

## Users

### Search Users

Searches registered users by username prefix (case-insensitive). The authenticated caller is automatically excluded from results.

- **Method**: `GET`
- **Path**: `/users/search`
- **Headers**:
  - `Authorization: Bearer <access_token>` (Required)

#### Query Parameters

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `q` | string | Yes | None | 2 to 32 characters | Username prefix search query. `%` and `_` are treated as literal characters. |

#### Responses

##### 200 OK
Returned when the query is valid and search executes.

**Response Body**: Array of `UserPublic` objects (maximum 20 items, sorted by `username` ascending).

```json
[
  {
    "user_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "username": "alex_ander",
    "display_name": "Alex",
    "created_at": "2026-11-09T12:00:00Z"
  },
  {
    "user_id": "3f8b1c4e-5a2d-4e9f-8c3b-1a2b3c4d5e6f",
    "username": "alice_wonder",
    "display_name": "Alice Wonder",
    "created_at": "2026-11-09T12:05:00Z"
  }
]
```

##### 401 Unauthorized
Returned when authentication fails. Detail: `not_authenticated`, `token_expired`, or `invalid_token`.

##### 422 Unprocessable Entity
Returned when `q` is shorter than 2 characters, longer than 32 characters, or omitted.

---

## Conversations

### Create or Retrieve Conversation

Creates a new two-party conversation between the authenticated user and a specified peer, or retrieves the existing conversation if one already exists.

- **Method**: `POST`
- **Path**: `/conversations`
- **Headers**:
  - `Authorization: Bearer <access_token>` (Required)
- **Content-Type**: `application/json`

#### Request Body Schema

| Field | Type | Required | Description |
|---|---|---|---|
| `peer_id` | UUID | Yes | The target user ID to start or resume a conversation with. |

#### Request Example
```json
{
  "peer_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
}
```

#### Responses

##### 201 Created
Returned when a new conversation channel is created.

##### 200 OK
Returned when a conversation channel between the two users already exists.

**Response Body**:
```json
{
  "id": "e3b0c442-98fc-1c14-9afbf4c8996fb924",
  "user_a_id": "11111111-1111-1111-1111-111111111111",
  "user_b_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "peer": {
    "user_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "username": "bob",
    "display_name": "Bob Builder",
    "created_at": "2026-11-09T12:00:00Z"
  },
  "verified_by_me": false,
  "verified_by_peer": false,
  "created_at": "2026-11-19T10:00:00Z",
  "last_message_at": null,
  "unread_count": 0
}
```

> [!NOTE]
> User IDs are always canonically sorted so that `user_a_id < user_b_id`. Concurrent creation race conditions are caught and handled atomically.

##### 400 Bad Request
Returned when `peer_id` equals the authenticated user's ID.

**Response Body**:
```json
{
  "detail": "cannot_chat_with_self"
}
```

##### 401 Unauthorized
Returned when authentication fails. Detail: `not_authenticated`, `token_expired`, or `invalid_token`.

##### 404 Not Found
Returned when `peer_id` does not match any registered user.

**Response Body**:
```json
{
  "detail": "user_not_found"
}
```

##### 422 Unprocessable Entity
Returned when request parameters fail schema validation (e.g. malformed UUID).

---

### List Conversations

Lists all conversations involving the authenticated user, ordered by newest activity first.

- **Method**: `GET`
- **Path**: `/conversations`
- **Headers**:
  - `Authorization: Bearer <access_token>` (Required)

#### Responses

##### 200 OK
Returned on successful query.

**Response Body**: Array of `ConversationResponse` objects.

```json
[
  {
    "id": "e3b0c442-98fc-1c14-9afbf4c8996fb924",
    "user_a_id": "11111111-1111-1111-1111-111111111111",
    "user_b_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "peer": {
      "user_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      "username": "bob",
      "display_name": "Bob Builder",
      "created_at": "2026-11-09T12:00:00Z"
    },
    "verified_by_me": true,
    "verified_by_peer": false,
    "created_at": "2026-11-19T10:00:00Z",
    "last_message_at": "2026-11-19T10:30:00Z",
    "unread_count": 2
  }
]
```

##### 401 Unauthorized
Returned when authentication fails. Detail: `not_authenticated`, `token_expired`, or `invalid_token`.

---

### Get Message History

Retrieves keyset-paginated message history for a conversation, ordered newest first by `(created_at, id)` descending. Each message contains nested versions ordered by `version_no` ascending.

- **Method**: `GET`
- **Path**: `/conversations/{id}/messages`
- **Headers**:
  - `Authorization: Bearer <access_token>` (Required)

#### Path Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | UUID | Yes | Unique conversation ID. |

#### Query Parameters

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `before` | string (UUID) | No | None | Valid message UUID | Keyset pagination cursor. The cursor is exclusive; only messages older than the message identified by this cursor in `(created_at DESC, id DESC)` order are returned. Malformed UUIDs, unknown message IDs, or cursor messages belonging to another conversation are rejected with HTTP 422. |
| `limit` | integer | No | 50 | 1 to 100 | Maximum number of messages to return per page. Defaults to 50. Allowed range is 1 to 100. |

#### Responses

##### 200 OK
Returned on successful query.

**Response Body**: Array of `MessageResponse` objects with nested `MessageVersionResponse` items.

```json
[
  {
    "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "conversation_id": "e3b0c442-98fc-1c14-9afbf4c8996fb924",
    "sender_id": "11111111-1111-1111-1111-111111111111",
    "client_msg_id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    "current_version": 2,
    "status": "SENT",
    "created_at": "2026-11-19T10:05:00Z",
    "delivered_at": null,
    "read_at": null,
    "versions": [
      {
        "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "message_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        "version_no": 1,
        "ctype": 3,
        "ciphertext": "c2VjcmV0X3ByZWtleV9jaXBoZXJ0ZXh0",
        "action": "CREATE",
        "actor_id": "11111111-1111-1111-1111-111111111111",
        "created_at": "2026-11-19T10:05:00Z",
        "erased_at": null
      },
      {
        "id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
        "message_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        "version_no": 2,
        "ctype": 1,
        "ciphertext": "c2VjcmV0X2VkaXRlZF9jaXBoZXJ0ZXh0",
        "action": "EDIT",
        "actor_id": "11111111-1111-1111-1111-111111111111",
        "created_at": "2026-11-19T10:10:00Z",
        "erased_at": null
      }
    ]
  }
]
```

> [!NOTE]
> - `ciphertext` is Base64 encoded in responses.
> - For tombstoned / erased versions (`action: DELETE`), `ciphertext` is returned as empty string `""` and `erased_at` contains the timestamp of deletion.
> - Versions for all messages in the page are fetched in a single batched query to prevent N+1 queries.

##### 401 Unauthorized
Returned when authentication fails. Detail: `not_authenticated`, `token_expired`, or `invalid_token`.

##### 404 Not Found
Returned when the conversation does not exist or the authenticated user is not a participant in the conversation.

> [!IMPORTANT]
> To prevent conversation enumeration, requesting a conversation where the user is not a participant returns HTTP 404 `conversation_not_found`, never 403.

**Response Body**:
```json
{
  "detail": "conversation_not_found"
}
```

##### 422 Unprocessable Entity
Returned when request parameters fail validation:
- `before` is malformed (not a valid UUID), syntactically valid but unknown in the database, or refers to a message from another conversation (`invalid_cursor`).
- `limit` is outside the allowed range of 1 to 100 or is not a valid integer.
- Path parameters fail schema validation.

**Example Response Body**:
```json
{
  "detail": "invalid_cursor"
}
```

---

## Key Directory

### Upload Prekey Bundle

Uploads or replenishes the public Signal Protocol prekey bundle for the authenticated user, establishing identity keys, medium-term signed prekeys, and one-time prekeys (OTPKs).

- **Method**: `PUT`
- **Path**: `/keys/bundle`
- **Content-Type**: `application/json`
- **Authentication**: Required (`Bearer <access_token>`)

#### Request Body Schema

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `userId` | string | Yes | Must match authenticated caller's UUID | User identifier owning the prekey bundle. |
| `registrationId` | integer | Yes | 1 to 16380 (strict integer) | Signal Protocol local registration ID. |
| `identityKey` | string | Yes | Base64-encoded, exactly 33 bytes (Curve25519) | Long-term identity public key with `0x05` prefix. |
| `signedPreKey` | object | Yes | Strict object: `keyId`, `publicKey`, `signature` | Medium-term signed prekey and signature. |
| `signedPreKey.keyId` | integer | Yes | >= 1 (strict integer) | Unique identifier for the signed prekey. |
| `signedPreKey.publicKey` | string | Yes | Base64-encoded, exactly 33 bytes (Curve25519) | Signed prekey public key bytes. |
| `signedPreKey.signature` | string | Yes | Base64-encoded, exactly 64 bytes (Ed25519/XEdDSA) | Signature over the signed prekey public key. |
| `oneTimePreKeys` | array | Yes | Maximum 200 items; unique `keyId`s | Array of one-time prekey objects (`keyId`, `publicKey`). May be empty. |
| `oneTimePreKeys[].keyId`| integer | Yes | >= 1 (strict integer) | Unique identifier for the one-time prekey. |
| `oneTimePreKeys[].publicKey` | string | Yes | Base64-encoded, exactly 33 bytes (Curve25519) | One-time prekey public key bytes. |
| `createdAt` | string | Yes | ISO 8601 UTC timestamp format | Timestamp when the bundle was generated. |

> [!NOTE]
> The server does not verify the XEdDSA signature over the signed prekey because that requires libsignal/curve25519 cryptographic primitives. Cryptographic signature verification is strictly performed client-side by peers before establishing an X3DH session.

#### Behavior & Invariants
- **Re-registration**: If `identityKey` differs from the user's currently stored identity key, it is treated as a re-registration: the server deletes all unconsumed one-time prekeys for the user and reports `identity_changed: true`. If unchanged, reports `identity_changed: false`.
- **Prekey ID Conflict**: If an uploaded prekey ID (signed or one-time) already exists in the database with a different public key, the server rejects the request with HTTP 409 `prekey_id_conflict`. The transaction is rolled back and nothing is stored.
- **Idempotency**: An identical re-upload (same key ID and identical public key bytes) is ignored rather than creating duplicate records or throwing an error.

#### Responses

##### 200 OK
Returned when the bundle is successfully stored or updated.

**Response Body**:
```json
{
  "identity_changed": false
}
```

##### 401 Unauthorized
Returned when authentication credentials are missing, invalid, or expired (`not_authenticated`, `invalid_token`, `token_expired`).

##### 403 Forbidden
Returned when the `userId` in the request body does not match the authenticated caller's user ID.

**Response Body**:
```json
{
  "detail": "user_mismatch"
}
```

##### 409 Conflict
Returned when a prekey ID already exists in the database with a different public key.

**Response Body**:
```json
{
  "detail": "prekey_id_conflict"
}
```

##### 422 Unprocessable Entity
Returned when payload fails validation:
- Key bytes length mismatch (identity, signed prekey, or OTPK not 33 bytes; signature not 64 bytes).
- Malformed base64 encoding.
- Duplicate `keyId` values within `oneTimePreKeys`.
- More than 200 one-time prekeys.
- `registrationId` outside `1..16380`.
- Unknown extra properties.

---

### Retrieve Peer Prekey Bundle

Retrieves the public prekey bundle of a peer user to initiate an end-to-end encrypted session via X3DH.

- **Method**: `GET`
- **Path**: `/keys/bundle/{user_id}`
- **Authentication**: Required (`Bearer <access_token>`)

#### Behavior & Invariants
- **Newest Signed Prekey**: Always returns the user's most recently uploaded signed prekey.
- **Atomic OTPK Consumption**: Atomically burns at most ONE unconsumed one-time prekey using optimistic concurrency control (up to 5 retries). Once consumed, an OTPK is never returned again.
- **Exhausted Prekeys**: If all one-time prekeys for the peer have been consumed, returns `oneTimePreKeys: []` (empty array) so the caller can still fall back to establishing a session without an OTPK.
- **Schema Compliance**: The response strictly adheres to `docs/schemas/prekey-bundle.schema.json`.

#### Responses

##### 200 OK
Returned when the peer's public bundle is successfully retrieved.

**Response Body**:
```json
{
  "userId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "registrationId": 1234,
  "identityKey": "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUF",
  "signedPreKey": {
    "keyId": 1,
    "publicKey": "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUF",
    "signature": "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBw=="
  },
  "oneTimePreKeys": [
    {
      "keyId": 10,
      "publicKey": "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUF"
    }
  ],
  "createdAt": "2026-11-19T12:00:00Z"
}
```

##### 401 Unauthorized
Returned when authentication credentials are missing or invalid.

##### 404 Not Found
Returned when the requested user does not exist or has not uploaded a prekey bundle.

**Response Body**:
```json
{
  "detail": "bundle_not_found"
}
```

##### 422 Unprocessable Entity
Returned when `user_id` is not a valid UUID format.

---

### Get Key Inventory Count

Returns the authenticated caller's inventory of available one-time prekeys and active signed prekey ID. Used by clients to monitor prekey depletion and determine when replenishment is needed.

- **Method**: `GET`
- **Path**: `/keys/count`
- **Authentication**: Required (`Bearer <access_token>`)

#### Responses

##### 200 OK
Returned with the caller's key inventory metrics.

**Response Body**:
```json
{
  "one_time_prekeys": 42,
  "signed_prekey_id": 3
}
```

> [!NOTE]
> `signed_prekey_id` returns `null` if the user has not uploaded any signed prekeys. No private keys or raw key bytes are ever returned in count responses.

##### 401 Unauthorized
Returned when authentication credentials are missing or invalid.

---

## Security and Privacy Rules

1. **Password Hashing**: Passwords are hashed using standard bcrypt (`$2b$`) with cost factor configured via `BCRYPT_ROUNDS` (defaults to 12).
2. **Byte Limit**: Inputs exceeding 72 UTF-8 bytes are rejected with validation errors rather than silently truncated.
3. **Audit & Logging**: Registration and login events log user IDs only (`user registered: user_id=<uuid>`, `user logged in: user_id=<uuid>`). Passwords, hashes, and tokens are never written to log outputs or error messages.
4. **JWT Security**: All tokens are signed with `HS256` using `settings.jwt_secret`. Algorithm `"none"` and non-whitelisted algorithms are strictly rejected.
5. **Single-Use Rotation**: Refresh tokens are single-use with database-backed atomic rotation. Presentation of an already-revoked token triggers immediate cascade revocation of all active refresh tokens for that user.
6. **Timing Attack Mitigation**: Login requests for non-existent users compute a dummy bcrypt verification to maintain constant-time parity with invalid password attempts.
