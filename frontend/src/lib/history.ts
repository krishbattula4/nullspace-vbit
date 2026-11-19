export type ServerHistoryVersion = {
  id: string;
  messageId: string;
  versionNo: number;
  ctype: 1 | 3;
  ciphertext: string;
  action: "CREATE" | "EDIT" | "DELETE" | "RETRACT";
  actorId: string;
  createdAt: string; // normalised ISO UTC ending in Z
  erasedAt: string | null;
};

export type ServerHistoryMessage = {
  id: string;
  conversationId: string;
  senderId: string;
  clientMsgId: string | null;
  status: "SENT" | "QUEUED" | "DELIVERED";
  currentVersion: number;
  createdAt: string; // normalised ISO UTC ending in Z
  deliveredAt: string | null;
  readAt: string | null;
  versions: ServerHistoryVersion[];
};

export class HistoryParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryParseError";
    Object.setPrototypeOf(this, HistoryParseError.prototype);
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const TIMESTAMP_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([zZ])|([+-]\d{2}(?::?\d{2})?))?$/;

/**
 * Normalises a timestamp string to a canonical ISO 8601 UTC string ending in 'Z'.
 * Treats missing timezone suffix (e.g. SQLite) as UTC.
 * Converts offsets like +00:00 to Z.
 * Throws HistoryParseError on malformed, unparseable, or impossible calendar dates.
 */
export function normalizeTimestamp(s: string): string {
  if (typeof s !== "string" || !s.trim()) {
    throw new HistoryParseError("Timestamp must be a non-empty string");
  }
  const str = s.trim();
  const match = TIMESTAMP_REGEX.exec(str);
  if (!match) {
    throw new HistoryParseError(`Malformed timestamp: "${s}"`);
  }

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);
  const second = parseInt(match[6], 10);

  if (month < 1 || month > 12) {
    throw new HistoryParseError(`Impossible month in timestamp: ${month}`);
  }
  if (day < 1 || day > 31) {
    throw new HistoryParseError(`Impossible day in timestamp: ${day}`);
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    throw new HistoryParseError(`Impossible time in timestamp: "${s}"`);
  }

  // Check calendar date validity (e.g. Feb 31, Apr 31, leap year)
  const utcCheck = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    utcCheck.getUTCFullYear() !== year ||
    utcCheck.getUTCMonth() !== month - 1 ||
    utcCheck.getUTCDate() !== day
  ) {
    throw new HistoryParseError(`Impossible calendar date in timestamp: "${s}"`);
  }

  // If no timezone suffix, treat as UTC
  let parseTarget = str;
  if (!match[8] && !match[9]) {
    parseTarget += "Z";
  }

  const d = new Date(parseTarget);
  if (isNaN(d.getTime())) {
    throw new HistoryParseError(`Invalid timestamp: "${s}"`);
  }

  // Keep MICROSECOND precision (always exactly 6 fraction digits). The reconcile step sorts
  // versions by this string to decrypt in the order the sender encrypted them, so two versions
  // created within the same millisecond must not tie. toISOString() alone would truncate to ms.
  // A fixed width also makes plain string comparison equal to time comparison.
  const base = d.toISOString().slice(0, 19);
  const fraction = (match[7] ?? "").padEnd(6, "0").slice(0, 6);
  return `${base}.${fraction}Z`;
}

function isValidBase64OrEmpty(s: unknown): s is string {
  if (typeof s !== "string") return false;
  if (s === "") return true;
  return s.length % 4 === 0 && BASE64_REGEX.test(s);
}

/**
 * Strictly parses a history page payload from GET /conversations/{id}/messages.
 * Validates types, UUIDs, ranges, and nested versions.
 * Ignores unknown extra properties for forward compatibility.
 * Throws HistoryParseError on any failure and never returns a partial list.
 */
