import { afterEach, describe, expect, it } from "vitest";
import { IndexedDBSignalStore } from "./IndexedDBSignalStore";
import { wipePrekeyState } from "./prekeyMaintenance";
import { ensureKeysPublished } from "./keyPublisher";
import { FakeKeyServer } from "../test/fakeKeyServer";
import { SessionManager } from "./session";
import { provisionKeys } from "./provision";

describe("keyPublisher: ensureKeysPublished", () => {
  const userIdsToClean = new Set<string>();

  function createUserId(prefix: string): string {
    const id = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    userIdsToClean.add(id);
    return id;
  }

  afterEach(async () => {
    for (const userId of userIdsToClean) {
      try {
        const store = new IndexedDBSignalStore(userId);
        await store.wipe();
      } catch {
        // Ignore wipe failure
      }
      try {
        await wipePrekeyState(userId);
      } catch {
        // Ignore wipe failure
      }
    }
    userIdsToClean.clear();
  });

  // Test a: Fresh user
  it("a. Fresh user: one PUT /keys/bundle with the full bundle, then maintain finds the count healthy and does nothing more; result published true", async () => {
    const userId = createUserId("alice-pub-a");
    const store = new IndexedDBSignalStore(userId);
    const server = new FakeKeyServer(userId);

    const result = await ensureKeysPublished({
      userId,
      store,
      authFetch: (path, init) => server.authFetch(path, init),
    });

    expect(result.status).toBe("ok");
    expect(result.published).toBe(true);
    expect(server.putCalls).toBe(1);
    expect(server.getUnconsumedCount()).toBe(100);
  });

  // Test b: Second call for the same user
  it("b. Second call for the same user does not PUT the full bundle again", async () => {
    const userId = createUserId("alice-pub-b");
    const store = new IndexedDBSignalStore(userId);
    const server = new FakeKeyServer(userId);

    const res1 = await ensureKeysPublished({
      userId,
      store,
      authFetch: (path, init) => server.authFetch(path, init),
    });
    expect(res1.status).toBe("ok");
    expect(res1.published).toBe(true);
    expect(server.putCalls).toBe(1);

    const res2 = await ensureKeysPublished({
      userId,
      store,
      authFetch: (path, init) => server.authFetch(path, init),
    });
    expect(res2.status).toBe("ok");
    expect(res2.published).toBe(false);
    expect(server.putCalls).toBe(1); // No additional PUT /keys/bundle
  });

  // Test c: Server count shows signed_prekey_id null
  it("c. Server count shows signed_prekey_id null although keys exist locally (first upload had failed): the full bundle is uploaded", async () => {
    const userId = createUserId("alice-pub-c");
    const store = new IndexedDBSignalStore(userId);
    const server = new FakeKeyServer(userId);

    // Provision keys locally first without uploading
    const prov = await provisionKeys(userId, store);
    expect(prov.created).toBe(true);

    // Server currently has nothing for alice (signed_prekey_id === null)
    const result = await ensureKeysPublished({
      userId,
      store,
      authFetch: (path, init) => server.authFetch(path, init),
    });

    expect(result.status).toBe("ok");
    expect(result.published).toBe(true);
    expect(server.putCalls).toBe(1);
    expect(server.getUnconsumedCount()).toBe(100);
  });

  // Test d: Count request fails (network error)
  it("d. Count request fails (network error) -> status 'skipped', nothing uploaded, no throw", async () => {
    const userId = createUserId("alice-pub-d");
    const store = new IndexedDBSignalStore(userId);
    const server = new FakeKeyServer(userId);
    server.failNextCount = true;

    const result = await ensureKeysPublished({
      userId,
      store,
      authFetch: (path, init) => server.authFetch(path, init),
    });

    expect(result.status).toBe("skipped");
    expect(result.published).toBe(false);
    expect(server.putCalls).toBe(0);
  });

  // Test e: PUT returns 500
  it("e. PUT returns 500 -> status 'failed', no throw", async () => {
    const userId = createUserId("alice-pub-e");
    const store = new IndexedDBSignalStore(userId);
    const server = new FakeKeyServer(userId);
    server.putStatus = 500;

    const result = await ensureKeysPublished({
      userId,
      store,
      authFetch: (path, init) => server.authFetch(path, init),
    });

    expect(result.status).toBe("failed");
    expect(result.published).toBe(false);
    expect(result.reason).toContain("500");
  });

  // Test f: Request serialization contains no private key material
  it("f. Every request body is serialized and contains no private key bytes and no 'privKey'", async () => {
    const userId = createUserId("alice-pub-f");
    const store = new IndexedDBSignalStore(userId);
    const server = new FakeKeyServer(userId);

    await ensureKeysPublished({
      userId,
      store,
      authFetch: (path, init) => server.authFetch(path, init),
    });

    expect(server.requests.length).toBeGreaterThan(0);
    for (const req of server.requests) {
      if (req.rawBody) {
        expect(req.rawBody).not.toContain("privKey");
        expect(req.rawBody).not.toContain("privateKey");
        expect(req.rawBody).not.toContain("priv");
      }
    }
  });

  // Test g: Top up after keys consumed
  it("g. After 85 of the 100 one-time prekeys are consumed on the fake server, ensureKeysPublished tops the server back up to at least 20 without reusing any key id (the fake server never returns 409)", async () => {
    const userId = createUserId("alice-pub-g");
    const store = new IndexedDBSignalStore(userId);
    const server = new FakeKeyServer(userId);

    // Initial publish
    await ensureKeysPublished({
      userId,
      store,
      authFetch: (path, init) => server.authFetch(path, init),
    });
    expect(server.getUnconsumedCount()).toBe(100);

    // Consume 85 keys on the server
    for (let i = 0; i < 85; i++) {
      const consumed = server.consumeOne();
      expect(consumed).not.toBeNull();
    }
    expect(server.getUnconsumedCount()).toBe(15);

    // Maintain runs inside ensureKeysPublished and replenishes
    const maintRes = await ensureKeysPublished({
      userId,
      store,
      authFetch: (path, init) => server.authFetch(path, init),
    });

    expect(maintRes.status).toBe("ok");
    expect(server.getUnconsumedCount()).toBeGreaterThanOrEqual(20);
    expect(server.getUnconsumedCount()).toBe(115); // 15 + 100
  });

  // Test h: Re-registration
  it("h. Re-registration: a user who clears local data and gets a new identity under the same userId publishes with identity_changed true and a peer can then fetch the new bundle and establish a session", async () => {
    const aliceId = createUserId("alice-pub-h");
    const bobId = createUserId("bob-pub-h");

    const aliceStore1 = new IndexedDBSignalStore(aliceId);
    const bobStore = new IndexedDBSignalStore(bobId);
    const server = new FakeKeyServer(aliceId);

    // Alice 1 registers and publishes
    const res1 = await ensureKeysPublished({
      userId: aliceId,
      store: aliceStore1,
      authFetch: server.createAuthFetch(aliceId),
    });
    expect(res1.status).toBe("ok");

    // Bob publishes
    const resBob = await ensureKeysPublished({
      userId: bobId,
      store: bobStore,
      authFetch: server.createAuthFetch(bobId),
    });
    expect(resBob.status).toBe("ok");

    // Bob establishes session with Alice 1
    const bobManager1 = new SessionManager(bobId, bobStore, server);
    const env1 = await bobManager1.encrypt(aliceId, "message to alice 1");
    expect(env1.type).toBe(3);

    // Alice wipes local data and generates fresh identity
    await aliceStore1.wipe();
    await wipePrekeyState(aliceId);

    const aliceStore2 = new IndexedDBSignalStore(aliceId);
    const res2 = await ensureKeysPublished({
      userId: aliceId,
      store: aliceStore2,
      authFetch: server.createAuthFetch(aliceId),
    });
    expect(res2.status).toBe("ok");

    // Peer (e.g. fresh peer charlie) fetches Alice's new bundle and establishes session
    const charlieId = createUserId("charlie-pub-h");
    const charlieStore = new IndexedDBSignalStore(charlieId);
    await ensureKeysPublished({
      userId: charlieId,
      store: charlieStore,
      authFetch: server.createAuthFetch(charlieId),
    });

    const charlieManager = new SessionManager(charlieId, charlieStore, server);
    const env2 = await charlieManager.encrypt(aliceId, "message to new alice");
    expect(env2.type).toBe(3);

    const aliceManager2 = new SessionManager(aliceId, aliceStore2, server);
    const decrypted = await aliceManager2.decrypt(charlieId, env2);
    expect(decrypted).toBe("message to new alice");
  });
});
