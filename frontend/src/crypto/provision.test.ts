import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import initSignal from "@privacyresearch/libsignal-protocol-typescript";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { IndexedDBSignalStore } from "./IndexedDBSignalStore";
import { provisionKeys, countOneTimePreKeys } from "./provision";
import { validatePreKeyBundle, toBase64, fromBase64, type PublicPreKeyBundle } from "./bundle";

describe("provisionKeys and PublicPreKeyBundle", () => {
  const testStores: IndexedDBSignalStore[] = [];

  const createStore = (userId: string): IndexedDBSignalStore => {
    const store = new IndexedDBSignalStore(userId);
    testStores.push(store);
    return store;
  };

  afterEach(async () => {
    while (testStores.length > 0) {
      const store = testStores.pop();
      if (store) {
        await store.wipe();
      }
    }
  });

  it("first call on fresh userId creates keys, validates bundle, generates 100 prekeys and signedPreKey 1", async () => {
    const userId = "alice-provision-1";
    const store = createStore(userId);

    const result = await provisionKeys(userId, store);

    expect(result.created).toBe(true);
    expect(result.registrationId).toBeGreaterThan(0);
    expect(result.bundle.userId).toBe(userId);
    expect(result.bundle.registrationId).toBe(result.registrationId);
    expect(result.bundle.signedPreKey.keyId).toBe(1);
    expect(result.bundle.oneTimePreKeys).toHaveLength(100);
    expect(validatePreKeyBundle(result.bundle)).toBe(true);

    const preKeyCount = await countOneTimePreKeys(store);
    expect(preKeyCount).toBe(100);
  });

  it("second call for the same userId does not regenerate keys and keeps count at 100", async () => {
    const userId = "bob-provision-repeat";
    const store = createStore(userId);

    const first = await provisionKeys(userId, store);
    expect(first.created).toBe(true);
    expect(await countOneTimePreKeys(store)).toBe(100);

    const second = await provisionKeys(userId, store);
    expect(second.created).toBe(false);
    expect(second.registrationId).toBe(first.registrationId);
    expect(second.bundle.registrationId).toBe(first.bundle.registrationId);
    expect(second.bundle.identityKey).toBe(first.bundle.identityKey);
    expect(second.bundle.signedPreKey.keyId).toBe(first.bundle.signedPreKey.keyId);
    expect(second.bundle.signedPreKey.publicKey).toBe(first.bundle.signedPreKey.publicKey);
    expect(second.bundle.signedPreKey.signature).toBe(first.bundle.signedPreKey.signature);

    const preKeyCount = await countOneTimePreKeys(store);
    expect(preKeyCount).toBe(100);
  });

  it("after removing 30 one-time prekeys, a third call generates exactly 30 new ones (101..130) and total is 100", async () => {
    const userId = "carol-provision-replenish";
    const store = createStore(userId);

    // Call 1: initial 100 keys (1..100)
    const first = await provisionKeys(userId, store);
    expect(first.created).toBe(true);
    expect(await countOneTimePreKeys(store)).toBe(100);

    // Call 2: idempotent repeat
    const second = await provisionKeys(userId, store);
    expect(second.created).toBe(false);
    expect(await countOneTimePreKeys(store)).toBe(100);

    // Delete 30 keys (IDs 1..30)
    for (let id = 1; id <= 30; id++) {
      await store.removePreKey(id);
    }
    expect(await countOneTimePreKeys(store)).toBe(70);

    // Call 3: replenish shortfall
    const third = await provisionKeys(userId, store);
    expect(third.created).toBe(false);
    expect(await countOneTimePreKeys(store)).toBe(100);
    expect(third.bundle.oneTimePreKeys).toHaveLength(100);

    // Verify IDs 101..130 exist in store
    for (let id = 101; id <= 130; id++) {
      const loaded = await store.loadPreKey(id);
      expect(loaded).toBeDefined();
    }

    // Verify ID 131 was NOT generated
    const beyondMax = await store.loadPreKey(131);
    expect(beyondMax).toBeUndefined();

    // Verify IDs 1..30 are indeed gone
    for (let id = 1; id <= 30; id++) {
      const deleted = await store.loadPreKey(id);
      expect(deleted).toBeUndefined();
    }
  });

  it("the signed prekey signature verifies against the identity key using the library's Curve verify function", async () => {
    const userId = "dan-signature-verify";
    const store = createStore(userId);

    const { bundle } = await provisionKeys(userId, store);

    const signal = await initSignal();
    const identityKeyBuf = fromBase64(bundle.identityKey);
    const signedPreKeyPubBuf = fromBase64(bundle.signedPreKey.publicKey);
    const signatureBuf = fromBase64(bundle.signedPreKey.signature);

    // Valid signature must verify without throwing
    await expect(
      signal.Curve.async.verifySignature(identityKeyBuf, signedPreKeyPubBuf, signatureBuf),
    ).resolves.not.toThrow();

    // Corrupted signature must throw
    const corruptedSig = new Uint8Array(signatureBuf);
    corruptedSig[0] ^= 1;
    await expect(
      signal.Curve.async.verifySignature(identityKeyBuf, signedPreKeyPubBuf, corruptedSig.buffer),
    ).rejects.toThrow();
  });

  it("bundle contains no private key fields and JSON serialization contains no private key bytes", async () => {
    const userId = "eve-private-isolation";
    const store = createStore(userId);

    const result = await provisionKeys(userId, store);

    // Retrieve private keys directly from IndexedDB
    const storedIdentity = await store.getIdentityKeyPair();
    expect(storedIdentity).toBeDefined();
    const identityPrivB64 = toBase64(storedIdentity!.privKey);

    const storedSignedPreKey = await store.loadSignedPreKey(1);
    expect(storedSignedPreKey).toBeDefined();
    const signedPreKeyPrivB64 = toBase64(storedSignedPreKey!.privKey);

    const storedOneTimePreKey = await store.loadPreKey(1);
    expect(storedOneTimePreKey).toBeDefined();
    const oneTimePrivB64 = toBase64(storedOneTimePreKey!.privKey);

    const json = JSON.stringify(result);

    // 1. No field name includes "priv"
    expect(json.toLowerCase()).not.toContain('"priv');

    // 2. No private key bytes exist anywhere in JSON output
    expect(json).not.toContain(identityPrivB64);
    expect(json).not.toContain(signedPreKeyPrivB64);
    expect(json).not.toContain(oneTimePrivB64);

    // 3. Deep check all object keys recursively
    const assertNoPrivInKeys = (val: unknown): void => {
      if (typeof val !== "object" || val === null) return;
      for (const [k, v] of Object.entries(val)) {
        expect(k.toLowerCase()).not.toContain("priv");
        assertNoPrivInKeys(v);
      }
    };
    assertNoPrivInKeys(result);
  });

  it("validatePreKeyBundle rejects invalid inputs (wrong identityKey length, duplicate keyIds, non-base64 strings)", async () => {
    const userId = "frank-validator-negative";
    const store = createStore(userId);

    const { bundle } = await provisionKeys(userId, store);
    expect(validatePreKeyBundle(bundle)).toBe(true);

    // 1. Wrong identityKey length (32 bytes instead of 33 bytes)
    const wrongLengthKey = {
      ...bundle,
      identityKey: toBase64(new Uint8Array(32).buffer),
    };
    expect(validatePreKeyBundle(wrongLengthKey)).toBe(false);

    // 2. Duplicate keyIds in oneTimePreKeys
    const duplicateKeyIds = {
      ...bundle,
      oneTimePreKeys: [
        { keyId: 5, publicKey: bundle.oneTimePreKeys[0].publicKey },
        { keyId: 5, publicKey: bundle.oneTimePreKeys[1].publicKey },
      ],
    };
    expect(validatePreKeyBundle(duplicateKeyIds)).toBe(false);

    // 3. Non-base64 strings
    const nonBase64Identity = {
      ...bundle,
      identityKey: "not-a-valid-base64-string!!@@##$$%%^^",
    };
    expect(validatePreKeyBundle(nonBase64Identity)).toBe(false);

    const nonBase64Signature = {
      ...bundle,
      signedPreKey: {
        ...bundle.signedPreKey,
        signature: "invalid-signature???",
      },
    };
    expect(validatePreKeyBundle(nonBase64Signature)).toBe(false);

    // 4. Non-positive keyIds
    const zeroKeyId = {
      ...bundle,
      signedPreKey: {
        ...bundle.signedPreKey,
        keyId: 0,
      },
    };
    expect(validatePreKeyBundle(zeroKeyId)).toBe(false);

    // 5. Wrong signature byte length (63 bytes instead of 64)
    const wrongSigLength = {
      ...bundle,
      signedPreKey: {
        ...bundle.signedPreKey,
        signature: toBase64(new Uint8Array(63).buffer),
      },
    };
    expect(validatePreKeyBundle(wrongSigLength)).toBe(false);
  });

  it("the bundle object validates against docs/schemas/prekey-bundle.schema.json using ajv", async () => {
    const userId = "grace-schema-sync";
    const store = createStore(userId);

    const { bundle } = await provisionKeys(userId, store);

    // Load draft 2020-12 schema from docs/schemas/prekey-bundle.schema.json
    const schemaPath = path.resolve(__dirname, "../../../docs/schemas/prekey-bundle.schema.json");
    const rawSchema = fs.readFileSync(schemaPath, "utf-8");
    const schema = JSON.parse(rawSchema);

    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile<PublicPreKeyBundle>(schema);

    // Verify bundle validates against schema
    const isValid = validate(bundle);
    expect(validate.errors).toBeNull();
    expect(isValid).toBe(true);

    // Verify schema rejects bundle with extraneous property
    const extraPropertyBundle = {
      ...bundle,
      maliciousField: "forbidden",
    };
    const isInvalid = validate(extraPropertyBundle);
    expect(isInvalid).toBe(false);
    expect(validate.errors).not.toBeNull();
  });
});
