/**
 * Verification State Machine
 *
 * | From State   | Event                        | To State    | Notes                                                              |
 * |--------------|------------------------------|-------------|--------------------------------------------------------------------|
 * | (none)       | recordFirstUse(k1)           | UNVERIFIED  | Trust On First Use (TOFU). Stores identityKey = k1                 |
 * | (none)       | observeIdentity(k1)          | UNVERIFIED  | Same as recordFirstUse; changed = false                            |
 * | UNVERIFIED   | observeIdentity(k1)          | UNVERIFIED  | Byte-for-byte matching key; changed = false                        |
 * | UNVERIFIED   | markVerified                 | VERIFIED    | User manual verification; sets verifiedAt                          |
 * | UNVERIFIED   | observeIdentity(k2)          | KEY_CHANGED | Key changed: prev = k1, identityKey = k2, changedAt = now, changed = true |
 * | VERIFIED     | observeIdentity(k1)          | VERIFIED    | Byte-for-byte matching key; changed = false                        |
 * | VERIFIED     | markVerified                 | VERIFIED    | Re-marking updates verifiedAt                                      |
 * | VERIFIED     | observeIdentity(k2)          | KEY_CHANGED | Key changed: prev = k1, identityKey = k2, changedAt = now, changed = true |
 * | KEY_CHANGED  | observeIdentity(k2)          | KEY_CHANGED | Same key as current changed key; changed = false                   |
 * | KEY_CHANGED  | observeIdentity(k3)          | KEY_CHANGED | Key changed again: prev = k2, identityKey = k3, changedAt = now, changed = true |
 * | KEY_CHANGED  | markVerified                 | VERIFIED    | User re-verified the new key: clears previousIdentityKey/changedAt |
 * | any          | reset                        | (none)      | Removes peer trust record from local store                         |
 * | any          | wipe                         | (none)      | Wipes entire trust database for the user                           |
 */

import { openDB, deleteDB, type DBSchema, type IDBPDatabase } from "idb";
import { areArrayBuffersEqual } from "./IndexedDBSignalStore";
import type { KeyChangeEvent, SessionManager } from "./session";

export type VerificationState = "UNVERIFIED" | "VERIFIED" | "KEY_CHANGED";

export type TrustRecord = {
  peerId: string;
  identityKey: ArrayBuffer; // the identity public key we currently trust for this peer
  state: VerificationState;
  verifiedAt?: string; // ISO 8601, set when the user marks VERIFIED
  previousIdentityKey?: ArrayBuffer; // set when state becomes KEY_CHANGED, so the UI can explain
  changedAt?: string;
};

export interface TrustDBSchema extends DBSchema {
  trust: {
    key: string;
    value: TrustRecord;
  };
}

