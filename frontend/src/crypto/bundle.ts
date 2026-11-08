export interface PublicPreKeyBundle {
  userId: string;
  registrationId: number;
  identityKey: string; // base64 of 33-byte public key
  signedPreKey: {
    keyId: number;
    publicKey: string;
    signature: string;
  }; // base64
  oneTimePreKeys: Array<{
    keyId: number;
    publicKey: string;
  }>; // base64, may be empty
  createdAt: string; // ISO 8601
}

const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function fromBase64(str: string): ArrayBuffer {
  if (typeof str !== "string" || str.length === 0 || !BASE64_REGEX.test(str)) {
    throw new Error("Invalid base64 string");
  }
  try {
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  } catch {
    throw new Error("Invalid base64 string");
  }
}

function isValidBase64WithByteLength(val: unknown, expectedByteLength: number): boolean {
  if (typeof val !== "string") return false;
  try {
    const buf = fromBase64(val);
    return buf.byteLength === expectedByteLength;
  } catch {
    return false;
  }
}

function isPositiveInteger(val: unknown): val is number {
  return typeof val === "number" && Number.isInteger(val) && val > 0;
}

export function validatePreKeyBundle(x: unknown): x is PublicPreKeyBundle {
  if (typeof x !== "object" || x === null || Array.isArray(x)) {
    return false;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrowing unknown object
  const candidate = x as Record<string, any>;

  if (typeof candidate.userId !== "string" || candidate.userId.trim() === "") {
    return false;
  }

  if (!isPositiveInteger(candidate.registrationId)) {
    return false;
  }

  if (typeof candidate.createdAt !== "string" || !ISO_8601_REGEX.test(candidate.createdAt)) {
    return false;
  }
  if (Number.isNaN(Date.parse(candidate.createdAt))) {
    return false;
  }

  // identityKey must be base64 of 33 bytes
  if (!isValidBase64WithByteLength(candidate.identityKey, 33)) {
    return false;
  }

  // signedPreKey
  if (
    typeof candidate.signedPreKey !== "object" ||
    candidate.signedPreKey === null ||
    Array.isArray(candidate.signedPreKey)
  ) {
    return false;
  }
  if (!isPositiveInteger(candidate.signedPreKey.keyId)) {
    return false;
  }
  if (!isValidBase64WithByteLength(candidate.signedPreKey.publicKey, 33)) {
    return false;
  }
  if (!isValidBase64WithByteLength(candidate.signedPreKey.signature, 64)) {
    return false;
  }

  // oneTimePreKeys: array of { keyId, publicKey }, may be empty, no duplicate keyIds
  if (!Array.isArray(candidate.oneTimePreKeys)) {
    return false;
  }

  const seenKeyIds = new Set<number>();
  for (const item of candidate.oneTimePreKeys) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return false;
    }
    if (!isPositiveInteger(item.keyId)) {
      return false;
    }
    if (seenKeyIds.has(item.keyId)) {
      return false; // Duplicate keyId rejected
    }
    seenKeyIds.add(item.keyId);

    if (!isValidBase64WithByteLength(item.publicKey, 33)) {
      return false;
    }
  }

  return true;
}
