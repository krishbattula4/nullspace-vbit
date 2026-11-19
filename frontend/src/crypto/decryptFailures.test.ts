import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexedDBSignalStore } from "./IndexedDBSignalStore";
import { provisionKeys } from "./provision";
import { SessionManager, IdentityChangedError } from "./session";
import { MessageStore } from "../store/messageStore";
import { SecureMessenger } from "./secureMessaging";
import { FakeKeyServer } from "../test/fakeKeyServer";
import {
  encodeClientFrame,
  parseServerFrame,
  type ClientFrame,
  type ServerAckFrame,
  type ServerMessageFrame,
} from "../lib/protocol";
import {
  decodeMessagePayload,
  encodeMessagePayload,
  MessagePayloadError,
} from "./messagePayload";
import { classifyDecryptError } from "./decryptErrors";

class FakeRelay {
  public recordedFrames: string[] = [];
  public users = new Map<string, SecureMessenger>();
  public conversationPeerMap = new Map<string, [string, string]>();
  public onMessageDelivering?: (
    frame: ServerMessageFrame,
    recipientId: string,
  ) => ServerMessageFrame | null;

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

  async handleSend(senderId: string, frame: ClientFrame): Promise<void> {
    const encoded = encodeClientFrame(frame);
    this.recordedFrames.push(encoded);

    if (frame.type === "MESSAGE") {
      const messageId = crypto.randomUUID();
      const createdAt = new Date().toISOString();

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

      const recipientId = this.getRecipientId(frame.conversation_id, senderId);
      let msgRaw: ServerMessageFrame = {
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

      if (this.onMessageDelivering && recipientId) {
        const modified = this.onMessageDelivering(msgRaw, recipientId);
        if (modified === null) return;
        msgRaw = modified;
      }

      const msgParsed = parseServerFrame(JSON.stringify(msgRaw)) as ServerMessageFrame;
      this.recordedFrames.push(JSON.stringify(msgParsed));

      const recipientMessenger = recipientId ? this.users.get(recipientId) : undefined;
      if (recipientMessenger) {
        await recipientMessenger.onServerFrame(msgParsed);
      }
    }
  }
}

describe("TASK P3.8: Out-of-order, duplicate and decrypt-failure handling", () => {
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

  it("a. Out of order inside an established session: 8 messages delivered in order 3,1,4,2,8,5,7,6 all decrypt without failure", async () => {
    const { aliceMessenger, bobMessenger, bobMsgStore, conversationId, bobId, aliceId, relay } =
      await setupTwoUsers();

    // 1. Establish session so Alice sends type 1 (WhisperMessage) frames
    await aliceMessenger.sendText(conversationId, bobId, "init from alice");
    await bobMessenger.sendText(conversationId, aliceId, "reply from bob");

    // 2. Alice sends 8 consecutive messages; intercept delivery to buffer them
    const messages = [
      "message 1",
      "message 2",
      "message 3",
      "message 4",
      "message 5",
      "message 6",
      "message 7",
      "message 8",
    ];

    const bufferedFrames: ServerMessageFrame[] = [];
    relay.onMessageDelivering = (frame) => {
      bufferedFrames.push(frame);
      return null; // do not deliver immediately
    };

    for (const text of messages) {
      await aliceMessenger.sendText(conversationId, bobId, text);
    }

    expect(bufferedFrames).toHaveLength(8);
    // All 8 must be ctype 1
    expect(bufferedFrames.every((f) => f.ctype === 1)).toBe(true);

    // 3. Deliver in order: 3, 1, 4, 2, 8, 5, 7, 6 (1-based)
    // 0-based indices: [2, 0, 3, 1, 7, 4, 6, 5]
    const outOfOrderIndices = [2, 0, 3, 1, 7, 4, 6, 5];
    for (const idx of outOfOrderIndices) {
      await bobMessenger.onServerFrame(bufferedFrames[idx]);
    }

    // 4. Verify all 8 decrypt, no failures, texts match
    const failed = await bobMessenger.listFailed(conversationId);
    expect(failed).toHaveLength(0);

    for (let i = 0; i < 8; i++) {
      const frame = bufferedFrames[i];
      const rec = await bobMsgStore.getMessage(frame.message_id);
      expect(rec).toBeDefined();
      expect(rec?.decryptFailed).toBeUndefined();

      const versions = await bobMsgStore.getVersions(frame.message_id);
      expect(versions).toHaveLength(1);
      const payload = decodeMessagePayload(versions[0].plaintext);
      expect(payload).toEqual({ type: "TEXT", text: messages[i] });
    }
  });

  it("b. Two prekey messages swapped: m2 delivered before m1; both decrypt", async () => {
    const { aliceMessenger, bobMessenger, bobMsgStore, conversationId, bobId, relay } =
      await setupTwoUsers();

    const bufferedFrames: ServerMessageFrame[] = [];
    relay.onMessageDelivering = (frame) => {
      bufferedFrames.push(frame);
      return null;
    };

    // Alice sends m1 and m2 before Bob replies (both are ctype 3 PreKeyWhisperMessage)
    await aliceMessenger.sendText(conversationId, bobId, "prekey message 1");
    await aliceMessenger.sendText(conversationId, bobId, "prekey message 2");

    expect(bufferedFrames).toHaveLength(2);
    expect(bufferedFrames[0].ctype).toBe(3);
    expect(bufferedFrames[1].ctype).toBe(3);

    // Deliver m2 first, then m1
    await bobMessenger.onServerFrame(bufferedFrames[1]);
    await bobMessenger.onServerFrame(bufferedFrames[0]);

    // Both decrypt
    const v1 = await bobMsgStore.getVersions(bufferedFrames[0].message_id);
    const v2 = await bobMsgStore.getVersions(bufferedFrames[1].message_id);
    expect(v1).toHaveLength(1);
    expect(v2).toHaveLength(1);
    expect(decodeMessagePayload(v1[0].plaintext)).toEqual({
      type: "TEXT",
      text: "prekey message 1",
    });
    expect(decodeMessagePayload(v2[0].plaintext)).toEqual({
      type: "TEXT",
      text: "prekey message 2",
    });
  });

  it("c. Replay: the same frame delivered 3 times renders exactly one message and decrypt is called once", async () => {
    const { aliceMessenger, bobMessenger, bobSessions, bobMsgStore, conversationId, bobId, relay } =
      await setupTwoUsers();

    const decryptSpy = vi.spyOn(bobSessions, "decrypt");

    let capturedFrame: ServerMessageFrame | null = null;
    relay.onMessageDelivering = (frame) => {
      capturedFrame = frame;
      return null;
    };

    await aliceMessenger.sendText(conversationId, bobId, "replay test");
    expect(capturedFrame).not.toBeNull();

    // Deliver frame 3 times
    await bobMessenger.onServerFrame(capturedFrame!);
    await bobMessenger.onServerFrame(capturedFrame!);
    await bobMessenger.onServerFrame(capturedFrame!);

    expect(decryptSpy).toHaveBeenCalledTimes(1);

    const messages = await bobMsgStore.listMessages(conversationId);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(capturedFrame!.message_id);
  });

  it("d. Corrupted ciphertext: flip a byte; record has decryptFailed true and code 'bad_mac', attempts 1; subsequent message decrypts; retryDecrypt fails, attempts becomes 2", async () => {
    const {
      aliceMessenger,
      bobMessenger,
      bobMsgStore,
      conversationId,
      bobId,
      aliceId,
      relay,
    } = await setupTwoUsers();

    // Establish session so Alice uses ctype 1
    await aliceMessenger.sendText(conversationId, bobId, "hello");
    await bobMessenger.sendText(conversationId, aliceId, "ack");

    let corruptedFrame: ServerMessageFrame | null = null;
    relay.onMessageDelivering = (frame) => {
      corruptedFrame = { ...frame };
      // Flip a byte in the MAC portion of the ciphertext
      const buf = Buffer.from(corruptedFrame.body, "base64");
      buf[buf.length - 2] ^= 0x55;
      corruptedFrame.body = buf.toString("base64");
      return corruptedFrame;
    };

    const failures: unknown[] = [];
    bobMessenger.on("decryptFailed", (f) => {
      failures.push(f);
    });

    await aliceMessenger.sendText(conversationId, bobId, "corrupt me");
    expect(corruptedFrame).not.toBeNull();

    // Bob stores record with decryptFailed: true, code: "bad_mac"
    const rec = await bobMsgStore.getMessage(corruptedFrame!.message_id);
    expect(rec).toBeDefined();
    expect(rec?.decryptFailed).toBe(true);
    expect(rec?.decryptErrorCode).toBe("bad_mac");

    // Failed envelope stored with exact received base64 and attempts = 1
    const env = await bobMsgStore.getFailedEnvelope(corruptedFrame!.message_id);
    expect(env).toBeDefined();
    expect(env?.body).toBe(corruptedFrame!.body);
    expect(env?.attempts).toBe(1);
    expect(env?.lastErrorCode).toBe("bad_mac");

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      messageId: corruptedFrame!.message_id,
      conversationId,
      code: "bad_mac",
    });

    // Subsequent valid message from Alice still decrypts cleanly
    relay.onMessageDelivering = undefined;
    await aliceMessenger.sendText(
      conversationId,
      bobId,
      "subsequent valid message",
    );
    const allMessages = await bobMsgStore.listMessages(conversationId);
    // 4 messages total: "hello", "ack", "corrupt me" (failed), "subsequent valid message"
    expect(allMessages).toHaveLength(4);

    const validIncoming = allMessages.find(
      (m) => m.id !== corruptedFrame!.message_id && m.senderId === aliceId && !m.decryptFailed,
    );
    expect(validIncoming).toBeDefined();
    const validVersions = await bobMsgStore.getVersions(validIncoming!.id);
    expect(validVersions).toHaveLength(1);
    expect(decodeMessagePayload(validVersions[0].plaintext)).toEqual({
      type: "TEXT",
      text: "subsequent valid message",
    });

    // retryDecrypt on corrupted message returns failed and attempts becomes 2
    const retryResult = await bobMessenger.retryDecrypt(corruptedFrame!.message_id);
    expect(retryResult).toEqual({ status: "failed", code: "bad_mac" });

    const updatedEnv = await bobMsgStore.getFailedEnvelope(corruptedFrame!.message_id);
    expect(updatedEnv?.attempts).toBe(2);
    expect(updatedEnv?.lastErrorCode).toBe("bad_mac");
  });

