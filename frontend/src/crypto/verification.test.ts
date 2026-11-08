import { describe, it, expect, afterEach } from "vitest";
import { KeyHelper } from "@privacyresearch/libsignal-protocol-typescript";
import {
  VerificationStore,
  attachVerification,
  stateLabel,
} from "./verification";
import { IndexedDBSignalStore, areArrayBuffersEqual } from "./IndexedDBSignalStore";
import { SessionManager, IdentityChangedError } from "./session";
import { InMemoryBundleProvider } from "./bundleProvider";
import { provisionKeys } from "./provision";

describe("VerificationStore & Verification State Machine (P4.3)", () => {
  const userIdsToWipe = new Set<string>();

  function trackUser(userId: string): string {
    userIdsToWipe.add(userId);
    return userId;
  }

  afterEach(async () => {
    for (const userId of userIdsToWipe) {
      const trustStore = new VerificationStore(userId);
      await trustStore.wipe();
      const signalStore = new IndexedDBSignalStore(userId);
      await signalStore.wipe();
    }
    userIdsToWipe.clear();
  });

  // Test a: recordFirstUse
  it("a. recordFirstUse creates UNVERIFIED with the given key; calling it again with a different key returns the ORIGINAL record unchanged", async () => {
    const userId = trackUser("user-a");
    const store = new VerificationStore(userId);

    const key1 = await KeyHelper.generateIdentityKeyPair();
    const key2 = await KeyHelper.generateIdentityKeyPair();

    // First use creates UNVERIFIED
    const first = await store.recordFirstUse("peer-1", key1.pubKey);
    expect(first.peerId).toBe("peer-1");
    expect(first.state).toBe("UNVERIFIED");
    expect(areArrayBuffersEqual(first.identityKey, key1.pubKey)).toBe(true);
    expect(first.verifiedAt).toBeUndefined();
    expect(first.previousIdentityKey).toBeUndefined();
    expect(first.changedAt).toBeUndefined();

    // Second call with different key returns original unchanged
    const second = await store.recordFirstUse("peer-1", key2.pubKey);
    expect(second.peerId).toBe("peer-1");
    expect(second.state).toBe("UNVERIFIED");
    expect(areArrayBuffersEqual(second.identityKey, key1.pubKey)).toBe(true);
    expect(areArrayBuffersEqual(second.identityKey, key2.pubKey)).toBe(false);

    // Verify persisted state matches
    const persisted = await store.get("peer-1");
    expect(persisted).toBeDefined();
    expect(persisted?.state).toBe("UNVERIFIED");
    expect(areArrayBuffersEqual(persisted!.identityKey, key1.pubKey)).toBe(true);

    store.close();
  });

  // Test b: markVerified
  it("b. markVerified moves UNVERIFIED -> VERIFIED and sets verifiedAt; throws for an unknown peer", async () => {
    const userId = trackUser("user-b");
    const store = new VerificationStore(userId);

    const key = await KeyHelper.generateIdentityKeyPair();
    await store.recordFirstUse("peer-b", key.pubKey);

    const verified = await store.markVerified("peer-b");
    expect(verified.peerId).toBe("peer-b");
    expect(verified.state).toBe("VERIFIED");
    expect(verified.verifiedAt).toBeDefined();
    expect(Number.isNaN(Date.parse(verified.verifiedAt!))).toBe(false);

    const retrieved = await store.get("peer-b");
    expect(retrieved?.state).toBe("VERIFIED");
    expect(retrieved?.verifiedAt).toBe(verified.verifiedAt);

    // Throws for unknown peer
    await expect(store.markVerified("non-existent-peer")).rejects.toThrow(
      "Cannot mark unknown peer as verified: non-existent-peer",
    );

    store.close();
  });

  // Test c: observeIdentity with same key
  it("c. observeIdentity with the same key leaves state and record untouched (VERIFIED stays VERIFIED)", async () => {
    const userId = trackUser("user-c");
    const store = new VerificationStore(userId);

    const key = await KeyHelper.generateIdentityKeyPair();
    await store.recordFirstUse("peer-c", key.pubKey);
    const initialVerified = await store.markVerified("peer-c");

    const result = await store.observeIdentity("peer-c", key.pubKey);
    expect(result.changed).toBe(false);
    expect(result.record.state).toBe("VERIFIED");
    expect(result.record.verifiedAt).toBe(initialVerified.verifiedAt);
    expect(result.record.previousIdentityKey).toBeUndefined();
    expect(result.record.changedAt).toBeUndefined();
    expect(areArrayBuffersEqual(result.record.identityKey, key.pubKey)).toBe(true);

    store.close();
  });

  // Test d: observeIdentity with different key from VERIFIED
  it("d. observeIdentity with a different key moves VERIFIED -> KEY_CHANGED, stores previousIdentityKey = old key, identityKey = new key, changed=true", async () => {
    const userId = trackUser("user-d");
    const store = new VerificationStore(userId);

    const oldKey = await KeyHelper.generateIdentityKeyPair();
    const newKey = await KeyHelper.generateIdentityKeyPair();

    await store.recordFirstUse("peer-d", oldKey.pubKey);
    await store.markVerified("peer-d");

    const result = await store.observeIdentity("peer-d", newKey.pubKey);
    expect(result.changed).toBe(true);
    expect(result.record.state).toBe("KEY_CHANGED");
    expect(areArrayBuffersEqual(result.record.identityKey, newKey.pubKey)).toBe(true);
    expect(result.record.previousIdentityKey).toBeDefined();
    expect(areArrayBuffersEqual(result.record.previousIdentityKey!, oldKey.pubKey)).toBe(true);
    expect(result.record.changedAt).toBeDefined();
    expect(Number.isNaN(Date.parse(result.record.changedAt!))).toBe(false);

    // Verify persisted
    const persisted = await store.get("peer-d");
    expect(persisted?.state).toBe("KEY_CHANGED");
    expect(areArrayBuffersEqual(persisted!.identityKey, newKey.pubKey)).toBe(true);
    expect(areArrayBuffersEqual(persisted!.previousIdentityKey!, oldKey.pubKey)).toBe(true);

    store.close();
  });

  // Test e: observeIdentity with different key from UNVERIFIED
  it("e. observeIdentity with a different key from UNVERIFIED also gives KEY_CHANGED", async () => {
    const userId = trackUser("user-e");
    const store = new VerificationStore(userId);

    const oldKey = await KeyHelper.generateIdentityKeyPair();
    const newKey = await KeyHelper.generateIdentityKeyPair();

    await store.recordFirstUse("peer-e", oldKey.pubKey);
    const before = await store.get("peer-e");
    expect(before?.state).toBe("UNVERIFIED");

    const result = await store.observeIdentity("peer-e", newKey.pubKey);
    expect(result.changed).toBe(true);
    expect(result.record.state).toBe("KEY_CHANGED");
    expect(areArrayBuffersEqual(result.record.identityKey, newKey.pubKey)).toBe(true);
    expect(areArrayBuffersEqual(result.record.previousIdentityKey!, oldKey.pubKey)).toBe(true);
    expect(result.record.changedAt).toBeDefined();

    store.close();
  });

  // Test f: markVerified from KEY_CHANGED
  it("f. markVerified from KEY_CHANGED gives VERIFIED and clears previousIdentityKey and changedAt", async () => {
    const userId = trackUser("user-f");
    const store = new VerificationStore(userId);

    const key1 = await KeyHelper.generateIdentityKeyPair();
    const key2 = await KeyHelper.generateIdentityKeyPair();

    await store.recordFirstUse("peer-f", key1.pubKey);
    await store.observeIdentity("peer-f", key2.pubKey); // KEY_CHANGED

    const beforeMark = await store.get("peer-f");
    expect(beforeMark?.state).toBe("KEY_CHANGED");
    expect(beforeMark?.previousIdentityKey).toBeDefined();
    expect(beforeMark?.changedAt).toBeDefined();

    // Re-verify the new key
    const marked = await store.markVerified("peer-f");
    expect(marked.state).toBe("VERIFIED");
    expect(areArrayBuffersEqual(marked.identityKey, key2.pubKey)).toBe(true);
    expect(marked.previousIdentityKey).toBeUndefined();
    expect(marked.changedAt).toBeUndefined();
    expect(marked.verifiedAt).toBeDefined();

    // Check store persistence
    const reloaded = await store.get("peer-f");
    expect(reloaded?.state).toBe("VERIFIED");
    expect(reloaded?.previousIdentityKey).toBeUndefined();
    expect(reloaded?.changedAt).toBeUndefined();
    expect(reloaded?.verifiedAt).toBe(marked.verifiedAt);

    store.close();
  });

  // Test g: Persistence and multi-user isolation
  it("g. Persistence: write with one VerificationStore, read with a new instance for the same userId; records identical. Isolation between two userIds", async () => {
    const user1 = trackUser("user-g1");
    const user2 = trackUser("user-g2");

    const key = await KeyHelper.generateIdentityKeyPair();

    // Write with store 1
    const store1 = new VerificationStore(user1);
    await store1.recordFirstUse("contact-1", key.pubKey);
    await store1.markVerified("contact-1");
    const written = await store1.get("contact-1");
    store1.close();

    // Read with a new instance for the same user
    const store1Reloaded = new VerificationStore(user1);
    const readBack = await store1Reloaded.get("contact-1");
    expect(readBack).toBeDefined();
    expect(readBack?.peerId).toBe("contact-1");
    expect(readBack?.state).toBe("VERIFIED");
    expect(readBack?.verifiedAt).toBe(written?.verifiedAt);
    expect(areArrayBuffersEqual(readBack!.identityKey, key.pubKey)).toBe(true);

    const list1 = await store1Reloaded.list();
    expect(list1.length).toBe(1);
    expect(list1[0].peerId).toBe("contact-1");
    store1Reloaded.close();

    // Isolation: user2 must not see user1's records
    const store2 = new VerificationStore(user2);
    const user2Record = await store2.get("contact-1");
    expect(user2Record).toBeUndefined();
    const list2 = await store2.list();
    expect(list2).toEqual([]);
    store2.close();
  });

  // Test h: Full integration with SessionManager and attachVerification
  it("h. Integration: alice and bob provisioned, SessionManagers with attachVerification. After alice.encrypt and bob.decrypt, both stores hold UNVERIFIED. After alice.markVerified('bob'), re-provisioning bob with a fresh store causes alice's record to become KEY_CHANGED even though IdentityChangedError is thrown", async () => {
    const aliceId = trackUser("alice-test-h");
    const bobId = trackUser("bob-test-h");
    const bobFreshStoreId = trackUser("bob-fresh-test-h");

    const aliceStore = new IndexedDBSignalStore(aliceId);
    const bobStore1 = new IndexedDBSignalStore(bobId);

    const aliceProvision = await provisionKeys(aliceId, aliceStore);
    const bobProvision1 = await provisionKeys(bobId, bobStore1);

    const bundles = new InMemoryBundleProvider();
    bundles.register(aliceProvision.bundle);
    bundles.register(bobProvision1.bundle);

    const aliceSession = new SessionManager(aliceId, aliceStore, bundles);
    const bobSession = new SessionManager(bobId, bobStore1, bundles);

    const aliceTrust = new VerificationStore(aliceId);
    const bobTrust = new VerificationStore(bobId);

    const unsubAlice = attachVerification(aliceSession, aliceTrust);
    const unsubBob = attachVerification(bobSession, bobTrust);

    // Alice encrypts first message to Bob (type 3)
    const envelope = await aliceSession.encrypt(bobId, "hello bob");
    expect(envelope.type).toBe(3);

    // Bob decrypts first message from Alice
    const decrypted = await bobSession.decrypt(aliceId, envelope);
    expect(decrypted).toBe("hello bob");

    // Both verification stores must hold an UNVERIFIED record for the other with correct identity keys
    const aliceRecordForBob = await aliceTrust.get(bobId);
    expect(aliceRecordForBob).toBeDefined();
    expect(aliceRecordForBob?.state).toBe("UNVERIFIED");
    const bobOwnKey1 = await bobStore1.getIdentityKeyPair();
    expect(areArrayBuffersEqual(aliceRecordForBob!.identityKey, bobOwnKey1!.pubKey)).toBe(true);

    const bobRecordForAlice = await bobTrust.get(aliceId);
    expect(bobRecordForAlice).toBeDefined();
    expect(bobRecordForAlice?.state).toBe("UNVERIFIED");
    const aliceOwnKey = await aliceStore.getIdentityKeyPair();
    expect(areArrayBuffersEqual(bobRecordForAlice!.identityKey, aliceOwnKey!.pubKey)).toBe(true);

    // Alice marks Bob as VERIFIED
    await aliceTrust.markVerified(bobId);
    const aliceVerifiedBob = await aliceTrust.get(bobId);
    expect(aliceVerifiedBob?.state).toBe("VERIFIED");

    // Re-provision Bob with a fresh store (new identity key)
    const bobFreshStore = new IndexedDBSignalStore(bobFreshStoreId);
    const bobProvision2 = await provisionKeys(bobId, bobFreshStore);
    expect(bobProvision2.bundle.identityKey).not.toBe(bobProvision1.bundle.identityKey);
    bundles.register(bobProvision2.bundle);

    // Clear Alice's session with Bob so Alice initiates a new handshake with Bob's new bundle
    await aliceStore.removeSession(aliceSession.address(bobId).toString());
    expect(await aliceSession.hasSession(bobId)).toBe(false);

    // Alice attempts to establish session with Bob's new bundle
    try {
      await aliceSession.ensureSession(bobId);
      expect.fail("ensureSession should have thrown IdentityChangedError");
    } catch (err) {
      expect(err).toBeInstanceOf(IdentityChangedError);
      expect((err as IdentityChangedError).peerId).toBe(bobId);
    }

    // Alice's trust record for Bob must now be in KEY_CHANGED
    const aliceBobChanged = await aliceTrust.get(bobId);
    expect(aliceBobChanged).toBeDefined();
    expect(aliceBobChanged?.state).toBe("KEY_CHANGED");
    expect(areArrayBuffersEqual(aliceBobChanged!.previousIdentityKey!, bobOwnKey1!.pubKey)).toBe(true);
    const bobOwnKey2 = await bobFreshStore.getIdentityKeyPair();
    expect(areArrayBuffersEqual(aliceBobChanged!.identityKey, bobOwnKey2!.pubKey)).toBe(true);
    expect(aliceBobChanged?.changedAt).toBeDefined();

    unsubAlice();
    unsubBob();
    bobFreshStore.close();
    aliceStore.close();
    bobStore1.close();
    aliceTrust.close();
    bobTrust.close();
  });

  // Test i: stateLabel
  it("i. stateLabel returns the right text and colour for each state", () => {
    expect(stateLabel("UNVERIFIED")).toEqual({
      text: "Unverified",
      colour: "amber",
    });

    expect(stateLabel("VERIFIED")).toEqual({
      text: "Verified",
      colour: "green",
    });

    expect(stateLabel("KEY_CHANGED")).toEqual({
      text: "Key changed",
      colour: "red",
    });
  });
});
