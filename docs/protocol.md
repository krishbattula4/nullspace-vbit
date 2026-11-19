# Wire protocol

All WebSocket frames are JSON objects with a `v` (protocol version, currently 1) and a `type`.
Message bodies are **always ciphertext**: base64 of the libsignal output, with `ctype` 3 (`PreKeyWhisperMessage`) or 1 (`WhisperMessage`).
The server never receives, stores or forwards plaintext.

### Device ID Rule

In Nullspace v1, multi-device support is out of scope. Every user has exactly one device, and the Signal Protocol device ID is **always 1** across all addresses and session operations (`new SignalProtocolAddress(userId, 1)`).

### CipherEnvelope Shape (MESSAGE event)

Client-to-client payloads transmitted in the `MESSAGE` and `EDIT` frames correspond to the `CipherEnvelope` structure produced by `SessionManager`:

```typescript
type CipherEnvelope = {
  type: 1 | 3; // 3 = PreKeyWhisperMessage (session initiation via X3DH), 1 = WhisperMessage (active ratchet)
  body: string; // standard base64 encoding of the binary message bytes
};
```

- **`ctype`**: Mapped directly from `CipherEnvelope.type` (`3` for initial handshake message establishing the session, `1` for subsequent ratcheted messages).
- **`body`**: Mapped directly from `CipherEnvelope.body` (standard base64 string derived from raw binary cipher bytes).

### Protocol Rules & Validation

- **Protocol Version**: `PROTOCOL_VERSION = 1`. Every WebSocket data frame must carry integer `"v": 1`.
- **Version Policy**: An unknown `v` is rejected with an ERROR frame carrying code `unsupported_version` and the connection stays open; the sender must upgrade.
- **Control Frames Exception**: Control frames carry NO `v` property: `AUTH`, `AUTH_OK`, `PING`, `PONG`.
- **Field Rules**:
  - **UUID**: Canonical lowercase hyphenated UUID strings matching `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`. Uppercase and non-hyphenated strings are rejected.
  - **`ctype`**: Strictly integer `1` (`WhisperMessage`) or `3` (`PreKeyWhisperMessage`). Any other integer or type is rejected.
  - **`body`**: Standard-alphabet base64 with correct padding, non-empty, decoded size at most `MAX_BODY_BYTES = 65536` bytes (base64 text at most 87384 characters). Non-canonical padding is rejected.
  - **Timestamps**: ISO 8601 UTC strings ending in `Z` (e.g. `2026-11-18T12:00:00Z`).
  - **Strict Schemas**: Unknown extra fields are rejected on both client and server frames.
