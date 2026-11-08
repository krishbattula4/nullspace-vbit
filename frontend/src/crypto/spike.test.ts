import { describe, expect, it } from "vitest";
import { runSpike, runPersistentSpike, runKeyChangeSpike } from "./spike";

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
    expect(result.aliceSafetyNumberFormatted).toBeDefined();
    expect(result.bobSafetyNumberFormatted).toBeDefined();
    expect(result.aliceSafetyNumberFormatted).toBe(result.bobSafetyNumberFormatted);
    expect(result.safetyNumbersMatch).toBe(true);
  });

  it("runKeyChangeSpike simulates Bob key change, alice decrypts, verification becomes Key changed", async () => {
    const result = await runKeyChangeSpike();
    expect(result.library).toBe("@privacyresearch/libsignal-protocol-typescript");
    expect(result.decryptedSuccess).toBe(true);
    expect(result.aliceDecrypted).toBe("I reinstalled");
    expect(result.stateLabelText).toBe("Key changed");
    expect(result.stateLabelColour).toBe("red");
    expect(result.eventDirection).toBe("incoming");
    expect(result.safetyNumbersDiffer).toBe(true);
  });
});
