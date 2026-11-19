# Threat model

Scope: Nullspace v1, a one-to-one web chat. Protocol: X3DH key agreement and the Double Ratchet, run in the browser with `@privacyresearch/libsignal-protocol-typescript` (see `docs/decisions/001-signal-library.md`). The server is FastAPI plus PostgreSQL and stores ciphertext only.

Status column: **Done** means merged to main, **Planned** means a task on the plan, not yet built. This table is the single place that must be updated when a feature ships.

## 1. Assets

| # | Asset | Where it lives |
|---|---|---|
| A1 | Message plaintext | Sender and recipient browsers only (IndexedDB local store, P3.7) |
| A2 | Private identity key, signed prekey, one-time prekeys, session state | IndexedDB in each browser; never sent anywhere |
| A3 | Ciphertext and edit history | PostgreSQL (`message_versions`) |
| A4 | Account credentials | bcrypt hash in PostgreSQL; refresh token hash in PostgreSQL; refresh token in browser localStorage |
| A5 | Metadata: who talks to whom, when, message sizes, online status | PostgreSQL rows and server memory |
| A6 | Attachment contents | Encrypted blob on server disk; key travels inside a Signal message (P6) |

## 2. Adversaries

| # | Adversary | Capability assumed |
|---|---|---|
| T1 | Curious or compromised server operator | Reads the database, memory and logs; can modify code; can drop, delay, reorder or replace public keys |
| T2 | Network attacker | Reads and alters traffic; defeated by TLS when it is deployed |
| T3 | Active man in the middle at first contact | Substitutes a user's identity key when sessions are first created |
| T4 | Database leak | Attacker obtains a copy of the database, not the browsers |
| T5 | Stolen or shared device | Attacker has the browser profile of a logged-in user |
| T6 | Malicious script in the page (XSS) | Runs JavaScript in the user's origin |
| T7 | Abusive user | Floods endpoints, guesses passwords, fills the prekey pool |

## 3. What holds and what does not

| Threat | Result | Why | Status |
|---|---|---|---|
| T1 reads message content | **Holds** | Server receives only Signal ciphertext. The envelope schema forbids unknown fields, so a plaintext field is invalid (P2.2). Once the message router uses it (P2.3), the server rejects such envelopes, proved by a test (P3.9). A plaintext audit over every BYTEA column checks the database (P8.4) | Partly done: envelope schema Done; router, rejection test and audit Planned |
| T1 sees metadata | **Does not hold** | Sender, recipient, timestamps, sizes, delivery and read times and presence are visible to the server by design. Sealed sender is out of scope | Accepted limitation |
| T1 withholds or drops messages | **Does not hold** | The server can delay or drop any message. Clients cannot prove a message was dropped | Accepted limitation |
| T1 or T3 substitutes a public key at first contact | **Detected, not prevented** | Trust on first use. A later key change always shows a KEY_CHANGED warning and never silently overwrites (P4.5). A user who compares the 60-digit safety number or scans the QR code (P4.1, P4.2) detects a substitution made at first contact | Crypto done; UI Planned (P4.6) |
| T2 reads or alters traffic | **Holds for content**, TLS needed for metadata and tokens | Content is end-to-end encrypted regardless of TLS. Access tokens and metadata rely on HTTPS and WSS in deployment | Deployment note |
| T4 database leak | **Holds for content** | Only ciphertext and bcrypt hashes are stored. Private keys are not in the database. Retracted messages keep their ciphertext by design (see section 4) | Done |
| T4 password cracking | **Partly holds** | bcrypt with cost set by configuration; passwords longer than 72 bytes are rejected, not truncated | Done |
| T5 stolen unlocked device | **Does not hold** | Keys in IndexedDB are not encrypted at rest and the refresh token is in localStorage. Anyone with the profile can read history and impersonate until the session is revoked. Logout clears tokens | Accepted limitation |
| T6 script injection | **Does not hold** | A script in the origin can read IndexedDB and localStorage. Mitigation is to keep the page free of injected HTML: React escapes by default, no `dangerouslySetInnerHTML`, strict security headers and a content security policy (P8.7) | Mitigated, Planned (P8.7) |
| T7 brute force and flooding | **Partly holds** | Refresh tokens rotate and reuse revokes the whole family. Login rate limiting, input limits and request size caps are planned. One-time prekeys can be drained by repeated fetches; clients replenish below 20 (P3.4) | Partly done, Planned (P8.7, P3.4) |
| Library risk | **Residual** | The browser library is a community port that Signal has not audited, with asm.js Curve25519. Revisit if Signal publishes an official browser build | Accepted, ADR 001 |

## 4. Edit, delete and retract are a rule, not a cryptographic guarantee

- **Delete before read** erases the ciphertext of every version on the server and leaves a tombstone. The recipient has not yet opened the message, so nothing readable remains with the server. This is the only case where deletion is enforced by the server.
- **Retract after read** keeps the ciphertext, and both users can open it. The message is marked withdrawn, not erased. This is deliberate: what has been read cannot be silently removed.
- Nothing stops a recipient from copying or photographing a message before it is deleted. The system makes silent removal after reading impossible, not secrecy after reading.
- Only the sender may edit, delete or retract, enforced on the server (P5.6). Every edit appends a new version; earlier versions are never overwritten.

## 5. Out of scope for v1

Multi-device sync (every user has device ID 1), group chat, sealed sender or metadata hiding, forward secrecy for exported files (an export is protected only by its passphrase), traffic analysis resistance, denial-of-service protection beyond basic rate limits, and a formal security audit.

## 6. Residual risks to state in the viva

1. Metadata is visible to the server.
2. First contact is trust on first use; protection depends on users comparing safety numbers.
3. A compromised browser or stolen device exposes everything on it.
4. The Signal library is a community port.
5. Retract-after-read keeps ciphertext on the server by design.
