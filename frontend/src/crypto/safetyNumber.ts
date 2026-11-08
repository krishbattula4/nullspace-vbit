import { FingerprintGenerator } from "@privacyresearch/libsignal-protocol-typescript";
import type { IndexedDBSignalStore } from "./IndexedDBSignalStore";

export const FINGERPRINT_ITERATIONS = 5200;

export type SafetyNumber = {
  digits: string;
  groups: string[];
  localUserId: string;
  remoteUserId: string;
};

function userIdToBinaryString(userId: string): string {
  const bytes = new TextEncoder().encode(userId);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return binary;
}

export async function computeSafetyNumber(
  localUserId: string,
  localIdentityKey: ArrayBuffer,
  remoteUserId: string,
  remoteIdentityKey: ArrayBuffer,
): Promise<SafetyNumber> {
  const generator = new FingerprintGenerator(FINGERPRINT_ITERATIONS);
  const localIdBin = userIdToBinaryString(localUserId);
  const remoteIdBin = userIdToBinaryString(remoteUserId);

  const digits = await generator.createFor(
    localIdBin,
    localIdentityKey,
    remoteIdBin,
    remoteIdentityKey,
  );

  if (digits.length !== 60 || !/^[0-9]{60}$/.test(digits)) {
    throw new Error(`Invalid fingerprint digits produced: expected 60 digits, got ${digits.length}`);
  }

  const groups: string[] = [];
  for (let i = 0; i < digits.length; i += 5) {
    groups.push(digits.slice(i, i + 5));
  }

  return {
    digits,
    groups,
    localUserId,
    remoteUserId,
  };
}

export async function safetyNumberWith(
  store: IndexedDBSignalStore,
  localUserId: string,
  remoteUserId: string,
): Promise<SafetyNumber | null> {
  const localKeyPair = await store.getIdentityKeyPair();
  if (!localKeyPair || !localKeyPair.pubKey) {
    return null;
  }

  let remoteIdentityKey = await store.loadIdentityKey(`${remoteUserId}.1`);
  if (!remoteIdentityKey) {
    remoteIdentityKey = await store.loadIdentityKey(remoteUserId);
  }
  if (!remoteIdentityKey) {
    return null;
  }

  return computeSafetyNumber(
    localUserId,
    localKeyPair.pubKey,
    remoteUserId,
    remoteIdentityKey,
  );
}

export function formatSafetyNumber(sn: SafetyNumber): string {
  const line1 = sn.groups.slice(0, 4).join(" ");
  const line2 = sn.groups.slice(4, 8).join(" ");
  const line3 = sn.groups.slice(8, 12).join(" ");
  return `${line1}\n${line2}\n${line3}`;
}

export function safetyNumbersMatch(a: string, b: string): boolean {
  const cleanA = a.replace(/\s+/g, "");
  const cleanB = b.replace(/\s+/g, "");
  return cleanA.length > 0 && cleanA === cleanB;
}
