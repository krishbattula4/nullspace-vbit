import { afterEach, describe, expect, it } from "vitest";
import {
  MessageStore,
  type MessageRecord,
  type VersionRecord,
} from "./messageStore";

describe("MessageStore (TASK P3.7: local message store)", () => {
  const testStores: MessageStore[] = [];

  const createStore = (userIdPrefix: string): MessageStore => {
    const uniqueId = `${userIdPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const store = new MessageStore(uniqueId);
    testStores.push(store);
    return store;
  };

  afterEach(async () => {
    while (testStores.length > 0) {
      const store = testStores.pop();
      if (store) {
        await store.wipe();
      }
    }
  });

  it("a. Persistence: write a message with 2 versions, close, open a NEW MessageStore with the same userId, and read everything back", async () => {
    const userId = `persist-user-${Date.now()}`;
    const store1 = new MessageStore(userId);
    testStores.push(store1);

    const msg: MessageRecord = {
      id: "msg-persist-1",
      conversationId: "conv-persist",
      senderId: "alice",
      createdAt: "2026-03-01T10:00:00.000Z",
      status: "SENT",
      currentVersion: 2,
    };
    await store1.putMessage(msg);

    const v1: VersionRecord = {
      messageId: "msg-persist-1",
      versionNo: 1,
      plaintext: "Original text",
      action: "CREATE",
      createdAt: "2026-03-01T10:00:00.000Z",
    };
    const v2: VersionRecord = {
      messageId: "msg-persist-1",
      versionNo: 2,
      plaintext: "Edited text",
      action: "EDIT",
      createdAt: "2026-03-01T10:05:00.000Z",
    };
    await store1.addVersion(v1);
    await store1.addVersion(v2);

    store1.close();

    // Open a new store with the exact same userId
    const store2 = new MessageStore(userId);
    testStores.push(store2);

    const loadedMsg = await store2.getMessage("msg-persist-1");
    expect(loadedMsg).toBeDefined();
    expect(loadedMsg).toEqual(msg);

    const loadedVersions = await store2.getVersions("msg-persist-1");
    expect(loadedVersions).toHaveLength(2);
    expect(loadedVersions[0]).toEqual(v1);
    expect(loadedVersions[1]).toEqual(v2);
  });

  it("b. wipe() then a new store with the same userId is empty; wiping twice does not throw", async () => {
    const userId = `wipe-user-${Date.now()}`;
    const store = new MessageStore(userId);
    testStores.push(store);

    await store.putMessage({
      id: "msg-wipe-1",
      conversationId: "conv-wipe",
      senderId: "bob",
      createdAt: "2026-03-01T12:00:00.000Z",
      status: "SENT",
      currentVersion: 1,
    });
    await store.addVersion({
      messageId: "msg-wipe-1",
      versionNo: 1,
      plaintext: "Soon to be wiped",
      action: "CREATE",
      createdAt: "2026-03-01T12:00:00.000Z",
    });
    await store.setHistoryState("conv-wipe", {
      oldest: { createdAt: "2026-03-01T12:00:00.000Z", id: "msg-wipe-1" },
      historyComplete: true,
    });

    // Wipe once
    await store.wipe();

    // Wiping twice does not throw
    await expect(store.wipe()).resolves.toBeUndefined();

    // A new store with the same userId is completely empty
    const freshStore = new MessageStore(userId);
    testStores.push(freshStore);

    expect(await freshStore.getMessage("msg-wipe-1")).toBeUndefined();
    expect(await freshStore.getVersions("msg-wipe-1")).toEqual([]);
    expect(await freshStore.getHistoryState("conv-wipe")).toBeUndefined();
    expect(await freshStore.countMessages("conv-wipe")).toBe(0);
  });

  it("c. A different userId never sees the first user's data", async () => {
    const storeAlice = createStore("alice");
    const storeBob = createStore("bob");

    await storeAlice.putMessage({
      id: "msg-alice-secret",
      conversationId: "conv-alice",
      senderId: "alice",
      createdAt: "2026-03-01T14:00:00.000Z",
      status: "SENT",
      currentVersion: 1,
    });
    await storeAlice.addVersion({
      messageId: "msg-alice-secret",
      versionNo: 1,
      plaintext: "Alice private data",
      action: "CREATE",
      createdAt: "2026-03-01T14:00:00.000Z",
    });
    await storeAlice.setHistoryState("conv-alice", {
      oldest: null,
      historyComplete: false,
    });

    // Bob should see none of Alice's data
    expect(await storeBob.getMessage("msg-alice-secret")).toBeUndefined();
    expect(await storeBob.getVersions("msg-alice-secret")).toEqual([]);
    expect(await storeBob.getHistoryState("conv-alice")).toBeUndefined();
    expect(await storeBob.countMessages("conv-alice")).toBe(0);
  });

  it("d. addVersion twice with the same number returns true then false and keeps the FIRST text; 50 parallel addVersion calls for the same key result in exactly one record", async () => {
    const store = createStore("add-version-idempotency");

    // First call: returns true
    const res1 = await store.addVersion({
      messageId: "msg-d1",
      versionNo: 1,
      plaintext: "First text",
      action: "CREATE",
      createdAt: "2026-03-01T15:00:00.000Z",
    });
    expect(res1).toBe(true);

    // Second call with same versionNo but different text: returns false
    const res2 = await store.addVersion({
      messageId: "msg-d1",
      versionNo: 1,
      plaintext: "Second text (should be ignored)",
      action: "CREATE",
      createdAt: "2026-03-01T15:01:00.000Z",
    });
    expect(res2).toBe(false);

    // Assert it keeps the FIRST text
    const versionsD1 = await store.getVersions("msg-d1");
    expect(versionsD1).toHaveLength(1);
    expect(versionsD1[0].plaintext).toBe("First text");

    // 50 parallel addVersion calls for the same key
    const parallelResults = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        store.addVersion({
          messageId: "msg-d2",
          versionNo: 1,
          plaintext: `Parallel attempt ${i}`,
          action: "CREATE",
          createdAt: "2026-03-01T15:10:00.000Z",
        }),
      ),
    );

    const trueCount = parallelResults.filter((r) => r === true).length;
    const falseCount = parallelResults.filter((r) => r === false).length;
    expect(trueCount).toBe(1);
    expect(falseCount).toBe(49);

    const versionsD2 = await store.getVersions("msg-d2");
    expect(versionsD2).toHaveLength(1);
  });

  it("e. getVersions is ordered by versionNo even when versions were added 3, 1, 2; currentVersion equals the maximum", async () => {
    const store = createStore("version-order");

    await store.putMessage({
      id: "msg-e",
      conversationId: "conv-e",
      senderId: "alice",
      createdAt: "2026-03-01T16:00:00.000Z",
      status: "SENT",
      currentVersion: 1,
    });

    // Add versions out of order: 3, 1, 2
    await store.addVersion({
      messageId: "msg-e",
      versionNo: 3,
      plaintext: "Version 3",
      action: "EDIT",
      createdAt: "2026-03-01T16:15:00.000Z",
    });
    await store.addVersion({
      messageId: "msg-e",
      versionNo: 1,
      plaintext: "Version 1",
      action: "CREATE",
      createdAt: "2026-03-01T16:00:00.000Z",
    });
    await store.addVersion({
      messageId: "msg-e",
      versionNo: 2,
      plaintext: "Version 2",
      action: "EDIT",
      createdAt: "2026-03-01T16:10:00.000Z",
    });

    // getVersions is ordered by versionNo ascending
    const versions = await store.getVersions("msg-e");
    expect(versions).toHaveLength(3);
    expect(versions.map((v) => v.versionNo)).toEqual([1, 2, 3]);
    expect(versions[0].plaintext).toBe("Version 1");
    expect(versions[1].plaintext).toBe("Version 2");
    expect(versions[2].plaintext).toBe("Version 3");

    // Message currentVersion equals the maximum versionNo
    const msg = await store.getMessage("msg-e");
    expect(msg).toBeDefined();
    expect(msg?.currentVersion).toBe(3);
  });

  it("f. listMessages: insert 120 messages (include 10 with identical createdAt), page with limit 50 using `before` = the last item of the previous page, and assert 3 pages, 120 unique ids, strictly newest-first order, no gaps", async () => {
    const store = createStore("pagination");
    const conversationId = "conv-f";
    const total = 120;
    const identicalTime = "2026-06-01T12:00:00.000Z";

    // Insert 120 messages, 10 of which have identical createdAt
    for (let i = 0; i < total; i++) {
      let createdAt: string;
      if (i >= 50 && i < 60) {
        createdAt = identicalTime;
      } else {
        const d = new Date(Date.UTC(2026, 0, 1, 0, i, 0));
        createdAt = d.toISOString();
      }
      const id = `msg-${String(i).padStart(4, "0")}`;
      await store.putMessage({
        id,
        conversationId,
        senderId: "user-f",
        createdAt,
        status: "SENT",
        currentVersion: 1,
      });
    }

    // Page 1: limit 50, newest first
    const page1 = await store.listMessages(conversationId, { limit: 50 });
    expect(page1).toHaveLength(50);

    // Page 2: before last item of page 1
    const lastP1 = page1[page1.length - 1];
    const page2 = await store.listMessages(conversationId, {
      before: { createdAt: lastP1.createdAt, id: lastP1.id },
      limit: 50,
    });
    expect(page2).toHaveLength(50);

    // Page 3: before last item of page 2
    const lastP2 = page2[page2.length - 1];
    const page3 = await store.listMessages(conversationId, {
      before: { createdAt: lastP2.createdAt, id: lastP2.id },
      limit: 50,
    });
    expect(page3).toHaveLength(20);

    const allRetrieved = [...page1, ...page2, ...page3];
    expect(allRetrieved).toHaveLength(120);

    // Assert 120 unique ids (no gaps, no duplicates)
    const uniqueIds = new Set(allRetrieved.map((m) => m.id));
    expect(uniqueIds.size).toBe(120);

    // Assert strictly newest-first order
    for (let i = 0; i < allRetrieved.length - 1; i++) {
      const a = allRetrieved[i];
      const b = allRetrieved[i + 1];
      const isNewer =
        a.createdAt > b.createdAt ||
        (a.createdAt === b.createdAt && a.id > b.id);
      expect(isNewer).toBe(true);
    }
  });

  it("g. listMessages only returns the requested conversation", async () => {
    const store = createStore("conv-isolation");

    await store.putMessage({
      id: "msg-c1-1",
      conversationId: "conv-1",
      senderId: "alice",
      createdAt: "2026-03-01T10:00:00.000Z",
      status: "SENT",
      currentVersion: 1,
    });
    await store.putMessage({
      id: "msg-c2-1",
      conversationId: "conv-2",
      senderId: "bob",
      createdAt: "2026-03-01T10:01:00.000Z",
      status: "SENT",
      currentVersion: 1,
    });
    await store.putMessage({
      id: "msg-c1-2",
      conversationId: "conv-1",
      senderId: "alice",
      createdAt: "2026-03-01T10:02:00.000Z",
      status: "SENT",
      currentVersion: 1,
    });

    const c1Messages = await store.listMessages("conv-1");
    expect(c1Messages).toHaveLength(2);
    expect(c1Messages.map((m) => m.id)).toEqual(["msg-c1-2", "msg-c1-1"]);

    const c2Messages = await store.listMessages("conv-2");
    expect(c2Messages).toHaveLength(1);
    expect(c2Messages[0].id).toBe("msg-c2-1");
  });

  it("h. setStatus never moves backward (READ then SENT stays READ); FAILED only from SENDING; unknown id resolves safely without creating a record", async () => {
    const store = createStore("status-transitions");

    await store.putMessage({
      id: "msg-h1",
      conversationId: "conv-h",
      senderId: "alice",
      createdAt: "2026-03-01T11:00:00.000Z",
      status: "SENDING",
      currentVersion: 1,
    });

    // Forward progression: SENDING < SENT < QUEUED < DELIVERED < READ
    expect(await store.setStatus("msg-h1", "SENT")).toBe("SENT");
    expect(await store.setStatus("msg-h1", "QUEUED")).toBe("QUEUED");
    expect(await store.setStatus("msg-h1", "DELIVERED")).toBe("DELIVERED");
    expect(await store.setStatus("msg-h1", "READ")).toBe("READ");

    // Backward transition attempt (READ then SENT stays READ)
    expect(await store.setStatus("msg-h1", "SENT")).toBe("READ");
    expect((await store.getMessage("msg-h1"))?.status).toBe("READ");

    // FAILED from READ is rejected (stays READ)
    expect(await store.setStatus("msg-h1", "FAILED")).toBe("READ");
    expect((await store.getMessage("msg-h1"))?.status).toBe("READ");

    // FAILED from SENT is rejected
    await store.putMessage({
      id: "msg-h2",
      conversationId: "conv-h",
      senderId: "alice",
      createdAt: "2026-03-01T11:05:00.000Z",
      status: "SENT",
      currentVersion: 1,
    });
    expect(await store.setStatus("msg-h2", "FAILED")).toBe("SENT");
    expect((await store.getMessage("msg-h2"))?.status).toBe("SENT");

    // FAILED is only allowed from SENDING
    await store.putMessage({
      id: "msg-h3",
      conversationId: "conv-h",
      senderId: "alice",
      createdAt: "2026-03-01T11:10:00.000Z",
      status: "SENDING",
      currentVersion: 1,
    });
    expect(await store.setStatus("msg-h3", "FAILED")).toBe("FAILED");
    expect((await store.getMessage("msg-h3"))?.status).toBe("FAILED");

    // Unknown id resolves safely without creating a record
    const unknownRes = await store.setStatus("non-existent-id", "SENT");
    expect(unknownRes).toBeUndefined();
    expect(await store.getMessage("non-existent-id")).toBeUndefined();
  });

  it("i. confirmSent rekeys the record and its versions in one step, is idempotent, and merges when the real id already exists; getMessage(tempId) is undefined afterwards", async () => {
    const store = createStore("confirm-sent");
    const clientMsgId = "client-temp-123";
    const serverMsgId = "server-real-456";

    // 1. Rekeying temporary record & versions
    await store.putMessage({
      id: clientMsgId,
      clientMsgId,
      conversationId: "conv-i",
      senderId: "alice",
      createdAt: "2026-03-01T12:00:00.000Z",
      status: "SENDING",
      currentVersion: 2,
    });
    await store.addVersion({
      messageId: clientMsgId,
      versionNo: 1,
      plaintext: "Draft 1",
      action: "CREATE",
      createdAt: "2026-03-01T12:00:00.000Z",
    });
    await store.addVersion({
      messageId: clientMsgId,
      versionNo: 2,
      plaintext: "Draft 2",
      action: "EDIT",
      createdAt: "2026-03-01T12:01:00.000Z",
    });

    await store.confirmSent(clientMsgId, {
      messageId: serverMsgId,
      status: "SENT",
      createdAt: "2026-03-01T12:00:02.000Z",
    });

    // getMessage(tempId) is undefined afterwards
    expect(await store.getMessage(clientMsgId)).toBeUndefined();
    expect(await store.getVersions(clientMsgId)).toEqual([]);

    // Real message exists with rekeyed properties and moved versions
    const realMsg = await store.getMessage(serverMsgId);
    expect(realMsg).toBeDefined();
    expect(realMsg?.id).toBe(serverMsgId);
    expect(realMsg?.clientMsgId).toBe(clientMsgId);
    expect(realMsg?.status).toBe("SENT");
    expect(realMsg?.createdAt).toBe("2026-03-01T12:00:02.000Z");

    const realVersions = await store.getVersions(serverMsgId);
    expect(realVersions).toHaveLength(2);
    expect(realVersions[0].messageId).toBe(serverMsgId);
    expect(realVersions[0].plaintext).toBe("Draft 1");
    expect(realVersions[1].messageId).toBe(serverMsgId);
    expect(realVersions[1].plaintext).toBe("Draft 2");

    // 2. Idempotent: calling it twice is harmless
    await expect(
      store.confirmSent(clientMsgId, {
        messageId: serverMsgId,
        status: "SENT",
      }),
    ).resolves.toBeUndefined();
    expect(await store.getMessage(clientMsgId)).toBeUndefined();
    expect(await store.getMessage(serverMsgId)).toBeDefined();

    // 3. Merging when real ID already exists (incoming message arrived first)
    const clientMsgId2 = "client-temp-999";
    const serverMsgId2 = "server-real-999";

    await store.putMessage({
      id: clientMsgId2,
      clientMsgId: clientMsgId2,
      conversationId: "conv-i",
      senderId: "alice",
      createdAt: "2026-03-01T13:00:00.000Z",
      status: "SENDING",
      currentVersion: 1,
    });
    await store.addVersion({
      messageId: clientMsgId2,
      versionNo: 1,
      plaintext: "Message from sender",
      action: "CREATE",
      createdAt: "2026-03-01T13:00:00.000Z",
    });

    // Simulated early arrival of server message (status already DELIVERED)
    await store.putMessage({
      id: serverMsgId2,
      conversationId: "conv-i",
      senderId: "alice",
      createdAt: "2026-03-01T13:00:01.000Z",
      status: "DELIVERED",
      currentVersion: 1,
    });

    await store.confirmSent(clientMsgId2, {
      messageId: serverMsgId2,
      status: "SENT",
    });

    expect(await store.getMessage(clientMsgId2)).toBeUndefined();
    const merged = await store.getMessage(serverMsgId2);
    expect(merged).toBeDefined();
    expect(merged?.clientMsgId).toBe(clientMsgId2);
    expect(merged?.status).toBe("DELIVERED"); // not downgraded to SENT
    const mergedVersions = await store.getVersions(serverMsgId2);
    expect(mergedVersions).toHaveLength(1);
    expect(mergedVersions[0].plaintext).toBe("Message from sender");
  });

  it("j. markDeleted erases every version's plaintext, keeps the rows and sets deletedAt/deletedBy; getVersions shows plaintext \"\" for all; calling it twice is fine", async () => {
    const store = createStore("mark-deleted");
    const msgId = "msg-to-delete";

    await store.putMessage({
      id: msgId,
      conversationId: "conv-j",
      senderId: "alice",
      createdAt: "2026-03-01T14:00:00.000Z",
      status: "SENT",
      currentVersion: 2,
    });
    await store.addVersion({
      messageId: msgId,
      versionNo: 1,
      plaintext: "Original confidential text",
      action: "CREATE",
      createdAt: "2026-03-01T14:00:00.000Z",
    });
    await store.addVersion({
      messageId: msgId,
      versionNo: 2,
      plaintext: "Edited confidential text",
      action: "EDIT",
      createdAt: "2026-03-01T14:05:00.000Z",
    });

    await store.markDeleted(msgId, {
      at: "2026-03-01T14:10:00.000Z",
      by: "alice",
    });

    const msg = await store.getMessage(msgId);
    expect(msg).toBeDefined();
    expect(msg?.deletedAt).toBe("2026-03-01T14:10:00.000Z");
    expect(msg?.deletedBy).toBe("alice");

    // All versions remain, but plaintext is erased to ""
    const versions = await store.getVersions(msgId);
    expect(versions).toHaveLength(2);
    expect(versions[0].plaintext).toBe("");
    expect(versions[0].versionNo).toBe(1);
    expect(versions[1].plaintext).toBe("");
    expect(versions[1].versionNo).toBe(2);

    // Calling it twice is fine (idempotent)
    await expect(
      store.markDeleted(msgId, {
        at: "2026-03-01T14:10:00.000Z",
        by: "alice",
      }),
    ).resolves.toBeUndefined();
    const msgAfter = await store.getMessage(msgId);
    expect(msgAfter?.deletedAt).toBe("2026-03-01T14:10:00.000Z");
  });

  it("n. A version that arrives after the message was deleted is stored with empty plaintext (text never comes back)", async () => {
    const store = createStore("late-version");
    const msgId = "msg-deleted-then-late-version";

    await store.putMessage({
      id: msgId,
      conversationId: "conv-n",
      senderId: "alice",
      createdAt: "2026-03-02T09:00:00.000Z",
      status: "SENT",
      currentVersion: 1,
    });
    await store.addVersion({
      messageId: msgId,
      versionNo: 1,
      plaintext: "secret one",
      action: "CREATE",
      createdAt: "2026-03-02T09:00:00.000Z",
    });
    await store.markDeleted(msgId, { at: "2026-03-02T09:01:00.000Z", by: "alice" });

    // an EDIT frame that was in flight arrives after the delete
    const inserted = await store.addVersion({
      messageId: msgId,
      versionNo: 2,
      plaintext: "secret two (late)",
      action: "EDIT",
      createdAt: "2026-03-02T09:00:30.000Z",
    });
    expect(inserted).toBe(true);

    const versions = await store.getVersions(msgId);
    expect(versions.map((v) => v.versionNo)).toEqual([1, 2]);
    expect(versions.every((v) => v.plaintext === "")).toBe(true);
    expect((await store.getMessage(msgId))?.currentVersion).toBe(2);
  });

  it("k. markRetracted keeps plaintext and sets retractedAt/retractedBy", async () => {
    const store = createStore("mark-retracted");
    const msgId = "msg-to-retract";

    await store.putMessage({
      id: msgId,
      conversationId: "conv-k",
      senderId: "bob",
      createdAt: "2026-03-01T15:00:00.000Z",
      status: "READ",
      currentVersion: 1,
    });
    await store.addVersion({
      messageId: msgId,
      versionNo: 1,
      plaintext: "Text that was read and is now retracted",
      action: "CREATE",
      createdAt: "2026-03-01T15:00:00.000Z",
    });

    await store.markRetracted(msgId, {
      at: "2026-03-01T15:30:00.000Z",
      by: "bob",
    });

    const msg = await store.getMessage(msgId);
    expect(msg).toBeDefined();
    expect(msg?.retractedAt).toBe("2026-03-01T15:30:00.000Z");
    expect(msg?.retractedBy).toBe("bob");

    // Plaintext is KEPT (retracted message can still be opened)
    const versions = await store.getVersions(msgId);
    expect(versions).toHaveLength(1);
    expect(versions[0].plaintext).toBe(
      "Text that was read and is now retracted",
    );
  });

  it("l. History state round trip; getLatestMessage and countMessages correct", async () => {
    const store = createStore("history-state");
    const convId = "conv-history-test";

    // History state round trip
    expect(await store.getHistoryState(convId)).toBeUndefined();
    const meta = {
      oldest: { createdAt: "2026-03-01T08:00:00.000Z", id: "msg-first" },
      historyComplete: true,
    };
    await store.setHistoryState(convId, meta);

    const loadedMeta = await store.getHistoryState(convId);
    expect(loadedMeta).toEqual({
      conversationId: convId,
      oldest: meta.oldest,
      historyComplete: meta.historyComplete,
    });

    // countMessages and getLatestMessage on empty conversation
    expect(await store.countMessages(convId)).toBe(0);
    expect(await store.getLatestMessage(convId)).toBeUndefined();

    // Insert 3 messages with chronological timestamps
    await store.putMessage({
      id: "msg-1",
      conversationId: convId,
      senderId: "alice",
      createdAt: "2026-03-01T08:00:00.000Z",
      status: "READ",
      currentVersion: 1,
    });
    await store.putMessage({
      id: "msg-2",
      conversationId: convId,
      senderId: "alice",
      createdAt: "2026-03-01T09:00:00.000Z",
      status: "READ",
      currentVersion: 1,
    });
    await store.putMessage({
      id: "msg-3",
      conversationId: convId,
      senderId: "alice",
      createdAt: "2026-03-01T10:00:00.000Z",
      status: "READ",
      currentVersion: 1,
    });

    expect(await store.countMessages(convId)).toBe(3);
    const latest = await store.getLatestMessage(convId);
    expect(latest).toBeDefined();
    expect(latest?.id).toBe("msg-3");
    expect(latest?.createdAt).toBe("2026-03-01T10:00:00.000Z");
  });

  it("m. A message whose text contains emoji, newlines and 10,000 characters round-trips exactly", async () => {
    const store = createStore("large-payload");
    const msgId = "msg-large";

    // Construct a rich string with emojis, symbols, newlines, and unicode
    const prefix = "🔐 Nullspace End-to-End Chat 💬\nLine 2: नमस्ते दुनिया 🌍\n🎉 Special chars: <>&\"'/\n\n";
    const chunk = "Repeated chunk with emoji 🚀 and text line.\n";
    let payload = prefix;
    while (payload.length < 10000) {
      payload += chunk;
    }
    // Trim to exactly 10,000 UTF-16 code units
    payload = payload.slice(0, 10000);
    expect(payload.length).toBe(10000);

    await store.putMessage({
      id: msgId,
      conversationId: "conv-m",
      senderId: "alice",
      createdAt: "2026-03-01T16:00:00.000Z",
      status: "SENT",
      currentVersion: 1,
    });

    await store.addVersion({
      messageId: msgId,
      versionNo: 1,
      plaintext: payload,
      action: "CREATE",
      createdAt: "2026-03-01T16:00:00.000Z",
    });

    const versions = await store.getVersions(msgId);
    expect(versions).toHaveLength(1);
    expect(versions[0].plaintext).toBe(payload);
    expect(versions[0].plaintext.length).toBe(10000);
  });

  it("markDecryptFailed updates decryptFailed flag on message record", async () => {
    const store = createStore("decrypt-failed");
    const msgId = "msg-decrypt-err";

    await store.putMessage({
      id: msgId,
      conversationId: "conv-decrypt",
      senderId: "bob",
      createdAt: "2026-03-01T17:00:00.000Z",
      status: "DELIVERED",
      currentVersion: 1,
    });

    await store.markDecryptFailed(msgId, true);
    expect((await store.getMessage(msgId))?.decryptFailed).toBe(true);

    await store.markDecryptFailed(msgId, false);
    expect((await store.getMessage(msgId))?.decryptFailed).toBe(false);
  });
});
