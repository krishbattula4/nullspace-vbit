/**
 * Chat export and import (client only, no server).
 *
 * Implements PBKDF2 (HMAC-SHA256, 600,000 iterations) to AES-256-GCM encryption
 * for exporting conversations to passphrase-protected .nullspace container files,
 * and strict validation, decryption, and merging of imported archives.
 */

import {
  MessageStore,
  type MessageRecord,
  type MessageStatus,
} from "../store/messageStore";
import { decodeMessagePayload } from "./messagePayload";
import { toBase64, fromBase64 } from "./media";

export const EXPORT_KDF_ITERATIONS = 600_000;
export const MIN_KDF_ITERATIONS = 600_000;
export const MAX_KDF_ITERATIONS = 5_000_000;
export const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MiB
export const MAX_TOTAL_MESSAGES = 200_000;

export type ExportErrorCode = "weak_passphrase" | "nothing_to_export" | "failed";

export class ExportError extends Error {
  readonly code: ExportErrorCode;

  constructor(code: ExportErrorCode, message?: string) {
    super(message ?? code);
    this.name = "ExportError";
    this.code = code;
    Object.setPrototypeOf(this, ExportError.prototype);
  }
}

export type ImportErrorCode =
  | "unsupported_format"
  | "unsupported_version"
  | "kdf_too_weak"
  | "kdf_too_strong"
  | "file_too_large"
  | "wrong_passphrase_or_corrupted"
  | "invalid_payload"
  | "wrong_account"
  | "failed";

export class ImportError extends Error {
  readonly code: ImportErrorCode;

  constructor(code: ImportErrorCode, message?: string) {
    super(message ?? code);
    this.name = "ImportError";
    this.code = code;
    Object.setPrototypeOf(this, ImportError.prototype);
  }
}

export interface ExportContainer {
  format: "nullspace-export";
  version: 1;
  kdf: {
    name: "PBKDF2-SHA256";
    iterations: number;
    salt: string;
  };
  cipher: {
    name: "AES-256-GCM";
    iv: string;
  };
  data: string;
}

export interface ExportVersion {
  versionNo: number;
  plaintext: string;
  action: "CREATE" | "EDIT";
  createdAt: string;
}

export interface ExportMessage {
  id: string;
  senderId: string;
  createdAt: string;
  status: "SENT" | "QUEUED" | "DELIVERED" | "READ";
  currentVersion: number;
  deletedAt?: string;
  deletedBy?: string;
  retractedAt?: string;
  retractedBy?: string;
  versions: ExportVersion[];
}

export interface ExportConversation {
  id: string;
  peerId: string;
  peerName: string | null;
  messages: ExportMessage[];
}

