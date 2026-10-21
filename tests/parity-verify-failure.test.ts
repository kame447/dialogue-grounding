// Independent contract cases. Real mock-producer captures are tested separately below.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRecords, verifyRecords } from "../dialogue-model/runtime/diagnostics/parity-verify/index.ts";
import type { Records, Row } from "../dialogue-model/runtime/diagnostics/parity-verify/core.ts";
import { allCalls, hash, row, rows } from "../dialogue-model/runtime/diagnostics/parity-verify/core.ts";
import { failureChecks, failureKind, plannedMapping } from "../dialogue-model/runtime/diagnostics/parity-verify/failure-records.ts";

const old: Record<string, Records> = JSON.parse(readFileSync(new URL("./fixtures/parity-verify/producer-records.json", import.meta.url), "utf8"));
const legacy: Row = JSON.parse(readFileSync(new URL("./fixtures/parity-verify/legacy-failure.json", import.meta.url), "utf8"));
const clone = <T>(v: T): T => structuredClone(v);
function mapped(): Records {
  const r = clone(old.known); r.run!.plannedMappingVersion = 1;
  r.trials.forEach((t, i) => { t.plannedIndex = i; }); return r;
}
function warmFailure(): Records {
  const r = mapped(), warm = r.warmup!, budget = row(r.summary!.budget);
  r.trials = []; r.packets = []; r.summary!.runOrder = [];
  r.summary!.skipped = rows(row(r.run!.manifest).trials).map((p, i) => ({ ...p, plannedIndex: i, reason: "warmup_failed:timeout", status: "not_reached" }));
  Object.assign(budget, { sends: rows(budget.sends).filter(s => s.id === 1), jevPosts: 0, lunaPosts: 1, lunaCalls: 1, observedJevUsd: 0,
    observedInputTokens: 10, observedOutputTokens: 2, observedLunaTokens: 12, missingInputTokens: 0, missingOutputTokens: 0,
    inFlight: [], unresolvedJevSends: [], stops: [], jevUnknown: false });
  r.evidence!.events = rows(r.evidence!.events).filter(e => e.trialOrder === null);
  r.evidence!.pairedReplay = []; r.evidence!.cache = rows(r.evidence!.cache).filter(e => e.trialOrder === null);
  r.billing = r.billing!.filter(e => row(e.entry).id === 1);
  r.failure = { schemaVersion: "parity_live_failure_v1", scope: "warmup", code: "timeout", stage: "cache_get", calls: clone(warm.calls),
    cache: null, observationCallStarted: true, policy: { status: "obtained", value: clone(warm.policy) },
    http: { measured: true, records: clone(warm.http) }, deadlines: {
      configured: { observationMs: 20000, lunaClientTimeoutMs: null },
      applied: { observationOuterMs: 20000, completeCalls: [{ callId: 1, callOptionTimeoutMs: 19990 }] } } };
  delete r.warmup; return r;
}
const find = (r: Records, id: string) => { const c = verifyRecords(r).checks.find(c => c.id === id); assert.ok(c, id); return c; };
const schema = (r: Records) => failureChecks(r).find(c => c.id === "failure.schema")!;
const mapping = (r: Records) => plannedMapping(r)[0];

test("C6: absent failure file adds no failure-scope checks", () => {
  assert.equal(old.known.failure, undefined);
  assert.deepEqual(verifyRecords(old.known).checks.filter(c => c.id.startsWith("failure.")), []);
});
test("R16R-3: all planned skips map once; omitting a whole skipped row mismatches when no output is missing", () => {
  const r = warmFailure(); assert.equal(mapping(r).status, "pass");
  (r.summary!.skipped as Row[]).pop();
  assert.equal(mapping(r).status, "mismatch"); assert.equal(mapping(r).reason, "planned_mapping");
});