  it("e. No session: deliver a type 1 message to a user who has no session with the sender; code is no_session; envelope is stored", async () => {
    const { aliceMessenger, bobMessenger, conversationId, bobId, aliceId, relay } =
      await setupTwoUsers();

    // 1. Establish session between Alice and Bob
    await aliceMessenger.sendText(conversationId, bobId, "hi");
    await bobMessenger.sendText(conversationId, aliceId, "reply");

    // Alice produces a type 1 message
    let type1Frame: ServerMessageFrame | null = null;
    relay.onMessageDelivering = (frame) => {
      type1Frame = frame;
      return null;
    };
    await aliceMessenger.sendText(conversationId, bobId, "type 1 frame");
    expect(type1Frame).not.toBeNull();
    expect(type1Frame!.ctype).toBe(1);

    // 2. Create third user Charlie who has NO session with Alice
    const charlieId = createUserId();
    const charlieSignalStore = new IndexedDBSignalStore(charlieId);
    signalStoresToClean.push(charlieSignalStore);
    await provisionKeys(charlieId, charlieSignalStore);

    const charlieMsgStore = new MessageStore(charlieId);
    storesToClean.push(charlieMsgStore);

    const keyServer = new FakeKeyServer(charlieId);
    const charlieSessions = new SessionManager(charlieId, charlieSignalStore, keyServer);

    const charlieMessenger = new SecureMessenger({
      userId: charlieId,
      sessions: charlieSessions,
      messages: charlieMsgStore,
      send: () => {},
    });

    const charlieFailures: unknown[] = [];
    charlieMessenger.on("decryptFailed", (f) => {
      charlieFailures.push(f);
    });

    // Deliver type 1 frame to Charlie
    await charlieMessenger.onServerFrame(type1Frame!);

    const rec = await charlieMsgStore.getMessage(type1Frame!.message_id);
    expect(rec).toBeDefined();
    expect(rec?.decryptFailed).toBe(true);
    expect(rec?.decryptErrorCode).toBe("no_session");

    const env = await charlieMsgStore.getFailedEnvelope(type1Frame!.message_id);
    expect(env).toBeDefined();
    expect(env?.lastErrorCode).toBe("no_session");
    expect(env?.attempts).toBe(1);

    expect(charlieFailures).toHaveLength(1);
    expect(charlieFailures[0]).toMatchObject({
      messageId: type1Frame!.message_id,
      code: "no_session",
    });
  });

