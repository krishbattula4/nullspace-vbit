import { describe, expect, it } from "vitest";
import { API_URL, WS_URL } from "./api";

describe("api config", () => {
  it("has sane defaults", () => {
    expect(API_URL).toMatch(/^https?:\/\//);
    expect(WS_URL).toMatch(/^wss?:\/\//);
  });
});
