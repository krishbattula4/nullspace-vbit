import { openDB, deleteDB, type DBSchema, type IDBPDatabase } from "idb";
import type { IndexedDBSignalStore } from "./IndexedDBSignalStore";
import { generateOneTimePreKeys, generateSignedPreKey } from "./keys";
import { toBase64, type PublicPreKeyBundle } from "./bundle";

export const LOW_WATER_MARK = 20;
export const REPLENISH_BATCH = 100;
export const MAX_PER_UPLOAD = 200;
export const SIGNED_PREKEY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PrekeyStateRecord {
  nextPreKeyId: number;
  activeSignedPreKeyId: number | null;
  lastRotatedAt: string | null;
}

export interface PrekeyDBSchema extends DBSchema {
  state: {
    key: string;
    value: PrekeyStateRecord;
  };
}

export class PrekeyState {
  private static readonly activeConnections = new Map<string, Set<IDBPDatabase<PrekeyDBSchema>>>();

  readonly userId: string;
  readonly dbName: string;
  private db: IDBPDatabase<PrekeyDBSchema> | null = null;

  constructor(userId: string) {
    this.userId = userId;
    this.dbName = `nullspace-prekeys-${userId}`;
  }

  private async getDb(): Promise<IDBPDatabase<PrekeyDBSchema>> {
    if (this.db) {
      return this.db;
    }
    const dbName = this.dbName;
    const db = await openDB<PrekeyDBSchema>(dbName, 1, {
      upgrade(database) {
        if (!database.objectStoreNames.contains("state")) {
          database.createObjectStore("state");
        }
      },
      blocking() {
        db.close();
      },
    });

    let set = PrekeyState.activeConnections.get(dbName);
    if (!set) {
      set = new Set();
      PrekeyState.activeConnections.set(dbName, set);
    }
    set.add(db);

    this.db = db;
    return this.db;
  }

  async get(): Promise<PrekeyStateRecord | null> {
    const db = await this.getDb();
    const val = await db.get("state", "current");
    return val ?? null;
  }

  async save(record: PrekeyStateRecord): Promise<void> {
    const db = await this.getDb();
    await db.put("state", record, "current");
  }

  close(): void {
    if (this.db) {
      const set = PrekeyState.activeConnections.get(this.dbName);
      if (set) {
        set.delete(this.db);
      }
      this.db.close();
      this.db = null;
    }
  }