  it("f. Transient failure then success: fake sessions throws 'transient' once then succeeds; retryDecrypt returns ok and cleans up", async () => {
    const userId = createUserId();
    const peerId = createUserId();
    const conversationId = crypto.randomUUID();
    const messageId = crypto.randomUUID();

    const msgStore = new MessageStore(userId);
    storesToClean.push(msgStore);

    let decryptCallCount = 0;
    const fakeSessions = {
      encrypt: async () => ({ type: 1 as const, body: "AAEC" }),
      decrypt: async () => {
        decryptCallCount++;
        if (decryptCallCount === 1) {
          throw new Error("transient network/disk error");
        }
        return encodeMessagePayload({ type: "TEXT", text: "recovered text" });
      },
    };

    const messenger = new SecureMessenger({
      userId,
      sessions: fakeSessions,
      messages: msgStore,
      send: () => {},
    });

    const messageEvents: unknown[] = [];
    const decryptFailedEvents: unknown[] = [];
    messenger.on("message", (m) => {
      messageEvents.push(m);
    });
    messenger.on("decryptFailed", (f) => {
      decryptFailedEvents.push(f);
    });

    const frame: ServerMessageFrame = {
      v: 1,
      type: "MESSAGE",
      message_id: messageId,
      conversation_id: conversationId,
      sender_id: peerId,
      version_no: 1,
      ctype: 1,
      body: "AAEC",
      created_at: "2026-11-19T10:00:00.000Z",
    };

    // First arrival: fails transiently
    await messenger.onServerFrame(frame);

    expect(decryptFailedEvents).toHaveLength(1);
    expect(decryptFailedEvents[0]).toMatchObject({
      messageId,
      code: "unknown",
    });

    const failedRecord = await msgStore.getMessage(messageId);
    expect(failedRecord?.decryptFailed).toBe(true);
    expect(failedRecord?.decryptErrorCode).toBe("unknown");

    const envelope = await msgStore.getFailedEnvelope(messageId);
    expect(envelope).toBeDefined();
    expect(envelope?.attempts).toBe(1);

    // Call retryDecrypt
    const retryRes = await messenger.retryDecrypt(messageId);
    expect(retryRes).toEqual({ status: "ok" });

    // Verify recovery
    const recoveredRecord = await msgStore.getMessage(messageId);
    expect(recoveredRecord?.decryptFailed).toBe(false);
    expect(recoveredRecord?.decryptErrorCode).toBeUndefined();

    const versions = await msgStore.getVersions(messageId);
    expect(versions).toHaveLength(1);
    expect(versions[0].plaintext).toBe(
      encodeMessagePayload({ type: "TEXT", text: "recovered text" }),
    );

    const envelopeAfter = await msgStore.getFailedEnvelope(messageId);
    expect(envelopeAfter).toBeUndefined();

    expect(messageEvents).toHaveLength(1);
  });

