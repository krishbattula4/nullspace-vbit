import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { MessageStore } from "../store/messageStore";
import {
  exportChats,
  importChats,
  validatePassphrase,
  triggerBrowserDownload,
  type ExportPayload,
} from "./chatExport";
import { encodeMessagePayload } from "./messagePayload";
import { buildMediaPayload, toBase64 } from "./media";
import { SecureMessenger } from "./secureMessaging";
import type { SessionManager } from "./session";

const TEST_PASSPHRASE = "Nullspace-Strong-Passphrase-2026!";
const FAST_ITERATIONS = 1000;

describe("Chat Export & Import (P7.5 + P7.6)", () => {
  let storesToWipe: MessageStore[] = [];

  function createStore(prefix: string): { store: MessageStore; userId: string } {
    const userId = `usr_${prefix}_${Math.random().toString(36).slice(2, 10)}`;
    const store = new MessageStore(userId);
    storesToWipe.push(store);
    return { store, userId };
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const s of storesToWipe) {
      try {
        await s.wipe();
      } catch {
        // ignore cleanup errors on already-wiped stores
      }
    }
    storesToWipe = [];
  });

  // Helper to encrypt hostile/custom JSON for invalid payload testing
  async function encryptRawPayload(
    payload: unknown,
    passphrase = TEST_PASSPHRASE,
    iterations = FAST_ITERATIONS,
  ): Promise<Uint8Array> {
    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const ivBytes = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const passBytes = enc.encode(passphrase.normalize("NFKC"));

    const baseKey = await crypto.subtle.importKey(
      "raw",
      passBytes,
      { name: "PBKDF2" },
      false,
      ["deriveKey"],
    );

    const aesKey = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: saltBytes,
        iterations,
        hash: "SHA-256",
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );

    const saltB64 = toBase64(saltBytes);
    const ivB64 = toBase64(ivBytes);
    const headerStr = `NULLSPACE-EXPORT\n1\nPBKDF2-SHA256\n${iterations}\n${saltB64}\n${ivB64}`;
    const additionalData = enc.encode(headerStr);
    const plaintextBytes = enc.encode(JSON.stringify(payload));

    const ciphertextBuffer = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: ivBytes, additionalData },
      aesKey,
      plaintextBytes,
    );

    const container = {
      format: "nullspace-export",
      version: 1,
      kdf: {
        name: "PBKDF2-SHA256",
        iterations,
        salt: saltB64,
      },
      cipher: {
        name: "AES-256-GCM",
        iv: ivB64,
      },
      data: toBase64(new Uint8Array(ciphertextBuffer)),
    };

    return enc.encode(JSON.stringify(container));
  }

  it("a. Round trip (acceptance): two conversations, edits, tombstones, retractions, media and unicode", async () => {
    const { store, userId } = createStore("roundtrip_a");
    const conv1Id = "c1111111-1111-4111-8111-111111111111";
    const conv2Id = "c2222222-2222-4222-8222-222222222222";
    const peer1Id = "usr_peer_alice";
    const peer2Id = "usr_peer_bob";

    // Message 1: Plain text
    const msg1Id = "11111111-1111-4111-8111-111111111111";
    await store.putMessage({
      id: msg1Id,
      conversationId: conv1Id,
      senderId: userId,
      createdAt: "2026-03-01T10:00:00.000Z",
      status: "SENT",
      currentVersion: 1,
    });
    await store.addVersion({
      messageId: msg1Id,
      versionNo: 1,
      plaintext: encodeMessagePayload({ type: "TEXT", text: "Hello Alice!" }),
      action: "CREATE",
      createdAt: "2026-03-01T10:00:00.000Z",
    });

    // Message 2: Edited message (3 versions)
    const msg2Id = "22222222-2222-4222-8222-222222222222";
    await store.putMessage({
      id: msg2Id,
      conversationId: conv1Id,
      senderId: userId,
      createdAt: "2026-03-01T10:01:00.000Z",
      status: "DELIVERED",
      currentVersion: 3,
    });
    await store.addVersion({
      messageId: msg2Id,
      versionNo: 1,
      plaintext: encodeMessagePayload({ type: "TEXT", text: "Draft 1" }),
      action: "CREATE",
      createdAt: "2026-03-01T10:01:00.000Z",
    });
    await store.addVersion({
      messageId: msg2Id,
      versionNo: 2,
      plaintext: encodeMessagePayload({ type: "TEXT", text: "Draft 2" }),
      action: "EDIT",
      createdAt: "2026-03-01T10:02:00.000Z",
    });
    await store.addVersion({
      messageId: msg2Id,
      versionNo: 3,
      plaintext: encodeMessagePayload({ type: "TEXT", text: "Final version" }),
      action: "EDIT",
      createdAt: "2026-03-01T10:03:00.000Z",
    });

    // Message 3: Deleted message (tombstone)
    const msg3Id = "33333333-3333-4333-8333-333333333333";
    await store.putMessage({
      id: msg3Id,
      conversationId: conv1Id,
      senderId: userId,
      createdAt: "2026-03-01T10:04:00.000Z",
      status: "DELIVERED",
      currentVersion: 1,
    });
    await store.addVersion({
      messageId: msg3Id,
      versionNo: 1,
      plaintext: encodeMessagePayload({ type: "TEXT", text: "Secret to be erased" }),
      action: "CREATE",
      createdAt: "2026-03-01T10:04:00.000Z",
    });
    await store.markDeleted(msg3Id, {
      at: "2026-03-01T10:05:00.000Z",
      by: userId,
    });

    // Message 4: Retracted message
    const msg4Id = "44444444-4444-4444-8444-444444444444";
    await store.putMessage({
      id: msg4Id,
      conversationId: conv1Id,
      senderId: userId,
      createdAt: "2026-03-01T10:06:00.000Z",
      status: "READ",
      currentVersion: 1,
    });
    await store.addVersion({
      messageId: msg4Id,
      versionNo: 1,
      plaintext: encodeMessagePayload({ type: "TEXT", text: "Read and retracted" }),
      action: "CREATE",
      createdAt: "2026-03-01T10:06:00.000Z",
    });
    await store.markRetracted(msg4Id, {
      at: "2026-03-01T10:07:00.000Z",
      by: userId,
    });

    // Message 5: Image payload in conversation 2
    const msg5Id = "55555555-5555-4555-8555-555555555555";
    const mediaId = "a1111111-1111-4111-8111-111111111111";
    const imagePayload = buildMediaPayload(
      {
        ciphertext: new Uint8Array([1, 2, 3, 4]),
        key: toBase64(new Uint8Array(32)),
        iv: toBase64(new Uint8Array(12)),
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        mime: "image/png",
        size: 1024,
      },
      mediaId,
    );
    await store.putMessage({
      id: msg5Id,
      conversationId: conv2Id,
      senderId: peer2Id,
      createdAt: "2026-03-01T10:08:00.000Z",
      status: "READ",
      currentVersion: 1,
    });
    await store.addVersion({
      messageId: msg5Id,
      versionNo: 1,
      plaintext: encodeMessagePayload(imagePayload),
      action: "CREATE",
      createdAt: "2026-03-01T10:08:00.000Z",
    });

    // Message 6: Unicode text with emoji and accents
    const msg6Id = "66666666-6666-4666-8666-666666666666";
    const unicodeText = "Hello 🚀🌟 Café & Naïve こんにちは";
    await store.putMessage({
      id: msg6Id,
      conversationId: conv2Id,
      senderId: peer2Id,
      createdAt: "2026-03-01T10:09:00.000Z",
      status: "SENT",
      currentVersion: 1,
    });
    await store.addVersion({
      messageId: msg6Id,
      versionNo: 1,
      plaintext: encodeMessagePayload({ type: "TEXT", text: unicodeText }),
      action: "CREATE",
      createdAt: "2026-03-01T10:09:00.000Z",
    });

    // Export using standard 600,000 iterations
    const exportResult = await exportChats({
      messages: store,
      userId,
      conversations: [
        { id: conv1Id, peerId: peer1Id, peerName: "Alice" },
        { id: conv2Id, peerId: peer2Id, peerName: "Bob" },
      ],
      passphrase: TEST_PASSPHRASE,
      now: () => new Date("2026-03-01T12:00:00.000Z"),
    });

    expect(exportResult.filename).toBe("nullspace-chat-2026-03-01.nullspace");
    expect(exportResult.counts).toEqual({
      conversations: 2,
      messages: 6,
      versions: 7, // 1 + 3 + 0 (tombstone) + 1 + 1 + 1
      tombstones: 1,
    });

    // Wipe store completely
    await store.wipe();

    // Import into fresh store with same userId
    const freshStore = new MessageStore(userId);
    storesToWipe.push(freshStore);

    const importNow = new Date("2026-03-02T15:00:00.000Z");
    const importResult = await importChats({
      file: exportResult.bytes,
      passphrase: TEST_PASSPHRASE,
      messages: freshStore,
      userId,
      now: () => importNow,
    });

    expect(importResult).toEqual({
      conversations: 2,
      messagesAdded: 6,
      messagesMerged: 0,
      versionsAdded: 7,
      tombstonesApplied: 1,
      skipped: 0,
    });

    // Verify all messages exist and have importedAt set
    const m1 = await freshStore.getMessage(msg1Id);
    expect(m1).toBeDefined();
    expect(m1?.importedAt).toBe(importNow.toISOString());
    expect(m1?.status).toBe("SENT");
    const v1 = await freshStore.getVersions(msg1Id);
    expect(v1).toHaveLength(1);
    expect(v1[0].plaintext).toBe(
      encodeMessagePayload({ type: "TEXT", text: "Hello Alice!" }),
    );

    const m2 = await freshStore.getMessage(msg2Id);
    expect(m2).toBeDefined();
    expect(m2?.importedAt).toBe(importNow.toISOString());
    expect(m2?.currentVersion).toBe(3);
    const v2 = await freshStore.getVersions(msg2Id);
    expect(v2).toHaveLength(3);
    expect(v2.map((v) => v.versionNo)).toEqual([1, 2, 3]);

    const m3 = await freshStore.getMessage(msg3Id);
    expect(m3).toBeDefined();
    expect(m3?.importedAt).toBe(importNow.toISOString());
    expect(m3?.deletedAt).toBe("2026-03-01T10:05:00.000Z");
    expect(m3?.deletedBy).toBe(userId);
    const v3 = await freshStore.getVersions(msg3Id);
    expect(v3).toHaveLength(0); // tombstone has no versions

    const m4 = await freshStore.getMessage(msg4Id);
    expect(m4).toBeDefined();
    expect(m4?.importedAt).toBe(importNow.toISOString());
    expect(m4?.retractedAt).toBe("2026-03-01T10:07:00.000Z");
    expect(m4?.retractedBy).toBe(userId);
    const v4 = await freshStore.getVersions(msg4Id);
    expect(v4).toHaveLength(1);
    expect(v4[0].plaintext).toBe(
      encodeMessagePayload({ type: "TEXT", text: "Read and retracted" }),
    );

    const m5 = await freshStore.getMessage(msg5Id);
    expect(m5).toBeDefined();
    expect(m5?.importedAt).toBe(importNow.toISOString());
    const v5 = await freshStore.getVersions(msg5Id);
    expect(v5).toHaveLength(1);
    expect(v5[0].plaintext).toBe(encodeMessagePayload(imagePayload));

    const m6 = await freshStore.getMessage(msg6Id);
    expect(m6).toBeDefined();
    expect(m6?.importedAt).toBe(importNow.toISOString());
    const v6 = await freshStore.getVersions(msg6Id);
    expect(v6).toHaveLength(1);
    expect(v6[0].plaintext).toBe(
      encodeMessagePayload({ type: "TEXT", text: unicodeText }),
    );
  }, 30000);

  it("b. UNREADABLE WITHOUT THE PASSPHRASE: tamper detection, wrong passphrase, downgrade protection", async () => {
    const { store, userId } = createStore("unreadable_b");
    const convId = "c1111111-1111-4111-8111-111111111111";
    const msgId = "11111111-1111-4111-8111-111111111111";
    const secretText = "SuperSecretConfidentialMessage123!";

    await store.putMessage({
      id: msgId,
      conversationId: convId,
      senderId: userId,
      createdAt: "2026-03-01T10:00:00.000Z",
      status: "SENT",
      currentVersion: 1,
    });
    await store.addVersion({
      messageId: msgId,
      versionNo: 1,
      plaintext: encodeMessagePayload({ type: "TEXT", text: secretText }),
      action: "CREATE",
      createdAt: "2026-03-01T10:00:00.000Z",
    });

    const exportRes = await exportChats({
      messages: store,
      userId,
      conversations: [{ id: convId, peerId: "peer_b", peerName: "Bob" }],
      passphrase: TEST_PASSPHRASE,
    });

    const fileStr = new TextDecoder().decode(exportRes.bytes);
    // Secret text is not present in raw file bytes nor as base64
    expect(fileStr.includes(secretText)).toBe(false);
    expect(fileStr.includes(btoa(secretText))).toBe(false);

    const freshStore = new MessageStore(userId);
    storesToWipe.push(freshStore);

    // Wrong passphrase fails with wrong_passphrase_or_corrupted
    await expect(
      importChats({
        file: exportRes.bytes,
        passphrase: "WrongPassword123!",
        messages: freshStore,
        userId,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "wrong_passphrase_or_corrupted" }),
    );

    // Tampering with salt base64
    const flipChar = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    const container = JSON.parse(fileStr);
    const tamperedSalt = {
      ...container,
      kdf: {
        ...container.kdf,
        salt: flipChar(container.kdf.salt),
      },
    };
    await expect(
      importChats({
        file: new TextEncoder().encode(JSON.stringify(tamperedSalt)),
        passphrase: TEST_PASSPHRASE,
        messages: freshStore,
        userId,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "wrong_passphrase_or_corrupted" }),
    );

    // Tampering with IV base64
    const tamperedIv = {
      ...container,
      cipher: {
        ...container.cipher,
        iv: flipChar(container.cipher.iv),
      },
    };
    await expect(
      importChats({
        file: new TextEncoder().encode(JSON.stringify(tamperedIv)),
        passphrase: TEST_PASSPHRASE,
        messages: freshStore,
        userId,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "wrong_passphrase_or_corrupted" }),
    );

    // Tampering with data base64
    const tamperedData = {
      ...container,
      data:
        container.data.slice(0, 10) +
        (container.data[10] === "A" ? "B" : "A") +
        container.data.slice(11),
    };
    await expect(
      importChats({
        file: new TextEncoder().encode(JSON.stringify(tamperedData)),
        passphrase: TEST_PASSPHRASE,
        messages: freshStore,
        userId,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "wrong_passphrase_or_corrupted" }),
    );

    // Tampering with iterations number in header (keeps JSON valid)
    const tamperedIterations = {
      ...container,
      kdf: {
        ...container.kdf,
        iterations: container.kdf.iterations + 1,
      },
    };
    await expect(
      importChats({
        file: new TextEncoder().encode(JSON.stringify(tamperedIterations)),
        passphrase: TEST_PASSPHRASE,
        messages: freshStore,
        userId,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "wrong_passphrase_or_corrupted" }),
    );

    // Truncated file
    await expect(
      importChats({
        file: exportRes.bytes.slice(0, 50),
        passphrase: TEST_PASSPHRASE,
        messages: freshStore,
        userId,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "wrong_passphrase_or_corrupted" }),
    );

    // Iterations edited down to 1000 (kdf_too_weak) without deriveKey
    const weakContainer = {
      ...container,
      kdf: { ...container.kdf, iterations: 1000 },
    };
    const deriveKeySpy = vi.spyOn(crypto.subtle, "deriveKey");
    await expect(
      importChats({
        file: new TextEncoder().encode(JSON.stringify(weakContainer)),
        passphrase: TEST_PASSPHRASE,
        messages: freshStore,
        userId,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "kdf_too_weak" }),
    );
    expect(deriveKeySpy).not.toHaveBeenCalled();

    // Iterations edited up to 100,000,000 (kdf_too_strong) without deriveKey
    const strongContainer = {
      ...container,
      kdf: { ...container.kdf, iterations: 100_000_000 },
    };
    await expect(
      importChats({
        file: new TextEncoder().encode(JSON.stringify(strongContainer)),
        passphrase: TEST_PASSPHRASE,
        messages: freshStore,
        userId,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "kdf_too_strong" }),
    );
    expect(deriveKeySpy).not.toHaveBeenCalled();
  }, 30000);

  it("c. NO NETWORK: export and import run purely client-side without network calls", async () => {
    const { store, userId } = createStore("no_network_c");
    const convId = "c1111111-1111-4111-8111-111111111111";
    const msgId = "11111111-1111-4111-8111-111111111111";

    await store.putMessage({
      id: msgId,
      conversationId: convId,
      senderId: userId,
      createdAt: "2026-03-01T10:00:00.000Z",
      status: "SENT",
      currentVersion: 1,
    });
    await store.addVersion({
      messageId: msgId,
      versionNo: 1,
      plaintext: encodeMessagePayload({ type: "TEXT", text: "Offline message" }),
      action: "CREATE",
      createdAt: "2026-03-01T10:00:00.000Z",
    });

    let networkAttempts = 0;
    const thrower = () => {
      networkAttempts++;
      throw new Error("Network call prohibited");
    };

    const origFetch = globalThis.fetch;
    const origXHR = globalThis.XMLHttpRequest;
    const origWS = globalThis.WebSocket;
    // Node 20 (used by CI) has no global `navigator`; Node 21+ does. Guard every access.
    const hasNavigator = typeof navigator !== "undefined";
    const origBeacon = hasNavigator ? navigator.sendBeacon : undefined;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      globalThis.fetch = thrower as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).XMLHttpRequest = function () {
        thrower();
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).WebSocket = function () {
        thrower();
      };
      if (typeof navigator !== "undefined") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (navigator as any).sendBeacon = thrower;
      }

      const exportRes = await exportChats({
        messages: store,
        userId,
        conversations: [{ id: convId, peerId: "peer_c" }],
        passphrase: TEST_PASSPHRASE,
      });

      const freshStore = new MessageStore(userId);
      storesToWipe.push(freshStore);

      await importChats({
        file: exportRes.bytes,
        passphrase: TEST_PASSPHRASE,
        messages: freshStore,
        userId,
      });

      expect(networkAttempts).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
      globalThis.XMLHttpRequest = origXHR;
      globalThis.WebSocket = origWS;
      if (hasNavigator) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- restoring a stubbed browser API
        (navigator as any).sendBeacon = origBeacon;
      }
    }
  }, 30000);

  it("d. Fresh salt and IV each export: two exports differ byte for byte and have unique salts/IVs", async () => {
    const { store, userId } = createStore("fresh_salt_iv_d");
    const convId = "c1111111-1111-4111-8111-111111111111";
    const msgId = "11111111-1111-4111-8111-111111111111";

    await store.putMessage({
      id: msgId,
      conversationId: convId,
      senderId: userId,
      createdAt: "2026-03-01T10:00:00.000Z",
      status: "SENT",
      currentVersion: 1,
    });
    await store.addVersion({
      messageId: msgId,
      versionNo: 1,
      plaintext: encodeMessagePayload({ type: "TEXT", text: "Identical input" }),
      action: "CREATE",
      createdAt: "2026-03-01T10:00:00.000Z",
    });

    const export1 = await exportChats({
      messages: store,
      userId,
      conversations: [{ id: convId, peerId: "peer_d" }],
      passphrase: TEST_PASSPHRASE,
      now: () => new Date("2026-03-01T10:00:00.000Z"),
    });

    const export2 = await exportChats({
      messages: store,
      userId,
      conversations: [{ id: convId, peerId: "peer_d" }],
      passphrase: TEST_PASSPHRASE,
      now: () => new Date("2026-03-01T10:00:00.000Z"),
    });

    const c1 = JSON.parse(new TextDecoder().decode(export1.bytes));
    const c2 = JSON.parse(new TextDecoder().decode(export2.bytes));

    expect(c1.kdf.salt).not.toBe(c2.kdf.salt);
    expect(c1.cipher.iv).not.toBe(c2.cipher.iv);
    expect(c1.data).not.toBe(c2.data);
    expect(export1.bytes).not.toEqual(export2.bytes);
  }, 30000);

  it("e. Passphrase rules: length, distinct chars, emoji, and NFKC normalisation", async () => {
    const { store, userId } = createStore("passphrase_rules_e");
    const convId = "c1111111-1111-4111-8111-111111111111";
    const msgId = "11111111-1111-4111-8111-111111111111";

    await store.putMessage({
      id: msgId,
      conversationId: convId,
      senderId: userId,
      createdAt: "2026-03-01T10:00:00.000Z",
      status: "SENT",
      currentVersion: 1,
    });
    await store.addVersion({
      messageId: msgId,
      versionNo: 1,
      plaintext: encodeMessagePayload({ type: "TEXT", text: "Text" }),
      action: "CREATE",
      createdAt: "2026-03-01T10:00:00.000Z",
    });

    // 11 characters rejected
    expect(validatePassphrase("12345678901").ok).toBe(false);
    await expect(
      exportChats({
        messages: store,
        userId,
        conversations: [{ id: convId, peerId: "peer" }],
        passphrase: "12345678901",
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "weak_passphrase" }),
    );

    // 16 repeated characters rejected (only 1 distinct)
    expect(validatePassphrase("aaaaaaaaaaaaaaaa").ok).toBe(false);
    await expect(
      exportChats({
        messages: store,
        userId,
        conversations: [{ id: convId, peerId: "peer" }],
        passphrase: "aaaaaaaaaaaaaaaa",
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "weak_passphrase" }),
    );

    // 12 characters with only 2 distinct rejected
    expect(validatePassphrase("abababababab").ok).toBe(false);
    await expect(
      exportChats({
        messages: store,
        userId,
        conversations: [{ id: convId, peerId: "peer" }],
        passphrase: "abababababab",
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "weak_passphrase" }),
    );

    // 12 characters with emoji (valid distinct count >= 5)
    const emojiPassphrase = "passphrase🚀1";
    expect(validatePassphrase(emojiPassphrase).ok).toBe(true);

    // Composed vs Decomposed Unicode (NFKC)
    const composed = "caf\u00e9-secret-passphrase-123";
    const decomposed = "cafe\u0301-secret-passphrase-123";

    const exportComposed = await exportChats({
      messages: store,
      userId,
      conversations: [{ id: convId, peerId: "peer" }],
      passphrase: composed,
      testOverrides: { kdfIterations: FAST_ITERATIONS },
    });

    await store.wipe();

    const freshStore = new MessageStore(userId);
    storesToWipe.push(freshStore);

    // Decomposed form decrypts the exact same export file
    const importRes = await importChats({
      file: exportComposed.bytes,
      passphrase: decomposed,
      messages: freshStore,
      userId,
      testOverrides: { minKdfIterations: FAST_ITERATIONS },
    });
    expect(importRes.messagesAdded).toBe(1);
  });

  it("f. Wrong account: file exported by user A imported with user B's ID throws wrong_account and writes NOTHING", async () => {
    const { store: storeA, userId: userA } = createStore("account_a");
    const { store: storeB, userId: userB } = createStore("account_b");

    const convId = "c1111111-1111-4111-8111-111111111111";
    const msgId = "11111111-1111-4111-8111-111111111111";

    await storeA.putMessage({
      id: msgId,
      conversationId: convId,
      senderId: userA,
      createdAt: "2026-03-01T10:00:00.000Z",
      status: "SENT",
      currentVersion: 1,
    });
    await storeA.addVersion({
      messageId: msgId,
      versionNo: 1,
      plaintext: encodeMessagePayload({ type: "TEXT", text: "Alice's confidential chat" }),
      action: "CREATE",
      createdAt: "2026-03-01T10:00:00.000Z",
    });

    const exportA = await exportChats({
      messages: storeA,
      userId: userA,
      conversations: [{ id: convId, peerId: "peer" }],
      passphrase: TEST_PASSPHRASE,
      testOverrides: { kdfIterations: FAST_ITERATIONS },
    });

    // Import with user B's userId
    await expect(
      importChats({
        file: exportA.bytes,
        passphrase: TEST_PASSPHRASE,
        messages: storeB,
        userId: userB,
        testOverrides: { minKdfIterations: FAST_ITERATIONS },
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "wrong_account" }),
    );

    // Store B must have NOTHING written
    const msgs = await storeB.listMessages(convId);
    expect(msgs).toHaveLength(0);
    const msg = await storeB.getMessage(msgId);
    expect(msg).toBeUndefined();
  });

  it("g. Idempotent and merge: importing twice leaves store identical; partial local history merges cleanly", async () => {
    const { store, userId } = createStore("merge_g");
    const convId = "c1111111-1111-4111-8111-111111111111";
    const msg1Id = "11111111-1111-4111-8111-111111111111";
    const msg2Id = "22222222-2222-4222-8222-222222222222";

    // Setup full export source
    const { store: exportSourceStore } = createStore("source_g");
    await exportSourceStore.putMessage({
      id: msg1Id,
      conversationId: convId,
      senderId: userId,
      createdAt: "2026-03-01T10:00:00.000Z",
      status: "SENT",
      currentVersion: 2,
    });
    await exportSourceStore.addVersion({
      messageId: msg1Id,
      versionNo: 1,
      plaintext: encodeMessagePayload({ type: "TEXT", text: "Msg1 v1" }),
      action: "CREATE",
      createdAt: "2026-03-01T10:00:00.000Z",
    });
    await exportSourceStore.addVersion({
      messageId: msg1Id,
      versionNo: 2,
      plaintext: encodeMessagePayload({ type: "TEXT", text: "Msg1 v2" }),
      action: "EDIT",
      createdAt: "2026-03-01T10:01:00.000Z",
    });

    await exportSourceStore.putMessage({
      id: msg2Id,
      conversationId: convId,
      senderId: userId,
      createdAt: "2026-03-01T10:02:00.000Z",
      status: "DELIVERED",
      currentVersion: 1,
    });
    await exportSourceStore.addVersion({
      messageId: msg2Id,
      versionNo: 1,
      plaintext: encodeMessagePayload({ type: "TEXT", text: "Msg2 v1" }),
      action: "CREATE",
      createdAt: "2026-03-01T10:02:00.000Z",
    });

    const exportRes = await exportChats({
      messages: exportSourceStore,
      userId,
      conversations: [{ id: convId, peerId: "peer_g" }],
      passphrase: TEST_PASSPHRASE,
      testOverrides: { kdfIterations: FAST_ITERATIONS },
    });

    // In local store, we already have msg1 with v1 (original text, no importedAt)
    await store.putMessage({
      id: msg1Id,
      conversationId: convId,
      senderId: userId,
      createdAt: "2026-03-01T10:00:00.000Z",
      status: "SENT",
      currentVersion: 1,
    });
    await store.addVersion({
      messageId: msg1Id,
      versionNo: 1,
      plaintext: encodeMessagePayload({ type: "TEXT", text: "Msg1 v1" }),
      action: "CREATE",
      createdAt: "2026-03-01T10:00:00.000Z",
    });

    // First import: merges v2 into msg1, adds msg2 completely
    const import1 = await importChats({
      file: exportRes.bytes,
      passphrase: TEST_PASSPHRASE,
      messages: store,
      userId,
      testOverrides: { minKdfIterations: FAST_ITERATIONS },
    });

    expect(import1.messagesAdded).toBe(1); // msg2 added
    expect(import1.messagesMerged).toBe(1); // msg1 merged (gained v2)
    expect(import1.versionsAdded).toBe(2); // v2 for msg1, v1 for msg2
    expect(import1.skipped).toBe(0);

    const localMsg1 = await store.getMessage(msg1Id);
    expect(localMsg1?.importedAt).toBeUndefined(); // Pre-existing record never gets importedAt!
    const localMsg2 = await store.getMessage(msg2Id);
    expect(localMsg2?.importedAt).toBeDefined(); // Newly added record has importedAt

    // Second import of the EXACT SAME FILE
    const import2 = await importChats({
      file: exportRes.bytes,
      passphrase: TEST_PASSPHRASE,
      messages: store,
      userId,
      testOverrides: { minKdfIterations: FAST_ITERATIONS },
    });

    expect(import2.messagesAdded).toBe(0);
    expect(import2.messagesMerged).toBe(0);
    expect(import2.versionsAdded).toBe(0);
    expect(import2.tombstonesApplied).toBe(0);
    expect(import2.skipped).toBe(2); // Both messages skipped
  });

  it("h. Deletion always wins: local text erased if export is deleted; local deleted message keeps text erased", async () => {
    const { store, userId } = createStore("del_wins_h");
    const convId = "c1111111-1111-4111-8111-111111111111";
    const msg1Id = "11111111-1111-4111-8111-111111111111";
    const msg2Id = "22222222-2222-4222-8222-222222222222";

    // Setup export store
    const { store: exportStore } = createStore("export_del_h");
    // Msg 1 is deleted in export
    await exportStore.putMessage({
      id: msg1Id,
      conversationId: convId,
      senderId: userId,
      createdAt: "2026-03-01T10:00:00.000Z",
      status: "SENT",
      currentVersion: 1,
    });
    await exportStore.markDeleted(msg1Id, {
      at: "2026-03-01T10:05:00.000Z",
      by: userId,
    });

    // Msg 2 has text in export
    await exportStore.putMessage({
      id: msg2Id,
      conversationId: convId,
      senderId: userId,
      createdAt: "2026-03-01T10:00:00.000Z",
      status: "SENT",
      currentVersion: 1,
    });
    await exportStore.addVersion({
      messageId: msg2Id,
      versionNo: 1,
      plaintext: encodeMessagePayload({ type: "TEXT", text: "Export text for Msg2" }),
      action: "CREATE",
      createdAt: "2026-03-01T10:00:00.000Z",
    });

    const exportRes = await exportChats({
      messages: exportStore,
      userId,
      conversations: [{ id: convId, peerId: "peer" }],
      passphrase: TEST_PASSPHRASE,
      testOverrides: { kdfIterations: FAST_ITERATIONS },
    });

    // In local store:
    // Msg 1 currently has active plaintext
    await store.putMessage({
      id: msg1Id,
      conversationId: convId,
      senderId: userId,
      createdAt: "2026-03-01T10:00:00.000Z",
      status: "SENT",
      currentVersion: 1,
    });
    await store.addVersion({
      messageId: msg1Id,
      versionNo: 1,
      plaintext: encodeMessagePayload({ type: "TEXT", text: "Active local text" }),
      action: "CREATE",
      createdAt: "2026-03-01T10:00:00.000Z",
    });

    // Msg 2 is ALREADY deleted locally
    await store.putMessage({
      id: msg2Id,
      conversationId: convId,
      senderId: userId,
      createdAt: "2026-03-01T10:00:00.000Z",
      status: "SENT",
      currentVersion: 1,
    });
    await store.markDeleted(msg2Id, {
      at: "2026-03-01T10:02:00.000Z",
      by: userId,
    });

    // Import:
    const importRes = await importChats({
      file: exportRes.bytes,
      passphrase: TEST_PASSPHRASE,
      messages: store,
      userId,
      testOverrides: { minKdfIterations: FAST_ITERATIONS },
    });

    expect(importRes.tombstonesApplied).toBe(1);

    // Case 1: local message 1 had text, export said deleted -> local text is erased!
    const m1 = await store.getMessage(msg1Id);
    expect(m1?.deletedAt).toBe("2026-03-01T10:05:00.000Z");
    const v1 = await store.getVersions(msg1Id);
    expect(v1.every((v) => v.plaintext === "")).toBe(true);

    // Case 2: export had text for msg 2, but local was already deleted -> text stays erased!
    const m2 = await store.getMessage(msg2Id);
    expect(m2?.deletedAt).toBe("2026-03-01T10:02:00.000Z");
    const v2 = await store.getVersions(msg2Id);
    expect(v2.length === 0 || v2.every((v) => v.plaintext === "")).toBe(true);
  });

  it("i. Status and flags: monotonic status progression and retraction flags", async () => {
    const { store, userId } = createStore("status_flags_i");
    const convId = "c1111111-1111-4111-8111-111111111111";
    const msgId = "11111111-1111-4111-8111-111111111111";

    const { store: exportStore } = createStore("export_status_i");
    await exportStore.putMessage({
      id: msgId,
      conversationId: convId,
      senderId: userId,
      createdAt: "2026-03-01T10:00:00.000Z",
      status: "DELIVERED",
      currentVersion: 1,
    });
    await exportStore.addVersion({
      messageId: msgId,
      versionNo: 1,
      plaintext: encodeMessagePayload({ type: "TEXT", text: "Status test" }),
      action: "CREATE",
      createdAt: "2026-03-01T10:00:00.000Z",
    });
    await exportStore.markRetracted(msgId, {
      at: "2026-03-01T10:10:00.000Z",
      by: userId,
    });

    const exportRes = await exportChats({
      messages: exportStore,
      userId,
      conversations: [{ id: convId, peerId: "peer" }],
      passphrase: TEST_PASSPHRASE,
      testOverrides: { kdfIterations: FAST_ITERATIONS },
    });

    // Local store has status READ (higher than DELIVERED) and no retraction
    await store.putMessage({
      id: msgId,
      conversationId: convId,
      senderId: userId,
      createdAt: "2026-03-01T10:00:00.000Z",
      status: "READ",
      currentVersion: 1,
    });
    await store.addVersion({
      messageId: msgId,
      versionNo: 1,
      plaintext: encodeMessagePayload({ type: "TEXT", text: "Status test" }),
      action: "CREATE",
      createdAt: "2026-03-01T10:00:00.000Z",
    });

    await importChats({
      file: exportRes.bytes,
      passphrase: TEST_PASSPHRASE,
      messages: store,
      userId,
      testOverrides: { minKdfIterations: FAST_ITERATIONS },
    });

    const localMsg = await store.getMessage(msgId);
    expect(localMsg?.status).toBe("READ"); // Must NOT downgrade from READ to DELIVERED
    expect(localMsg?.retractedAt).toBe("2026-03-01T10:10:00.000Z"); // Retraction applied
    expect(localMsg?.retractedBy).toBe(userId);
  });

  it("j. READ-ONLY: canEdit, canDelete, and canRetract return reason 'imported' for imported messages", async () => {
    const { store, userId } = createStore("readonly_j");
    const convId = "c1111111-1111-4111-8111-111111111111";
    const importedMsgId = "11111111-1111-4111-8111-111111111111";
    const normalMsgId = "22222222-2222-4222-8222-222222222222";

    // Imported message has importedAt set
    await store.putMessage({
      id: importedMsgId,
      conversationId: convId,
      senderId: userId,
      createdAt: "2026-03-01T10:00:00.000Z",
      status: "SENT",
      currentVersion: 1,
      importedAt: "2026-03-02T10:00:00.000Z",
    });
    await store.addVersion({
      messageId: importedMsgId,
      versionNo: 1,
      plaintext: encodeMessagePayload({ type: "TEXT", text: "Imported message text" }),
      action: "CREATE",
      createdAt: "2026-03-01T10:00:00.000Z",
    });

    // Normal local message (no importedAt)
    await store.putMessage({
      id: normalMsgId,
      conversationId: convId,
      senderId: userId,
      createdAt: "2026-03-01T10:01:00.000Z",
      status: "SENT",
      currentVersion: 1,
    });
    await store.addVersion({
      messageId: normalMsgId,
      versionNo: 1,
      plaintext: encodeMessagePayload({ type: "TEXT", text: "Normal message text" }),
      action: "CREATE",
      createdAt: "2026-03-01T10:01:00.000Z",
    });

    // Construct SecureMessenger with fake sessions
    const fakeSessions = {} as unknown as SessionManager;
    const messenger = new SecureMessenger({
      userId,
      sessions: fakeSessions,
      messages: store,
      send: () => {},
    });

    // Imported message must be strictly read-only
    expect(await messenger.canEdit(importedMsgId)).toEqual({
      allowed: false,
      reason: "imported",
    });
    expect(await messenger.canDelete(importedMsgId)).toEqual({
      allowed: false,
      reason: "imported",
    });
    expect(await messenger.canRetract(importedMsgId)).toEqual({
      allowed: false,
      reason: "imported",
    });

    // Normal message is allowed
    expect(await messenger.canEdit(normalMsgId)).toEqual({ allowed: true });
    expect(await messenger.canDelete(normalMsgId)).toEqual({ allowed: true });
  });

  it("k. Invalid payloads: reject malformed structures with ImportError 'invalid_payload' and leave store unchanged", async () => {
    const { store, userId } = createStore("invalid_payloads_k");
    const validConvId = "c1111111-1111-4111-8111-111111111111";
    const validMsgId = "11111111-1111-4111-8111-111111111111";

    const baseValidPayload: ExportPayload = {
      schema: 1,
      exportedAt: "2026-03-01T10:00:00.000Z",
      exporter: { userId },
      conversations: [
        {
          id: validConvId,
          peerId: "peer_k",
          peerName: "Peer",
          messages: [
            {
              id: validMsgId,
              senderId: userId,
              createdAt: "2026-03-01T10:00:00.000Z",
              status: "SENT",
              currentVersion: 1,
              versions: [
                {
                  versionNo: 1,
                  plaintext: encodeMessagePayload({ type: "TEXT", text: "Hello" }),
                  action: "CREATE",
                  createdAt: "2026-03-01T10:00:00.000Z",
                },
              ],
            },
          ],
        },
      ],
    };

    // Subcases of hostile or corrupted payloads
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mutating hostile test payload
    const hostilePayloads: Array<{ name: string; mutate: (p: any) => void }> = [
      {
        name: "bad message UUID",
        mutate: (p) => {
          p.conversations[0].messages[0].id = "not-a-valid-uuid";
        },
      },
      {
        name: "bad conversation UUID",
        mutate: (p) => {
          p.conversations[0].id = "invalid-conv-uuid";
        },
      },
      {
        name: "unknown message status",
        mutate: (p) => {
          p.conversations[0].messages[0].status = "SOME_RANDOM_STATUS";
        },
      },
      {
        name: "version 0",
        mutate: (p) => {
          p.conversations[0].messages[0].versions[0].versionNo = 0;
        },
      },
      {
        name: "duplicate version numbers",
        mutate: (p) => {
          p.conversations[0].messages[0].versions.push({
            versionNo: 1,
            plaintext: encodeMessagePayload({ type: "TEXT", text: "Duplicate v1" }),
            action: "EDIT",
            createdAt: "2026-03-01T10:01:00.000Z",
          });
        },
      },
      {
        name: "plaintext that is a number",
        mutate: (p) => {
          p.conversations[0].messages[0].versions[0].plaintext = 12345;
        },
      },
      {
        name: "unknown extra field at root",
        mutate: (p) => {
          p.unknownExtraField = "malicious";
        },
      },
      {
        name: "unknown extra field on message",
        mutate: (p) => {
          p.conversations[0].messages[0].extraField = 999;
        },
      },
      {
        name: "invalid message payload JSON format",
        mutate: (p) => {
          p.conversations[0].messages[0].versions[0].plaintext =
            JSON.stringify({ type: "TEXT", extra: "not allowed in TEXT" });
        },
      },
      {
        name: "wrong schema number",
        mutate: (p) => {
          p.schema = 2;
        },
      },
      {
        name: "wrong exporter structure",
        mutate: (p) => {
          p.exporter = "not_an_object";
        },
      },
    ];

    for (const testCase of hostilePayloads) {
      const payloadClone = JSON.parse(JSON.stringify(baseValidPayload));
      testCase.mutate(payloadClone);
      const encryptedFile = await encryptRawPayload(payloadClone);

      await expect(
        importChats({
          file: encryptedFile,
          passphrase: TEST_PASSPHRASE,
          messages: store,
          userId,
          testOverrides: { minKdfIterations: FAST_ITERATIONS },
        }),
      ).rejects.toThrowError(
        expect.objectContaining({ code: "invalid_payload" }),
      );

      // Verify store snapshot remains completely empty
      const messages = await store.listMessages(validConvId);
      expect(messages).toHaveLength(0);
    }
  });

  it("l. Exclusions & Source Audit: SENDING, FAILED, decryptFailed excluded; deleted has no text; no Signal store imports", async () => {
    const { store, userId } = createStore("exclusions_l");
    const convId = "c1111111-1111-4111-8111-111111111111";

    // 1. Confirmed normal message
    const msgNormalId = "11111111-1111-4111-8111-111111111111";
    await store.putMessage({
      id: msgNormalId,
      conversationId: convId,
      senderId: userId,
      createdAt: "2026-03-01T10:00:00.000Z",
      status: "SENT",
      currentVersion: 1,
    });
    await store.addVersion({
      messageId: msgNormalId,
      versionNo: 1,
      plaintext: encodeMessagePayload({ type: "TEXT", text: "Normal message" }),
      action: "CREATE",
      createdAt: "2026-03-01T10:00:00.000Z",
    });

    // 2. SENDING message (unconfirmed)
    const msgSendingId = "22222222-2222-4222-8222-222222222222";
    await store.putMessage({
      id: msgSendingId,
      conversationId: convId,
      senderId: userId,
      createdAt: "2026-03-01T10:01:00.000Z",
      status: "SENDING",
      currentVersion: 1,
    });

    // 3. FAILED message
    const msgFailedId = "33333333-3333-4333-8333-333333333333";
    await store.putMessage({
      id: msgFailedId,
      conversationId: convId,
      senderId: userId,
      createdAt: "2026-03-01T10:02:00.000Z",
      status: "FAILED",
      currentVersion: 1,
    });

    // 4. decryptFailed message (own_unavailable placeholder)
    const msgDecryptFailedId = "44444444-4444-4444-8444-444444444444";
    await store.putMessage({
      id: msgDecryptFailedId,
      conversationId: convId,
      senderId: userId,
      createdAt: "2026-03-01T10:03:00.000Z",
      status: "DELIVERED",
      currentVersion: 1,
      decryptFailed: true,
      decryptErrorCode: "own_unavailable",
    });

    // 5. Deleted message
    const msgDeletedId = "55555555-5555-4555-8555-555555555555";
    await store.putMessage({
      id: msgDeletedId,
      conversationId: convId,
      senderId: userId,
      createdAt: "2026-03-01T10:04:00.000Z",
      status: "READ",
      currentVersion: 1,
    });
    await store.addVersion({
      messageId: msgDeletedId,
      versionNo: 1,
      plaintext: encodeMessagePayload({ type: "TEXT", text: "Confidential deleted text" }),
      action: "CREATE",
      createdAt: "2026-03-01T10:04:00.000Z",
    });
    await store.markDeleted(msgDeletedId, {
      at: "2026-03-01T10:05:00.000Z",
      by: userId,
    });

    const exportRes = await exportChats({
      messages: store,
      userId,
      conversations: [{ id: convId, peerId: "peer" }],
      passphrase: TEST_PASSPHRASE,
      testOverrides: { kdfIterations: FAST_ITERATIONS },
    });

    // Expect exactly 2 messages in export: msgNormalId and msgDeletedId
    expect(exportRes.counts.messages).toBe(2);
    expect(exportRes.counts.tombstones).toBe(1);

    // Decrypt and inspect payload structure
    const fileContainer = JSON.parse(new TextDecoder().decode(exportRes.bytes));
    expect(Object.keys(fileContainer).sort()).toEqual(
      ["cipher", "data", "format", "kdf", "version"].sort(),
    );

    // Verify deleted text is nowhere in the file
    const rawFileText = new TextDecoder().decode(exportRes.bytes);
    expect(rawFileText.includes("Confidential deleted text")).toBe(false);

    // Check module source does NOT import IndexedDBSignalStore
    const chatExportPath = path.resolve(__dirname, "chatExport.ts");
    const sourceCode = fs.readFileSync(chatExportPath, "utf-8");
    expect(sourceCode).not.toContain("IndexedDBSignalStore");
  });

  it("m. Size: files exceeding maxFileBytes rejected with 'file_too_large'; 1500 messages round trip", async () => {
    const { store, userId } = createStore("size_m");
    const convId = "c1111111-1111-4111-8111-111111111111";

    const dummyFile = new Uint8Array(100);
    // Max file bytes check before parsing
    await expect(
      importChats({
        file: dummyFile,
        passphrase: TEST_PASSPHRASE,
        messages: store,
        userId,
        maxFileBytes: 50, // override with 50 bytes
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "file_too_large" }),
    );

    // 1,500 messages round trip
    const count = 1500;
    const baseTime = Date.parse("2026-03-01T00:00:00.000Z");

    for (let i = 0; i < count; i++) {
      const hex = i.toString(16).padStart(12, "0");
      const id = `00000000-0000-4000-8000-${hex}`;
      const iso = new Date(baseTime + i * 1000).toISOString();
      await store.putMessage({
        id,
        conversationId: convId,
        senderId: userId,
        createdAt: iso,
        status: "SENT",
        currentVersion: 1,
      });
      await store.addVersion({
        messageId: id,
        versionNo: 1,
        plaintext: encodeMessagePayload({ type: "TEXT", text: `Msg #${i}` }),
        action: "CREATE",
        createdAt: iso,
      });
    }

    const exportRes = await exportChats({
      messages: store,
      userId,
      conversations: [{ id: convId, peerId: "peer_m" }],
      passphrase: TEST_PASSPHRASE,
      testOverrides: { kdfIterations: FAST_ITERATIONS },
    });

    expect(exportRes.counts.messages).toBe(count);

    await store.wipe();
    const freshStore = new MessageStore(userId);
    storesToWipe.push(freshStore);

    const importRes = await importChats({
      file: exportRes.bytes,
      passphrase: TEST_PASSPHRASE,
      messages: freshStore,
      userId,
      testOverrides: { minKdfIterations: FAST_ITERATIONS },
    });

    expect(importRes.messagesAdded).toBe(count);
    const totalStored = await freshStore.countMessages(convId);
    expect(totalStored).toBe(count);
  }, 45000);

  it("n. nothing_to_export: exporting conversations with no exportable messages throws ExportError 'nothing_to_export'", async () => {
    const { store, userId } = createStore("empty_n");
    const convId = "c1111111-1111-4111-8111-111111111111";

    // 1. Completely empty conversation
    await expect(
      exportChats({
        messages: store,
        userId,
        conversations: [{ id: convId, peerId: "peer" }],
        passphrase: TEST_PASSPHRASE,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "nothing_to_export" }),
    );

    // 2. Conversation with only unconfirmed SENDING and FAILED messages
    await store.putMessage({
      id: "11111111-1111-4111-8111-111111111111",
      conversationId: convId,
      senderId: userId,
      createdAt: "2026-03-01T10:00:00.000Z",
      status: "SENDING",
      currentVersion: 1,
    });
    await store.putMessage({
      id: "22222222-2222-4222-8222-222222222222",
      conversationId: convId,
      senderId: userId,
      createdAt: "2026-03-01T10:01:00.000Z",
      status: "FAILED",
      currentVersion: 1,
    });

    await expect(
      exportChats({
        messages: store,
        userId,
        conversations: [{ id: convId, peerId: "peer" }],
        passphrase: TEST_PASSPHRASE,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "nothing_to_export" }),
    );
  });

  it("o. triggerBrowserDownload: exactly one click, sanitized filename ending with .nullspace, revokes object URL", () => {
    let clickCount = 0;
    let anchorHref = "";
    let anchorDownload = "";
    let removed = false;
    let createdUrl = "";
    let revokedUrl = "";

    const fakeAnchor = {
      style: {} as Record<string, string>,
      set href(v: string) {
        anchorHref = v;
      },
      get href() {
        return anchorHref;
      },
      set download(v: string) {
        anchorDownload = v;
      },
      get download() {
        return anchorDownload;
      },
      click() {
        clickCount++;
      },
      parentNode: {
        removeChild(c: unknown) {
          if (c === fakeAnchor) removed = true;
        },
      },
    };

    const fakeDoc = {
      createElement(tag: string) {
        if (tag === "a") return fakeAnchor;
        return {};
      },
      body: {
        appendChild() {},
      },
    } as unknown as Document;

    const fakeURL = {
      createObjectURL() {
        createdUrl = "blob:nullspace-test-blob";
        return createdUrl;
      },
      revokeObjectURL(url: string) {
        revokedUrl = url;
      },
    } as unknown as typeof URL;

    triggerBrowserDownload(
      new Uint8Array([1, 2, 3]),
      "../../unsafe/path/chat-Alice.export.nullspace",
      { document: fakeDoc, URL: fakeURL },
    );

    expect(clickCount).toBe(1);
    expect(anchorDownload.endsWith(".nullspace")).toBe(true);
    expect(anchorDownload).not.toContain("/");
    expect(anchorDownload).not.toContain("\\");
    expect(removed).toBe(true);
    expect(revokedUrl).toBe(createdUrl);

    // Test that revokeObjectURL is called even if click throws
    const throwingAnchor = {
      ...fakeAnchor,
      click() {
        throw new Error("Click failed");
      },
    };
    const throwingDoc = {
      createElement(tag: string) {
        if (tag === "a") return throwingAnchor;
        return {};
      },
      body: { appendChild() {} },
    } as unknown as Document;

    expect(() => {
      triggerBrowserDownload(new Uint8Array([4, 5, 6]), "test.nullspace", {
        document: throwingDoc,
        URL: fakeURL,
      });
    }).toThrow("Click failed");

    expect(revokedUrl).toBe(createdUrl);
  });

  it("p. Pagination: conversation with 450 messages exports completely across pages in stable order", async () => {
    const { store, userId } = createStore("pagination_p");
    const convId = "c1111111-1111-4111-8111-111111111111";
    const totalCount = 450;
    const baseTime = Date.parse("2026-03-01T00:00:00.000Z");
    const expectedIds: string[] = [];

    for (let i = 0; i < totalCount; i++) {
      const hex = i.toString(16).padStart(12, "0");
      const id = `10000000-0000-4000-8000-${hex}`;
      expectedIds.push(id);
      const iso = new Date(baseTime + i * 1000).toISOString();
      await store.putMessage({
        id,
        conversationId: convId,
        senderId: userId,
        createdAt: iso,
        status: "DELIVERED",
        currentVersion: 1,
      });
      await store.addVersion({
        messageId: id,
        versionNo: 1,
        plaintext: encodeMessagePayload({ type: "TEXT", text: `Paged message ${i}` }),
        action: "CREATE",
        createdAt: iso,
      });
    }

    const exportRes = await exportChats({
      messages: store,
      userId,
      conversations: [{ id: convId, peerId: "peer_p" }],
      passphrase: TEST_PASSPHRASE,
      testOverrides: { kdfIterations: FAST_ITERATIONS },
    });

    expect(exportRes.counts.messages).toBe(totalCount);

    await store.wipe();

    // Decrypt and verify all 450 IDs are present in stable chronological order
    const freshStore = new MessageStore(userId);
    storesToWipe.push(freshStore);

    const importRes = await importChats({
      file: exportRes.bytes,
      passphrase: TEST_PASSPHRASE,
      messages: freshStore,
      userId,
      testOverrides: { minKdfIterations: FAST_ITERATIONS },
    });

    expect(importRes.messagesAdded).toBe(totalCount);
    const messages = await freshStore.listMessages(convId, { limit: 500 });
    // listMessages returns newest first
    expect(messages).toHaveLength(totalCount);
    const localIdsAscending = messages.map((m) => m.id).reverse();
    expect(localIdsAscending).toEqual(expectedIds);
  });
});
