import { KeyHelper } from "@privacyresearch/libsignal-protocol-typescript";
import { IndexedDBSignalStore } from "./IndexedDBSignalStore";
import { generateSignedPreKey, generateOneTimePreKeys } from "./keys";
import { toBase64, type PublicPreKeyBundle } from "./bundle";

export const SIGNED_PREKEY_ID_START = 1;
export const ONE_TIME_PREKEY_BATCH = 100;

export interface ProvisionResult {
  created: boolean;
  registrationId: number;
  bundle: PublicPreKeyBundle;
}

export async function countOneTimePreKeys(store: IndexedDBSignalStore): Promise<number> {
  const ids = await store.listPreKeyIds();
  return ids.length;
}

export async function provisionKeys(
  userId: string,
  store?: IndexedDBSignalStore,
): Promise<ProvisionResult> {
  const signalStore = store ?? new IndexedDBSignalStore(userId);

  // 1. Identity key pair and registration ID
  let created = false;
  let identityKeyPair = await signalStore.getIdentityKeyPair();
  let registrationId = await signalStore.getLocalRegistrationId();

  if (!identityKeyPair || registrationId === undefined) {
    identityKeyPair = await KeyHelper.generateIdentityKeyPair();
    registrationId = KeyHelper.generateRegistrationId();
    await Promise.all([
      signalStore.setIdentityKeyPair(identityKeyPair),
      signalStore.setLocalRegistrationId(registrationId),
    ]);
    created = true;
  }

  // 2. Ensure signed prekey exists
  let signedPreKeyIds = await signalStore.getSignedPreKeyIds();
  if (signedPreKeyIds.length === 0) {
    await generateSignedPreKey(signalStore, identityKeyPair, SIGNED_PREKEY_ID_START);
    signedPreKeyIds = await signalStore.getSignedPreKeyIds();
  }

  const activeSignedPreKeyId = signedPreKeyIds[signedPreKeyIds.length - 1];
  const signedPreKey = await signalStore.loadSignedPreKey(activeSignedPreKeyId);
  if (!signedPreKey || !signedPreKey.signature) {
    throw new Error(`Signed prekey ${activeSignedPreKeyId} is missing or has no signature attached`);
  }

  // 3. Ensure at least ONE_TIME_PREKEY_BATCH one-time prekeys exist
  const existingPreKeyIds = await signalStore.listPreKeyIds();
  const shortfall = Math.max(0, ONE_TIME_PREKEY_BATCH - existingPreKeyIds.length);
  if (shortfall > 0) {
    const highestId =
      existingPreKeyIds.length > 0 ? existingPreKeyIds[existingPreKeyIds.length - 1] : 0;
    const startId = highestId + 1;
    await generateOneTimePreKeys(signalStore, startId, shortfall);
  }

  // 4. Build public prekey bundle (never include private keys)
  const allPreKeyIds = await signalStore.listPreKeyIds();
  const oneTimePreKeys: Array<{ keyId: number; publicKey: string }> = [];
  for (const id of allPreKeyIds) {
    const preKey = await signalStore.loadPreKey(id);
    if (preKey) {
      oneTimePreKeys.push({
        keyId: id,
        publicKey: toBase64(preKey.pubKey),
      });
    }
  }

  const bundle: PublicPreKeyBundle = {
    userId,
    registrationId,
    identityKey: toBase64(identityKeyPair.pubKey),
    signedPreKey: {
      keyId: activeSignedPreKeyId,
      publicKey: toBase64(signedPreKey.pubKey),
      signature: toBase64(signedPreKey.signature),
    },
    oneTimePreKeys,
    createdAt: new Date().toISOString(),
  };

  return {
    created,
    registrationId,
    bundle,
  };
}