  async wipe(): Promise<void> {
    const set = PrekeyState.activeConnections.get(this.dbName);
    if (set) {
      for (const conn of set) {
        conn.close();
      }
      set.clear();
      PrekeyState.activeConnections.delete(this.dbName);
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    await deleteDB(this.dbName);
  }
}

export async function wipePrekeyState(userId: string): Promise<void> {
  const state = new PrekeyState(userId);
  await state.wipe();
}

export interface MaintenanceArgs {
  store: IndexedDBSignalStore;
  userId: string;
  authFetch: (path: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}

export type MaintenanceResult =
  | { status: "ok"; replenished: number; rotated: boolean; serverCount: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason?: string };

const inFlightMap = new Map<string, Promise<MaintenanceResult>>();

export async function maintainPrekeys(args: MaintenanceArgs): Promise<MaintenanceResult> {
  const existing = inFlightMap.get(args.userId);
  if (existing) {
    return existing;
  }

  const run = (async () => {
    if (
      typeof navigator !== "undefined" &&
      navigator.locks &&
      typeof navigator.locks.request === "function"
    ) {
      return await navigator.locks.request(`nullspace-prekeys-${args.userId}`, async () => {
        return await executeMaintenance(args);
      });
    }
    return await executeMaintenance(args);
  })();

  inFlightMap.set(args.userId, run);
  try {
    return await run;
  } finally {
    inFlightMap.delete(args.userId);
  }
}

async function executeMaintenance(args: MaintenanceArgs): Promise<MaintenanceResult> {
  const { store, userId, authFetch, now } = args;
  const currentTimeMs = now ? now() : Date.now();
  const prekeyState = new PrekeyState(userId);

  try {
    // 2. Call GET /keys/count. If the request fails (network or non-2xx) return { status: "skipped", reason } and change NOTHING
    let countRes: Response;
    try {
      countRes = await authFetch("/keys/count", { method: "GET" });
    } catch (err) {
      return { status: "skipped", reason: err instanceof Error ? err.message : String(err) };
    }

    if (!countRes.ok) {
      return { status: "skipped", reason: `HTTP ${countRes.status}` };
    }

    let countData: { one_time_prekeys: number; signed_prekey_id: number | null };
    try {
      countData = (await countRes.json()) as {
        one_time_prekeys: number;
        signed_prekey_id: number | null;
      };
    } catch {
      return { status: "skipped", reason: "Invalid JSON response from GET /keys/count" };
    }

    if (typeof countData.one_time_prekeys !== "number") {
      return { status: "skipped", reason: "Missing one_time_prekeys in count response" };
    }

    let serverCount = countData.one_time_prekeys;
    let replenishedCount = 0;

    // 3. Replenish: if one_time_prekeys < LOW_WATER_MARK
    if (serverCount < LOW_WATER_MARK) {
      const identityKeyPair = await store.getIdentityKeyPair();
      const registrationId = await store.getLocalRegistrationId();
      if (!identityKeyPair || registrationId === undefined) {
        return { status: "failed", reason: "Missing identity credentials in store" };
      }

      const signedPreKeyIds = await store.getSignedPreKeyIds();
      if (signedPreKeyIds.length === 0) {
        return { status: "failed", reason: "Missing signed prekeys in store" };
      }
      const currentSignedPreKeyId = signedPreKeyIds[signedPreKeyIds.length - 1];
      const currentSignedPreKey = await store.loadSignedPreKey(currentSignedPreKeyId);
      if (!currentSignedPreKey || !currentSignedPreKey.signature) {
        return {
          status: "failed",
          reason: `Signed prekey ${currentSignedPreKeyId} is invalid or has no signature`,
        };
      }

      let attempt = 0;
      let uploadSuccess = false;

      while (attempt < 2 && !uploadSuccess) {
        attempt++;

        const state = await prekeyState.get();
        const existingPreKeyIds = await store.listPreKeyIds();
        const highestId =
          existingPreKeyIds.length > 0 ? existingPreKeyIds[existingPreKeyIds.length - 1] : 0;
        const startId = state?.nextPreKeyId ?? highestId + 1;

        // Generate REPLENISH_BATCH new one-time prekeys
        const newPreKeys = await generateOneTimePreKeys(store, startId, REPLENISH_BATCH);

        // Advance and SAVE counter BEFORE uploading (so a crash can never cause id reuse)
        const nextPreKeyId = startId + REPLENISH_BATCH;
        await prekeyState.save({
          nextPreKeyId,
          activeSignedPreKeyId: state?.activeSignedPreKeyId ?? countData.signed_prekey_id,
          lastRotatedAt: state?.lastRotatedAt ?? null,
        });

        // PUT /keys/bundle split into chunks of at most MAX_PER_UPLOAD
        let hasConflict = false;
        let lastAvailableCount = serverCount;

        for (let i = 0; i < newPreKeys.length; i += MAX_PER_UPLOAD) {
          const chunk = newPreKeys.slice(i, i + MAX_PER_UPLOAD);
          const bundle: PublicPreKeyBundle = {
            userId,
            registrationId,
            identityKey: toBase64(identityKeyPair.pubKey),
            signedPreKey: {
              keyId: currentSignedPreKeyId,
              publicKey: toBase64(currentSignedPreKey.pubKey),
              signature: toBase64(currentSignedPreKey.signature),
            },
            oneTimePreKeys: chunk.map((k) => ({
              keyId: k.keyId,
              publicKey: toBase64(k.publicKey),
            })),
            createdAt: new Date(currentTimeMs).toISOString(),
          };

          let putRes: Response;
          try {
            putRes = await authFetch("/keys/bundle", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(bundle),
            });
          } catch (err) {
            return {
              status: "failed",
              reason: err instanceof Error ? err.message : String(err),
            };
          }

          if (putRes.status === 409) {
            hasConflict = true;
            break;
          }

          if (!putRes.ok) {
            return {
              status: "failed",
              reason: `PUT /keys/bundle failed with HTTP ${putRes.status}`,
            };
          }

          // The real PUT response is only {identity_changed}; do not read any other field.
          // The server now holds `chunk.length` more unconsumed keys than before.
          lastAvailableCount += chunk.length;
        }

        if (hasConflict) {
          if (attempt === 1) {
            // Advance counter by 1000 and retry exactly once
            const currentState = await prekeyState.get();
            const currentCounter = currentState?.nextPreKeyId ?? nextPreKeyId;
            const advancedCounter = currentCounter + 1000;
            await prekeyState.save({
              nextPreKeyId: advancedCounter,
              activeSignedPreKeyId:
                currentState?.activeSignedPreKeyId ?? countData.signed_prekey_id,
              lastRotatedAt: currentState?.lastRotatedAt ?? null,
            });
            continue;
          } else {
            return { status: "failed", reason: "Prekey ID conflict after retry" };
          }
        }

        uploadSuccess = true;
        replenishedCount += REPLENISH_BATCH;
        serverCount = lastAvailableCount;
      }

      if (!uploadSuccess) {
        return { status: "failed", reason: "Replenishment failed" };
      }
    }

    // 4. Rotate signed prekey
    let didRotate = false;
    const stateAfterReplenish = await prekeyState.get();
    let activeSignedPreKeyId =
      stateAfterReplenish?.activeSignedPreKeyId ?? countData.signed_prekey_id;
    let lastRotatedAt = stateAfterReplenish?.lastRotatedAt ?? null;

    if (lastRotatedAt === null) {
      // First run: record lastRotatedAt = now (do not rotate on first run)
      lastRotatedAt = new Date(currentTimeMs).toISOString();
      const existingPreKeyIds = await store.listPreKeyIds();
      const highestPreKeyId =
        existingPreKeyIds.length > 0 ? existingPreKeyIds[existingPreKeyIds.length - 1] : 0;

      await prekeyState.save({
        nextPreKeyId: stateAfterReplenish?.nextPreKeyId ?? highestPreKeyId + 1,
        activeSignedPreKeyId,
        lastRotatedAt,
      });
    } else {
      const ageMs = currentTimeMs - Date.parse(lastRotatedAt);
      if (ageMs >= SIGNED_PREKEY_MAX_AGE_MS) {
        const identityKeyPair = await store.getIdentityKeyPair();
        const registrationId = await store.getLocalRegistrationId();
        if (!identityKeyPair || registrationId === undefined) {
          return { status: "failed", reason: "Missing identity credentials for rotation" };
        }

        const existingSignedIds = await store.getSignedPreKeyIds();
        const highestExistingSignedId =
          existingSignedIds.length > 0 ? existingSignedIds[existingSignedIds.length - 1] : 0;

        let targetSignedKeyId: number;
        // Check if an unconfirmed signed prekey was already generated (from a previous failed PUT)
        if (activeSignedPreKeyId !== null && highestExistingSignedId > activeSignedPreKeyId) {
          targetSignedKeyId = highestExistingSignedId;
        } else {
          targetSignedKeyId = highestExistingSignedId + 1;
          await generateSignedPreKey(store, identityKeyPair, targetSignedKeyId);
        }

        const signedPreKeyRecord = await store.loadSignedPreKey(targetSignedKeyId);
        if (!signedPreKeyRecord || !signedPreKeyRecord.signature) {
          return {
            status: "failed",
            reason: `Signed prekey ${targetSignedKeyId} could not be loaded or has no signature`,
          };
        }

        const rotationBundle: PublicPreKeyBundle = {
          userId,
          registrationId,
          identityKey: toBase64(identityKeyPair.pubKey),
          signedPreKey: {
            keyId: targetSignedKeyId,
            publicKey: toBase64(signedPreKeyRecord.pubKey),
            signature: toBase64(signedPreKeyRecord.signature),
          },
          oneTimePreKeys: [],
          createdAt: new Date(currentTimeMs).toISOString(),
        };

        let putRes: Response;
        try {
          putRes = await authFetch("/keys/bundle", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(rotationBundle),
          });
        } catch (err) {
          return {
            status: "failed",
            reason: err instanceof Error ? err.message : String(err),
          };
        }

        if (!putRes.ok) {
          return { status: "failed", reason: `Rotation upload failed with HTTP ${putRes.status}` };
        }

        // ONLY after a 200:
        const previousActiveSignedPreKeyId = activeSignedPreKeyId;
        activeSignedPreKeyId = targetSignedKeyId;
        lastRotatedAt = new Date(currentTimeMs).toISOString();

        const currentState = await prekeyState.get();
        const existingPreKeyIds = await store.listPreKeyIds();
        const highestPreKeyId =
          existingPreKeyIds.length > 0 ? existingPreKeyIds[existingPreKeyIds.length - 1] : 0;

        await prekeyState.save({
          nextPreKeyId: currentState?.nextPreKeyId ?? highestPreKeyId + 1,
          activeSignedPreKeyId,
          lastRotatedAt,
        });

        // 5. Keep the previous signed prekey:
        // delete from the local store every signed prekey whose id is lower than the PREVIOUS active one (so the newest two remain)
        if (previousActiveSignedPreKeyId !== null) {
          const allSignedIds = await store.getSignedPreKeyIds();
          for (const id of allSignedIds) {
            if (id < previousActiveSignedPreKeyId) {
              await store.removeSignedPreKey(id);
            }
          }
        }

        didRotate = true;
      }
    }

    return {
      status: "ok",
      replenished: replenishedCount,
      rotated: didRotate,
      serverCount,
    };
  } finally {
    prekeyState.close();
  }
}
