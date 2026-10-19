// Local (proposition-scoped) grounding contract: closed sets stay disjoint where the design requires it.
import test from "node:test";
import assert from "node:assert/strict";
import { LOCAL_ACTS, LOCAL_ASPECTS, LOCAL_ISSUE_STATES, LOCAL_NAME_STATES, LOCAL_SOURCES } from "../dialogue-model/runtime/local-grounding/contract.ts";

test("closed sets are frozen and duplicate-free", () => {
  for (const values of [LOCAL_ACTS, LOCAL_ASPECTS, LOCAL_ISSUE_STATES, LOCAL_NAME_STATES, LOCAL_SOURCES]) {
    assert.ok(Object.isFrozen(values));
    assert.equal(new Set(values).size, values.length);
  }
});

test("construal and naming are separate aspects and acts", () => {
  assert.ok(LOCAL_ASPECTS.includes("construal") && LOCAL_ASPECTS.includes("name"));
  assert.ok(LOCAL_ACTS.includes("construe") && LOCAL_ACTS.includes("name_propose"));
  assert.deepEqual([...LOCAL_NAME_STATES], ["no_name", "unclear", "not_agreed", "agreed", "unknown"]);
});

test("acknowledgment and unknown are distinct from agreement", () => {
  for (const act of ["acknowledge", "unknown", "agree", "name_accept"] as const) assert.ok(LOCAL_ACTS.includes(act));
});
