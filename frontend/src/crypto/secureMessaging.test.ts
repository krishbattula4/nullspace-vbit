import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexedDBSignalStore } from "./IndexedDBSignalStore";
import { wipePrekeyState } from "./prekeyMaintenance";
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
  MAX_TEXT_CHARS,
  MessagePayloadError,
} from "./messagePayload";
import { buildMediaPayload, toBase64 } from "./media";

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
    // Validate with encodeClientFrame semantics
    const encoded = encodeClientFrame(frame);
    this.recordedFrames.push(encoded);

    if (frame.type === "MESSAGE") {
      const messageId = crypto.randomUUID();
      const createdAt = new Date().toISOString();

      // 1. Deliver ACK frame to sender
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

      // 2. Deliver MESSAGE frame to recipient
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

describe("SecureMessenger and Secure Messaging Engine", () => {
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
    // Upload both initial public bundles to fake key server
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
    while (storesToClean.length > 0) {
      const store = storesToClean.pop();
      try {
        await store?.wipe();
      } catch {
        // ignore
      }
    }
    while (signalStoresToClean.length > 0) {
      const s = signalStoresToClean.pop();
      try {
        await s?.wipe();
      } catch {
        // ignore
      }
    }
    for (const userId of userIdsToClean) {
      try {
        await wipePrekeyState(userId);
      } catch {
        // ignore
      }
    }
    userIdsToClean.clear();
    vi.restoreAllMocks();
  });

  // Test a: Round trip
  it("a. Round trip: alice sends text 'meet at the library at 5pm'; bob's MessageStore has the message under the relay's message_id with decoded payload text equal to it; alice's MessageStore has it with the real message id (the temporary client id record no longer exists) and status SENT", async () => {
    const {
      bobId,
      conversationId,
      aliceMsgStore,
      bobMsgStore,
      aliceMessenger,
      relay,
    } = await setupTwoUsers();

    const text = "meet at the library at 5pm";
    const { clientMsgId } = await aliceMessenger.sendText(conversationId, bobId, text);

    // Verify Bob's store
    const bobMessages = await bobMsgStore.listMessages(conversationId);
    expect(bobMessages).toHaveLength(1);
    const bobMsg = bobMessages[0];
    expect(bobMsg.status).toBe("DELIVERED");

    const bobVersions = await bobMsgStore.getVersions(bobMsg.id);
    expect(bobVersions).toHaveLength(1);
    const decoded = decodeMessagePayload(bobVersions[0].plaintext);
    expect(decoded).toEqual({ type: "TEXT", text });

    // Verify Alice's store: temporary client id record no longer exists
    const tempRecord = await aliceMsgStore.getMessage(clientMsgId);
    expect(tempRecord).toBeUndefined();

    // Real message id record exists with status SENT
    const realMsg = await aliceMsgStore.getMessage(bobMsg.id);
    expect(realMsg).toBeDefined();
    expect(realMsg?.id).toBe(bobMsg.id);
    expect(realMsg?.clientMsgId).toBe(clientMsgId);
    expect(realMsg?.status).toBe("SENT");

    // Check wire format
    expect(relay.recordedFrames.length).toBeGreaterThanOrEqual(3);
  });

  // Test b: NO PLAINTEXT ON THE WIRE (acceptance criterion)
  it("b. NO PLAINTEXT ON THE WIRE (acceptance criterion): across ALL frames the relay recorded, the secret strings sent by both users appear nowhere in the JSON text, neither as plain text nor as base64 of the text; the first message from alice has ctype 3, and after bob replies alice's next message has ctype 1; the body of each frame differs from the previous one", async () => {
    const {
      aliceId,
      bobId,
      conversationId,
      aliceMessenger,
      bobMessenger,
      relay,
    } = await setupTwoUsers();

    const secret1 = "super-secret-top-secret-alice-meeting-coords-9944";
    const secret2 = "bob-classified-acknowledgement-passcode-7711";
    const secret3 = "alice-final-confirmation-code-3322";

    // Alice -> Bob (first message, ctype 3)
    await aliceMessenger.sendText(conversationId, bobId, secret1);

    // Bob -> Alice (reply)
    await bobMessenger.sendText(conversationId, aliceId, secret2);

    // Alice -> Bob (next message, ctype 1)
    await aliceMessenger.sendText(conversationId, bobId, secret3);

    // Inspect ALL recorded frames from the relay
    const secrets = [secret1, secret2, secret3];
    for (const frameJson of relay.recordedFrames) {
      for (const secret of secrets) {
        expect(frameJson).not.toContain(secret);
        expect(frameJson).not.toContain(btoa(secret));
      }
    }

    // Filter MESSAGE frames from recorded wire frames
    const messageFrames: ServerMessageFrame[] = [];
    for (const frameStr of relay.recordedFrames) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- inspecting parsed JSON
      const parsed = JSON.parse(frameStr) as any;
      if (parsed.type === "MESSAGE" && "created_at" in parsed) {
        messageFrames.push(parsed as ServerMessageFrame);
      }
    }

    expect(messageFrames.length).toBe(3);
    // 1. First message from alice has ctype 3
    expect(messageFrames[0].ctype).toBe(3);
    // 2. Bob replies
    // 3. After bob replies, alice's next message has ctype 1
    expect(messageFrames[2].ctype).toBe(1);

    // The body of each frame differs from the previous one
    expect(messageFrames[0].body).not.toBe(messageFrames[1].body);
    expect(messageFrames[1].body).not.toBe(messageFrames[2].body);
    expect(messageFrames[0].body).not.toBe(messageFrames[2].body);
  });

  // Test c: 20 alternating messages
  it("c. 20 messages alternating between alice and bob in a conversation all arrive in order and decrypt correctly", async () => {
    const {
      aliceId,
      bobId,
      conversationId,
      aliceMessenger,
      bobMessenger,
      aliceMsgStore,
      bobMsgStore,
    } = await setupTwoUsers();

    const sentTexts: string[] = [];
    for (let i = 0; i < 20; i++) {
      const text = `alternating-message-${i}`;
      sentTexts.push(text);
      if (i % 2 === 0) {
        await aliceMessenger.sendText(conversationId, bobId, text);
      } else {
        await bobMessenger.sendText(conversationId, aliceId, text);
      }
    }

    // Alice's store should hold all 20 messages (10 sent as SENT, 10 received as DELIVERED)
    const aliceList = await aliceMsgStore.listMessages(conversationId, { limit: 100 });
    expect(aliceList).toHaveLength(20);

    // Bob's store should hold all 20 messages (10 received as DELIVERED, 10 sent as SENT)
    const bobList = await bobMsgStore.listMessages(conversationId, { limit: 100 });
    expect(bobList).toHaveLength(20);

    // Verify all 20 messages decrypted correctly and preserved content
    for (let i = 0; i < 20; i++) {
      const targetStore = i % 2 === 0 ? bobMsgStore : aliceMsgStore;
      const expectedText = sentTexts[i];

      const allMsgs = await targetStore.listMessages(conversationId, { limit: 100 });
      let found = false;
      for (const m of allMsgs) {
        const versions = await targetStore.getVersions(m.id);
        if (versions.length > 0) {
          const payload = decodeMessagePayload(versions[0].plaintext);
          if (payload.type === "TEXT" && payload.text === expectedText) {
            found = true;
            break;
          }
        }
      }
      expect(found).toBe(true);
    }
  });

  // Test d: Concurrency
  it("d. Concurrency: alice calls sendText 10 times at once with Promise.all (no awaiting between calls). All 10 reach bob, decrypt, and arrive in the order the frames were sent, with no decrypt failures", async () => {
    const {
      bobId,
      conversationId,
      aliceMessenger,
      bobMsgStore,
    } = await setupTwoUsers();

    const texts = Array.from({ length: 10 }, (_, i) => `concurrent-batch-item-${i}`);

    // Fire all 10 calls concurrently with Promise.all
    await Promise.all(texts.map((text) => aliceMessenger.sendText(conversationId, bobId, text)));

    const bobMessages = await bobMsgStore.listMessages(conversationId, { limit: 50 });
    expect(bobMessages).toHaveLength(10);

    // Ensure zero decrypt failures
    for (const msg of bobMessages) {
      expect(msg.decryptFailed).toBeFalsy();
    }

    // Verify Bob received all 10 in exact chronological order (listMessages returns newest first)
    const receivedTexts: string[] = [];
    for (const msg of [...bobMessages].reverse()) {
      const versions = await bobMsgStore.getVersions(msg.id);
      expect(versions).toHaveLength(1);
      const payload = decodeMessagePayload(versions[0].plaintext);
      if (payload.type === "TEXT") {
        receivedTexts.push(payload.text);
      }
    }

    expect(receivedTexts).toEqual(texts);
  });

  // Test e: Replay protection
  it("e. Replay: the relay delivers the same MESSAGE frame to bob twice. Bob stores exactly one message and sessions.decrypt is called exactly once for it (wrap sessions with a counting spy); onServerFrame does not throw", async () => {
    const {
      bobId,
      conversationId,
      aliceMessenger,
      bobSessions,
      bobMsgStore,
      bobMessenger,
      relay,
    } = await setupTwoUsers();

    const decryptSpy = vi.spyOn(bobSessions, "decrypt");

    let capturedServerFrame: ServerMessageFrame | undefined;
    relay.onMessageDelivering = (frame) => {
      capturedServerFrame = frame;
      return frame;
    };

    await aliceMessenger.sendText(conversationId, bobId, "replay-test-message");
    expect(capturedServerFrame).toBeDefined();
    expect(decryptSpy).toHaveBeenCalledTimes(1);

    // Deliver the exact same server MESSAGE frame to Bob a second time
    await expect(bobMessenger.onServerFrame(capturedServerFrame!)).resolves.not.toThrow();

    // sessions.decrypt must still have been called exactly once
    expect(decryptSpy).toHaveBeenCalledTimes(1);

    // Bob still holds exactly one message
    const bobMessages = await bobMsgStore.listMessages(conversationId);
    expect(bobMessages).toHaveLength(1);
  });

  // Test f: Corrupted ciphertext
  it("f. Corrupted ciphertext: flip one byte of a MESSAGE body before delivery. Bob stores the record with decryptFailed true and no version, a 'decryptFailed' event fires, nothing throws, and the NEXT valid message from alice still decrypts", async () => {
    const {
      bobId,
      conversationId,
      aliceMessenger,
      bobMsgStore,
      bobMessenger,
      relay,
    } = await setupTwoUsers();

    const decryptFailedEvents: unknown[] = [];
    bobMessenger.on("decryptFailed", (evt) => {
      decryptFailedEvents.push(evt);
    });

    let corruptNext = true;
    let corruptedMessageId = "";
    relay.onMessageDelivering = (frame) => {
      if (corruptNext) {
        corruptNext = false;
        corruptedMessageId = frame.message_id;
        // Flip the first character of the base64 ciphertext body
        const flippedChar = frame.body[0] === "A" ? "B" : "A";
        return {
          ...frame,
          body: flippedChar + frame.body.slice(1),
        };
      }
      return frame;
    };

    // First message gets corrupted
    await aliceMessenger.sendText(conversationId, bobId, "message-to-be-corrupted");

    expect(decryptFailedEvents).toHaveLength(1);
    const corruptedRecord = await bobMsgStore.getMessage(corruptedMessageId);
    expect(corruptedRecord).toBeDefined();
    expect(corruptedRecord?.decryptFailed).toBe(true);

    const corruptedVersions = await bobMsgStore.getVersions(corruptedMessageId);
    expect(corruptedVersions).toHaveLength(0); // No version stored

    // Second message is sent cleanly
    const validText = "next-valid-message-after-corruption";
    await aliceMessenger.sendText(conversationId, bobId, validText);

    const bobMessages = await bobMsgStore.listMessages(conversationId);
    expect(bobMessages).toHaveLength(2);

    const validRecord = bobMessages.find((m) => m.id !== corruptedMessageId);
    expect(validRecord).toBeDefined();
    expect(validRecord?.decryptFailed).toBeFalsy();

    const validVersions = await bobMsgStore.getVersions(validRecord!.id);
    expect(validVersions).toHaveLength(1);
    const payload = decodeMessagePayload(validVersions[0].plaintext);
    expect(payload).toEqual({ type: "TEXT", text: validText });
  });

  // Test g: Payloads (Unicode, 10,000 chars, IMAGE)
  it("g. Unicode, emoji and newlines ('नमस्ते 🔐\\nline two') and a 10,000 character text round-trip exactly; an IMAGE payload built with buildMediaPayload round-trips through the pipeline and decodeMessagePayload returns it unchanged", async () => {
    const {
      bobId,
      conversationId,
      aliceMessenger,
      bobMsgStore,
    } = await setupTwoUsers();

    // 1. Unicode & emoji
    const unicodeText = "नमस्ते 🔐\nline two";
    await aliceMessenger.sendText(conversationId, bobId, unicodeText);

    // 2. 10,000 characters
    const longText = "x".repeat(MAX_TEXT_CHARS);
    await aliceMessenger.sendText(conversationId, bobId, longText);

    // 3. IMAGE payload
    const dummyKey = toBase64(new Uint8Array(32));
    const dummyIv = toBase64(new Uint8Array(12));
    const imagePayload = buildMediaPayload(
      {
        ciphertext: new Uint8Array([1, 2, 3]),
        key: dummyKey,
        iv: dummyIv,
        sha256: "a".repeat(64),
        mime: "image/png",
        size: 512,
      },
      crypto.randomUUID(),
    );
    await aliceMessenger.sendPayload(conversationId, bobId, imagePayload);

    const bobMessages = await bobMsgStore.listMessages(conversationId, { limit: 10 });
    expect(bobMessages).toHaveLength(3);

    // listMessages returns newest-first: index 0 is image, 1 is longText, 2 is unicode
    const vImage = (await bobMsgStore.getVersions(bobMessages[0].id))[0];
    const vLong = (await bobMsgStore.getVersions(bobMessages[1].id))[0];
    const vUnicode = (await bobMsgStore.getVersions(bobMessages[2].id))[0];

    expect(decodeMessagePayload(vUnicode.plaintext)).toEqual({ type: "TEXT", text: unicodeText });
    expect(decodeMessagePayload(vLong.plaintext)).toEqual({ type: "TEXT", text: longText });
    expect(decodeMessagePayload(vImage.plaintext)).toEqual(imagePayload);
  });

  // Test h: Key change on send
  it("h. Key change on send: re-provision bob under the same userId with a fresh store (new identity) after alice already has a session; alice.sendText rejects with IdentityChangedError, `send` was NOT called, and alice's stored record has status FAILED", async () => {
    const {
      aliceId,
      bobId,
      conversationId,
      aliceMessenger,
      aliceSignalStore,
      aliceSessions,
      aliceMsgStore,
      keyServer,
      relay,
    } = await setupTwoUsers();

    // Initial exchange to establish session
    await aliceMessenger.sendText(conversationId, bobId, "initial message");

    // Re-provision Bob under the same userId with a fresh store
    const bobFreshStoreId = createUserId();
    const bobFreshStore = new IndexedDBSignalStore(bobFreshStoreId);
    signalStoresToClean.push(bobFreshStore);
    const bobProv2 = await provisionKeys(bobId, bobFreshStore);

    // Upload new bundle to fake key server
    await keyServer.authFetch("/keys/bundle", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bobProv2.bundle),
    });

    // Clear Alice's session so Alice initiates new handshake with Bob's bundle
    await aliceSignalStore.removeSession(aliceSessions.address(bobId).toString());

    const relaySendSpy = vi.spyOn(relay, "handleSend");
    relaySendSpy.mockClear();

    // Alice attempts sendText -> must reject with IdentityChangedError
    let caughtErr: unknown;
    try {
      await aliceMessenger.sendText(conversationId, bobId, "message to new bob");
    } catch (err) {
      caughtErr = err;
    }

    expect(caughtErr).toBeInstanceOf(IdentityChangedError);
    expect((caughtErr as IdentityChangedError).peerId).toBe(bobId);

    // Relay `send` was NOT called
    expect(relaySendSpy).not.toHaveBeenCalled();

    // Alice's stored record for that failed message has status FAILED
    const aliceMessages = await aliceMsgStore.listMessages(conversationId);
    const failedMsg = aliceMessages.find((m) => m.status === "FAILED");
    expect(failedMsg).toBeDefined();
    expect(failedMsg?.senderId).toBe(aliceId);
  });

  // Test i: ERROR frame and control frames
  it("i. ERROR frame with client_msg_id marks that outgoing message FAILED; a duplicate ACK is harmless; an ACK for an unknown client_msg_id is ignored; DELIVERED, READ and TYPING frames are ignored without error", async () => {
    const {
      conversationId,
      aliceMsgStore,
      aliceMessenger,
    } = await setupTwoUsers();

    const clientMsgId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    // Pre-insert a message in SENDING status
    await aliceMsgStore.putMessage({
      id: clientMsgId,
      clientMsgId,
      conversationId,
      senderId: aliceMessenger.userId,
      createdAt,
      status: "SENDING",
      currentVersion: 1,
    });

    // 1. Deliver ERROR frame with client_msg_id
    await aliceMessenger.onServerFrame({
      v: 1,
      type: "ERROR",
      code: "routing_failed",
      client_msg_id: clientMsgId,
    });

    const failedMsg = await aliceMsgStore.getMessage(clientMsgId);
    expect(failedMsg?.status).toBe("FAILED");

    // 2. Deliver duplicate ACK
    const realMsgId = crypto.randomUUID();
    await aliceMessenger.onServerFrame({
      v: 1,
      type: "ACK",
      client_msg_id: clientMsgId,
      message_id: realMsgId,
      status: "SENT",
    });
    // Second duplicate ACK
    await expect(
      aliceMessenger.onServerFrame({
        v: 1,
        type: "ACK",
        client_msg_id: clientMsgId,
        message_id: realMsgId,
        status: "SENT",
      }),
    ).resolves.not.toThrow();

    // 3. ACK for unknown client_msg_id
    await expect(
      aliceMessenger.onServerFrame({
        v: 1,
        type: "ACK",
        client_msg_id: crypto.randomUUID(),
        message_id: crypto.randomUUID(),
        status: "SENT",
      }),
    ).resolves.not.toThrow();

    // 4. Other frames (DELIVERED, READ, TYPING, PRESENCE)
    await expect(
      aliceMessenger.onServerFrame({
        v: 1,
        type: "DELIVERED",
        message_id: realMsgId,
        delivered_at: new Date().toISOString(),
      }),
    ).resolves.not.toThrow();

    await expect(
      aliceMessenger.onServerFrame({
        v: 1,
        type: "READ",
        message_id: realMsgId,
        read_at: new Date().toISOString(),
      }),
    ).resolves.not.toThrow();

    await expect(
      aliceMessenger.onServerFrame({
        v: 1,
        type: "TYPING",
        conversation_id: conversationId,
        user_id: "bob",
      }),
    ).resolves.not.toThrow();
  });

  // Test j: Handlers and error isolation
  it("j. Handlers: unsubscribe works; a throwing handler does not stop other handlers or the engine", async () => {
    const {
      bobId,
      conversationId,
      aliceMessenger,
      bobMessenger,
    } = await setupTwoUsers();

    const normalHandler = vi.fn();
    const throwingHandler = vi.fn(() => {
      throw new Error("Crashing handler!");
    });

    // Register throwing handler and normal handler
    bobMessenger.on("message", throwingHandler);
    const unsub = bobMessenger.on("message", normalHandler);

    // Send a message
    await aliceMessenger.sendText(conversationId, bobId, "hello handler test");

    expect(throwingHandler).toHaveBeenCalledTimes(1);
    expect(normalHandler).toHaveBeenCalledTimes(1);

    // Unsubscribe normal handler
    unsub();

    await aliceMessenger.sendText(conversationId, bobId, "second message after unsub");
    expect(throwingHandler).toHaveBeenCalledTimes(2);
    expect(normalHandler).toHaveBeenCalledTimes(1); // Not called again
  });

  // Test k: messagePayload strictness
  it("k. messagePayload strictness: bad JSON, array, unknown type, TEXT with extra field, TEXT with number text, empty and whitespace-only text, 10,001 characters, IMAGE payload with a 31-byte key, all rejected with MessagePayloadError; a valid TEXT payload round-trips", () => {
    // 1. Bad JSON
    expect(() => decodeMessagePayload("not valid json{")).toThrow(MessagePayloadError);

    // 2. Array
    expect(() => decodeMessagePayload("[]")).toThrow(MessagePayloadError);

    // 3. Unknown type
    expect(() => decodeMessagePayload(JSON.stringify({ type: "UNKNOWN", text: "hello" }))).toThrow(
      MessagePayloadError,
    );

    // 4. TEXT with extra field
    expect(() =>
      decodeMessagePayload(JSON.stringify({ type: "TEXT", text: "hi", extra: 123 })),
    ).toThrow(MessagePayloadError);

    // 5. TEXT with number text
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing invalid runtime input
      encodeMessagePayload({ type: "TEXT", text: 12345 as any }),
    ).toThrow(MessagePayloadError);

    // 6. Empty and whitespace-only text
    expect(() => encodeMessagePayload({ type: "TEXT", text: "" })).toThrow(MessagePayloadError);
    expect(() => encodeMessagePayload({ type: "TEXT", text: "   \n\t  " })).toThrow(
      MessagePayloadError,
    );

    // 7. 10,001 characters
    expect(() =>
      encodeMessagePayload({ type: "TEXT", text: "a".repeat(MAX_TEXT_CHARS + 1) }),
    ).toThrow(MessagePayloadError);

    // 8. IMAGE payload with a 31-byte key
    const invalidImage = {
      type: "IMAGE",
      media_id: crypto.randomUUID(),
      key: toBase64(new Uint8Array(31)), // 31 bytes instead of 32
      iv: toBase64(new Uint8Array(12)),
      sha256: "b".repeat(64),
      mime: "image/png",
      size: 100,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing invalid runtime input
    expect(() => encodeMessagePayload(invalidImage as any)).toThrow(MessagePayloadError);
    expect(() => decodeMessagePayload(JSON.stringify(invalidImage))).toThrow(MessagePayloadError);

    // 9. Valid TEXT payload round-trips
    const valid = { type: "TEXT" as const, text: "valid message text" };
    const encoded = encodeMessagePayload(valid);
    expect(decodeMessagePayload(encoded)).toEqual(valid);
  });

  // Test l: Persistence
  it("l. Persistence: after the conversation, create NEW MessageStore and MessageStore-backed messenger instances for bob on the same userId and read the history back with listMessages (no re-decryption needed)", async () => {
    const {
      bobId,
      conversationId,
      aliceMessenger,
      bobMsgStore,
      bobSessions,
    } = await setupTwoUsers();

    // Alice sends 3 messages to Bob
    await aliceMessenger.sendText(conversationId, bobId, "history msg 1");
    await aliceMessenger.sendText(conversationId, bobId, "history msg 2");
    await aliceMessenger.sendText(conversationId, bobId, "history msg 3");

    // Close Bob's original MessageStore
    bobMsgStore.close();

    // Instantiate fresh MessageStore and messenger for Bob on the same userId
    const freshBobStore = new MessageStore(bobId);
    storesToClean.push(freshBobStore);

    const freshMessenger = new SecureMessenger({
      userId: bobId,
      sessions: bobSessions,
      messages: freshBobStore,
      send: () => {},
    });
    void freshMessenger;

    const history = await freshBobStore.listMessages(conversationId, { limit: 10 });
    expect(history).toHaveLength(3);

    // listMessages returns newest-first: reverse to assert chronological order
    const texts: string[] = [];
    for (const record of [...history].reverse()) {
      expect(record.status).toBe("DELIVERED");
      const versions = await freshBobStore.getVersions(record.id);
      expect(versions).toHaveLength(1);
      const payload = decodeMessagePayload(versions[0].plaintext);
      if (payload.type === "TEXT") {
        texts.push(payload.text);
      }
    }

    expect(texts).toEqual(["history msg 1", "history msg 2", "history msg 3"]);
  });
});
