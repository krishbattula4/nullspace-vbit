import { IdentityChangedError } from "./session";
import { MessagePayloadError } from "./messagePayload";
import type { DecryptErrorCode } from "../store/messageStore";

/**
 * Observed real library error texts from @privacyresearch/libsignal-protocol-typescript (v0.0.16):
 *
 * 1. Missing session:
 *    - Type 1 WhisperMessage to a peer without an established session:
 *      Error: "No record for device <peerId>.1"
 *    - Type 3 PreKeyWhisperMessage with missing local prekey:
 *      Error: "Missing Signed PreKey for PreKeyWhisperMessage"
 *    - Session lookup failure:
 *      Error: "No session to encrypt message for <address>"
 *    Mapped to: "no_session"
 *
 * 2. Corrupted ciphertext / Bad MAC:
 *    - Flipped byte in MAC or encrypted payload:
 *      Error: "Bad MAC"
 *    - Protobuf parsing errors from corrupted wire bytes:
 *      RangeError: "index out of range: ..."
 *      Error: "invalid wire type <n> at offset <m>"
 *      Error: "Incompatible version number on WhisperMessage <version>"
 *    Mapped to: "bad_mac"
 *
 * 3. Replay / duplicate message:
 *    - Decrypting the same message counter twice or receiving an expired counter:
 *      Error [MessageCounterError]: "Message key not found. The counter was repeated or the key was not filled."
 *    Mapped to: "replayed_or_old"
 *
 * 4. Identity changed:
 *    - Thrown by SessionManager or libsignal when remote identity key differs:
 *      IdentityChangedError: "Identity key changed for peer: <peerId>"
 *    Mapped to: "identity_changed"
 *
 * 5. Payload validation:
 *    - Decrypted successfully but JSON schema or media payload constraints failed:
 *      MessagePayloadError: "..."
 *    Mapped to: "payload_invalid"
 *
 * 6. Storage / quota:
 *    - DOMException: QuotaExceededError
 *    - Error with message mentioning "IndexedDB" or "transaction"
 *    Mapped to: "storage"
 */
export function classifyDecryptError(err: unknown): DecryptErrorCode {
  if (
    err instanceof IdentityChangedError ||
    (err instanceof Error && err.name === "IdentityChangedError")
  ) {
    return "identity_changed";
  }

  if (
    err instanceof MessagePayloadError ||
    (err instanceof Error && err.name === "MessagePayloadError")
  ) {
    return "payload_invalid";
  }

  if (
    (typeof DOMException !== "undefined" &&
      err instanceof DOMException &&
      err.name === "QuotaExceededError") ||
    (typeof err === "object" &&
      err !== null &&
      (err as { name?: string }).name === "QuotaExceededError")
  ) {
    return "storage";
  }

  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("indexeddb") || msg.includes("transaction")) {
      return "storage";
    }

    if (
      err.name === "MessageCounterError" ||
      msg.includes("message key not found") ||
      msg.includes("counter was repeated")
    ) {
      return "replayed_or_old";
    }

    if (
      msg.includes("bad mac") ||
      msg.includes("invalid wire type") ||
      msg.includes("index out of range") ||
      msg.includes("incompatible version number")
    ) {
      return "bad_mac";
    }

    if (
      msg.includes("no record for device") ||
      msg.includes("no session") ||
      msg.includes("missing signed prekey")
    ) {
      return "no_session";
    }
  }

  return "unknown";
}
