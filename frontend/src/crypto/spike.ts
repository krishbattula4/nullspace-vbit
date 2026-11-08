import {
  KeyHelper,
  SessionBuilder,
  SessionCipher,
  SignalProtocolAddress,
  type DeviceType,
  type Direction,
  type KeyPairType,
  type SessionRecordType,
  type StorageType,
} from "@privacyresearch/libsignal-protocol-typescript";
import { IndexedDBSignalStore } from "./IndexedDBSignalStore";
import { provisionKeys } from "./provision";
import { InMemoryBundleProvider } from "./bundleProvider";
import { SessionManager, type KeyChangeEvent } from "./session";
import { VerificationStore, stateLabel, attachVerification } from "./verification";
import {
  safetyNumberWith,
  formatSafetyNumber,
  safetyNumbersMatch,
} from "./safetyNumber";

export interface SignalStoreWithIdentity extends StorageType {
  setIdentityKeyPair(keyPair: KeyPairType): Promise<void>;
  setLocalRegistrationId(id: number): Promise<void>;
  wipe?(): Promise<void>;
}

export type SignalStoreFactory = (
  userId: string,
) => SignalStoreWithIdentity | Promise<SignalStoreWithIdentity>;

function areArrayBuffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const viewA = new Uint8Array(a);
  const viewB = new Uint8Array(b);
  for (let i = 0; i < viewA.length; i++) {
    if (viewA[i] !== viewB[i]) return false;
  }
  return true;
}

export class InMemorySignalProtocolStore implements SignalStoreWithIdentity {
  private identityKeyPair?: KeyPairType;
  private registrationId?: number;
  private readonly preKeys = new Map<string | number, KeyPairType>();
  private readonly signedPreKeys = new Map<
    string | number,
    KeyPairType & { signature?: ArrayBuffer }
  >();
  private readonly sessions = new Map<string, SessionRecordType>();
  private readonly identities = new Map<string, ArrayBuffer>();

  async getIdentityKeyPair(): Promise<KeyPairType | undefined> {
    return this.identityKeyPair;
  }

  async setIdentityKeyPair(keyPair: KeyPairType): Promise<void> {
    this.identityKeyPair = keyPair;
  }

  async getLocalRegistrationId(): Promise<number | undefined> {
    return this.registrationId;
  }

  async setLocalRegistrationId(id: number): Promise<void> {
    this.registrationId = id;
  }

  async isTrustedIdentity(
    identifier: string,
    identityKey: ArrayBuffer,
    direction?: Direction,
  ): Promise<boolean> {
    void identifier;
    void identityKey;
    void direction;
    // In-memory spike trusts all identities established during the handshake
    return true;
  }

  async saveIdentity(
    encodedAddress: string,
    publicKey: ArrayBuffer,
    nonblockingApproval?: boolean,
  ): Promise<boolean> {
    void nonblockingApproval;
    const existing = this.identities.get(encodedAddress);
    this.identities.set(encodedAddress, publicKey);
    if (!existing) {
      return false;
    }
    return !areArrayBuffersEqual(existing, publicKey);
  }

  async loadPreKey(keyId: string | number): Promise<KeyPairType | undefined> {
    return this.preKeys.get(keyId);
  }

  async storePreKey(keyId: number | string, keyPair: KeyPairType): Promise<void> {
    this.preKeys.set(keyId, keyPair);
  }

  async removePreKey(keyId: number | string): Promise<void> {
    this.preKeys.delete(keyId);
  }

  async storeSession(encodedAddress: string, record: SessionRecordType): Promise<void> {
    this.sessions.set(encodedAddress, record);
  }

  async loadSession(encodedAddress: string): Promise<SessionRecordType | undefined> {
    return this.sessions.get(encodedAddress);
  }

  async loadSignedPreKey(
    keyId: number | string,
  ): Promise<(KeyPairType & { signature?: ArrayBuffer }) | undefined> {
    return this.signedPreKeys.get(keyId);
  }

  async storeSignedPreKey(
    keyId: number | string,
    keyPair: KeyPairType,
    signature?: ArrayBuffer,
  ): Promise<void> {
    const sig = signature ?? (keyPair as { signature?: ArrayBuffer }).signature;
    this.signedPreKeys.set(keyId, {
      pubKey: keyPair.pubKey,
      privKey: keyPair.privKey,
      signature: sig,
    });
  }

  async removeSignedPreKey(keyId: number | string): Promise<void> {
    this.signedPreKeys.delete(keyId);
  }
}

