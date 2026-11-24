# Nullspace Chat Export & Import Format (Version 1)

## Overview

Nullspace provides client-side passphrase-protected export and import for conversation histories. All cryptographic operations execute locally in the browser via WebCrypto. No server requests, unencrypted telemetry, or external network calls are made during either export or import.

Export files use the `.nullspace` extension and contain an authenticated, tamper-evident UTF-8 JSON container wrapping AES-256-GCM ciphertext.

---

## Container Format (Version 1)

An exported file is a UTF-8 JSON document adhering to the following structure:

```json
{
  "format": "nullspace-export",
  "version": 1,
  "kdf": {
    "name": "PBKDF2-SHA256",
    "iterations": 600000,
    "salt": "<base64, 16 random bytes>"
  },
  "cipher": {
    "name": "AES-256-GCM",
    "iv": "<base64, 12 random bytes>"
  },
  "data": "<base64 of AES-GCM ciphertext including the 16-byte authentication tag>"
}
```

### Container Field Definitions

| Field | Type | Description |
|---|---|---|
| `format` | `string` | Fixed string identifier `"nullspace-export"`. Any other value is rejected with `unsupported_format`. |
| `version` | `number` | Integer format version (`1`). Any other value is rejected with `unsupported_version`. |
| `kdf.name` | `string` | Key derivation function algorithm, strictly `"PBKDF2-SHA256"`. |
| `kdf.iterations` | `number` | PBKDF2 iteration count. Must be an integer between 600,000 and 5,000,000. |
| `kdf.salt` | `string` | Base64-encoded 16-byte cryptographically secure random salt (`crypto.getRandomValues`). Never reused. |
| `cipher.name` | `string` | Symmetric cipher algorithm, strictly `"AES-256-GCM"`. |
| `cipher.iv` | `string` | Base64-encoded 12-byte (96-bit) cryptographically secure random IV. Never reused. |
| `data` | `string` | Base64-encoded ciphertext produced by AES-256-GCM, including the appended 16-byte GCM authentication tag. |

No extraneous or unrecognized fields are permitted at any level of the container.

---

## Cryptographic Key Derivation & Encryption

### Key Derivation: PBKDF2-SHA256 (600,000 Iterations)

- **Passphrase Processing**: The user passphrase is normalized using Unicode Normalization Form KC (`NFKC`) and encoded as UTF-8 bytes before key derivation.
- **Passphrase Complexity Requirements**:
  - Minimum length of 12 Unicode code points.
  - Minimum of 5 distinct characters.
  - Rejects single repeated characters (e.g. `"aaaaaaaaaaaa"`) and low-entropy sequences.
- **KDF Parameters**:
  - Algorithm: PBKDF2 with HMAC-SHA256.
  - Salt: 16 cryptographically random bytes generated via `crypto.getRandomValues()`.
  - Iteration Count: `600,000` iterations (standard export default).
  - Derived Key: 256-bit AES-GCM key, flagged as **non-extractable** (`extractable: false`).

#### Why 600,000 Iterations?
In accordance with OWASP Password Storage and Key Derivation recommendations, 600,000 iterations of PBKDF2-HMAC-SHA256 provide substantial resistance against offline GPU and ASIC brute-force attacks while remaining practical to compute in modern JavaScript browser environments (typically requiring a few hundred milliseconds on modern hardware). 

### Authenticated Header & Downgrade Attack Protection

To prevent an adversary from tampering with cryptographic parameters in the plaintext container (e.g., lowering iteration counts or altering the format version), the exporter binds the container header parameters directly into AES-256-GCM's `additionalData`:

```
NULLSPACE-EXPORT\n<version>\n<kdf.name>\n<iterations>\n<salt base64>\n<iv base64>
```

Example header string:
```
NULLSPACE-EXPORT
1
PBKDF2-SHA256
600000
8fKg2w4+kX9mK...==
wK9+lX2m...==
```

Because `additionalData` is authenticated by the AES-GCM 128-bit authentication tag, any modification to the format version, KDF algorithm name, iteration count, salt, or IV causes AES-GCM decryption to fail immediately with an authentication error.

Furthermore, before any key derivation is attempted, the import parser verifies that `iterations >= 600,000` (rejecting weaker files with `kdf_too_weak`) and `iterations <= 5,000,000` (rejecting excessively large counts with `kdf_too_strong`). This prevents malicious files from causing client Denial of Service (browser freeze) or accepting insecure keys.

---

## Decrypted Payload Format

Once decrypted, the payload is parsed as strict UTF-8 JSON:

```json
{
  "schema": 1,
  "exportedAt": "2026-11-23T18:00:00.000Z",
  "exporter": {
    "userId": "usr_9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
  },
  "conversations": [
    {
      "id": "e2c366ff-6f81-42e5-bc09-02be3bcf9216",
      "peerId": "usr_f1a2b3c4-d5e6-7f8a-9b0c-1d2e3f4a5b6c",
      "peerName": "Alice",
      "messages": [
        {
          "id": "b3f07a4a-1011-4148-89c0-9a4f4bbd0505",
          "senderId": "usr_9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
          "createdAt": "2026-11-23T17:30:00.000Z",
          "status": "READ",
          "currentVersion": 2,
          "versions": [
            {
              "versionNo": 1,
              "plaintext": "{\"type\":\"TEXT\",\"text\":\"Meeting at 5?\"}",
              "action": "CREATE",
              "createdAt": "2026-11-23T17:30:00.000Z"
            },
            {
              "versionNo": 2,
              "plaintext": "{\"type\":\"TEXT\",\"text\":\"Meeting at 6?\"}",
              "action": "EDIT",
              "createdAt": "2026-11-23T17:31:00.000Z"
            }
          ]
        }
      ]
    }
  ]
}
```

