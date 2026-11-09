# Cryptographic Test Suite & Verification Matrix

This document catalogs every cryptographic test file in Nullspace (`frontend/src/crypto/`), detailing the scope, invariants, and cryptographic guarantees verified by each test suite.

## Test Environment & Execution

All cryptographic operations execute in standard TypeScript and browser WebCrypto APIs (`globalThis.crypto.subtle`) without native Node crypto polyfills (per ADR-001). Vitest executes tests with `fake-indexeddb` to simulate isolated browser IndexedDB storage per user.

### Running Tests

```bash
cd frontend
npm run lint         # ESLint check for style, undefined variables, and TypeScript rules
npm run typecheck    # Strict TypeScript compile check (tsc -b --noEmit)
npm test             # Vitest test suite execution across all test files
```

To run a single crypto test suite:

```bash
cd frontend
npx vitest run src/crypto/verificationFlows.test.ts
```

---

## Crypto Test Suite Matrix

| Test File | Task ID | Primary Modules Under Test | What It Proves |
|---|---|---|---|
| `frontend/src/crypto/IndexedDBSignalStore.test.ts` | P3.1 | `IndexedDBSignalStore.ts`, `keys.ts` | **IndexedDB Signal protocol storage & key helpers**: CRUD operations across all 5 object stores (`identity`, `trustedIdentities`, `preKeys`, `signedPreKeys`, `sessions`); binary `ArrayBuffer` storage without base64/JSON overhead; persistence across reloads (same `userId`, fresh store instance); strict database isolation between different `userId`s; identity change detection via `identityChanged()` without mutating stored keys; database wiping on logout; and key generation helpers (`ensureIdentity`, `generateSignedPreKey`, `generateOneTimePreKeys`, `buildPreKeyBundle`). |
| `frontend/src/crypto/provision.test.ts` | P3.2 | `provision.ts`, `bundle.ts` | **Key provisioning on initial login & prekey bundle validation**: First-login provisioning generating identity keys, signed prekey 1, and pool of 100 one-time prekeys; idempotent subsequent calls preserving keys; replenishment of depleted one-time prekeys back to 100; Curve25519/Ed25519 signature verification of signed prekey; strict exclusion of private keys from public bundles and JSON serialization; prekey bundle validation (`validatePreKeyBundle`); and compliance with `docs/schemas/prekey-bundle.schema.json` draft 2020-12 via Ajv. |
| `frontend/src/crypto/session.test.ts` | P3.5 | `session.ts`, `bundleProvider.ts` | **X3DH session establishment & Double Ratchet messaging**: Initiation of X3DH sessions yielding type 3 `PreKeyWhisperMessage` envelopes; recipient decryption and ratchet replies transitioning subsequent messages to type 1 `WhisperMessage`; consumption and deletion of one-time prekeys; fallback session setup when one-time prekeys are exhausted (signed prekey only); Double Ratchet session persistence across simulated page reloads; outgoing identity key change rejection (`IdentityChangedError`); Unicode and emoji message encryption/decryption; and `HttpBundleProvider` network fetching, authentication headers, and error handling (404, invalid body, network failure). |
| `frontend/src/crypto/spike.test.ts` | P0.8 / P4.5 | `spike.ts` | **End-to-end Signal protocol integration & spike demonstrations**: Basic Signal protocol handshake and decryption of `'hello'`; 2-way persistent ratchet exchange across persistent `IndexedDBSignalStore` instances; and key change simulation verifying that a peer re-provisioning allows decryption while updating verification status to "Key changed". |
| `frontend/src/crypto/safetyNumber.test.ts` | P4.1 | `safetyNumber.ts` | **60-digit safety number computation & verification**: Generation of 60-digit safety numbers using libsignal `FingerprintGenerator` configured with 5200 SHA-512 iterations (`FINGERPRINT_ITERATIONS = 5200`); formatting into 12 groups of 5 digits; deterministic reproducibility across multiple runs; detection of mismatched identity keys; graceful `null` handling when remote identity key is absent; whitespace-tolerant equality checking via `safetyNumbersMatch`; and symmetry invariance regardless of alphabetical user ID ordering (`alice`/`bob` vs `zed`/`amy`). |
| `frontend/src/crypto/verification.test.ts` | P4.3 | `verification.ts` | **Verification state machine & persistent trust store**: Local trust storage in per-user IndexedDB database (`nullspace-trust-${userId}`); Trust-on-first-use (`recordFirstUse`) establishing `UNVERIFIED` state; manual verification (`markVerified`) transitioning `UNVERIFIED -> VERIFIED` and setting `verifiedAt` timestamp; rejection of `markVerified` on unknown peers; `observeIdentity` preserving state on matching keys; `observeIdentity` transitioning `VERIFIED -> KEY_CHANGED` and `UNVERIFIED -> KEY_CHANGED` on key mismatches while preserving `previousIdentityKey` and setting `changedAt`; `markVerified` from `KEY_CHANGED` transitioning back to `VERIFIED` and clearing previous key metadata; store persistence and user isolation; integration with `SessionManager` via `attachVerification`; and UI status badges and colors via `stateLabel`. |
| `frontend/src/crypto/keyChange.test.ts` | P4.5 | `prekeyMessage.ts`, `session.ts`, `verification.ts` | **Key change detection, delivery policy, & accept flow**: Binary parsing of sender identity public key from raw type 3 protobuf messages via `extractIdentityKeyFromPreKeyMessage` and rejection of malformed envelopes; incoming key change policy (decrypt and deliver message, update VerificationStore to `KEY_CHANGED`, accept key in Signal store, emit single incoming `KeyChangeEvent`); outgoing key change policy (throw `IdentityChangedError`, update VerificationStore to `KEY_CHANGED`, retain old key in Signal store, emit single outgoing `KeyChangeEvent`); `acceptNewIdentity` resetting sessions and allowing resumed communication while keeping `KEY_CHANGED` until user re-verifies; zero false positive events during 20 back-and-forth messages; and idempotency when repeated prekey messages arrive with the same changed key. |
| `frontend/src/crypto/verificationFlows.test.ts` | P4.8 | `session.ts`, `verification.ts`, `safetyNumber.ts`, `IndexedDBSignalStore.ts` | **Complete end-to-end verification lifecycle scenarios**: Multi-party integration exercising the three core verification flows without mocks: (1) `UNVERIFIED -> VERIFIED` after two users exchange messages, compute identical 60-digit safety numbers, and mark verified; (2) `VERIFIED -> KEY_CHANGED` when a peer re-provisions and sends a prekey message, proving message delivery, exactly one `KeyChangeEvent`, and that `attachVerification`'s `onKeyChanged` callback delivers both the event and the updated `TrustRecord` (powering the in-app banner warning); (3) `KEY_CHANGED -> VERIFIED` after `acceptNewIdentity` clears old ratchets, re-establishes encrypted communication, proves new safety numbers match between peers (and differ from pre-change safety numbers), and `markVerified` restores trusted `VERIFIED` status. |