export async function runSpike(
  storeFactory?: SignalStoreFactory,
): Promise<{ library: string; decrypted: string }> {
  const library = "@privacyresearch/libsignal-protocol-typescript";

  // 1. Generate identity, signed prekey, and one-time prekey for Bob
  const bobStore = storeFactory ? await storeFactory("bob") : new InMemorySignalProtocolStore();
  const bobRegistrationId = KeyHelper.generateRegistrationId();
  const bobIdentityKeyPair = await KeyHelper.generateIdentityKeyPair();
  await bobStore.setLocalRegistrationId(bobRegistrationId);
  await bobStore.setIdentityKeyPair(bobIdentityKeyPair);

  const signedPreKeyId = 1;
  const bobSignedPreKey = await KeyHelper.generateSignedPreKey(bobIdentityKeyPair, signedPreKeyId);
  await bobStore.storeSignedPreKey(
    signedPreKeyId,
    bobSignedPreKey.keyPair,
    bobSignedPreKey.signature,
  );

  const oneTimePreKeyId = 1;
  const bobPreKey = await KeyHelper.generatePreKey(oneTimePreKeyId);
  await bobStore.storePreKey(oneTimePreKeyId, bobPreKey.keyPair);

  // 2. Build prekey bundle for Bob
  const bobPreKeyBundle: DeviceType = {
    identityKey: bobIdentityKeyPair.pubKey,
    registrationId: bobRegistrationId,
    signedPreKey: {
      keyId: bobSignedPreKey.keyId,
      publicKey: bobSignedPreKey.keyPair.pubKey,
      signature: bobSignedPreKey.signature,
    },
    preKey: {
      keyId: bobPreKey.keyId,
      publicKey: bobPreKey.keyPair.pubKey,
    },
  };

  // 3. Initialize Alice and establish session with Bob
  const aliceStore = storeFactory ? await storeFactory("alice") : new InMemorySignalProtocolStore();
  const aliceRegistrationId = KeyHelper.generateRegistrationId();
  const aliceIdentityKeyPair = await KeyHelper.generateIdentityKeyPair();
  await aliceStore.setLocalRegistrationId(aliceRegistrationId);
  await aliceStore.setIdentityKeyPair(aliceIdentityKeyPair);

  const bobAddress = new SignalProtocolAddress("bob", 1);
  const aliceSessionBuilder = new SessionBuilder(aliceStore, bobAddress);
  await aliceSessionBuilder.processPreKey(bobPreKeyBundle);

  // 4. Encrypt "hello" from Alice to Bob
  const aliceSessionCipher = new SessionCipher(aliceStore, bobAddress);
  const plaintextBytes = new TextEncoder().encode("hello");
  const ciphertext = await aliceSessionCipher.encrypt(plaintextBytes.buffer);

  if (!ciphertext.body) {
    throw new Error("Ciphertext body is empty");
  }

  // 5. Decrypt message on Bob's side
  const aliceAddress = new SignalProtocolAddress("alice", 1);
  const bobSessionCipher = new SessionCipher(bobStore, aliceAddress);

  let decryptedBuffer: ArrayBuffer;
  if (ciphertext.type === 3) {
    decryptedBuffer = await bobSessionCipher.decryptPreKeyWhisperMessage(ciphertext.body, "binary");
  } else {
    decryptedBuffer = await bobSessionCipher.decryptWhisperMessage(ciphertext.body, "binary");
  }

  const decrypted = new TextDecoder().decode(decryptedBuffer);

  return {
    library,
    decrypted,
  };
}

export interface PersistentSpikeResult {
  library: string;
  aliceDecrypted: string;
  bobDecrypted: string;
  aliceToBobEnvelopeType: 1 | 3;
  bobToAliceEnvelopeType: 1 | 3;
  aliceSafetyNumberFormatted?: string;
  bobSafetyNumberFormatted?: string;
  safetyNumbersMatch?: boolean;
}

