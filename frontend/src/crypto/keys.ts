import {
  KeyHelper,
  type DeviceType,
  type KeyPairType,
  type PreKeyType,
  type SignedPublicPreKeyType,
  type StorageType,
} from "@privacyresearch/libsignal-protocol-typescript";

export interface IdentityData {
  identityKeyPair: KeyPairType<ArrayBuffer>;
  registrationId: number;
}

export interface SignalStoreIdentityOperations extends StorageType {
  getIdentityKeyPair(): Promise<KeyPairType<ArrayBuffer> | undefined>;
  setIdentityKeyPair(keyPair: KeyPairType<ArrayBuffer>): Promise<void>;
  getLocalRegistrationId(): Promise<number | undefined>;
  setLocalRegistrationId(id: number): Promise<void>;
}

export interface SignalStoreSignedPreKeyOperations extends StorageType {
  loadSignedPreKey(
    keyId: number | string,
  ): Promise<(KeyPairType<ArrayBuffer> & { signature?: ArrayBuffer }) | undefined>;
  storeSignedPreKey(
    keyId: number | string,
    keyPair: KeyPairType<ArrayBuffer>,
    signature?: ArrayBuffer,
  ): Promise<void>;
}

export async function ensureIdentity(store: SignalStoreIdentityOperations): Promise<IdentityData> {
  let [identityKeyPair, registrationId] = await Promise.all([
    store.getIdentityKeyPair(),
    store.getLocalRegistrationId(),
  ]);

  if (!identityKeyPair || registrationId === undefined) {
    identityKeyPair = await KeyHelper.generateIdentityKeyPair();
    registrationId = KeyHelper.generateRegistrationId();
    await Promise.all([
      store.setIdentityKeyPair(identityKeyPair),
      store.setLocalRegistrationId(registrationId),
    ]);
  }

  return {
    identityKeyPair,
    registrationId,
  };
}

export async function generateSignedPreKey(
  store: SignalStoreSignedPreKeyOperations,
  identityKeyPair: KeyPairType<ArrayBuffer>,
  keyId: number,
): Promise<SignedPublicPreKeyType<ArrayBuffer>> {
  const signedPreKey = await KeyHelper.generateSignedPreKey(identityKeyPair, keyId);
  await store.storeSignedPreKey(keyId, signedPreKey.keyPair, signedPreKey.signature);
  return {
    keyId: signedPreKey.keyId,
    publicKey: signedPreKey.keyPair.pubKey,
    signature: signedPreKey.signature,
  };
}

export async function generateOneTimePreKeys(
  store: StorageType,
  startId: number,
  count: number,
): Promise<PreKeyType<ArrayBuffer>[]> {
  const publicPreKeys: PreKeyType<ArrayBuffer>[] = [];
  for (let i = 0; i < count; i++) {
    const keyId = startId + i;
    const preKey = await KeyHelper.generatePreKey(keyId);
    await store.storePreKey(keyId, preKey.keyPair);
    publicPreKeys.push({
      keyId: preKey.keyId,
      publicKey: preKey.keyPair.pubKey,
    });
  }
  return publicPreKeys;
}

export async function buildPreKeyBundle(
  store: SignalStoreSignedPreKeyOperations,
  signedPreKeyId: number,
  oneTimePreKeyId?: number,
): Promise<DeviceType<ArrayBuffer>> {
  const [identityKeyPair, registrationId, signedPreKey] = await Promise.all([
    store.getIdentityKeyPair(),
    store.getLocalRegistrationId(),
    store.loadSignedPreKey(signedPreKeyId),
  ]);

  if (!identityKeyPair) {
    throw new Error("Identity key pair not found in store");
  }
  if (registrationId === undefined) {
    throw new Error("Registration ID not found in store");
  }
  if (!signedPreKey) {
    throw new Error(`Signed prekey ${signedPreKeyId} not found in store`);
  }

  const signature = signedPreKey.signature;
  if (!signature) {
    throw new Error(`Signed prekey ${signedPreKeyId} has no signature attached`);
  }

  let preKey: PreKeyType<ArrayBuffer> | undefined;
  if (oneTimePreKeyId !== undefined) {
    const loadedPreKey = await store.loadPreKey(oneTimePreKeyId);
    if (!loadedPreKey) {
      throw new Error(`One-time prekey ${oneTimePreKeyId} not found in store`);
    }
    preKey = {
      keyId: Number(oneTimePreKeyId),
      publicKey: loadedPreKey.pubKey,
    };
  }

  return {
    identityKey: identityKeyPair.pubKey,
    registrationId,
    signedPreKey: {
      keyId: Number(signedPreKeyId),
      publicKey: signedPreKey.pubKey,
      signature,
    },
    preKey,
  };
}
