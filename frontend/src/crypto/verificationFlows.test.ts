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
import { safetyNumberWith, safetyNumbersMatch } from "./safetyNumber";

describe("P4.8 End-to-End Verification Flows", () => {
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

  // Scenario 1: UNVERIFIED -> VERIFIED after the two users compare safety numbers
  it(
    "Scenario 1: UNVERIFIED -> VERIFIED after the two users compare safety numbers",
    async () => {
      const aliceId = trackUser("alice-scen1");
      const bobId = trackUser("bob-scen1");

      const aliceSignalStore = new IndexedDBSignalStore(aliceId);
      const bobSignalStore = new IndexedDBSignalStore(bobId);

      const aliceProvision = await provisionKeys(aliceId, aliceSignalStore);
      const bobProvision = await provisionKeys(bobId, bobSignalStore);

      const bundles = new InMemoryBundleProvider();
      bundles.register(aliceProvision.bundle);
      bundles.register(bobProvision.bundle);

      const aliceSession = new SessionManager(aliceId, aliceSignalStore, bundles);
      const bobSession = new SessionManager(bobId, bobSignalStore, bundles);

      const aliceTrust = new VerificationStore(aliceId);
      const bobTrust = new VerificationStore(bobId);

      const unsubAlice = attachVerification(aliceSession, aliceTrust);
      const unsubBob = attachVerification(bobSession, bobTrust);

      // Initial state: before exchange, no trust records exist
      expect(await aliceTrust.get(bobId)).toBeUndefined();
      expect(await bobTrust.get(aliceId)).toBeUndefined();

      // Alice sends initial prekey message (type 3) to Bob
      const envelope = await aliceSession.encrypt(bobId, "Hello Bob, initial handshake");
      expect(envelope.type).toBe(3);

      const decrypted = await bobSession.decrypt(aliceId, envelope);
      expect(decrypted).toBe("Hello Bob, initial handshake");

      // Both stores now hold UNVERIFIED records via TOFU with correct identity keys
      const aliceRecordBefore = await aliceTrust.get(bobId);
      expect(aliceRecordBefore).toBeDefined();
      expect(aliceRecordBefore?.state).toBe("UNVERIFIED");
      expect(aliceRecordBefore?.verifiedAt).toBeUndefined();
      expect(aliceRecordBefore?.previousIdentityKey).toBeUndefined();
      expect(aliceRecordBefore?.changedAt).toBeUndefined();

      const bobKeyPair = await bobSignalStore.getIdentityKeyPair();
      expect(areArrayBuffersEqual(aliceRecordBefore!.identityKey, bobKeyPair!.pubKey)).toBe(true);

      const bobRecordBefore = await bobTrust.get(aliceId);
      expect(bobRecordBefore).toBeDefined();
      expect(bobRecordBefore?.state).toBe("UNVERIFIED");
      expect(bobRecordBefore?.verifiedAt).toBeUndefined();

      const aliceKeyPair = await aliceSignalStore.getIdentityKeyPair();
      expect(areArrayBuffersEqual(bobRecordBefore!.identityKey, aliceKeyPair!.pubKey)).toBe(true);

      // Alice and Bob compute their 60-digit safety numbers
      const aliceSafetyNumber = await safetyNumberWith(aliceSignalStore, aliceId, bobId);
      const bobSafetyNumber = await safetyNumberWith(bobSignalStore, bobId, aliceId);

      expect(aliceSafetyNumber).not.toBeNull();
      expect(bobSafetyNumber).not.toBeNull();
      expect(aliceSafetyNumber!.digits).toMatch(/^[0-9]{60}$/);
      expect(bobSafetyNumber!.digits).toMatch(/^[0-9]{60}$/);
      expect(aliceSafetyNumber!.groups).toHaveLength(12);
      expect(bobSafetyNumber!.groups).toHaveLength(12);

      // Verify that safety numbers match between both users
      expect(safetyNumbersMatch(aliceSafetyNumber!.digits, bobSafetyNumber!.digits)).toBe(true);

      // Both users confirm safety numbers out-of-band and mark each other VERIFIED
      const aliceVerified = await aliceTrust.markVerified(bobId);
      const bobVerified = await bobTrust.markVerified(aliceId);

      expect(aliceVerified.state).toBe("VERIFIED");
      expect(aliceVerified.verifiedAt).toBeDefined();
      expect(Number.isNaN(Date.parse(aliceVerified.verifiedAt!))).toBe(false);
      expect(aliceVerified.previousIdentityKey).toBeUndefined();
      expect(aliceVerified.changedAt).toBeUndefined();

      expect(bobVerified.state).toBe("VERIFIED");
      expect(bobVerified.verifiedAt).toBeDefined();
      expect(Number.isNaN(Date.parse(bobVerified.verifiedAt!))).toBe(false);

      // Verify persisted state in VerificationStore
      const alicePersisted = await aliceTrust.get(bobId);
      expect(alicePersisted?.state).toBe("VERIFIED");
      expect(alicePersisted?.verifiedAt).toBe(aliceVerified.verifiedAt);

      const bobPersisted = await bobTrust.get(aliceId);
      expect(bobPersisted?.state).toBe("VERIFIED");
      expect(bobPersisted?.verifiedAt).toBe(bobVerified.verifiedAt);

      unsubAlice();
      unsubBob();
      aliceSignalStore.close();
      bobSignalStore.close();
      aliceTrust.close();
      bobTrust.close();
    },
    15000,
  );

  // Scenario 2: VERIFIED -> KEY_CHANGED when the peer re-provisions and sends a prekey message,
  // asserting exactly one KeyChangeEvent and that the onKeyChanged callback from attachVerification
  // receives both the event and the TrustRecord
  it(
    "Scenario 2: VERIFIED -> KEY_CHANGED when the peer re-provisions and sends a prekey message, asserting exactly one KeyChangeEvent and that the onKeyChanged callback from attachVerification receives both the event and the TrustRecord",
    async () => {
      const aliceId = trackUser("alice-scen2");
      const bobId = trackUser("bob-scen2");
      const bobFreshStoreId = trackUser("bob-fresh-scen2");

      const aliceSignalStore = new IndexedDBSignalStore(aliceId);
      const bobSignalStore1 = new IndexedDBSignalStore(bobId);

      const aliceProvision = await provisionKeys(aliceId, aliceSignalStore);
      const bobProvision1 = await provisionKeys(bobId, bobSignalStore1);

      const bundles = new InMemoryBundleProvider();
      bundles.register(aliceProvision.bundle);
      bundles.register(bobProvision1.bundle);

      const aliceSession = new SessionManager(aliceId, aliceSignalStore, bundles);
      const bobSession1 = new SessionManager(bobId, bobSignalStore1, bundles);

      const aliceTrust = new VerificationStore(aliceId);

      // Track KeyChangeEvents emitted directly from SessionManager
      const sessionKeyChangeEvents: KeyChangeEvent[] = [];
      aliceSession.addOnKeyChangedListener((event) => {
        sessionKeyChangeEvents.push(event);
      });

      // Track callbacks from attachVerification's onKeyChanged option
      const attachKeyChangedInvocations: Array<{ event: KeyChangeEvent; record: TrustRecord }> = [];
      const unsubAlice = attachVerification(aliceSession, aliceTrust, {
        onKeyChanged: (event, record) => {
          attachKeyChangedInvocations.push({ event, record });
        },
      });

      // Alice and Bob establish an initial session and Alice marks Bob as VERIFIED
      const envInit = await aliceSession.encrypt(bobId, "initial message before reinstall");
      await bobSession1.decrypt(aliceId, envInit);
      const verifiedRecord = await aliceTrust.markVerified(bobId);
      expect(verifiedRecord.state).toBe("VERIFIED");
      const verifiedTimestamp = verifiedRecord.verifiedAt;
      expect(verifiedTimestamp).toBeDefined();

      const bobOldKeyPair = await bobSignalStore1.getIdentityKeyPair();
      expect(bobOldKeyPair).toBeDefined();
      const bobOldIdentityKey = bobOldKeyPair!.pubKey;

      // Bob re-provisions: fresh IndexedDB store, fresh identity key pair, updated bundle
      const bobSignalStore2 = new IndexedDBSignalStore(bobFreshStoreId);
      const bobProvision2 = await provisionKeys(bobId, bobSignalStore2);
      expect(bobProvision2.bundle.identityKey).not.toBe(bobProvision1.bundle.identityKey);
      bundles.register(bobProvision2.bundle);

      const bobNewKeyPair = await bobSignalStore2.getIdentityKeyPair();
      expect(bobNewKeyPair).toBeDefined();
      const bobNewIdentityKey = bobNewKeyPair!.pubKey;
      expect(areArrayBuffersEqual(bobOldIdentityKey, bobNewIdentityKey)).toBe(false);

      const bobSession2 = new SessionManager(bobId, bobSignalStore2, bundles);

      // Bob sends a prekey message (type 3) to Alice with the new identity key
      const prekeyEnvelope = await bobSession2.encrypt(
        aliceId,
        "I re-provisioned Nullspace on a new phone",
      );
      expect(prekeyEnvelope.type).toBe(3);

      // Alice decrypts the prekey message: message is decrypted and delivered (not dropped)
      const decrypted = await aliceSession.decrypt(bobId, prekeyEnvelope);
      expect(decrypted).toBe("I re-provisioned Nullspace on a new phone");

      // Assert exactly one KeyChangeEvent was emitted from SessionManager
      expect(sessionKeyChangeEvents).toHaveLength(1);
      const sessionEvent = sessionKeyChangeEvents[0];
      expect(sessionEvent.direction).toBe("incoming");
      expect(sessionEvent.peerId).toBe(bobId);
      expect(areArrayBuffersEqual(sessionEvent.previousKey!, bobOldIdentityKey)).toBe(true);
      expect(areArrayBuffersEqual(sessionEvent.newKey, bobNewIdentityKey)).toBe(true);
      expect(sessionEvent.at).toBeDefined();

      // Assert the onKeyChanged callback from attachVerification receives BOTH the event and the TrustRecord
      expect(attachKeyChangedInvocations).toHaveLength(1);
      const { event: cbEvent, record: cbRecord } = attachKeyChangedInvocations[0];

      // Assert event details passed to callback
      expect(cbEvent).toEqual(sessionEvent);
      expect(cbEvent.direction).toBe("incoming");
      expect(cbEvent.peerId).toBe(bobId);
      expect(areArrayBuffersEqual(cbEvent.previousKey!, bobOldIdentityKey)).toBe(true);
      expect(areArrayBuffersEqual(cbEvent.newKey, bobNewIdentityKey)).toBe(true);

      // Assert TrustRecord details passed to callback (powers the UI banner event)
      expect(cbRecord).toBeDefined();
      expect(cbRecord.peerId).toBe(bobId);
      expect(cbRecord.state).toBe("KEY_CHANGED");
      expect(areArrayBuffersEqual(cbRecord.identityKey, bobNewIdentityKey)).toBe(true);
      expect(areArrayBuffersEqual(cbRecord.previousIdentityKey!, bobOldIdentityKey)).toBe(true);
      expect(cbRecord.changedAt).toBeDefined();
      expect(Number.isNaN(Date.parse(cbRecord.changedAt!))).toBe(false);
      expect(cbRecord.verifiedAt).toBe(verifiedTimestamp);

      // Assert Alice's VerificationStore persists the KEY_CHANGED record
      const aliceStoredRecord = await aliceTrust.get(bobId);
      expect(aliceStoredRecord).toBeDefined();
      expect(aliceStoredRecord?.state).toBe("KEY_CHANGED");
      expect(areArrayBuffersEqual(aliceStoredRecord!.identityKey, bobNewIdentityKey)).toBe(true);
      expect(areArrayBuffersEqual(aliceStoredRecord!.previousIdentityKey!, bobOldIdentityKey)).toBe(
        true,
      );
      expect(aliceStoredRecord?.changedAt).toBe(cbRecord.changedAt);

      // Assert Alice's Signal store has accepted the new identity key so ratchet proceeds
      const aliceStoredSignalIdentity = await aliceSignalStore.loadIdentityKey(
        aliceSession.address(bobId).toString(),
      );
      expect(aliceStoredSignalIdentity).toBeDefined();
      expect(areArrayBuffersEqual(aliceStoredSignalIdentity!, bobNewIdentityKey)).toBe(true);

      unsubAlice();
      aliceSignalStore.close();
      bobSignalStore1.close();
      bobSignalStore2.close();
      aliceTrust.close();
    },
    15000,
  );

  // Scenario 3: KEY_CHANGED -> VERIFIED after acceptNewIdentity and markVerified, with matching safety numbers
  it(
    "Scenario 3: KEY_CHANGED -> VERIFIED after acceptNewIdentity and markVerified, with matching safety numbers",
    async () => {
      const aliceId = trackUser("alice-scen3");
      const bobId = trackUser("bob-scen3");
      const bobFreshStoreId = trackUser("bob-fresh-scen3");

      const aliceSignalStore = new IndexedDBSignalStore(aliceId);
      const bobSignalStore1 = new IndexedDBSignalStore(bobId);

      const aliceProvision = await provisionKeys(aliceId, aliceSignalStore);
      const bobProvision1 = await provisionKeys(bobId, bobSignalStore1);

      const bundles = new InMemoryBundleProvider();
      bundles.register(aliceProvision.bundle);
      bundles.register(bobProvision1.bundle);

      const aliceSession = new SessionManager(aliceId, aliceSignalStore, bundles);
      const bobSession1 = new SessionManager(bobId, bobSignalStore1, bundles);

      const aliceTrust = new VerificationStore(aliceId);
      const bobTrust1 = new VerificationStore(bobId);

      const unsubAlice = attachVerification(aliceSession, aliceTrust);
      const unsubBob1 = attachVerification(bobSession1, bobTrust1);

      // 1. Initial exchange and verification
      const envInit = await aliceSession.encrypt(bobId, "init before key change");
      await bobSession1.decrypt(aliceId, envInit);
      await aliceTrust.markVerified(bobId);
      await bobTrust1.markVerified(aliceId);

      // Compute initial safety number
      const initialSafetyAlice = await safetyNumberWith(aliceSignalStore, aliceId, bobId);
      const initialSafetyBob = await safetyNumberWith(bobSignalStore1, bobId, aliceId);
      expect(initialSafetyAlice).not.toBeNull();
      expect(initialSafetyBob).not.toBeNull();
      expect(safetyNumbersMatch(initialSafetyAlice!.digits, initialSafetyBob!.digits)).toBe(true);

      const bobOldKeyPair = await bobSignalStore1.getIdentityKeyPair();
      const bobOldIdentityKey = bobOldKeyPair!.pubKey;

      // 2. Bob re-provisions with a fresh store (new identity key)
      const bobSignalStore2 = new IndexedDBSignalStore(bobFreshStoreId);
      const bobProvision2 = await provisionKeys(bobId, bobSignalStore2);
      bundles.register(bobProvision2.bundle);

      const bobNewKeyPair = await bobSignalStore2.getIdentityKeyPair();
      const bobNewIdentityKey = bobNewKeyPair!.pubKey;
      expect(areArrayBuffersEqual(bobOldIdentityKey, bobNewIdentityKey)).toBe(false);

      const bobTrust2 = new VerificationStore(bobId);
      const bobSession2 = new SessionManager(bobId, bobSignalStore2, bundles);
      const unsubBob2 = attachVerification(bobSession2, bobTrust2);

      // Clear Alice's cached session with Bob so Alice initiates a new handshake with Bob's new bundle
      await aliceSignalStore.removeSession(aliceSession.address(bobId).toString());

      // 3. Alice attempts outgoing session establishment to Bob -> IdentityChangedError
      await expect(aliceSession.encrypt(bobId, "outgoing message to new Bob")).rejects.toThrow(
        IdentityChangedError,
      );

      // Assert Alice's trust record transitioned to KEY_CHANGED
      const changedRecord = await aliceTrust.get(bobId);
      expect(changedRecord).toBeDefined();
      expect(changedRecord?.state).toBe("KEY_CHANGED");
      expect(areArrayBuffersEqual(changedRecord!.previousIdentityKey!, bobOldIdentityKey)).toBe(
        true,
      );
      expect(areArrayBuffersEqual(changedRecord!.identityKey, bobNewIdentityKey)).toBe(true);
      expect(changedRecord?.changedAt).toBeDefined();

      // Alice's Signal store still retains the old key at this point
      const retainedKey = await aliceSignalStore.loadIdentityKey(
        aliceSession.address(bobId).toString(),
      );
      expect(areArrayBuffersEqual(retainedKey!, bobOldIdentityKey)).toBe(true);

      // 4. User accepts new identity via acceptNewIdentity
      await aliceSession.acceptNewIdentity(bobId);

      // Verification state remains KEY_CHANGED (accepting allows messaging, but user has not re-verified)
      const afterAcceptRecord = await aliceTrust.get(bobId);
      expect(afterAcceptRecord?.state).toBe("KEY_CHANGED");

      // Alice's Signal store now trusts the new identity key
      const updatedSignalKey = await aliceSignalStore.loadIdentityKey(
        aliceSession.address(bobId).toString(),
      );
      expect(areArrayBuffersEqual(updatedSignalKey!, bobNewIdentityKey)).toBe(true);

      // 5. Alice successfully encrypts message to Bob, Bob decrypts it
      const envResumed = await aliceSession.encrypt(bobId, "resumed communication with new key");
      expect(envResumed.type).toBe(3);
      const decryptedResumed = await bobSession2.decrypt(aliceId, envResumed);
      expect(decryptedResumed).toBe("resumed communication with new key");

      // 6. Both users compute new safety numbers
      const newSafetyAlice = await safetyNumberWith(aliceSignalStore, aliceId, bobId);
      const newSafetyBob = await safetyNumberWith(bobSignalStore2, bobId, aliceId);

      expect(newSafetyAlice).not.toBeNull();
      expect(newSafetyBob).not.toBeNull();

      // New safety numbers match between Alice and Bob
      expect(safetyNumbersMatch(newSafetyAlice!.digits, newSafetyBob!.digits)).toBe(true);

      // New safety numbers are strictly different from the pre-change safety numbers
      expect(safetyNumbersMatch(newSafetyAlice!.digits, initialSafetyAlice!.digits)).toBe(false);

      // 7. Users confirm safety numbers out-of-band and call markVerified
      const aliceReverified = await aliceTrust.markVerified(bobId);
      const bobReverified = await bobTrust2.markVerified(aliceId);

      // Assert transition KEY_CHANGED -> VERIFIED: clears previousIdentityKey and changedAt, updates verifiedAt
      expect(aliceReverified.state).toBe("VERIFIED");
      expect(aliceReverified.verifiedAt).toBeDefined();
      expect(aliceReverified.previousIdentityKey).toBeUndefined();
      expect(aliceReverified.changedAt).toBeUndefined();
      expect(areArrayBuffersEqual(aliceReverified.identityKey, bobNewIdentityKey)).toBe(true);

      expect(bobReverified.state).toBe("VERIFIED");
      expect(bobReverified.verifiedAt).toBeDefined();

      // Assert persistent VerificationStore matches
      const aliceFinalRecord = await aliceTrust.get(bobId);
      expect(aliceFinalRecord?.state).toBe("VERIFIED");
      expect(aliceFinalRecord?.verifiedAt).toBe(aliceReverified.verifiedAt);
      expect(aliceFinalRecord?.previousIdentityKey).toBeUndefined();
      expect(aliceFinalRecord?.changedAt).toBeUndefined();

      // 8. Subsequent message exchange continues normally with active ratchet (type 1)
      const replyEnv = await bobSession2.encrypt(aliceId, "session verified and ratcheted");
      expect(replyEnv.type).toBe(1);
      const replyDecrypted = await aliceSession.decrypt(bobId, replyEnv);
      expect(replyDecrypted).toBe("session verified and ratcheted");

      unsubAlice();
      unsubBob1();
      unsubBob2();
      aliceSignalStore.close();
      bobSignalStore1.close();
      bobSignalStore2.close();
      aliceTrust.close();
      bobTrust1.close();
      bobTrust2.close();
    },
    15000,
  );
});
