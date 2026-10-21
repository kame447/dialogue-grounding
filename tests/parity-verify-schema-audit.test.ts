// POSTAUDIT-22: recorded JSON only; one corrupted item per negative case.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyRecords } from "../dialogue-model/runtime/diagnostics/parity-verify/index.ts";
import { failureChecks } from "../dialogue-model/runtime/diagnostics/parity-verify/failure-records.ts";
import { row, rows } from "../dialogue-model/runtime/diagnostics/parity-verify/core.ts";
import type { Records, Row } from "../dialogue-model/runtime/diagnostics/parity-verify/core.ts";

const capture: Record<string, Records> = JSON.parse(readFileSync(new URL("./fixtures/parity-verify/failure-path/producer-records.json", import.meta.url), "utf8"));
const historical: Record<string, Records> = JSON.parse(readFileSync(new URL("./fixtures/parity-verify/producer-records.json", import.meta.url), "utf8"));
const clone = <T>(value: T): T => structuredClone(value);
const fixture = (name = "observation_timeout") => clone(capture[name]);
function result(r: Records, id: string) {
  const c = verifyRecords(r).checks.find(c => c.id === id); assert.ok(c, id); return c;
}
function schema(r: Records) { return failureChecks(r).find(c => c.id === "failure.schema")!; }
type Path = Array<string | number>;
function slot(value: Row, path: Path): { owner: any; key: string | number } {
  let owner: any = value; for (const key of path.slice(0, -1)) owner = owner[key]; return { owner, key: path.at(-1)! };
}
function legacy(): Records {
  const r = fixture();
  r.failure = { code: r.failure!.code, calls: clone(r.failure!.calls), cache: clone(capture.post_cache.failure!.cache) }; return r;
}
const enums: Array<{ name: string; make: () => Records; path: Path }> = [
  { name: "warmup.stage", make: fixture, path: ["stage"] },
  { name: "after_warmup.stage", make: () => fixture("cache_read_failed"), path: ["stage"] },
  { name: "HTTP.outcome", make: fixture, path: ["http", "records", 1, "outcome"] },
  { name: "HTTP.kind", make: fixture, path: ["http", "records", 1, "kind"] },
  { name: "HTTP.method", make: fixture, path: ["http", "records", 1, "method"] },
  { name: "CallReceipt.provider", make: legacy, path: ["calls", 0, "provider"] },
  { name: "CallReceipt.status", make: fixture, path: ["calls", 0, "status"] },
  { name: "cache.status", make: () => fixture("post_cache"), path: ["cache", "status"] },
  { name: "cache.reason", make: () => fixture("post_cache"), path: ["cache", "reason"] },
  { name: "cache.observation", make: () => fixture("post_cache"), path: ["cache", "observation"] },
  { name: "policy.status", make: () => fixture("policy_get_failed"), path: ["policy", "status"] },
  { name: "legacy.CallReceipt.status", make: legacy, path: ["calls", 0, "status"] },
  ...["status", "reason", "observation"].map(field => ({ name: `legacy.cache.${field}`, make: legacy, path: ["cache", field] })),
];
for (const item of enums) {
  test(`R121-1 ${item.name}: genuine string remains valid`, () => { assert.equal(schema(item.make()).status, "pass"); });
  for (const wrong of ["singleton_array", "object", "null", "boolean", "integer", "padded_string"]) test(`R121-1 ${item.name}: rejects ${wrong} without coercion`, () => {
    const r = item.make(), target = slot(r.failure!, item.path), original = target.owner[target.key];
    assert.equal(schema(r).status, "pass");
    target.owner[target.key] = wrong === "singleton_array" ? [original] : wrong === "object" ? { value: original } :
      wrong === "null" ? null : wrong === "boolean" ? true : wrong === "integer" ? 7 : `${original} `;
    assert.equal(schema(r).status, "mismatch"); assert.equal(schema(r).reason, "schema_violation");
  });
}
const booleans: Array<[string, Path]> = [["observationCallStarted", ["observationCallStarted"]], ["http.measured", ["http", "measured"]], ["policy.ready", ["policy", "value", "ready"]]];
for (const [name, path] of booleans) for (const wrong of ["true", 0, 1, null, [], {}]) test(`R121-1 ${name}: boolean rejects ${JSON.stringify(wrong)}`, () => {
  const r = fixture(), target = slot(r.failure!, path); target.owner[target.key] = wrong;
  assert.equal(schema(r).status, "mismatch"); assert.equal(schema(r).reason, "schema_violation");
});
for (const [name, path] of [
  ["configured.observationMs", ["deadlines", "configured", "observationMs"]],
  ["complete.callId", ["deadlines", "applied", "completeCalls", 0, "callId"]],
] as Array<[string, Path]>) for (const wrong of ["20000", true, null, [], {}, 1.5]) test(`R121-1 ${name}: integer rejects ${JSON.stringify(wrong)}`, () => {
  const r = fixture(), target = slot(r.failure!, path); target.owner[target.key] = wrong;
  assert.equal(schema(r).status, "mismatch"); assert.equal(schema(r).reason, "schema_violation");
});

