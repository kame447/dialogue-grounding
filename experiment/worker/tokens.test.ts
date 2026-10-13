// @vitest-environment node
import { describe, expect, it } from "vitest";
import { constantTimeEqual, randomHex, sha256Hex } from "./tokens";
import { isRoomId, isToken } from "../src/ai/protocol";

describe("tokens", () => {
  it("creates protocol-shaped room ids and tokens", () => {
    expect(isRoomId(randomHex(16))).toBe(true);
    expect(isToken(randomHex(24))).toBe(true);
  });

  it("hashes text and compares equal and unequal values", async () => {
    expect(await sha256Hex("token")).toMatch(/^[0-9a-f]{64}$/);
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});
