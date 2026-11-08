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
import { SessionManager } from "./session";

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

  return {
    library,
    aliceDecrypted,
    bobDecrypted,
    aliceToBobEnvelopeType: aliceToBobEnvelope.type,
    bobToAliceEnvelopeType: bobToAliceEnvelope.type,
  };
}