function toArrayBuffer(buf: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (buf instanceof ArrayBuffer) return buf;
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function normalizeRecord(record: TrustRecord): TrustRecord {
  return {
    ...record,
    identityKey: toArrayBuffer(record.identityKey),
    previousIdentityKey: record.previousIdentityKey
      ? toArrayBuffer(record.previousIdentityKey)
      : undefined,
  };
}

export class VerificationStore {
  private static readonly activeConnections = new Map<string, Set<IDBPDatabase<TrustDBSchema>>>();

  readonly userId: string;
  readonly dbName: string;
  private db: IDBPDatabase<TrustDBSchema> | null = null;

  constructor(userId: string) {
    this.userId = userId;
    this.dbName = `nullspace-trust-${userId}`;
  }

  private async getDb(): Promise<IDBPDatabase<TrustDBSchema>> {
    if (this.db) {
      return this.db;
    }

    const dbName = this.dbName;
    const db = await openDB<TrustDBSchema>(dbName, 1, {
      upgrade(database) {
        if (!database.objectStoreNames.contains("trust")) {
          database.createObjectStore("trust", { keyPath: "peerId" });
        }
      },
      blocking() {
        db.close();
      },
    });

    let set = VerificationStore.activeConnections.get(dbName);
    if (!set) {
      set = new Set();
      VerificationStore.activeConnections.set(dbName, set);
    }
    set.add(db);

    this.db = db;
    return this.db;
  }

  close(): void {
    if (this.db) {
      const set = VerificationStore.activeConnections.get(this.dbName);
      if (set) {
        set.delete(this.db);
      }
      this.db.close();
      this.db = null;
    }
  }

  async get(peerId: string): Promise<TrustRecord | undefined> {
    const db = await this.getDb();
    const record = await db.get("trust", peerId);
    return record ? normalizeRecord(record) : undefined;
  }

  async list(): Promise<TrustRecord[]> {
    const db = await this.getDb();
    const records = await db.getAll("trust");
    return records.map(normalizeRecord);
  }

  async recordFirstUse(peerId: string, identityKey: ArrayBuffer): Promise<TrustRecord> {
    const db = await this.getDb();
    const tx = db.transaction("trust", "readwrite");
    const existing = await tx.store.get(peerId);
    if (existing) {
      await tx.done;
      return normalizeRecord(existing);
    }

    const record: TrustRecord = {
      peerId,
      identityKey: toArrayBuffer(identityKey),
      state: "UNVERIFIED",
    };
    await tx.store.put(record);
    await tx.done;
    return record;
  }

  async markVerified(peerId: string): Promise<TrustRecord> {
    const db = await this.getDb();
    const tx = db.transaction("trust", "readwrite");
    const existing = await tx.store.get(peerId);
    if (!existing) {
      await tx.done;
      throw new Error(`Cannot mark unknown peer as verified: ${peerId}`);
    }

    const record: TrustRecord = {
      peerId: existing.peerId,
      identityKey: toArrayBuffer(existing.identityKey),
      state: "VERIFIED",
      verifiedAt: new Date().toISOString(),
    };
    // From KEY_CHANGED -> VERIFIED means user re-verified the new key: clear previousIdentityKey and changedAt

    await tx.store.put(record);
    await tx.done;
    return record;
  }

  async observeIdentity(
    peerId: string,
    identityKey: ArrayBuffer,
  ): Promise<{ record: TrustRecord; changed: boolean }> {
    const keyBuf = toArrayBuffer(identityKey);
    const db = await this.getDb();
    const tx = db.transaction("trust", "readwrite");
    const existing = await tx.store.get(peerId);

    if (!existing) {
      const record: TrustRecord = {
        peerId,
        identityKey: keyBuf,
        state: "UNVERIFIED",
      };
      await tx.store.put(record);
      await tx.done;
      return { record, changed: false };
    }

    const currentKey = toArrayBuffer(existing.identityKey);
    if (areArrayBuffersEqual(currentKey, keyBuf)) {
      await tx.done;
      return { record: normalizeRecord(existing), changed: false };
    }

    // Key changed: transition to KEY_CHANGED regardless of prior state
    const record: TrustRecord = {
      peerId,
      identityKey: keyBuf,
      state: "KEY_CHANGED",
      previousIdentityKey: currentKey,
      changedAt: new Date().toISOString(),
      verifiedAt: existing.verifiedAt,
    };
    await tx.store.put(record);
    await tx.done;
    return { record, changed: true };
  }

  async reset(peerId: string): Promise<void> {
    const db = await this.getDb();
    await db.delete("trust", peerId);
  }

  async wipe(): Promise<void> {
    const set = VerificationStore.activeConnections.get(this.dbName);
    if (set) {
      for (const conn of set) {
        conn.close();
      }
      set.clear();
      VerificationStore.activeConnections.delete(this.dbName);
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    await deleteDB(this.dbName);
  }
}

export function stateLabel(state: VerificationState): {
  text: "Unverified" | "Verified" | "Key changed";
  colour: "amber" | "green" | "red";
} {
  switch (state) {
    case "UNVERIFIED":
      return { text: "Unverified", colour: "amber" };
    case "VERIFIED":
      return { text: "Verified", colour: "green" };
    case "KEY_CHANGED":
      return { text: "Key changed", colour: "red" };
  }
}

export interface AttachVerificationOptions {
  onKeyChanged?: (event: KeyChangeEvent, record: TrustRecord) => void;
}

export function attachVerification(
  sessionManager: SessionManager,
  verificationStore: VerificationStore,
  options?: AttachVerificationOptions,
): () => void {
  const unsubIdentity = sessionManager.addOnIdentityListener(
    async (peerId: string, identityKey: ArrayBuffer) => {
      await verificationStore.observeIdentity(peerId, identityKey);
    },
  );

  const unsubKeyChanged = sessionManager.addOnKeyChangedListener(
    async (event: KeyChangeEvent) => {
      if (options?.onKeyChanged) {
        const record = await verificationStore.get(event.peerId);
        if (record) {
          options.onKeyChanged(event, record);
        }
      }
    },
  );

  return () => {
    unsubIdentity();
    unsubKeyChanged();
  };
}