const policyCases: Array<[string, (f: Row) => void]> = [
  ["ready=false", f => { row(row(f.policy).value).ready = false; }],
  ["wrong purpose", f => { row(row(f.policy).value).purpose = "another_purpose"; }],
  ["unexpected provider", f => { row(row(f.policy).value).provider = "unexpected"; }],
  ["another model", f => { row(row(f.policy).value).model = "synthetic-other"; }],
  ["failed after observation", f => { f.policy = { status: "failed", value: null }; }],
  ["not_requested after observation", f => { f.policy = { status: "not_requested", value: null }; }],
];
for (const [name, corrupt] of policyCases) test(`R121-2 obtained policy rejects ${name} independently of JSON types`, () => {
  const r = fixture(); corrupt(r.failure!);
  assert.equal(schema(r).status, "pass"); // Type-correct contradictions need a separate contract check.
  assert.equal(result(r, "failure.policy").status, "mismatch");
});
for (const model of [" ", "bad model;command", "a".repeat(129)]) test(`R121-2 obtained policy rejects malformed model ${JSON.stringify(model)}`, () => {
  const r = fixture(), f = r.failure!; // Valid obtained-policy boundary before any complete: isolate syntax from call equality.
  f.stage = "policy_get"; f.calls = []; f.observationCallStarted = false;
  row(f.http).records = rows(row(f.http).records).filter(h => h.kind === "policy_get");
  Object.assign(row(row(f.deadlines).applied), { observationOuterMs: null, completeCalls: [] });
  assert.equal(schema(r).status, "pass"); row(row(f.policy).value).model = model;
  assert.equal(result(r, "failure.policy").status, "mismatch");
});
test("R121-2 policy follows recorded requested model instead of pinning a research model ID", () => {
  const r = fixture(), p = row(row(r.failure!.policy).value); p.model = "organization/new-model:v2.1";
  rows(r.failure!.calls).forEach(c => { c.requestedModel = p.model; });
  assert.ok(!failureChecks(r).some(c => c.id === "failure.policy" && c.status === "mismatch"));
});
for (const provider of ["openai", "gemini"]) test(`R121-2 existing provider ${provider} remains allowed`, () => {
  const r = fixture(); row(row(r.failure!.policy).value).provider = provider;
  assert.ok(!failureChecks(r).some(c => c.id === "failure.policy" && c.status === "mismatch"));
});
test("R121-2 cache_get before complete still requires obtained policy", () => {
  const r = fixture("policy_get_failed"), f = r.failure!;
  f.stage = "cache_get"; row(row(f.deadlines).applied).observationOuterMs = 20000;
  f.policy = clone(capture.observation_timeout.failure!.policy); assert.equal(schema(r).status, "pass");
  f.policy = { status: "failed", value: null };
  assert.equal(schema(r).status, "pass"); assert.equal(result(r, "failure.policy").status, "mismatch");
});
test("R121-2 observed complete requires policy even when the stage is unknown", () => {
  const r = fixture(); r.failure!.stage = "unknown";
  r.failure!.policy = { status: "not_requested", value: null };
  assert.equal(schema(r).status, "pass"); assert.equal(result(r, "failure.policy").status, "mismatch");
});
test("R121-2 genuine policy GET failure, client setup and legacy stay distinct", () => {
  const r = fixture("policy_get_failed"); assert.deepEqual(verifyRecords(r).checks.filter(c => c.status === "mismatch"), []);
  const setup = fixture("policy_get_failed"), f = setup.failure!;
  f.stage = "client_setup"; f.policy = { status: "not_requested", value: null }; f.http = { measured: false, records: [] };
  assert.equal(schema(setup).status, "pass"); assert.deepEqual(failureChecks(setup).filter(c => c.status === "mismatch"), []);
  const old = legacy(); assert.equal(result(old, "failure.policy").status, "not_reached"); assert.equal(result(old, "failure.policy").reason, "legacy_unrecorded");
});

