import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/ai/protocol";
import { createLimit } from "./limits";
import { MOCK_OPENING, mockReplyText } from "./partners/mockRules";

describe("room creation limit", () => {
  it("uses the dev override only on localhost", () => {
    expect(createLimit({ DEV_CREATE_PER_MINUTE: "300" }, new URL("http://127.0.0.1:8788/api/rooms"))).toBe(300);
    expect(createLimit({ DEV_CREATE_PER_MINUTE: "300" }, new URL("http://localhost:8788/api/rooms"))).toBe(300);
    expect(createLimit({ DEV_CREATE_PER_MINUTE: "300" }, new URL("https://dg-tangram-ai-demo.example.workers.dev/api/rooms"))).toBe(LIMITS.createPerMinute);
  });

  it("falls back to the production limit for missing or invalid overrides", () => {
    expect(createLimit({}, new URL("http://127.0.0.1:8788/"))).toBe(LIMITS.createPerMinute);
    expect(createLimit({ DEV_CREATE_PER_MINUTE: "abc" }, new URL("http://127.0.0.1:8788/"))).toBe(LIMITS.createPerMinute);
    expect(createLimit({ DEV_CREATE_PER_MINUTE: "0" }, new URL("http://127.0.0.1:8788/"))).toBe(LIMITS.createPerMinute);
    expect(LIMITS.createPerMinute).toBe(10);
  });
});

describe("mock AI script", () => {
  it("never asks for or mentions figure numbers", () => {
    for (const text of [MOCK_OPENING, ...Array.from({ length: 8 }, (_, i) => mockReplyText(i))]) {
      expect(text).not.toMatch(/図形\s*[0-9０-９]|番号/);
    }
  });
});
