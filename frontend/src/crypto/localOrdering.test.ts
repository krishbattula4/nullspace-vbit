import { afterEach, describe, expect, it } from "vitest";
import { MessageStore } from "../store/messageStore";
import { SecureMessenger } from "./secureMessaging";

// Regression test: messages created inside the same millisecond (a fast sender, or a fast CI
// runner) must still keep their send order. Before the fix their local timestamps tied and the
// order fell back to the random message id.

describe("local message ordering", () => {
  const stores: MessageStore[] = [];
  afterEach(async () => {
    while (stores.length > 0) {
      const s = stores.pop();
      if (s) await s.wipe();
    }
  });

  function makeMessenger(userId: string, messages: MessageStore, now: () => Date) {
    return new SecureMessenger({
      userId,
      sessions: {
        encrypt: async () => ({ type: 1 as const, body: "AAEC" }),
        decrypt: async () => "",
      },
      messages,
      send: () => {},
      now,
    });
  }

  it("keeps send order for messages created at the very same instant (frozen clock)", async () => {
    const userId = crypto.randomUUID();
    const peerId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const messages = new MessageStore(userId);
    stores.push(messages);
    const frozen = new Date("2026-11-19T10:00:00.000Z");
    const messenger = makeMessenger(userId, messages, () => frozen);

    const sentIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      const { clientMsgId } = await messenger.sendText(conversationId, peerId, `message ${i}`);
      sentIds.push(clientMsgId);
    }

    const newestFirst = await messages.listMessages(conversationId);
    expect(newestFirst.map((m) => m.id)).toEqual([...sentIds].reverse());
    // every local timestamp is unique and strictly increasing, with microsecond precision
    const stamps = newestFirst.map((m) => m.createdAt).reverse();
    expect(new Set(stamps).size).toBe(stamps.length);
    expect([...stamps].sort()).toEqual(stamps);
    for (const s of stamps) {
      expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    }
  });

  it("keeps order when the clock goes backwards (adjusted system time)", async () => {
    const userId = crypto.randomUUID();
    const peerId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const messages = new MessageStore(userId);
    stores.push(messages);
    const times = [
      new Date("2026-11-19T10:00:05.000Z"),
      new Date("2026-11-19T10:00:01.000Z"), // clock jumped back
      new Date("2026-11-19T10:00:09.000Z"),
    ];
    let i = 0;
    const messenger = makeMessenger(userId, messages, () => times[Math.min(i++, times.length - 1)]);

    const a = await messenger.sendText(conversationId, peerId, "first");
    const b = await messenger.sendText(conversationId, peerId, "second");
    const c = await messenger.sendText(conversationId, peerId, "third");

    const newestFirst = await messages.listMessages(conversationId);
    expect(newestFirst.map((m) => m.id)).toEqual([c.clientMsgId, b.clientMsgId, a.clientMsgId]);
  });
});