- **Client-Side Event**: `KEY_CHANGED` is a CLIENT-SIDE event only (raised when a contact's identity key differs). It never travels over the wire: the backend must reject it as `unknown_type`; the TypeScript side defines its type `{type:"KEY_CHANGED", user_id}` for the UI event bus only.

### Client -> Server Frames (all need v)

1. **`MESSAGE`**: Transmits an end-to-end encrypted message.
   - Fields: `conversation_id`, `client_msg_id`, `ctype`, `body`
   ```json
   {
     "v": 1,
     "type": "MESSAGE",
     "conversation_id": "11111111-1111-1111-1111-111111111111",
     "client_msg_id": "22222222-2222-2222-2222-222222222222",
     "ctype": 1,
     "body": "AQID"
   }
   ```

2. **`DELIVERED`**: Recipient confirms receipt of message ciphertext.
   - Fields: `message_id`
   ```json
   {
     "v": 1,
     "type": "DELIVERED",
     "message_id": "44444444-4444-4444-4444-444444444444"
   }
   ```

3. **`READ`**: Recipient confirms user has read the message.
   - Fields: `message_id`
   ```json
   {
     "v": 1,
     "type": "READ",
     "message_id": "44444444-4444-4444-4444-444444444444"
   }
   ```

4. **`EDIT`**: Sender publishes a newly encrypted revision of an existing message.
   - Fields: `message_id`, `ctype`, `body`
   ```json
   {
     "v": 1,
     "type": "EDIT",
     "message_id": "44444444-4444-4444-4444-444444444444",
     "ctype": 1,
     "body": "BAUG"
   }
   ```

5. **`DELETE`**: Sender deletes message prior to read (ciphertext erased on server).
   - Fields: `message_id`
   ```json
   {
     "v": 1,
     "type": "DELETE",
     "message_id": "44444444-4444-4444-4444-444444444444"
   }
   ```

6. **`RETRACT`**: Sender retracts message after read (ciphertext preserved, bubble collapsed).
   - Fields: `message_id`
   ```json
   {
     "v": 1,
     "type": "RETRACT",
     "message_id": "44444444-4444-4444-4444-444444444444"
   }
   ```

7. **`TYPING`**: Ephemeral typing indicator for a conversation.
   - Fields: `conversation_id`
   ```json
   {
     "v": 1,
     "type": "TYPING",
     "conversation_id": "11111111-1111-1111-1111-111111111111"
   }
   ```

### Server -> Client Frames (all need v)

1. **`MESSAGE`**: Relayed ciphertext message with assigned ID and metadata.
   - Fields: `message_id`, `conversation_id`, `sender_id`, `version_no` (int >= 1), `ctype`, `body`, `created_at`
   ```json
   {
     "v": 1,
     "type": "MESSAGE",
     "message_id": "44444444-4444-4444-4444-444444444444",
     "conversation_id": "11111111-1111-1111-1111-111111111111",
     "sender_id": "55555555-5555-5555-5555-555555555555",
     "version_no": 1,
     "ctype": 1,
     "body": "AQID",
     "created_at": "2026-11-18T12:00:00Z"
   }
   ```

2. **`ACK`**: Server acknowledgment confirming receipt and routing status of a sent message.
   - Fields: `client_msg_id`, `message_id`, `status` (`"SENT"` or `"QUEUED"`)
   ```json
   {
     "v": 1,
     "type": "ACK",
     "client_msg_id": "22222222-2222-2222-2222-222222222222",
     "message_id": "44444444-4444-4444-4444-444444444444",
     "status": "SENT"
   }
   ```

3. **`DELIVERED`**: Delivery notification relayed to the sender.
   - Fields: `message_id`, `delivered_at`
   ```json
   {
     "v": 1,
     "type": "DELIVERED",
     "message_id": "44444444-4444-4444-4444-444444444444",
     "delivered_at": "2026-11-18T12:00:05Z"
   }
   ```

4. **`READ`**: Read receipt relayed to the sender.
   - Fields: `message_id`, `read_at`
   ```json
   {
     "v": 1,
     "type": "READ",
     "message_id": "44444444-4444-4444-4444-444444444444",
     "read_at": "2026-11-18T12:00:10Z"
   }
   ```

5. **`EDIT`**: Relayed edited version of a message.
   - Fields: `message_id`, `version_no` (int >= 2), `ctype`, `body`, `edited_at`
   ```json
   {
     "v": 1,
     "type": "EDIT",
     "message_id": "44444444-4444-4444-4444-444444444444",
     "version_no": 2,
     "ctype": 1,
     "body": "BAUG",
     "edited_at": "2026-11-18T12:00:15Z"
   }
   ```

6. **`DELETE`**: Relayed message deletion broadcast.
   - Fields: `message_id`
   ```json
   {
     "v": 1,
     "type": "DELETE",
     "message_id": "44444444-4444-4444-4444-444444444444"
   }
   ```

7. **`RETRACT`**: Relayed message retraction broadcast.
   - Fields: `message_id`
   ```json
   {
     "v": 1,
     "type": "RETRACT",
     "message_id": "44444444-4444-4444-4444-444444444444"
   }
   ```

8. **`TYPING`**: Relayed ephemeral typing event.
   - Fields: `conversation_id`, `user_id`
   ```json
   {
     "v": 1,
     "type": "TYPING",
     "conversation_id": "11111111-1111-1111-1111-111111111111",
     "user_id": "55555555-5555-5555-5555-555555555555"
   }
   ```

9. **`PRESENCE`**: Contact online / offline state change.
   - Fields: `user_id`, `online` (boolean)
   ```json
   {
     "v": 1,
     "type": "PRESENCE",
     "user_id": "55555555-5555-5555-5555-555555555555",
     "online": true
   }
   ```

10. **`ERROR`**: Server error frame for rejected messages or parser failures.
    - Fields: `code` (string), `detail` (string, optional), `client_msg_id` (UUID, optional)
    ```json
    {
      "v": 1,
      "type": "ERROR",
      "code": "invalid_frame",
      "detail": "bad UUID",
      "client_msg_id": "22222222-2222-2222-2222-222222222222"
    }
    ```

### Control Frames (no v)

- **`AUTH`** (client -> server): Handshake authentication frame sent within 5 seconds of connection.
  ```json
  {
    "type": "AUTH",
    "token": "<access token>"
  }
  ```
- **`AUTH_OK`** (server -> client): Handshake acknowledgment confirming connection registration.
  ```json
  {
    "type": "AUTH_OK",
    "user_id": "55555555-5555-5555-5555-555555555555"
  }
  ```
- **`PING`**: Heartbeat probe frame.
  ```json
  {
    "type": "PING"
  }
  ```
- **`PONG`**: Heartbeat response frame.
  ```json
  {
    "type": "PONG"
  }
  ```

### Parser and Routing Error Codes

When a received WebSocket data frame violates protocol rules or routing constraints, the server generates an `ERROR` frame with one of the following canonical error codes:

| Error Code | Meaning |
|---|---|
| `invalid_json` | The payload text is not valid JSON. |
| `not_an_object` | The JSON payload is not a JSON object (e.g. array, primitive, null). |
| `missing_version` | The `"v"` field is missing from a data frame. |
| `unsupported_version` | The `"v"` field is not an integer, is a boolean, or is not equal to `1`. |
| `unknown_type` | The `"type"` field is unrecognized, server-only frame sent by client, or control/client-only frame sent as data frame. |
| `invalid_frame` | One or more fields failed validation (e.g. non-canonical UUID, invalid ctype, invalid base64, decoded payload > 65536 bytes, non-canonical padding, extra unknown fields). |
| `conversation_not_found` | The requested conversation does not exist or the authenticated sender is not a participant in the conversation. |

### Message Routing and Persistence Flow

For incoming `MESSAGE` frames:

1. **Client Transmission**: The client transmits an encrypted `MESSAGE` frame containing `conversation_id`, `client_msg_id`, `ctype` (`1` or `3`), and base64 `body`.
2. **Envelope Validation**: The frame is checked against protocol version (`v: 1`) and client frame constraints. Malformed frames generate an `ERROR` frame (`invalid_frame`, `unsupported_version`, `unknown_type`), and the WebSocket connection remains open.
3. **Session & Membership Validation**: A short-lived database session is opened for the frame. The server queries the conversation and verifies that the authenticated `sender_id` matches `user_a_id` or `user_b_id`. If the conversation does not exist or the sender is not a participant, the server sends an `ERROR` frame (`conversation_not_found`), stores no data, and aborts routing.
4. **Idempotency Enforcement**: The server queries for an existing message using `(sender_id, client_msg_id)`. If found, no new message or version rows are inserted; the server immediately returns the original `ACK` referencing the existing server `message_id` and status. Uniqueness races on concurrent requests are safely handled via database uniqueness constraints and transaction rollbacks.
5. **Ciphertext Storage & Persistence**:
   - Exactly one `Message` row is created with server-generated UUID `id`, `conversation_id`, `sender_id`, `client_msg_id`, and initial status (`SENT` if recipient is online, otherwise `QUEUED`).
   - Exactly one `MessageVersion` row is created (`version_no = 1`, `action = CREATE`, `actor_id = sender_id`, `ctype` from frame).
   - Ciphertext in `body` is decoded from standard base64 into raw binary bytes and stored in `message_versions.ciphertext`. Plaintext message content is never received, stored, or logged.
   - The database transaction commits before any delivery attempt occurs (**commit-before-push**).
6. **Recipient Delivery**:
   - The recipient is determined as the other conversation participant.
   - An outgoing `MESSAGE` frame is constructed using `message_frame(...)` and pushed to the recipient using `registry.send_to_user(recipient_id, out_frame)`.
   - The message is never routed back to the sender socket.
7. **Delivery Status & Sender ACK**:
   - If `send_to_user` delivers to at least one active socket, status is `SENT`.
   - If the recipient has no active sockets (offline), status is `QUEUED`.
   - The server transmits an `ACK` frame (`client_msg_id`, `message_id`, `status`) strictly to the originating WebSocket. If the sender has multiple connected tabs, only the tab that submitted the message receives the acknowledgment.

REST (HTTPS) is used for one-shot operations: `/auth/*`, `/keys/*`, `/conversations/*`, `/media/*`, `/me/audit`.

## WebSocket authentication

WebSocket connections are initiated at endpoint `/ws`.

### Handshake flow

1. **Connection Acceptance**: The server accepts the initial WebSocket connection without prior authentication.
2. **Authentication Frame**: The client must send a JSON authentication frame as its first message within 5 seconds (`AUTH_TIMEOUT_SECONDS = 5.0`):
   ```json
   {
     "type": "AUTH",
     "token": "<access token>"
   }
   ```
3. **Validation & Verification**: The server decodes the token enforcing `expected_type="access"` and validates that the user exists in the database. A short-lived database session is used solely for the user lookup and immediately released—no database session is held open for the lifetime of the connection.
4. **Acknowledgment**: On successful authentication, the server registers the socket in the connection registry (`registry`) and sends an acknowledgment frame:
   ```json
   {
     "type": "AUTH_OK",
     "user_id": "<user_uuid>"
   }
   ```
5. **Connection Lifecycle**: The client may maintain multiple active sockets (e.g. across multiple browser tabs). Sockets remain registered until closed or disconnected, at which point they are automatically unregistered from the connection registry in a `finally` block.

### Close codes

If authentication fails, the server closes the WebSocket connection with code `4401` and a short reason string:

| Close Code | Reason String | Condition |
|---|---|---|
| `4401` | `"auth_timeout"` | No frame was received within `AUTH_TIMEOUT_SECONDS` (5 seconds). |
| `4401` | `"token_expired"` | The presented access JWT has expired. |
| `4401` | `"invalid_token"` | Non-JSON payload, frame `type` is not `"AUTH"`, missing or empty `token`, malformed JWT, signature error, refresh token presented instead of access token, or user no longer exists in the database. |

### Zero-token URL query policy

**Authentication tokens are never accepted in the URL query string** (such as `/ws?token=...`).

**Rationale**: URLs and query strings are routinely recorded in plain text across web server access logs, reverse proxy logs, application performance traces, error monitoring dashboards, and browser navigation histories. Placing sensitive Bearer tokens in URLs causes credentials to leak across logging infrastructure. Nullspace strictly ignores query parameter tokens and mandates that authentication occurs over the established WebSocket channel via the encrypted TLS tunnel.

## Heartbeat

WebSocket connections use periodic heartbeat ping/pong frames to detect stale or broken network connections, enforce idle timeouts, and maintain socket health.

### Keepalive flow

1. **Heartbeat Task**: Only after `AUTH_OK` has been sent successfully, the server starts a dedicated heartbeat task for the connection.
2. **Server PING**: The server sends a PING frame every 30 seconds (`HEARTBEAT_INTERVAL_SECONDS = 30.0`):
   ```json
   {
     "type": "PING"
   }
   ```
3. **Client PONG**: The client responds to server PING with a PONG frame:
   ```json
   {
     "type": "PONG"
   }
   ```
4. **Client PING**: If the client sends a `{"type": "PING"}` frame, the server responds immediately with `{"type": "PONG"}`.
5. **Activity Refresh**: Any received frame from the client (PING, PONG, or data payload) refreshes the connection's `last_seen` timestamp in the connection registry (`registry.touch`).
6. **Inactivity Timeout**: Connections that remain inactive for 60 seconds (`HEARTBEAT_TIMEOUT_SECONDS = 60.0`) without receiving any frame are closed.

### Lifecycle close codes

| Close Code | Reason String | Condition |
|---|---|---|
| `4401` | `"auth_timeout"`, `"token_expired"`, `"invalid_token"` | Initial authentication handshake failed or timed out. |
| `4408` | `"heartbeat_timeout"` | Inactive connection; no frame was received within 60 seconds (`HEARTBEAT_TIMEOUT_SECONDS`). |
| `1009` | `"message_too_big"` | Incoming message exceeded `max_message_bytes` (65,536 bytes / 64 KiB). |
| `1011` | `"internal_error"` | Unexpected server-side error encountered during connection processing. |
| `1000` | Normal closure | Connection closed cleanly by client or server. |

When a connection closes or disconnects under any condition, the server cancels and awaits the connection's heartbeat task, removes the socket cleanly from the registry, and cleans up the user's entry when no sockets remain.

## Client key storage

The client persists Signal Protocol state locally using browser IndexedDB via `IndexedDBSignalStore`. Each user account uses an isolated database named:
```
nullspace-signal-${userId}
```
Two accounts in the same browser never share keys, sessions, or trusted identities.

### Object stores

1. **`identity`**: Own identity key pair (`pubKey`, `privKey` as `ArrayBuffer`) and local `registrationId` (integer).
2. **`trustedIdentities`**: Remote public identity keys (`ArrayBuffer`) keyed by remote address string (`name` and `name.deviceId`). Initial handshakes trust keys on first use (TOFU); key replacements trigger change detection via `identityChanged()`.
3. **`preKeys`**: One-time Curve25519 prekey pairs (`pubKey`, `privKey` as `ArrayBuffer`) keyed by `keyId`.
4. **`signedPreKeys`**: Medium-term signed prekey pairs (`pubKey`, `privKey`, and signature as `ArrayBuffer`) keyed by `keyId`.
5. **`sessions`**: Double Ratchet session state records (serialized protocol strings) keyed by remote address (`${name}.${deviceId}`).

### Key security rules

**Private keys never leave IndexedDB.** Key material is generated via browser WebCrypto APIs and persisted directly into IndexedDB as raw `ArrayBuffer` values without base64 encoding or JSON stringification. Private keys are never logged, exported unencrypted, or transmitted over REST or WebSocket connections to the server or any third party.

## Prekey bundle format

Public prekey bundles are JSON payloads published to the backend via `POST /keys` or `PUT /keys` and retrieved by peers initiating Double Ratchet sessions. The schema is formally defined in `docs/schemas/prekey-bundle.schema.json`.

All public keys are Curve25519 public keys prefixed with `0x05` (33 bytes raw, base64-encoded). The signature is an Ed25519 signature over the signed prekey public key bytes (64 bytes raw, base64-encoded).

### Example bundle (fake values)

```json
{
  "userId": "usr_alice123",
  "registrationId": 9876,
  "identityKey": "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUF",
  "signedPreKey": {
    "keyId": 1,
    "publicKey": "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUF",
    "signature": "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBw=="
  },
  "oneTimePreKeys": [
    {
      "keyId": 1,
      "publicKey": "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUF"
    },
    {
      "keyId": 2,
      "publicKey": "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUF"
    }
  ],
  "createdAt": "2026-11-08T12:00:00.000Z"
}
```

## Safety number

Safety numbers provide out-of-band visible key verification between two users to verify that their end-to-end encrypted session is not subject to a man-in-the-middle (MITM) attack or identity key substitution.

- **Format**: 60 decimal digits, displayed as 12 groups of 5 digits separated by spaces across 3 lines of 4 groups each.
- **Algorithm**: Computed using libsignal's `FingerprintGenerator` configured with 5200 iterations (`FINGERPRINT_ITERATIONS = 5200`, iterative SHA-512 hashing).
- **Identifier**: `userId` encoded as UTF-8 bytes (the stable identifier) along with each user's 33-byte Curve25519 identity public key.
- **Symmetry**: Identical on both devices when neither identity key has been substituted. `FingerprintGenerator.createFor` lexicographically sorts the two 30-digit halves before concatenating, ensuring identical digits regardless of which user is local or remote.
- **Security & Privacy**: The safety number never leaves the client device over the wire. It is never sent to the server. Verification is conducted strictly out-of-band (in person, over a secure voice call, or by scanning a QR code in task P4.2).

## Verification states

Nullspace tracks each peer contact's verification status locally on the device using a per-user IndexedDB trust store (`nullspace-trust-${userId}`, object store `trust` keyed by `peerId`).

### State table

| From State | Event | To State | Notes |
|---|---|---|---|
| (none) | `recordFirstUse(k1)` | `UNVERIFIED` | Trust On First Use (TOFU). Stores initial `identityKey = k1`. |
| (none) | `observeIdentity(k1)` | `UNVERIFIED` | Same as `recordFirstUse`; `changed = false`. |
| `UNVERIFIED` | `observeIdentity(k1)` | `UNVERIFIED` | Matching identity key byte-for-byte; `changed = false`. |
| `UNVERIFIED` | `markVerified` | `VERIFIED` | User explicitly verified safety number; sets `verifiedAt` timestamp. |
| `UNVERIFIED` | `observeIdentity(k2)` | `KEY_CHANGED` | Key mismatch: `previousIdentityKey = k1`, `identityKey = k2`, `changedAt = now`, `changed = true`. |
| `VERIFIED` | `observeIdentity(k1)` | `VERIFIED` | Matching identity key byte-for-byte; `changed = false`. |
| `VERIFIED` | `markVerified` | `VERIFIED` | Re-verifying updates `verifiedAt` timestamp. |
| `VERIFIED` | `observeIdentity(k2)` | `KEY_CHANGED` | Key mismatch: `previousIdentityKey = k1`, `identityKey = k2`, `changedAt = now`, `changed = true`. |
| `KEY_CHANGED` | `observeIdentity(k2)` | `KEY_CHANGED` | Matching the currently changed key; `changed = false`. |
| `KEY_CHANGED` | `observeIdentity(k3)` | `KEY_CHANGED` | Key changed again: `previousIdentityKey = k2`, `identityKey = k3`, `changedAt = now`, `changed = true`. |
| `KEY_CHANGED` | `markVerified` | `VERIFIED` | User re-verified the new key: clears `previousIdentityKey` and `changedAt`, sets `verifiedAt`. |
| any | `reset(peerId)` | (none) | Removes peer trust record from local store (used on reset/logout). |
| any | `wipe()` | (none) | Wipes entire trust database for user. |

### Key change security rule

**A key change always produces `KEY_CHANGED` and a visible warning, never a silent overwrite.**

### Key change policy

- **Incoming prekey message with a new identity key**: record `KEY_CHANGED` in the `VerificationStore`, accept the new key in the Signal store, decrypt and deliver the message. The user sees a red "Key changed" state and an in-chat warning (P4.6); messages are never silently dropped.
- **Outgoing session setup with a new identity key**: record `KEY_CHANGED`, do NOT send. The caller gets `IdentityChangedError`. The UI offers "Continue with new key", which calls `acceptNewIdentity`; the state stays `KEY_CHANGED` until the user re-verifies.

## Media encryption

Media attachments (images up to 5 MiB: `image/png`, `image/jpeg`, `image/gif`, `image/webp`) are encrypted client-side using WebCrypto AES-GCM (256-bit key, 96-bit IV) before upload.

The plaintext encryption key and IV travel exclusively to the recipient inside an end-to-end Signal-encrypted message envelope, never to the media storage server (fulfilling Asset A6 of `docs/threat-model.md`).

### Media payload structure (inside Signal envelope)

When an image is shared, the sender uploads the encrypted blob to `POST /media` (receiving a canonical UUID `media_id`) and places the following payload inside the Signal message:

```typescript
interface MediaPayload {
  type: "IMAGE";
  media_id: string; // Canonical lowercase UUID of the ciphertext blob on server
  key: string;      // Base64 encoding of 32-byte AES-256-GCM symmetric key
  iv: string;       // Base64 encoding of 12-byte initialization vector (96-bit)
  sha256: string;   // Lowercase hex SHA-256 hash of the ciphertext (64 chars)
  mime: string;     // Declared MIME type: image/png, image/jpeg, image/gif, or image/webp
  size: number;     // Plaintext size in bytes (1 to 5242880)
}
```

### Integrity rule & verification policy

1. **Pre-decryption integrity verification**: Before attempting AES-GCM decryption, the client MUST recompute the SHA-256 digest over the downloaded ciphertext bytes and compare it with `payload.sha256` using constant-time comparison.
2. **Strict rejection on integrity failure**: If the recomputed SHA-256 digest does not match `payload.sha256`, the client throws `MediaIntegrityError` immediately without invoking `crypto.subtle.decrypt`. Decryption is never attempted on tampered or corrupted ciphertext.
3. **Decryption error handling**: Any failure during key/IV decoding or AES-GCM decryption (e.g. authentication tag mismatch, bad key, bad IV) throws `MediaDecryptError`. Partial data is never returned.
4. **Server isolation (Asset A6)**: The server receives only multipart form data containing `conversation_id` and the encrypted `file` (`blob.bin`). It is structurally impossible for encryption keys or IVs to reach the server.



## Prekey maintenance

Nullspace clients autonomously replenish one-time prekeys and rotate signed prekeys via periodic maintenance runs (`maintainPrekeys`).

### Replenishment Policy

- **Polling**: Clients query `GET /keys/count` to check server inventory (`one_time_prekeys` available and current `signed_prekey_id`). Network failures or non-2xx responses cause maintenance to return `{ status: "skipped" }` without state changes or throwing.
- **Low-Water Mark**: When available one-time prekeys drop below `LOW_WATER_MARK = 20`, the client replenishes `REPLENISH_BATCH = 100` new prekeys starting from `PrekeyState.nextPreKeyId`.
- **Pre-Upload Counter Persistence**: Counter advancement is committed to IndexedDB (`nullspace-prekeys-${userId}`) *before* initiating the network upload to ensure crashes never lead to key ID reuse.
- **Upload Contract**: One-time prekeys are uploaded via `PUT /keys/bundle` in chunks of at most `MAX_PER_UPLOAD = 200` keys alongside the newest confirmed signed prekey.
- **Conflict Handling**: If the server rejects an upload with HTTP 409 `prekey_id_conflict` (due to an existing key ID with a different public key), the client advances `nextPreKeyId` by 1000, updates state, and retries once. If the retry fails, `{ status: "failed" }` is returned cleanly.

### Signed Prekey Rotation Policy

- **Rotation Schedule**: Clients rotate signed prekeys every `SIGNED_PREKEY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000` (7 days). On first run, `lastRotatedAt` is recorded without rotating.
- **Upload & Confirmation**: Rotation publishes a new signed prekey with `id = (highest existing signed prekey id) + 1` and an empty `oneTimePreKeys` array to `PUT /keys/bundle`. Only upon receiving HTTP 200 does the client update `activeSignedPreKeyId` and `lastRotatedAt`.
- **Upload Failure Reuse**: If a rotation PUT fails, the newly generated signed prekey is retained in the local store and reused on the next maintenance run without burning additional key IDs.
- **Two-Key Retention Window**: After a successful rotation, the client purges from local storage all signed prekeys strictly older than the *previous* active signed prekey (`id < previousActiveSignedPreKeyId`). This retains exactly the current and previous signed prekeys so that delayed or out-of-order prekey messages decrypt successfully.

### Concurrency and Cross-Tab Coordination

- **Single Flight**: Concurrent maintenance calls within the same process are deduplicated via an in-process Promise map (`inFlightMap`).
- **Web Locks API**: Cross-tab concurrency is serialized using Web Locks API lock `nullspace-prekeys-${userId}`, falling back to in-process synchronization in non-supporting environments.


## Message payload

The end-to-end encrypted payload that travels inside the Signal Double Ratchet envelope (`ClientMessageFrame.body` / `ServerMessageFrame.body`). The application server only ever sees the ciphertext envelope and has no ability to inspect or tamper with the inner plaintext.

### Payload Schema

Message payloads are structured as strict JSON objects with a discriminating `type` field:

```typescript
export const MAX_TEXT_CHARS = 10_000;

export type TextPayload = {
  type: "TEXT";
  text: string;
};

export type MessagePayload = TextPayload | MediaPayload;
```

### Validation Rules

- **TEXT Payload**:
  - `type` must be `"TEXT"`.
  - Object must contain exactly two keys: `type` and `text` (no extraneous or unknown properties permitted).
  - `text` must be a string, non-empty after trimming, and at most `MAX_TEXT_CHARS = 10_000` characters.
- **IMAGE Payload**:
  - Validated strictly via `parseMediaPayload(p)`: canonical lowercase UUID `media_id`, 32-byte base64 AES-GCM key, 12-byte base64 IV, 64-character lowercase hex SHA-256 digest, allowed image MIME type (`image/png`, `image/jpeg`, `image/gif`, `image/webp`), and size between 1 and 5 MiB.
- **Strict Parsing**: Any invalid JSON, non-object, unknown payload `type`, extra property, or validation failure throws `MessagePayloadError`. Partial data is never accepted or returned.

### Cryptographic Ordering & Ratchet Concurrency

Signal Double Ratchet sessions require sequential execution per peer. Nullspace clients serialize outgoing encryption/send operations and incoming decryption operations using an in-memory per-peer promise mutex:
- Encrypt+send for one peer and decrypt for one sender are strictly serialized.
- Frames are transmitted over the wire in the exact sequence their ciphertexts were produced.
- A failure in one operation (e.g. `IdentityChangedError`) does not stall or block subsequent operations in the queue.

### Replay Protection & Decryption Error Containment

- **Replay Protection**: Because Signal Double Ratchet decryption is non-idempotent (decrypting the same ciphertext twice throws and can corrupt ratchet state), incoming `MESSAGE` frames check if version 1 already exists in the local `MessageStore` before calling `sessions.decrypt()`. Duplicate frames are discarded safely without decrypting.
- **Decryption Failure Containment**: If decryption or payload decoding fails on an incoming frame (e.g. corrupted ciphertext or invalid payload), the error is contained: the message record is committed locally with `decryptFailed: true` (with no plaintext version), a `decryptFailed` event is emitted, and later incoming frames continue to process without crash.

## Decrypt failures

When an incoming message envelope cannot be decrypted or decoded, Nullspace persists the raw ciphertext in the `failedEnvelopes` store, records the classified failure code, prevents application crashes, and allows subsequent retries.

### Classification of decryption error codes

The engine classifies errors into seven canonical `DecryptErrorCode` values using observed error texts from `@privacyresearch/libsignal-protocol-typescript` (v0.0.16) and WebCrypto/IndexedDB:

| `DecryptErrorCode` | Real observed error message / condition | Meaning |
|---|---|---|
| `no_session` | `Error: No record for device <peerId>.1`<br>`Error: Missing Signed PreKey for PreKeyWhisperMessage`<br>`Error: No session to encrypt message for <address>` | No active Signal session or matching prekey exists for the sender. |
| `bad_mac` | `Error: Bad MAC`<br>`RangeError: index out of range: ...`<br>`Error: invalid wire type <n> at offset <m>`<br>`Error: Incompatible version number on WhisperMessage <version>` | Ciphertext corruption, authentication tag mismatch, or corrupted protobuf wire bytes. |
| `replayed_or_old` | `Error [MessageCounterError]: Message key not found. The counter was repeated or the key was not filled.` | Counter was repeated, message was previously decrypted, or ratchet counter is expired. |
| `identity_changed` | `IdentityChangedError: Identity key changed for peer: <peerId>` | Peer's public identity key differs from the stored trust record. |
| `payload_invalid` | `MessagePayloadError: ...` | Ciphertext decrypted successfully, but inner JSON payload failed schema or media constraints. |
| `storage` | `DOMException: QuotaExceededError`<br>`Error: ... IndexedDB ...`<br>`Error: ... transaction ...` | Local storage quota exceeded or IndexedDB transaction aborted while persisting state. |
| `unknown` | Any other unrecognized exception | Unexpected runtime error. |

### Auto-retry policy

- **Auto-retried error codes**: Only envelopes with `lastErrorCode: "unknown"` or `lastErrorCode: "storage"` and `attempts < 3`.
  - *Rationale*: Transient errors such as disk contention, temporary storage quota exhaustion, or unclassified runtime anomalies may resolve on subsequent message processing.
- **Excluded from auto-retry**:
  - `bad_mac`: Ciphertext corruption or MAC failure is permanent; waiting cannot repair corrupted bits.
  - `replayed_or_old`: Repeated or expired ratchet counters cannot be decrypted by waiting.
  - `identity_changed`: Requires explicit user verification or acceptance of the new identity key.
  - `payload_invalid`: The decrypted payload violates structural schema rules and will fail every subsequent parse attempt.
- **Trigger**: Executed within the same per-peer mutex lock immediately after any successful decryption from sender $X$ (normal receive or manual retry).
- **Batch limit**: At most 20 envelopes per trigger, processed strictly in `receivedAt` ascending order.

### Ciphertext deletion policy

In accordance with Section 4 of `docs/threat-model.md`, when a message is marked deleted via `MessageStore.markDeleted(id)`:
1. All versions in the `versions` store have their `plaintext` wiped to `""`.
2. Any corresponding record in `failedEnvelopes` is permanently deleted (`deleteFailedEnvelope(id)`).
**Rule**: The raw ciphertext of a deleted message must not stay on the user's device.
