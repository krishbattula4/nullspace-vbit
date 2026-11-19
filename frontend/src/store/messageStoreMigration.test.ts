import { afterEach, describe, expect, it } from "vitest";
import { openDB } from "idb";
import {
  MessageStore,
  type MessageRecord,
  type VersionRecord,
  type ConversationMetaRecord,
  type FailedEnvelopeRecord,
} from "./messageStore";

describe("MessageStore Schema Migration & FailedEnvelope CRUD", () => {
  const storesToClean: MessageStore[] = [];

  function createUserId(): string {
    return crypto.randomUUID();
  }

  function getStore(userId: string): MessageStore {
    const s = new MessageStore(userId);
    storesToClean.push(s);
    return s;
  }

  afterEach(async () => {
    while (storesToClean.length > 0) {
      const s = storesToClean.pop();
      if (s) {
        await s.wipe();
      }
    }
  });

  it("m. Migration: opens a version 1 database, upgrades to version 2, keeps old data and enables failedEnvelopes", async () => {
    const userId = createUserId();
    const dbName = `nullspace-messages-${userId}`;

    // 1. Create a version 1 database by hand with idb
    const v1Db = await openDB(dbName, 1, {
      upgrade(database) {
        const msgStore = database.createObjectStore("messages", {
          keyPath: "id",
        });
        msgStore.createIndex("byConversationTime", [
          "conversationId",
          "createdAt",
          "id",
        ]);
        msgStore.createIndex("byClientMsgId", "clientMsgId", {
          unique: true,
        });

        const verStore = database.createObjectStore("versions", {
          keyPath: ["messageId", "versionNo"],
        });
        verStore.createIndex("byMessage", "messageId");

        database.createObjectStore("meta", {
          keyPath: "conversationId",
        });
      },
    });

    const conversationId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const oldMsg: MessageRecord = {
      id: messageId,
      conversationId,
      senderId: userId,
      createdAt: "2026-11-19T10:00:00.000Z",
      status: "SENT",
      currentVersion: 2,
    };
    const v1: VersionRecord = {
      messageId,
      versionNo: 1,
      plaintext: "first draft",
      action: "CREATE",
      createdAt: "2026-11-19T10:00:00.000Z",
    };
    const v2: VersionRecord = {
      messageId,
      versionNo: 2,
      plaintext: "edited message",
      action: "EDIT",
      createdAt: "2026-11-19T10:01:00.000Z",
    };
    const meta: ConversationMetaRecord = {
      conversationId,
      oldest: { createdAt: "2026-11-19T10:00:00.000Z", id: messageId },
      historyComplete: true,
    };

    // Insert records into version 1 DB
    await v1Db.put("messages", oldMsg);
    await v1Db.put("versions", v1);
    await v1Db.put("versions", v2);
    await v1Db.put("meta", meta);
    v1Db.close();

    // 2. Open with the new MessageStore (which triggers upgrade to version 2)
    const store = getStore(userId);

    // Verify all old data is intact
    const loadedMsg = await store.getMessage(messageId);
    expect(loadedMsg).toEqual(oldMsg);

    const versions = await store.getVersions(messageId);
    expect(versions).toHaveLength(2);
    expect(versions).toEqual(expect.arrayContaining([v1, v2]));

    const loadedMeta = await store.getHistoryState(conversationId);
    expect(loadedMeta).toEqual(meta);

    // Verify new failedEnvelopes methods work on upgraded DB
    const failedEnv: FailedEnvelopeRecord = {
      messageId: crypto.randomUUID(),
      conversationId,
      senderId: crypto.randomUUID(),
      ctype: 1,
      body: "AQIDBA==",
      receivedAt: "2026-11-19T10:05:00.000Z",
      attempts: 1,
      lastErrorCode: "bad_mac",
    };
    await store.saveFailedEnvelope(failedEnv);
    const retrieved = await store.getFailedEnvelope(failedEnv.messageId);
    expect(retrieved).toEqual(failedEnv);
  });

  it("n. Failed envelope CRUD: save, get, list with filters and ordering, increment attempts, delete", async () => {
    const userId = createUserId();
    const store = getStore(userId);

    const convA = crypto.randomUUID();
    const convB = crypto.randomUUID();
    const senderX = crypto.randomUUID();
    const senderY = crypto.randomUUID();

    const env1: FailedEnvelopeRecord = {
      messageId: "msg-002",
      conversationId: convA,
      senderId: senderX,
      ctype: 1,
      body: "Ym9keTI=",
      receivedAt: "2026-11-19T12:00:00.000Z",
      attempts: 1,
      lastErrorCode: "unknown",
    };
    const env2: FailedEnvelopeRecord = {
      messageId: "msg-001",
      conversationId: convA,
      senderId: senderX,
      ctype: 3,
      body: "Ym9keTE=",
      receivedAt: "2026-11-19T11:00:00.000Z",
      attempts: 1,
      lastErrorCode: "no_session",
    };
    const env3: FailedEnvelopeRecord = {
      messageId: "msg-003",
      conversationId: convB,
      senderId: senderY,
      ctype: 1,
      body: "Ym9keTM=",
      receivedAt: "2026-11-19T11:00:00.000Z",
      attempts: 2,
      lastErrorCode: "bad_mac",
    };

    // Save
    await store.saveFailedEnvelope(env1);
    await store.saveFailedEnvelope(env2);
    await store.saveFailedEnvelope(env3);

    // Get
    const get1 = await store.getFailedEnvelope("msg-001");
    expect(get1).toEqual(env2);
    const getMissing = await store.getFailedEnvelope("msg-999");
    expect(getMissing).toBeUndefined();

    // List all: sorted by receivedAt ascending then messageId
    // env2 (11:00, "msg-001") vs env3 (11:00, "msg-003") -> env2 then env3
    // env1 (12:00, "msg-002") -> env1
    const all = await store.listFailedEnvelopes();
    expect(all.map((e) => e.messageId)).toEqual(["msg-001", "msg-003", "msg-002"]);

    // Filter by senderId
    const senderXList = await store.listFailedEnvelopes({ senderId: senderX });
    expect(senderXList.map((e) => e.messageId)).toEqual(["msg-001", "msg-002"]);

    // Filter by conversationId
    const convBList = await store.listFailedEnvelopes({ conversationId: convB });
    expect(convBList.map((e) => e.messageId)).toEqual(["msg-003"]);

    // Filter by both
    const bothFilter = await store.listFailedEnvelopes({
      senderId: senderX,
      conversationId: convA,
    });
    expect(bothFilter.map((e) => e.messageId)).toEqual(["msg-001", "msg-002"]);

    // Increment attempts
    await store.incrementFailedAttempts("msg-001", "storage");
    const updated1 = await store.getFailedEnvelope("msg-001");
    expect(updated1?.attempts).toBe(2);
    expect(updated1?.lastErrorCode).toBe("storage");

    // Delete
    await store.deleteFailedEnvelope("msg-001");
    const afterDelete = await store.getFailedEnvelope("msg-001");
    expect(afterDelete).toBeUndefined();

    const remaining = await store.listFailedEnvelopes();
    expect(remaining.map((e) => e.messageId)).toEqual(["msg-003", "msg-002"]);

    // markDeleted removes the failed envelope as well
    await store.markDeleted("msg-003");
    const afterMarkDeleted = await store.getFailedEnvelope("msg-003");
    expect(afterMarkDeleted).toBeUndefined();
    const finalRemaining = await store.listFailedEnvelopes();
    expect(finalRemaining.map((e) => e.messageId)).toEqual(["msg-002"]);
  });
});
