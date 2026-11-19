# Local Message Store

## Overview

In Nullspace, all messages transmitted over WebSocket frames or stored on the server are strictly ciphertext. Decrypted message plaintext lives **only on the user's local device** in browser IndexedDB.

The storage engine is implemented in `frontend/src/store/messageStore.ts` via the `idb` library. It maintains conversation history, edit versions, message status tracking, and synchronization metadata.

---

## Database Architecture

### Per-User Database Isolation

To prevent cross-account data leakage within the same browser instance, each user account maintains an isolated database named:
```
nullspace-messages-${userId}
```
Two accounts logged in consecutively or concurrently on the same browser never share an IndexedDB database or access each other's decrypted history.

### Object Stores & Schema (Database Version 2)

The database consists of four object stores:

#### 1. `messages`
Stores the metadata, status, version pointer, and flags for each chat message.

- **Primary Key (`keyPath`)**: `id` (`string`)
  - Outgoing pending messages: assigned a temporary `id` equal to `clientMsgId` (canonical lowercase UUID).
  - Confirmed or incoming messages: assigned the server-generated `messageId` (canonical lowercase UUID).
- **Indexes**:
  - `byConversationTime` on `["conversationId", "createdAt", "id"]`:
    - Compound index enabling efficient, gap-free, duplicate-free pagination in reverse chronological order (`newest first`).
    - Compound ordering ensures consistent sorting even when multiple messages share identical ISO timestamps.
  - `byClientMsgId` on `"clientMsgId"` (`{ unique: true }`):
    - Enforces uniqueness for client-generated message tracking IDs.
    - Records without `clientMsgId` (e.g. incoming messages) are excluded from the index and do not violate uniqueness.

**Record Structure (`MessageRecord`)**:
```typescript
interface MessageRecord {
  id: string;                                           // Message UUID or temporary clientMsgId
  conversationId: string;                               // Target conversation UUID
  senderId: string;                                     // User ID of the author
  clientMsgId?: string;                                 // Client correlation UUID (for outgoing messages)
  createdAt: string;                                    // ISO 8601 UTC timestamp
  status: "SENDING" | "SENT" | "QUEUED" | "DELIVERED" | "READ" | "FAILED";
  currentVersion: number;                               // Highest version number stored (>= 1)
  deletedAt?: string;                                   // ISO timestamp when deleted (if deleted)
  deletedBy?: string;                                   // User ID who deleted the message
  retractedAt?: string;                                 // ISO timestamp when retracted (if retracted)
  retractedBy?: string;                                 // User ID who retracted the message
  decryptFailed?: boolean;                              // True if client failed to decrypt ciphertext
  decryptErrorCode?: DecryptErrorCode;                  // Classification code if decryptFailed is true
}
```

#### 2. `versions`
Maintains the plaintext edit history for each message. Every edit appends a new version row; existing versions are immutable and never overwritten.

- **Primary Key (`keyPath`)**: `["messageId", "versionNo"]` (`[string, number]`)
- **Indexes**:
  - `byMessage` on `"messageId"`: Allows retrieval of all versions for a given message.

**Record Structure (`VersionRecord`)**:
```typescript
interface VersionRecord {
  messageId: string;                                    // Associated message UUID
  versionNo: number;                                    // Version index (1 for initial creation, 2+ for edits)
  plaintext: string;                                    // Decrypted message text
  action: "CREATE" | "EDIT";                            // Creation or revision indicator
  createdAt: string;                                    // ISO 8601 UTC timestamp
}
```

#### 3. `meta`
Tracks the pagination and synchronization boundaries for each conversation, allowing UI views to know which ranges of history are already cached locally.

- **Primary Key (`keyPath`)**: `conversationId` (`string`)

**Record Structure (`ConversationMetaRecord`)**:
```typescript
interface ConversationMetaRecord {
  conversationId: string;                               // Conversation UUID
  oldest: { createdAt: string; id: string } | null;     // Boundary of the oldest locally stored message
  historyComplete: boolean;                             // True if all history up to conversation inception is cached
}
```

#### 4. `failedEnvelopes`
Stores raw ciphertexts of incoming messages that failed decryption or payload parsing, supporting manual and automatic retry attempts.