export interface ExportPayload {
  schema: 1;
  exportedAt: string;
  exporter: {
    userId: string;
  };
  conversations: ExportConversation[];
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ALLOWED_STATUSES = new Set<string>([
  "SENT",
  "QUEUED",
  "DELIVERED",
  "READ",
]);

/**
 * Validates a user-provided passphrase.
 * After NFKC normalization, requires at least 12 Unicode code points
 * and at least 5 distinct characters.
 */
export function validatePassphrase(
  p: string,
): { ok: true } | { ok: false; reason: string } {
  if (typeof p !== "string") {
    return { ok: false, reason: "Passphrase must be a string" };
  }
  const normalized = p.normalize("NFKC");
  const codePoints = Array.from(normalized);
  if (codePoints.length < 12) {
    return {
      ok: false,
      reason: "Passphrase must be at least 12 characters",
    };
  }
  const distinct = new Set(codePoints);
  if (distinct.size < 5) {
    return {
      ok: false,
      reason: "Passphrase must contain at least 5 distinct characters",
    };
  }
  return { ok: true };
}

function isValidIsoDate(str: unknown): boolean {
  if (typeof str !== "string") return false;
  const time = Date.parse(str);
  if (isNaN(time)) return false;
  // Ensure valid ISO calendar timestamp format
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(
    str,
  );
}

function hasExactKeys(
  obj: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  const keys = Object.keys(obj);
  const allowed = new Set([...required, ...optional]);
  if (!required.every((k) => k in obj)) return false;
  return keys.every((k) => allowed.has(k));
}

function buildHeaderString(
  version: number,
  kdfName: string,
  iterations: number,
  saltBase64: string,
  ivBase64: string,
): string {
  return `NULLSPACE-EXPORT\n${version}\n${kdfName}\n${iterations}\n${saltBase64}\n${ivBase64}`;
}

/**
 * Exports one or more conversations to a passphrase-encrypted .nullspace container.
 * Strictly client-side: no network access, never imports Signal key stores.
 */
export async function exportChats(args: {
  messages: MessageStore;
  userId: string;
  conversations: { id: string; peerId: string; peerName?: string | null }[];
  passphrase: string;
  now?: () => Date;
  testOverrides?: { kdfIterations?: number };
}): Promise<{
  bytes: Uint8Array;
  filename: string;
  counts: {
    conversations: number;
    messages: number;
    versions: number;
    tombstones: number;
  };
}> {
  const validation = validatePassphrase(args.passphrase);
  if (!validation.ok) {
    throw new ExportError("weak_passphrase", validation.reason);
  }

  let totalExportableMessages = 0;
  let totalVersions = 0;
  let totalTombstones = 0;
  const exportedConversations: ExportConversation[] = [];

  for (const conv of args.conversations) {
    const rawMessages: MessageRecord[] = [];
    let beforeCursor: { createdAt: string; id: string } | undefined = undefined;

    // Page listMessages with before cursor (limit 200) until short page
    while (true) {
      const page = await args.messages.listMessages(conv.id, {
        limit: 200,
        before: beforeCursor,
      });
      if (page.length === 0) break;
      rawMessages.push(...page);
      if (page.length < 200) break;
      const last = page[page.length - 1];
      beforeCursor = { createdAt: last.createdAt, id: last.id };
    }

    // Sort messages chronologically ascending for deterministic export
    rawMessages.sort((a, b) => {
      const timeCmp = a.createdAt.localeCompare(b.createdAt);
      if (timeCmp !== 0) return timeCmp;
      return a.id.localeCompare(b.id);
    });

    const exportMessages: ExportMessage[] = [];

    for (const msg of rawMessages) {
      // Exclude unconfirmed SENDING or FAILED messages
      if (msg.status === "SENDING" || msg.status === "FAILED") {
        continue;
      }
      // Exclude messages with decryptFailed (including own_unavailable)
      if (msg.decryptFailed) {
        continue;
      }

      if (msg.deletedAt) {
        // Tombstone: exported with no versions (plaintext erased)
        totalTombstones++;
        totalExportableMessages++;
        const tombstoneMsg: ExportMessage = {
          id: msg.id,
          senderId: msg.senderId,
          createdAt: msg.createdAt,
          status: msg.status as "SENT" | "QUEUED" | "DELIVERED" | "READ",
          currentVersion: msg.currentVersion ?? 1,
          deletedAt: msg.deletedAt,
          ...(msg.deletedBy ? { deletedBy: msg.deletedBy } : {}),
          ...(msg.retractedAt ? { retractedAt: msg.retractedAt } : {}),
          ...(msg.retractedBy ? { retractedBy: msg.retractedBy } : {}),
          versions: [],
        };
        exportMessages.push(tombstoneMsg);
      } else {
        const rawVersions = await args.messages.getVersions(msg.id);
        rawVersions.sort((a, b) => a.versionNo - b.versionNo);

        const versions: ExportVersion[] = rawVersions.map((v) => ({
          versionNo: v.versionNo,
          plaintext: v.plaintext,
          action: v.action,
          createdAt: v.createdAt,
        }));

        totalVersions += versions.length;
        totalExportableMessages++;

        const exportMsg: ExportMessage = {
          id: msg.id,
          senderId: msg.senderId,
          createdAt: msg.createdAt,
          status: msg.status as "SENT" | "QUEUED" | "DELIVERED" | "READ",
          currentVersion: msg.currentVersion ?? 1,
          ...(msg.retractedAt ? { retractedAt: msg.retractedAt } : {}),
          ...(msg.retractedBy ? { retractedBy: msg.retractedBy } : {}),
          versions,
        };
        exportMessages.push(exportMsg);
      }
    }

    if (exportMessages.length > 0) {
      exportedConversations.push({
        id: conv.id,
        peerId: conv.peerId,
        peerName: conv.peerName ?? null,
        messages: exportMessages,
      });
    }
  }

  if (totalExportableMessages === 0) {
    throw new ExportError("nothing_to_export", "No exportable messages found");
  }

  const nowDate = args.now ? args.now() : new Date();
  const yyyyMmDd = nowDate.toISOString().slice(0, 10);
  let nameTag = "chat";
  if (args.conversations.length === 1 && args.conversations[0].peerName) {
    const cleaned = args.conversations[0].peerName.replace(
      /[^a-zA-Z0-9_-]/g,
      "",
    );
    if (cleaned.length > 0) {
      nameTag = cleaned;
    }
  }
  const filename = `nullspace-${nameTag}-${yyyyMmDd}.nullspace`;

  const payload: ExportPayload = {
    schema: 1,
    exportedAt: nowDate.toISOString(),
    exporter: {
      userId: args.userId,
    },
    conversations: exportedConversations,
  };

  const iterations =
    args.testOverrides?.kdfIterations ?? EXPORT_KDF_ITERATIONS;
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const ivBytes = crypto.getRandomValues(new Uint8Array(12));

  const enc = new TextEncoder();
  const passBytes = enc.encode(args.passphrase.normalize("NFKC"));

  const baseKey = await crypto.subtle.importKey(
    "raw",
    passBytes,
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );

  const saltB64 = toBase64(saltBytes);
  const ivB64 = toBase64(ivBytes);
  const headerStr = buildHeaderString(
    1,
    "PBKDF2-SHA256",
    iterations,
    saltB64,
    ivB64,
  );
  const additionalData = enc.encode(headerStr);
  const plaintextBytes = enc.encode(JSON.stringify(payload));

  const ciphertextBuffer = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: ivBytes,
      additionalData,
    },
    aesKey,
    plaintextBytes,
  );

  const container: ExportContainer = {
    format: "nullspace-export",
    version: 1,
    kdf: {
      name: "PBKDF2-SHA256",
      iterations,
      salt: saltB64,
    },
    cipher: {
      name: "AES-256-GCM",
      iv: ivB64,
    },
    data: toBase64(new Uint8Array(ciphertextBuffer)),
  };

  const bytes = enc.encode(JSON.stringify(container));

  return {
    bytes,
    filename,
    counts: {
      conversations: exportedConversations.length,
      messages: totalExportableMessages,
      versions: totalVersions,
      tombstones: totalTombstones,
    },
  };
}

