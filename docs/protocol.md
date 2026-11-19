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

### Parser Error Codes

When a received WebSocket data frame violates protocol rules, the server generates an `ERROR` frame with one of the following canonical error codes:

| Error Code | Meaning |
|---|---|
| `invalid_json` | The payload text is not valid JSON. |
| `not_an_object` | The JSON payload is not a JSON object (e.g. array, primitive, null). |
| `missing_version` | The `"v"` field is missing from a data frame. |
| `unsupported_version` | The `"v"` field is not an integer, is a boolean, or is not equal to `1`. |
| `unknown_type` | The `"type"` field is unrecognized, server-only frame sent by client, or control/client-only frame sent as data frame. |
| `invalid_frame` | One or more fields failed validation (e.g. non-canonical UUID, invalid ctype, invalid base64, decoded payload > 65536 bytes, non-canonical padding, extra unknown fields). |

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

