// Consume producer JSON only. Never import/read its implementation or generator.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyRecords } from "../dialogue-model/runtime/diagnostics/parity-verify/index.ts";
import type { Check, Records } from "../dialogue-model/runtime/diagnostics/parity-verify/core.ts";
import { allCalls, allHttp, list, row, rows } from "../dialogue-model/runtime/diagnostics/parity-verify/core.ts";

// Parent integrates the fixture at this repository-relative location. A path override
// supports read-only connection checks before integration, without copying its data.
const source = process.env.PARITY_FAILURE_FIXTURE ?? new URL("./fixtures/parity-verify/failure-path/producer-records.json", import.meta.url);
const captured: Record<string, Records> = JSON.parse(readFileSync(source, "utf8"));
const names = ["observation_timeout", "policy_get_failed", "post_cache", "cache_read_failed", "cache_read_and_save_failed"];
const fixture = (name: string) => { assert.ok(captured[name], `missing capture ${name}`); return structuredClone(captured[name]); };
const select = (checks: Check[], id: string) => { const found = checks.find(c => c.id === id); assert.ok(found, `missing check ${id}`); return found; };
const failures = (checks: Check[], prefix: string) => checks.filter(c => c.id.startsWith(prefix) && c.status === "mismatch");

test("C7 producer capture contains all five contract scenarios", () => {
  assert.deepEqual(Object.keys(captured).sort(), [...names].sort());
});
for (const name of names) test(`C7 ${name}: closed failure schema and ownership remain independently coherent`, () => {
  const r = fixture(name), v = verifyRecords(r);
  for (const id of ["failure.schema", "failure.scope", "records.ownership"]) assert.equal(select(v.checks, id).status, "pass", id);
  assert.deepEqual(failures(v.checks, "billing."), []);
  assert.deepEqual(v.checks.filter(c => c.reason === "duplicate_ownership" && c.status === "mismatch"), []);
  assert.equal(r.run!.plannedMappingVersion, 1);
  if (name !== "cache_read_and_save_failed") assert.equal(select(v.checks, "records.planned_mapping").status, "pass");
});
test("C7 observation timeout preserves one measured POST, unknown usage and the applied complete deadline", () => {
  const r = fixture("observation_timeout"), f = r.failure!, applied = row(row(f.deadlines).applied), v = verifyRecords(r);
  assert.equal(f.scope, "warmup"); assert.equal(f.stage, "cache_get"); assert.equal(f.observationCallStarted, true);
  assert.ok(Number.isInteger(applied.observationOuterMs)); assert.equal(rows(applied.completeCalls).length, 1);
  assert.equal(rows(applied.completeCalls)[0].callId, rows(f.calls)[0].id);
  assert.equal(v.totals.lunaComplete, 1); assert.equal(v.totals.recordedLunaPosts, 1); assert.equal(v.totals.actualSends, 1);
  assert.equal(v.totals.unknownInputTokens, 1); assert.equal(v.totals.unknownOutputTokens, 1);
  assert.equal(v.totals.lunaCostUsd, null); assert.equal(v.totals.totalUsd, null);
  assert.equal(rows(row(f.http).records).find(h => h.kind === "completion_post")!.outcome, "unknown");
  assert.deepEqual(v.checks.filter(c => c.status === "mismatch"), []);
  for (const gate of ["G1", "G2", "G3", "G4"]) assert.equal(select(v.checks, `gate.${gate}`).status, "not_reached");
  assert.equal(r.trials.length, 0); assert.equal(rows(r.summary!.skipped).length, list(row(r.run!.manifest).trials).length);
  assert.ok(rows(r.summary!.skipped).every(s => s.status === "not_reached" && String(s.reason).startsWith("warmup_failed:")));
});
test("C7 policy GET failure measures GET separately, with zero complete/POST and no applied observation", () => {
  const r = fixture("policy_get_failed"), f = r.failure!, applied = row(row(f.deadlines).applied), v = verifyRecords(r);
  assert.equal(f.stage, "policy_get"); assert.equal(f.observationCallStarted, false); assert.equal(row(f.policy).status, "failed");
  assert.equal(row(f.policy).value, null); assert.equal(applied.observationOuterMs, null); assert.deepEqual(applied.completeCalls, []);
  assert.equal(v.totals.policyGets, 1); assert.equal(v.totals.recordedLunaPosts, 0); assert.equal(v.totals.lunaComplete, 0);
  assert.equal(v.totals.actualSends, 0); assert.equal(rows(row(f.http).records)[0].method, "GET");
  assert.deepEqual(v.checks.filter(c => c.status === "mismatch"), []);
});
test("C7 post-cache capture retains its actual missing-POST wiring violation", () => {
  const r = fixture("post_cache"), v = verifyRecords(r);
  assert.equal(r.failure!.stage, "post_cache"); assert.equal(r.failure!.code, "cache_warmup_http_wiring");
  assert.equal(v.totals.lunaComplete, 1); assert.equal(v.totals.recordedLunaPosts, 0);
  assert.equal(select(v.checks, "ledger.complete_post").status, "mismatch");
  assert.deepEqual(v.checks.filter(c => c.status === "mismatch").map(c => c.id), ["ledger.complete_post"]);
  assert.equal(select(v.checks, "ledger.total.lunaCalls").status, "pass");
  assert.equal(select(v.checks, "ledger.event_reconciliation").status, "pass");
});
test("C7 trial cache-read failure preserves native receipts without double accounting or certifying G1", () => {
  const r = fixture("cache_read_failed"), t = r.trials[0], v = verifyRecords(r);
  assert.equal(r.failure!.scope, "after_warmup"); assert.deepEqual(Object.keys(r.failure!).sort(), ["code", "schemaVersion", "scope", "stage"]);
  assert.equal(t.failure, "cache_read_failed"); assert.equal(t.plannedIndex, 0); assert.ok(rows(t.calls).length > 0);
  assert.ok(rows(t.calls).some(c => c.provider === "luna" && list(c.sendIds).length > 0));
  assert.ok(rows(t.calls).some(c => c.provider === "jev" && list(c.sendIds).length > 0));
  assert.ok(rows(t.http).some(h => h.kind === "completion_post"));
  assert.equal(v.totals.lunaComplete, allCalls(r).filter(c => c.provider === "luna").length);
  assert.equal(v.totals.recordedLunaPosts, allHttp(r).filter(h => h.kind === "completion_post").length);
  assert.deepEqual(failures(v.checks, "ledger."), []);
  // Astra RULING-C7-G2: actual committed turn evidence survives later finalization failure.
  assert.equal(select(v.checks, "gate.G2").status, "pass");
  assert.equal(select(v.checks, "gate.claim.G2").status, "pass");
  assert.equal(row(t.gates).passed, false); assert.equal(t.failure, "cache_read_failed");
  assert.ok(!r.trials.some(t => t.stage === "main"));
  assert.equal(select(v.checks, "gate.claim.execution").status, "pass");
  assert.equal(select(v.checks, "gate.primary_error_progression").status, "not_reached");
  assert.notEqual(select(v.checks, "gate.G1").status, "pass"); // No fabricated per-trial cache hash receipt.
  assert.deepEqual(v.checks.filter(c => c.status === "mismatch"), []);
});
for (const owner of ["trial", "summary"]) test(`G2 ruling: failure plus only ${owner} overall passed=true is a contradiction`, () => {
  const r = fixture("cache_read_failed");
  const target = owner === "trial" ? row(r.trials[0].gates) : rows(r.summary!.gates)[0];
  assert.equal(target.passed, false); target.passed = true; // Sole corruption; failure evidence and G1..G4 unchanged.
  const v = verifyRecords(r);
  assert.equal(select(v.checks, "gate.claim.execution").status, "mismatch");
  assert.equal(select(v.checks, "gate.claim.execution").reason, "overall_passed_requires_no_primary_execution_failure");
  assert.equal(select(v.checks, "gate.G2").status, "pass");
});
test("G2 ruling: main begun after a recorded primary error violates independent progression", () => {
  const r = fixture("cache_read_failed"), t = structuredClone(r.trials[0]);
  Object.assign(t, { order: 1, plannedIndex: 1, stage: "main", failure: null });
  // Only the new trial's existence/order/stage matters to this scoped progression check.
  r.trials.push(t);
  const v = verifyRecords(r);
  assert.equal(select(v.checks, "gate.primary_error_progression").status, "mismatch");
  assert.equal(select(v.checks, "gate.primary_error_progression").reason, "main_started_after_primary_execution_failure");
  assert.equal(select(v.checks, "gate.G2").status, "pass");
});
test("G2 ruling: a cache_read_failed code before any valid turn cannot certify G2", () => {
  const r = fixture("cache_read_failed"); r.trials[0].turns = [];
  const v = verifyRecords(r); assert.notEqual(select(v.checks, "gate.G2").status, "pass");
  assert.notEqual(select(v.checks, "gate.claim.G2").status, "pass");
});
for (const source of ["call", "attempt", "stage", "image"]) test(`G2 ruling retains in-turn ${source} failures`, () => {
  const r = fixture("cache_read_failed"), t = r.trials[0];
  if (source === "call") rows(t.calls).find(c => c.phase === "decision")!.status = "error";
  if (source === "attempt") rows(t.attempts)[0].status = "aborted";
  if (source === "stage") row(row(rows(rows(t.turns)[0].trace)[0].aiPublic).stages).ai_support = { status: "timeout" };
  if (source === "image") rows(t.calls).find(c => c.phase === "decision")!.imageCount = 1;
  assert.equal(select(verifyRecords(r).checks, "gate.G2").status, "mismatch");
});
test("C7 failed trial save keeps started fact and G3 failure, with output_missing rather than invented native calls", () => {
  const r = fixture("cache_read_and_save_failed"), v = verifyRecords(r), saving = row(r.summary!.auditability);
  assert.equal(r.failure!.scope, "after_warmup"); assert.equal(r.trials.length, 0);
  assert.equal(list(r.summary!.runOrder).length, 1); assert.ok(!rows(r.summary!.skipped).some(s => s.plannedIndex === 0));
  assert.notEqual(saving.status, "auditable"); assert.equal(saving.requiredWritesComplete, false);
  assert.equal(row(row(rows(r.summary!.gates)[0]).G3).passed, false);
  assert.ok(r.storage!.some(s => s.name === "trial-0.private.json" && !s.regular));
  for (const id of ["records.trial_file.0", "records.planned_mapping", "ledger.total.lunaCalls", "ledger.send_ownership", "ledger.event_reconciliation"])
    assert.equal(select(v.checks, id).status, "not_reached", id);
  assert.equal(select(v.checks, "records.trial_file.0").reason, "output_missing");
  assert.equal(select(v.checks, "records.planned_mapping").reason, "output_missing");
  assert.equal(select(v.checks, "gate.G3").status, "not_reached");
  assert.deepEqual(v.checks.filter(c => c.status === "mismatch"), []);
  assert.ok(Number(v.totals.actualSends) > Number(v.totals.recordedLunaPosts)); // Ordered ledger survives missing native file.
});
