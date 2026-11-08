import { describe, expect, it, afterEach } from "vitest";
import { IndexedDBSignalStore, areArrayBuffersEqual } from "./IndexedDBSignalStore";
import { provisionKeys } from "./provision";
import { InMemoryBundleProvider } from "./bundleProvider";
import {
  SessionManager,
  IdentityChangedError,
  type KeyChangeEvent,
} from "./session";
import {
  VerificationStore,
  attachVerification,
  type TrustRecord,
} from "./verification";
import {
  extractIdentityKeyFromPreKeyMessage,
  MalformedPreKeyMessageError,
} from "./prekeyMessage";
import { safetyNumberWith, safetyNumbersMatch } from "./safetyNumber";
import { fromBase64 } from "./bundle";

function base64ToBinaryString(b64: string): string {
  const buf = fromBase64(b64);
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return binary;
}

describe("P4.5 Key Change Detection & Accept Policy", () => {
  const userIdsToClean: string[] = [];

  function trackUser(prefix: string): string {
    const id = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    userIdsToClean.push(id);
    return id;
  }

  afterEach(async () => {
    for (const id of userIdsToClean) {
      try {
        const signalStore = new IndexedDBSignalStore(id);
        await signalStore.wipe();
      } catch {
        // ignore
      }
      try {
        const trustStore = new VerificationStore(id);
        await trustStore.wipe();
      } catch {
        // ignore
      }
    }
    userIdsToClean.length = 0;
  });

  // Test a: extractIdentityKeyFromPreKeyMessage
  it("a. extractIdentityKeyFromPreKeyMessage on a real type 3 envelope produced by SessionManager returns a key byte-equal to sender's identity public key; on garbage input throws MalformedPreKeyMessageError", async () => {
    const aliceId = trackUser("alice-test-a");
    const bobId = trackUser("bob-test-a");

    const aliceStore = new IndexedDBSignalStore(aliceId);
    const bobStore = new IndexedDBSignalStore(bobId);

    const aliceProvision = await provisionKeys(aliceId, aliceStore);
    const bobProvision = await provisionKeys(bobId, bobStore);

    const bundles = new InMemoryBundleProvider();
    bundles.register(aliceProvision.bundle);
    bundles.register(bobProvision.bundle);

    const aliceSession = new SessionManager(aliceId, aliceStore, bundles);
    const envelope = await aliceSession.encrypt(bobId, "hello bob");
    expect(envelope.type).toBe(3);

    // Extract binary string
    const binary = base64ToBinaryString(envelope.body);
    const extracted = extractIdentityKeyFromPreKeyMessage(binary);
    expect(extracted.byteLength).toBe(33);

    const aliceIdentityKeyPair = await aliceStore.getIdentityKeyPair();
    expect(aliceIdentityKeyPair).toBeDefined();
    expect(areArrayBuffersEqual(extracted, aliceIdentityKeyPair!.pubKey)).toBe(true);

    // Garbage inputs throw MalformedPreKeyMessageError
    expect(() => extractIdentityKeyFromPreKeyMessage("")).toThrow(MalformedPreKeyMessageError);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing defensive runtime checks
    expect(() => extractIdentityKeyFromPreKeyMessage(null as any)).toThrow(MalformedPreKeyMessageError);
    expect(() => extractIdentityKeyFromPreKeyMessage("short")).toThrow(MalformedPreKeyMessageError);
    // Invalid version byte (e.g. 0x01)
    expect(() => extractIdentityKeyFromPreKeyMessage(String.fromCharCode(0x01, 0x02, 0x03))).toThrow(
      MalformedPreKeyMessageError,
    );
    // Illegal char code > 0xff
    expect(() => extractIdentityKeyFromPreKeyMessage(String.fromCharCode(0x33, 0x105))).toThrow(
      MalformedPreKeyMessageError,
    );
    // Valid version (0x33) but corrupted protobuf
    expect(() =>
      extractIdentityKeyFromPreKeyMessage(String.fromCharCode(0x33, 0xff, 0xff, 0xff)),
    ).toThrow(MalformedPreKeyMessageError);
  });

  // Test b: Incoming change
  it("b. Incoming change: alice and bob exchange messages and alice marks bob VERIFIED. Re-provision bob (fresh store, new identity). New bob sends to alice. alice.decrypt returns the plaintext; alice's VerificationStore record for bob is KEY_CHANGED with previousIdentityKey = old key and identityKey = new key; alice's Signal store now trusts the new key; exactly one KeyChangeEvent with direction 'incoming' was emitted", async () => {
    const aliceId = trackUser("alice-test-b");
    const bobId = trackUser("bob-test-b");
    const bobFreshStoreId = trackUser("bob-fresh-test-b");

    const aliceStore = new IndexedDBSignalStore(aliceId);
    const bobStore1 = new IndexedDBSignalStore(bobId);

    const aliceProvision = await provisionKeys(aliceId, aliceStore);
    const bobProvision1 = await provisionKeys(bobId, bobStore1);

    const bundles = new InMemoryBundleProvider();
    bundles.register(aliceProvision.bundle);
    bundles.register(bobProvision1.bundle);

    const aliceSession = new SessionManager(aliceId, aliceStore, bundles);
    const bobSession1 = new SessionManager(bobId, bobStore1, bundles);

    const aliceTrust = new VerificationStore(aliceId);
    const bobTrust = new VerificationStore(bobId);

    const keyChangeEvents: KeyChangeEvent[] = [];
    const attachedCallbacks: { event: KeyChangeEvent; record: TrustRecord }[] = [];

    aliceSession.addOnKeyChangedListener((event) => {
      keyChangeEvents.push(event);
    });

    attachVerification(aliceSession, aliceTrust, {
      onKeyChanged: (event, record) => {
        attachedCallbacks.push({ event, record });
      },
    });
    attachVerification(bobSession1, bobTrust);

    // Initial exchange
    const env1 = await aliceSession.encrypt(bobId, "hello bob 1");
    await bobSession1.decrypt(aliceId, env1);

    const env2 = await bobSession1.encrypt(aliceId, "hello alice 1");
    await aliceSession.decrypt(bobId, env2);

    // Alice marks Bob as VERIFIED
    await aliceTrust.markVerified(bobId);
    const verifiedRecord = await aliceTrust.get(bobId);
    expect(verifiedRecord?.state).toBe("VERIFIED");

    const bobOldKeyPair = await bobStore1.getIdentityKeyPair();
    const bobOldKey = bobOldKeyPair!.pubKey;

    expect(keyChangeEvents).toHaveLength(0);

    // Re-provision Bob with fresh store (new identity key)
    const bobStore2 = new IndexedDBSignalStore(bobFreshStoreId);
    const bobProvision2 = await provisionKeys(bobId, bobStore2);
    bundles.register(bobProvision2.bundle);

    const bobNewKeyPair = await bobStore2.getIdentityKeyPair();
    const bobNewKey = bobNewKeyPair!.pubKey;
    expect(areArrayBuffersEqual(bobOldKey, bobNewKey)).toBe(false);

    // New Bob sends to Alice
    const bobSession2 = new SessionManager(bobId, bobStore2, bundles);
    const reinstalledEnv = await bobSession2.encrypt(aliceId, "I reinstalled");

    // Alice decrypts
    const plaintext = await aliceSession.decrypt(bobId, reinstalledEnv);
    expect(plaintext).toBe("I reinstalled");

    // Alice's VerificationStore record for Bob
    const record = await aliceTrust.get(bobId);
    expect(record).toBeDefined();
    expect(record?.state).toBe("KEY_CHANGED");
    expect(areArrayBuffersEqual(record!.previousIdentityKey!, bobOldKey)).toBe(true);
    expect(areArrayBuffersEqual(record!.identityKey, bobNewKey)).toBe(true);
    expect(record?.changedAt).toBeDefined();

    // Alice's Signal store now trusts the new key
    const trustedKeyInSignalStore = await aliceStore.loadIdentityKey(bobId);
    expect(trustedKeyInSignalStore).toBeDefined();
    expect(areArrayBuffersEqual(trustedKeyInSignalStore!, bobNewKey)).toBe(true);

    // Exactly one KeyChangeEvent with direction "incoming" was emitted
    expect(keyChangeEvents).toHaveLength(1);
    expect(keyChangeEvents[0].direction).toBe("incoming");
    expect(keyChangeEvents[0].peerId).toBe(bobId);
    expect(areArrayBuffersEqual(keyChangeEvents[0].previousKey!, bobOldKey)).toBe(true);
    expect(areArrayBuffersEqual(keyChangeEvents[0].newKey, bobNewKey)).toBe(true);

    // attachVerification onKeyChanged was also invoked with both event and record
    expect(attachedCallbacks).toHaveLength(1);
    expect(attachedCallbacks[0].event).toEqual(keyChangeEvents[0]);
    expect(attachedCallbacks[0].record.state).toBe("KEY_CHANGED");
  });

  // Test c: Outgoing change
  it("c. Outgoing change: same setup but instead alice tries encrypt to new bob. It throws IdentityChangedError; record is KEY_CHANGED; alice's Signal store still holds the OLD key; one KeyChangeEvent with direction 'outgoing'", async () => {
    const aliceId = trackUser("alice-test-c");
    const bobId = trackUser("bob-test-c");
    const bobFreshStoreId = trackUser("bob-fresh-test-c");

    const aliceStore = new IndexedDBSignalStore(aliceId);
    const bobStore1 = new IndexedDBSignalStore(bobId);

    const aliceProvision = await provisionKeys(aliceId, aliceStore);
    const bobProvision1 = await provisionKeys(bobId, bobStore1);

    const bundles = new InMemoryBundleProvider();
    bundles.register(aliceProvision.bundle);
    bundles.register(bobProvision1.bundle);

    const aliceSession = new SessionManager(aliceId, aliceStore, bundles);
    const bobSession1 = new SessionManager(bobId, bobStore1, bundles);

    const aliceTrust = new VerificationStore(aliceId);
    const bobTrust = new VerificationStore(bobId);

    const keyChangeEvents: KeyChangeEvent[] = [];
    aliceSession.addOnKeyChangedListener((event) => {
      keyChangeEvents.push(event);
    });

    attachVerification(aliceSession, aliceTrust);
    attachVerification(bobSession1, bobTrust);

    // Initial exchange
    const env1 = await aliceSession.encrypt(bobId, "hello bob 1");
    await bobSession1.decrypt(aliceId, env1);

    // Alice marks Bob as VERIFIED
    await aliceTrust.markVerified(bobId);
    const bobOldKeyPair = await bobStore1.getIdentityKeyPair();
    const bobOldKey = bobOldKeyPair!.pubKey;

    expect(keyChangeEvents).toHaveLength(0);

    // Re-provision Bob with fresh store (new identity key)
    const bobStore2 = new IndexedDBSignalStore(bobFreshStoreId);
    const bobProvision2 = await provisionKeys(bobId, bobStore2);
    bundles.register(bobProvision2.bundle);

    const bobNewKeyPair = await bobStore2.getIdentityKeyPair();
    const bobNewKey = bobNewKeyPair!.pubKey;

    // Clear Alice's session with Bob so Alice initiates new session setup (X3DH)
    await aliceStore.removeSession(aliceSession.address(bobId).toString());

    // Alice tries to encrypt to new Bob
    let caughtErr: unknown;
    try {
      await aliceSession.encrypt(bobId, "hello new bob");
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toBeInstanceOf(IdentityChangedError);
    expect((caughtErr as IdentityChangedError).peerId).toBe(bobId);

    // Record in VerificationStore is KEY_CHANGED
    const record = await aliceTrust.get(bobId);
    expect(record).toBeDefined();
    expect(record?.state).toBe("KEY_CHANGED");
    expect(areArrayBuffersEqual(record!.previousIdentityKey!, bobOldKey)).toBe(true);
    expect(areArrayBuffersEqual(record!.identityKey, bobNewKey)).toBe(true);

    // Alice's Signal store still holds the OLD key
    const trustedKeyInSignalStore = await aliceStore.loadIdentityKey(bobId);
    expect(trustedKeyInSignalStore).toBeDefined();
    expect(areArrayBuffersEqual(trustedKeyInSignalStore!, bobOldKey)).toBe(true);

    // One KeyChangeEvent with direction "outgoing"
    expect(keyChangeEvents).toHaveLength(1);
    expect(keyChangeEvents[0].direction).toBe("outgoing");
    expect(keyChangeEvents[0].peerId).toBe(bobId);
    expect(areArrayBuffersEqual(keyChangeEvents[0].previousKey!, bobOldKey)).toBe(true);
    expect(areArrayBuffersEqual(keyChangeEvents[0].newKey, bobNewKey)).toBe(true);
  });

  // Test d: acceptNewIdentity
  it("d. acceptNewIdentity: after (c), alice.acceptNewIdentity('bob') then alice.encrypt succeeds and new bob decrypts it; state remains KEY_CHANGED; after alice's VerificationStore.markVerified('bob') it is VERIFIED and safetyNumberWith now matches between alice and new bob", async () => {
    const aliceId = trackUser("alice-test-d");
    const bobId = trackUser("bob-test-d");
    const bobFreshStoreId = trackUser("bob-fresh-test-d");

    const aliceStore = new IndexedDBSignalStore(aliceId);
    const bobStore1 = new IndexedDBSignalStore(bobId);

    const aliceProvision = await provisionKeys(aliceId, aliceStore);
    const bobProvision1 = await provisionKeys(bobId, bobStore1);

    const bundles = new InMemoryBundleProvider();
    bundles.register(aliceProvision.bundle);
    bundles.register(bobProvision1.bundle);

    const aliceSession = new SessionManager(aliceId, aliceStore, bundles);
    const bobSession1 = new SessionManager(bobId, bobStore1, bundles);

    const aliceTrust = new VerificationStore(aliceId);

    attachVerification(aliceSession, aliceTrust);

    // Initial exchange & mark verified
    const env1 = await aliceSession.encrypt(bobId, "hello bob");
    await bobSession1.decrypt(aliceId, env1);
    await aliceTrust.markVerified(bobId);

    // Re-provision Bob
    const bobStore2 = new IndexedDBSignalStore(bobFreshStoreId);
    const bobProvision2 = await provisionKeys(bobId, bobStore2);
    bundles.register(bobProvision2.bundle);
    const bobNewKeyPair = await bobStore2.getIdentityKeyPair();

    // Clear old session
    await aliceStore.removeSession(aliceSession.address(bobId).toString());

    // Alice encounters IdentityChangedError on outgoing
    await expect(aliceSession.encrypt(bobId, "hello new bob")).rejects.toThrow(
      IdentityChangedError,
    );

    // Alice calls acceptNewIdentity("bob")
    await aliceSession.acceptNewIdentity(bobId);

    // Alice's Signal store now holds the new key
    const trustedKey = await aliceStore.loadIdentityKey(bobId);
    expect(trustedKey).toBeDefined();
    expect(areArrayBuffersEqual(trustedKey!, bobNewKeyPair!.pubKey)).toBe(true);

    // Now alice.encrypt succeeds
    const envAfterAccept = await aliceSession.encrypt(bobId, "message after accept");
    expect(envAfterAccept.type).toBe(3);

    // New Bob decrypts it
    const bobSession2 = new SessionManager(bobId, bobStore2, bundles);
    const decrypted = await bobSession2.decrypt(aliceId, envAfterAccept);
    expect(decrypted).toBe("message after accept");

    // Verification state remains KEY_CHANGED until re-verified
    const recordAfterAccept = await aliceTrust.get(bobId);
    expect(recordAfterAccept?.state).toBe("KEY_CHANGED");

    // Alice marks Bob as VERIFIED
    await aliceTrust.markVerified(bobId);
    const recordVerified = await aliceTrust.get(bobId);
    expect(recordVerified?.state).toBe("VERIFIED");

    // safetyNumberWith now matches between Alice and new Bob
    const snAlice = await safetyNumberWith(aliceStore, aliceId, bobId);
    const snBob = await safetyNumberWith(bobStore2, bobId, aliceId);
    expect(snAlice).toBeDefined();
    expect(snBob).toBeDefined();
    expect(snAlice!.digits).toBe(snBob!.digits);
    expect(safetyNumbersMatch(snAlice!.digits, snBob!.digits)).toBe(true);
  });

  // Test e: No false positives
  it("e. No false positives: 20 messages in both directions between unchanged alice and bob never emit a KeyChangeEvent and the state stays as set", async () => {
    const aliceId = trackUser("alice-test-e");
    const bobId = trackUser("bob-test-e");

    const aliceStore = new IndexedDBSignalStore(aliceId);
    const bobStore = new IndexedDBSignalStore(bobId);

    const aliceProvision = await provisionKeys(aliceId, aliceStore);
    const bobProvision = await provisionKeys(bobId, bobStore);

    const bundles = new InMemoryBundleProvider();
    bundles.register(aliceProvision.bundle);
    bundles.register(bobProvision.bundle);

    const aliceSession = new SessionManager(aliceId, aliceStore, bundles);
    const bobSession = new SessionManager(bobId, bobStore, bundles);

    const aliceTrust = new VerificationStore(aliceId);
    const bobTrust = new VerificationStore(bobId);

    const aliceEvents: KeyChangeEvent[] = [];
    const bobEvents: KeyChangeEvent[] = [];

    aliceSession.addOnKeyChangedListener((event) => {
      aliceEvents.push(event);
    });
    bobSession.addOnKeyChangedListener((event) => {
      bobEvents.push(event);
    });

    attachVerification(aliceSession, aliceTrust);
    attachVerification(bobSession, bobTrust);

    // Initial exchange and verification
    const envInit = await aliceSession.encrypt(bobId, "init");
    await bobSession.decrypt(aliceId, envInit);
    await aliceTrust.markVerified(bobId);
    await bobTrust.markVerified(aliceId);

    // 20 messages alternating between Alice and Bob
    for (let i = 0; i < 20; i++) {
      if (i % 2 === 0) {
        const env = await aliceSession.encrypt(bobId, `msg from alice ${i}`);
        const text = await bobSession.decrypt(aliceId, env);
        expect(text).toBe(`msg from alice ${i}`);
      } else {
        const env = await bobSession.encrypt(aliceId, `msg from bob ${i}`);
        const text = await aliceSession.decrypt(bobId, env);
        expect(text).toBe(`msg from bob ${i}`);
      }
    }

    // Zero KeyChangeEvents emitted
    expect(aliceEvents).toHaveLength(0);
    expect(bobEvents).toHaveLength(0);

    // States remain VERIFIED
    const aliceRecord = await aliceTrust.get(bobId);
    const bobRecord = await bobTrust.get(aliceId);
    expect(aliceRecord?.state).toBe("VERIFIED");
    expect(bobRecord?.state).toBe("VERIFIED");
  });

  // Test f: Same key observed again does not emit a second event
  it("f. Same key observed again (bob sends another prekey message, e.g. after alice's session was removed) does not emit a second event", async () => {
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

    const aliceSession = new SessionManager(aliceId, aliceStore, bundles);
    const bobSession1 = new SessionManager(bobId, bobStore1, bundles);

    const aliceTrust = new VerificationStore(aliceId);

    const aliceEvents: KeyChangeEvent[] = [];
    aliceSession.addOnKeyChangedListener((event) => {
      aliceEvents.push(event);
    });

    attachVerification(aliceSession, aliceTrust);

    // Initial message & mark verified
    const envInit = await aliceSession.encrypt(bobId, "init");
    await bobSession1.decrypt(aliceId, envInit);
    await aliceTrust.markVerified(bobId);

    // Re-provision Bob
    const bobStore2 = new IndexedDBSignalStore(bobFreshStoreId);
    const bobProvision2 = await provisionKeys(bobId, bobStore2);
    bundles.register(bobProvision2.bundle);

    const bobSession2 = new SessionManager(bobId, bobStore2, bundles);

    // Bob sends prekey message 1 (type 3)
    const envMsg1 = await bobSession2.encrypt(aliceId, "prekey 1");
    expect(envMsg1.type).toBe(3);

    const text1 = await aliceSession.decrypt(bobId, envMsg1);
    expect(text1).toBe("prekey 1");

    expect(aliceEvents).toHaveLength(1);
    expect(aliceEvents[0].direction).toBe("incoming");

    // Alice's session with Bob is removed
    await aliceStore.removeSession(aliceSession.address(bobId).toString());

    // Bob also removes his session with Alice so he initiates a new X3DH prekey message
    await bobStore2.removeSession(bobSession2.address(aliceId).toString());

    // Bob sends prekey message 2 (type 3) with the SAME new key
    const envMsg2 = await bobSession2.encrypt(aliceId, "prekey 2");
    expect(envMsg2.type).toBe(3);

    const text2 = await aliceSession.decrypt(bobId, envMsg2);
    expect(text2).toBe("prekey 2");

    // Assert that NO second event was emitted
    expect(aliceEvents).toHaveLength(1);

    // State remains KEY_CHANGED
    const record = await aliceTrust.get(bobId);
    expect(record?.state).toBe("KEY_CHANGED");
  });
});
