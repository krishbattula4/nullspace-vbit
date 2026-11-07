import { describe, expect, it } from "vitest";
import { runSpike } from "./spike";

describe("Signal protocol spike", () => {
  it("resolves with decrypted === 'hello'", async () => {
    const result = await runSpike();
    expect(result.decrypted).toBe("hello");
    expect(result.library).toBe("@privacyresearch/libsignal-protocol-typescript");
  });
});