  it("g. Auto-retry: two failed messages with code unknown, third message succeeds; earlier messages recovered in order; bad_mac not retried; 3 attempt cap respected", async () => {
    const userId = createUserId();
    const senderId = createUserId();
    const conversationId = crypto.randomUUID();

    const msgStore = new MessageStore(userId);
    storesToClean.push(msgStore);

    const m1Id = "msg-001";
    const m2Id = "msg-002";
    const m3Id = "msg-003";
    const badMacId = "msg-bad-mac";
    const maxAttemptsId = "msg-max-attempts";

    // Setup decrypt responses
    const decryptState = new Map<string, number>();
    const fakeSessions = {
      encrypt: async () => ({ type: 1 as const, body: "AAEC" }),
      decrypt: async (peer: string, env: { type: 1 | 3; body: string }) => {
        void peer;
        const count = (decryptState.get(env.body) ?? 0) + 1;
        decryptState.set(env.body, count);

        if (env.body === "BODY-M1") {
          if (count === 1) throw new Error("transient 1");
          return encodeMessagePayload({ type: "TEXT", text: "text m1" });
        }
        if (env.body === "BODY-M2") {
          if (count === 1) throw new Error("transient 2");
          return encodeMessagePayload({ type: "TEXT", text: "text m2" });
        }
        if (env.body === "BODY-M3") {
          return encodeMessagePayload({ type: "TEXT", text: "text m3" });
        }
        if (env.body === "BODY-BAD-MAC") {
          throw new Error("Bad MAC");
        }
        if (env.body === "BODY-MAX-ATTEMPTS") {
          throw new Error("transient max");
        }
        return encodeMessagePayload({ type: "TEXT", text: "default" });
      },
    };

    const messenger = new SecureMessenger({
      userId,
      sessions: fakeSessions,
      messages: msgStore,
      send: () => {},
    });

    const receivedMessages: string[] = [];
    messenger.on("message", (m) => {
      receivedMessages.push(m.id);
    });

    // Deliver m1 -> fails (code: unknown, attempts: 1)
    await messenger.onServerFrame({
      v: 1,
      type: "MESSAGE",
      message_id: m1Id,
      conversation_id: conversationId,
      sender_id: senderId,
      version_no: 1,
      ctype: 1,
      body: "BODY-M1",
      created_at: "2026-11-19T10:00:00.000Z",
    });

    // Deliver m2 -> fails (code: unknown, attempts: 1)
    await messenger.onServerFrame({
      v: 1,
      type: "MESSAGE",
      message_id: m2Id,
      conversation_id: conversationId,
      sender_id: senderId,
      version_no: 1,
      ctype: 1,
      body: "BODY-M2",
      created_at: "2026-11-19T10:01:00.000Z",
    });

    // Deliver bad_mac message -> fails (code: bad_mac, attempts: 1)
    await messenger.onServerFrame({
      v: 1,
      type: "MESSAGE",
      message_id: badMacId,
      conversation_id: conversationId,
      sender_id: senderId,
      version_no: 1,
      ctype: 1,
      body: "BODY-BAD-MAC",
      created_at: "2026-11-19T10:02:00.000Z",
    });

    // Add an envelope that has already reached 3 attempts
    await msgStore.saveFailedEnvelope({
      messageId: maxAttemptsId,
      conversationId,
      senderId,
      ctype: 1,
      body: "BODY-MAX-ATTEMPTS",
      receivedAt: "2026-11-19T09:59:00.000Z",
      attempts: 3,
      lastErrorCode: "unknown",
    });
    await msgStore.putMessage({
      id: maxAttemptsId,
      conversationId,
      senderId,
      createdAt: "2026-11-19T09:59:00.000Z",
      status: "DELIVERED",
      currentVersion: 1,
      decryptFailed: true,
      decryptErrorCode: "unknown",
    });

    expect(receivedMessages).toEqual([]);

    // Now deliver m3 -> decrypt succeeds! Triggers auto-retry of eligible envelopes
    await messenger.onServerFrame({
      v: 1,
      type: "MESSAGE",
      message_id: m3Id,
      conversation_id: conversationId,
      sender_id: senderId,
      version_no: 1,
      ctype: 1,
      body: "BODY-M3",
      created_at: "2026-11-19T10:03:00.000Z",
    });

    // m3 was received first, followed by auto-retried m1 then m2 in receivedAt order
    expect(receivedMessages).toEqual([m3Id, m1Id, m2Id]);

    // m1 and m2 failed envelopes are deleted
    expect(await msgStore.getFailedEnvelope(m1Id)).toBeUndefined();
    expect(await msgStore.getFailedEnvelope(m2Id)).toBeUndefined();

    // bad_mac message was NOT retried automatically
    const badMacEnv = await msgStore.getFailedEnvelope(badMacId);
    expect(badMacEnv).toBeDefined();
    expect(badMacEnv?.attempts).toBe(1);

    // message with attempts === 3 was NOT retried automatically
    const maxAttemptsEnv = await msgStore.getFailedEnvelope(maxAttemptsId);
    expect(maxAttemptsEnv).toBeDefined();
    expect(maxAttemptsEnv?.attempts).toBe(3);
  });

