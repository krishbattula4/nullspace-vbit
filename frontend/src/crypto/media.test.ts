import { describe, expect, it, vi } from "vitest";
import {
  MAX_MEDIA_BYTES,
  MediaDecryptError,
  MediaIntegrityError,
  MediaTypeError,
  MediaTooLargeError,
  MediaUploadError,
  buildMediaPayload,
  decryptMedia,
  encryptMedia,
  fromBase64,
  parseMediaPayload,
  toBase64,
  uploadMedia,
} from "./media";

function makePngData(extraBytes: number[] = []): Uint8Array {
  // PNG magic bytes: 0x89, 0x50, 0x4E, 0x47
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...extraBytes]);
}

function makeJpegData(extraBytes: number[] = []): Uint8Array {
  // JPEG magic bytes: 0xFF, 0xD8, 0xFF
  return new Uint8Array([0xff, 0xd8, 0xff, ...extraBytes]);
}

function makeGifData(extraBytes: number[] = []): Uint8Array {
  // GIF magic bytes: "GIF8" (0x47, 0x49, 0x46, 0x38)
  return new Uint8Array([0x47, 0x49, 0x46, 0x38, ...extraBytes]);
}

function makeWebpData(extraBytes: number[] = []): Uint8Array {
  // WebP magic bytes: RIFF (4 bytes) + size (4 bytes) + WEBP (4 bytes)
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, // "RIFF"
    0x00, 0x00, 0x00, 0x00, // file size placeholder
    0x57, 0x45, 0x42, 0x50, // "WEBP"
    ...extraBytes,
  ]);
}

