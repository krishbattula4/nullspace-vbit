# Wire protocol (draft, completed in task P2.2)

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


| type | direction | fields | notes |
|---|---|---|---|
| MESSAGE | client -> server -> recipient | conversation_id, client_msg_id, ctype, body | server assigns message_id and version 1 |
| ACK | server -> sender | client_msg_id, message_id, status | status SENT or QUEUED |
| DELIVERED | recipient -> server -> sender | message_id | sets delivered_at |
| READ | recipient -> server -> sender | message_id | sets read_at (P5.1) |
| EDIT | client -> server -> recipient | message_id, ctype, body | new version, action EDIT |
| DELETE | client -> server -> both | message_id | allowed only before read; ciphertext erased |
| RETRACT | client -> server -> both | message_id | after read; ciphertext kept, bubble collapsed |
| TYPING | client -> server -> recipient | conversation_id | throttled, never stored |
| PRESENCE | server -> contacts | user_id, online | first connect / last disconnect only |
| KEY_CHANGED | client-side event | user_id | raised when a contact's identity key differs from the trusted one |

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

