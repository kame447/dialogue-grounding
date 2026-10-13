import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/ai/protocol";
import { createLimit } from "./limits";
import { extractNamePairs } from "./partners/mockRules";

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

describe("mock name extraction", () => {
  it("keeps only the last mention per figure", () => {
    const pairs = extractNamePairs("図形2は細長くて、左に傾いた人みたいに見えます。図形2は踊り子");
    expect([...pairs]).toEqual([[2, "踊り子"]]);
  });

  it("reads several figures and full-width digits", () => {
    expect([...extractNamePairs("図形１は山、図形3を「星」")]).toEqual([[1, "山"], [3, "星"]]);
  });
});
