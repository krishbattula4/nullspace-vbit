import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexedDBSignalStore } from "./IndexedDBSignalStore";
import { provisionKeys } from "./provision";
import { SessionManager } from "./session";
import { MessageStore } from "../store/messageStore";
import { SecureMessenger, MessageActionError } from "./secureMessaging";
import { FakeKeyServer } from "../test/fakeKeyServer";
import {
  encodeClientFrame,
  parseServerFrame,
  type ClientFrame,
  type ServerAckFrame,
  type ServerMessageFrame,
  type ServerEditFrame,
  type ServerDeleteFrame,
  type ServerRetractFrame,
  type ServerDeliveredFrame,
  type ServerReadFrame,
  type ServerErrorFrame,
} from "../lib/protocol";
import {
  decodeMessagePayload,
  encodeMessagePayload,
} from "./messagePayload";
import type { MediaPayload } from "./media";

interface RelayMessageState {
  senderId: string;
  recipientId: string;
  readAt: string | null;
  currentVersion: number;
}

class FakeRelay {
  public recordedFrames: string[] = [];
  public users = new Map<string, SecureMessenger>();
  public conversationPeerMap = new Map<string, [string, string]>();
  public messageState = new Map<string, RelayMessageState>();
  public delaySenderEcho = false;
  public delayedEchoes: Array<() => Promise<void>> = [];

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

  async markRead(messageId: string): Promise<void> {
    const state = this.messageState.get(messageId);
    if (!state) return;
    state.readAt = new Date().toISOString();

    const senderMessenger = this.users.get(state.senderId);
    if (senderMessenger) {
      // 1. Deliver DELIVERED frame beforehand
      const deliveredRaw: ServerDeliveredFrame = {
        v: 1,
        type: "DELIVERED",
        message_id: messageId,
        delivered_at: new Date().toISOString(),
      };
      const deliveredParsed = parseServerFrame(JSON.stringify(deliveredRaw)) as ServerDeliveredFrame;
      this.recordedFrames.push(JSON.stringify(deliveredParsed));
      await senderMessenger.onServerFrame(deliveredParsed);

      // 2. Deliver READ frame
      const readRaw: ServerReadFrame = {
        v: 1,
        type: "READ",
        message_id: messageId,
        read_at: state.readAt,
      };
      const readParsed = parseServerFrame(JSON.stringify(readRaw)) as ServerReadFrame;
      this.recordedFrames.push(JSON.stringify(readParsed));
      await senderMessenger.onServerFrame(readParsed);
    }
  }

  async flushDelayedEchoes(): Promise<void> {
    while (this.delayedEchoes.length > 0) {
      const fn = this.delayedEchoes.shift();
      if (fn) await fn();
    }
  }

