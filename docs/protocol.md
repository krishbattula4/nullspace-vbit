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