---

## Detailed Suite Summaries

### 1. `IndexedDBSignalStore.test.ts`
Tests the IndexedDB implementation of libsignal's `StorageType`.
- Verifies storage, loading, and deletion for identity keys, registration IDs, prekeys, signed prekeys, sessions, and trusted identity records.
- Simulates page refresh by opening new store instances on the same database name.
- Verifies database sandboxing: writes by user A never leak to user B.
- Verifies TOFU behavior in `isTrustedIdentity` and mismatch detection in `identityChanged`.
- Verifies database destruction via `wipe()`.
- Validates key generation helper functions (`keys.ts`).

### 2. `provision.test.ts`
Tests client key provisioning on initial registration or login.
- Verifies creation of identity key pair, signed prekey, and batch of 100 one-time prekeys.
- Verifies idempotency: calling provisioning repeatedly for an existing user reuses existing identity and signed prekey.
- Verifies one-time prekey replenishment: when store prekey count drops (e.g. after consumption), subsequent provisioning generates only enough prekeys to restore the pool to 100.
- Verifies cryptographic validity of the signed prekey signature against the identity public key.
- Asserts that private keys never enter public bundle objects or serialized JSON.
- Validates prekey bundles against JSON Schema draft 2020-12 using Ajv.

### 3. `session.test.ts`
Tests `SessionManager` and Double Ratchet session setup via X3DH.
- Verifies that initial message from Alice to Bob produces type 3 `PreKeyWhisperMessage` and decrypts successfully.
- Verifies that Bob's reply encrypts as type 1 `WhisperMessage` or type 3, and subsequent messages ratchet with type 1 envelopes.
- Verifies one-time prekey consumption: Bob's store removes the consumed prekey, reducing store count from 100 to 99.
- Verifies session establishment succeeds even when prekey bundles contain no one-time prekeys (signed prekey fallback).
- Verifies session persistence: creating a new `SessionManager` on the same user store decrypts subsequent messages without refetching prekey bundles.
- Verifies `IdentityChangedError` on outbound session creation when the recipient's bundle identity key differs from the trusted key.
- Verifies round-trip encryption of multi-byte UTF-8 strings and emojis (`'नमस्ते 🔐'`).
- Tests `HttpBundleProvider` network fetching, authentication headers, 404 handling, and malformed body detection.