- **Primary Key (`keyPath`)**: `messageId` (`string`)
- **Indexes**:
  - `bySenderId` on `"senderId"`
  - `byConversationId` on `"conversationId"`
  - `byReceivedAt` on `"receivedAt"`

**Record Structure (`FailedEnvelopeRecord`)**:
```typescript
interface FailedEnvelopeRecord {
  messageId: string;                                    // Message UUID
  conversationId: string;                               // Target conversation UUID
  senderId: string;                                     // Sender user UUID
  ctype: 1 | 3;                                         // 1: WhisperMessage, 3: PreKeyWhisperMessage
  body: string;                                         // Raw base64 ciphertext
  receivedAt: string;                                   // ISO 8601 UTC timestamp
  attempts: number;                                     // Number of decryption attempts (>= 1)
  lastErrorCode: DecryptErrorCode;                      // Classification code of the last failure
}
```

---

## Status State Machine

Message status progresses forward monotonically:
```
SENDING < SENT < QUEUED < DELIVERED < READ
```

### Transition Rules

1. **Monotonic Forward Only**: A status cannot regress. For example, if a message has reached `READ`, a delayed or duplicate network acknowledgement indicating `SENT` or `DELIVERED` will not downgrade the status.
2. **`FAILED` Restricted to `SENDING`**: A message can transition to `FAILED` only if its current status is `SENDING`. Once a message is acknowledged as `SENT` or beyond, it cannot fail.
3. **Rekeying on Server Confirmation (`confirmSent`)**:
   - Outgoing messages initially reside in the store under their temporary `clientMsgId`.
   - When the server returns an `ACK` frame with the definitive `messageId`, `confirmSent(clientMsgId, { messageId, status, createdAt })` atomically rekeys the message record and shifts its associated `versions` rows to the new `messageId` in a single transaction.
   - If the server-relayed message arrives over WebSocket before the `ACK` (causing a record with `messageId` to already exist), `confirmSent` merges the records, preserving the highest status and all versions.

---

## Delete vs. Retract Specification

In accordance with Section 4 of `docs/threat-model.md` and the Nullspace protocol:

### Delete (Before Read)

- **Trigger**: The sender deletes a message before the recipient has read it (`status < READ`).
- **Store Behavior (`markDeleted`)**:
  - Sets `deletedAt` and `deletedBy` on the `MessageRecord`.
  - **Erases plaintext permanently**: Iterates over all `VersionRecord` rows for the message and overwrites `plaintext` with `""` (empty string).
  - **Purges ciphertext envelope**: Deletes any corresponding envelope in `failedEnvelopes` so no raw ciphertext remains on the device.
  - The message row and version rows are preserved as tombstones so that thread continuity and version indexing remain valid, but the confidential plaintext and ciphertext are erased from the client device.
  - Operation is idempotent.

### Retract (After Read)

- **Trigger**: The sender retracts a message after the recipient has already opened and read it (`status === "READ"`).
- **Store Behavior (`markRetracted`)**:
  - Sets `retractedAt` and `retractedBy` on the `MessageRecord`.
  - **Plaintext is preserved**: All `VersionRecord` rows retain their original `plaintext`.
  - *Rationale*: A message that has already been read cannot be secretly removed from human memory or logs. The UI displays the message as retracted / collapsed, but users may expand and view what was said.
  - Operation is idempotent.

---

## Security Notice: Plaintext Storage at Rest

> [!WARNING]
> **Plaintext is stored UNENCRYPTED in browser IndexedDB.**

As formally accepted in `docs/threat-model.md` under **Asset A1** and **Threat T5 ("Stolen or shared device")**:
- Decrypted message text is stored unencrypted in the browser profile's IndexedDB storage.
- An attacker who obtains physical access to an unlocked device or exports the browser profile directory can read the complete local chat history directly from IndexedDB without needing cryptographic keys.
- **Wipe Mechanism**:
  - The `MessageStore.wipe()` method closes all active database connections and permanently deletes the IndexedDB database (`deleteDB`).
  - Users logging out or selecting "Clear local data" invoke `wipe()` to purge the local store from disk.
- **External Safeguards**:
  - Device security relies on operating system full-disk encryption (e.g., BitLocker, FileVault, LUKS), screen lock passwords, and OS-level user account isolation.