  async handleSend(senderId: string, frame: ClientFrame): Promise<void> {
    const encoded = encodeClientFrame(frame);
    this.recordedFrames.push(encoded);

    if (frame.type === "MESSAGE") {
      const messageId = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const recipientId = this.getRecipientId(frame.conversation_id, senderId);
      if (!recipientId) return;

      this.messageState.set(messageId, {
        senderId,
        recipientId,
        readAt: null,
        currentVersion: 1,
      });

      const ackRaw: ServerAckFrame = {
        v: 1,
        type: "ACK",
        client_msg_id: frame.client_msg_id,
        message_id: messageId,
        status: "SENT",
      };
      const ackParsed = parseServerFrame(JSON.stringify(ackRaw)) as ServerAckFrame;
      this.recordedFrames.push(JSON.stringify(ackParsed));

      const senderMessenger = this.users.get(senderId);
      if (senderMessenger) {
        await senderMessenger.onServerFrame(ackParsed);
      }

      const msgRaw: ServerMessageFrame = {
        v: 1,
        type: "MESSAGE",
        message_id: messageId,
        conversation_id: frame.conversation_id,
        sender_id: senderId,
        version_no: 1,
        ctype: frame.ctype,
        body: frame.body,
        created_at: createdAt,
      };
      const msgParsed = parseServerFrame(JSON.stringify(msgRaw)) as ServerMessageFrame;
      this.recordedFrames.push(JSON.stringify(msgParsed));

      const recipientMessenger = this.users.get(recipientId);
      if (recipientMessenger) {
        await recipientMessenger.onServerFrame(msgParsed);
      }
    } else if (frame.type === "EDIT") {
      const state = this.messageState.get(frame.message_id);
      if (!state) return;
      if (state.senderId !== senderId) return;

      state.currentVersion += 1;
      const editRaw: ServerEditFrame = {
        v: 1,
        type: "EDIT",
        message_id: frame.message_id,
        version_no: state.currentVersion,
        ctype: frame.ctype,
        body: frame.body,
        edited_at: new Date().toISOString(),
      };
      const editParsed = parseServerFrame(JSON.stringify(editRaw)) as ServerEditFrame;
      this.recordedFrames.push(JSON.stringify(editParsed));

      // Delivered to RECIPIENT ONLY
      const recipientMessenger = this.users.get(state.recipientId);
      if (recipientMessenger) {
        await recipientMessenger.onServerFrame(editParsed);
      }
    } else if (frame.type === "DELETE") {
      const state = this.messageState.get(frame.message_id);
      if (!state) return;
      if (state.senderId !== senderId) return;

      // Refuse if readAt is set
      if (state.readAt !== null) {
        return;
      }

      const deleteRaw: ServerDeleteFrame = {
        v: 1,
        type: "DELETE",
        message_id: frame.message_id,
      };
      const deleteParsed = parseServerFrame(JSON.stringify(deleteRaw)) as ServerDeleteFrame;
      this.recordedFrames.push(JSON.stringify(deleteParsed));

      const deliverToRecipient = async () => {
        const recipientMessenger = this.users.get(state.recipientId);
        if (recipientMessenger) {
          await recipientMessenger.onServerFrame(deleteParsed);
        }
      };
      const deliverToSender = async () => {
        const senderMessenger = this.users.get(state.senderId);
        if (senderMessenger) {
          await senderMessenger.onServerFrame(deleteParsed);
        }
      };

      await deliverToRecipient();

      if (this.delaySenderEcho) {
        this.delayedEchoes.push(deliverToSender);
      } else {
        await deliverToSender();
      }
    } else if (frame.type === "RETRACT") {
      const state = this.messageState.get(frame.message_id);
      if (!state) return;
      if (state.senderId !== senderId) return;

      // Refuse unless readAt is set
      if (state.readAt === null) {
        return;
      }

      const retractRaw: ServerRetractFrame = {
        v: 1,
        type: "RETRACT",
        message_id: frame.message_id,
      };
      const retractParsed = parseServerFrame(JSON.stringify(retractRaw)) as ServerRetractFrame;
      this.recordedFrames.push(JSON.stringify(retractParsed));

      const recipientMessenger = this.users.get(state.recipientId);
      if (recipientMessenger) {
        await recipientMessenger.onServerFrame(retractParsed);
      }
      const senderMessenger = this.users.get(state.senderId);
      if (senderMessenger) {
        await senderMessenger.onServerFrame(retractParsed);
      }
    }
  }
}

