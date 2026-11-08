import { describe, it, expect, afterEach, vi } from "vitest";
import { IndexedDBSignalStore, areArrayBuffersEqual } from "./IndexedDBSignalStore";
import { provisionKeys, countOneTimePreKeys } from "./provision";
import {
  InMemoryBundleProvider,
  HttpBundleProvider,
  BundleFetchError,
} from "./bundleProvider";
import { SessionManager, IdentityChangedError } from "./session";
import type { PublicPreKeyBundle } from "./bundle";

describe("SessionManager and X3DH Sessions", () => {
  const userIdsToWipe = new Set<string>();

  function trackUser(userId: string): string {
    userIdsToWipe.add(userId);
    return userId;
  }

  afterEach(async () => {
    for (const userId of userIdsToWipe) {
      const store = new IndexedDBSignalStore(userId);
      await store.wipe();
    }
    userIdsToWipe.clear();
    vi.restoreAllMocks();
  });

  // Test a: First message
  it("a. First message: alice has no session with bob; alice.encrypt produces type 3; bob.decrypt returns the plaintext", async () => {
    const aliceId = trackUser("alice-test-a");
    const bobId = trackUser("bob-test-a");

    const aliceStore = new IndexedDBSignalStore(aliceId);
    const bobStore = new IndexedDBSignalStore(bobId);

    const aliceProvision = await provisionKeys(aliceId, aliceStore);
    const bobProvision = await provisionKeys(bobId, bobStore);

    const bundles = new InMemoryBundleProvider();
    bundles.register(aliceProvision.bundle);
    bundles.register(bobProvision.bundle);

    const aliceManager = new SessionManager(aliceId, aliceStore, bundles);
    const bobManager = new SessionManager(bobId, bobStore, bundles);

    expect(await aliceManager.hasSession(bobId)).toBe(false);

    const plaintext = "Hello Bob!";
    const envelope = await aliceManager.encrypt(bobId, plaintext);

    expect(envelope.type).toBe(3); // PreKeyWhisperMessage
    expect(typeof envelope.body).toBe("string");
    expect(envelope.body.length).toBeGreaterThan(0);
    expect(await aliceManager.hasSession(bobId)).toBe(true);

    const decrypted = await bobManager.decrypt(aliceId, envelope);
    expect(decrypted).toBe(plaintext);
    expect(await bobManager.hasSession(aliceId)).toBe(true);
  });

  // Test b: Reply and ratchet
  it("b. Reply: bob.encrypt to alice produces a message alice.decrypt returns correctly; after the exchange, alice's next message to bob is type 1", async () => {
    const aliceId = trackUser("alice-test-b");
    const bobId = trackUser("bob-test-b");

    const aliceStore = new IndexedDBSignalStore(aliceId);
    const bobStore = new IndexedDBSignalStore(bobId);

    const aliceProvision = await provisionKeys(aliceId, aliceStore);
    const bobProvision = await provisionKeys(bobId, bobStore);

    const bundles = new InMemoryBundleProvider();
    bundles.register(aliceProvision.bundle);
    bundles.register(bobProvision.bundle);

    const aliceManager = new SessionManager(aliceId, aliceStore, bundles);
    const bobManager = new SessionManager(bobId, bobStore, bundles);

    // 1. Alice sends first message (type 3)
    const env1 = await aliceManager.encrypt(bobId, "Message 1 from Alice");
    expect(env1.type).toBe(3);
    const bobDecrypted1 = await bobManager.decrypt(aliceId, env1);
    expect(bobDecrypted1).toBe("Message 1 from Alice");

    // 2. Bob replies to Alice (type 1)
    const env2 = await bobManager.encrypt(aliceId, "Reply from Bob");
    expect(env2.type).toBe(1);
    const aliceDecrypted2 = await aliceManager.decrypt(bobId, env2);
    expect(aliceDecrypted2).toBe("Reply from Bob");

    // 3. Alice sends next message to Bob (ratcheted, type 1)
    const env3 = await aliceManager.encrypt(bobId, "Message 2 from Alice");
    expect(env3.type).toBe(1);
    const bobDecrypted3 = await bobManager.decrypt(aliceId, env3);
    expect(bobDecrypted3).toBe("Message 2 from Alice");
  });

  // Test c: One-time prekey consumption
  it("c. One-time prekey consumption: after bob decrypts the type 3 message, the one-time prekey used is removed from bob's store (count 99), and the InMemoryBundleProvider served exactly one prekey", async () => {
    const aliceId = trackUser("alice-test-c");
    const bobId = trackUser("bob-test-c");

    const aliceStore = new IndexedDBSignalStore(aliceId);
    const bobStore = new IndexedDBSignalStore(bobId);

    const aliceProvision = await provisionKeys(aliceId, aliceStore);
    const bobProvision = await provisionKeys(bobId, bobStore);

    const bundles = new InMemoryBundleProvider();
    bundles.register(aliceProvision.bundle);
    bundles.register(bobProvision.bundle);

    expect(await countOneTimePreKeys(bobStore)).toBe(100);

    const fetchSpy = vi.spyOn(bundles, "fetchBundle");

    const aliceManager = new SessionManager(aliceId, aliceStore, bundles);
    const bobManager = new SessionManager(bobId, bobStore, bundles);

    const env = await aliceManager.encrypt(bobId, "Consuming OPK");
    expect(env.type).toBe(3);

    // Assert bundle provider served exactly one one-time prekey
    expect(fetchSpy).toHaveBeenCalledWith(bobId);
    const fetchedResult = await fetchSpy.mock.results[0].value;
    expect(fetchedResult.oneTimePreKeys).toHaveLength(1);
    const consumedKeyId = fetchedResult.oneTimePreKeys[0].keyId;

    // Bob still has 100 prekeys before decrypting
    expect(await countOneTimePreKeys(bobStore)).toBe(100);

    // Bob decrypts
    const decrypted = await bobManager.decrypt(aliceId, env);
    expect(decrypted).toBe("Consuming OPK");

    // After decryption, Bob's store has 99 prekeys and the consumed key is gone
    expect(await countOneTimePreKeys(bobStore)).toBe(99);
    expect(await bobStore.loadPreKey(consumedKeyId)).toBeUndefined();
  });

  // Test d: No one-time prekeys left
  it("d. No one-time prekeys left: provider with an emptied list still allows session setup (signed prekey only) and messages decrypt", async () => {
    const aliceId = trackUser("alice-test-d");
    const bobId = trackUser("bob-test-d");

    const aliceStore = new IndexedDBSignalStore(aliceId);
    const bobStore = new IndexedDBSignalStore(bobId);

    const aliceProvision = await provisionKeys(aliceId, aliceStore);
    const bobProvision = await provisionKeys(bobId, bobStore);

    // Empty Bob's one-time prekeys in the bundle
    const emptyOpkBundle: PublicPreKeyBundle = {
      ...bobProvision.bundle,
      oneTimePreKeys: [],
    };

    const bundles = new InMemoryBundleProvider();
    bundles.register(aliceProvision.bundle);
    bundles.register(emptyOpkBundle);

    const aliceManager = new SessionManager(aliceId, aliceStore, bundles);
    const bobManager = new SessionManager(bobId, bobStore, bundles);

    const env = await aliceManager.encrypt(bobId, "Session without OPK");
    expect(env.type).toBe(3);

    const decrypted = await bobManager.decrypt(aliceId, env);
    expect(decrypted).toBe("Session without OPK");

    // Exchange continues with type 1 reply
    const reply = await bobManager.encrypt(aliceId, "Reply without OPK");
    expect(reply.type).toBe(1);
    expect(await aliceManager.decrypt(bobId, reply)).toBe("Reply without OPK");
  });

  // Test e: Persistence
  it("e. Persistence: create a NEW IndexedDBSignalStore and SessionManager for bob with the same userId; it decrypts the next type 1 message from alice without any new bundle fetch (assert fetchBundle was not called)", async () => {
    const aliceId = trackUser("alice-test-e");
    const bobId = trackUser("bob-test-e");

    const aliceStore = new IndexedDBSignalStore(aliceId);
    const bobStore = new IndexedDBSignalStore(bobId);

    const aliceProvision = await provisionKeys(aliceId, aliceStore);
    const bobProvision = await provisionKeys(bobId, bobStore);

    const bundles = new InMemoryBundleProvider();
    bundles.register(aliceProvision.bundle);
    bundles.register(bobProvision.bundle);

    const aliceManager = new SessionManager(aliceId, aliceStore, bundles);
    const bobManager1 = new SessionManager(bobId, bobStore, bundles);

    // First exchange establishing session
    const env1 = await aliceManager.encrypt(bobId, "Handshake message");
    await bobManager1.decrypt(aliceId, env1);

    // Bob replies to complete 2-way ratchet
    const reply1 = await bobManager1.encrypt(aliceId, "Handshake reply");
    await aliceManager.decrypt(bobId, reply1);

    // Close Bob's first store connection
    bobStore.close();

    // Alice produces a next ratcheted message (type 1)
    const env2 = await aliceManager.encrypt(bobId, "Persistent ratcheted message");
    expect(env2.type).toBe(1);

    // Spy on bundles to guarantee Bob does not fetch any bundle
    const fetchSpy = vi.spyOn(bundles, "fetchBundle");

    // Create a NEW store and SessionManager for Bob with same userId
    const newBobStore = new IndexedDBSignalStore(bobId);
    const newBobManager = new SessionManager(bobId, newBobStore, bundles);

    const decrypted2 = await newBobManager.decrypt(aliceId, env2);
    expect(decrypted2).toBe("Persistent ratcheted message");

    expect(fetchSpy).not.toHaveBeenCalled();
    newBobStore.close();
  });

  // Test f: Identity change
  it("f. Identity change: register a second provisioning of 'bob' with a fresh store (new identity key) under the same userId after alice already trusts the first; alice.ensureSession or encrypt must throw IdentityChangedError, and alice's stored trusted key for bob must be unchanged afterwards", async () => {
    const aliceId = trackUser("alice-test-f");
    const bobId = trackUser("bob-test-f");
    const bobFreshStoreId = trackUser("bob-fresh-test-f");

    const aliceStore = new IndexedDBSignalStore(aliceId);
    const bobStore1 = new IndexedDBSignalStore(bobId);

    const aliceProvision = await provisionKeys(aliceId, aliceStore);
    const bobProvision1 = await provisionKeys(bobId, bobStore1);

    const bundles = new InMemoryBundleProvider();
    bundles.register(aliceProvision.bundle);
    bundles.register(bobProvision1.bundle);

    const aliceManager = new SessionManager(aliceId, aliceStore, bundles);

    // Alice establishes session with Bob 1 and trusts Bob 1's identity key
    await aliceManager.ensureSession(bobId);
    const trustedKeyBefore = await aliceStore.loadIdentityKey(bobId);
    expect(trustedKeyBefore).toBeDefined();

    // Bob re-provisions with a fresh store (generating a new identity key)
    const bobFreshStore = new IndexedDBSignalStore(bobFreshStoreId);
    const bobProvision2 = await provisionKeys(bobId, bobFreshStore);

    expect(bobProvision2.bundle.identityKey).not.toBe(bobProvision1.bundle.identityKey);

    // Register Bob 2's new bundle under the same userId
    bundles.register(bobProvision2.bundle);

    // Clear Alice's session with Bob so Alice attempts a new handshake with Bob's bundle
    await aliceStore.removeSession(aliceManager.address(bobId).toString());
    expect(await aliceManager.hasSession(bobId)).toBe(false);

    // ensureSession must throw IdentityChangedError
    await expect(aliceManager.ensureSession(bobId)).rejects.toThrow(IdentityChangedError);

    // encrypt must also throw IdentityChangedError
    try {
      await aliceManager.encrypt(bobId, "hello");
      expect.fail("encrypt should have thrown IdentityChangedError");
    } catch (err) {
      expect(err).toBeInstanceOf(IdentityChangedError);
      expect((err as IdentityChangedError).peerId).toBe(bobId);
    }

    // Alice's stored trusted key for Bob must be unchanged afterwards
    const trustedKeyAfter = await aliceStore.loadIdentityKey(bobId);
    expect(trustedKeyAfter).toBeDefined();
    expect(areArrayBuffersEqual(trustedKeyBefore!, trustedKeyAfter!)).toBe(true);

    bobFreshStore.close();
  });

  // Test g: Unicode round trip
  it("g. Unicode round trip: 'नमस्ते 🔐' encrypts and decrypts intact", async () => {
    const aliceId = trackUser("alice-test-g");
    const bobId = trackUser("bob-test-g");

    const aliceStore = new IndexedDBSignalStore(aliceId);
    const bobStore = new IndexedDBSignalStore(bobId);

    const aliceProvision = await provisionKeys(aliceId, aliceStore);
    const bobProvision = await provisionKeys(bobId, bobStore);

    const bundles = new InMemoryBundleProvider();
    bundles.register(aliceProvision.bundle);
    bundles.register(bobProvision.bundle);

    const aliceManager = new SessionManager(aliceId, aliceStore, bundles);
    const bobManager = new SessionManager(bobId, bobStore, bundles);

    const unicodeText = "नमस्ते 🔐";
    const env = await aliceManager.encrypt(bobId, unicodeText);
    const decrypted = await bobManager.decrypt(aliceId, env);

    expect(decrypted).toBe(unicodeText);

    // Reply with more unicode / emoji
    const replyText = "Привет мир! 🌍🎉 123 ñ and \u0000 \uFFFF";
    const replyEnv = await bobManager.encrypt(aliceId, replyText);
    const decryptedReply = await aliceManager.decrypt(bobId, replyEnv);

    expect(decryptedReply).toBe(replyText);
  });

  // Test h: HttpBundleProvider
  describe("h. HttpBundleProvider", () => {
    it("with a mocked fetch returning a valid bundle it resolves, and the request carries the Bearer header", async () => {
      const mockUserId = trackUser("mock-alice");
      const store = new IndexedDBSignalStore(mockUserId);
      const provision = await provisionKeys(mockUserId, store);
      const validBundle = provision.bundle;

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => validBundle,
      });
      vi.stubGlobal("fetch", fetchMock);

      const provider = new HttpBundleProvider("https://api.nullspace.chat", () => "secret-jwt-token");
      const fetched = await provider.fetchBundle(mockUserId);

      expect(fetched).toEqual(validBundle);
      expect(fetchMock).toHaveBeenCalledWith(
        `https://api.nullspace.chat/keys/bundle/${mockUserId}`,
        {
          method: "GET",
          headers: {
            Authorization: "Bearer secret-jwt-token",
          },
        },
      );
    });

    it("throws BundleFetchError on 404 response", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: "Not found" }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const provider = new HttpBundleProvider("https://api.nullspace.chat", () => null);

      await expect(provider.fetchBundle("unknown-user")).rejects.toThrow(BundleFetchError);
      await expect(provider.fetchBundle("unknown-user")).rejects.toMatchObject({ status: 404 });
    });

    it("throws BundleFetchError on invalid body (malformed bundle shape)", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ userId: "alice", registrationId: "not-a-number" }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const provider = new HttpBundleProvider("https://api.nullspace.chat", () => null);

      await expect(provider.fetchBundle("alice")).rejects.toThrow(BundleFetchError);
    });

    it("throws BundleFetchError on network failure", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("Network connection refused"));
      vi.stubGlobal("fetch", fetchMock);

      const provider = new HttpBundleProvider("https://api.nullspace.chat", () => null);

      await expect(provider.fetchBundle("alice")).rejects.toThrow(BundleFetchError);
    });
  });
});
