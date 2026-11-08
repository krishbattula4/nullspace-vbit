import { afterEach, describe, expect, it } from "vitest";
import { IndexedDBSignalStore, areArrayBuffersEqual } from "./IndexedDBSignalStore";
import { runSpike } from "./spike";
import {
  ensureIdentity,
  generateSignedPreKey,
  generateOneTimePreKeys,
  buildPreKeyBundle,
} from "./keys";

function createBuffer(bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

describe("IndexedDBSignalStore", () => {
  const testStores: IndexedDBSignalStore[] = [];

  const createStore = (userId: string): IndexedDBSignalStore => {
    const store = new IndexedDBSignalStore(userId);
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

  it("saves and loads every record type, and remove methods delete records", async () => {
    const store = createStore("test-crud-user");

    // 1. Identity key pair
    const pubKey = createBuffer([1, 2, 3, 4]);
    const privKey = createBuffer([5, 6, 7, 8]);
    await store.setIdentityKeyPair({ pubKey, privKey });
    const loadedIdentity = await store.getIdentityKeyPair();
    expect(loadedIdentity).toBeDefined();
    expect(areArrayBuffersEqual(loadedIdentity!.pubKey, pubKey)).toBe(true);
    expect(areArrayBuffersEqual(loadedIdentity!.privKey, privKey)).toBe(true);

    // 2. Registration ID
    await store.setLocalRegistrationId(9999);
    const loadedRegId = await store.getLocalRegistrationId();
    expect(loadedRegId).toBe(9999);

    // 3. Trusted identity
    const trustedKey = createBuffer([11, 22, 33]);
    const isFirstUseTrusted = await store.isTrustedIdentity("alice.1", trustedKey);
    expect(isFirstUseTrusted).toBe(true);
    expect(await store.loadIdentityKey("alice.1")).toBeUndefined(); // TOFU does not save

    const replaced = await store.saveIdentity("alice.1", trustedKey);
    expect(replaced).toBe(false); // First save is not a replacement of existing differing key

    const loadedTrusted = await store.loadIdentityKey("alice.1");
    expect(loadedTrusted).toBeDefined();
    expect(areArrayBuffersEqual(loadedTrusted!, trustedKey)).toBe(true);
    // Root name lookup
    expect(await store.isTrustedIdentity("alice", trustedKey)).toBe(true);

    await store.removeIdentityKey("alice.1");
    expect(await store.loadIdentityKey("alice.1")).toBeUndefined();
    expect(await store.loadIdentityKey("alice")).toBeUndefined();

    // 4. PreKeys
    const preKeyPair = {
      pubKey: createBuffer([21, 22]),
      privKey: createBuffer([23, 24]),
    };
    await store.storePreKey(101, preKeyPair);
    const loadedPreKey = await store.loadPreKey(101);
    expect(loadedPreKey).toBeDefined();
    expect(areArrayBuffersEqual(loadedPreKey!.pubKey, preKeyPair.pubKey)).toBe(true);
    // Test string normalization
    const loadedPreKeyByStr = await store.loadPreKey("101");
    expect(loadedPreKeyByStr).toBeDefined();

    expect(await store.listPreKeyIds()).toEqual([101]);

    await store.removePreKey(101);
    expect(await store.loadPreKey(101)).toBeUndefined();
    expect(await store.loadPreKey("101")).toBeUndefined();
    expect(await store.listPreKeyIds()).toEqual([]);

    // 5. Signed PreKeys
    const signedKeyPair = {
      pubKey: createBuffer([31, 32]),
      privKey: createBuffer([33, 34]),
    };
    const signature = createBuffer([41, 42, 43]);
    await store.storeSignedPreKey(202, signedKeyPair, signature);
    const loadedSigned = await store.loadSignedPreKey(202);
    expect(loadedSigned).toBeDefined();
    expect(areArrayBuffersEqual(loadedSigned!.pubKey, signedKeyPair.pubKey)).toBe(true);
    expect(areArrayBuffersEqual(loadedSigned!.privKey, signedKeyPair.privKey)).toBe(true);
    expect(loadedSigned!.signature).toBeDefined();
    expect(areArrayBuffersEqual(loadedSigned!.signature!, signature)).toBe(true);

    expect(await store.getSignedPreKeyIds()).toEqual([202]);

    await store.removeSignedPreKey(202);
    expect(await store.loadSignedPreKey(202)).toBeUndefined();
    expect(await store.getSignedPreKeyIds()).toEqual([]);

    // 6. Sessions
    await store.storeSession("charlie.1", "session-record-1");
    await store.storeSession("charlie.2", "session-record-2");
    await store.storeSession("david.1", "session-record-3");

    expect(await store.loadSession("charlie.1")).toBe("session-record-1");
    expect(await store.loadSession("charlie.2")).toBe("session-record-2");

    await store.removeSession("charlie.1");
    expect(await store.loadSession("charlie.1")).toBeUndefined();
    expect(await store.loadSession("charlie.2")).toBe("session-record-2");

    await store.removeAllSessions("charlie");
    expect(await store.loadSession("charlie.2")).toBeUndefined();
    expect(await store.loadSession("david.1")).toBe("session-record-3");

    await store.removeAllSessions();
    expect(await store.loadSession("david.1")).toBeUndefined();
  });

  it("persists records across different store instances with the same userId (simulating page reload)", async () => {
    const userId = "persistence-user";
    const store1 = createStore(userId);

    const pubKey = createBuffer([100, 101]);
    const privKey = createBuffer([102, 103]);
    await store1.setIdentityKeyPair({ pubKey, privKey });
    await store1.setLocalRegistrationId(54321);

    const contactKey = createBuffer([200, 201]);
    await store1.saveIdentity("contact.1", contactKey);

    const preKey = { pubKey: createBuffer([1]), privKey: createBuffer([2]) };
    await store1.storePreKey(5, preKey);

    const signedPreKey = { pubKey: createBuffer([3]), privKey: createBuffer([4]) };
    const sig = createBuffer([9, 9, 9]);
    await store1.storeSignedPreKey(6, signedPreKey, sig);

    await store1.storeSession("contact.1", "persisted-session-string");

    // Open a brand new store instance with the same userId
    const store2 = createStore(userId);

    const reloadedIdentity = await store2.getIdentityKeyPair();
    expect(reloadedIdentity).toBeDefined();
    expect(areArrayBuffersEqual(reloadedIdentity!.pubKey, pubKey)).toBe(true);
    expect(reloadedIdentity!.pubKey instanceof ArrayBuffer).toBe(true);
    expect(reloadedIdentity!.privKey instanceof ArrayBuffer).toBe(true);

    expect(await store2.getLocalRegistrationId()).toBe(54321);

    const reloadedContactKey = await store2.loadIdentityKey("contact.1");
    expect(reloadedContactKey).toBeDefined();
    expect(areArrayBuffersEqual(reloadedContactKey!, contactKey)).toBe(true);

    const reloadedPreKey = await store2.loadPreKey(5);
    expect(reloadedPreKey).toBeDefined();
    expect(areArrayBuffersEqual(reloadedPreKey!.pubKey, preKey.pubKey)).toBe(true);

    const reloadedSigned = await store2.loadSignedPreKey(6);
    expect(reloadedSigned).toBeDefined();
    expect(areArrayBuffersEqual(reloadedSigned!.signature!, sig)).toBe(true);

    expect(await store2.loadSession("contact.1")).toBe("persisted-session-string");
  });

  it("isolates data between different userIds", async () => {
    const aliceStore = createStore("user-alice-isolated");
    const bobStore = createStore("user-bob-isolated");

    await aliceStore.setIdentityKeyPair({
      pubKey: createBuffer([1, 1, 1]),
      privKey: createBuffer([2, 2, 2]),
    });
    await aliceStore.setLocalRegistrationId(1111);
    await aliceStore.storeSession("shared-contact.1", "alice-session");
    await aliceStore.storePreKey(1, {
      pubKey: createBuffer([3, 3]),
      privKey: createBuffer([4, 4]),
    });

    expect(await bobStore.getIdentityKeyPair()).toBeUndefined();
    expect(await bobStore.getLocalRegistrationId()).toBeUndefined();
    expect(await bobStore.loadSession("shared-contact.1")).toBeUndefined();
    expect(await bobStore.loadPreKey(1)).toBeUndefined();
  });

  it("identityChanged returns false for matching key and true for mismatched key without modifying stored key", async () => {
    const store = createStore("identity-change-user");
    const originalKey = createBuffer([10, 20, 30, 40]);
    const alteredKey = createBuffer([10, 20, 30, 99]);

    // Unstored identity reports no change
    expect(await store.identityChanged("partner.1", originalKey)).toBe(false);

    // Save initial identity
    await store.saveIdentity("partner.1", originalKey);

    // Same key matches
    expect(await store.identityChanged("partner.1", originalKey)).toBe(false);
    expect(await store.identityChanged("partner", originalKey)).toBe(false);

    // Altered key reports mismatch (true)
    expect(await store.identityChanged("partner.1", alteredKey)).toBe(true);
    expect(await store.identityChanged("partner", alteredKey)).toBe(true);

    // Verify stored key was not altered
    const stored = await store.loadIdentityKey("partner.1");
    expect(stored).toBeDefined();
    expect(areArrayBuffersEqual(stored!, originalKey)).toBe(true);
  });

  it("end to end: runs the spike flow with IndexedDBSignalStore instances and decrypts 'hello'", async () => {
    const timestamp = Date.now();
    const aliceId = `e2e-alice-${timestamp}`;
    const bobId = `e2e-bob-${timestamp}`;

    const aliceStore = createStore(aliceId);
    const bobStore = createStore(bobId);

    const result = await runSpike(async (userId) => {
      if (userId === "alice") return aliceStore;
      if (userId === "bob") return bobStore;
      return createStore(`e2e-${userId}-${timestamp}`);
    });

    expect(result.decrypted).toBe("hello");
    expect(result.library).toBe("@privacyresearch/libsignal-protocol-typescript");

    // Verify Bob's store persisted the session and Alice's identity
    const bobSession = await bobStore.loadSession("alice.1");
    expect(bobSession).toBeDefined();
    expect(typeof bobSession).toBe("string");

    const aliceTrusted = await bobStore.loadIdentityKey("alice.1");
    expect(aliceTrusted).toBeDefined();
  });

  it("wipe() completely deletes and empties the database", async () => {
    const userId = "wipe-test-user";
    const store = createStore(userId);

    await store.setIdentityKeyPair({
      pubKey: createBuffer([1]),
      privKey: createBuffer([2]),
    });
    await store.setLocalRegistrationId(777);
    await store.storePreKey(1, { pubKey: createBuffer([3]), privKey: createBuffer([4]) });
    await store.storeSession("test.1", "session");

    await store.wipe();

    const freshStore = createStore(userId);
    expect(await freshStore.getIdentityKeyPair()).toBeUndefined();
    expect(await freshStore.getLocalRegistrationId()).toBeUndefined();
    expect(await freshStore.loadPreKey(1)).toBeUndefined();
    expect(await freshStore.loadSession("test.1")).toBeUndefined();
  });

  describe("keys.ts cryptographic key helpers", () => {
    it("ensureIdentity generates once and returns existing on subsequent calls", async () => {
      const store = createStore("ensure-identity-user");

      const initial = await ensureIdentity(store);
      expect(initial.identityKeyPair).toBeDefined();
      expect(initial.identityKeyPair.pubKey.byteLength).toBe(33);
      expect(initial.registrationId).toBeGreaterThan(0);

      const second = await ensureIdentity(store);
      expect(
        areArrayBuffersEqual(second.identityKeyPair.pubKey, initial.identityKeyPair.pubKey),
      ).toBe(true);
      expect(second.registrationId).toBe(initial.registrationId);
    });

    it("generateSignedPreKey, generateOneTimePreKeys, and buildPreKeyBundle assemble a valid bundle", async () => {
      const store = createStore("bundle-user");
      const { identityKeyPair, registrationId } = await ensureIdentity(store);

      const signedPreKey = await generateSignedPreKey(store, identityKeyPair, 1);
      expect(signedPreKey.keyId).toBe(1);
      expect(signedPreKey.publicKey.byteLength).toBe(33);
      expect(signedPreKey.signature.byteLength).toBe(64);

      const oneTimeKeys = await generateOneTimePreKeys(store, 100, 5);
      expect(oneTimeKeys).toHaveLength(5);
      expect(oneTimeKeys[0].keyId).toBe(100);
      expect(oneTimeKeys[4].keyId).toBe(104);

      const bundle = await buildPreKeyBundle(store, 1, 100);
      expect(bundle.registrationId).toBe(registrationId);
      expect(areArrayBuffersEqual(bundle.identityKey, identityKeyPair.pubKey)).toBe(true);
      expect(bundle.signedPreKey.keyId).toBe(1);
      expect(areArrayBuffersEqual(bundle.signedPreKey.publicKey, signedPreKey.publicKey)).toBe(
        true,
      );
      expect(areArrayBuffersEqual(bundle.signedPreKey.signature, signedPreKey.signature)).toBe(
        true,
      );
      expect(bundle.preKey).toBeDefined();
      expect(bundle.preKey!.keyId).toBe(100);
      expect(areArrayBuffersEqual(bundle.preKey!.publicKey, oneTimeKeys[0].publicKey)).toBe(true);
    });
  });
});