test("8105: duplicate existing complete ID cannot replace another complete with the same list length", () => {
  const r = warmFailure(), f = r.failure!, applied = row(row(f.deadlines).applied);
  (f.calls as Row[]).push({ ...clone(rows(f.calls)[0]), id: 2, sendIds: [] });
  (applied.completeCalls as Row[]).push({ callId: 2, callOptionTimeoutMs: 10000 });
  assert.equal(schema(r).status, "pass");
  rows(applied.completeCalls)[1].callId = 1; // Both IDs exist; length still matches. Only bijection is broken.
  assert.equal(schema(r).status, "mismatch"); assert.equal(schema(r).reason, "schema_violation");
});
test("8105: omitting one of two complete deadlines leaves a schema violation", () => {
  const r = warmFailure(), f = r.failure!, applied = row(row(f.deadlines).applied);
  (f.calls as Row[]).push({ ...clone(rows(f.calls)[0]), id: 2, sendIds: [] });
  (applied.completeCalls as Row[]).push({ callId: 2, callOptionTimeoutMs: null });
  assert.equal(schema(r).status, "pass"); (applied.completeCalls as Row[]).pop();
  assert.equal(schema(r).status, "mismatch"); assert.equal(schema(r).reason, "schema_violation");
});
test("8102: closed unknown POST outcome is valid; a started POST outcome is not", () => {
  const r = warmFailure(), post = rows(row(r.failure!.http).records).find(h => h.kind === "completion_post")!;
  post.outcome = "unknown"; post.status = null; assert.equal(schema(r).status, "pass");
  post.outcome = "started"; assert.equal(schema(r).status, "mismatch"); assert.equal(schema(r).reason, "schema_violation");
});