describe("Media Encryption Helper (P6.1)", () => {
  // -------------------------------------------------------------------------
  // a. Round trip
  // -------------------------------------------------------------------------
  it("a. Round trip: encrypt then decrypt returns identical bytes for PNG and JPEG spanning 0..255", async () => {
    const allByteValues = Array.from({ length: 256 }, (_, i) => i);

    // PNG test
    const pngInput = makePngData(allByteValues);
    const pngEncrypted = await encryptMedia(pngInput, "image/png");
    const pngDecrypted = await decryptMedia(pngEncrypted);
    expect(pngDecrypted).toEqual(pngInput);

    // JPEG test
    const jpegInput = makeJpegData(allByteValues);
    const jpegEncrypted = await encryptMedia(jpegInput, "image/jpeg");
    const jpegDecrypted = await decryptMedia(jpegEncrypted);
    expect(jpegDecrypted).toEqual(jpegInput);
  });

  // -------------------------------------------------------------------------
  // b. Ciphertext unreadability & nondeterminism
  // -------------------------------------------------------------------------
  it("b. Ciphertext is not readable: plaintext absent, length is plaintext + 16, different keys/IVs/ciphertexts per run", async () => {
    const distinctiveRun = [
      0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc,
      0xdd, 0xee, 0xff, 0x42,
    ];
    const input = makePngData([...distinctiveRun, 1, 2, 3, 4]);

    const enc1 = await encryptMedia(input, "image/png");
    const enc2 = await encryptMedia(input, "image/png");

    // Length must be plaintext bytes + 16 (AES-GCM 128-bit authentication tag)
    expect(enc1.ciphertext.byteLength).toBe(input.byteLength + 16);
    expect(enc2.ciphertext.byteLength).toBe(input.byteLength + 16);

    // Search for the 16-byte distinctive run in ciphertext
    const ct1 = enc1.ciphertext;
    let foundDistinctiveRun = false;
    for (let i = 0; i <= ct1.byteLength - distinctiveRun.length; i++) {
      let match = true;
      for (let j = 0; j < distinctiveRun.length; j++) {
        if (ct1[i + j] !== distinctiveRun[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        foundDistinctiveRun = true;
        break;
      }
    }
    expect(foundDistinctiveRun).toBe(false);

    // Two encryptions of SAME input produce different ciphertexts, keys, and IVs
    expect(enc1.key).not.toBe(enc2.key);
    expect(enc1.iv).not.toBe(enc2.iv);
    expect(enc1.ciphertext).not.toEqual(enc2.ciphertext);
    expect(enc1.sha256).not.toBe(enc2.sha256);
  });

  // -------------------------------------------------------------------------
  // c. Key, IV, and SHA-256 properties
  // -------------------------------------------------------------------------
  it("c. Key is 32 bytes and IV is 12 bytes after base64 decoding; sha256 matches independent computation", async () => {
    const input = makePngData([10, 20, 30]);
    const enc = await encryptMedia(input, "image/png");

    const decodedKey = fromBase64(enc.key);
    expect(decodedKey.byteLength).toBe(32);

    const decodedIv = fromBase64(enc.iv);
    expect(decodedIv.byteLength).toBe(12);

    // Independent SHA-256 of the ciphertext
    const digest = await crypto.subtle.digest("SHA-256", enc.ciphertext);
    const independentHex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toLowerCase();

    expect(enc.sha256).toBe(independentHex);
  });

  // -------------------------------------------------------------------------
  // d. Tampering & short-circuiting
  // -------------------------------------------------------------------------
  it("d. Tampering: flipped byte or wrong hash throws MediaIntegrityError without attempting decrypt; wrong key/IV throws MediaDecryptError", async () => {
    const input = makePngData([1, 2, 3, 4, 5]);
    const enc = await encryptMedia(input, "image/png");

    const decryptSpy = vi.spyOn(crypto.subtle, "decrypt");

    try {
      // 1. Flip one byte in ciphertext -> MediaIntegrityError, crypto.subtle.decrypt NOT called
      const flippedCiphertext = new Uint8Array(enc.ciphertext);
      flippedCiphertext[0] ^= 0x01;

      await expect(
        decryptMedia({
          ...enc,
          ciphertext: flippedCiphertext,
        }),
      ).rejects.toThrow(MediaIntegrityError);

      expect(decryptSpy).not.toHaveBeenCalled();

      // 2. Replace sha256 with another valid 64-char lowercase hex hash -> MediaIntegrityError, NOT called
      decryptSpy.mockClear();
      const anotherValidHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
      await expect(
        decryptMedia({
          ...enc,
          sha256: anotherValidHash,
        }),
      ).rejects.toThrow(MediaIntegrityError);

      expect(decryptSpy).not.toHaveBeenCalled();

      // 3. Correct hash but wrong key -> MediaDecryptError, decrypt IS called
      decryptSpy.mockClear();
      const wrongKey = toBase64(crypto.getRandomValues(new Uint8Array(32)));
      await expect(
        decryptMedia({
          ...enc,
          key: wrongKey,
        }),
      ).rejects.toThrow(MediaDecryptError);

      expect(decryptSpy).toHaveBeenCalled();

      // 4. Correct hash but wrong IV -> MediaDecryptError
      decryptSpy.mockClear();
      const wrongIv = toBase64(crypto.getRandomValues(new Uint8Array(12)));
      await expect(
        decryptMedia({
          ...enc,
          iv: wrongIv,
        }),
      ).rejects.toThrow(MediaDecryptError);

      expect(decryptSpy).toHaveBeenCalled();
    } finally {
      decryptSpy.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // e. Limits and MIME verification
  // -------------------------------------------------------------------------
  it("e. Limits: exactly MAX_MEDIA_BYTES succeeds, MAX_MEDIA_BYTES + 1 throws MediaTooLargeError, empty throws; text/plain, image/svg+xml, and magic mismatch throw MediaTypeError", async () => {
    // Empty data -> MediaTooLargeError
    await expect(encryptMedia(new Uint8Array(0), "image/png")).rejects.toThrow(
      MediaTooLargeError,
    );

    // Disallowed MIME types -> MediaTypeError
    await expect(
      encryptMedia(makePngData([1, 2, 3]), "text/plain"),
    ).rejects.toThrow(MediaTypeError);
    await expect(
      encryptMedia(makePngData([1, 2, 3]), "image/svg+xml"),
    ).rejects.toThrow(MediaTypeError);

    // Magic byte mismatch: PNG magic bytes declared as image/jpeg -> MediaTypeError
    const pngAsJpeg = makePngData([1, 2, 3]);
    await expect(encryptMedia(pngAsJpeg, "image/jpeg")).rejects.toThrow(
      MediaTypeError,
    );

    // GIF and WebP magic checks
    const gif = makeGifData([1, 2, 3]);
    const gifEnc = await encryptMedia(gif, "image/gif");
    expect(gifEnc.mime).toBe("image/gif");

    const webp = makeWebpData([1, 2, 3]);
    const webpEnc = await encryptMedia(webp, "image/webp");
    expect(webpEnc.mime).toBe("image/webp");

    const invalidWebp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0, 0, 0, 0]);
    await expect(encryptMedia(invalidWebp, "image/webp")).rejects.toThrow(
      MediaTypeError,
    );

    // Size limits: MAX_MEDIA_BYTES succeeds
    const exactMaxData = new Uint8Array(MAX_MEDIA_BYTES);
    exactMaxData.set([0x89, 0x50, 0x4e, 0x47]); // valid PNG magic bytes
    const maxEnc = await encryptMedia(exactMaxData, "image/png");
    expect(maxEnc.size).toBe(MAX_MEDIA_BYTES);

    // MAX_MEDIA_BYTES + 1 -> MediaTooLargeError
    const overMaxData = new Uint8Array(MAX_MEDIA_BYTES + 1);
    overMaxData.set([0x89, 0x50, 0x4e, 0x47]);
    await expect(encryptMedia(overMaxData, "image/png")).rejects.toThrow(
      MediaTooLargeError,
    );
  });

  // -------------------------------------------------------------------------
  // f. uploadMedia isolation & key secrecy
  // -------------------------------------------------------------------------
  it("f. uploadMedia with mocked authFetch: exactly one call to /media with FormData (conversation_id and file), ciphertext equals blob bytes, key/IV/plaintext absent", async () => {
    const plaintext = makePngData([99, 100, 101, 102, 103, 104]);
    const enc = await encryptMedia(plaintext, "image/png");

    let capturedPath = "";
    let capturedInit: RequestInit | undefined;

    const mockAuthFetch = vi.fn().mockImplementation(async (path: string, init?: RequestInit) => {
      capturedPath = path;
      capturedInit = init;
      return new Response(
        JSON.stringify({ media_id: "12345678-1234-4234-8234-123456789abc" }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    });

    const conversationId = "87654321-4321-4321-8321-cba987654321";
    const result = await uploadMedia({
      ciphertext: enc.ciphertext,
      conversationId,
      authFetch: mockAuthFetch,
    });

    expect(mockAuthFetch).toHaveBeenCalledTimes(1);
    expect(capturedPath).toBe("/media");
    expect(capturedInit?.method).toBe("POST");
    expect(result.mediaId).toBe("12345678-1234-4234-8234-123456789abc");

    const formData = capturedInit?.body as FormData;
    expect(formData).toBeInstanceOf(FormData);

    // FormData has exactly conversation_id and file
    expect(formData.get("conversation_id")).toBe(conversationId);
    const file = formData.get("file") as Blob;
    expect(file).toBeInstanceOf(Blob);
    expect(file.type).toBe("application/octet-stream");

    const blobBytes = new Uint8Array(await file.arrayBuffer());
    expect(blobBytes).toEqual(enc.ciphertext);

    // Assert key, IV, and plaintext are NOT present anywhere in the request
    const serializedEntries = [
      capturedPath,
      JSON.stringify(capturedInit?.headers ?? {}),
      formData.get("conversation_id") as string,
    ].join(" ");

    expect(serializedEntries).not.toContain(enc.key);
    expect(serializedEntries).not.toContain(enc.iv);

    // Check plaintext byte run is not anywhere in metadata
    const plaintextString = String.fromCharCode(...plaintext);
    expect(serializedEntries).not.toContain(plaintextString);
  });

  // -------------------------------------------------------------------------
  // g. uploadMedia HTTP status error mapping
  // -------------------------------------------------------------------------
  it("g. uploadMedia maps 413 and 403 to a thrown typed error with status; returns mediaId on 201", async () => {
    const enc = await encryptMedia(makePngData([1]), "image/png");

    // 413 Payload Too Large
    const fetch413 = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "File too large" }), { status: 413 }),
    );
    await expect(
      uploadMedia({
        ciphertext: enc.ciphertext,
        conversationId: "00000000-0000-4000-8000-000000000000",
        authFetch: fetch413,
      }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof MediaUploadError && err.status === 413,
    );

    // 403 Forbidden
    const fetch403 = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "Permission denied" }), { status: 403 }),
    );
    await expect(
      uploadMedia({
        ciphertext: enc.ciphertext,
        conversationId: "00000000-0000-4000-8000-000000000000",
        authFetch: fetch403,
      }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof MediaUploadError && err.status === 403,
    );

    // 201 Created
    const fetch201 = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ media_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }), {
        status: 201,
      }),
    );
    const res = await uploadMedia({
      ciphertext: enc.ciphertext,
      conversationId: "00000000-0000-4000-8000-000000000000",
      authFetch: fetch201,
    });
    expect(res.mediaId).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  });

  // -------------------------------------------------------------------------
  // h. Payload serialization & strict parse validation
  // -------------------------------------------------------------------------
  it("h. buildMediaPayload then parseMediaPayload round-trips; parseMediaPayload strictly rejects each invalid variant", async () => {
    const enc = await encryptMedia(makePngData([1, 2, 3]), "image/png");
    const mediaId = "11111111-aaaa-4aaa-8aaa-555555555555";

    const payload = buildMediaPayload(enc, mediaId);
    const parsed = parseMediaPayload(payload);
    expect(parsed).toEqual(payload);

    // 1. Non-object inputs
    expect(() => parseMediaPayload(null)).toThrow();
    expect(() => parseMediaPayload(undefined)).toThrow();
    expect(() => parseMediaPayload("not-an-object")).toThrow();
    expect(() => parseMediaPayload(123)).toThrow();
    expect(() => parseMediaPayload([])).toThrow();

    // 2. Wrong type
    expect(() => parseMediaPayload({ ...payload, type: "FILE" })).toThrow();
    expect(() => parseMediaPayload({ ...payload, type: "image" })).toThrow();

    // 3. 31-byte key
    const key31 = toBase64(new Uint8Array(31));
    expect(() => parseMediaPayload({ ...payload, key: key31 })).toThrow();

    // 4. 11-byte IV
    const iv11 = toBase64(new Uint8Array(11));
    expect(() => parseMediaPayload({ ...payload, iv: iv11 })).toThrow();

    // 5. Uppercase hex sha256
    expect(() =>
      parseMediaPayload({ ...payload, sha256: payload.sha256.toUpperCase() }),
    ).toThrow();

    // 6. Uppercase UUID
    expect(() =>
      parseMediaPayload({ ...payload, media_id: payload.media_id.toUpperCase() }),
    ).toThrow();

    // 7. Disallowed mime
    expect(() =>
      parseMediaPayload({ ...payload, mime: "image/bmp" }),
    ).toThrow();

    // 8. Extra field
    expect(() =>
      parseMediaPayload({ ...payload, extraField: "should-fail" }),
    ).toThrow();
  });

  // -------------------------------------------------------------------------
  // i. Concurrency
  // -------------------------------------------------------------------------
  it("i. Concurrency: 20 parallel encryptMedia calls produce 20 distinct IVs", async () => {
    const input = makePngData([1, 2, 3, 4]);

    const encryptions = await Promise.all(
      Array.from({ length: 20 }, () => encryptMedia(input, "image/png")),
    );

    const ivSet = new Set(encryptions.map((e) => e.iv));
    expect(ivSet.size).toBe(20);

    const keySet = new Set(encryptions.map((e) => e.key));
    expect(keySet.size).toBe(20);
  });
});
