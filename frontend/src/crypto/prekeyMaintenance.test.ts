import { afterEach, describe, expect, it } from "vitest";
import { IndexedDBSignalStore } from "./IndexedDBSignalStore";
import { provisionKeys } from "./provision";
import {
  maintainPrekeys,
  PrekeyState,
  wipePrekeyState,
  LOW_WATER_MARK,
  SIGNED_PREKEY_MAX_AGE_MS,
} from "./prekeyMaintenance";
import { toBase64, type PublicPreKeyBundle } from "./bundle";
import { InMemoryBundleProvider } from "./bundleProvider";
import { SessionManager } from "./session";

interface FakeServerPreKey {
  keyId: number;
  publicKey: string;
  consumed: boolean;
}

interface FakeServerSignedPreKey {
  keyId: number;
  publicKey: string;
  signature: string;
}

class FakeServer {
  public oneTimePreKeys = new Map<number, FakeServerPreKey>();
  public signedPreKeys: FakeServerSignedPreKey[] = [];
  public identityKey: string | null = null;
  public registrationId: number | null = null;
  public conflictOnNextPut = false;
  public alwaysConflict = false;
  public failNextCount = false;
  public failNextPutNetwork = false;
  public countCalls = 0;
  public putCalls = 0;
  public conflictCount = 0;
  public hasDuplicateDifferentKey = false;
  public requests: Array<{ path: string; init?: RequestInit }> = [];

  constructor(public userId: string) {}

  consumeOne(): FakeServerPreKey | null {
    for (const prekey of this.oneTimePreKeys.values()) {
      if (!prekey.consumed) {
        prekey.consumed = true;
        return prekey;
      }
    }
    return null;
  }

  getUnconsumedCount(): number {
    let count = 0;
    for (const prekey of this.oneTimePreKeys.values()) {
      if (!prekey.consumed) {
        count++;
      }
    }
    return count;
  }

  getNewestSignedPreKey(): FakeServerSignedPreKey | null {
    if (this.signedPreKeys.length === 0) return null;
    return this.signedPreKeys[this.signedPreKeys.length - 1];
  }