describe("TASK P5.2: Edit, Delete and Retract in Secure Messaging Engine", () => {
  const userIdsToClean = new Set<string>();
  const storesToClean: MessageStore[] = [];
  const signalStoresToClean: IndexedDBSignalStore[] = [];

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

    const relay = new FakeRelay();
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
      keyServer,
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

  it("a. Edit round trip: alice sends and edits twice; bob has versions 1,2,3; alice has 1,2,3; no secret text on wire", async () => {
    const { aliceMessenger, aliceMsgStore, bobMsgStore, conversationId, bobId, relay } =
      await setupTwoUsers();

    const secret1 = "secret version 1";
    const secret2 = "secret version 2 updated";
    const secret3 = "secret version 3 final";

    // Alice sends initial message
    const { clientMsgId } = await aliceMessenger.sendText(conversationId, bobId, secret1);
    expect(clientMsgId).toBeDefined();
    const aliceMsg = (await aliceMsgStore.listMessages(conversationId))[0];
    const messageId = aliceMsg.id;

    // Alice edits twice
    const editRes1 = await aliceMessenger.sendEdit(conversationId, bobId, messageId, secret2);
    expect(editRes1.versionNo).toBe(2);

    const editRes2 = await aliceMessenger.sendEdit(conversationId, bobId, messageId, secret3);
    expect(editRes2.versionNo).toBe(3);

    // Verify Bob's versions
    const bobVersions = await bobMsgStore.getVersions(messageId);
    expect(bobVersions).toHaveLength(3);
    expect(bobVersions.map((v) => v.versionNo)).toEqual([1, 2, 3]);
    expect(decodeMessagePayload(bobVersions[0].plaintext)).toEqual({ type: "TEXT", text: secret1 });
    expect(decodeMessagePayload(bobVersions[1].plaintext)).toEqual({ type: "TEXT", text: secret2 });
    expect(decodeMessagePayload(bobVersions[2].plaintext)).toEqual({ type: "TEXT", text: secret3 });

    // Verify Alice's local versions
    const aliceVersions = await aliceMsgStore.getVersions(messageId);
    expect(aliceVersions).toHaveLength(3);
    expect(aliceVersions.map((v) => v.versionNo)).toEqual([1, 2, 3]);
    expect(decodeMessagePayload(aliceVersions[0].plaintext)).toEqual({ type: "TEXT", text: secret1 });
    expect(decodeMessagePayload(aliceVersions[1].plaintext)).toEqual({ type: "TEXT", text: secret2 });
    expect(decodeMessagePayload(aliceVersions[2].plaintext)).toEqual({ type: "TEXT", text: secret3 });

    // Wire privacy: secret texts appear nowhere in plain text or base64 across all frames
    for (const frameJson of relay.recordedFrames) {
      for (const secret of [secret1, secret2, secret3]) {
        expect(frameJson).not.toContain(secret);
        const secretB64 = Buffer.from(secret).toString("base64");
        expect(frameJson).not.toContain(secretB64);
      }
    }
  });

  it("b. canEdit and edit rules: not_sender, not_confirmed, deleted, not_text, empty, unchanged; send not called and nothing stored", async () => {
    const {
      aliceMessenger,
      bobMessenger,
      aliceMsgStore,
      conversationId,
      bobId,
      aliceId,
      relay,
    } = await setupTwoUsers();

    // Alice sends initial message
    await aliceMessenger.sendText(conversationId, bobId, "initial text");
    const aliceMsg = (await aliceMsgStore.listMessages(conversationId))[0];
    const messageId = aliceMsg.id;

    const sendSpy = vi.spyOn(relay, "handleSend");

    // 1. Not sender (Bob tries to edit Alice's message)
    const canBob = await bobMessenger.canEdit(messageId);
    expect(canBob).toEqual({ allowed: false, reason: "not_sender" });
    await expect(bobMessenger.sendEdit(conversationId, aliceId, messageId, "bob edit")).rejects.toThrow(
      MessageActionError,
    );
    await expect(bobMessenger.sendEdit(conversationId, aliceId, messageId, "bob edit")).rejects.toMatchObject({
      code: "not_sender",
    });

    // 2. Not confirmed (SENDING message)
    const unconfirmedId = crypto.randomUUID();
    await aliceMsgStore.putMessage({
      id: unconfirmedId,
      conversationId,
      senderId: aliceId,
      createdAt: new Date().toISOString(),
      status: "SENDING",
      currentVersion: 1,
    });
    expect(await aliceMessenger.canEdit(unconfirmedId)).toEqual({
      allowed: false,
      reason: "not_confirmed",
    });
    await expect(
      aliceMessenger.sendEdit(conversationId, bobId, unconfirmedId, "new text"),
    ).rejects.toThrow(MessageActionError);
    await expect(
      aliceMessenger.sendEdit(conversationId, bobId, unconfirmedId, "new text"),
    ).rejects.toMatchObject({ code: "not_confirmed" });

    // 3. Deleted message
    const deletedMsgId = crypto.randomUUID();
    await aliceMsgStore.putMessage({
      id: deletedMsgId,
      conversationId,
      senderId: aliceId,
      createdAt: new Date().toISOString(),
      status: "SENT",
      currentVersion: 1,
      deletedAt: new Date().toISOString(),
    });
    expect(await aliceMessenger.canEdit(deletedMsgId)).toEqual({
      allowed: false,
      reason: "deleted",
    });
    await expect(
      aliceMessenger.sendEdit(conversationId, bobId, deletedMsgId, "new text"),
    ).rejects.toThrow(MessageActionError);
    await expect(
      aliceMessenger.sendEdit(conversationId, bobId, deletedMsgId, "new text"),
    ).rejects.toMatchObject({ code: "deleted" });

    // 4. Image message -> not_text
    const imagePayload: MediaPayload = {
      type: "IMAGE",
      media_id: crypto.randomUUID(),
      key: btoa("0".repeat(32)),
      iv: btoa("0".repeat(12)),
      sha256: "0".repeat(64),
      mime: "image/png",
      size: 1024,
    };
    await aliceMessenger.sendPayload(conversationId, bobId, imagePayload);
    const imageMsg = (await aliceMsgStore.listMessages(conversationId))[0];
    expect(await aliceMessenger.canEdit(imageMsg.id)).toEqual({
      allowed: false,
      reason: "not_text",
    });
    await expect(
      aliceMessenger.sendEdit(conversationId, bobId, imageMsg.id, "edit image"),
    ).rejects.toThrow(MessageActionError);
    await expect(
      aliceMessenger.sendEdit(conversationId, bobId, imageMsg.id, "edit image"),
    ).rejects.toMatchObject({ code: "not_text" });

    // 5. Empty or whitespace-only text
    await expect(
      aliceMessenger.sendEdit(conversationId, bobId, messageId, "   "),
    ).rejects.toThrow(MessageActionError);
    await expect(
      aliceMessenger.sendEdit(conversationId, bobId, messageId, "   "),
    ).rejects.toMatchObject({ code: "empty" });

    // 6. Unchanged text
    await expect(
      aliceMessenger.sendEdit(conversationId, bobId, messageId, "initial text"),
    ).rejects.toThrow(MessageActionError);
    await expect(
      aliceMessenger.sendEdit(conversationId, bobId, messageId, "initial text"),
    ).rejects.toMatchObject({ code: "unchanged" });

    // Send was only called for the initial image payload (not for any of the rejected edits)
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // In all rejected cases on messageId, versions remain exactly 1
    const versions = await aliceMsgStore.getVersions(messageId);
    expect(versions).toHaveLength(1);
  });

  it("c. Concurrency: 5 sendEdit calls at once produce consecutive versions 2..6 and final text matches", async () => {
    const { aliceMessenger, bobMsgStore, aliceMsgStore, conversationId, bobId } =
      await setupTwoUsers();

    await aliceMessenger.sendText(conversationId, bobId, "v1 original");
    const aliceMsg = (await aliceMsgStore.listMessages(conversationId))[0];
    const messageId = aliceMsg.id;

    const edits = ["v2 edit", "v3 edit", "v4 edit", "v5 edit", "v6 final"];

    // 5 concurrent sendEdit calls at once with Promise.all
    const results = await Promise.all(
      edits.map((text) => aliceMessenger.sendEdit(conversationId, bobId, messageId, text)),
    );

    expect(results.map((r) => r.versionNo)).toEqual([2, 3, 4, 5, 6]);

    const bobVersions = await bobMsgStore.getVersions(messageId);
    expect(bobVersions).toHaveLength(6);
    expect(bobVersions.map((v) => v.versionNo)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(decodeMessagePayload(bobVersions[5].plaintext)).toEqual({
      type: "TEXT",
      text: "v6 final",
    });

    const aliceVersions = await aliceMsgStore.getVersions(messageId);
    expect(aliceVersions).toHaveLength(6);
    expect(decodeMessagePayload(aliceVersions[5].plaintext)).toEqual({
      type: "TEXT",
      text: "v6 final",
    });
  });

  it("d. If send throws during an edit, no local version is added and error propagates", async () => {
    const { aliceMessenger, aliceMsgStore, conversationId, bobId, relay } =
      await setupTwoUsers();

    await aliceMessenger.sendText(conversationId, bobId, "v1 text");
    const msg = (await aliceMsgStore.listMessages(conversationId))[0];

    // Mock send to throw
    vi.spyOn(relay, "handleSend").mockRejectedValueOnce(new Error("socket disconnected"));

    await expect(
      aliceMessenger.sendEdit(conversationId, bobId, msg.id, "v2 should fail"),
    ).rejects.toThrow("socket disconnected");

    const versions = await aliceMsgStore.getVersions(msg.id);
    expect(versions).toHaveLength(1);
  });

  it("e. Corrupted EDIT frame: nothing stored, decryptFailed event with kind EDIT fires, next valid EDIT works", async () => {
    const { aliceMessenger, bobMessenger, bobMsgStore, conversationId, bobId } =
      await setupTwoUsers();

    await aliceMessenger.sendText(conversationId, bobId, "v1");
    const bobMsg = (await bobMsgStore.listMessages(conversationId))[0];

    const decryptFailures: unknown[] = [];
    bobMessenger.on("decryptFailed", (f) => {
      decryptFailures.push(f);
    });

    // Deliver a corrupted EDIT frame to Bob
    const corruptFrame: ServerEditFrame = {
      v: 1,
      type: "EDIT",
      message_id: bobMsg.id,
      version_no: 2,
      ctype: 1,
      body: "AQIDBA==", // Invalid ciphertext
      edited_at: new Date().toISOString(),
    };

    await bobMessenger.onServerFrame(corruptFrame);

    expect(decryptFailures).toHaveLength(1);
    expect(decryptFailures[0]).toMatchObject({
      messageId: bobMsg.id,
      kind: "EDIT",
      versionNo: 2,
    });

    // Bob still has only version 1
    expect(await bobMsgStore.getVersions(bobMsg.id)).toHaveLength(1);

    // Next valid edit succeeds
    await aliceMessenger.sendEdit(conversationId, bobId, bobMsg.id, "v2 valid");
    const bobVersions = await bobMsgStore.getVersions(bobMsg.id);
    expect(bobVersions).toHaveLength(2);
    expect(bobVersions[1].versionNo).toBe(2);
    expect(decodeMessagePayload(bobVersions[1].plaintext)).toEqual({
      type: "TEXT",
      text: "v2 valid",
    });
  });

  it("f. Replay: same EDIT frame delivered twice adds one version and decrypt is called once", async () => {
    const { aliceMessenger, bobMessenger, bobSessions, bobMsgStore, conversationId, bobId } =
      await setupTwoUsers();

    await aliceMessenger.sendText(conversationId, bobId, "v1");
    const bobMsg = (await bobMsgStore.listMessages(conversationId))[0];

    // Spy on Bob's decrypt
    const decryptSpy = vi.spyOn(bobSessions, "decrypt");

    const editRes = await aliceMessenger.sendEdit(conversationId, bobId, bobMsg.id, "v2");
    expect(editRes.versionNo).toBe(2);

    // Bob received and processed edit 2 once. Decrypt was called once.
    expect(decryptSpy).toHaveBeenCalledTimes(1);

    // Get the recorded EDIT frame from relay
    const editFrameRaw: ServerEditFrame = {
      v: 1,
      type: "EDIT",
      message_id: bobMsg.id,
      version_no: 2,
      ctype: 1,
      body: "AAEC",
      edited_at: new Date().toISOString(),
    };

    // Replay: deliver version 2 frame again to Bob
    await bobMessenger.onServerFrame(editFrameRaw);

    // Decrypt is NOT called again (still 1)
    expect(decryptSpy).toHaveBeenCalledTimes(1);
    expect(await bobMsgStore.getVersions(bobMsg.id)).toHaveLength(2);
  });

  it("g. Version gap: an EDIT with version_no 4 arrives when only 1 and 2 exist; stored as [1,2,4], currentVersion is 4", async () => {
    const { aliceMessenger, bobMessenger, bobMsgStore, conversationId, bobId, aliceSessions } =
      await setupTwoUsers();

    await aliceMessenger.sendText(conversationId, bobId, "v1");
    const bobMsg = (await bobMsgStore.listMessages(conversationId))[0];

    await aliceMessenger.sendEdit(conversationId, bobId, bobMsg.id, "v2");
    expect(await bobMsgStore.getVersions(bobMsg.id)).toHaveLength(2);

    // Alice produces an encrypted version 4 payload
    const enc4 = await aliceSessions.encrypt(
      bobId,
      encodeMessagePayload({ type: "TEXT", text: "v4 gap" }),
    );

    const gapFrame: ServerEditFrame = {
      v: 1,
      type: "EDIT",
      message_id: bobMsg.id,
      version_no: 4,
      ctype: enc4.type,
      body: enc4.body,
      edited_at: new Date().toISOString(),
    };

    await bobMessenger.onServerFrame(gapFrame);

    const bobVersions = await bobMsgStore.getVersions(bobMsg.id);
    expect(bobVersions.map((v) => v.versionNo)).toEqual([1, 2, 4]);

    const updatedMsg = await bobMsgStore.getMessage(bobMsg.id);
    expect(updatedMsg?.currentVersion).toBe(4);
  });

  it("h. Delete before read: delayed echo proves local message unchanged before echo; then both stores deleted, plaintext erased, failed envelope purged", async () => {
    const { aliceMessenger, bobMsgStore, aliceMsgStore, conversationId, bobId, relay } =
      await setupTwoUsers();

    await aliceMessenger.sendText(conversationId, bobId, "message to delete");
    const aliceMsg = (await aliceMsgStore.listMessages(conversationId))[0];
    const messageId = aliceMsg.id;

    // Enable delayed echo on relay
    relay.delaySenderEcho = true;

    // Alice sends delete
    await aliceMessenger.sendDelete(bobId, messageId);

    // Alice's local store is NOT changed yet!
    const msgBeforeEcho = await aliceMsgStore.getMessage(messageId);
    expect(msgBeforeEcho?.deletedAt).toBeUndefined();
    const verBeforeEcho = await aliceMsgStore.getVersions(messageId);
    expect(verBeforeEcho[0].plaintext).not.toBe("");

    // Bob's store was already updated by the relay
    const bobMsg = await bobMsgStore.getMessage(messageId);
    expect(bobMsg?.deletedAt).toBeDefined();

    // Now flush delayed echo to Alice
    await relay.flushDelayedEchoes();

    // Both stores now have deletedAt set, deletedBy = aliceId, plaintext erased to ""
    const msgAfterEcho = await aliceMsgStore.getMessage(messageId);
    expect(msgAfterEcho?.deletedAt).toBeDefined();
    expect(msgAfterEcho?.deletedBy).toBe(aliceMsg.senderId);

    const verAfterAlice = await aliceMsgStore.getVersions(messageId);
    expect(verAfterAlice[0].plaintext).toBe("");

    const verAfterBob = await bobMsgStore.getVersions(messageId);
    expect(verAfterBob[0].plaintext).toBe("");

    // No failed envelope in either store
    expect(await aliceMsgStore.getFailedEnvelope(messageId)).toBeUndefined();
    expect(await bobMsgStore.getFailedEnvelope(messageId)).toBeUndefined();
  });

  it("i. Delete after read: relay.markRead first; canDelete returns already_read, sendDelete throws already_read and nothing sent", async () => {
    const { aliceMessenger, aliceMsgStore, conversationId, bobId, relay } =
      await setupTwoUsers();

    await aliceMessenger.sendText(conversationId, bobId, "read then delete");
    const aliceMsg = (await aliceMsgStore.listMessages(conversationId))[0];
    const messageId = aliceMsg.id;

    // Bob marks message as read
    await relay.markRead(messageId);

    // Alice's store updated to READ
    const msgStatus = await aliceMsgStore.getMessage(messageId);
    expect(msgStatus?.status).toBe("READ");

    const can = await aliceMessenger.canDelete(messageId);
    expect(can).toEqual({ allowed: false, reason: "already_read" });

    const sendSpy = vi.spyOn(relay, "handleSend");
    await expect(aliceMessenger.sendDelete(bobId, messageId)).rejects.toMatchObject({
      code: "already_read",
    });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("j. Retract after read: relay.markRead, alice sendRetract; plaintexts KEPT; retract before read throws not_read", async () => {
    const { aliceMessenger, bobMsgStore, aliceMsgStore, conversationId, bobId, relay } =
      await setupTwoUsers();

    await aliceMessenger.sendText(conversationId, bobId, "message to retract");
    const aliceMsg = (await aliceMsgStore.listMessages(conversationId))[0];
    const messageId = aliceMsg.id;

    // Retract before read throws not_read
    const canBefore = await aliceMessenger.canRetract(messageId);
    expect(canBefore).toEqual({ allowed: false, reason: "not_read" });
    await expect(aliceMessenger.sendRetract(bobId, messageId)).rejects.toMatchObject({
      code: "not_read",
    });

    // Bob reads message
    await relay.markRead(messageId);

    // Retract after read succeeds
    const canAfter = await aliceMessenger.canRetract(messageId);
    expect(canAfter).toEqual({ allowed: true });

    await aliceMessenger.sendRetract(bobId, messageId);

    // Both stores get retractedAt and retractedBy
    const msgAlice = await aliceMsgStore.getMessage(messageId);
    expect(msgAlice?.retractedAt).toBeDefined();
    expect(msgAlice?.retractedBy).toBe(aliceMsg.senderId);

    const msgBob = await bobMsgStore.getMessage(messageId);
    expect(msgBob?.retractedAt).toBeDefined();
    expect(msgBob?.retractedBy).toBe(aliceMsg.senderId);

    // Plaintexts are KEPT and readable
    const verAlice = await aliceMsgStore.getVersions(messageId);
    expect(decodeMessagePayload(verAlice[0].plaintext)).toEqual({
      type: "TEXT",
      text: "message to retract",
    });

    const verBob = await bobMsgStore.getVersions(messageId);
    expect(decodeMessagePayload(verBob[0].plaintext)).toEqual({
      type: "TEXT",
      text: "message to retract",
    });
  });

  it("k. Tombstone wins: late EDIT after DELETE is ignored; retracted message cannot be edited; DELETE after RETRACT is ignored", async () => {
    const {
      aliceMessenger,
      bobMessenger,
      bobMsgStore,
      aliceMsgStore,
      conversationId,
      bobId,
      relay,
      bobSessions,
    } = await setupTwoUsers();

    // 1. DELETE wins over EDIT
    await aliceMessenger.sendText(conversationId, bobId, "msg for delete tombstone");
    const msg1 = (await aliceMsgStore.listMessages(conversationId))[0];
    await aliceMessenger.sendDelete(bobId, msg1.id);

    const decryptSpy = vi.spyOn(bobSessions, "decrypt");

    // Late EDIT arrives for deleted message
    const lateEdit: ServerEditFrame = {
      v: 1,
      type: "EDIT",
      message_id: msg1.id,
      version_no: 2,
      ctype: 1,
      body: "AAEC",
      edited_at: new Date().toISOString(),
    };
    await bobMessenger.onServerFrame(lateEdit);
    // Decrypt is never called and text stays empty
    expect(decryptSpy).not.toHaveBeenCalled();
    const ver1 = await bobMsgStore.getVersions(msg1.id);
    expect(ver1[0].plaintext).toBe("");

    // 2. Retracted message cannot be edited
    await aliceMessenger.sendText(conversationId, bobId, "msg for retract tombstone");
    const msg2 = (await aliceMsgStore.listMessages(conversationId))[0];
    await relay.markRead(msg2.id);
    await aliceMessenger.sendRetract(bobId, msg2.id);

    expect(await aliceMessenger.canEdit(msg2.id)).toEqual({
      allowed: false,
      reason: "retracted",
    });
    await expect(
      aliceMessenger.sendEdit(conversationId, bobId, msg2.id, "try edit"),
    ).rejects.toMatchObject({ code: "retracted" });

    // 3. DELETE frame after RETRACT is ignored
    const lateDelete: ServerDeleteFrame = {
      v: 1,
      type: "DELETE",
      message_id: msg2.id,
    };
    await bobMessenger.onServerFrame(lateDelete);
    const rec2 = await bobMsgStore.getMessage(msg2.id);
    expect(rec2?.deletedAt).toBeUndefined();
    expect(rec2?.retractedAt).toBeDefined();
  });

  it("l. Orphan events: EDIT, DELETE and RETRACT for unknown message id do not throw and emit orphanEvent", async () => {
    const { aliceMessenger } = await setupTwoUsers();

    const orphanEvents: Array<{ kind: string; messageId: string }> = [];
    aliceMessenger.on("orphanEvent", (e) => {
      orphanEvents.push(e);
    });

    const unknownId = crypto.randomUUID();

    // Unknown EDIT
    await aliceMessenger.onServerFrame({
      v: 1,
      type: "EDIT",
      message_id: unknownId,
      version_no: 2,
      ctype: 1,
      body: "AAEC",
      edited_at: new Date().toISOString(),
    });

    // Unknown DELETE
    await aliceMessenger.onServerFrame({
      v: 1,
      type: "DELETE",
      message_id: unknownId,
    });

    // Unknown RETRACT
    await aliceMessenger.onServerFrame({
      v: 1,
      type: "RETRACT",
      message_id: unknownId,
    });

    expect(orphanEvents).toHaveLength(3);
    expect(orphanEvents).toEqual([
      { kind: "EDIT", messageId: unknownId },
      { kind: "DELETE", messageId: unknownId },
      { kind: "RETRACT", messageId: unknownId },
    ]);
  });

  it("m. Status frames: READ after DELIVERED upgrades alice's message; late DELIVERED does not downgrade; unknown ids ignored", async () => {
    const { aliceMessenger, aliceMsgStore, conversationId, bobId } = await setupTwoUsers();

    await aliceMessenger.sendText(conversationId, bobId, "status test");
    const aliceMsg = (await aliceMsgStore.listMessages(conversationId))[0];
    const messageId = aliceMsg.id;

    // Initial status is SENT
    expect((await aliceMsgStore.getMessage(messageId))?.status).toBe("SENT");

    // Deliver DELIVERED frame
    await aliceMessenger.onServerFrame({
      v: 1,
      type: "DELIVERED",
      message_id: messageId,
      delivered_at: new Date().toISOString(),
    });
    expect((await aliceMsgStore.getMessage(messageId))?.status).toBe("DELIVERED");

    // Deliver READ frame
    await aliceMessenger.onServerFrame({
      v: 1,
      type: "READ",
      message_id: messageId,
      read_at: new Date().toISOString(),
    });
    expect((await aliceMsgStore.getMessage(messageId))?.status).toBe("READ");

    // Late DELIVERED does not downgrade READ
    await aliceMessenger.onServerFrame({
      v: 1,
      type: "DELIVERED",
      message_id: messageId,
      delivered_at: new Date().toISOString(),
    });
    expect((await aliceMsgStore.getMessage(messageId))?.status).toBe("READ");

    // Unknown message id does not throw
    await expect(
      aliceMessenger.onServerFrame({
        v: 1,
        type: "READ",
        message_id: crypto.randomUUID(),
        read_at: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();
  });

  it("n. EDIT frame whose message was sent by THIS user is ignored without decrypting", async () => {
    const { aliceMessenger, aliceMsgStore, aliceSessions, conversationId, bobId } =
      await setupTwoUsers();

    await aliceMessenger.sendText(conversationId, bobId, "self message");
    const aliceMsg = (await aliceMsgStore.listMessages(conversationId))[0];

    const decryptSpy = vi.spyOn(aliceSessions, "decrypt");

    // Malicious/errant server sends EDIT frame back to Alice for her own message
    await aliceMessenger.onServerFrame({
      v: 1,
      type: "EDIT",
      message_id: aliceMsg.id,
      version_no: 2,
      ctype: 1,
      body: "AAEC",
      edited_at: new Date().toISOString(),
    });

    expect(decryptSpy).not.toHaveBeenCalled();
    expect(await aliceMsgStore.getVersions(aliceMsg.id)).toHaveLength(1);
  });

  it("o. ERROR frame without client_msg_id emits protocolError and does not throw", async () => {
    const { aliceMessenger } = await setupTwoUsers();

    const protocolErrors: Array<{ code: string; detail?: string }> = [];
    aliceMessenger.on("protocolError", (e) => {
      protocolErrors.push(e);
    });

    const errorFrame: ServerErrorFrame = {
      v: 1,
      type: "ERROR",
      code: "unauthorized_action",
      detail: "Only original sender may edit",
    };

    await expect(aliceMessenger.onServerFrame(errorFrame)).resolves.toBeUndefined();
    expect(protocolErrors).toHaveLength(1);
    expect(protocolErrors[0]).toEqual({
      code: "unauthorized_action",
      detail: "Only original sender may edit",
    });
  });

  it("p. History survives reload: new MessageStore and SecureMessenger read back versions and retract flags", async () => {
    const { aliceMessenger, bobId, conversationId, bobSessions, bobMsgStore, relay } =
      await setupTwoUsers();

    await aliceMessenger.sendText(conversationId, bobId, "history v1");
    const msg = (await bobMsgStore.listMessages(conversationId))[0];

    await aliceMessenger.sendEdit(conversationId, bobId, msg.id, "history v2");
    await aliceMessenger.sendEdit(conversationId, bobId, msg.id, "history v3");
    await relay.markRead(msg.id);
    await aliceMessenger.sendRetract(bobId, msg.id);

    // Create fresh MessageStore for Bob simulating page reload
    const freshBobStore = new MessageStore(bobId);
    storesToClean.push(freshBobStore);

    const reloadedMessenger = new SecureMessenger({
      userId: bobId,
      sessions: bobSessions,
      messages: freshBobStore,
      send: () => {},
    });

    // Validates that reloaded messenger correctly queries the persistent store
    expect(await reloadedMessenger.canEdit(msg.id)).toEqual({
      allowed: false,
      reason: "not_sender",
    });

    const reloadedMsg = await freshBobStore.getMessage(msg.id);
    expect(reloadedMsg).toBeDefined();
    expect(reloadedMsg?.retractedAt).toBeDefined();
    expect(reloadedMsg?.currentVersion).toBe(3);

    const reloadedVersions = await freshBobStore.getVersions(msg.id);
    expect(reloadedVersions).toHaveLength(3);
    expect(decodeMessagePayload(reloadedVersions[2].plaintext)).toEqual({
      type: "TEXT",
      text: "history v3",
    });
  });
});
