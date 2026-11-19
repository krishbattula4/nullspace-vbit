import { afterEach, describe, expect, it } from "vitest";
import { MessageStore } from "../store/messageStore";
import { SecureMessenger } from "./secureMessaging";
import { normalizeTimestamp, type ServerHistoryMessage } from "../lib/history";

// Hardening tests for P5.7: microsecond ordering of timestamps and honest status counting.

describe("normalizeTimestamp precision", () => {
  it("keeps microseconds and always emits exactly 6 fraction digits", () => {
    expect(normalizeTimestamp("2026-11-19T10:00:00.123456")).toBe("2026-11-19T10:00:00.123456Z");
    expect(normalizeTimestamp("2026-11-19T10:00:00.123456+00:00")).toBe("2026-11-19T10:00:00.123456Z");
    expect(normalizeTimestamp("2026-11-19T10:00:00.1Z")).toBe("2026-11-19T10:00:00.100000Z");
    expect(normalizeTimestamp("2026-11-19T10:00:00Z")).toBe("2026-11-19T10:00:00.000000Z");
    // more than 6 digits are truncated, never rounded up into the next second
    expect(normalizeTimestamp("2026-11-19T10:00:00.9999999Z")).toBe("2026-11-19T10:00:00.999999Z");
  });

  it("converts a non-zero offset to UTC without touching the fraction", () => {
    expect(normalizeTimestamp("2026-11-19T15:30:00.250001+05:30")).toBe("2026-11-19T10:00:00.250001Z");
  });

  it("orders two timestamps inside the same millisecond correctly by plain string comparison", () => {
    const a = normalizeTimestamp("2026-11-19T10:00:00.123100");
    const b = normalizeTimestamp("2026-11-19T10:00:00.123900");
    const c = normalizeTimestamp("2026-11-19T10:00:00.124000");
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
    expect([c, a, b].sort()).toEqual([a, b, c]);
  });
});

describe("reconcileHistory status counting", () => {
  const stores: MessageStore[] = [];
  afterEach(async () => {
    while (stores.length > 0) {
      const s = stores.pop();
      if (s) await s.wipe();
    }
  });

  it("counts only real status changes and is a no-op the second time", async () => {
    const userId = crypto.randomUUID();
    const peerId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const messages = new MessageStore(userId);
    stores.push(messages);

    const messenger = new SecureMessenger({
      userId,
      sessions: {
        encrypt: async () => ({ type: 1 as const, body: "AAEC" }),
        decrypt: async () => {
          throw new Error("decrypt must not be called for own messages");
        },
      },
      messages,
      send: () => {},
    });

    const ownRead: ServerHistoryMessage = {
      id: crypto.randomUUID(),
      conversationId,
      senderId: userId,
      clientMsgId: crypto.randomUUID(),
      status: "DELIVERED",
      currentVersion: 1,
      createdAt: normalizeTimestamp("2026-11-19T10:00:00.000001"),
      deliveredAt: normalizeTimestamp("2026-11-19T10:00:01.000000"),
      readAt: normalizeTimestamp("2026-11-19T10:00:02.000000"),
      versions: [],
    };
    const ownSent: ServerHistoryMessage = {
      ...ownRead,
      id: crypto.randomUUID(),
      clientMsgId: crypto.randomUUID(),
      status: "SENT",
      deliveredAt: null,
      readAt: null,
      createdAt: normalizeTimestamp("2026-11-19T10:00:03.000000"),
    };

    const first = await messenger.reconcileHistory(peerId, [ownRead, ownSent]);
    // the placeholders are created with the server status; only the READ one changes afterwards
    expect(first.statusUpdates).toBe(1);
    expect((await messages.getMessage(ownRead.id))?.status).toBe("READ");
    expect((await messages.getMessage(ownSent.id))?.status).toBe("SENT");

    const updates: unknown[] = [];
    messenger.on("update", (d) => {
      updates.push(d);
    });
    const second = await messenger.reconcileHistory(peerId, [ownRead, ownSent]);
    expect(second.statusUpdates).toBe(0);
    expect(second.decrypted).toBe(0);
    expect(second.tombstones).toBe(0);
    // nothing changed, so no per-message update events either
    expect(updates).toHaveLength(0);
  });
});
