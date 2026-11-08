import { openDB, deleteDB, type DBSchema, type IDBPDatabase } from "idb";
import type {
  Direction,
  KeyPairType,
  SessionRecordType,
  StorageType,
} from "@privacyresearch/libsignal-protocol-typescript";

export interface StoredKeyPair {
  pubKey: ArrayBuffer;
  privKey: ArrayBuffer;
  signature?: ArrayBuffer;
}

export interface SignalDBSchema extends DBSchema {
  identity: {
    key: string;
    value: StoredKeyPair | number;
  };
  trustedIdentities: {
    key: string;
    value: ArrayBuffer;
  };
  preKeys: {
    key: number | string;
    value: StoredKeyPair;
  };
  signedPreKeys: {
    key: number | string;
    value: StoredKeyPair;
  };
  sessions: {
    key: string;
    value: SessionRecordType;
  };
}

export function areArrayBuffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const viewA = new Uint8Array(a);
  const viewB = new Uint8Array(b);
  for (let i = 0; i < viewA.length; i++) {
    if (viewA[i] !== viewB[i]) return false;
  }
  return true;
}

function toArrayBuffer(buf: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (buf instanceof ArrayBuffer) return buf;
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function normalizeKeyId(keyId: number | string): {
  primary: number | string;
  alt?: number | string;
} {
  if (typeof keyId === "number") {
    return { primary: keyId, alt: String(keyId) };
  }
  const parsed = Number(keyId);
  if (!Number.isNaN(parsed) && String(parsed) === keyId.trim()) {
    return { primary: parsed, alt: keyId };
  }
  return { primary: keyId };
}

export class IndexedDBSignalStore implements StorageType {
  private static readonly activeConnections = new Map<string, Set<IDBPDatabase<SignalDBSchema>>>();

  readonly userId: string;
  readonly dbName: string;
  private db: IDBPDatabase<SignalDBSchema> | null = null;

  constructor(userId: string) {
    this.userId = userId;
    this.dbName = `nullspace-signal-${userId}`;
  }

  private async getDb(): Promise<IDBPDatabase<SignalDBSchema>> {
    if (this.db) {
      return this.db;
    }

    const dbName = this.dbName;
    const db = await openDB<SignalDBSchema>(dbName, 1, {
      upgrade(database) {
        if (!database.objectStoreNames.contains("identity")) {
          database.createObjectStore("identity");
        }
        if (!database.objectStoreNames.contains("trustedIdentities")) {
          database.createObjectStore("trustedIdentities");
        }
        if (!database.objectStoreNames.contains("preKeys")) {
          database.createObjectStore("preKeys");
        }
        if (!database.objectStoreNames.contains("signedPreKeys")) {
          database.createObjectStore("signedPreKeys");
        }
        if (!database.objectStoreNames.contains("sessions")) {
          database.createObjectStore("sessions");
        }
      },
      blocking() {
        db.close();
      },
    });

    let set = IndexedDBSignalStore.activeConnections.get(dbName);
    if (!set) {
      set = new Set();
      IndexedDBSignalStore.activeConnections.set(dbName, set);
    }
    set.add(db);

    this.db = db;
    return this.db;
  }

  close(): void {
    if (this.db) {
      const set = IndexedDBSignalStore.activeConnections.get(this.dbName);
      if (set) {
        set.delete(this.db);
      }
      this.db.close();
      this.db = null;
    }
  }

  // --- Identity Key Pair & Registration ID ---

  async getIdentityKeyPair(): Promise<KeyPairType<ArrayBuffer> | undefined> {
    const db = await this.getDb();
    const val = await db.get("identity", "keyPair");
    if (!val || typeof val === "number") return undefined;
    return {
      pubKey: toArrayBuffer(val.pubKey),
      privKey: toArrayBuffer(val.privKey),
    };
  }

  async setIdentityKeyPair(keyPair: KeyPairType<ArrayBuffer>): Promise<void> {
    const db = await this.getDb();
    await db.put(
      "identity",
      {
        pubKey: toArrayBuffer(keyPair.pubKey),
        privKey: toArrayBuffer(keyPair.privKey),
      },
      "keyPair",
    );
  }

  async getLocalRegistrationId(): Promise<number | undefined> {
    const db = await this.getDb();
    const val = await db.get("identity", "registrationId");
    return typeof val === "number" ? val : undefined;
  }

  async setLocalRegistrationId(id: number): Promise<void> {
    const db = await this.getDb();
    await db.put("identity", id, "registrationId");
  }

  // --- Trusted Identities ---

  async isTrustedIdentity(
    identifier: string,
    identityKey: ArrayBuffer,
    direction?: Direction,
  ): Promise<boolean> {
    void direction;
    const existing = await this.loadIdentityKey(identifier);
    if (!existing) {
      // First use: return true and do NOT save
      return true;
    }
    return areArrayBuffersEqual(existing, toArrayBuffer(identityKey));
  }

  async identityChanged(address: string, newKey: ArrayBuffer): Promise<boolean> {
    const existing = await this.loadIdentityKey(address);
    if (!existing) {
      return false;
    }
    return !areArrayBuffersEqual(existing, toArrayBuffer(newKey));
  }

  async saveIdentity(
    encodedAddress: string,
    publicKey: ArrayBuffer,
    nonblockingApproval?: boolean,
  ): Promise<boolean> {
    void nonblockingApproval;
    const pubKeyBuf = toArrayBuffer(publicKey);
    const existing = await this.loadIdentityKey(encodedAddress);

    const db = await this.getDb();
    const tx = db.transaction("trustedIdentities", "readwrite");
    await tx.store.put(pubKeyBuf, encodedAddress);
    if (encodedAddress.includes(".")) {
      const baseName = encodedAddress.split(".")[0];
      await tx.store.put(pubKeyBuf, baseName);
    }
    await tx.done;

    if (!existing) {
      return false;
    }
    return !areArrayBuffersEqual(existing, pubKeyBuf);
  }

  async loadIdentityKey(address: string): Promise<ArrayBuffer | undefined> {
    const db = await this.getDb();
    let key = await db.get("trustedIdentities", address);
    if (!key && address.includes(".")) {
      key = await db.get("trustedIdentities", address.split(".")[0]);
    }
    return key;
  }

  async removeIdentityKey(address: string): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction("trustedIdentities", "readwrite");
    await tx.store.delete(address);
    if (address.includes(".")) {
      await tx.store.delete(address.split(".")[0]);
    }
    await tx.done;
  }

  async removeTrustedIdentity(address: string): Promise<void> {
    return this.removeIdentityKey(address);
  }

  // --- PreKeys ---

  async loadPreKey(keyId: number | string): Promise<KeyPairType<ArrayBuffer> | undefined> {
    const db = await this.getDb();
    const { primary, alt } = normalizeKeyId(keyId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- primary is valid IDB key (number | string)
    let val = await db.get("preKeys", primary as any);
    if (!val && alt !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- alt is valid IDB key
      val = await db.get("preKeys", alt as any);
    }
    if (!val) return undefined;
    return {
      pubKey: toArrayBuffer(val.pubKey),
      privKey: toArrayBuffer(val.privKey),
    };
  }

  async storePreKey(keyId: number | string, keyPair: KeyPairType<ArrayBuffer>): Promise<void> {
    const db = await this.getDb();
    const { primary } = normalizeKeyId(keyId);
    await db.put(
      "preKeys",
      {
        pubKey: toArrayBuffer(keyPair.pubKey),
        privKey: toArrayBuffer(keyPair.privKey),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- primary is valid IDB key
      primary as any,
    );
  }

  async removePreKey(keyId: number | string): Promise<void> {
    const db = await this.getDb();
    const { primary, alt } = normalizeKeyId(keyId);
    const tx = db.transaction("preKeys", "readwrite");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- valid IDB key
    await tx.store.delete(primary as any);
    if (alt !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- valid IDB key
      await tx.store.delete(alt as any);
    }
    await tx.done;
  }

  // --- Signed PreKeys ---

  async loadSignedPreKey(
    keyId: number | string,
  ): Promise<(KeyPairType<ArrayBuffer> & { signature?: ArrayBuffer }) | undefined> {
    const db = await this.getDb();
    const { primary, alt } = normalizeKeyId(keyId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- valid IDB key
    let val = await db.get("signedPreKeys", primary as any);
    if (!val && alt !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- valid IDB key
      val = await db.get("signedPreKeys", alt as any);
    }
    if (!val) return undefined;
    return {
      pubKey: toArrayBuffer(val.pubKey),
      privKey: toArrayBuffer(val.privKey),
      signature: val.signature ? toArrayBuffer(val.signature) : undefined,
    };
  }

  async storeSignedPreKey(
    keyId: number | string,
    keyPair: KeyPairType<ArrayBuffer>,
    signature?: ArrayBuffer,
  ): Promise<void> {
    const db = await this.getDb();
    const { primary } = normalizeKeyId(keyId);
    const sig = signature ?? (keyPair as { signature?: ArrayBuffer }).signature;
    await db.put(
      "signedPreKeys",
      {
        pubKey: toArrayBuffer(keyPair.pubKey),
        privKey: toArrayBuffer(keyPair.privKey),
        signature: sig ? toArrayBuffer(sig) : undefined,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- valid IDB key
      primary as any,
    );
  }

  async removeSignedPreKey(keyId: number | string): Promise<void> {
    const db = await this.getDb();
    const { primary, alt } = normalizeKeyId(keyId);
    const tx = db.transaction("signedPreKeys", "readwrite");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- valid IDB key
    await tx.store.delete(primary as any);
    if (alt !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- valid IDB key
      await tx.store.delete(alt as any);
    }
    await tx.done;
  }

  // --- Sessions ---

  async loadSession(encodedAddress: string): Promise<SessionRecordType | undefined> {
    const db = await this.getDb();
    return db.get("sessions", encodedAddress);
  }

  async storeSession(encodedAddress: string, record: SessionRecordType): Promise<void> {
    const db = await this.getDb();
    await db.put("sessions", record, encodedAddress);
  }

  async removeSession(encodedAddress: string): Promise<void> {
    const db = await this.getDb();
    await db.delete("sessions", encodedAddress);
  }

  async removeAllSessions(identifier?: string): Promise<void> {
    const db = await this.getDb();
    if (!identifier) {
      await db.clear("sessions");
      return;
    }
    const tx = db.transaction("sessions", "readwrite");
    const keys = await tx.store.getAllKeys();
    for (const key of keys) {
      const keyStr = String(key);
      if (keyStr === identifier || keyStr.startsWith(`${identifier}.`)) {
        await tx.store.delete(key);
      }
    }
    await tx.done;
  }

  // --- Database Management ---

  async wipe(): Promise<void> {
    const set = IndexedDBSignalStore.activeConnections.get(this.dbName);
    if (set) {
      for (const conn of set) {
        conn.close();
      }
      set.clear();
      IndexedDBSignalStore.activeConnections.delete(this.dbName);
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    await deleteDB(this.dbName);
  }
}
