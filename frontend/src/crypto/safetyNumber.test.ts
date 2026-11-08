import { describe, expect, it } from "vitest";
import { KeyHelper } from "@privacyresearch/libsignal-protocol-typescript";
import { IndexedDBSignalStore } from "./IndexedDBSignalStore";
import { provisionKeys } from "./provision";
import { InMemoryBundleProvider } from "./bundleProvider";
import { SessionManager } from "./session";
import {
  computeSafetyNumber,
  safetyNumberWith,
  formatSafetyNumber,
  safetyNumbersMatch,
  FINGERPRINT_ITERATIONS,
} from "./safetyNumber";

describe("Safety Number Verification (P4.1)", () => {
  it("a. Provision 'alice' and 'bob', establish session, exchange messages; safetyNumberWith returns identical digits", async () => {
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

    const msgToBob = await aliceSession.encrypt("bob", "hello bob");
    const bobDecrypted = await bobSession.decrypt("alice", msgToBob);
    expect(bobDecrypted).toBe("hello bob");

    const msgToAlice = await bobSession.encrypt("alice", "hello alice");
    const aliceDecrypted = await aliceSession.decrypt("bob", msgToAlice);
    expect(aliceDecrypted).toBe("hello alice");

    const aliceSN = await safetyNumberWith(aliceStore, "alice", "bob");
    const bobSN = await safetyNumberWith(bobStore, "bob", "alice");

    expect(aliceSN).not.toBeNull();
    expect(bobSN).not.toBeNull();
    expect(aliceSN!.digits).toBe(bobSN!.digits);
    expect(aliceSN!.localUserId).toBe("alice");
    expect(aliceSN!.remoteUserId).toBe("bob");
    expect(bobSN!.localUserId).toBe("bob");
    expect(bobSN!.remoteUserId).toBe("alice");
  });

  it("b. digits has length 60 and matches /^[0-9]{60}$/; groups has 12 entries of 5 digits", async () => {
    const aliceStore = new IndexedDBSignalStore("alice");
    const aliceSN = await safetyNumberWith(aliceStore, "alice", "bob");

    expect(aliceSN).not.toBeNull();
    expect(aliceSN!.digits).toHaveLength(60);
    expect(aliceSN!.digits).toMatch(/^[0-9]{60}$/);

    expect(aliceSN!.groups).toHaveLength(12);
    for (const group of aliceSN!.groups) {
      expect(group).toHaveLength(5);
      expect(group).toMatch(/^[0-9]{5}$/);
    }
    expect(aliceSN!.groups.join("")).toBe(aliceSN!.digits);

    const formatted = formatSafetyNumber(aliceSN!);
    const lines = formatted.split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const parts = line.split(" ");
      expect(parts).toHaveLength(4);
      for (const part of parts) {
        expect(part).toHaveLength(5);
        expect(part).toMatch(/^[0-9]{5}$/);
      }
    }
  });

  it("c. Deterministic: computing twice gives the same result", async () => {
    const aliceStore = new IndexedDBSignalStore("alice");
    const bobStore = new IndexedDBSignalStore("bob");

    const first = await safetyNumberWith(aliceStore, "alice", "bob");
    const second = await safetyNumberWith(aliceStore, "alice", "bob");
    const bobSecond = await safetyNumberWith(bobStore, "bob", "alice");

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).toEqual(second);
    expect(first!.digits).toBe(bobSecond!.digits);
  });

  it("d. Key swap: compute with bob's identity replaced by a freshly generated identity key; digits differ from (a)", async () => {
    const aliceStore = new IndexedDBSignalStore("alice");
    const aliceKey = await aliceStore.getIdentityKeyPair();
    expect(aliceKey).toBeDefined();

    const aliceSN = await safetyNumberWith(aliceStore, "alice", "bob");
    expect(aliceSN).not.toBeNull();

    const swappedBobKeyPair = await KeyHelper.generateIdentityKeyPair();
    const swappedSN = await computeSafetyNumber(
      "alice",
      aliceKey!.pubKey,
      "bob",
      swappedBobKeyPair.pubKey,
    );

    expect(swappedSN.digits).toHaveLength(60);
    expect(swappedSN.digits).toMatch(/^[0-9]{60}$/);
    expect(swappedSN.digits).not.toBe(aliceSN!.digits);
  });

  it("e. Returns null when the remote trusted key is missing (fresh store that never talked to bob)", async () => {
    const freshStore = new IndexedDBSignalStore("fresh_user");
    await freshStore.wipe();
    await provisionKeys("fresh_user", freshStore);

    const result = await safetyNumberWith(freshStore, "fresh_user", "bob");
    expect(result).toBeNull();

    const unprovisionedStore = new IndexedDBSignalStore("unprovisioned_user");
    await unprovisionedStore.wipe();
    const unprovResult = await safetyNumberWith(unprovisionedStore, "unprovisioned_user", "bob");
    expect(unprovResult).toBeNull();
  });

  it("f. safetyNumbersMatch ignores spaces and newlines; mismatched digits return false", async () => {
    const aliceStore = new IndexedDBSignalStore("alice");
    const aliceSN = await safetyNumberWith(aliceStore, "alice", "bob");
    expect(aliceSN).not.toBeNull();

    const formatted = formatSafetyNumber(aliceSN!);
    expect(safetyNumbersMatch(formatted, aliceSN!.digits)).toBe(true);
    expect(safetyNumbersMatch(`  \n${formatted}\n\t `, aliceSN!.digits)).toBe(true);
    expect(safetyNumbersMatch(formatted, formatted)).toBe(true);

    // Mismatched digits
    const tampered = aliceSN!.digits.slice(0, 59) + (aliceSN!.digits[59] === "0" ? "1" : "0");
    expect(safetyNumbersMatch(formatted, tampered)).toBe(false);
    expect(safetyNumbersMatch("12345 67890", "12345 67891")).toBe(false);

    // Empty strings do not match
    expect(safetyNumbersMatch("", "")).toBe(false);
    expect(safetyNumbersMatch("   \n ", "")).toBe(false);
  });

  it("g. Symmetry holds regardless of which userId sorts first: repeat (a) with userIds 'zed' and 'amy'", async () => {
    // Note: 'zed' > 'amy' alphabetically
    const zedStore = new IndexedDBSignalStore("zed");
    const amyStore = new IndexedDBSignalStore("amy");
    await zedStore.wipe();
    await amyStore.wipe();

    const zedProvision = await provisionKeys("zed", zedStore);
    const amyProvision = await provisionKeys("amy", amyStore);

    const bundles = new InMemoryBundleProvider();
    bundles.register(zedProvision.bundle);
    bundles.register(amyProvision.bundle);

    const zedSession = new SessionManager("zed", zedStore, bundles);
    const amySession = new SessionManager("amy", amyStore, bundles);

    const zedToAmy = await zedSession.encrypt("amy", "hello amy from zed");
    const amyDecrypted = await amySession.decrypt("zed", zedToAmy);
    expect(amyDecrypted).toBe("hello amy from zed");

    const amyToZed = await amySession.encrypt("zed", "hello zed from amy");
    const zedDecrypted = await zedSession.decrypt("amy", amyToZed);
    expect(zedDecrypted).toBe("hello zed from amy");

    const zedSN = await safetyNumberWith(zedStore, "zed", "amy");
    const amySN = await safetyNumberWith(amyStore, "amy", "zed");

    expect(zedSN).not.toBeNull();
    expect(amySN).not.toBeNull();
    expect(zedSN!.digits).toBe(amySN!.digits);
    expect(zedSN!.digits).toHaveLength(60);
    expect(zedSN!.groups).toHaveLength(12);
  });

  it("verifies FINGERPRINT_ITERATIONS export is 5200", () => {
    expect(FINGERPRINT_ITERATIONS).toBe(5200);
  });
});
