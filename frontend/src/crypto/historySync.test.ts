import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexedDBSignalStore } from "./IndexedDBSignalStore";
import { provisionKeys } from "./provision";
import { SessionManager } from "./session";
import { MessageStore } from "../store/messageStore";
import { SecureMessenger } from "./secureMessaging";
import { FakeKeyServer } from "../test/fakeKeyServer";
import { FakeHistoryServer } from "../test/fakeHistoryServer";
import { syncConversationHistory } from "./historySync";
import {
  encodeClientFrame,
  parseServerFrame,
  type ClientFrame,
  type ServerAckFrame,
  type ServerMessageFrame,
  type ServerEditFrame,
  type ServerDeleteFrame,
  type ServerRetractFrame,
} from "../lib/protocol";
import { decodeMessagePayload } from "./messagePayload";

class RelayMessageState {
  senderId = "";
  currentVersion = 1;
  readAt: string | null = null;
  deliveredAt: string | null = null;
}

class ExtendedRelay {
  public recordedFrames: string[] = [];
  public sentMessageIds: string[] = [];
  public users = new Map<string, SecureMessenger>();
  public conversationPeerMap = new Map<string, [string, string]>();
  public messageState = new Map<string, RelayMessageState>();
  public offlineUsers = new Set<string>();
  public server: FakeHistoryServer;

  constructor(server: FakeHistoryServer) {
    this.server = server;
  }

  registerUser(userId: string, messenger: SecureMessenger): void {
    this.users.set(userId, messenger);
  }

  registerConversation(conversationId: string, userA: string, userB: string): void {
    this.conversationPeerMap.set(conversationId, [userA, userB]);
  }

  getRecipientId(conversationId: string, senderId: string): string | undefined {
    const peers = this.conversationPeerMap.get(conversationId);
    if (!peers) return undefined;
    return peers[0] === senderId ? peers[1] : peers[0];
  }

  async markDelivered(messageId: string): Promise<void> {
    const state = this.messageState.get(messageId);
    if (!state) return;
    const now = new Date().toISOString();
    state.deliveredAt = now;
    this.server.markDelivered(messageId, now);

    const senderMessenger = this.users.get(state.senderId);
    if (senderMessenger) {
      await senderMessenger.onServerFrame({
        v: 1,
        type: "DELIVERED",
        message_id: messageId,
        delivered_at: now,
      });
    }
  }

  async markRead(messageId: string): Promise<void> {
    const state = this.messageState.get(messageId);
    if (!state) return;
    const now = new Date().toISOString();
    state.readAt = now;
    state.deliveredAt = state.deliveredAt ?? now;
    this.server.markRead(messageId, now);

    const senderMessenger = this.users.get(state.senderId);
    if (senderMessenger) {
      await senderMessenger.onServerFrame({
        v: 1,
        type: "DELIVERED",
        message_id: messageId,
        delivered_at: now,
      });
      await senderMessenger.onServerFrame({
        v: 1,
        type: "READ",
        message_id: messageId,
        read_at: now,
      });
    }
  }

  async handleSend(senderId: string, frame: ClientFrame): Promise<void> {
    const encoded = encodeClientFrame(frame);
    this.recordedFrames.push(encoded);

    if (frame.type === "MESSAGE") {
      const messageId = crypto.randomUUID();
      this.sentMessageIds.push(messageId);
      const createdAt = new Date().toISOString();
      const recipientId = this.getRecipientId(frame.conversation_id, senderId);

      const msgState = new RelayMessageState();
      msgState.senderId = senderId;
      this.messageState.set(messageId, msgState);

      // 1. Deliver ACK back to sender
      const ackRaw: ServerAckFrame = {
        v: 1,
        type: "ACK",
        client_msg_id: frame.client_msg_id,
        message_id: messageId,
        status: "SENT",
      };
      const ackParsed = parseServerFrame(JSON.stringify(ackRaw)) as ServerAckFrame;
      const senderMessenger = this.users.get(senderId);
      if (senderMessenger) {
        await senderMessenger.onServerFrame(ackParsed);
      }

      // 2. Mirror into FakeHistoryServer
      const serverMsgFrame: ServerMessageFrame = {
        v: 1,
        type: "MESSAGE",
        message_id: messageId,
        conversation_id: frame.conversation_id,
        sender_id: senderId,
        version_no: 1,
        created_at: createdAt,
        ctype: frame.ctype,
        body: frame.body,
      };
      this.server.addMessageFromFrame(serverMsgFrame, senderId, frame.conversation_id, frame.client_msg_id);

      // 3. Deliver to recipient if online
      if (recipientId && !this.offlineUsers.has(recipientId)) {
        const recipientMessenger = this.users.get(recipientId);
        if (recipientMessenger) {
          await recipientMessenger.onServerFrame(serverMsgFrame);
        }
      }
    } else if (frame.type === "EDIT") {
      const state = this.messageState.get(frame.message_id);
      if (state) {
        state.currentVersion++;
      }
      const editedAt = new Date().toISOString();
      const serverEditRaw: ServerEditFrame = {
        v: 1,
        type: "EDIT",
        message_id: frame.message_id,
        version_no: state ? state.currentVersion : 2,
        ctype: frame.ctype,
        body: frame.body,
        edited_at: editedAt,
      };
      const editParsed = parseServerFrame(JSON.stringify(serverEditRaw)) as ServerEditFrame;

      // Mirror into server
      this.server.addEditFromFrame(editParsed, senderId);

      // Deliver to peer if online
      for (const [uid, messenger] of this.users.entries()) {
        if (uid !== senderId && !this.offlineUsers.has(uid)) {
          await messenger.onServerFrame(editParsed);
        }
      }
    } else if (frame.type === "DELETE") {
      const serverDeleteRaw: ServerDeleteFrame = {
        v: 1,
        type: "DELETE",
        message_id: frame.message_id,
      };
      const deleteParsed = parseServerFrame(JSON.stringify(serverDeleteRaw)) as ServerDeleteFrame;

      this.server.deleteMessage(frame.message_id, senderId);

      // Deliver to both participants
      for (const [uid, messenger] of this.users.entries()) {
        if (!this.offlineUsers.has(uid)) {
          await messenger.onServerFrame(deleteParsed);
        }
      }
    } else if (frame.type === "RETRACT") {
      const serverRetractRaw: ServerRetractFrame = {
        v: 1,
        type: "RETRACT",
        message_id: frame.message_id,
      };
      const retractParsed = parseServerFrame(JSON.stringify(serverRetractRaw)) as ServerRetractFrame;

      this.server.retractMessage(frame.message_id, senderId);

      // Deliver to both participants
      for (const [uid, messenger] of this.users.entries()) {
        if (!this.offlineUsers.has(uid)) {
          await messenger.onServerFrame(retractParsed);
        }
      }
    }
  }
}

