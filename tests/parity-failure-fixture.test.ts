// Mechanical capture/provenance checks, independent of verifier judgments.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { captureFailureFixtures, comparableCaptures, COMPARISON_EXCLUSIONS, FAILURE_SCENARIOS, FIXED_DATE_MS,
  fixtureSourceHashes, sha256 } from "./support/generate-failure-fixture.ts";
import type { Capture, Captures } from "./support/generate-failure-fixture.ts";
import { createTrialV2, modelView } from "../dialogue-model/runtime/stimuli/scatter-v2.mjs";

const directory = new URL("./fixtures/parity-verify/failure-path/", import.meta.url);
const raw = await readFile(new URL("producer-records.json", directory), "utf8");
const frozen: Captures = JSON.parse(raw);
const metadata = JSON.parse(await readFile(new URL("capture-metadata.json", directory), "utf8"));
// R2-D Option B: retain historical bytes; bind current comparisons to the approved integrated capture.
const currentDirectory = new URL("./fixtures/parity-verify/failure-path-luna-public-acts-5e28a2c/", import.meta.url);
const currentRaw = await readFile(new URL("producer-records.json", currentDirectory), "utf8");
const currentFrozen: Captures = JSON.parse(currentRaw);
const currentMetadata = JSON.parse(await readFile(new URL("capture-metadata.json", currentDirectory), "utf8"));
const closed = (value: any, keys: readonly string[]) => {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
};
const integer = (value: unknown) => assert.ok(Number.isSafeInteger(value) && (value as number) >= 0);

function failureShape(record: Capture) {
  const failure = record.failure;
  assert.equal(failure.schemaVersion, "parity_live_failure_v1");
  assert.ok(typeof failure.code === "string" && /^[a-z_]+$/u.test(failure.code));
  if (failure.scope === "after_warmup") {
    closed(failure, ["schemaVersion", "scope", "code", "stage"]);
    assert.equal(failure.stage, "trial_loop"); assert.ok(record.warmup); return;
  }
  closed(failure, ["schemaVersion", "scope", "code", "stage", "calls", "cache", "observationCallStarted", "policy", "http", "deadlines"]);
  assert.equal(failure.scope, "warmup"); assert.equal(record.warmup, undefined);
  assert.ok(["cache_get", "policy_get", "post_cache"].includes(failure.stage));
  assert.ok(Array.isArray(failure.calls)); assert.equal(typeof failure.observationCallStarted, "boolean");
  closed(failure.policy, ["status", "value"]);
  if (failure.policy.status === "obtained") {
    closed(failure.policy.value, ["purpose", "ready", "model", "provider"]);
    assert.equal(failure.policy.value.purpose, "dialogue_turn"); assert.equal(failure.policy.value.ready, true);
    assert.equal(failure.policy.value.model, "synthetic-luna"); assert.equal(failure.policy.value.provider, "openai");
  } else { assert.ok(["failed", "not_requested"].includes(failure.policy.status)); assert.equal(failure.policy.value, null); }
  closed(failure.http, ["measured", "records"]);
  assert.equal(typeof failure.http.measured, "boolean"); assert.ok(Array.isArray(failure.http.records));
  if (!failure.http.measured) assert.deepEqual(failure.http.records, []);
  for (const receipt of failure.http.records) {
    closed(receipt, ["method", "kind", "phase", "callId", "sendId", "hashScheme", "requestSha256", "status", "outcome"]);
    assert.equal(receipt.hashScheme, "canonical_json_sha256");
    assert.ok(["returned", "unknown"].includes(receipt.outcome));
  }
  closed(failure.deadlines, ["configured", "applied"]);
  closed(failure.deadlines.configured, ["observationMs", "lunaClientTimeoutMs"]);
  assert.deepEqual(failure.deadlines.configured, { observationMs: 20000, lunaClientTimeoutMs: null });
  closed(failure.deadlines.applied, ["observationOuterMs", "completeCalls"]);
  assert.ok(failure.deadlines.applied.observationOuterMs === null || Number.isSafeInteger(failure.deadlines.applied.observationOuterMs));
  assert.ok(Array.isArray(failure.deadlines.applied.completeCalls));
  for (const call of failure.deadlines.applied.completeCalls) {
    closed(call, ["callId", "callOptionTimeoutMs"]); integer(call.callId);
    assert.ok(call.callOptionTimeoutMs === null || Number.isSafeInteger(call.callOptionTimeoutMs));
  }
}

