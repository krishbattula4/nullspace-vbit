/**
 * Client-side media encryption, decryption, upload, and payload helpers.
 *
 * Implements WebCrypto AES-GCM (256-bit key, 96-bit IV) with pre-decryption
 * constant-time SHA-256 integrity checks. Fulfills Asset A6 of threat model:
 * keys and IVs travel inside the Signal envelope; the media server only receives
 * the encrypted blob.
 */

export const MAX_MEDIA_BYTES = 5 * 1024 * 1024; // 5 MiB
export const ALLOWED_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type AllowedMediaType = (typeof ALLOWED_MEDIA_TYPES)[number];

export interface EncryptedMedia {
  ciphertext: Uint8Array;
  key: string; /* base64, 32 bytes */
  iv: string; /* base64, 12 bytes */
  sha256: string; /* lowercase hex of the CIPHERTEXT */
  mime: string;
  size: number; /* plaintext bytes */
}

export interface MediaPayload {
  type: "IMAGE";
  media_id: string;
  key: string;
  iv: string;
  sha256: string;
  mime: string;
  size: number;
}

export class MediaTooLargeError extends Error {
  constructor(message = "Media too large") {
    super(message);
    this.name = "MediaTooLargeError";
    Object.setPrototypeOf(this, MediaTooLargeError.prototype);
  }
}

export class MediaTypeError extends Error {
  constructor(message = "Invalid media type") {
    super(message);
    this.name = "MediaTypeError";
    Object.setPrototypeOf(this, MediaTypeError.prototype);
  }
}

export class MediaIntegrityError extends Error {
  constructor(message = "Media integrity verification failed") {
    super(message);
    this.name = "MediaIntegrityError";
    Object.setPrototypeOf(this, MediaIntegrityError.prototype);
  }
}

export class MediaDecryptError extends Error {
  constructor(message = "Media decryption failed") {
    super(message);
    this.name = "MediaDecryptError";
    Object.setPrototypeOf(this, MediaDecryptError.prototype);
  }
}

export class MediaUploadError extends Error {
  readonly status?: number;

  constructor(message = "Media upload failed", status?: number) {
    super(message);
    this.name = "MediaUploadError";
    this.status = status;
    Object.setPrototypeOf(this, MediaUploadError.prototype);
  }
}

const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function fromBase64(str: string): Uint8Array {
  if (typeof str !== "string" || str.length === 0 || !BASE64_REGEX.test(str)) {
    throw new Error("Invalid base64 string");
  }
  try {
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    throw new Error("Invalid base64 string");
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex.toLowerCase();
}

/**
 * Constant-time string comparison to prevent timing side channels.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verifies that the file magic bytes match the declared MIME type.
 * A renamed .exe or other format will fail this check.
 */
function checkMagicBytes(bytes: Uint8Array, mime: string): void {
  if (mime === "image/png") {
    if (
      bytes.byteLength < 4 ||
      bytes[0] !== 0x89 ||
      bytes[1] !== 0x50 ||
      bytes[2] !== 0x4e ||
      bytes[3] !== 0x47
    ) {
      throw new MediaTypeError(
        "Declared MIME is image/png but magic bytes do not match PNG (89 50 4E 47)",
      );
    }
  } else if (mime === "image/jpeg") {
    if (
      bytes.byteLength < 3 ||
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8 ||
      bytes[2] !== 0xff
    ) {
      throw new MediaTypeError(
        "Declared MIME is image/jpeg but magic bytes do not match JPEG (FF D8 FF)",
      );
    }
  } else if (mime === "image/gif") {
    if (
      bytes.byteLength < 4 ||
      bytes[0] !== 0x47 || // 'G'
      bytes[1] !== 0x49 || // 'I'
      bytes[2] !== 0x46 || // 'F'
      bytes[3] !== 0x38 // '8'
    ) {
      throw new MediaTypeError(
        "Declared MIME is image/gif but magic bytes do not match GIF (GIF8)",
      );
    }
  } else if (mime === "image/webp") {
    if (
      bytes.byteLength < 12 ||
      bytes[0] !== 0x52 || // 'R'
      bytes[1] !== 0x49 || // 'I'
      bytes[2] !== 0x46 || // 'F'
      bytes[3] !== 0x46 || // 'F'
      bytes[8] !== 0x57 || // 'W'
      bytes[9] !== 0x45 || // 'E'
      bytes[10] !== 0x42 || // 'B'
      bytes[11] !== 0x50 // 'P'
    ) {
      throw new MediaTypeError(
        "Declared MIME is image/webp but magic bytes do not match WebP (RIFF....WEBP)",
      );
    }
  } else {
    throw new MediaTypeError(`Disallowed media type: ${mime}`);
  }
}

/**
 * Encrypts media bytes client-side using WebCrypto AES-GCM (256-bit key, 96-bit IV).
 * Generates fresh random key and IV for every call.
 */
export async function encryptMedia(
  data: Uint8Array | ArrayBuffer,
  mime: string,
): Promise<EncryptedMedia> {
  if (!(ALLOWED_MEDIA_TYPES as readonly string[]).includes(mime)) {
    throw new MediaTypeError(`Disallowed media type: ${mime}`);
  }

  const bytes =
    data instanceof Uint8Array
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);

  if (bytes.byteLength === 0) {
    throw new MediaTooLargeError("Media data is empty");
  }
  if (bytes.byteLength > MAX_MEDIA_BYTES) {
    throw new MediaTooLargeError(
      `Media data size (${bytes.byteLength} bytes) exceeds MAX_MEDIA_BYTES (${MAX_MEDIA_BYTES})`,
    );
  }

  checkMagicBytes(bytes, mime);

  // Fresh random 256-bit AES-GCM key and fresh random 96-bit IV for every call
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const ivBytes = crypto.getRandomValues(new Uint8Array(12));

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );

  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: ivBytes },
    cryptoKey,
    bytes,
  );

  const ciphertext = new Uint8Array(encryptedBuffer);

  const digestBuffer = await crypto.subtle.digest("SHA-256", ciphertext);
  const sha256 = bytesToHex(new Uint8Array(digestBuffer));

  return {
    ciphertext,
    key: toBase64(keyBytes),
    iv: toBase64(ivBytes),
    sha256,
    mime,
    size: bytes.byteLength,
  };
}

