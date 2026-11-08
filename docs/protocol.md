# Wire protocol (draft, completed in task P2.2)

All WebSocket frames are JSON objects with a `v` (protocol version, currently 1) and a `type`.
Message bodies are **always ciphertext**: base64 of the libsignal output, with `ctype` 3 (PreKeySignalMessage) or 2 (SignalMessage).
The server never receives, stores or forwards plaintext.

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


