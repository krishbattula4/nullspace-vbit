import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageStore } from "../store/messageStore";
import { SecureMessenger } from "./secureMessaging";
import { encodeMessagePayload } from "./messagePayload";
import type { ServerMessageFrame } from "../lib/protocol";

// Hardening tests for the secure messaging engine: send failure, cross-tab locking and the
// rule that a failed decrypt attempt never overwrites a message that was stored successfully.

describe("SecureMessenger hardening", () => {
  const stores: MessageStore[] = [];

  function newStore(userId: string): MessageStore {
    const s = new MessageStore(userId);
    stores.push(s);
    return s;
  }

  function incoming(messageId: string, senderId: string, conversationId: string): ServerMessageFrame {
    return {
      v: 1,
      type: "MESSAGE",
      message_id: messageId,
      conversation_id: conversationId,
      sender_id: senderId,
      version_no: 1,
      ctype: 1,
      body: "AAEC",
      created_at: "2026-11-19T10:00:00.000Z",
    };
  }

  afterEach(async () => {
    vi.unstubAllGlobals();
    while (stores.length > 0) {
      const s = stores.pop();
      if (s) await s.wipe();
    }
  });

  it("marks the message FAILED and rethrows when send() throws", async () => {
    const userId = crypto.randomUUID();
    const peerId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const messages = newStore(userId);
    const messenger = new SecureMessenger({
      userId,
      sessions: {
        encrypt: async () => ({ type: 1 as const, body: "AAEC" }),
        decrypt: async () => "",
      },
      messages,
      send: () => {
        throw new Error("socket closed");
      },
    });

    const updates: unknown[] = [];
    messenger.on("update", (d) => {
      updates.push(d);
    });

    await expect(messenger.sendText(conversationId, peerId, "hello")).rejects.toThrow("socket closed");

    const list = await messages.listMessages(conversationId);
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe("FAILED");
    expect(updates).toHaveLength(1);
  });

  it("serialises decrypts for one peer across two tabs using the Web Locks API", async () => {
    const userId = crypto.randomUUID();
    const peerId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();

    // Minimal Web Locks stand-in: one FIFO queue per lock name, shared by both "tabs".
    const queues = new Map<string, Promise<unknown>>();
    const lockNames: string[] = [];
    vi.stubGlobal("navigator", {
      locks: {
        request: <T>(name: string, cb: () => Promise<T>): Promise<T> => {
          lockNames.push(name);
          const previous = queues.get(name) ?? Promise.resolve();
          const run = previous.then(() => cb());
          queues.set(
            name,
            run.catch(() => {}),
          );
          return run;
        },
      },
    });

    let active = 0;
    let maxActive = 0;
    const slowDecrypt = async (): Promise<string> => {
      active++;
      maxActive = Math.max(maxActive, active);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      active--;
      return encodeMessagePayload({ type: "TEXT", text: "hi" });
    };

    // Two messengers on the same account = two browser tabs sharing one IndexedDB.
    const tabA = new SecureMessenger({
      userId,
      sessions: { encrypt: async () => ({ type: 1 as const, body: "AAEC" }), decrypt: slowDecrypt },
      messages: newStore(userId),
      send: () => {},
    });
    const tabB = new SecureMessenger({
      userId,
      sessions: { encrypt: async () => ({ type: 1 as const, body: "AAEC" }), decrypt: slowDecrypt },
      messages: newStore(userId),
      send: () => {},
    });

    await Promise.all([
      tabA.onServerFrame(incoming(crypto.randomUUID(), peerId, conversationId)),
      tabB.onServerFrame(incoming(crypto.randomUUID(), peerId, conversationId)),
    ]);

    expect(maxActive).toBe(1);
    expect(lockNames).toContain(`nullspace-peer-${userId}-${peerId}`);
  });

  it("does not overwrite a message stored by another tab when this tab's decrypt fails", async () => {
    const userId = crypto.randomUUID();
    const peerId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const messageId = crypto.randomUUID();

    const otherTabStore = newStore(userId);
    const thisTabStore = newStore(userId);
    const plaintext = encodeMessagePayload({ type: "TEXT", text: "stored by the other tab" });

    const messenger = new SecureMessenger({
      userId,
      sessions: {
        encrypt: async () => ({ type: 1 as const, body: "AAEC" }),
        // The other tab wins the race and stores the message, then this tab's decrypt fails
        // because the ratchet state has already moved on.
        decrypt: async () => {
          await otherTabStore.putMessage({
            id: messageId,
            conversationId,
            senderId: peerId,
            createdAt: "2026-11-19T10:00:00.000Z",
            status: "DELIVERED",
            currentVersion: 1,
          });
          await otherTabStore.addVersion({
            messageId,
            versionNo: 1,
            plaintext,
            action: "CREATE",
            createdAt: "2026-11-19T10:00:00.000Z",
          });
          throw new Error("ratchet state changed by another tab");
        },
      },
      messages: thisTabStore,
      send: () => {},
    });

    const failures: unknown[] = [];
    messenger.on("decryptFailed", (d) => {
      failures.push(d);
    });

    await messenger.onServerFrame(incoming(messageId, peerId, conversationId));

    const record = await thisTabStore.getMessage(messageId);
    expect(record).toBeDefined();
    expect(record?.decryptFailed).not.toBe(true);
    const versions = await thisTabStore.getVersions(messageId);
    expect(versions).toHaveLength(1);
    expect(versions[0].plaintext).toBe(plaintext);
    expect(failures).toHaveLength(0);
  });
});