function plannedMapping(record: Capture, scenario: string) {
  assert.equal(record.run.plannedMappingVersion, 1);
  const plans = record.run.manifest.trials;
  const started = record.trials.map(trial => trial.plannedIndex);
  for (const trial of record.trials) {
    integer(trial.plannedIndex);
    for (const key of ["stage", "scriptId", "label"]) assert.equal(trial[key], plans[trial.plannedIndex][key]);
  }
  assert.equal(record.summary.runOrder.length, scenario.startsWith("cache_read") ? 1 : 0);
  for (const skipped of record.summary.skipped) {
    integer(skipped.plannedIndex); assert.equal(skipped.status, "not_reached");
    assert.equal(skipped.scriptId, plans[skipped.plannedIndex].scriptId); assert.equal(skipped.label, plans[skipped.plannedIndex].label);
  }
  if (scenario === "cache_read_and_save_failed") {
    // The producer summary/evidence retain a started trial, but its file is
    // genuinely missing. Do not invent a saved trial or move it into skipped.
    assert.deepEqual(started, []); assert.deepEqual(record.summary.skipped.map((s: any) => s.plannedIndex), [1, 2]);
    assert.deepEqual(record.summary.runOrder, [{ scriptId: plans[0].scriptId, label: plans[0].label }]);
    assert.ok(record.evidence.events.some((e: any) => e.type === "send" && e.trialOrder === 0));
  } else {
    assert.deepEqual([...started, ...record.summary.skipped.map((s: any) => s.plannedIndex)].sort((a, b) => a - b), [0, 1, 2]);
  }
}

function storageAndPrivacy(captures: Captures) {
  const imageBase64 = modelView(createTrialV2({ seed: 1701 })).png.toString("base64");
  const strings = (value: unknown): void => {
    if (typeof value === "string") {
      assert.ok(!value.includes(imageBase64), "captured own-image bytes");
      assert.ok(!/data\s*:\s*image\s*\/|sk-|\bBearer\b|\btoken\b|fixture-auth-material|[A-Za-z0-9+/]{200,}={0,2}/iu.test(value), "image or authentication-like value in fixture");
    } else if (Array.isArray(value)) value.forEach(strings);
    else if (value && typeof value === "object") Object.values(value).forEach(strings);
  };
  strings(captures);
  for (const [scenario, record] of Object.entries(captures)) {
    closed(record.directories, ["root", "output", "cache", "run"]);
    assert.ok(Object.values(record.directories).every(mode => mode === 0o700), `${scenario}: private directories must be 0700`);
    for (const storage of record.storage) {
      assert.equal(storage.mode, storage.regular ? 0o600 : 0o700, `${scenario}/${storage.name}`);
      if (!storage.regular) assert.ok(scenario === "cache_read_and_save_failed" && storage.name === "trial-0.private.json");
    }
    assert.ok(record.storage.some(s => s.name === "failure.private.json" && s.regular));
  }
}

test("failure fixture source SHA and literal digest require explicit regeneration when stale", async () => {
  assert.equal(metadata.schemaVersion, "parity_live_failure_capture_v1");
  assert.deepEqual(metadata.scenarios, [...FAILURE_SCENARIOS]);
  assert.deepEqual(metadata.comparisonExclusions, [...COMPARISON_EXCLUSIONS]);
  assert.deepEqual(metadata.controlledClock, { dateMs: FIXED_DATE_MS, performanceStartMs: 0 });
  assert.equal(sha256(raw), metadata.fixtureSha256, "fixture digest differs: 再生成が必要 (regenerate failure fixture)");
  assert.equal(sha256(raw), "5b25db524986d2313e631735dfb53d9ef216f0ae850e5c140084f58c902bd5c8");
  assert.equal(sha256(JSON.stringify(metadata.sourceFiles)), "0bb6a47fcf5ddfe74b871bb690405a6a1a82a50cd194fb800f37acf10c0c3c0a");
  assert.equal(currentMetadata.schemaVersion, metadata.schemaVersion);
  assert.equal(currentMetadata.baseCommit, "5e28a2c5237c438fdedb1b41110103a1a286821d");
  assert.equal(sha256(currentRaw), currentMetadata.fixtureSha256);
  assert.deepEqual(currentMetadata.scenarios, metadata.scenarios);
  assert.deepEqual(currentMetadata.comparisonExclusions, metadata.comparisonExclusions);
  assert.deepEqual(currentMetadata.controlledClock, metadata.controlledClock);
  assert.deepEqual(await fixtureSourceHashes(currentFrozen), currentMetadata.sourceFiles,
    "producer/generator source SHA differs: 再生成が必要 — node tests/support/generate-failure-fixture.ts");
});