export function parseHistoryPage(json: unknown): ServerHistoryMessage[] {
  if (!Array.isArray(json)) {
    throw new HistoryParseError("History page must be a JSON array");
  }

  const result: ServerHistoryMessage[] = [];

  for (let i = 0; i < json.length; i++) {
    const item = json[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new HistoryParseError(`Message item at index ${i} is not a valid object`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic property validation
    const m = item as Record<string, any>;

    if (typeof m.id !== "string" || !UUID_REGEX.test(m.id)) {
      throw new HistoryParseError(`Message at index ${i} has invalid or non-canonical id: "${String(m.id)}"`);
    }
    if (typeof m.conversation_id !== "string" || !UUID_REGEX.test(m.conversation_id)) {
      throw new HistoryParseError(
        `Message at index ${i} has invalid conversation_id: "${String(m.conversation_id)}"`,
      );
    }
    if (typeof m.sender_id !== "string" || !UUID_REGEX.test(m.sender_id)) {
      throw new HistoryParseError(`Message at index ${i} has invalid sender_id: "${String(m.sender_id)}"`);
    }

    let clientMsgId: string | null = null;
    if (m.client_msg_id !== null && m.client_msg_id !== undefined) {
      if (typeof m.client_msg_id !== "string" || !UUID_REGEX.test(m.client_msg_id)) {
        throw new HistoryParseError(
          `Message at index ${i} has invalid client_msg_id: "${String(m.client_msg_id)}"`,
        );
      }
      clientMsgId = m.client_msg_id;
    }

    if (m.status !== "SENT" && m.status !== "QUEUED" && m.status !== "DELIVERED") {
      throw new HistoryParseError(`Message at index ${i} has invalid status: "${String(m.status)}"`);
    }

    if (
      typeof m.current_version !== "number" ||
      !Number.isInteger(m.current_version) ||
      m.current_version < 1
    ) {
      throw new HistoryParseError(
        `Message at index ${i} has invalid current_version: "${String(m.current_version)}"`,
      );
    }

    const createdAt = normalizeTimestamp(m.created_at);
    const deliveredAt =
      m.delivered_at === null || m.delivered_at === undefined
        ? null
        : normalizeTimestamp(m.delivered_at);
    const readAt =
      m.read_at === null || m.read_at === undefined
        ? null
        : normalizeTimestamp(m.read_at);

    if (!Array.isArray(m.versions)) {
      throw new HistoryParseError(`Message at index ${i} versions must be an array`);
    }

    const parsedVersions: ServerHistoryVersion[] = [];

    for (let j = 0; j < m.versions.length; j++) {
      const vItem = m.versions[j];
      if (typeof vItem !== "object" || vItem === null || Array.isArray(vItem)) {
        throw new HistoryParseError(`Version at index ${j} of message ${m.id} is not an object`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic property validation
      const v = vItem as Record<string, any>;

      if (typeof v.id !== "string" || !UUID_REGEX.test(v.id)) {
        throw new HistoryParseError(`Version at index ${j} has invalid id: "${String(v.id)}"`);
      }
      if (typeof v.message_id !== "string" || !UUID_REGEX.test(v.message_id) || v.message_id !== m.id) {
        throw new HistoryParseError(
          `Version at index ${j} has invalid or mismatched message_id: "${String(v.message_id)}"`,
        );
      }
      if (
        typeof v.version_no !== "number" ||
        !Number.isInteger(v.version_no) ||
        v.version_no < 1
      ) {
        throw new HistoryParseError(
          `Version at index ${j} has invalid version_no: "${String(v.version_no)}"`,
        );
      }
      if (v.ctype !== 1 && v.ctype !== 3) {
        throw new HistoryParseError(`Version at index ${j} has invalid ctype: "${String(v.ctype)}"`);
      }
      if (!isValidBase64OrEmpty(v.ciphertext)) {
        throw new HistoryParseError(`Version at index ${j} has invalid ciphertext`);
      }
      if (
        v.action !== "CREATE" &&
        v.action !== "EDIT" &&
        v.action !== "DELETE" &&
        v.action !== "RETRACT"
      ) {
        throw new HistoryParseError(`Version at index ${j} has invalid action: "${String(v.action)}"`);
      }
      if (typeof v.actor_id !== "string" || !UUID_REGEX.test(v.actor_id)) {
        throw new HistoryParseError(`Version at index ${j} has invalid actor_id: "${String(v.actor_id)}"`);
      }

      const vCreatedAt = normalizeTimestamp(v.created_at);
      const vErasedAt =
        v.erased_at === null || v.erased_at === undefined
          ? null
          : normalizeTimestamp(v.erased_at);

      parsedVersions.push({
        id: v.id,
        messageId: v.message_id,
        versionNo: v.version_no,
        ctype: v.ctype,
        ciphertext: v.ciphertext,
        action: v.action,
        actorId: v.actor_id,
        createdAt: vCreatedAt,
        erasedAt: vErasedAt,
      });
    }

    result.push({
      id: m.id,
      conversationId: m.conversation_id,
      senderId: m.sender_id,
      clientMsgId,
      status: m.status,
      currentVersion: m.current_version,
      createdAt,
      deliveredAt,
      readAt,
      versions: parsedVersions,
    });
  }

  return result;
}