  it("h. retryDecrypt for an unknown id returns not_found without throwing; retry of a message that was decrypted in the meantime returns ok and cleans up", async () => {
    const userId = createUserId();
    const senderId = createUserId();
    const conversationId = crypto.randomUUID();
    const messageId = crypto.randomUUID();

    const msgStore = new MessageStore(userId);
    storesToClean.push(msgStore);

    const messenger = new SecureMessenger({
      userId,
      sessions: {
        encrypt: async () => ({ type: 1 as const, body: "AAEC" }),
        decrypt: async () => "",
      },
      messages: msgStore,
      send: () => {},
    });

    // Unknown id returns not_found without throwing
    const resUnknown = await messenger.retryDecrypt(crypto.randomUUID());
    expect(resUnknown).toEqual({ status: "not_found" });

    // Message decrypted in the meantime (version 1 exists in store)
    await msgStore.saveFailedEnvelope({
      messageId,
      conversationId,
      senderId,
      ctype: 1,
      body: "AAEC",
      receivedAt: "2026-11-19T10:00:00.000Z",
      attempts: 1,
      lastErrorCode: "unknown",
    });
    await msgStore.putMessage({
      id: messageId,
      conversationId,
      senderId,
      createdAt: "2026-11-19T10:00:00.000Z",
      status: "DELIVERED",
      currentVersion: 1,
      decryptFailed: true,
      decryptErrorCode: "unknown",
    });
    await msgStore.addVersion({
      messageId,
      versionNo: 1,
      plaintext: encodeMessagePayload({ type: "TEXT", text: "decrypted meanwhile" }),
      action: "CREATE",
      createdAt: "2026-11-19T10:00:00.000Z",
    });

    // retryDecrypt returns ok and cleans up
    const resMeanwhile = await messenger.retryDecrypt(messageId);
    expect(resMeanwhile).toEqual({ status: "ok" });

    const envAfter = await msgStore.getFailedEnvelope(messageId);
    expect(envAfter).toBeUndefined();

    const msgAfter = await msgStore.getMessage(messageId);
    expect(msgAfter?.decryptFailed).toBe(false);
    expect(msgAfter?.decryptErrorCode).toBeUndefined();
  });