for (const scenario of FAILURE_SCENARIOS) test(`failure fixture ${scenario}: closed schema, planned slots, private storage`, () => {
  const record = frozen[scenario]; failureShape(record); plannedMapping(record, scenario);
  assert.equal(record.run.execution, "mock"); assert.notEqual(record.summary.status, "wiring_passed");
  if (scenario === "policy_get_failed") {
    assert.equal(record.failure.stage, "policy_get"); assert.deepEqual(record.failure.policy, { status: "failed", value: null });
    assert.equal(record.failure.observationCallStarted, false); assert.equal(record.failure.deadlines.applied.observationOuterMs, null);
    assert.deepEqual(record.failure.deadlines.applied.completeCalls, []); assert.deepEqual(record.failure.calls, []);
    assert.equal(record.summary.budget.lunaPosts, 0);
    assert.equal(record.failure.http.records.length, 1); assert.equal(record.failure.http.records[0].kind, "policy_get");
  } else if (!scenario.startsWith("cache_read")) {
    assert.equal(record.failure.stage, scenario === "post_cache" ? "post_cache" : "cache_get");
    assert.equal(record.failure.observationCallStarted, true);
    assert.equal(record.failure.deadlines.applied.observationOuterMs, 20000);
    assert.deepEqual(record.failure.deadlines.applied.completeCalls, [{ callId: 1, callOptionTimeoutMs: 20000 }]);
    assert.equal(record.failure.calls.length, 1);
    const posts = record.failure.http.records.filter((r: any) => r.kind === "completion_post");
    assert.equal(posts.length, scenario === "post_cache" ? 0 : 1);
    if (scenario === "post_cache") assert.equal(record.failure.code, "cache_warmup_http_wiring");
    else assert.equal(posts[0].outcome, "unknown");
  } else {
    assert.equal(record.failure.code, "cache_read_failed");
    if (scenario === "cache_read_failed") {
      assert.equal(record.trials.length, 1); assert.equal(record.trials[0].failure, "cache_read_failed");
      for (const provider of ["luna", "jev"]) assert.ok(record.trials[0].calls.some((c: any) => c.provider === provider));
      assert.ok(record.trials[0].http.length > 0);
    } else {
      assert.equal(record.summary.status, "save_failed"); assert.equal(record.summary.gates[0].G3.passed, false);
      assert.ok(record.summary.auditability.recordReceipts.some((r: any) => r.file === "trial-0.private.json" && r.status === "failed"));
    }
  }
  // One owner per logical call / actual send. Billing revisions are a journal,
  // not additional owners; the missing trial remains missing in the fifth case.
  const owners = [record.failure, record.warmup, ...record.trials].filter(Boolean);
  const calls = owners.flatMap(owner => owner.calls ?? []).map(call => call.id);
  const sends = owners.flatMap(owner => Array.isArray(owner.http) ? owner.http : owner.http?.records ?? [])
    .flatMap(receipt => receipt.sendId === null ? [] : [receipt.sendId]);
  assert.equal(new Set(calls).size, calls.length); assert.equal(new Set(sends).size, sends.length);
});

test("failure fixtures contain no image/authentication bodies and record actual private modes", () => { storageAndPrivacy(frozen); });

test("two independent mock producer captures match the frozen fixture except the three listed run IDs", async t => {
  const first = await captureFailureFixtures(t.mock), second = await captureFailureFixtures(t.mock);
  for (const scenario of FAILURE_SCENARIOS) {
    assert.notEqual(first[scenario].run.runId, second[scenario].run.runId);
    failureShape(first[scenario]); failureShape(second[scenario]);
    plannedMapping(first[scenario], scenario); plannedMapping(second[scenario], scenario);
  }
  storageAndPrivacy(first); storageAndPrivacy(second);
  assert.deepEqual(comparableCaptures(first), comparableCaptures(second));
  assert.deepEqual(comparableCaptures(first), comparableCaptures(currentFrozen), "producer output changed: 再生成が必要");
});
