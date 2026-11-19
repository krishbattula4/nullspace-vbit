import { describe, expect, it } from "vitest";
import {
  normalizeTimestamp,
  parseHistoryPage,
  HistoryParseError,
} from "./history";

describe("history.ts parser and normalizer", () => {
  describe("normalizeTimestamp", () => {
    it("handles naive, Z and +00:00 inputs producing matching UTC ISO strings", () => {
      const naive = "2026-11-19T10:05:00";
      const withZ = "2026-11-19T10:05:00Z";
      const withOffset = "2026-11-19T10:05:00+00:00";

      const resNaive = normalizeTimestamp(naive);
      const resZ = normalizeTimestamp(withZ);
      const resOffset = normalizeTimestamp(withOffset);

      expect(resNaive).toBe("2026-11-19T10:05:00.000000Z");
      expect(resZ).toBe("2026-11-19T10:05:00.000000Z");
      expect(resOffset).toBe("2026-11-19T10:05:00.000000Z");
    });

    it("throws HistoryParseError for garbage or empty strings", () => {
      expect(() => normalizeTimestamp("")).toThrow(HistoryParseError);
      expect(() => normalizeTimestamp("   ")).toThrow(HistoryParseError);
      expect(() => normalizeTimestamp("not-a-timestamp")).toThrow(HistoryParseError);
      expect(() => normalizeTimestamp("2026-99-99T99:99:99")).toThrow(HistoryParseError);
    });

    it("throws HistoryParseError for impossible calendar dates (Feb 31, Month 13)", () => {
      expect(() => normalizeTimestamp("2026-02-31T10:00:00Z")).toThrow(HistoryParseError);
      expect(() => normalizeTimestamp("2026-13-10T10:00:00Z")).toThrow(HistoryParseError);
      expect(() => normalizeTimestamp("2026-04-31T10:00:00Z")).toThrow(HistoryParseError);
      expect(() => normalizeTimestamp("2025-02-29T10:00:00Z")).toThrow(HistoryParseError); // not leap year
    });

    it("accepts valid leap year Feb 29", () => {
      expect(normalizeTimestamp("2024-02-29T12:00:00Z")).toBe("2024-02-29T12:00:00.000000Z");
    });
  });

  describe("parseHistoryPage", () => {
    const validMessage = {
      id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      conversation_id: "e3b0c442-98fc-1c14-9afb-f4c8996fb924",
      sender_id: "11111111-1111-1111-1111-111111111111",
      client_msg_id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      current_version: 2,
      status: "SENT",
      created_at: "2026-11-19T10:05:00Z",
      delivered_at: null,
      read_at: null,
      versions: [
        {
          id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          message_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
          version_no: 1,
          ctype: 3,
          ciphertext: "c2VjcmV0X3ByZWtleV9jaXBoZXJ0ZXh0",
          action: "CREATE",
          actor_id: "11111111-1111-1111-1111-111111111111",
          created_at: "2026-11-19T10:05:00Z",
          erased_at: null,
        },
        {
          id: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
          message_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
          version_no: 2,
          ctype: 1,
          ciphertext: "c2VjcmV0X2VkaXRlZF9jaXBoZXJ0ZXh0",
          action: "EDIT",
          actor_id: "11111111-1111-1111-1111-111111111111",
          created_at: "2026-11-19T10:10:00Z",
          erased_at: null,
        },
      ],
    };

    it("accepts a valid page and converts snake_case to camelCase", () => {
      const parsed = parseHistoryPage([validMessage]);
      expect(parsed).toHaveLength(1);
      const m = parsed[0];
      expect(m.id).toBe("f47ac10b-58cc-4372-a567-0e02b2c3d479");
      expect(m.conversationId).toBe("e3b0c442-98fc-1c14-9afb-f4c8996fb924");
      expect(m.senderId).toBe("11111111-1111-1111-1111-111111111111");
      expect(m.clientMsgId).toBe("6ba7b810-9dad-11d1-80b4-00c04fd430c8");
      expect(m.currentVersion).toBe(2);
      expect(m.status).toBe("SENT");
      expect(m.createdAt).toBe("2026-11-19T10:05:00.000000Z");
      expect(m.deliveredAt).toBeNull();
      expect(m.readAt).toBeNull();
      expect(m.versions).toHaveLength(2);
      expect(m.versions[0]).toEqual({
        id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        messageId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        versionNo: 1,
        ctype: 3,
        ciphertext: "c2VjcmV0X3ByZWtleV9jaXBoZXJ0ZXh0",
        action: "CREATE",
        actorId: "11111111-1111-1111-1111-111111111111",
        createdAt: "2026-11-19T10:05:00.000000Z",
        erasedAt: null,
      });
    });

    it("accepts empty ciphertext (e.g. for DELETE or RETRACT)", () => {
      const deletedMessage = {
        ...validMessage,
        versions: [
          {
            ...validMessage.versions[0],
            action: "DELETE",
            ciphertext: "",
            erased_at: "2026-11-19T10:15:00Z",
          },
        ],
      };
      const parsed = parseHistoryPage([deletedMessage]);
      expect(parsed[0].versions[0].ciphertext).toBe("");
      expect(parsed[0].versions[0].action).toBe("DELETE");
    });

    it("ignores unknown extra fields (forward compatible)", () => {
      const withExtra = {
        ...validMessage,
        extra_server_field: "ignored",
        server_tags: [1, 2, 3],
        versions: [
          {
            ...validMessage.versions[0],
            extra_version_field: { foo: "bar" },
          },
        ],
      };
      const parsed = parseHistoryPage([withExtra]);
      expect(parsed).toHaveLength(1);
      // Extra fields are omitted from result object
      expect((parsed[0] as unknown as Record<string, unknown>).extra_server_field).toBeUndefined();
      expect((parsed[0].versions[0] as unknown as Record<string, unknown>).extra_version_field).toBeUndefined();
    });

    it("rejects non-array input", () => {
      expect(() => parseHistoryPage(null)).toThrow(HistoryParseError);
      expect(() => parseHistoryPage({})).toThrow(HistoryParseError);
      expect(() => parseHistoryPage("string")).toThrow(HistoryParseError);
    });

    it("rejects bad UUIDs (uppercase or invalid format)", () => {
      const badId = { ...validMessage, id: "F47AC10B-58CC-4372-A567-0E02B2C3D479" };
      expect(() => parseHistoryPage([badId])).toThrow(HistoryParseError);

      const badSender = { ...validMessage, sender_id: "not-a-uuid" };
      expect(() => parseHistoryPage([badSender])).toThrow(HistoryParseError);
    });

    it("rejects version_no 0 or negative", () => {
      const badVerNo = {
        ...validMessage,
        versions: [{ ...validMessage.versions[0], version_no: 0 }],
      };
      expect(() => parseHistoryPage([badVerNo])).toThrow(HistoryParseError);
    });

    it("rejects ctype 2 (must be 1 or 3)", () => {
      const badCtype = {
        ...validMessage,
        versions: [{ ...validMessage.versions[0], ctype: 2 }],
      };
      expect(() => parseHistoryPage([badCtype])).toThrow(HistoryParseError);
    });

    it("rejects unknown action", () => {
      const badAction = {
        ...validMessage,
        versions: [{ ...validMessage.versions[0], action: "PURGE" }],
      };
      expect(() => parseHistoryPage([badAction])).toThrow(HistoryParseError);
    });

    it("rejects non-base64 ciphertext", () => {
      const badCiphertext = {
        ...validMessage,
        versions: [{ ...validMessage.versions[0], ciphertext: "not base 64 @@@" }],
      };
      expect(() => parseHistoryPage([badCiphertext])).toThrow(HistoryParseError);
    });

    it("never returns a partial list if an item is invalid", () => {
      const badItem = { ...validMessage, status: "INVALID_STATUS" };
      expect(() => parseHistoryPage([validMessage, badItem])).toThrow(HistoryParseError);
    });
  });
});