  it("i. Deleted message: markDeleted removes the failed envelope as well (no ciphertext remains)", async () => {
    const userId = createUserId();
    const conversationId = crypto.randomUUID();
    const messageId = crypto.randomUUID();

    const msgStore = new MessageStore(userId);
    storesToClean.push(msgStore);

    await msgStore.saveFailedEnvelope({
      messageId,
      conversationId,
      senderId: crypto.randomUUID(),
      ctype: 1,
      body: "SECRET-CIPHERTEXT==",
      receivedAt: "2026-11-19T10:00:00.000Z",
      attempts: 1,
      lastErrorCode: "bad_mac",
    });
    await msgStore.putMessage({
      id: messageId,
      conversationId,
      senderId: crypto.randomUUID(),
      createdAt: "2026-11-19T10:00:00.000Z",
      status: "DELIVERED",
      currentVersion: 1,
      decryptFailed: true,
      decryptErrorCode: "bad_mac",
    });

    expect(await msgStore.getFailedEnvelope(messageId)).toBeDefined();

    await msgStore.markDeleted(messageId);

    // Verify envelope is completely deleted from failedEnvelopes
    expect(await msgStore.getFailedEnvelope(messageId)).toBeUndefined();
    expect(await msgStore.listFailedEnvelopes()).toHaveLength(0);
  });

