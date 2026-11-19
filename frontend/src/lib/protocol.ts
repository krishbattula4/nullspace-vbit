/**
 * WebSocket envelope schema and protocol validation for Nullspace.
 *
 * Implements strict type definitions, encoding, and decoding for protocol v1 frames.
 */

export const PROTOCOL_VERSION = 1 as const;
export const MAX_BODY_BYTES = 65536;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/;

const CLIENT_FRAME_TYPES = [
  "MESSAGE",
  "DELIVERED",
  "READ",
  "EDIT",
  "DELETE",
  "RETRACT",
  "TYPING",
] as const;

const SERVER_FRAME_TYPES = [
  "MESSAGE",
  "ACK",
  "DELIVERED",
  "READ",
  "EDIT",
  "DELETE",
  "RETRACT",
  "TYPING",
  "PRESENCE",
  "ERROR",
] as const;

export class ProtocolError extends Error {
  readonly code: string;
  readonly detail?: string;

  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ProtocolError";
    this.code = code;
    this.detail = detail;
  }
}

// Control frames (no protocol version 'v')
export interface AuthFrame {
  type: "AUTH";
  token: string;
}

export interface AuthOkFrame {
  type: "AUTH_OK";
  user_id: string;
}

export interface PingFrame {
  type: "PING";
}

export interface PongFrame {
  type: "PONG";
}

// Client -> server frames (require v: 1)
export interface ClientMessageFrame {
  v: 1;
  type: "MESSAGE";
  conversation_id: string;
  client_msg_id: string;
  ctype: 1 | 3;
  body: string;
}

export interface ClientDeliveredFrame {
  v: 1;
  type: "DELIVERED";
  message_id: string;
}

export interface ClientReadFrame {
  v: 1;
  type: "READ";
  message_id: string;
}

export interface ClientEditFrame {
  v: 1;
  type: "EDIT";
  message_id: string;
  ctype: 1 | 3;
  body: string;
}

export interface ClientDeleteFrame {
  v: 1;
  type: "DELETE";
  message_id: string;
}

export interface ClientRetractFrame {
  v: 1;
  type: "RETRACT";
  message_id: string;
}

export interface ClientTypingFrame {
  v: 1;
  type: "TYPING";
  conversation_id: string;
}

export type ClientFrame =
  | ClientMessageFrame
  | ClientDeliveredFrame
  | ClientReadFrame
  | ClientEditFrame
  | ClientDeleteFrame
  | ClientRetractFrame
  | ClientTypingFrame;

// Server -> client frames (require v: 1)
export interface ServerMessageFrame {
  v: 1;
  type: "MESSAGE";
  message_id: string;
  conversation_id: string;
  sender_id: string;
  version_no: number;
  ctype: 1 | 3;
  body: string;
  created_at: string;
}

export interface ServerAckFrame {
  v: 1;
  type: "ACK";
  client_msg_id: string;
  message_id: string;
  status: "SENT" | "QUEUED";
}

export interface ServerDeliveredFrame {
  v: 1;
  type: "DELIVERED";
  message_id: string;
  delivered_at: string;
}

export interface ServerReadFrame {
  v: 1;
  type: "READ";
  message_id: string;
  read_at: string;
}

export interface ServerEditFrame {
  v: 1;
  type: "EDIT";
  message_id: string;
  version_no: number;
  ctype: 1 | 3;
  body: string;
  edited_at: string;
}

export interface ServerDeleteFrame {
  v: 1;
  type: "DELETE";
  message_id: string;
}

export interface ServerRetractFrame {
  v: 1;
  type: "RETRACT";
  message_id: string;
}

export interface ServerTypingFrame {
  v: 1;
  type: "TYPING";
  conversation_id: string;
  user_id: string;
}

export interface ServerPresenceFrame {
  v: 1;
  type: "PRESENCE";
  user_id: string;
  online: boolean;
}

export interface ServerErrorFrame {
  v: 1;
  type: "ERROR";
  code: string;
  detail?: string;
  client_msg_id?: string;
}

export type ServerFrame =
  | ServerMessageFrame
  | ServerAckFrame
  | ServerDeliveredFrame
  | ServerReadFrame
  | ServerEditFrame
  | ServerDeleteFrame
  | ServerRetractFrame
  | ServerTypingFrame
  | ServerPresenceFrame
  | ServerErrorFrame;

// Client-side only event (event bus only; rejected over the wire)
export interface KeyChangedEvent {
  type: "KEY_CHANGED";
  user_id: string;
}