describe("TASK P5.7: History Reconciliation (Merge by Version Number After Being Offline)", () => {
  const signalStoresToClean: IndexedDBSignalStore[] = [];
  const storesToClean: MessageStore[] = [];
  const userIdsToClean = new Set<string>();

  function createUserId(): string {
    const id = crypto.randomUUID();
    userIdsToClean.add(id);
    return id;
  }

  async function setupTwoUsers() {
    const aliceId = createUserId();
    const bobId = createUserId();
    const conversationId = crypto.randomUUID();

    const aliceSignalStore = new IndexedDBSignalStore(aliceId);
    const bobSignalStore = new IndexedDBSignalStore(bobId);
    signalStoresToClean.push(aliceSignalStore, bobSignalStore);

    const aliceProv = await provisionKeys(aliceId, aliceSignalStore);
    const bobProv = await provisionKeys(bobId, bobSignalStore);

    const keyServer = new FakeKeyServer(aliceId);
    await keyServer.authFetch("/keys/bundle", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(aliceProv.bundle),
    });
    await keyServer.authFetch("/keys/bundle", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bobProv.bundle),
    });

    const aliceSessions = new SessionManager(aliceId, aliceSignalStore, keyServer);
    const bobSessions = new SessionManager(bobId, bobSignalStore, keyServer);

    const aliceMsgStore = new MessageStore(aliceId);
    const bobMsgStore = new MessageStore(bobId);
    storesToClean.push(aliceMsgStore, bobMsgStore);

    const historyServer = new FakeHistoryServer();
    const relay = new ExtendedRelay(historyServer);
    relay.registerConversation(conversationId, aliceId, bobId);

    const aliceMessenger = new SecureMessenger({
      userId: aliceId,
      sessions: aliceSessions,
      messages: aliceMsgStore,
      send: (frame) => relay.handleSend(aliceId, frame),
    });

    const bobMessenger = new SecureMessenger({
      userId: bobId,
      sessions: bobSessions,
      messages: bobMsgStore,
      send: (frame) => relay.handleSend(bobId, frame),
    });

    relay.registerUser(aliceId, aliceMessenger);
    relay.registerUser(bobId, bobMessenger);

    return {
      aliceId,
      bobId,
      conversationId,
      aliceSignalStore,
      bobSignalStore,
      aliceSessions,
      bobSessions,
      aliceMsgStore,
      bobMsgStore,
      historyServer,
      relay,
      aliceMessenger,
      bobMessenger,
    };
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    while (storesToClean.length > 0) {
      const s = storesToClean.pop();
      if (s) await s.wipe();
    }
    while (signalStoresToClean.length > 0) {
      const s = signalStoresToClean.pop();
      if (s) await s.wipe();
    }
  });

  it("a. Offline edits: bob is offline; alice sends m1 and edits twice; bob syncs; versions 1,2,3 with right texts, currentVersion 3, decrypt called exactly 3 times", async () => {
    const { aliceMessenger, bobMessenger, bobMsgStore, bobSessions, conversationId, bobId, aliceId, relay, historyServer } =
      await setupTwoUsers();

    // Bob goes offline
    relay.offlineUsers.add(bobId);

    // Alice sends initial message and edits twice
    await aliceMessenger.sendText(conversationId, bobId, "v1 text");
    const m1Server = Array.from(historyServer.messages.values())[0];
    const m1Id = m1Server.id;

    await aliceMessenger.sendEdit(conversationId, bobId, m1Id, "v2 text");
    await aliceMessenger.sendEdit(conversationId, bobId, m1Id, "v3 text");

    // Bob has zero messages locally
    expect(await bobMsgStore.getMessage(m1Id)).toBeUndefined();

    // Counting spy on Bob's decrypt
    const decryptSpy = vi.spyOn(bobSessions, "decrypt");

    // Bob reconnects and syncs
    relay.offlineUsers.delete(bobId);
    const syncRes = await syncConversationHistory({
      messenger: bobMessenger,
      messages: bobMsgStore,
      conversationId,
      peerId: aliceId,
      authFetch: historyServer.authFetch,
    });

    expect(syncRes.status).toBe("ok");
    if (syncRes.status === "ok") {
      expect(syncRes.result.decrypted).toBe(3);
      expect(syncRes.result.failures).toBe(0);
    }
    expect(decryptSpy).toHaveBeenCalledTimes(3);

    const bobMsg = await bobMsgStore.getMessage(m1Id);
    expect(bobMsg).toBeDefined();
    expect(bobMsg?.currentVersion).toBe(3);

    const versions = await bobMsgStore.getVersions(m1Id);
    expect(versions).toHaveLength(3);
    expect(versions.map((v) => v.versionNo)).toEqual([1, 2, 3]);
    expect(decodeMessagePayload(versions[0].plaintext)).toEqual({ type: "TEXT", text: "v1 text" });
    expect(decodeMessagePayload(versions[1].plaintext)).toEqual({ type: "TEXT", text: "v2 text" });
    expect(decodeMessagePayload(versions[2].plaintext)).toEqual({ type: "TEXT", text: "v3 text" });
  });

  it("b. Never-seen messages interleaved with edits: 5 messages, m2 and m4 edited; after sync all present; next live message decrypts (ratchet healthy)", async () => {
    const { aliceMessenger, bobMessenger, bobMsgStore, conversationId, bobId, aliceId, relay, historyServer } =
      await setupTwoUsers();

    relay.offlineUsers.add(bobId);

    // Alice sends 5 messages
    await aliceMessenger.sendText(conversationId, bobId, "msg 1");
    await aliceMessenger.sendText(conversationId, bobId, "msg 2");
    await aliceMessenger.sendText(conversationId, bobId, "msg 3");
    await aliceMessenger.sendText(conversationId, bobId, "msg 4");
    await aliceMessenger.sendText(conversationId, bobId, "msg 5");

    const serverMsgs = Array.from(historyServer.messages.values()).sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    );
    expect(serverMsgs).toHaveLength(5);

    // Edit m2 and m4
    await aliceMessenger.sendEdit(conversationId, bobId, serverMsgs[1].id, "msg 2 edit");
    await aliceMessenger.sendEdit(conversationId, bobId, serverMsgs[3].id, "msg 4 edit");

    // Bob syncs
    relay.offlineUsers.delete(bobId);
    const syncRes = await syncConversationHistory({
      messenger: bobMessenger,
      messages: bobMsgStore,
      conversationId,
      peerId: aliceId,
      authFetch: historyServer.authFetch,
    });
    expect(syncRes.status).toBe("ok");

    // All 5 messages present locally
    const bobMsgs = await bobMsgStore.listMessages(conversationId);
    expect(bobMsgs).toHaveLength(5);

    const m2Versions = await bobMsgStore.getVersions(serverMsgs[1].id);
    expect(m2Versions).toHaveLength(2);
    expect(decodeMessagePayload(m2Versions[1].plaintext)).toEqual({ type: "TEXT", text: "msg 2 edit" });

    const m4Versions = await bobMsgStore.getVersions(serverMsgs[3].id);
    expect(m4Versions).toHaveLength(2);
    expect(decodeMessagePayload(m4Versions[1].plaintext)).toEqual({ type: "TEXT", text: "msg 4 edit" });

    // Live message arrives from Alice -> ratchet is healthy and decrypts!
    await aliceMessenger.sendText(conversationId, bobId, "msg 6 live");
    const m6 = await bobMsgStore.getLatestMessage(conversationId);
    expect(m6).toBeDefined();
    const m6Versions = await bobMsgStore.getVersions(m6!.id);
    expect(m6Versions).toHaveLength(1);
    expect(decodeMessagePayload(m6Versions[0].plaintext)).toEqual({ type: "TEXT", text: "msg 6 live" });
  });

  it("c. Deleted while offline: tombstone stored, decrypt never called; retracted while offline: original decrypted and retract applied", async () => {
    const { aliceMessenger, bobMessenger, bobMsgStore, bobSessions, conversationId, bobId, aliceId, relay, historyServer } =
      await setupTwoUsers();

    relay.offlineUsers.add(bobId);

    // Alice sends m1 and m2
    await aliceMessenger.sendText(conversationId, bobId, "to be deleted");
    await aliceMessenger.sendText(conversationId, bobId, "to be retracted");

    const serverMsgs = Array.from(historyServer.messages.values()).sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    );
    const m1Id = serverMsgs[0].id;
    const m2Id = serverMsgs[1].id;

    // Alice deletes m1 while Bob is offline
    await aliceMessenger.sendDelete(bobId, m1Id);

    // Alice retracts m2 while Bob is offline
    await relay.markRead(m2Id);
    await aliceMessenger.sendRetract(bobId, m2Id);

    const decryptSpy = vi.spyOn(bobSessions, "decrypt");

    relay.offlineUsers.delete(bobId);
    const syncRes = await syncConversationHistory({
      messenger: bobMessenger,
      messages: bobMsgStore,
      conversationId,
      peerId: aliceId,
      authFetch: historyServer.authFetch,
    });
    expect(syncRes.status).toBe("ok");

    // Decrypt was called for m2 only (NOT for deleted m1)
    expect(decryptSpy).toHaveBeenCalledTimes(1);

    // m1 is deleted tombstone
    const m1Local = await bobMsgStore.getMessage(m1Id);
    expect(m1Local).toBeDefined();
    expect(m1Local?.deletedAt).toBeDefined();
    expect(m1Local?.deletedBy).toBe(aliceId);
    expect(await bobMsgStore.getVersions(m1Id)).toHaveLength(0);

    // m2 is retracted but plaintexts kept
    const m2Local = await bobMsgStore.getMessage(m2Id);
    expect(m2Local).toBeDefined();
    expect(m2Local?.retractedAt).toBeDefined();
    const m2Versions = await bobMsgStore.getVersions(m2Id);
    expect(m2Versions).toHaveLength(1);
    expect(decodeMessagePayload(m2Versions[0].plaintext)).toEqual({ type: "TEXT", text: "to be retracted" });
  });

  it("d. Idempotent: second sync makes zero decrypt calls and store snapshot is identical", async () => {
    const { aliceMessenger, bobMessenger, bobMsgStore, bobSessions, conversationId, bobId, aliceId, relay, historyServer } =
      await setupTwoUsers();

    relay.offlineUsers.add(bobId);
    await aliceMessenger.sendText(conversationId, bobId, "idem 1");
    await aliceMessenger.sendText(conversationId, bobId, "idem 2");
    const m1Server = Array.from(historyServer.messages.values())[0];
    await aliceMessenger.sendEdit(conversationId, bobId, m1Server.id, "idem 1 edit");

    relay.offlineUsers.delete(bobId);
    // 1st sync
    await syncConversationHistory({
      messenger: bobMessenger,
      messages: bobMsgStore,
      conversationId,
      peerId: aliceId,
      authFetch: historyServer.authFetch,
    });

    const snapshot1Msgs = await bobMsgStore.listMessages(conversationId);
    const snapshot1M1Versions = await bobMsgStore.getVersions(m1Server.id);

    // 2nd sync
    const decryptSpy = vi.spyOn(bobSessions, "decrypt");
    const syncRes2 = await syncConversationHistory({
      messenger: bobMessenger,
      messages: bobMsgStore,
      conversationId,
      peerId: aliceId,
      authFetch: historyServer.authFetch,
    });

    expect(syncRes2.status).toBe("ok");
    if (syncRes2.status === "ok") {
      expect(syncRes2.result.decrypted).toBe(0);
      expect(syncRes2.result.failures).toBe(0);
      expect(syncRes2.result.tombstones).toBe(0);
      expect(syncRes2.result.retracted).toBe(0);
    }
    expect(decryptSpy).toHaveBeenCalledTimes(0);

    const snapshot2Msgs = await bobMsgStore.listMessages(conversationId);
    const snapshot2M1Versions = await bobMsgStore.getVersions(m1Server.id);

    expect(snapshot2Msgs).toEqual(snapshot1Msgs);
    expect(snapshot2M1Versions).toEqual(snapshot1M1Versions);
  });

  it("e. Partial knowledge: bob has v1 live; v2 and v3 arrive via sync; decrypt called 2 times. Gap: local has v1, v3; sync adds v2", async () => {
    const { aliceMessenger, bobMessenger, bobMsgStore, bobSessions, conversationId, bobId, aliceId, relay, historyServer } =
      await setupTwoUsers();

    // Alice sends initial message while Bob is online
    await aliceMessenger.sendText(conversationId, bobId, "v1 live");
    const m1Server = Array.from(historyServer.messages.values())[0];

    // Bob goes offline
    relay.offlineUsers.add(bobId);
    await aliceMessenger.sendEdit(conversationId, bobId, m1Server.id, "v2 sync");
    await aliceMessenger.sendEdit(conversationId, bobId, m1Server.id, "v3 sync");

    const decryptSpy = vi.spyOn(bobSessions, "decrypt");

    relay.offlineUsers.delete(bobId);
    const syncRes = await syncConversationHistory({
      messenger: bobMessenger,
      messages: bobMsgStore,
      conversationId,
      peerId: aliceId,
      authFetch: historyServer.authFetch,
    });
    expect(syncRes.status).toBe("ok");
    expect(decryptSpy).toHaveBeenCalledTimes(2); // Only v2 and v3 decrypted

    const versions = await bobMsgStore.getVersions(m1Server.id);
    expect(versions.map((v) => v.versionNo)).toEqual([1, 2, 3]);
  });

  it("f. Own messages after a data wipe: placeholder created with own_unavailable, decrypt never called, delete/retract applied", async () => {
    const {
      aliceMessenger,
      aliceMsgStore,
      bobId,
      aliceId,
      conversationId,
      aliceSessions,
      relay,
      historyServer,
    } = await setupTwoUsers();

    // Alice sends m1, m2, m3
    await aliceMessenger.sendText(conversationId, bobId, "alice m1");
    await aliceMessenger.sendText(conversationId, bobId, "alice m2");
    await aliceMessenger.sendText(conversationId, bobId, "alice m3");

    const m1Id = relay.sentMessageIds[0];
    const m2Id = relay.sentMessageIds[1];
    const m3Id = relay.sentMessageIds[2];

    // Alice deletes m2 and retracts m3 on server
    historyServer.deleteMessage(m2Id, aliceId);
    historyServer.markRead(m3Id);
    historyServer.retractMessage(m3Id, aliceId);

    // Simulate wipe: wipe Alice's store and create fresh MessageStore
    await aliceMsgStore.wipe();
    const freshAliceStore = new MessageStore(aliceId);
    storesToClean.push(freshAliceStore);

    const reloadedAliceMessenger = new SecureMessenger({
      userId: aliceId,
      sessions: aliceSessions,
      messages: freshAliceStore,
      send: (f) => relay.handleSend(aliceId, f),
    });

    const decryptSpy = vi.spyOn(aliceSessions, "decrypt");

    // Alice syncs
    const syncRes = await syncConversationHistory({
      messenger: reloadedAliceMessenger,
      messages: freshAliceStore,
      conversationId,
      peerId: bobId,
      authFetch: historyServer.authFetch,
    });

    expect(syncRes.status).toBe("ok");
    // Decrypt is NEVER called for own messages
    expect(decryptSpy).toHaveBeenCalledTimes(0);

    const msgs = await freshAliceStore.listMessages(conversationId);
    expect(msgs).toHaveLength(3);

    // m1 placeholder
    const m1 = await freshAliceStore.getMessage(m1Id);
    expect(m1?.decryptFailed).toBe(true);
    expect(m1?.decryptErrorCode).toBe("own_unavailable");

    // m2 deleted tombstone
    const m2 = await freshAliceStore.getMessage(m2Id);
    expect(m2?.deletedAt).toBeDefined();

    // m3 retracted
    const m3 = await freshAliceStore.getMessage(m3Id);
    expect(m3?.retractedAt).toBeDefined();
  });

  it("g. Lost ACK: local SENDING record whose clientMsgId matches server message is re-keyed to server id, confirmedSends: 1", async () => {
    const { aliceMessenger, bobId, aliceId, conversationId, aliceMsgStore, historyServer } =
      await setupTwoUsers();

    const clientMsgId = crypto.randomUUID();
    const serverMsgId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Alice has local unconfirmed record under clientMsgId
    await aliceMsgStore.putMessage({
      id: clientMsgId,
      clientMsgId,
      conversationId,
      senderId: aliceId,
      createdAt: now,
      status: "SENDING",
      currentVersion: 1,
    });
    await aliceMsgStore.addVersion({
      messageId: clientMsgId,
      versionNo: 1,
      plaintext: JSON.stringify({ type: "TEXT", text: "lost ack msg" }),
      action: "CREATE",
      createdAt: now,
    });

    // Server has recorded it with serverMsgId
    historyServer.addMessageFromFrame(
      {
        v: 1,
        type: "MESSAGE",
        message_id: serverMsgId,
        conversation_id: conversationId,
        sender_id: aliceId,
        version_no: 1,
        created_at: now,
        ctype: 1,
        body: "c2VjcmV0",
      },
      aliceId,
      conversationId,
      clientMsgId,
    );

    const syncRes = await syncConversationHistory({
      messenger: aliceMessenger,
      messages: aliceMsgStore,
      conversationId,
      peerId: bobId,
      authFetch: historyServer.authFetch,
    });

    expect(syncRes.status).toBe("ok");
    if (syncRes.status === "ok") {
      expect(syncRes.result.confirmedSends).toBe(1);
    }

    // Temporary record under clientMsgId was deleted
    expect(await aliceMsgStore.getMessage(clientMsgId)).toBeUndefined();

    // Real record exists under serverMsgId
    const confirmedMsg = await aliceMsgStore.getMessage(serverMsgId);
    expect(confirmedMsg).toBeDefined();
    expect(confirmedMsg?.clientMsgId).toBe(clientMsgId);
    expect(confirmedMsg?.status).toBe("SENT");

    // Version re-keyed
    const versions = await aliceMsgStore.getVersions(serverMsgId);
    expect(versions).toHaveLength(1);
    expect(versions[0].messageId).toBe(serverMsgId);
  });

  it("h. Status: readAt gives READ, deliveredAt gives DELIVERED on alice's messages; stale lower status does not downgrade", async () => {
    const { aliceMessenger, bobId, conversationId, aliceMsgStore, historyServer } =
      await setupTwoUsers();

    // Alice sends 2 messages
    await aliceMessenger.sendText(conversationId, bobId, "msg 1");
    await aliceMessenger.sendText(conversationId, bobId, "msg 2");

    const serverMsgs = Array.from(historyServer.messages.values()).sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    );
    const m1Id = serverMsgs[0].id;
    const m2Id = serverMsgs[1].id;

    historyServer.markDelivered(m1Id);
    historyServer.markRead(m2Id);

    const syncRes = await syncConversationHistory({
      messenger: aliceMessenger,
      messages: aliceMsgStore,
      conversationId,
      peerId: bobId,
      authFetch: historyServer.authFetch,
    });

    expect(syncRes.status).toBe("ok");
    expect((await aliceMsgStore.getMessage(m1Id))?.status).toBe("DELIVERED");
    expect((await aliceMsgStore.getMessage(m2Id))?.status).toBe("READ");

    // Repeat sync: status does not downgrade
    await syncConversationHistory({
      messenger: aliceMessenger,
      messages: aliceMsgStore,
      conversationId,
      peerId: bobId,
      authFetch: historyServer.authFetch,
    });
    expect((await aliceMsgStore.getMessage(m2Id))?.status).toBe("READ");
  });

  it("i. Paging: 120 messages, pageSize 50: keyset paging with before=<id>; routine maxPages 2 touches 100; concurrent sync calls share one set of requests", async () => {
    const conversationId = crypto.randomUUID();
    const aliceId = createUserId();
    const bobId = createUserId();
    const historyServer = new FakeHistoryServer();

    // Seed 120 messages on server
    for (let i = 0; i < 120; i++) {
      const msgId = crypto.randomUUID();
      const createdAt = new Date(Date.now() - (120 - i) * 1000).toISOString();
      historyServer.messages.set(msgId, {
        id: msgId,
        conversation_id: conversationId,
        sender_id: aliceId,
        client_msg_id: null,
        status: "DELIVERED",
        current_version: 1,
        created_at: createdAt,
        delivered_at: null,
        read_at: null,
        versions: [
          {
            id: crypto.randomUUID(),
            message_id: msgId,
            version_no: 1,
            ctype: 1,
            ciphertext: "c2VjcmV0",
            action: "CREATE",
            actor_id: aliceId,
            created_at: createdAt,
            erased_at: null,
          },
        ],
      });
    }

    const bobMsgStore = new MessageStore(bobId);
    storesToClean.push(bobMsgStore);

    // Fast fake messenger
    const mockMessenger = {
      reconcileHistory: vi.fn().mockResolvedValue({
        decrypted: 0,
        tombstones: 0,
        retracted: 0,
        statusUpdates: 0,
        failures: 0,
        confirmedSends: 0,
      }),
    } as unknown as SecureMessenger;

    // Routine sync (maxPages 2, pageSize 50) -> touches 100 messages in 2 pages
    historyServer.requestLog = [];
    const resRoutine = await syncConversationHistory({
      messenger: mockMessenger,
      messages: bobMsgStore,
      conversationId,
      peerId: aliceId,
      authFetch: historyServer.authFetch,
      pageSize: 50,
      maxPages: 2,
    });

    expect(resRoutine.status).toBe("ok");
    expect(historyServer.requestLog).toHaveLength(2);
    expect(historyServer.requestLog[0]).toContain("limit=50");
    expect(historyServer.requestLog[1]).toContain("&before=");

    // Full resync (fullResync: true) -> fetches all 120 messages in 3 pages (50 + 50 + 20)
    historyServer.requestLog = [];
    const resFull = await syncConversationHistory({
      messenger: mockMessenger,
      messages: bobMsgStore,
      conversationId,
      peerId: aliceId,
      authFetch: historyServer.authFetch,
      pageSize: 50,
      fullResync: true,
    });

    expect(resFull.status).toBe("ok");
    expect(historyServer.requestLog).toHaveLength(3);

    // Concurrent sync calls share one run (single flight)
    historyServer.requestLog = [];
    const [p1, p2] = await Promise.all([
      syncConversationHistory({
        messenger: mockMessenger,
        messages: bobMsgStore,
        conversationId,
        peerId: aliceId,
        authFetch: historyServer.authFetch,
        pageSize: 50,
      }),
      syncConversationHistory({
        messenger: mockMessenger,
        messages: bobMsgStore,
        conversationId,
        peerId: aliceId,
        authFetch: historyServer.authFetch,
        pageSize: 50,
      }),
    ]);

    expect(p1).toEqual(p2);
    // Request count reflects exactly one run, not two
    expect(historyServer.requestLog).toHaveLength(3);
  });

  it("j. Failures: network error, HTTP 500, invalid JSON and malformed page each return { status: 'skipped' } and change NOTHING in store", async () => {
    const { bobMessenger, bobMsgStore, conversationId, aliceId, historyServer } =
      await setupTwoUsers();

    // 1. Network error
    historyServer.failNetwork = true;
    const resNetwork = await syncConversationHistory({
      messenger: bobMessenger,
      messages: bobMsgStore,
      conversationId,
      peerId: aliceId,
      authFetch: historyServer.authFetch,
    });
    expect(resNetwork.status).toBe("skipped");
    expect(await bobMsgStore.listMessages(conversationId)).toHaveLength(0);
    historyServer.failNetwork = false;

    // 2. HTTP 500
    historyServer.failHttp500 = true;
    const res500 = await syncConversationHistory({
      messenger: bobMessenger,
      messages: bobMsgStore,
      conversationId,
      peerId: aliceId,
      authFetch: historyServer.authFetch,
    });
    expect(res500.status).toBe("skipped");
    expect(await bobMsgStore.listMessages(conversationId)).toHaveLength(0);
    historyServer.failHttp500 = false;

    // 3. Invalid JSON
    historyServer.failInvalidJson = true;
    const resJson = await syncConversationHistory({
      messenger: bobMessenger,
      messages: bobMsgStore,
      conversationId,
      peerId: aliceId,
      authFetch: historyServer.authFetch,
    });
    expect(resJson.status).toBe("skipped");
    expect(await bobMsgStore.listMessages(conversationId)).toHaveLength(0);
    historyServer.failInvalidJson = false;

    // 4. Malformed page
    historyServer.failMalformedPage = true;
    const resMalformed = await syncConversationHistory({
      messenger: bobMessenger,
      messages: bobMsgStore,
      conversationId,
      peerId: aliceId,
      authFetch: historyServer.authFetch,
    });
    expect(resMalformed.status).toBe("skipped");
    expect(await bobMsgStore.listMessages(conversationId)).toHaveLength(0);
  });

  it("k. Timestamps in all three styles produce the same normalised createdAt values locally", async () => {
    const conversationId = crypto.randomUUID();
    const aliceId = createUserId();
    const bobId = createUserId();

    const timestampStyles: ("iso-z" | "iso-offset" | "naive")[] = ["iso-z", "iso-offset", "naive"];
    const results: string[] = [];

    for (const style of timestampStyles) {
      const historyServer = new FakeHistoryServer();
      historyServer.timestampStyle = style;
      const msgId = crypto.randomUUID();
      const baseIso = "2026-11-19T10:05:00.000Z";

      historyServer.messages.set(msgId, {
        id: msgId,
        conversation_id: conversationId,
        sender_id: aliceId,
        client_msg_id: null,
        status: "DELIVERED",
        current_version: 1,
        created_at: baseIso,
        delivered_at: null,
        read_at: null,
        versions: [
          {
            id: crypto.randomUUID(),
            message_id: msgId,
            version_no: 1,
            ctype: 1,
            ciphertext: "",
            action: "DELETE",
            actor_id: aliceId,
            created_at: baseIso,
            erased_at: baseIso,
          },
        ],
      });

      const store = new MessageStore(bobId);
      storesToClean.push(store);

      const mockMessenger = new SecureMessenger({
        userId: bobId,
        sessions: { encrypt: vi.fn(), decrypt: vi.fn() },
        messages: store,
        send: vi.fn(),
      });

      await syncConversationHistory({
        messenger: mockMessenger,
        messages: store,
        conversationId,
        peerId: aliceId,
        authFetch: historyServer.authFetch,
      });

      const tombstone = await store.getMessage(msgId);
      expect(tombstone).toBeDefined();
      results.push(tombstone!.deletedAt!);
    }

    // All three produced identical normalised ISO UTC timestamps
    expect(results[0]).toBe("2026-11-19T10:05:00.000000Z");
    expect(results[1]).toBe("2026-11-19T10:05:00.000000Z");
    expect(results[2]).toBe("2026-11-19T10:05:00.000000Z");
  });

  it("l. Corrupted ciphertext for a CREATE stores failed envelope; corrupted EDIT emits decryptFailed kind EDIT and next sync succeeds", async () => {
    const { aliceMessenger, bobMessenger, bobMsgStore, bobSessions, conversationId, bobId, aliceId, relay, historyServer } =
      await setupTwoUsers();

    relay.offlineUsers.add(bobId);
    // Alice sends m1 (which will fail CREATE) and m2 (which will succeed)
    await aliceMessenger.sendText(conversationId, bobId, "msg 1 will fail");
    await aliceMessenger.sendText(conversationId, bobId, "msg 2 will succeed");

    const m1Server = Array.from(historyServer.messages.values())[0];
    const m2Server = Array.from(historyServer.messages.values())[1];

    // Spy on decrypt to fail m1 CREATE
    const originalDecrypt = bobSessions.decrypt.bind(bobSessions);
    vi.spyOn(bobSessions, "decrypt").mockImplementation(async (sender, env) => {
      if (env.body === m1Server.versions[0].ciphertext) {
        throw new Error("Bad MAC");
      }
      return originalDecrypt(sender, env);
    });

    const decryptFailedEvents: unknown[] = [];
    bobMessenger.on("decryptFailed", (e) => {
      decryptFailedEvents.push(e);
    });

    relay.offlineUsers.delete(bobId);
    const syncRes1 = await syncConversationHistory({
      messenger: bobMessenger,
      messages: bobMsgStore,
      conversationId,
      peerId: aliceId,
      authFetch: historyServer.authFetch,
    });

    expect(syncRes1.status).toBe("ok");
    // CREATE for m1 failed: failed envelope stored, message has decryptFailed true
    const failedEnv = await bobMsgStore.getFailedEnvelope(m1Server.id);
    expect(failedEnv).toBeDefined();
    expect(failedEnv?.lastErrorCode).toBe("bad_mac");

    const failedMsg = await bobMsgStore.getMessage(m1Server.id);
    expect(failedMsg?.decryptFailed).toBe(true);
    expect(failedMsg?.decryptErrorCode).toBe("bad_mac");

    // Sync continued with remaining messages: m2 succeeded!
    const m2Local = await bobMsgStore.getMessage(m2Server.id);
    expect(m2Local).toBeDefined();
    expect(m2Local?.decryptFailed).toBeUndefined();
    const m2Versions = await bobMsgStore.getVersions(m2Server.id);
    expect(m2Versions).toHaveLength(1);
    expect(JSON.parse(m2Versions[0].plaintext).text).toBe("msg 2 will succeed");

    // 1 decryptFailed event so far (for CREATE)
    expect(decryptFailedEvents).toHaveLength(1);
    expect((decryptFailedEvents[0] as Record<string, unknown>).messageId).toBe(m1Server.id);

    // Now test corrupted EDIT:
    // Alice sends an edit for m2 while bob is offline
    relay.offlineUsers.add(bobId);
    await aliceMessenger.sendEdit(conversationId, bobId, m2Server.id, "msg 2 edited text");
    const m2Updated = historyServer.messages.get(m2Server.id)!;
    const editVersion = m2Updated.versions.find((v) => v.action === "EDIT")!;

    // Make decrypt fail for m2 EDIT version
    vi.spyOn(bobSessions, "decrypt").mockImplementation(async (sender, env) => {
      if (env.body === editVersion.ciphertext) {
        throw new Error("Bad MAC");
      }
      return originalDecrypt(sender, env);
    });

    relay.offlineUsers.delete(bobId);
    const syncRes2 = await syncConversationHistory({
      messenger: bobMessenger,
      messages: bobMsgStore,
      conversationId,
      peerId: aliceId,
      authFetch: historyServer.authFetch,
    });

    expect(syncRes2.status).toBe("ok");
    // Emitted decryptFailed with kind: EDIT, versionNo: 2
    expect(decryptFailedEvents).toHaveLength(2);
    const editFailedEvt = decryptFailedEvents[1] as Record<string, unknown>;
    expect(editFailedEvt.kind).toBe("EDIT");
    expect(editFailedEvt.messageId).toBe(m2Server.id);
    expect(editFailedEvt.versionNo).toBe(2);

    // Version 2 was not stored; earlier version 1 remains intact
    const m2VersionsAfterFailedEdit = await bobMsgStore.getVersions(m2Server.id);
    expect(m2VersionsAfterFailedEdit).toHaveLength(1);
    expect(JSON.parse(m2VersionsAfterFailedEdit[0].plaintext).text).toBe("msg 2 will succeed");

    // Next sync with good decrypt succeeds naturally
    vi.spyOn(bobSessions, "decrypt").mockImplementation(originalDecrypt);

    const syncRes3 = await syncConversationHistory({
      messenger: bobMessenger,
      messages: bobMsgStore,
      conversationId,
      peerId: aliceId,
      authFetch: historyServer.authFetch,
    });

    expect(syncRes3.status).toBe("ok");
    const m2VersionsAfterSuccess = await bobMsgStore.getVersions(m2Server.id);
    expect(m2VersionsAfterSuccess).toHaveLength(2);
    expect(JSON.parse(m2VersionsAfterSuccess[1].plaintext).text).toBe("msg 2 edited text");
  });

  it("m. Orphan repair: bob receives DELETE for unknown message (emits orphanEvent); then sync applies tombstone from server", async () => {
    const { bobMessenger, bobMsgStore, conversationId, aliceId, historyServer } =
      await setupTwoUsers();

    const orphanId = crypto.randomUUID();
    const orphanEvents: unknown[] = [];
    bobMessenger.on("orphanEvent", (e) => {
      orphanEvents.push(e);
    });

    // Bob receives live DELETE frame for message he never saw
    await bobMessenger.onServerFrame({
      v: 1,
      type: "DELETE",
      message_id: orphanId,
    });

    expect(orphanEvents).toHaveLength(1);
    expect(orphanEvents[0]).toEqual({ kind: "DELETE", messageId: orphanId });
    expect(await bobMsgStore.getMessage(orphanId)).toBeUndefined();

    // Server has recorded it
    historyServer.addMessageFromFrame(
      {
        v: 1,
        type: "MESSAGE",
        message_id: orphanId,
        conversation_id: conversationId,
        sender_id: aliceId,
        version_no: 1,
        created_at: new Date().toISOString(),
        ctype: 1,
        body: "c2VjcmV0",
      },
      aliceId,
      conversationId,
    );
    historyServer.deleteMessage(orphanId, aliceId);

    // Bob syncs -> tombstone applied!
    await syncConversationHistory({
      messenger: bobMessenger,
      messages: bobMsgStore,
      conversationId,
      peerId: aliceId,
      authFetch: historyServer.authFetch,
    });

    const tombstone = await bobMsgStore.getMessage(orphanId);
    expect(tombstone).toBeDefined();
    expect(tombstone?.deletedAt).toBeDefined();
  });

  it("n. Concurrency: a live MESSAGE frame arrives while a sync is running for the same peer; both complete, no double decrypt, no deadlock", async () => {
    const {
      aliceMessenger,
      bobMessenger,
      bobMsgStore,
      bobSessions,
      aliceSessions,
      conversationId,
      bobId,
      aliceId,
      historyServer,
    } = await setupTwoUsers();

    // Alice produces message m1 for history server
    const enc1 = await aliceSessions.encrypt(
      bobId,
      JSON.stringify({ type: "TEXT", text: "sync message" }),
    );
    const m1Id = crypto.randomUUID();
    historyServer.addMessageFromFrame(
      {
        v: 1,
        type: "MESSAGE",
        message_id: m1Id,
        conversation_id: conversationId,
        sender_id: aliceId,
        version_no: 1,
        created_at: new Date().toISOString(),
        ctype: enc1.type,
        body: enc1.body,
      },
      aliceId,
      conversationId,
    );

    const decryptSpy = vi.spyOn(bobSessions, "decrypt");

    // Concurrently trigger sync and a live MESSAGE frame
    const syncPromise = syncConversationHistory({
      messenger: bobMessenger,
      messages: bobMsgStore,
      conversationId,
      peerId: aliceId,
      authFetch: historyServer.authFetch,
    });

    const liveMsgPromise = aliceMessenger.sendText(conversationId, bobId, "live message");

    const [syncRes, liveRes] = await Promise.all([syncPromise, liveMsgPromise]);
    expect(syncRes.status).toBe("ok");
    expect(liveRes.clientMsgId).toBeDefined();

    // Both messages exist locally
    const msgs = await bobMsgStore.listMessages(conversationId);
    expect(msgs).toHaveLength(2);

    // Each message was decrypted exactly once (no double-decrypt)
    expect(decryptSpy).toHaveBeenCalledTimes(2);
  });
});
