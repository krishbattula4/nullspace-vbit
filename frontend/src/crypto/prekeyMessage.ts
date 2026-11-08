/**
 * PreKeyWhisperMessage decoding utilities.
 *
 * Libsignal's SessionCipher.decryptPreKeyWhisperMessage decodes the PreKeyWhisperMessage
 * protobuf after stripping the leading version byte. The protobuf definition is not
 * exported from @privacyresearch/libsignal-protocol-typescript package root;
 * libsignal itself depends on and imports it from @privacyresearch/libsignal-protocol-protobuf-ts.
 * We import PreKeyWhisperMessage directly from @privacyresearch/libsignal-protocol-protobuf-ts.
 */

import { PreKeyWhisperMessage } from "@privacyresearch/libsignal-protocol-protobuf-ts";

export class MalformedPreKeyMessageError extends Error {
  constructor(message = "Malformed PreKeyWhisperMessage") {
    super(message);
    this.name = "MalformedPreKeyMessageError";
  }
}

/**
 * Takes the binary-string body of a type 3 envelope, strips the leading version
 * byte exactly as the library does, decodes the PreKeyWhisperMessage protobuf
 * and returns its identityKey as a 33-byte ArrayBuffer.
 *
 * Throws a typed MalformedPreKeyMessageError on failure.
 */
export function extractIdentityKeyFromPreKeyMessage(bodyBinary: string): ArrayBuffer {
  if (typeof bodyBinary !== "string" || bodyBinary.length < 1) {
    throw new MalformedPreKeyMessageError("PreKeyWhisperMessage body is empty or not a string");
  }

  // Convert binary string to bytes and validate char codes (same as libsignal binaryStringToArrayBuffer)
  const bytes = new Uint8Array(bodyBinary.length);
  for (let i = 0; i < bodyBinary.length; i++) {
    const charCode = bodyBinary.charCodeAt(i);
    if (charCode > 0xff) {
      throw new MalformedPreKeyMessageError(
        `Illegal character code in PreKeyWhisperMessage body: ${charCode}`,
      );
    }
    bytes[i] = charCode;
  }

  // Strip leading version byte and validate exactly as SessionCipher.decryptPreKeyWhisperMessage does:
  // if ((version & 0xf) > 3 || version >> 4 < 3) { throw new Error('Incompatible version number...'); }
  const version = bytes[0];
  if ((version & 0x0f) > 3 || version >> 4 < 3) {
    throw new MalformedPreKeyMessageError(
      `Incompatible version number on PreKeyWhisperMessage: ${version}`,
    );
  }

  const messageData = bytes.subarray(1);
  if (messageData.length === 0) {
    throw new MalformedPreKeyMessageError("PreKeyWhisperMessage data is empty after version byte");
  }

  let decoded: PreKeyWhisperMessage;
  try {
    decoded = PreKeyWhisperMessage.decode(messageData);
  } catch (err) {
    throw new MalformedPreKeyMessageError(
      `Failed to decode PreKeyWhisperMessage protobuf: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!decoded.identityKey || decoded.identityKey.byteLength !== 33) {
    throw new MalformedPreKeyMessageError(
      `Expected 33-byte identityKey in PreKeyWhisperMessage, got ${decoded.identityKey?.byteLength ?? 0} bytes`,
    );
  }

  return decoded.identityKey.buffer.slice(
    decoded.identityKey.byteOffset,
    decoded.identityKey.byteOffset + decoded.identityKey.byteLength,
  );
}