### Payload Constraints
1. **Schema**: Must equal integer `1`.
2. **Identifiers**: All message and conversation `id` values must be canonical lowercase UUIDs.
3. **Timestamps**: All timestamps must be ISO 8601 strings.
4. **Statuses**: Must be one of `"SENT"`, `"QUEUED"`, `"DELIVERED"`, or `"READ"`.
5. **Versions**: Positive monotonic integers (`>= 1`), unique per message.
6. **Payload Format**: For non-deleted messages, each version's `plaintext` must be a valid serialized `MessagePayload` (validated via `decodeMessagePayload`).
7. **Caps**: A single export file may contain at most 200,000 total messages and must not exceed 50 MiB in total file size.

---

## What Is Exported vs. Excluded

### Included in Export
- Confirmed conversation messages (`SENT`, `QUEUED`, `DELIVERED`, `READ`).
- Complete edit history (`VersionRecord` entries) for each message.
- Message tombstones (deleted messages) with `deletedAt` and optional `deletedBy`.
- Retraction metadata (`retractedAt`, `retractedBy`).
- Media attachment payloads (encrypted image metadata and keys).

### Excluded from Export
1. **Signal Protocol Keys & Sessions**: The export module does NOT import or read `IndexedDBSignalStore`. Identity keys, prekeys, signed prekeys, session ratchets, and sender keys are never exported.
2. **Account Credentials & Tokens**: Authentication tokens, refresh tokens, passwords, and password hashes are never exported.
3. **Unconfirmed & Failed Messages**: Outgoing messages currently in `SENDING` status or marked as `FAILED` are excluded.
4. **Decryption Failures**: Messages where `decryptFailed === true` (including `"own_unavailable"` placeholders created during history sync) are excluded.
5. **Deleted Message Plaintexts**: For deleted messages, the plaintext is permanently erased from local storage and exported strictly as a tombstone (`"versions": []`).

---

## Import Semantics & Store Merging

Importing a `.nullspace` file into an account profile follows deterministic rules:

### Account Binding
`payload.exporter.userId` must match the current account's `userId`. Attempting to import another user's chat archive into a different account throws `ImportError("wrong_account")` and halts before writing to the database.

### Merging Rules
1. **Fresh Messages**: If a message does not exist in local IndexedDB:
   - Stored via `putMessage` with metadata and `importedAt = <current_iso_timestamp>`.
   - Versions added via `addVersion`.
   - Tombstone / retraction flags applied if present.
2. **Existing Messages**: If a message already exists locally:
   - Existing plaintext and fields are **never overwritten**.
   - `importedAt` is **never added** to an existing record.
   - Missing version records are added by version number (`addVersion` refuses to overwrite existing version records).
   - **Deletion Always Wins**: If the export marks a message as deleted and the local message is not, `markDeleted` is called to erase local plaintext and apply the tombstone. If the local message is already deleted, imported version texts are discarded.
   - **Retraction**: Retraction flags are applied if missing locally and the message is not deleted.
   - **Status Progression**: Status advances monotonically (`SENT < QUEUED < DELIVERED < READ`) via `setStatus`.
3. **Idempotence**: Importing the identical `.nullspace` file multiple times produces zero changes after the first run (`messagesAdded: 0`, `versionsAdded: 0`, `tombstonesApplied: 0`).

---

## Why Imported Messages Are Read-Only

All messages created during import receive the `importedAt` property in their `MessageRecord`. 

In `frontend/src/crypto/secureMessaging.ts`, `canEdit`, `canDelete`, and `canRetract` explicitly check `msg.importedAt` and return:
```typescript
{ allowed: false, reason: "imported" }
```

### Rationale
1. **Cryptographic State Disconnection**: Imported messages represent historical archive records. The local client does not possess the active Signal Double Ratchet session state or message keys corresponding to the imported message's original transmission. Attempting to send an `EDIT`, `DELETE`, or `RETRACT` protocol frame for an imported message would desynchronize ratchet counters with the peer.
2. **Archive Immutability**: Historical archives imported from backups serve as a permanent record of past discussions and must not be mutated or falsified after the fact.

---

## Threat Model & Security Considerations

Refer to `docs/threat-model.md` for Nullspace's baseline security assumptions and asset classifications.

### 1. Offline Brute-Force Attacks (Passphrase Strength)
> [!WARNING]
> **Security depends entirely on passphrase entropy.**
> An attacker who obtains an exported `.nullspace` file can mount an offline dictionary or brute-force attack against PBKDF2-SHA256 without interacting with the network.

While 600,000 iterations impose significant computation costs on adversaries, passphrases chosen by users with insufficient entropy (e.g., short dictionary words) can still be cracked. Nullspace mitigates this by enforcing minimum length and distinct character requirements during passphrase entry.

### 2. Plaintext Exposure Upon Decryption
Once decrypted, the payload contains plaintext message content. The browser application decrypts this data in ephemeral memory, merges it directly into IndexedDB, and frees intermediate variables. Users storing exported files on unencrypted local drives accept the risk outlined under **Threat T5 ("Stolen or shared device")** in `docs/threat-model.md`.

### 3. Forward Secrecy Boundary
Signal protocol provides forward secrecy by discarding ratchet message keys immediately upon receipt. A `.nullspace` export creates an encrypted snapshot of decrypted messages at a specific point in time. Compounding multiple historical sessions into a single archive means that compromise of the export passphrase exposes all messages within that file.
