import { parseMediaPayload, type MediaPayload } from "./media";

export const MAX_TEXT_CHARS = 10_000;

export type TextPayload = { type: "TEXT"; text: string };

export type MessagePayload = TextPayload | MediaPayload;

export class MessagePayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessagePayloadError";
    Object.setPrototypeOf(this, MessagePayloadError.prototype);
  }
}

function validateTextPayload(obj: Record<string, unknown>): TextPayload {
  const keys = Object.keys(obj);
  if (keys.length !== 2 || !keys.includes("type") || !keys.includes("text")) {
    throw new MessagePayloadError("TEXT payload must only contain 'type' and 'text'");
  }

  if (typeof obj.text !== "string") {
    throw new MessagePayloadError("TEXT payload text must be a string");
  }

  if (obj.text.trim().length === 0) {
    throw new MessagePayloadError("TEXT payload text must not be empty or whitespace-only");
  }

  if (obj.text.length > MAX_TEXT_CHARS) {
    throw new MessagePayloadError(
      `TEXT payload exceeds maximum length of ${MAX_TEXT_CHARS} characters`,
    );
  }

  return {
    type: "TEXT",
    text: obj.text,
  };
}

export function encodeMessagePayload(p: MessagePayload): string {
  if (typeof p !== "object" || p === null || Array.isArray(p)) {
    throw new MessagePayloadError("Payload must be a non-null object");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic payload validation
  const candidate = p as Record<string, any>;

  if (candidate.type === "TEXT") {
    const validated = validateTextPayload(candidate);
    return JSON.stringify(validated);
  }

  if (candidate.type === "IMAGE") {
    try {
      const validated = parseMediaPayload(candidate);
      return JSON.stringify(validated);
    } catch (err) {
      throw new MessagePayloadError(
        `Invalid IMAGE payload: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  throw new MessagePayloadError(`Unknown payload type: ${String(candidate.type)}`);
}

export function decodeMessagePayload(plaintext: string): MessagePayload {
  if (typeof plaintext !== "string") {
    throw new MessagePayloadError("Plaintext must be a string");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch (err) {
    throw new MessagePayloadError(
      `Failed to parse message payload JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MessagePayloadError("Decoded payload must be a non-null object");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic payload validation
  const candidate = parsed as Record<string, any>;

  if (candidate.type === "TEXT") {
    return validateTextPayload(candidate);
  }

  if (candidate.type === "IMAGE") {
    try {
      return parseMediaPayload(candidate);
    } catch (err) {
      throw new MessagePayloadError(
        `Invalid IMAGE payload: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  throw new MessagePayloadError(`Unknown payload type: ${String(candidate.type)}`);
}