  it("j. Storage failure while saving the failure record: onServerFrame still resolves and emits decryptFailed with code 'storage'", async () => {
    const userId = createUserId();
    const senderId = createUserId();
    const conversationId = crypto.randomUUID();
    const messageId = crypto.randomUUID();

    const msgStore = new MessageStore(userId);
    storesToClean.push(msgStore);

    const messenger = new SecureMessenger({
      userId,
      sessions: {
        encrypt: async () => ({ type: 1 as const, body: "AAEC" }),
        decrypt: async () => {
          throw new Error("Bad MAC");
        },
      },
      messages: msgStore,
      send: () => {},
    });

    // Make messages.putMessage throw once to simulate storage crash
    vi.spyOn(msgStore, "putMessage").mockRejectedValueOnce(
      new Error("IndexedDB quota exceeded / disk full"),
    );

    const events: unknown[] = [];
    messenger.on("decryptFailed", (e) => {
      events.push(e);
    });

    // onServerFrame must never throw
    await expect(
      messenger.onServerFrame({
        v: 1,
        type: "MESSAGE",
        message_id: messageId,
        conversation_id: conversationId,
        sender_id: senderId,
        version_no: 1,
        ctype: 1,
        body: "AAEC",
        created_at: "2026-11-19T10:00:00.000Z",
      }),
    ).resolves.toBeUndefined();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      messageId,
      conversationId,
      senderId,
      code: "storage",
    });
  });

  it("k. listFailed returns only the failed messages of the requested conversation, oldest first", async () => {
    const userId = createUserId();
    const senderId = createUserId();
    const convA = crypto.randomUUID();
    const convB = crypto.randomUUID();

    const msgStore = new MessageStore(userId);
    storesToClean.push(msgStore);

    const messenger = new SecureMessenger({
      userId,
      sessions: {
        encrypt: async () => ({ type: 1 as const, body: "AAEC" }),
        decrypt: async () => {
          throw new Error("Bad MAC");
        },
      },
      messages: msgStore,
      send: () => {},
    });

    // Deliver msgA2 at 10:05
    await messenger.onServerFrame({
      v: 1,
      type: "MESSAGE",
      message_id: "msg-a2",
      conversation_id: convA,
      sender_id: senderId,
      version_no: 1,
      ctype: 1,
      body: "AAEC",
      created_at: "2026-11-19T10:05:00.000Z",
    });

    // Deliver msgA1 at 10:01
    await messenger.onServerFrame({
      v: 1,
      type: "MESSAGE",
      message_id: "msg-a1",
      conversation_id: convA,
      sender_id: senderId,
      version_no: 1,
      ctype: 1,
      body: "AAEC",
      created_at: "2026-11-19T10:01:00.000Z",
    });

    // Deliver msgB1 to convB at 10:03
    await messenger.onServerFrame({
      v: 1,
      type: "MESSAGE",
      message_id: "msg-b1",
      conversation_id: convB,
      sender_id: senderId,
      version_no: 1,
      ctype: 1,
      body: "AAEC",
      created_at: "2026-11-19T10:03:00.000Z",
    });

    // listFailed for convA must return only msgA1 then msgA2 (oldest first)
    const listA = await messenger.listFailed(convA);
    expect(listA.map((m) => m.id)).toEqual(["msg-a1", "msg-a2"]);

    // listFailed for convB must return only msgB1
    const listB = await messenger.listFailed(convB);
    expect(listB.map((m) => m.id)).toEqual(["msg-b1"]);
  });

  it("l. classifyDecryptError unit tests for every code, including DOMException QuotaExceededError and IdentityChangedError", () => {
    // 1. identity_changed
    expect(classifyDecryptError(new IdentityChangedError("alice"))).toBe("identity_changed");
    const idErr = new Error("identity error");
    idErr.name = "IdentityChangedError";
    expect(classifyDecryptError(idErr)).toBe("identity_changed");

    // 2. payload_invalid
    expect(classifyDecryptError(new MessagePayloadError("Invalid text payload"))).toBe(
      "payload_invalid",
    );
    const payErr = new Error("payload error");
    payErr.name = "MessagePayloadError";
    expect(classifyDecryptError(payErr)).toBe("payload_invalid");

    // 3. storage
    const quotaErr = new DOMException("The quota has been exceeded", "QuotaExceededError");
    expect(classifyDecryptError(quotaErr)).toBe("storage");
    expect(classifyDecryptError({ name: "QuotaExceededError" })).toBe("storage");
    expect(classifyDecryptError(new Error("IndexedDB transaction aborted unexpectedly"))).toBe(
      "storage",
    );
    expect(classifyDecryptError(new Error("Database transaction timed out"))).toBe("storage");

    // 4. no_session
    expect(classifyDecryptError(new Error("No record for device alice.1"))).toBe("no_session");
    expect(
      classifyDecryptError(new Error("Missing Signed PreKey for PreKeyWhisperMessage")),
    ).toBe("no_session");
    expect(classifyDecryptError(new Error("No session to encrypt message for bob"))).toBe(
      "no_session",
    );

    // 5. bad_mac
    expect(classifyDecryptError(new Error("Bad MAC"))).toBe("bad_mac");
    expect(classifyDecryptError(new RangeError("index out of range: 27 + 1828539 > 137"))).toBe(
      "bad_mac",
    );
    expect(classifyDecryptError(new Error("invalid wire type 7 at offset 1"))).toBe("bad_mac");
    expect(
      classifyDecryptError(new Error("Incompatible version number on WhisperMessage 5")),
    ).toBe("bad_mac");

    // 6. replayed_or_old
    expect(
      classifyDecryptError(
        new Error(
          "Message key not found. The counter was repeated or the key was not filled.",
        ),
      ),
    ).toBe("replayed_or_old");
    const counterErr = new Error("counter issue");
    counterErr.name = "MessageCounterError";
    expect(classifyDecryptError(counterErr)).toBe("replayed_or_old");
    expect(classifyDecryptError(new Error("The counter was repeated"))).toBe("replayed_or_old");

    // 7. unknown
    expect(classifyDecryptError(new Error("Something completely unrecognised"))).toBe("unknown");
    expect(classifyDecryptError("plain string error")).toBe("unknown");
    expect(classifyDecryptError(null)).toBe("unknown");
    expect(classifyDecryptError(undefined)).toBe("unknown");
    expect(classifyDecryptError({})).toBe("unknown");
  });
});
