import test from "node:test";
import assert from "node:assert/strict";
import { resolvePurposeModel, RESEARCH_AI_PURPOSES } from "./modelPolicy.mjs";

test("research model selection is centralized by purpose", () => {
  assert.deepEqual(RESEARCH_AI_PURPOSES, ["dialogue_turn"]);
  assert.deepEqual(
    resolvePurposeModel({ purpose: "dialogue_turn", model: "malicious-client-model" },
      { DIALOGUE_MODEL: "gpt-4o-mini" }),
    { purpose: "dialogue_turn", model: "gpt-4o-mini" },
  );
});

test("changing only the internal Worker variable selects a new model", () => {
  const request = { purpose: "dialogue_turn" };
  assert.equal(resolvePurposeModel(request, { DIALOGUE_MODEL: "vision-A" }).model, "vision-A");
  assert.equal(resolvePurposeModel(request, { DIALOGUE_MODEL: "vision-B" }).model, "vision-B");
});

test("model selection rejects unknown purposes and missing or invalid Worker settings", () => {
  const validEnv = { DIALOGUE_MODEL: "gpt-4o-mini" };
  assert.deepEqual(resolvePurposeModel({ purpose: "dialogue_unknown" }, validEnv),
    { error: "unsupported_purpose" });
  assert.deepEqual(resolvePurposeModel({ model: "gpt-4o-mini" }, validEnv),
    { error: "unsupported_purpose" });
  assert.deepEqual(resolvePurposeModel({ purpose: "__proto__" }, validEnv),
    { error: "unsupported_purpose" });
  assert.deepEqual(resolvePurposeModel({ purpose: "dialogue_turn" }, {}),
    { error: "model_unconfigured" });
  assert.deepEqual(resolvePurposeModel({ purpose: "dialogue_turn" },
    { DIALOGUE_MODEL: "bad model;command" }), { error: "model_unconfigured" });
});