function closedLunaUnknown(): Records {
  const r = warmFailure(), c = rows(r.failure!.calls)[0], budget = row(r.summary!.budget), s = rows(budget.sends)[0];
  Object.assign(c, { status: "error", error: "luna_error", model: null, inputTokens: null, outputTokens: null });
  Object.assign(s, { status: "sent_result_unknown", model: null, inputTokens: null, outputTokens: null });
  Object.assign(budget, { observedInputTokens: 0, observedOutputTokens: 0, observedLunaTokens: 0, missingInputTokens: 1, missingOutputTokens: 1, halted: true });
  const post = rows(row(r.failure!.http).records).find(h => h.kind === "completion_post")!; post.outcome = "unknown"; post.status = null;
  const events = rows(r.evidence!.events).filter(e => e.type !== "response"), context = { ...events.find(e => e.type === "send")! };
  delete context.seq; delete context.at;
  events.push({ ...context, type: "stop", scope: "instance", scopeDetail: "logical_call", reason: "phase_aborted", inFlight: [1] },
    { ...context, type: "response", status: "unknown", model: null, inputTokens: null, outputTokens: null },
    { type: "stop", scope: "run", reason: "warmup_failed", inFlight: [1] });
  r.evidence!.events = events.map((e, i) => ({ ...e, seq: i + 1, at: "2026-10-21T00:00:00Z" }));
  r.billing = [{ entry: { ...s, status: "in_flight" } }, { entry: { ...s }, stops: [{ reason: "warmup_failed" }] }];
  return r;
}
function lateLunaUsage(r: Records) {
  const budget = row(r.summary!.budget), s = rows(budget.sends)[0];
  Object.assign(s, { status: "observed_response", model: "synthetic-luna", inputTokens: 10, outputTokens: 2 });
  Object.assign(budget, { observedInputTokens: 10, observedOutputTokens: 2, observedLunaTokens: 12, missingInputTokens: 0, missingOutputTokens: 0 });
  const events = rows(r.evidence!.events), prior = events.find(e => e.type === "response")!;
  const late: Row = { ...prior, seq: events.length + 1, status: "ok", model: "synthetic-luna", inputTokens: 10, outputTokens: 2 };
  (r.evidence!.events as Row[]).push(late); r.billing!.push({ entry: { ...s } }); return late;
}
test("8105: post-close usage revises the same Luna send and preserves unknown consumption at stop", () => {
  const r = closedLunaUnknown(), before = verifyRecords(r), native = hash({ calls: r.failure!.calls, http: r.failure!.http });
  assert.equal(schema(r).status, "pass"); assert.deepEqual(before.checks.filter(c => c.id.startsWith("ledger.") && c.status === "mismatch"), []);
  assert.equal(before.totals.unknownInputTokens, 1); assert.equal(before.totals.latestKnownLunaTokens, 0);
  const late = lateLunaUsage(r), after = verifyRecords(r);
  assert.equal(hash({ calls: r.failure!.calls, http: r.failure!.http }), native);
  assert.equal(late.sendId, rows(row(r.summary!.budget).sends)[0].id);
  assert.equal(after.totals.lunaComplete, 1); assert.equal(after.totals.actualSends, 1); assert.equal(after.totals.reservations, 1);
  assert.equal(after.totals.latestKnownLunaTokens, 12); assert.equal(after.totals.unknownInputTokens, 0);
  assert.deepEqual(after.checks.filter(c => c.id.startsWith("ledger.") && c.status === "mismatch"), []);
  assert.deepEqual(after.checks.filter(c => c.id.startsWith("billing.") && c.status === "mismatch"), []);
  const stopped = after.inFlightAtStops.at(-1)!; assert.deepEqual(stopped.sendIds, [1]);
  assert.equal(stopped.calls![0].knownInputTokensAtStop, null); assert.equal(stopped.calls![0].latestKnownInputTokens, 10);
  (r.evidence!.events as Row[]).push({ ...late, seq: Number(late.seq) + 1 });
  assert.equal(verifyRecords(r).totals.latestKnownLunaTokens, 12); // Same revision is never charged twice.
});
test("8105: late usage with another send ID is rejected instead of becoming a new send", () => {
  const r = closedLunaUnknown(), late = lateLunaUsage(r); late.sendId = 999;
  assert.equal(find(r, "ledger.event.7.response_ownership").status, "mismatch");
  assert.equal(verifyRecords(r).totals.actualSends, 1);
});
test("8102: client setup without measurement keeps HTTP unknown and deadlines unapplied", () => {
  const r = warmFailure(), f = r.failure!;
  Object.assign(f, { stage: "client_setup", calls: [], observationCallStarted: false, http: { measured: false, records: [] }, policy: { status: "not_requested", value: null } });
  Object.assign(row(row(f.deadlines).applied), { observationOuterMs: null, completeCalls: [] });
  assert.equal(schema(r).status, "pass"); assert.equal(find(r, "failure.http").status, "not_reached");
  assert.equal(verifyRecords(r).totals.policyGets, null);
});
test("8102: configured/applied deadlines are distinct, and an inconsistent configured value mismatches", () => {
  const r = warmFailure(), d = row(r.failure!.deadlines);
  assert.equal(row(d.configured).lunaClientTimeoutMs, null); assert.equal(find(r, "failure.deadlines").status, "pass");
  row(d.configured).observationMs = 30000;
  assert.equal(schema(r).status, "pass"); assert.equal(find(r, "failure.deadlines").status, "mismatch");
});

