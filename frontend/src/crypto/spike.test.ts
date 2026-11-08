import { describe, expect, it } from "vitest";
import { runSpike, runPersistentSpike } from "./spike";

describe("Signal protocol spike", () => {
  it("resolves with decrypted === 'hello'", async () => {
    const result = await runSpike();
    expect(result.decrypted).toBe("hello");
    expect(result.library).toBe("@privacyresearch/libsignal-protocol-typescript");
  });

  it("runPersistentSpike executes 2-way persistent ratchet exchange", async () => {
    const result = await runPersistentSpike();
    expect(result.library).toBe("@privacyresearch/libsignal-protocol-typescript");
    expect(result.bobDecrypted).toBe("hello");
    expect(result.aliceDecrypted).toBe("hi back");
    expect(result.aliceToBobEnvelopeType).toBe(3);
    expect(result.bobToAliceEnvelopeType).toBe(1);
  });
});