/**
 * Decrypts media bytes client-side.
 * Recomputes SHA-256 over ciphertext first and compares in constant time.
 * If integrity check fails, throws MediaIntegrityError WITHOUT attempting decryption.
 */
export async function decryptMedia(input: {
  ciphertext: Uint8Array;
  key: string;
  iv: string;
  sha256: string;
}): Promise<Uint8Array> {
  // 1. FIRST recompute SHA-256 of the ciphertext and compare with input.sha256 using constant-time comparison
  const digestBuffer = await crypto.subtle.digest("SHA-256", input.ciphertext);
  const computedSha256 = bytesToHex(new Uint8Array(digestBuffer));

  if (!constantTimeEqual(computedSha256, input.sha256)) {
    throw new MediaIntegrityError(
      "Ciphertext integrity check failed: SHA-256 hash mismatch",
    );
  }

  // 2. Then decrypt; any failure throws MediaDecryptError. Never returns partial data.
  try {
    const keyBytes = fromBase64(input.key);
    if (keyBytes.byteLength !== 32) {
      throw new Error(`Invalid key length: expected 32 bytes, got ${keyBytes.byteLength}`);
    }

    const ivBytes = fromBase64(input.iv);
    if (ivBytes.byteLength !== 12) {
      throw new Error(`Invalid IV length: expected 12 bytes, got ${ivBytes.byteLength}`);
    }

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );

    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: ivBytes },
      cryptoKey,
      input.ciphertext,
    );

    return new Uint8Array(decryptedBuffer);
  } catch (err) {
    if (err instanceof MediaIntegrityError) {
      throw err;
    }
    throw new MediaDecryptError(
      `Decryption failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Uploads media ciphertext to the server via POST /media as multipart form data.
 * Receives ONLY ciphertext, conversationId, and authFetch; key and IV are structurally impossible to send.
 */
export async function uploadMedia(args: {
  ciphertext: Uint8Array;
  conversationId: string;
  authFetch: (path: string, init?: RequestInit) => Promise<Response>;
}): Promise<{ mediaId: string }> {
  const formData = new FormData();
  formData.append("conversation_id", args.conversationId);
  formData.append(
    "file",
    new Blob([args.ciphertext], { type: "application/octet-stream" }),
    "blob.bin",
  );

  let res: Response;
  try {
    res = await args.authFetch("/media", {
      method: "POST",
      body: formData,
    });
  } catch (err) {
    throw new MediaUploadError(
      `Network error uploading media: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- response body may be any shape
      const errorBody = (await res.json()) as any;
      if (errorBody && typeof errorBody.detail === "string") {
        detail = errorBody.detail;
      }
    } catch {
      // Ignore JSON parse error on non-2xx
    }
    throw new MediaUploadError(
      `Upload failed with status ${res.status}: ${detail}`,
      res.status,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- response body may be any shape
  let body: any;
  try {
    body = await res.json();
  } catch {
    throw new MediaUploadError("Server returned invalid JSON response", res.status);
  }

  if (!body || typeof body.media_id !== "string") {
    throw new MediaUploadError("Server response missing media_id", res.status);
  }

  return { mediaId: body.media_id };
}

/**
 * Builds the MediaPayload to be placed inside the Signal-encrypted message envelope.
 */
export function buildMediaPayload(
  enc: EncryptedMedia,
  mediaId: string,
): MediaPayload {
  if (typeof mediaId !== "string" || !UUID_REGEX.test(mediaId)) {
    throw new Error(
      `Invalid media_id: must be a canonical lowercase UUID, got "${mediaId}"`,
    );
  }
  return {
    type: "IMAGE",
    media_id: mediaId,
    key: enc.key,
    iv: enc.iv,
    sha256: enc.sha256,
    mime: enc.mime,
    size: enc.size,
  };
}

/**
 * Parses and strictly validates a media payload from an untrusted source.
 * Rejects wrong type, invalid key/iv lengths, uppercase/invalid hashes,
 * non-canonical UUIDs, disallowed mime types, extra fields, or non-objects.
 */
export function parseMediaPayload(value: unknown): MediaPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Media payload must be a non-null object");
  }

  const ALLOWED_KEYS = new Set([
    "type",
    "media_id",
    "key",
    "iv",
    "sha256",
    "mime",
    "size",
  ]);

  const actualKeys = Object.keys(value);
  if (actualKeys.length !== ALLOWED_KEYS.size) {
    throw new Error(
      `Media payload has incorrect field count: expected ${ALLOWED_KEYS.size}, got ${actualKeys.length}`,
    );
  }

  for (const k of actualKeys) {
    if (!ALLOWED_KEYS.has(k)) {
      throw new Error(`Media payload contains unknown extra field: ${k}`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- validating untrusted input fields
  const obj = value as Record<string, any>;

  if (obj.type !== "IMAGE") {
    throw new Error(`Media payload type must be "IMAGE", got "${String(obj.type)}"`);
  }

  if (typeof obj.media_id !== "string" || !UUID_REGEX.test(obj.media_id)) {
    throw new Error(
      `Media payload media_id must be a canonical lowercase UUID, got "${String(obj.media_id)}"`,
    );
  }

  if (typeof obj.key !== "string") {
    throw new Error("Media payload key must be a base64 string");
  }
  let keyBytes: Uint8Array;
  try {
    keyBytes = fromBase64(obj.key);
  } catch {
    throw new Error("Media payload key is invalid base64");
  }
  if (keyBytes.byteLength !== 32) {
    throw new Error(
      `Media payload key must decode to 32 bytes, got ${keyBytes.byteLength}`,
    );
  }

  if (typeof obj.iv !== "string") {
    throw new Error("Media payload iv must be a base64 string");
  }
  let ivBytes: Uint8Array;
  try {
    ivBytes = fromBase64(obj.iv);
  } catch {
    throw new Error("Media payload iv is invalid base64");
  }
  if (ivBytes.byteLength !== 12) {
    throw new Error(
      `Media payload iv must decode to 12 bytes, got ${ivBytes.byteLength}`,
    );
  }

  if (typeof obj.sha256 !== "string" || !SHA256_HEX_REGEX.test(obj.sha256)) {
    throw new Error(
      `Media payload sha256 must be 64 lowercase hex characters, got "${String(obj.sha256)}"`,
    );
  }

  if (
    typeof obj.mime !== "string" ||
    !(ALLOWED_MEDIA_TYPES as readonly string[]).includes(obj.mime)
  ) {
    throw new Error(`Media payload mime "${String(obj.mime)}" is not allowed`);
  }

  if (
    typeof obj.size !== "number" ||
    !Number.isInteger(obj.size) ||
    obj.size <= 0 ||
    obj.size > MAX_MEDIA_BYTES
  ) {
    throw new Error(
      `Media payload size must be an integer between 1 and ${MAX_MEDIA_BYTES}`,
    );
  }

  return {
    type: "IMAGE",
    media_id: obj.media_id,
    key: obj.key,
    iv: obj.iv,
    sha256: obj.sha256,
    mime: obj.mime,
    size: obj.size,
  };
}