### 4. `spike.test.ts`
Validates end-to-end flows against the spike demonstration code.
- Verifies basic in-memory libsignal spike flow (`runSpike`).
- Verifies persistent 2-way ratchet spike flow (`runPersistentSpike`).
- Verifies key change spike flow (`runKeyChangeSpike`), confirming Alice decrypts Bob's message after re-provisioning while Alice's verification status changes to "Key changed".

### 5. `safetyNumber.test.ts`
Tests safety number generation and comparison.
- Generates 60-digit fingerprints with 5200 iterations of SHA-512 via `FingerprintGenerator`.
- Validates formatting into 12 groups of 5 digits separated by spaces.
- Asserts deterministic generation (calling twice produces identical output).
- Validates mismatch detection when remote identity keys differ.
- Validates `safetyNumbersMatch` handling of whitespace and differing strings.
- Verifies symmetry invariant: safety numbers match regardless of which user ID is lexicographically first.
- Asserts `FINGERPRINT_ITERATIONS === 5200`.

### 6. `verification.test.ts`
Tests `VerificationStore`, state transitions, and session wiring.
- Tests `recordFirstUse` TOFU semantics.
- Tests `markVerified` transition from `UNVERIFIED` to `VERIFIED` and setting `verifiedAt`.
- Tests `observeIdentity` preserving state on identical keys.
- Tests `observeIdentity` transitioning `VERIFIED -> KEY_CHANGED` and `UNVERIFIED -> KEY_CHANGED` on mismatched keys, storing `previousIdentityKey` and `changedAt`.
- Tests `markVerified` from `KEY_CHANGED` transitioning back to `VERIFIED` and clearing previous key metadata.
- Tests store persistence and multi-user isolation in IndexedDB.
- Tests `attachVerification` integration with `SessionManager`.
- Tests `stateLabel` badge texts and colors ("Unverified" / amber, "Verified" / green, "Key changed" / red).

### 7. `keyChange.test.ts`
Tests key change handling policies and event emission.
- Tests `extractIdentityKeyFromPreKeyMessage` extracting sender identity key from raw type 3 envelopes.
- Tests incoming key change: Bob re-provisions and sends prekey message; Alice decrypts message; Alice's store records `KEY_CHANGED`; Alice's Signal store accepts key; exactly one incoming `KeyChangeEvent` is emitted.
- Tests outgoing key change: Alice attempts to encrypt to re-provisioned Bob; throws `IdentityChangedError`; Alice's store records `KEY_CHANGED`; Alice's Signal store retains old key; exactly one outgoing `KeyChangeEvent` is emitted.
- Tests `acceptNewIdentity`: Alice accepts new key; encryption succeeds; state stays `KEY_CHANGED`; re-verifying marks `VERIFIED` and safety numbers match.
- Tests absence of false positive events across 20 alternating messages.
- Tests idempotency when receiving repeated prekey messages with the same new key.

### 8. `verificationFlows.test.ts`
Comprehensive end-to-end verification lifecycle tests covering complete multi-step scenarios:
- **Scenario 1 (`UNVERIFIED -> VERIFIED`)**: Alice and Bob establish a session, verify initial `UNVERIFIED` state, compute matching 60-digit safety numbers, and mark each other `VERIFIED`.
- **Scenario 2 (`VERIFIED -> KEY_CHANGED`)**: Bob re-provisions with a fresh store and sends a prekey message to Alice. Verifies that Alice successfully decrypts and delivers the message, exactly one `KeyChangeEvent` is emitted, and `attachVerification`'s `onKeyChanged` callback receives both the `KeyChangeEvent` and the updated `TrustRecord` (powering the in-app banner warning).
- **Scenario 3 (`KEY_CHANGED -> VERIFIED`)**: Following outgoing key change detection (`IdentityChangedError`), Alice invokes `acceptNewIdentity` to resume communication (state remains `KEY_CHANGED`). Alice and Bob verify matching new safety numbers (which differ from pre-change numbers), and invoke `markVerified` to transition to `VERIFIED` with cleared history and active Double Ratchet.