test("R121-3 missing trial cannot hide a summary overall/component contradiction", () => {
  const r = fixture("cache_read_and_save_failed"), snapshot = rows(r.summary!.gates)[0];
  assert.equal(snapshot.passed, false); assert.equal(row(snapshot.G3).passed, false); snapshot.passed = true;
  assert.equal(result(r, "gate.claim.snapshot").status, "mismatch");
  assert.equal(result(r, "gate.claim.snapshot").reason, "overall_passed_contradicts_component_gate");
  assert.equal(result(r, "records.trial_file.0").status, "not_reached"); assert.equal(result(r, "records.trial_file.0").reason, "output_missing");
  assert.equal(result(r, "records.planned_mapping").reason, "output_missing");
  assert.equal(result(r, "ledger.event_reconciliation").reason, "output_missing");
  assert.equal(r.trials.length, 0);
});
test("R121-3 unchanged save-failure capture keeps missing output and zero mismatches", () => {
  const r = fixture("cache_read_and_save_failed"); assert.deepEqual(verifyRecords(r).checks.filter(c => c.status === "mismatch"), []);
  assert.equal(result(r, "records.trial_file.0").reason, "output_missing");
});
test("R121-3 a trial snapshot also rejects its own overall/component contradiction", () => {
  const r = clone(historical.known), g = row(r.trials[0].gates); assert.equal(g.passed, true); row(g.G3).passed = false;
  assert.equal(result(r, "gate.claim.snapshot").status, "mismatch");
});
test("R121-3 unknown components are not guessed false", () => {
  const r = clone(historical.known), g = rows(r.summary!.gates)[0];
  assert.equal(g.passed, true); delete g.G3;
  assert.equal(result(r, "gate.claim.snapshot").status, "not_reached");
  assert.deepEqual(verifyRecords(r).checks.filter(c => c.status === "mismatch"), []);
});
test("R121-3 a known false component remains a contradiction even if another component is missing", () => {
  const r = fixture("cache_read_and_save_failed"), g = rows(r.summary!.gates)[0]; g.passed = true; delete g.G4;
  assert.equal(result(r, "gate.claim.snapshot").status, "mismatch");
});
test("R121-3 later failure does not invalidate an earlier good smoke snapshot or G4", () => {
  const r = clone(historical.known), last = r.trials.at(-1)!; last.failure = "synthetic_later_failure";
  row(last.gates).passed = false; rows(r.summary!.gates).at(-1)!.passed = false;
  assert.equal(result(r, "gate.G4").status, "pass"); assert.equal(result(r, "gate.claim.G4").status, "pass");
  assert.equal(result(r, "gate.claim.snapshot").status, "pass");
  assert.equal(row(r.trials[0].gates).passed, true);
});