/**
 * Imports conversations from a passphrase-protected .nullspace container file.
 * Validates container, derives key, decrypts, strictly parses payload,
 * checks account identity, and merges messages into the local store.
 */
export async function importChats(args: {
  file: Uint8Array;
  passphrase: string;
  messages: MessageStore;
  userId: string;
  now?: () => Date;
  maxFileBytes?: number;
  testOverrides?: { minKdfIterations?: number };
}): Promise<{
  conversations: number;
  messagesAdded: number;
  messagesMerged: number;
  versionsAdded: number;
  tombstonesApplied: number;
  skipped: number;
}> {
  // Step 1: File size check
  const maxBytes = args.maxFileBytes ?? MAX_FILE_BYTES;
  if (args.file.byteLength > maxBytes) {
    throw new ImportError("file_too_large", "File exceeds maximum allowed size");
  }

  // Step 2: Strict container validation before key derivation
  let containerRaw: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(args.file);
    containerRaw = JSON.parse(text);
  } catch {
    throw new ImportError(
      "wrong_passphrase_or_corrupted",
      "Container is not valid UTF-8 JSON",
    );
  }

  if (
    typeof containerRaw !== "object" ||
    containerRaw === null ||
    Array.isArray(containerRaw)
  ) {
    throw new ImportError(
      "wrong_passphrase_or_corrupted",
      "Container must be a JSON object",
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic container validation
  const container = containerRaw as Record<string, any>;

  if (container.format !== "nullspace-export") {
    throw new ImportError(
      "unsupported_format",
      `Unsupported container format: ${String(container.format)}`,
    );
  }

  if (container.version !== 1) {
    throw new ImportError(
      "unsupported_version",
      `Unsupported container version: ${String(container.version)}`,
    );
  }

  if (
    !hasExactKeys(container, ["format", "version", "kdf", "cipher", "data"])
  ) {
    throw new ImportError(
      "wrong_passphrase_or_corrupted",
      "Container has unexpected or missing fields",
    );
  }

  if (
    typeof container.kdf !== "object" ||
    container.kdf === null ||
    Array.isArray(container.kdf) ||
    !hasExactKeys(container.kdf, ["name", "iterations", "salt"])
  ) {
    throw new ImportError(
      "wrong_passphrase_or_corrupted",
      "Invalid KDF parameters",
    );
  }

  if (container.kdf.name !== "PBKDF2-SHA256") {
    throw new ImportError(
      "unsupported_format",
      `Unsupported KDF algorithm: ${String(container.kdf.name)}`,
    );
  }

  if (
    typeof container.kdf.iterations !== "number" ||
    !Number.isInteger(container.kdf.iterations)
  ) {
    throw new ImportError(
      "wrong_passphrase_or_corrupted",
      "KDF iterations must be an integer",
    );
  }

  const minIterations =
    args.testOverrides?.minKdfIterations ?? MIN_KDF_ITERATIONS;
  if (container.kdf.iterations < minIterations) {
    throw new ImportError(
      "kdf_too_weak",
      `KDF iterations ${container.kdf.iterations} below minimum ${minIterations}`,
    );
  }

  if (container.kdf.iterations > MAX_KDF_ITERATIONS) {
    throw new ImportError(
      "kdf_too_strong",
      `KDF iterations ${container.kdf.iterations} exceeds maximum ${MAX_KDF_ITERATIONS}`,
    );
  }

  let saltBytes: Uint8Array;
  try {
    saltBytes = fromBase64(container.kdf.salt);
  } catch {
    throw new ImportError(
      "wrong_passphrase_or_corrupted",
      "Invalid salt base64",
    );
  }
  if (saltBytes.byteLength !== 16) {
    throw new ImportError(
      "wrong_passphrase_or_corrupted",
      `Salt must be 16 bytes, got ${saltBytes.byteLength}`,
    );
  }

  if (
    typeof container.cipher !== "object" ||
    container.cipher === null ||
    Array.isArray(container.cipher) ||
    !hasExactKeys(container.cipher, ["name", "iv"])
  ) {
    throw new ImportError(
      "wrong_passphrase_or_corrupted",
      "Invalid cipher parameters",
    );
  }

  if (container.cipher.name !== "AES-256-GCM") {
    throw new ImportError(
      "unsupported_format",
      `Unsupported cipher algorithm: ${String(container.cipher.name)}`,
    );
  }

  let ivBytes: Uint8Array;
  try {
    ivBytes = fromBase64(container.cipher.iv);
  } catch {
    throw new ImportError("wrong_passphrase_or_corrupted", "Invalid IV base64");
  }
  if (ivBytes.byteLength !== 12) {
    throw new ImportError(
      "wrong_passphrase_or_corrupted",
      `IV must be 12 bytes, got ${ivBytes.byteLength}`,
    );
  }

  let ciphertextBytes: Uint8Array;
  try {
    ciphertextBytes = fromBase64(container.data);
  } catch {
    throw new ImportError(
      "wrong_passphrase_or_corrupted",
      "Invalid data base64",
    );
  }

  // Step 3: Derive key and decrypt with additionalData header
  let decryptedBytes: ArrayBuffer;
  try {
    const enc = new TextEncoder();
    const passBytes = enc.encode(args.passphrase.normalize("NFKC"));

    const baseKey = await crypto.subtle.importKey(
      "raw",
      passBytes,
      { name: "PBKDF2" },
      false,
      ["deriveKey"],
    );

    const aesKey = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: saltBytes,
        iterations: container.kdf.iterations,
        hash: "SHA-256",
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );

    const headerStr = buildHeaderString(
      container.version,
      container.kdf.name,
      container.kdf.iterations,
      container.kdf.salt,
      container.cipher.iv,
    );
    const additionalData = enc.encode(headerStr);

    decryptedBytes = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: ivBytes,
        additionalData,
      },
      aesKey,
      ciphertextBytes,
    );
  } catch {
    throw new ImportError(
      "wrong_passphrase_or_corrupted",
      "Decryption failed or header authentication mismatched",
    );
  }

  // Step 4: Parse payload strictly
  let payloadRaw: unknown;
  try {
    const decryptedText = new TextDecoder("utf-8", { fatal: true }).decode(
      decryptedBytes,
    );
    payloadRaw = JSON.parse(decryptedText);
  } catch {
    throw new ImportError("invalid_payload", "Payload is not valid JSON");
  }

  if (
    typeof payloadRaw !== "object" ||
    payloadRaw === null ||
    Array.isArray(payloadRaw)
  ) {
    throw new ImportError("invalid_payload", "Payload must be a JSON object");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic payload validation
  const payload = payloadRaw as Record<string, any>;

  if (
    !hasExactKeys(payload, [
      "schema",
      "exportedAt",
      "exporter",
      "conversations",
    ])
  ) {
    throw new ImportError("invalid_payload", "Payload has unexpected fields");
  }

  if (payload.schema !== 1) {
    throw new ImportError("invalid_payload", "Unsupported payload schema");
  }

  if (!isValidIsoDate(payload.exportedAt)) {
    throw new ImportError("invalid_payload", "Invalid exportedAt timestamp");
  }

  if (
    typeof payload.exporter !== "object" ||
    payload.exporter === null ||
    Array.isArray(payload.exporter) ||
    !hasExactKeys(payload.exporter, ["userId"]) ||
    typeof payload.exporter.userId !== "string" ||
    payload.exporter.userId.length === 0
  ) {
    throw new ImportError("invalid_payload", "Invalid exporter object");
  }

  if (!Array.isArray(payload.conversations)) {
    throw new ImportError(
      "invalid_payload",
      "conversations must be an array",
    );
  }

  let totalMessageCount = 0;

  for (const conv of payload.conversations) {
    if (
      typeof conv !== "object" ||
      conv === null ||
      Array.isArray(conv) ||
      !hasExactKeys(conv, ["id", "peerId", "peerName", "messages"])
    ) {
      throw new ImportError("invalid_payload", "Invalid conversation object");
    }

    if (typeof conv.id !== "string" || !UUID_REGEX.test(conv.id)) {
      throw new ImportError(
        "invalid_payload",
        "Conversation id must be a canonical lowercase UUID",
      );
    }

    if (typeof conv.peerId !== "string" || conv.peerId.length === 0) {
      throw new ImportError(
        "invalid_payload",
        "Conversation peerId must be a non-empty string",
      );
    }

    if (conv.peerName !== null && typeof conv.peerName !== "string") {
      throw new ImportError(
        "invalid_payload",
        "Conversation peerName must be string or null",
      );
    }

    if (!Array.isArray(conv.messages)) {
      throw new ImportError(
        "invalid_payload",
        "Conversation messages must be an array",
      );
    }

    for (const msg of conv.messages) {
      totalMessageCount++;
      if (totalMessageCount > MAX_TOTAL_MESSAGES) {
        throw new ImportError(
          "invalid_payload",
          `Total messages exceed maximum allowed of ${MAX_TOTAL_MESSAGES}`,
        );
      }

      if (
        typeof msg !== "object" ||
        msg === null ||
        Array.isArray(msg) ||
        !hasExactKeys(
          msg,
          ["id", "senderId", "createdAt", "status", "currentVersion", "versions"],
          ["deletedAt", "deletedBy", "retractedAt", "retractedBy"],
        )
      ) {
        throw new ImportError("invalid_payload", "Invalid message object");
      }

      if (typeof msg.id !== "string" || !UUID_REGEX.test(msg.id)) {
        throw new ImportError(
          "invalid_payload",
          "Message id must be a canonical lowercase UUID",
        );
      }

      if (typeof msg.senderId !== "string" || msg.senderId.length === 0) {
        throw new ImportError(
          "invalid_payload",
          "Message senderId must be a non-empty string",
        );
      }

      if (!isValidIsoDate(msg.createdAt)) {
        throw new ImportError(
          "invalid_payload",
          "Message createdAt must be a valid ISO timestamp",
        );
      }

      if (!ALLOWED_STATUSES.has(msg.status)) {
        throw new ImportError(
          "invalid_payload",
          `Message status '${String(msg.status)}' is not in allowed set`,
        );
      }

      if (
        typeof msg.currentVersion !== "number" ||
        !Number.isInteger(msg.currentVersion) ||
        msg.currentVersion < 1
      ) {
        throw new ImportError(
          "invalid_payload",
          "Message currentVersion must be a positive integer",
        );
      }

      if (msg.deletedAt !== undefined) {
        if (!isValidIsoDate(msg.deletedAt)) {
          throw new ImportError(
            "invalid_payload",
            "Message deletedAt must be a valid ISO timestamp",
          );
        }
        if (
          msg.deletedBy !== undefined &&
          (typeof msg.deletedBy !== "string" || msg.deletedBy.length === 0)
        ) {
          throw new ImportError(
            "invalid_payload",
            "Message deletedBy must be a non-empty string",
          );
        }
      }

      if (msg.retractedAt !== undefined) {
        if (!isValidIsoDate(msg.retractedAt)) {
          throw new ImportError(
            "invalid_payload",
            "Message retractedAt must be a valid ISO timestamp",
          );
        }
        if (
          msg.retractedBy !== undefined &&
          (typeof msg.retractedBy !== "string" || msg.retractedBy.length === 0)
        ) {
          throw new ImportError(
            "invalid_payload",
            "Message retractedBy must be a non-empty string",
          );
        }
      }

      if (!Array.isArray(msg.versions)) {
        throw new ImportError(
          "invalid_payload",
          "Message versions must be an array",
        );
      }

      if (msg.deletedAt !== undefined) {
        // Deleted messages must be exported as tombstones with NO versions
        if (msg.versions.length !== 0) {
          throw new ImportError(
            "invalid_payload",
            "Deleted message must have empty versions array",
          );
        }
      } else {
        const seenVersionNos = new Set<number>();
        for (const v of msg.versions) {
          if (
            typeof v !== "object" ||
            v === null ||
            Array.isArray(v) ||
            !hasExactKeys(v, ["versionNo", "plaintext", "action", "createdAt"])
          ) {
            throw new ImportError("invalid_payload", "Invalid version object");
          }

          if (
            typeof v.versionNo !== "number" ||
            !Number.isInteger(v.versionNo) ||
            v.versionNo < 1
          ) {
            throw new ImportError(
              "invalid_payload",
              "versionNo must be a positive integer",
            );
          }

          if (seenVersionNos.has(v.versionNo)) {
            throw new ImportError(
              "invalid_payload",
              `Duplicate versionNo ${v.versionNo} in message ${msg.id}`,
            );
          }
          seenVersionNos.add(v.versionNo);

          if (typeof v.plaintext !== "string") {
            throw new ImportError(
              "invalid_payload",
              "Version plaintext must be a string",
            );
          }

          if (v.action !== "CREATE" && v.action !== "EDIT") {
            throw new ImportError(
              "invalid_payload",
              `Invalid version action: ${String(v.action)}`,
            );
          }

          if (!isValidIsoDate(v.createdAt)) {
            throw new ImportError(
              "invalid_payload",
              "Version createdAt must be a valid ISO timestamp",
            );
          }

          // Validate non-deleted version plaintext format with decodeMessagePayload
          try {
            decodeMessagePayload(v.plaintext);
          } catch {
            throw new ImportError(
              "invalid_payload",
              `Version plaintext in message ${msg.id} is not a valid MessagePayload`,
            );
          }
        }
      }
    }
  }

  // Step 5: Verify exporter account matches
  if (payload.exporter.userId !== args.userId) {
    throw new ImportError(
      "wrong_account",
      `Export belongs to account '${payload.exporter.userId}', not '${args.userId}'`,
    );
  }

  // Step 6: Merge into local store
  const nowIso = (args.now ? args.now() : new Date()).toISOString();
  let messagesAdded = 0;
  let messagesMerged = 0;
  let versionsAdded = 0;
  let tombstonesApplied = 0;
  let skipped = 0;

  for (const conv of payload.conversations) {
    for (const exportedMsg of conv.messages) {
      const localMsg = await args.messages.getMessage(exportedMsg.id);

      if (!localMsg) {
        // Message not present locally: insert new record with importedAt
        const newMsg: MessageRecord = {
          id: exportedMsg.id,
          conversationId: conv.id,
          senderId: exportedMsg.senderId,
          createdAt: exportedMsg.createdAt,
          status: exportedMsg.status as MessageStatus,
          currentVersion: exportedMsg.currentVersion,
          importedAt: nowIso,
        };
        await args.messages.putMessage(newMsg);
        messagesAdded++;

        // Add versions
        const sortedVersions = [...exportedMsg.versions].sort(
          (a, b) => a.versionNo - b.versionNo,
        );
        for (const v of sortedVersions) {
          const added = await args.messages.addVersion({
            messageId: exportedMsg.id,
            versionNo: v.versionNo,
            plaintext: v.plaintext,
            action: v.action,
            createdAt: v.createdAt,
          });
          if (added) {
            versionsAdded++;
          }
        }

        // Apply tombstone or retraction flags
        if (exportedMsg.deletedAt) {
          await args.messages.markDeleted(exportedMsg.id, {
            at: exportedMsg.deletedAt,
            by: exportedMsg.deletedBy,
          });
          tombstonesApplied++;
        }
        if (exportedMsg.retractedAt) {
          await args.messages.markRetracted(exportedMsg.id, {
            at: exportedMsg.retractedAt,
            by: exportedMsg.retractedBy,
          });
        }
      } else {
        // Message is present locally: merge without overwriting local fields
        let messageGainedSomething = false;

        // If local message is NOT deleted, add missing versions
        if (!localMsg.deletedAt) {
          const sortedVersions = [...exportedMsg.versions].sort(
            (a, b) => a.versionNo - b.versionNo,
          );
          for (const v of sortedVersions) {
            const added = await args.messages.addVersion({
              messageId: exportedMsg.id,
              versionNo: v.versionNo,
              plaintext: v.plaintext,
              action: v.action,
              createdAt: v.createdAt,
            });
            if (added) {
              versionsAdded++;
              messageGainedSomething = true;
            }
          }
        }

        // Deletion always wins: if export is deleted and local is not
        if (exportedMsg.deletedAt && !localMsg.deletedAt) {
          await args.messages.markDeleted(exportedMsg.id, {
            at: exportedMsg.deletedAt,
            by: exportedMsg.deletedBy,
          });
          tombstonesApplied++;
          messageGainedSomething = true;
        }

        // Apply retraction flags only if missing locally and not deleted
        const isCurrentlyDeleted = Boolean(
          localMsg.deletedAt || exportedMsg.deletedAt,
        );
        if (
          !isCurrentlyDeleted &&
          exportedMsg.retractedAt &&
          !localMsg.retractedAt
        ) {
          await args.messages.markRetracted(exportedMsg.id, {
            at: exportedMsg.retractedAt,
            by: exportedMsg.retractedBy,
          });
          messageGainedSomething = true;
        }

        // Status only moves forward
        const prevStatus = localMsg.status;
        const updatedStatus = await args.messages.setStatus(
          exportedMsg.id,
          exportedMsg.status as MessageStatus,
        );
        if (updatedStatus && updatedStatus !== prevStatus) {
          messageGainedSomething = true;
        }

        if (messageGainedSomething) {
          messagesMerged++;
        } else {
          skipped++;
        }
      }
    }
  }

  return {
    conversations: payload.conversations.length,
    messagesAdded,
    messagesMerged,
    versionsAdded,
    tombstonesApplied,
    skipped,
  };
}

/**
 * Triggers a browser file download of the encrypted export bytes.
 * Creates an object URL, clicks a hidden anchor, removes the anchor,
 * and always revokes the object URL.
 */
export function triggerBrowserDownload(
  bytes: Uint8Array,
  filename: string,
  env?: { document: Document; URL: typeof URL },
): void {
  const doc = env?.document ?? globalThis.document;
  const urlApi = env?.URL ?? globalThis.URL;

  // Sanitise filename: keep only [a-zA-Z0-9_-], ensure .nullspace suffix
  const base = filename
    .replace(/\.nullspace$/i, "")
    .replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeName = `${base || "chat"}.nullspace`;

  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const objectUrl = urlApi.createObjectURL(blob);
  const anchor = doc.createElement("a");
  anchor.href = objectUrl;
  anchor.download = safeName;
  anchor.style.display = "none";
  doc.body.appendChild(anchor);

  try {
    anchor.click();
  } finally {
    if (anchor.parentNode) {
      anchor.parentNode.removeChild(anchor);
    }
    urlApi.revokeObjectURL(objectUrl);
  }
}
