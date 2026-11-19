import { describe, expect, it } from "vitest";
import rawExamples from "../../../docs/schemas/envelope-examples.json?raw";
import {
  MAX_BODY_BYTES,
  PROTOCOL_VERSION,
  ProtocolError,
  deleteFrame,
  deliveredFrame,
  editFrame,
  encodeClientFrame,
  messageFrame,
  parseServerFrame,
  readFrame,
  retractFrame,
  typingFrame,
  type AuthOkFrame,
  type ClientFrame,
  type PingFrame,
  type PongFrame,
  type ServerFrame,
} from "./protocol";

interface ExampleSuite {
  clientFrames: ClientFrame[];
  serverFrames: ServerFrame[];
  invalidClientFrames: Array<{
    name: string;
    frame: unknown;
    code: string;
  }>;
}

const examples = JSON.parse(rawExamples) as ExampleSuite;

describe("WebSocket Envelope Protocol (P2.2)", () => {
  it("h. every serverFrames example parses to a typed frame with correct field values", () => {
    for (const frame of examples.serverFrames) {
      const raw = JSON.stringify(frame);
      const parsed = parseServerFrame(raw);

      expect(parsed.type).toBe(frame.type);
      expect((parsed as ServerFrame).v).toBe(PROTOCOL_VERSION);

      // Verify all fields match
      expect(parsed).toEqual(frame);
    }
  });

  it("i. encodeClientFrame of every clientFrames example round-trips correctly", () => {
    for (const frame of examples.clientFrames) {
      const encoded = encodeClientFrame(frame);
      const parsed = JSON.parse(encoded) as unknown;
      expect(parsed).toEqual(frame);
    }
  });

  it("j. invalid client frames rejected by encodeClientFrame; parseServerFrame error handling", () => {
    for (const entry of examples.invalidClientFrames) {
      // If the frame has the shape of an object that a client could attempt to build/send
      if (typeof entry.frame === "object" && entry.frame !== null && !Array.isArray(entry.frame)) {
        expect(
          () => encodeClientFrame(entry.frame as unknown as ClientFrame),
          `Failed on entry: ${entry.name}`,
        ).toThrowError(ProtocolError);

        try {
          encodeClientFrame(entry.frame as unknown as ClientFrame);
        } catch (err) {
          expect(err).toBeInstanceOf(ProtocolError);
          expect((err as ProtocolError).code).toBe(entry.code);
        }
      }
    }

    // parseServerFrame rejects unsupported_version (v: 2)
    const futureVersionFrame = JSON.stringify({
      v: 2,
      type: "MESSAGE",
      message_id: "44444444-4444-4444-4444-444444444444",
      conversation_id: "11111111-1111-1111-1111-111111111111",
      sender_id: "55555555-5555-5555-5555-555555555555",
      version_no: 1,
      ctype: 1,
      body: "AQID",
      created_at: "2026-11-18T12:00:00Z",
    });
    expect(() => parseServerFrame(futureVersionFrame)).toThrowError(ProtocolError);
    try {
      parseServerFrame(futureVersionFrame);
    } catch (err) {
      expect((err as ProtocolError).code).toBe("unsupported_version");
    }

    // parseServerFrame rejects missing_version
    const missingVersionFrame = JSON.stringify({
      type: "MESSAGE",
      message_id: "44444444-4444-4444-4444-444444444444",
      conversation_id: "11111111-1111-1111-1111-111111111111",
      sender_id: "55555555-5555-5555-5555-555555555555",
      version_no: 1,
      ctype: 1,
      body: "AQID",
      created_at: "2026-11-18T12:00:00Z",
    });
    expect(() => parseServerFrame(missingVersionFrame)).toThrowError(ProtocolError);
    try {
      parseServerFrame(missingVersionFrame);
    } catch (err) {
      expect((err as ProtocolError).code).toBe("missing_version");
    }

    // parseServerFrame rejects unknown_type
    const unknownTypeFrame = JSON.stringify({
      v: 1,
      type: "NOT_A_SERVER_TYPE",
    });
    expect(() => parseServerFrame(unknownTypeFrame)).toThrowError(ProtocolError);
    try {
      parseServerFrame(unknownTypeFrame);
    } catch (err) {
      expect((err as ProtocolError).code).toBe("unknown_type");
    }
  });

  it("k. body of exactly MAX_BODY_BYTES decoded bytes accepted; MAX_BODY_BYTES + 1 rejected", () => {
    const cid = "11111111-1111-1111-1111-111111111111";
    const mid = "22222222-2222-2222-2222-222222222222";

    // Exactly 65536 bytes
    const exactBytes = new Uint8Array(MAX_BODY_BYTES);
    exactBytes.fill(65); // ASCII 'A'
    let exactBinary = "";
    for (let i = 0; i < exactBytes.length; i++) {
      exactBinary += String.fromCharCode(exactBytes[i]);
    }
    const exactBase64 = btoa(exactBinary);

    const clientExactFrame: ClientFrame = {
      v: 1,
      type: "MESSAGE",
      conversation_id: cid,
      client_msg_id: mid,
      ctype: 1,
      body: exactBase64,
    };
    expect(() => encodeClientFrame(clientExactFrame)).not.toThrow();

    const serverExactFrame = JSON.stringify({
      v: 1,
      type: "MESSAGE",
      message_id: mid,
      conversation_id: cid,
      sender_id: mid,
      version_no: 1,
      ctype: 1,
      body: exactBase64,
      created_at: "2026-11-18T12:00:00Z",
    });
    expect(() => parseServerFrame(serverExactFrame)).not.toThrow();

    // Exactly 65537 bytes (MAX_BODY_BYTES + 1)
    const overflowBytes = new Uint8Array(MAX_BODY_BYTES + 1);
    overflowBytes.fill(65);
    let overflowBinary = "";
    for (let i = 0; i < overflowBytes.length; i++) {
      overflowBinary += String.fromCharCode(overflowBytes[i]);
    }
    const overflowBase64 = btoa(overflowBinary);

    const clientOverflowFrame: ClientFrame = {
      v: 1,
      type: "MESSAGE",
      conversation_id: cid,
      client_msg_id: mid,
      ctype: 1,
      body: overflowBase64,
    };
    expect(() => encodeClientFrame(clientOverflowFrame)).toThrowError(ProtocolError);
    try {
      encodeClientFrame(clientOverflowFrame);
    } catch (err) {
      expect((err as ProtocolError).code).toBe("invalid_frame");
    }

    const serverOverflowFrame = JSON.stringify({
      v: 1,
      type: "MESSAGE",
      message_id: mid,
      conversation_id: cid,
      sender_id: mid,
      version_no: 1,
      ctype: 1,
      body: overflowBase64,
      created_at: "2026-11-18T12:00:00Z",
    });
    expect(() => parseServerFrame(serverOverflowFrame)).toThrowError(ProtocolError);
    try {
      parseServerFrame(serverOverflowFrame);
    } catch (err) {
      expect((err as ProtocolError).code).toBe("invalid_frame");
    }
  });

  it("parses control frames AUTH_OK, PING, and PONG", () => {
    const authOk = parseServerFrame(
      JSON.stringify({
        type: "AUTH_OK",
        user_id: "55555555-5555-5555-5555-555555555555",
      }),
    ) as AuthOkFrame;
    expect(authOk.type).toBe("AUTH_OK");
    expect(authOk.user_id).toBe("55555555-5555-5555-5555-555555555555");

    const ping = parseServerFrame(JSON.stringify({ type: "PING" })) as PingFrame;
    expect(ping.type).toBe("PING");

    const pong = parseServerFrame(JSON.stringify({ type: "PONG" })) as PongFrame;
    expect(pong.type).toBe("PONG");

    // Rejects control frame with extra properties
    expect(() =>
      parseServerFrame(
        JSON.stringify({
          type: "AUTH_OK",
          user_id: "55555555-5555-5555-5555-555555555555",
          extra: 123,
        }),
      ),
    ).toThrowError(ProtocolError);
  });

  it("builders construct valid client frames", () => {
    const cid = "11111111-1111-1111-1111-111111111111";
    const mid = "22222222-2222-2222-2222-222222222222";

    const msg = messageFrame(cid, mid, 1, "AQID");
    expect(msg).toEqual({
      v: 1,
      type: "MESSAGE",
      conversation_id: cid,
      client_msg_id: mid,
      ctype: 1,
      body: "AQID",
    });

    const del = deliveredFrame(mid);
    expect(del).toEqual({ v: 1, type: "DELIVERED", message_id: mid });

    const rd = readFrame(mid);
    expect(rd).toEqual({ v: 1, type: "READ", message_id: mid });

    const ed = editFrame(mid, 3, "BAUG");
    expect(ed).toEqual({ v: 1, type: "EDIT", message_id: mid, ctype: 3, body: "BAUG" });

    const delFrame = deleteFrame(mid);
    expect(delFrame).toEqual({ v: 1, type: "DELETE", message_id: mid });

    const retFrame = retractFrame(mid);
    expect(retFrame).toEqual({ v: 1, type: "RETRACT", message_id: mid });

    const typ = typingFrame(cid);
    expect(typ).toEqual({ v: 1, type: "TYPING", conversation_id: cid });
  });
});