test("legacy fixed synthetic shape retains its one known complete; unrecorded HTTP is unknown", () => {
  const r = warmFailure(); r.failure = clone(legacy); delete r.run!.plannedMappingVersion;
  rows(r.summary!.skipped).forEach(s => { delete s.plannedIndex; });
  const v = verifyRecords(r);
  assert.equal(failureKind(r.failure), "legacy_v0"); assert.equal(schema(r).status, "pass");
  assert.equal(allCalls(r).length, 1); assert.equal(v.totals.lunaComplete, 1); assert.equal(v.totals.policyGets, null);
  for (const part of ["http", "policy", "deadlines"]) assert.deepEqual(find(r, `failure.${part}`), { id: `failure.${part}`, status: "not_reached", reason: "legacy_unrecorded" });
  assert.equal(find(r, "ledger.total.lunaCalls").status, "pass");
  for (const id of ["ledger.complete_post", "replay.http_receipts", "ledger.event_reconciliation"]) {
    assert.equal(find(r, id).status, "not_reached"); assert.equal(find(r, id).reason, "legacy_unrecorded");
  }
  assert.deepEqual(v.checks.filter(c => c.id.startsWith("ledger.") && c.status === "mismatch"), []);
});
test("warmup v1 is a separate owner with coherent ledger and no invented warmup success", () => {
  const r = warmFailure(), v = verifyRecords(r);
  assert.equal(schema(r).status, "pass"); assert.equal(find(r, "failure.scope").status, "pass");
  assert.equal(find(r, "records.ownership").status, "pass"); assert.equal(v.totals.lunaComplete, 1);
  assert.deepEqual(v.checks.filter(c => c.id.startsWith("ledger.") && c.status === "mismatch"), []);
  assert.equal(find(r, "cache.warmup").status, "not_reached");
});
const corruptions: Array<[string, (f: Row) => void]> = [
  ["missing http", f => { delete f.http; }], ["unknown top key", f => { f.extra = true; }],
  ["unknown policy key", f => { row(f.policy).extra = true; }],
  ["false measured with records", f => { row(f.http).measured = false; }],
  ["failed policy with value", f => { row(f.policy).status = "failed"; }],
  ["started HTTP after close", f => { rows(row(f.http).records)[0].outcome = "started"; }],
  ["call ID wrong type", f => { rows(f.calls)[0].id = "1"; }],
  ["missing call field", f => { delete rows(f.calls)[0].inputTokens; }],
  ["unknown receipt key", f => { rows(row(f.http).records)[0].extra = true; }],
  ["wrong cache type", f => { f.cache = []; }],
  ["observation start contradicted", f => { f.observationCallStarted = false; }],
  ["unknown stage", f => { f.stage = "guessed_cause"; }],
  ["unapplied outer timeout after cache started", f => { row(row(f.deadlines).applied).observationOuterMs = null; }],
  ["missing complete deadline", f => { row(row(f.deadlines).applied).completeCalls = []; }],
  ["duplicate complete deadline", f => { const a = row(row(f.deadlines).applied); a.completeCalls = [...rows(a.completeCalls), clone(rows(a.completeCalls)[0])]; }],
  ["wrong complete call ID", f => { rows(row(row(f.deadlines).applied).completeCalls)[0].callId = 999; }],
  ["unknown configured field", f => { row(row(f.deadlines).configured).effectiveNativeTimeout = 1; }],
  ["unknown schema version", f => { f.schemaVersion = "parity_live_failure_v2"; }],
];
for (const [name, change] of corruptions) test(`closed failure schema rejects ${name}`, () => {
  const r = warmFailure(); assert.equal(schema(r).status, "pass"); change(r.failure!);
  assert.equal(schema(r).status, "mismatch"); assert.equal(schema(r).reason, "schema_violation");
});
test("partial new records cannot fall back to legacy acceptance", () => {
  const r = warmFailure(); delete r.failure!.schemaVersion; assert.equal(schema(r).status, "mismatch");
  r.failure = { ...clone(legacy), http: [] }; assert.equal(schema(r).status, "mismatch");
});
for (const value of [null, [], 7, "failure"]) test(`failure top-level wrong type ${JSON.stringify(value)} is schema_violation`, () => {
  const r = warmFailure(); r.failure = value as unknown as Row;
  assert.equal(schema(r).status, "mismatch"); assert.equal(schema(r).reason, "schema_violation");
});
test("warmup HTTP hash contradictions survive an otherwise valid failure schema", () => {
  const r = warmFailure(); assert.equal(find(r, "failure.http_binding.0").status, "pass");
  rows(row(r.failure!.http).records).find(h => h.kind === "completion_post")!.requestSha256 = "0".repeat(64);
  assert.equal(schema(r).status, "pass"); assert.equal(find(r, "failure.http_binding.0").status, "mismatch");
});
test("legacy missing HTTP cannot erase known complete-event count contradictions", () => {
  const r = warmFailure(); r.failure = clone(legacy);
  const complete = rows(r.evidence!.events).find(e => e.type === "complete")!;
  const event = { ...complete, seq: 100, at: "2027-01-01T00:00:00Z", callId: 999 };
  (r.evidence!.events as Row[]).push(event);
  assert.equal(find(r, "ledger.event_reconciliation").status, "mismatch");
});
test("policy failure records GET separately with no observation complete or POST", () => {
  const r = warmFailure(), f = r.failure!;
  f.stage = "policy_get"; f.calls = []; f.observationCallStarted = false; f.policy = { status: "failed", value: null };
  row(f.http).records = rows(row(f.http).records).filter(h => h.kind === "policy_get");
  row(row(f.deadlines).applied).observationOuterMs = null; row(row(f.deadlines).applied).completeCalls = [];
  assert.equal(schema(r).status, "pass");
});
test("after_warmup cannot re-own calls; scope requires the actual warmup file", () => {
  const r = mapped(); r.failure = { schemaVersion: "parity_live_failure_v1", scope: "after_warmup", code: "trial_finalize_failed", stage: "trial_loop" };
  assert.equal(schema(r).status, "pass"); assert.equal(find(r, "records.ownership").status, "pass");
  assert.equal(verifyRecords(r).totals.lunaComplete, verifyRecords(old.known).totals.lunaComplete);
  delete r.warmup; assert.equal(find(r, "failure.scope").reason, "scope_contradiction"); assert.equal(find(r, "failure.scope").status, "mismatch");
  r.failure.calls = []; assert.equal(schema(r).status, "mismatch");
});
test("warmup scope plus warmup file exposes scope and duplicate ownership", () => {
  const r = warmFailure(); r.warmup = { calls: clone(r.failure!.calls), http: clone(row(r.failure!.http).records) };
  assert.equal(find(r, "failure.scope").status, "mismatch"); assert.equal(find(r, "records.ownership").reason, "duplicate_ownership");
  assert.equal(find(r, "records.ownership").status, "mismatch");
});
for (const field of ["call", "send", "http_call"]) test(`cross-file ${field} ID ownership never silently deduplicates`, () => {
  const r = mapped(), a = r.trials[0], b = r.trials[1];
  if (field === "call") rows(b.calls)[0].id = rows(a.calls)[0].id;
  if (field === "send") rows(b.calls)[0].sendIds = clone(rows(a.calls)[0].sendIds);
  if (field === "http_call") rows(b.http).find(h => h.kind === "completion_post")!.callId = rows(a.calls)[0].id;
  assert.equal(find(r, "records.ownership").status, "mismatch");
});
for (const scenario of Object.keys(old)) test(`unchanged ${scenario} fixture has legacy mapping, unchanged existing assertions`, () => {
  assert.deepEqual(mapping(old[scenario]), { id: "records.planned_mapping", status: "not_reached", reason: "legacy_unrecorded" });
});
test("new mapping requires one owner for every planned index", () => {
  const r = mapped(); assert.equal(mapping(r).status, "pass"); delete r.trials[1].plannedIndex;
  assert.equal(mapping(r).status, "mismatch"); assert.equal(mapping(r).reason, "planned_mapping");
});
test("duplicate planned index and started-plus-skipped both mismatch", () => {
  const r = mapped(); r.trials[1].plannedIndex = 0; assert.equal(mapping(r).status, "mismatch");
  const s = mapped(); s.summary!.skipped = [{ ...rows(row(s.run!.manifest).trials)[0], plannedIndex: 0 }];
  assert.equal(mapping(s).status, "mismatch");
});
test("missing skipped plannedIndex is malformed even alongside missing output", () => {
  const r = warmFailure(); delete rows(r.summary!.skipped)[0].plannedIndex; assert.equal(mapping(r).status, "mismatch");
});
test("missing trial output preserves started facts and reports output_missing, not guessed mapping failure", () => {
  const r = mapped(); r.trials.splice(1, 1);
  assert.equal(mapping(r).status, "not_reached"); assert.equal(mapping(r).reason, "output_missing");
  assert.equal(find(r, "records.trial_file.1").reason, "output_missing");
  assert.equal(find(r, "ledger.total.lunaCalls").status, "not_reached");
  assert.equal(find(r, "ledger.send_ownership").status, "not_reached");
  assert.equal(find(r, "ledger.event_reconciliation").status, "not_reached");
  assert.equal(find(r, "records.ownership").status, "pass");
  assert.deepEqual(verifyRecords(r).checks.filter(c => c.id.startsWith("replay.") && c.status === "mismatch"), []);
  r.trials[1].plannedIndex = 0; assert.equal(mapping(r).status, "mismatch");
});
test("missing output cannot hide recorded billing or stop contradictions", () => {
  const r = mapped(); r.trials.splice(1, 1); row(r.summary!.budget).lunaPosts = 0;
  assert.equal(find(r, "ledger.total.lunaPosts").status, "mismatch");
});
test("missing mapping source fields remain output_missing, while known duplicates still mismatch", () => {
  const r = mapped(); delete r.summary!.runOrder;
  assert.equal(mapping(r).reason, "output_missing"); assert.equal(mapping(r).status, "not_reached");
  r.trials[1].plannedIndex = 0; assert.equal(mapping(r).status, "mismatch");
  const s = mapped(); delete row(s.run!.manifest).trials; assert.equal(mapping(s).reason, "output_missing");
});
test("known legacy excess trials contradict the plan without inferring indices", () => {
  const r = clone(old.known); r.trials.push(clone(r.trials[0])); assert.equal(mapping(r).status, "mismatch");
});
test("missing marker plus plannedIndex is version_contradiction; unknown marker is unknown_version", () => {
  const r = mapped(); delete r.run!.plannedMappingVersion; assert.equal(mapping(r).reason, "version_contradiction");
  r.run!.plannedMappingVersion = 2; assert.equal(mapping(r).reason, "unknown_version");
});
test("R16R-3: a skipped-only plannedIndex also contradicts a missing marker", () => {
  const r = clone(old.known); r.summary!.skipped = [{ plannedIndex: 0 }];
  assert.equal(mapping(r).status, "mismatch"); assert.equal(mapping(r).reason, "version_contradiction");
});
for (const version of [0, 2, "1", null, true]) test(`R16R-3: marker ${JSON.stringify(version)} is an unknown version`, () => {
  const r = mapped(); r.run!.plannedMappingVersion = version;
  assert.equal(mapping(r).status, "mismatch"); assert.equal(mapping(r).reason, "unknown_version");
});
for (const index of [-1, 3, "1", null]) test(`R16R-3: invalid plannedIndex ${JSON.stringify(index)} is a mapping violation`, () => {
  const r = mapped(); r.trials[1].plannedIndex = index;
  assert.equal(mapping(r).status, "mismatch"); assert.equal(mapping(r).reason, "planned_mapping");
});
for (const duplicate of ["call", "send", "started_skipped"]) test(`PREAPPROVAL-16R2: missing trial output cannot hide known ${duplicate} duplication`, () => {
  const r = mapped(); r.trials.splice(1, 1);
  assert.equal(mapping(r).reason, "output_missing");
  if (duplicate === "call") rows(r.trials[1].calls)[0].id = rows(r.trials[0].calls)[0].id;
  if (duplicate === "send") rows(r.trials[1].calls)[0].sendIds = clone(rows(r.trials[0].calls)[0].sendIds);
  if (duplicate === "started_skipped") {
    r.summary!.skipped = [{ ...rows(row(r.run!.manifest).trials)[0], plannedIndex: 0, reason: "synthetic" }];
    assert.equal(mapping(r).status, "mismatch"); assert.equal(mapping(r).reason, "planned_mapping");
  } else {
    assert.equal(find(r, "records.ownership").status, "mismatch"); assert.equal(find(r, "records.ownership").reason, "duplicate_ownership");
    assert.equal(mapping(r).status, "not_reached");
  }
});
test("PREAPPROVAL-16R2: failure integrity never masks actual cache or stage gate failures", () => {
  const r = mapped(); r.failure = { schemaVersion: "parity_live_failure_v1", scope: "after_warmup", code: "cache_read_failed", stage: "trial_loop" };
  r.trials[0].failure = "cache_read_failed";
  rows(r.evidence!.cache).find(c => c.trialOrder === 0)!.afterSha256 = null;
  assert.equal(schema(r).status, "pass"); assert.equal(find(r, "records.ownership").status, "pass");
  assert.deepEqual(verifyRecords(r).checks.filter(c => c.id.startsWith("ledger.") && c.status === "mismatch"), []);
  for (const id of ["cache.immutable.0", "gate.G1"]) assert.equal(find(r, id).status, "mismatch");
  // Astra 8162/parent 8164: committed-turn G2 survives, independent error guards do not.
  assert.equal(find(r, "gate.G2").status, "pass");
  assert.equal(find(r, "gate.claim.execution").status, "mismatch");
  assert.equal(find(r, "gate.claim.execution").reason, "overall_passed_requires_no_primary_execution_failure");
  assert.equal(find(r, "gate.primary_error_progression").status, "mismatch");
  assert.equal(find(r, "gate.primary_error_progression").reason, "main_started_after_primary_execution_failure");
});
test("PREAPPROVAL-16R2: physical field deletion and physical file loss have distinct outcomes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "parity-mapping-")), r = mapped();
  try {
    await chmod(dir, 0o700);
    const save = (name: string, value: unknown) => writeFile(join(dir, name), JSON.stringify(value), { mode: 0o600 });
    await save("run.private.json", r.run); await save("summary.private.json", r.summary); await save("warmup.private.json", r.warmup);
    for (const t of r.trials) await save(`trial-${t.order}.private.json`, t);
    assert.equal(mapping(await loadRecords(dir)).status, "pass");
    const malformed = clone(r.trials[1]); delete malformed.plannedIndex; await save("trial-1.private.json", malformed);
    assert.equal(mapping(await loadRecords(dir)).reason, "planned_mapping");
    await rm(join(dir, "trial-1.private.json"));
    const absent = await loadRecords(dir); assert.equal(mapping(absent).reason, "output_missing"); assert.equal(mapping(absent).status, "not_reached");
    assert.deepEqual(absent.summary!.runOrder, r.summary!.runOrder);
    assert.equal(find(absent, "records.trial_file.1").reason, "output_missing");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("real cache invariant violation survives a well-formed failure wrapper", () => {
  const r = warmFailure(); r.failure!.stage = "post_cache"; r.failure!.cache = clone(old.known.warmup!.audit); row(r.failure!.cache).status = "HIT";
  assert.equal(schema(r).status, "pass"); assert.equal(find(r, "failure.cache").status, "mismatch");
});
test("saved cache receipt with missing warmup file is missing proof, while memo corruption remains a mismatch", () => {
  const r = warmFailure(); r.failure!.stage = "post_cache";
  assert.equal(find(r, "cache.warmup.receipt").status, "not_reached");
  assert.equal(find(r, "cache.warmup.receipt").reason, "output_missing");
  assert.equal(find(r, "cache.receipt.0.memo").status, "not_reached");
  assert.equal(find(r, "cache.receipt.0.validation").status, "pass");
  row(rows(r.evidence!.cache)[0].memo).observedAt = "synthetic-corruption";
  assert.equal(find(r, "cache.receipt.0.memo").status, "mismatch");
});
test("loader reads failure.private.json independently, with no warmup or trials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "parity-failure-"));
  try {
    await chmod(dir, 0o700); await writeFile(join(dir, "failure.private.json"), JSON.stringify(legacy), { mode: 0o600 });
    const loaded = await loadRecords(dir); assert.deepEqual(loaded.failure, legacy); assert.equal(loaded.warmup, undefined);
    assert.equal(verifyRecords(loaded).totals.lunaComplete, 1); assert.equal(find(loaded, "failure.http").reason, "legacy_unrecorded");
    assert.deepEqual(verifyRecords(loaded).checks.filter(c => c.id.startsWith("ledger.") && c.status === "mismatch"), []);
    await writeFile(join(dir, "failure.private.json"), "null", { mode: 0o600 });
    assert.equal(find(await loadRecords(dir), "failure.schema").reason, "schema_violation");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