// ---------------------------------------------------------------------------
// Validation Helpers
// ---------------------------------------------------------------------------

function validateUuid(val: unknown, fieldName: string): string {
  if (typeof val !== "string" || !UUID_REGEX.test(val)) {
    throw new ProtocolError("invalid_frame", `Invalid canonical lowercase UUID for ${fieldName}`);
  }
  return val;
}

function validateCtype(val: unknown): 1 | 3 {
  // Ensure strict number and integer (1 or 3)
  if (typeof val !== "number" || !Number.isInteger(val) || (val !== 1 && val !== 3)) {
    throw new ProtocolError("invalid_frame", "ctype must be integer 1 or 3");
  }
  return val;
}

function validateBase64Body(val: unknown): string {
  if (typeof val !== "string" || val.length === 0) {
    throw new ProtocolError("invalid_frame", "body must be non-empty string");
  }
  if (val.length % 4 !== 0 || !BASE64_REGEX.test(val)) {
    throw new ProtocolError("invalid_frame", "body must be valid standard base64");
  }

  let decoded: string;
  try {
    decoded = atob(val);
  } catch (e) {
    throw new ProtocolError("invalid_frame", `Invalid base64 payload: ${String(e)}`);
  }

  if (decoded.length === 0) {
    throw new ProtocolError("invalid_frame", "decoded body cannot be empty");
  }
  if (decoded.length > MAX_BODY_BYTES) {
    throw new ProtocolError(
      "invalid_frame",
      `decoded body ${decoded.length} bytes exceeds maximum ${MAX_BODY_BYTES}`,
    );
  }

  // Non-canonical padding check: re-encoding must reproduce the exact string byte-for-byte
  if (btoa(decoded) !== val) {
    throw new ProtocolError("invalid_frame", "body contains non-canonical base64 padding");
  }

  return val;
}

function validateTimestamp(val: unknown, fieldName: string): string {
  if (typeof val !== "string" || !TIMESTAMP_REGEX.test(val) || isNaN(Date.parse(val))) {
    throw new ProtocolError("invalid_frame", `${fieldName} must be ISO 8601 UTC string ending in Z`);
  }
  return val;
}

function assertExactKeys(obj: Record<string, unknown>, allowedKeys: readonly string[]): void {
  const keys = Object.keys(obj);
  for (const k of keys) {
    if (!allowedKeys.includes(k)) {
      throw new ProtocolError("invalid_frame", `Unknown extra field: ${k}`);
    }
  }
  for (const k of allowedKeys) {
    if (!(k in obj)) {
      throw new ProtocolError("invalid_frame", `Missing required field: ${k}`);
    }
  }
}