export async function runPersistentSpike(): Promise<PersistentSpikeResult> {
  const library = "@privacyresearch/libsignal-protocol-typescript";

  const aliceStore = new IndexedDBSignalStore("alice");
  const bobStore = new IndexedDBSignalStore("bob");
  await aliceStore.wipe();
  await bobStore.wipe();

  const aliceProvision = await provisionKeys("alice", aliceStore);
  const bobProvision = await provisionKeys("bob", bobStore);

  const bundles = new InMemoryBundleProvider();
  bundles.register(aliceProvision.bundle);
  bundles.register(bobProvision.bundle);

  const aliceSession = new SessionManager("alice", aliceStore, bundles);
  const bobSession = new SessionManager("bob", bobStore, bundles);

  // Alice sends "hello" to Bob (initial message: X3DH handshake, envelope type 3)
  const aliceToBobEnvelope = await aliceSession.encrypt("bob", "hello");
  const bobDecrypted = await bobSession.decrypt("alice", aliceToBobEnvelope);

  // Bob sends "hi back" to Alice (reply on established session, envelope type 1)
  const bobToAliceEnvelope = await bobSession.encrypt("alice", "hi back");
  const aliceDecrypted = await aliceSession.decrypt("bob", bobToAliceEnvelope);

  // Compute safety numbers for Alice and Bob
  const aliceSN = await safetyNumberWith(aliceStore, "alice", "bob");
  const bobSN = await safetyNumberWith(bobStore, "bob", "alice");

  const aliceSafetyNumberFormatted = aliceSN ? formatSafetyNumber(aliceSN) : undefined;
  const bobSafetyNumberFormatted = bobSN ? formatSafetyNumber(bobSN) : undefined;
  const match =
    aliceSN && bobSN ? safetyNumbersMatch(aliceSN.digits, bobSN.digits) : false;

  return {
    library,
    aliceDecrypted,
    bobDecrypted,
    aliceToBobEnvelopeType: aliceToBobEnvelope.type,
    bobToAliceEnvelopeType: bobToAliceEnvelope.type,
    aliceSafetyNumberFormatted,
    bobSafetyNumberFormatted,
    safetyNumbersMatch: match,
  };
}

export interface KeyChangeSpikeResult {
  library: string;
  aliceDecrypted: string;
  decryptedSuccess: boolean;
  stateLabelText: "Unverified" | "Verified" | "Key changed";
  stateLabelColour: "amber" | "green" | "red";
  eventDirection?: "incoming" | "outgoing";
  safetyNumberBeforeFormatted?: string;
  safetyNumberAfterFormatted?: string;
  safetyNumbersDiffer: boolean;
}

export async function runKeyChangeSpike(): Promise<KeyChangeSpikeResult> {
  const library = "@privacyresearch/libsignal-protocol-typescript";

  const aliceStore = new IndexedDBSignalStore("alice");
  const bobStore1 = new IndexedDBSignalStore("bob");
  await aliceStore.wipe();
  await bobStore1.wipe();

  const aliceTrust = new VerificationStore("alice");
  await aliceTrust.wipe();

  const aliceProvision = await provisionKeys("alice", aliceStore);
  const bobProvision1 = await provisionKeys("bob", bobStore1);

  const bundles = new InMemoryBundleProvider();
  bundles.register(aliceProvision.bundle);
  bundles.register(bobProvision1.bundle);

  let lastKeyChangeEvent: KeyChangeEvent | undefined;

  const aliceSession = new SessionManager("alice", aliceStore, bundles);
  const bobSession1 = new SessionManager("bob", bobStore1, bundles);

  attachVerification(aliceSession, aliceTrust, {
    onKeyChanged: (event) => {
      lastKeyChangeEvent = event;
    },
  });

  // Initial message exchange so session and trusted keys are established
  const initialEnvelope = await aliceSession.encrypt("bob", "initial handshake");
  await bobSession1.decrypt("alice", initialEnvelope);

  // Safety number before key change
  const snBefore = await safetyNumberWith(aliceStore, "alice", "bob");
  const safetyNumberBeforeFormatted = snBefore ? formatSafetyNumber(snBefore) : undefined;

  // Re-provision Bob with a fresh IndexedDBSignalStore (wipe first)
  const bobStore2 = new IndexedDBSignalStore("bob");
  await bobStore2.wipe();
  const bobProvision2 = await provisionKeys("bob", bobStore2);

  // Re-register Bob's new bundle in the provider
  bundles.register(bobProvision2.bundle);

  // NEW Bob sends "I reinstalled" to Alice
  const bobSession2 = new SessionManager("bob", bobStore2, bundles);
  const reinstalledEnvelope = await bobSession2.encrypt("alice", "I reinstalled");

  // Alice decrypts it
  const aliceDecrypted = await aliceSession.decrypt("bob", reinstalledEnvelope);
  const decryptedSuccess = aliceDecrypted === "I reinstalled";

  // Alice's verification state for Bob
  const record = await aliceTrust.get("bob");
  const label = stateLabel(record?.state ?? "UNVERIFIED");

  // Safety number after key change
  const snAfter = await safetyNumberWith(aliceStore, "alice", "bob");
  const safetyNumberAfterFormatted = snAfter ? formatSafetyNumber(snAfter) : undefined;
  const safetyNumbersDiffer = Boolean(
    snBefore && snAfter && snBefore.digits !== snAfter.digits,
  );

  return {
    library,
    aliceDecrypted,
    decryptedSuccess,
    stateLabelText: label.text,
    stateLabelColour: label.colour,
    eventDirection: lastKeyChangeEvent?.direction,
    safetyNumberBeforeFormatted,
    safetyNumberAfterFormatted,
    safetyNumbersDiffer,
  };
}