  async authFetch(path: string, init?: RequestInit): Promise<Response> {
    this.requests.push({ path, init });

    if (path === "/keys/count") {
      this.countCalls++;
      if (this.failNextCount) {
        this.failNextCount = false;
        throw new Error("Network error during /keys/count");
      }
      const data = {
        one_time_prekeys: this.getUnconsumedCount(),
        signed_prekey_id: this.getNewestSignedPreKey()?.keyId ?? null,
      };
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (path === "/keys/bundle" && (init?.method === "PUT" || !init?.method)) {
      this.putCalls++;
      if (this.failNextPutNetwork) {
        this.failNextPutNetwork = false;
        throw new Error("Network error during /keys/bundle");
      }

      if (this.alwaysConflict || this.conflictOnNextPut) {
        this.conflictOnNextPut = false;
        this.conflictCount++;
        return new Response(JSON.stringify({ detail: "prekey_id_conflict" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }

      const body = JSON.parse(init?.body as string) as PublicPreKeyBundle;

      if (body.userId !== this.userId) {
        return new Response(JSON.stringify({ detail: "user_id_mismatch" }), { status: 400 });
      }

      if (body.oneTimePreKeys && body.oneTimePreKeys.length > 200) {
        return new Response(JSON.stringify({ detail: "too_many_prekeys" }), { status: 400 });
      }

      // Check conflict: a keyId that already exists on the server (even if already consumed) with a DIFFERENT public key
      for (const otk of body.oneTimePreKeys) {
        const existing = this.oneTimePreKeys.get(otk.keyId);
        if (existing && existing.publicKey !== otk.publicKey) {
          this.conflictCount++;
          this.hasDuplicateDifferentKey = true;
          return new Response(JSON.stringify({ detail: "prekey_id_conflict" }), {
            status: 409,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      // Idempotent: add new ones, identical re-upload ignored
      for (const otk of body.oneTimePreKeys) {
        const existing = this.oneTimePreKeys.get(otk.keyId);
        if (!existing) {
          this.oneTimePreKeys.set(otk.keyId, {
            keyId: otk.keyId,
            publicKey: otk.publicKey,
            consumed: false,
          });
        }
      }

      // Signed prekey: older signed prekeys stay on the server, newest is served
      if (body.signedPreKey) {
        const existingSpk = this.signedPreKeys.find((s) => s.keyId === body.signedPreKey.keyId);
        if (!existingSpk) {
          this.signedPreKeys.push({ ...body.signedPreKey });
        }
      }

      const identityChanged = this.identityKey !== null && this.identityKey !== body.identityKey;
      this.identityKey = body.identityKey;
      this.registrationId = body.registrationId;

      // Mirrors the real server: the PUT response body is only {identity_changed}.
      return new Response(
        JSON.stringify({
          identity_changed: identityChanged,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return new Response(JSON.stringify({ detail: "not_found" }), { status: 404 });
  }
}

describe("TASK P3.4 Prekey replenishment and signed prekey rotation", () => {
  const userIdsToClean: string[] = [];

  function createUserId(prefix: string): string {
    const id = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    userIdsToClean.push(id);
    return id;
  }

  afterEach(async () => {
    while (userIdsToClean.length > 0) {
      const id = userIdsToClean.pop();
      if (id) {
        await wipePrekeyState(id);
        const store = new IndexedDBSignalStore(id);
        await store.wipe();
      }
    }
  });

  // a. Count 100 and fresh state: nothing uploaded, status ok, replenished 0.
  it("a. Count 100 and fresh state: nothing uploaded, status ok, replenished 0", async () => {
    const userId = createUserId("test-a");
    const store = new IndexedDBSignalStore(userId);
    const provision = await provisionKeys(userId, store);

    const server = new FakeServer(userId);
    await server.authFetch("/keys/bundle", {
      method: "PUT",
      body: JSON.stringify(provision.bundle),
    });

    expect(server.getUnconsumedCount()).toBe(100);
    const initialPutCalls = server.putCalls;

    const result = await maintainPrekeys({
      store,
      userId,
      authFetch: (p, i) => server.authFetch(p, i),
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.replenished).toBe(0);
      expect(result.rotated).toBe(false);
      expect(result.serverCount).toBe(100);
    }
    expect(server.putCalls).toBe(initialPutCalls);
  });

  // b. Count 19: exactly 100 new prekeys are generated and uploaded; the new ids continue after the previous counter; nothing private is in any request body
  it("b. Count 19: exactly 100 new prekeys are generated and uploaded; the new ids continue after the previous counter; nothing private is in any request body", async () => {
    const userId = createUserId("test-b");
    const store = new IndexedDBSignalStore(userId);
    const provision = await provisionKeys(userId, store);

    const server = new FakeServer(userId);
    await server.authFetch("/keys/bundle", {
      method: "PUT",
      body: JSON.stringify(provision.bundle),
    });

    // Consume until 19 keys remain
    while (server.getUnconsumedCount() > 19) {
      server.consumeOne();
    }
    expect(server.getUnconsumedCount()).toBe(19);

    const result = await maintainPrekeys({
      store,
      userId,
      authFetch: (p, i) => server.authFetch(p, i),
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.replenished).toBe(100);
      expect(result.rotated).toBe(false);
      expect(result.serverCount).toBe(119);
    }

    // Verify IDs continue after previous counter (101..200)
    for (let id = 101; id <= 200; id++) {
      expect(server.oneTimePreKeys.has(id)).toBe(true);
    }
    expect(server.oneTimePreKeys.has(201)).toBe(false);

    // Verify nothing private is in any request body
    const identity = await store.getIdentityKeyPair();
    expect(identity).toBeDefined();
    const identityPrivB64 = toBase64(identity!.privKey);

    const signedPreKey = await store.loadSignedPreKey(1);
    expect(signedPreKey).toBeDefined();
    const signedPreKeyPrivB64 = toBase64(signedPreKey!.privKey);

    for (const req of server.requests) {
      if (req.init?.body) {
        const bodyStr = req.init.body as string;
        expect(bodyStr.toLowerCase()).not.toContain('"priv');
        expect(bodyStr).not.toContain(identityPrivB64);
        expect(bodyStr).not.toContain(signedPreKeyPrivB64);

        // Check each uploaded prekey's private key
        for (let id = 101; id <= 200; id++) {
          const otk = await store.loadPreKey(id);
          if (otk) {
            const otkPrivB64 = toBase64(otk.privKey);
            expect(bodyStr).not.toContain(otkPrivB64);
          }
        }
      }
    }
  });

  // c. SOAK (the acceptance criterion)
  it(
    "c. SOAK (the acceptance criterion): 200 iterations of consumeOne + maintainPrekeys",
    async () => {
      const userId = createUserId("test-soak");
      const store = new IndexedDBSignalStore(userId);
      const provision = await provisionKeys(userId, store);

      const server = new FakeServer(userId);
      await server.authFetch("/keys/bundle", {
        method: "PUT",
        body: JSON.stringify(provision.bundle),
      });

      for (let i = 0; i < 200; i++) {
        const consumed = server.consumeOne();
        expect(consumed).not.toBeNull();

        const countImmediatelyAfterConsume = server.getUnconsumedCount();
        expect(countImmediatelyAfterConsume).toBeGreaterThanOrEqual(LOW_WATER_MARK - 1);

        const result = await maintainPrekeys({
          store,
          userId,
          authFetch: (p, i) => server.authFetch(p, i),
        });

        expect(result.status).toBe("ok");
        const countImmediatelyAfterMaintain = server.getUnconsumedCount();
        expect(countImmediatelyAfterMaintain).toBeGreaterThanOrEqual(LOW_WATER_MARK);
      }

      expect(server.conflictCount).toBe(0);
      expect(server.hasDuplicateDifferentKey).toBe(false);
      expect(server.putCalls).toBeGreaterThan(1);
    },
    30000,
  );

  // d. Id reuse regression: consume ALL 100 prekeys on the fake server, remove all of them from the local store, run maintainPrekeys; uploads 101 and up with no 409
  it("d. Id reuse regression: consume ALL 100 prekeys, remove all from local store, run maintainPrekeys", async () => {
    const userId = createUserId("test-d");
    const store = new IndexedDBSignalStore(userId);
    const provision = await provisionKeys(userId, store);

    const server = new FakeServer(userId);
    await server.authFetch("/keys/bundle", {
      method: "PUT",
      body: JSON.stringify(provision.bundle),
    });

    // Consume all 100 prekeys on the fake server
    while (server.getUnconsumedCount() > 0) {
      server.consumeOne();
    }
    expect(server.getUnconsumedCount()).toBe(0);

    // Remove all 100 prekeys from the local store
    for (let id = 1; id <= 100; id++) {
      await store.removePreKey(id);
    }
    expect(await store.listPreKeyIds()).toHaveLength(0);

    // Run maintainPrekeys
    const result = await maintainPrekeys({
      store,
      userId,
      authFetch: (p, i) => server.authFetch(p, i),
    });

    expect(result.status).toBe("ok");
    expect(server.conflictCount).toBe(0);

    // New keys are 101..200
    for (let id = 101; id <= 200; id++) {
      expect(server.oneTimePreKeys.has(id)).toBe(true);
    }
    expect(server.getUnconsumedCount()).toBe(100);
  });

  // e. 409 handling: make the fake server answer the first PUT with 409; advances counter by 1000, retries once and succeeds; second consecutive 409 gives status failed
  it("e. 409 handling: advances counter by 1000 and retries once; second consecutive 409 gives status failed without throwing", async () => {
    const userId = createUserId("test-e");
    const store = new IndexedDBSignalStore(userId);
    const provision = await provisionKeys(userId, store);

    const server = new FakeServer(userId);
    await server.authFetch("/keys/bundle", {
      method: "PUT",
      body: JSON.stringify(provision.bundle),
    });

    // Drain server down to 10 keys
    while (server.getUnconsumedCount() > 10) {
      server.consumeOne();
    }

    // First run: server answers first PUT with 409
    server.conflictOnNextPut = true;
    const result1 = await maintainPrekeys({
      store,
      userId,
      authFetch: (p, i) => server.authFetch(p, i),
    });

    expect(result1.status).toBe("ok");
    // After conflict at 101, counter was bumped by 1000, so new keys start at 1201..1300
    const state = await new PrekeyState(userId).get();
    expect(state?.nextPreKeyId).toBeGreaterThanOrEqual(1301);

    // Second run: server answers consecutive PUTs with 409
    while (server.getUnconsumedCount() > 10) {
      server.consumeOne();
    }
    server.alwaysConflict = true;

    const result2 = await maintainPrekeys({
      store,
      userId,
      authFetch: (p, i) => server.authFetch(p, i),
    });

    expect(result2.status).toBe("failed");
  });

  // f. Crash safety: make the PUT fail with a network error after generation; counter was already advanced
  it("f. Crash safety: make the PUT fail with a network error after generation; counter was already advanced", async () => {
    const userId = createUserId("test-f");
    const store = new IndexedDBSignalStore(userId);
    const provision = await provisionKeys(userId, store);

    const server = new FakeServer(userId);
    await server.authFetch("/keys/bundle", {
      method: "PUT",
      body: JSON.stringify(provision.bundle),
    });

    while (server.getUnconsumedCount() > 10) {
      server.consumeOne();
    }

    server.failNextPutNetwork = true;
    const result1 = await maintainPrekeys({
      store,
      userId,
      authFetch: (p, i) => server.authFetch(p, i),
    });

    expect(result1.status).toBe("failed");

    // PrekeyState counter was already advanced past the generated keys (101..200 -> next is 201)
    const stateAfterFail = await new PrekeyState(userId).get();
    expect(stateAfterFail?.nextPreKeyId).toBe(201);

    // Run maintain again; new keys must start at 201 (no overlap with 101..200)
    const result2 = await maintainPrekeys({
      store,
      userId,
      authFetch: (p, i) => server.authFetch(p, i),
    });

    expect(result2.status).toBe("ok");
    for (let id = 201; id <= 300; id++) {
      expect(server.oneTimePreKeys.has(id)).toBe(true);
    }
    // 101..200 were never uploaded to server
    for (let id = 101; id <= 200; id++) {
      expect(server.oneTimePreKeys.has(id)).toBe(false);
    }
  });

  // g. Network failure on GET /keys/count returns { status: "skipped" } and changes nothing in the store or the state
  it("g. Network failure on GET /keys/count returns { status: 'skipped' } and changes nothing in the store or the state", async () => {
    const userId = createUserId("test-g");
    const store = new IndexedDBSignalStore(userId);
    const provision = await provisionKeys(userId, store);

    const server = new FakeServer(userId);
    await server.authFetch("/keys/bundle", {
      method: "PUT",
      body: JSON.stringify(provision.bundle),
    });

    const prekeyIdsBefore = await store.listPreKeyIds();
    const signedPreKeyIdsBefore = await store.getSignedPreKeyIds();
    const stateBefore = await new PrekeyState(userId).get();

    server.failNextCount = true;
    const result = await maintainPrekeys({
      store,
      userId,
      authFetch: (p, i) => server.authFetch(p, i),
    });

    expect(result.status).toBe("skipped");

    const prekeyIdsAfter = await store.listPreKeyIds();
    const signedPreKeyIdsAfter = await store.getSignedPreKeyIds();
    const stateAfter = await new PrekeyState(userId).get();

    expect(prekeyIdsAfter).toEqual(prekeyIdsBefore);
    expect(signedPreKeyIdsAfter).toEqual(signedPreKeyIdsBefore);
    expect(stateAfter).toEqual(stateBefore);
  });

  // h. Rotation: with an injected clock, first run records lastRotatedAt without rotating; advancing the clock by 6 days 23 hours does not rotate; by 7 days rotates exactly once
  it("h. Rotation: first run records lastRotatedAt; +6d23h does not rotate; +7d rotates exactly once", async () => {
    const userId = createUserId("test-h");
    const store = new IndexedDBSignalStore(userId);
    const provision = await provisionKeys(userId, store);

    const server = new FakeServer(userId);
    await server.authFetch("/keys/bundle", {
      method: "PUT",
      body: JSON.stringify(provision.bundle),
    });

    let currentTime = 1_000_000_000_000;

    // Run 1: first run records lastRotatedAt without rotating
    const run1 = await maintainPrekeys({
      store,
      userId,
      authFetch: (p, i) => server.authFetch(p, i),
      now: () => currentTime,
    });
    expect(run1.status).toBe("ok");
    if (run1.status === "ok") {
      expect(run1.rotated).toBe(false);
    }
    const state1 = await new PrekeyState(userId).get();
    expect(state1?.lastRotatedAt).toBe(new Date(currentTime).toISOString());
    expect(state1?.activeSignedPreKeyId).toBe(1);

    // Run 2: advance clock by 6 days and 23 hours
    currentTime += (6 * 24 + 23) * 60 * 60 * 1000;
    const run2 = await maintainPrekeys({
      store,
      userId,
      authFetch: (p, i) => server.authFetch(p, i),
      now: () => currentTime,
    });
    expect(run2.status).toBe("ok");
    if (run2.status === "ok") {
      expect(run2.rotated).toBe(false);
    }
    expect(server.getNewestSignedPreKey()?.keyId).toBe(1);

    // Run 3: advance clock to reach full 7 days from start
    currentTime = 1_000_000_000_000 + SIGNED_PREKEY_MAX_AGE_MS;
    const run3 = await maintainPrekeys({
      store,
      userId,
      authFetch: (p, i) => server.authFetch(p, i),
      now: () => currentTime,
    });
    expect(run3.status).toBe("ok");
    if (run3.status === "ok") {
      expect(run3.rotated).toBe(true);
    }

    // New signed prekey id is 2, uploaded with empty one-time prekeys
    expect(server.getNewestSignedPreKey()?.keyId).toBe(2);
    const state3 = await new PrekeyState(userId).get();
    expect(state3?.activeSignedPreKeyId).toBe(2);
    expect(state3?.lastRotatedAt).toBe(new Date(currentTime).toISOString());

    // Verify rotation request carried empty oneTimePreKeys
    const lastPutReq = server.requests
      .filter((r) => r.path === "/keys/bundle")
      .slice(-1)[0];
    const lastBody = JSON.parse(lastPutReq.init?.body as string) as PublicPreKeyBundle;
    expect(lastBody.signedPreKey.keyId).toBe(2);
    expect(lastBody.oneTimePreKeys).toHaveLength(0);
  });

  // i. After rotation the PREVIOUS signed prekey is still in the store and still loads, and a prekey message built against the PREVIOUS signed prekey still decrypts
  it("i. After rotation the PREVIOUS signed prekey is still in the store and still loads, and a prekey message built against the PREVIOUS signed prekey still decrypts", async () => {
    const aliceId = createUserId("alice-test-i");
    const bobId = createUserId("bob-test-i");

    const aliceStore = new IndexedDBSignalStore(aliceId);
    const bobStore = new IndexedDBSignalStore(bobId);

    const aliceProvision = await provisionKeys(aliceId, aliceStore);
    const bobProvision = await provisionKeys(bobId, bobStore);

    const bobServer = new FakeServer(bobId);
    await bobServer.authFetch("/keys/bundle", {
      method: "PUT",
      body: JSON.stringify(bobProvision.bundle),
    });

    let currentTime = 1_000_000_000_000;

    // First run sets lastRotatedAt
    await maintainPrekeys({
      store: bobStore,
      userId: bobId,
      authFetch: (p, i) => bobServer.authFetch(p, i),
      now: () => currentTime,
    });

    // Rotation 1: advance by 7 days
    currentTime += SIGNED_PREKEY_MAX_AGE_MS;
    const rot1 = await maintainPrekeys({
      store: bobStore,
      userId: bobId,
      authFetch: (p, i) => bobServer.authFetch(p, i),
      now: () => currentTime,
    });
    expect(rot1.status).toBe("ok");
    if (rot1.status === "ok") {
      expect(rot1.rotated).toBe(true);
    }

    // Bob now has active signed prekey 2. But Alice has Bob's initial bundle with signed prekey 1!
    const bundles = new InMemoryBundleProvider();
    bundles.register(aliceProvision.bundle);
    bundles.register(bobProvision.bundle); // Bob bundle with signedPreKey 1

    const aliceSession = new SessionManager(aliceId, aliceStore, bundles);
    const bobSession = new SessionManager(bobId, bobStore, bundles);

    const envelope = await aliceSession.encrypt(bobId, "late prekey message for bob");
    expect(envelope.type).toBe(3);

    // Bob still decrypts successfully using previous signed prekey 1
    const decrypted = await bobSession.decrypt(aliceId, envelope);
    expect(decrypted).toBe("late prekey message for bob");

    // Rotation 2: advance by another 7 days to rotate to signed prekey 3
    currentTime += SIGNED_PREKEY_MAX_AGE_MS;
    const rot2 = await maintainPrekeys({
      store: bobStore,
      userId: bobId,
      authFetch: (p, i) => bobServer.authFetch(p, i),
      now: () => currentTime,
    });
    expect(rot2.status).toBe("ok");
    if (rot2.status === "ok") {
      expect(rot2.rotated).toBe(true);
    }

    // Signed prekey 1 (from two rotations ago) is deleted!
    expect(await bobStore.loadSignedPreKey(1)).toBeUndefined();
    // Signed prekey 2 (previous active) is kept
    expect(await bobStore.loadSignedPreKey(2)).toBeDefined();
    // Signed prekey 3 (current active) is kept
    expect(await bobStore.loadSignedPreKey(3)).toBeDefined();
  });

  // j. A failed rotation upload keeps the new local signed prekey, does not update lastRotatedAt, and the next successful run reuses that same signed prekey id
  it("j. A failed rotation upload keeps the new local signed prekey, does not update lastRotatedAt, and the next successful run reuses that same signed prekey id", async () => {
    const userId = createUserId("test-j");
    const store = new IndexedDBSignalStore(userId);
    const provision = await provisionKeys(userId, store);

    const server = new FakeServer(userId);
    await server.authFetch("/keys/bundle", {
      method: "PUT",
      body: JSON.stringify(provision.bundle),
    });

    let currentTime = 1_000_000_000_000;
    await maintainPrekeys({
      store,
      userId,
      authFetch: (p, i) => server.authFetch(p, i),
      now: () => currentTime,
    });

    // Advance clock 7 days
    currentTime += SIGNED_PREKEY_MAX_AGE_MS;
    server.failNextPutNetwork = true;

    const failedRun = await maintainPrekeys({
      store,
      userId,
      authFetch: (p, i) => server.authFetch(p, i),
      now: () => currentTime,
    });
    expect(failedRun.status).toBe("failed");

    // Local store has generated signed prekey 2
    expect(await store.loadSignedPreKey(2)).toBeDefined();
    // lastRotatedAt and activeSignedPreKeyId were NOT updated
    const stateAfterFail = await new PrekeyState(userId).get();
    expect(stateAfterFail?.activeSignedPreKeyId).toBe(1);
    expect(stateAfterFail?.lastRotatedAt).toBe(new Date(1_000_000_000_000).toISOString());

    // Next successful run reuses signed prekey 2 without generating signed prekey 3
    const successRun = await maintainPrekeys({
      store,
      userId,
      authFetch: (p, i) => server.authFetch(p, i),
      now: () => currentTime,
    });
    expect(successRun.status).toBe("ok");
    if (successRun.status === "ok") {
      expect(successRun.rotated).toBe(true);
    }

    expect(server.getNewestSignedPreKey()?.keyId).toBe(2);
    expect(await store.loadSignedPreKey(3)).toBeUndefined();
    const finalState = await new PrekeyState(userId).get();
    expect(finalState?.activeSignedPreKeyId).toBe(2);
  });

  // k. Single flight: 5 concurrent maintainPrekeys calls cause exactly one GET /keys/count and one upload
  it("k. Single flight: 5 concurrent maintainPrekeys calls cause exactly one GET /keys/count and one upload", async () => {
    const userId = createUserId("test-k");
    const store = new IndexedDBSignalStore(userId);
    const provision = await provisionKeys(userId, store);

    const server = new FakeServer(userId);
    await server.authFetch("/keys/bundle", {
      method: "PUT",
      body: JSON.stringify(provision.bundle),
    });

    // Drain to 10 keys so replenish is triggered
    while (server.getUnconsumedCount() > 10) {
      server.consumeOne();
    }

    server.countCalls = 0;
    server.putCalls = 0;

    const results = await Promise.all([
      maintainPrekeys({ store, userId, authFetch: (p, i) => server.authFetch(p, i) }),
      maintainPrekeys({ store, userId, authFetch: (p, i) => server.authFetch(p, i) }),
      maintainPrekeys({ store, userId, authFetch: (p, i) => server.authFetch(p, i) }),
      maintainPrekeys({ store, userId, authFetch: (p, i) => server.authFetch(p, i) }),
      maintainPrekeys({ store, userId, authFetch: (p, i) => server.authFetch(p, i) }),
    ]);

    for (const r of results) {
      expect(r.status).toBe("ok");
    }

    expect(server.countCalls).toBe(1);
    expect(server.putCalls).toBe(1);
  });

  // l. provision.ts regression: after consuming and removing ALL local one-time prekeys, provisionKeys generates ids that do not start at 1
  it("l. provision.ts regression: after consuming and removing ALL local one-time prekeys, provisionKeys generates ids that do not start at 1", async () => {
    const userId = createUserId("test-l");
    const store = new IndexedDBSignalStore(userId);

    const first = await provisionKeys(userId, store);
    expect(first.bundle.oneTimePreKeys).toHaveLength(100);

    // Remove all 100 prekeys from the local store
    for (let id = 1; id <= 100; id++) {
      await store.removePreKey(id);
    }
    expect(await store.listPreKeyIds()).toHaveLength(0);

    // Re-provision
    const second = await provisionKeys(userId, store);
    expect(second.bundle.oneTimePreKeys).toHaveLength(100);

    // Verify all IDs start at 101, not 1
    const newIds = second.bundle.oneTimePreKeys.map((k) => k.keyId);
    expect(newIds[0]).toBe(101);
    expect(newIds[99]).toBe(200);
    expect(newIds).not.toContain(1);
  });
});