function assertAllowedKeys(
  obj: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): void {
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      throw new ProtocolError("invalid_frame", `Unknown extra field: ${k}`);
    }
  }
  for (const k of requiredKeys) {
    if (!(k in obj)) {
      throw new ProtocolError("invalid_frame", `Missing required field: ${k}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Protocol Parser & Encoder
// ---------------------------------------------------------------------------

/**
 * Parses and validates an incoming server frame or control frame.
 *
 * Enforces versioning, UUID schemas, base64 constraints, timestamp formatting,
 * and rejects unknown types or extra properties.
 */
export function parseServerFrame(raw: string): ServerFrame | AuthOkFrame | PingFrame | PongFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ProtocolError("invalid_json", String(e));
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProtocolError("not_an_object", "Frame must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  // Control frames carry NO "v" property
  if (!("v" in obj)) {
    const controlType = obj.type;
    if (controlType === "AUTH_OK") {
      assertExactKeys(obj, ["type", "user_id"]);
      validateUuid(obj.user_id, "user_id");
      return obj as unknown as AuthOkFrame;
    }
    if (controlType === "PING") {
      assertExactKeys(obj, ["type"]);
      return obj as unknown as PingFrame;
    }
    if (controlType === "PONG") {
      assertExactKeys(obj, ["type"]);
      return obj as unknown as PongFrame;
    }
    // Missing 'v' on non-control frame
    throw new ProtocolError("missing_version", "Missing 'v' field");
  }

  // Version check
  const v = obj.v;
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new ProtocolError("unsupported_version", "Version must be an integer");
  }
  if (v !== PROTOCOL_VERSION) {
    throw new ProtocolError("unsupported_version", `Unsupported protocol version ${v}`);
  }

  // Type check
  const type = obj.type;
  if (typeof type !== "string" || !(SERVER_FRAME_TYPES as readonly string[]).includes(type)) {
    throw new ProtocolError("unknown_type", `Unknown server frame type: ${String(type)}`);
  }

  // Strict per-frame field validation
  switch (type) {
    case "MESSAGE": {
      assertExactKeys(obj, [
        "v",
        "type",
        "message_id",
        "conversation_id",
        "sender_id",
        "version_no",
        "ctype",
        "body",
        "created_at",
      ]);
      validateUuid(obj.message_id, "message_id");
      validateUuid(obj.conversation_id, "conversation_id");
      validateUuid(obj.sender_id, "sender_id");
      if (
        typeof obj.version_no !== "number" ||
        !Number.isInteger(obj.version_no) ||
        obj.version_no < 1
      ) {
        throw new ProtocolError("invalid_frame", "version_no must be integer >= 1");
      }
      validateCtype(obj.ctype);
      validateBase64Body(obj.body);
      validateTimestamp(obj.created_at, "created_at");
      return obj as unknown as ServerMessageFrame;
    }

    case "ACK": {
      assertExactKeys(obj, ["v", "type", "client_msg_id", "message_id", "status"]);
      validateUuid(obj.client_msg_id, "client_msg_id");
      validateUuid(obj.message_id, "message_id");
      if (obj.status !== "SENT" && obj.status !== "QUEUED") {
        throw new ProtocolError("invalid_frame", "status must be SENT or QUEUED");
      }
      return obj as unknown as ServerAckFrame;
    }

    case "DELIVERED": {
      assertExactKeys(obj, ["v", "type", "message_id", "delivered_at"]);
      validateUuid(obj.message_id, "message_id");
      validateTimestamp(obj.delivered_at, "delivered_at");
      return obj as unknown as ServerDeliveredFrame;
    }

    case "READ": {
      assertExactKeys(obj, ["v", "type", "message_id", "read_at"]);
      validateUuid(obj.message_id, "message_id");
      validateTimestamp(obj.read_at, "read_at");
      return obj as unknown as ServerReadFrame;
    }

    case "EDIT": {
      assertExactKeys(obj, [
        "v",
        "type",
        "message_id",
        "version_no",
        "ctype",
        "body",
        "edited_at",
      ]);
      validateUuid(obj.message_id, "message_id");
      if (
        typeof obj.version_no !== "number" ||
        !Number.isInteger(obj.version_no) ||
        obj.version_no < 2
      ) {
        throw new ProtocolError("invalid_frame", "version_no must be integer >= 2");
      }
      validateCtype(obj.ctype);
      validateBase64Body(obj.body);
      validateTimestamp(obj.edited_at, "edited_at");
      return obj as unknown as ServerEditFrame;
    }

    case "DELETE": {
      assertExactKeys(obj, ["v", "type", "message_id"]);
      validateUuid(obj.message_id, "message_id");
      return obj as unknown as ServerDeleteFrame;
    }

    case "RETRACT": {
      assertExactKeys(obj, ["v", "type", "message_id"]);
      validateUuid(obj.message_id, "message_id");
      return obj as unknown as ServerRetractFrame;
    }

    case "TYPING": {
      assertExactKeys(obj, ["v", "type", "conversation_id", "user_id"]);
      validateUuid(obj.conversation_id, "conversation_id");
      validateUuid(obj.user_id, "user_id");
      return obj as unknown as ServerTypingFrame;
    }

    case "PRESENCE": {
      assertExactKeys(obj, ["v", "type", "user_id", "online"]);
      validateUuid(obj.user_id, "user_id");
      if (typeof obj.online !== "boolean") {
        throw new ProtocolError("invalid_frame", "online must be boolean");
      }
      return obj as unknown as ServerPresenceFrame;
    }

    case "ERROR": {
      assertAllowedKeys(obj, ["v", "type", "code"], ["detail", "client_msg_id"]);
      if (typeof obj.code !== "string" || obj.code.length === 0) {
        throw new ProtocolError("invalid_frame", "code must be non-empty string");
      }
      if ("detail" in obj && typeof obj.detail !== "string") {
        throw new ProtocolError("invalid_frame", "detail must be string");
      }
      if ("client_msg_id" in obj && obj.client_msg_id !== undefined) {
        validateUuid(obj.client_msg_id, "client_msg_id");
      }
      return obj as unknown as ServerErrorFrame;
    }

    default:
      throw new ProtocolError("unknown_type", `Unknown server frame type: ${String(type)}`);
  }
}

/**
 * Validates and serializes an outgoing client frame to a JSON string.
 */
export function encodeClientFrame(frame: ClientFrame): string {
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
    throw new ProtocolError("not_an_object", "Frame must be a JSON object");
  }

  const obj = frame as unknown as Record<string, unknown>;

  if (!("v" in obj)) {
    throw new ProtocolError("missing_version", "Missing 'v' field");
  }
  const v = obj.v;
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new ProtocolError("unsupported_version", "Version must be an integer");
  }
  if (v !== PROTOCOL_VERSION) {
    throw new ProtocolError("unsupported_version", `Unsupported protocol version ${v}`);
  }

  const type = obj.type;
  if (typeof type !== "string" || !(CLIENT_FRAME_TYPES as readonly string[]).includes(type)) {
    throw new ProtocolError("unknown_type", `Unknown client frame type: ${String(type)}`);
  }

  switch (type) {
    case "MESSAGE": {
      assertExactKeys(obj, [
        "v",
        "type",
        "conversation_id",
        "client_msg_id",
        "ctype",
        "body",
      ]);
      validateUuid(obj.conversation_id, "conversation_id");
      validateUuid(obj.client_msg_id, "client_msg_id");
      validateCtype(obj.ctype);
      validateBase64Body(obj.body);
      break;
    }

    case "DELIVERED": {
      assertExactKeys(obj, ["v", "type", "message_id"]);
      validateUuid(obj.message_id, "message_id");
      break;
    }

    case "READ": {
      assertExactKeys(obj, ["v", "type", "message_id"]);
      validateUuid(obj.message_id, "message_id");
      break;
    }

    case "EDIT": {
      assertExactKeys(obj, ["v", "type", "message_id", "ctype", "body"]);
      validateUuid(obj.message_id, "message_id");
      validateCtype(obj.ctype);
      validateBase64Body(obj.body);
      break;
    }

    case "DELETE": {
      assertExactKeys(obj, ["v", "type", "message_id"]);
      validateUuid(obj.message_id, "message_id");
      break;
    }

    case "RETRACT": {
      assertExactKeys(obj, ["v", "type", "message_id"]);
      validateUuid(obj.message_id, "message_id");
      break;
    }

    case "TYPING": {
      assertExactKeys(obj, ["v", "type", "conversation_id"]);
      validateUuid(obj.conversation_id, "conversation_id");
      break;
    }

    default:
      throw new ProtocolError("unknown_type", `Unknown client frame type: ${String(type)}`);
  }

  return JSON.stringify(frame);
}

// ---------------------------------------------------------------------------
// Client Frame Builders
// ---------------------------------------------------------------------------

export function messageFrame(
  conversation_id: string,
  client_msg_id: string,
  ctype: 1 | 3,
  body: string,
): ClientMessageFrame {
  validateUuid(conversation_id, "conversation_id");
  validateUuid(client_msg_id, "client_msg_id");
  validateCtype(ctype);
  validateBase64Body(body);
  return {
    v: PROTOCOL_VERSION,
    type: "MESSAGE",
    conversation_id,
    client_msg_id,
    ctype,
    body,
  };
}

export function deliveredFrame(message_id: string): ClientDeliveredFrame {
  validateUuid(message_id, "message_id");
  return {
    v: PROTOCOL_VERSION,
    type: "DELIVERED",
    message_id,
  };
}

export function readFrame(message_id: string): ClientReadFrame {
  validateUuid(message_id, "message_id");
  return {
    v: PROTOCOL_VERSION,
    type: "READ",
    message_id,
  };
}

export function editFrame(
  message_id: string,
  ctype: 1 | 3,
  body: string,
): ClientEditFrame {
  validateUuid(message_id, "message_id");
  validateCtype(ctype);
  validateBase64Body(body);
  return {
    v: PROTOCOL_VERSION,
    type: "EDIT",
    message_id,
    ctype,
    body,
  };
}

export function deleteFrame(message_id: string): ClientDeleteFrame {
  validateUuid(message_id, "message_id");
  return {
    v: PROTOCOL_VERSION,
    type: "DELETE",
    message_id,
  };
}

export function retractFrame(message_id: string): ClientRetractFrame {
  validateUuid(message_id, "message_id");
  return {
    v: PROTOCOL_VERSION,
    type: "RETRACT",
    message_id,
  };
}

export function typingFrame(conversation_id: string): ClientTypingFrame {
  validateUuid(conversation_id, "conversation_id");
  return {
    v: PROTOCOL_VERSION,
    type: "TYPING",
    conversation_id,
  };
}
