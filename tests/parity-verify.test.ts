// Entirely synthetic record fixtures. No harness imports, APIs or credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { canonical, hash, loadRecords, profileHash, sha256, verifyDirectory, verifyRecords } from "../dialogue-model/runtime/diagnostics/parity-verify/index.ts";
import type { Records, Row } from "../dialogue-model/runtime/diagnostics/parity-verify/index.ts";
import { coverage } from "../dialogue-model/runtime/diagnostics/parity-verify/coverage.ts";
import { row, rows } from "../dialogue-model/runtime/diagnostics/parity-verify/core.ts";

const digest = sha256("synthetic cache bytes");
function fixture(): Records {
  const profile = { id: "synthetic_profile", referenceMemory: true, decisionMode: "jev", humanReferent: true,
    localGrounding: { enabled: true, aiPublicClaims: true }, initialObservation: "cache_required", timeouts: { decisionMs: 15000 },
    modelPolicy: { jevModel: "test-jev" }, questionLayout: "two_stage_v1", lunaRequest: { timeoutMs: null, maxCompletionTokens: null } };
  const memo = { observedAt: "2026-10-21T00:00:00Z", figures: [{ id: "own-1", region: { x: 0, y: 0, w: 10, h: 10 },
    holistic: [{ construal: "synthetic shape", basis: ["synthetic parts"], status: "hypothesis" }],
    analytic: { shapes: ["triangle"], composition: "synthetic triangle", relations: [] }, unknowns: [], reobservations: [] }] };
  const caps = { lunaCalls: 131, lunaPosts: 393, jevPosts: 208, jevUsd: 2, lunaTokens: 1500000 };
  const manifest = { id: "synthetic", caps };
  const records: Records = { run: { runId: "synthetic-only", execution: "mock", manifest, manifestSha256: hash(manifest), profile, profileSha256: profileHash(profile) },
    summary: {}, warmup: {}, trials: [], billing: [], packets: [], storage: [],
    evidence: { version: 1, runId: "synthetic-only", events: [], pairedReplay: [], cache: [] } };
  const sends: Row[] = [], events = records.evidence!.events as Row[], billing = records.billing!, cache = records.evidence!.cache as Row[];
  let callId = 0, sendId = 0;
  const push = (event: Row) => { events.push({ seq: events.length + 1, at: "2026-10-21T00:00:00Z", ...event }); };
  const addCall = (order: number | null, label: string, provider: string, phase: string, payload: unknown) => {
    const id = ++callId, sid = ++sendId, model = provider === "luna" ? "test-luna" : "test-jev";
    const context = { provider, trialOrder: order, label, instanceId: `${provider}-${order ?? "warm"}`, callId: id, phase };
    if (provider === "luna") push({ type: "complete", ...context });
    push({ type: "reserve", ...context, sendId: sid }); push({ type: "send", ...context, sendId: sid });
    const initial = { id: sid, provider, phase, turn: order === null ? null : 1, logicalCallId: id, status: "in_flight", costUsd: null,
      inputTokens: null, outputTokens: null, model: null, modelMatches: null };
    billing.push({ entry: structuredClone(initial), stops: [] });
    const result = { ...initial, status: "observed_response", costUsd: provider === "jev" ? 0.001 : null,
      inputTokens: provider === "luna" ? 10 : null, outputTokens: provider === "luna" ? 2 : null, model, modelMatches: true };
    sends.push(result); billing.push({ entry: structuredClone(result), stops: [] });
    push({ type: "response", ...context, sendId: sid, status: "ok", requestedModel: model, model, costUsd: result.costUsd,
      inputTokens: result.inputTokens, outputTokens: result.outputTokens });
    return { id, sendIds: [sid], phase, turn: order === null ? null : 1, provider, requestSha256: hash(payload), instructionSha256: hash("synthetic instructions"),
      requestedModel: model, model, status: "ok", error: null, costUsd: result.costUsd, inputTokens: result.inputTokens,
      outputTokens: result.outputTokens, imageCount: 0, latencyMs: 1 };
  };
  const policy = () => ({ method: "GET", kind: "policy_get", phase: null, requestSha256: null, status: 200, outcome: "returned" });
  const snapshot = () => {
    const luna = sends.filter(s => s.provider === "luna"), jev = sends.filter(s => s.provider === "jev");
    return { sends: structuredClone(sends), observedJevUsd: jev.length * 0.001, observedInputTokens: luna.length * 10,
      observedOutputTokens: luna.length * 2, observedLunaTokens: luna.length * 12, missingInputTokens: 0, missingOutputTokens: 0,
      lunaCalls: luna.length, lunaPosts: luna.length, jevPosts: jev.length, inFlight: [], unresolvedJevSends: [],
      jevUnknown: false, halted: false, stops: [], limits: caps, lunaCostUsd: null, totalUsd: null };
  };
  const httpPost = (phase: string, payload: unknown) => ({ method: "POST", kind: "completion_post", phase, requestSha256: hash(payload), status: 200, outcome: "returned" });
  const warmPayload = [{ role: "user", content: "Observe synthetic own image" }];
  const warmCall = addCall(null, "warmup", "luna", "observation_initial", warmPayload);
  records.warmup = { audit: { status: "MISS", key: { modelHash: hash("test-luna") } }, memoSha256: hash(memo), fileSha256: digest,
    calls: [warmCall], http: [policy(), httpPost("observation_initial", warmPayload)], policy: { model: "test-luna" } };
  cache.push({ trialOrder: null, status: "MISS", beforeSha256: null, afterSha256: digest, memo, memoSha256: hash(memo), validated: true, requestedModel: "test-luna", returnedModel: "test-luna" });
  const labels = ["repair-first", "repair-first", "bypass-enabled"];
  for (let order = 0; order < labels.length; order++) {
    const label = labels[order], stage = order === 0 ? "smoke" : "main";
    const request = (key: string) => ({ model: "test-jev", state: "{}", questions: { [key]: { type: "choice", instructions: "Use public evidence", criteria: { unknown: "Uncertain", figure_0: "Own figure" } } } });
    const hr = request("human_referent"), decision = request("action"), generation = [{ role: "system", content: "Generate a natural response from the synthetic public history only." }];
    const response = (key: string) => ({ model: "test-jev", usage: { cost: 0.001 }, answers: { [key]: { type: "choice", choice: "unknown", probabilities: { unknown: 1, figure_0: 0 } } } });
    const calls = [addCall(order, label, "jev", "human_referent", hr), addCall(order, label, "jev", "decision", decision), addCall(order, label, "luna", "generation", generation)];
    const state = { graph: { records: [] }, ledger: {}, repairHistory: [], observationMemo: structuredClone(memo), aiPublic: { log: [] } };
    const publicTurns = [{ id: "human-1", seq: 1, speaker: "human", text: "形があるね。" }, { id: "ai-2", seq: 2, speaker: "ai", text: "見てみよう。" }];
    const trace = { status: "committed", turnIndex: 1, publicSpeech: "見てみよう。", humanReferent: { status: "ok", model: "test-jev" },
      local: { status: "committed", localStatus: "ok" }, decisions: [{ action: "describe", decisionKind: "jev_local_test", evidence: { stages: [{ model: "test-jev" }] } }],
      finalAction: { action: "describe" }, reobservations: [], aiPublic: { pending: { aiSeq: 2, status: "empty", candidates: [], reasons: [] },
        stages: { ai_extraction: { status: "ok" }, ai_function: { status: "skipped" }, ai_support: { status: "skipped" } } } };
    const tape = { state: structuredClone(state), events: [structuredClone(publicTurns[0])], jev: [response("human_referent"), response("action")],
      luna: [{ phase: "generation", response: { model: "test-luna", text: "見てみよう。", inputTokens: 10, outputTokens: 2 } }],
      expectedRequests: calls.map(c => ({ provider: c.provider, phase: c.phase, requestSha256: c.requestSha256 })) };
    const trial: Row = { order, stage, label, scriptId: "S0", completed: true, failure: null, profile: structuredClone(profile), profileSha256: profileHash(profile),
      cache: { status: "HIT", key: { modelHash: hash("test-luna") } },
      identity: { image: hash("own image"), anchors: hash("own anchors"), memo: hash(memo), prompts: hash("prompts"), profile: profileHash(profile),
        timeouts: hash(profile.timeouts), requestedModels: hash(["test-luna", "test-jev"]), returnedModels: ["test-luna", "test-jev"] },
      calls, http: [policy(), httpPost("generation", generation)], publicTurns, attempts: [], budget: snapshot(),
      turns: [{ turn: 1, publicText: "見てみよう。", trace: [trace], state, humanReferent: [hash(hr)], actionInputs: [hash(decision)],
        humanMaterial: [hash("same referent materials")], actionMaterial: [hash("same action materials")] }],
      replay: [{ tape, result: { requests: structuredClone(tape.expectedRequests), labelsEqual: true, status: "same_material_same_payload" } }],
      gates: { G1: { passed: true }, G2: { passed: true }, G3: { passed: true }, G4: { passed: true } } };
    records.trials.push(trial);
    const material = { state: structuredClone(tape.state), events: structuredClone(tape.events), profile: structuredClone(profile) };
    const requests = [hr, decision, generation].map((payload, j) => ({ provider: calls[j].provider, phase: calls[j].phase, payload, payloadSha256: hash(payload) }));
    (records.evidence!.pairedReplay as Row[]).push({ trialOrder: order, turn: 1,
      left: { label: "repair-first", material: structuredClone(material), materialSha256: hash(material), requests: structuredClone(requests) },
      right: { label: "bypass-enabled", material: structuredClone(material), materialSha256: hash(material), requests: structuredClone(requests) } });
    cache.push({ trialOrder: order, status: "HIT", beforeSha256: digest, afterSha256: digest, memo: structuredClone(memo), memoSha256: hash(memo), validated: true, requestedModel: "test-luna", returnedModel: "test-luna" });
    for (const seq of [1, 2]) {
      const prefix = publicTurns.filter(t => t.seq <= seq).map(t => ({ turn: t.seq, speaker: t.speaker, text: t.text }));
      records.packets!.push({ name: `public-${order}-${seq}.packet.json`, value: { prefix, sha256: hash(prefix) } });
    }
  }
  const budget = { sends, observedJevUsd: 0.006, observedInputTokens: 40, observedOutputTokens: 8, observedLunaTokens: 48,
    missingInputTokens: 0, missingOutputTokens: 0, lunaCalls: 4, lunaPosts: 4, jevPosts: 6, inFlight: [], unresolvedJevSends: [],
    jevUnknown: false, halted: false, stops: [], limits: caps, lunaCostUsd: null, totalUsd: null };
  records.summary = { runId: "synthetic-only", profile: structuredClone(profile), profileSha256: profileHash(profile), manifestSha256: hash(manifest), budget, cacheFileSha256: digest };
  const names = ["run.private.json", "summary.private.json", "warmup.private.json", ...records.trials.map(t => `trial-${t.order}.private.json`)];
  records.storage = [...names, ...records.packets!.map(p => p.name)].map(name => ({ name, mode: 0o600, external: true, regular: true }));
  return records;
}
const result = (records: Records, id: string) => {
  const report = verifyRecords(records), found = report.checks.find(c => c.id === id);
  assert.ok(found, `missing check ${id}; ${JSON.stringify(report.checks.filter(c => c.status === "mismatch"))}`); return found;
};
function corrupt(name: string, mutate: (r: Records) => void, id: string) {
  test(name, () => { const r = fixture(); assert.equal(result(r, id).status, "pass"); mutate(r); assert.equal(result(r, id).status, "mismatch"); });
}

test("independent canonical JSON matches fixed SHA vectors, preserves arrays, rejects invalid JSON", () => {
  assert.equal(canonical({ z: [2, 1], a: { c: false, b: "日本語" } }), '{"a":{"b":"日本語","c":false},"z":[2,1]}');
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(hash({ b: 1, a: 2 }), hash({ a: 2, b: 1 }));
  assert.notEqual(hash([1, 2]), hash([2, 1]));
  for (const v of [undefined, NaN, Infinity, new Date(), [undefined], new Array(1)]) assert.throws(() => canonical(v));
});
test("clean full synthetic records have no mismatch and all four gates pass", () => {
  const r = fixture(), report = verifyRecords(r);
  assert.deepEqual(report.checks.filter(c => c.status === "mismatch"), []);
  for (const gate of ["G1", "G2", "G3", "G4"]) assert.equal(result(r, `gate.${gate}`).status, "pass");
  assert.equal(report.status, "not_reached"); // Naming semantics deliberately not evaluated.
  assert.equal(report.totals.policyGets, 4); assert.equal(report.totals.lunaComplete, 4);
});
corrupt("one profile flag changed invalidates profile SHA", r => { row(r.trials[1].profile).referenceMemory = false; }, "identity.profile.3");
corrupt("one memo SHA changed across labels is detected", r => { row(r.trials[2].identity).memo = hash("corrupt"); }, "identity.pair.0.memo");
corrupt("one byte-equivalent cache hash changed after trial is detected", r => { rows(r.evidence!.cache)[1].afterSha256 = hash("changed cache"); }, "cache.immutable.0");
corrupt("trial MISS is never accepted", r => { row(r.trials[0].cache).status = "MISS"; }, "cache.trial.0");
corrupt("warm-up zero POST is never accepted", r => { r.warmup!.http = rows(r.warmup!.http).filter(h => h.kind !== "completion_post"); }, "cache.warmup");
corrupt("unknown Luna USD cannot become zero", r => { row(r.summary!.budget).lunaCostUsd = 0; }, "ledger.unknown_cost");
corrupt("one budget total changed is detected", r => { row(r.summary!.budget).observedJevUsd = 0; }, "ledger.total.observedJevUsd");
corrupt("unknown input-token field cannot be silently zeroed in total", r => { rows(row(r.summary!.budget).sends)[0].inputTokens = null; }, "ledger.total.observedInputTokens");
corrupt("duplicate one send ID is detected", r => { rows(row(r.summary!.budget).sends)[1].id = 1; }, "ledger.ids");
corrupt("one call references another call's send", r => { rows(r.trials[0].calls)[0].sendIds = [1]; }, "ledger.call.1");
corrupt("a model mismatch is detected", r => { rows(r.trials[0].calls)[0].model = "other-model"; }, "identity.model.1");
corrupt("one non-observation image crosses the wire boundary", r => { rows(r.trials[0].calls)[0].imageCount = 1; }, "identity.images");
corrupt("one public secret-like token is detected without being printed", r => { rows(r.trials[0].publicTurns)[1].text = "Bearer synthetic-private-token"; }, "privacy.public");
corrupt("one public packet SHA is corrupted", r => { r.packets![0].value.sha256 = hash("corrupt"); }, "records.packet.0");
corrupt("one file permission is too broad", r => { r.storage![0].mode = 0o644; }, "gate.G3");
corrupt("one stage-one primary error blocks G2 even when final speech committed", r => { rows(r.trials[0].calls)[2].status = "error"; }, "gate.G2");
corrupt("one recorded probability shape is invalid", r => {
  const tape = row(rows(r.trials[0].replay)[0].tape);
  row(row(row(rows(tape.jev)[0].answers).human_referent).probabilities).unknown = 2;
}, "gate.G2");
corrupt("one evidence run ID differs", r => { r.evidence!.runId = "unrelated"; }, "records.evidence");
corrupt("one ordered event sequence is duplicated", r => { rows(r.evidence!.events)[1].seq = 1; }, "ledger.event_order");
corrupt("one reservation becomes a refusal before the actual send", r => { rows(r.evidence!.events).find(e => e.type === "reserve")!.type = "refused"; }, "ledger.event.2.reserved_before_send");

test("raw paired payload differences are detected even if original harness says labelsEqual", () => {
  const r = fixture(), pair = rows(r.evidence!.pairedReplay)[0], request = rows(row(pair.right).requests)[0];
  row(request.payload).model = "other-model";
  request.payloadSha256 = hash(request.payload);
  assert.equal(result(r, "replay.0.parity").status, "mismatch");
  assert.equal(result(r, "replay.0.right.wire_binding").status, "mismatch");
});
test("normalization omits only pre-listed envelope keys and never nested model keys", () => {
  const r = fixture(), request = rows(row(rows(r.evidence!.pairedReplay)[0].right).requests)[0];
  request.label = "metadata-only"; request.startedAt = "measurement-only";
  assert.equal(result(r, "replay.0.parity").status, "pass");
  row(request.payload).label = "model-visible"; request.payloadSha256 = hash(request.payload);
  assert.equal(result(r, "replay.0.parity").status, "mismatch");
});
test("genuine upstream material differences are not classified as label mismatches", () => {
  const r = fixture(), right = row(rows(r.evidence!.pairedReplay)[0].right);
  row(right.material).state = { graph: { records: ["upstream stochastic difference"] } };
  right.materialSha256 = hash(right.material);
  assert.equal(result(r, "replay.0.parity").status, "not_comparable");
  rows(r.trials[2].turns)[0].humanMaterial = [hash("different upstream material")];
  assert.equal(result(r, "identity.pair.0.turn.0.humanReferent").status, "not_comparable");
});
test("missing raw evidence cannot be replaced with labelsEqual or gate pass booleans", () => {
  const r = fixture(); delete r.evidence;
  assert.equal(result(r, "replay.prewire").status, "not_reached");
  assert.equal(result(r, "ledger.events").status, "not_reached");
  assert.equal(result(r, "cache.immutable.0").status, "not_reached");
  assert.equal(result(r, "gate.claim.G1").status, "not_reached");
});

test("run stop reports all in-flight calls; no new send or commit can follow it", () => {
  const r = fixture(), events = rows(r.evidence!.events), sendIndex = events.findIndex(e => e.type === "send");
  const s = events[sendIndex], stop = { seq: 0, at: s.at, type: "stop", reason: "trial_timeout", scope: "run", inFlight: [s.sendId] };
  events.splice(sendIndex + 1, 0, stop); events.forEach((e, i) => { e.seq = i + 1; });
  r.evidence!.events = events;
  const report = verifyRecords(r);
  assert.deepEqual(report.inFlightAtStops[0].sendIds, [s.sendId]);
  assert.equal(result(r, "ledger.stop_discipline").status, "mismatch");
  stop.inFlight = [];
  assert.ok(verifyRecords(r).checks.some(c => c.reason === "all_in_flight_at_stop_listed" && c.status === "mismatch"));
});
test("Jev per-instance prediction rule checks previous maximum, not merely final USD", () => {
  const r = fixture(), events = rows(r.evidence!.events);
  const responses = events.filter(e => e.type === "response" && e.provider === "jev" && e.trialOrder === 0);
  responses[0].costUsd = 0.03; // .03 spent + .03 predicted exceeds .05 before next send.
  const report = verifyRecords(r);
  assert.ok(report.checks.some(c => c.reason === "jev_instance_point05_rule" && c.status === "mismatch"));
});
test("unknown Jev billing halts within the same trial, while unknown Luna usage is a lower bound", () => {
  const r = fixture(), events = rows(r.evidence!.events);
  events.find(e => e.type === "response" && e.provider === "jev")!.costUsd = null;
  assert.equal(result(r, "ledger.stop_discipline").status, "mismatch");
  const clean = fixture(), budget = row(clean.summary!.budget), send = rows(budget.sends)[0];
  send.inputTokens = null; budget.observedInputTokens = 30; budget.observedLunaTokens = 38; budget.missingInputTokens = 1;
  assert.equal(result(clean, "ledger.total.missingInputTokens").status, "pass");
  assert.equal(verifyRecords(clean).totals.unknownInputTokens, 1);
});
test("late response revisions are billed once and never reopen a stopped run", () => {
  const r = fixture(), events = rows(r.evidence!.events), lastResponse = events.at(-1)!;
  const stop = { seq: events.length + 1, at: lastResponse.at, type: "stop", scope: "run", reason: "end", inFlight: [] };
  events.push(stop, { ...lastResponse, seq: events.length + 2 }); r.evidence!.events = events;
  assert.equal(result(r, "ledger.stop_discipline").status, "pass");
  assert.equal(verifyRecords(r).totals.latestKnownLunaTokens, 48);
  events.push({ type: "commit", seq: events.length + 1, at: lastResponse.at, trialOrder: 2 });
  assert.equal(result(r, "ledger.stop_discipline").status, "mismatch");
});

function coverageFixture() {
  const r = fixture(), trial = r.trials[0], turns = rows(trial.turns), turn = turns[0], trace = rows(turn.trace)[0];
  const candidates = [{ candidateKey: "2#1", quote: "見て", sourceTurn: 2 }, { candidateKey: "2#2", quote: "みよう", sourceTurn: 2 }];
  (trial.calls as Row[]).push(...["ai_extraction", "ai_function", "ai_support"].map((phase, index) => ({ turn: 1, phase, status: "ok", sendIds: [100 + index], model: "test-model", requestedModel: "test-model" })));
  trace.aiPublic = { stages: { ai_extraction: { status: "ok" }, ai_function: { status: "ok" }, ai_support: { status: "ok" } },
    pending: { aiSeq: 2, status: "ready", candidates, reasons: [] } };
  const next = structuredClone(turn); next.turn = 3;
  rows(next.trace)[0].aiPublic = { pending: { aiSeq: 4, status: "empty", candidates: [] }, stages: {},
    application: { aiSeq: 2, status: "applied", claims: [{ id: "3:pub1", candidateKey: "2#1" }, { id: "3:pub2", candidateKey: "2#2" }] } };
  row(row(next.state).graph).records = [{ id: "3:pub1", speaker: "ai", sourceTurn: 2 }, { id: "3:pub2", speaker: "ai", sourceTurn: 2 }];
  trial.turns = [turn, next]; r.trials = [trial]; return r;
}
const aiCell = (r: Records) => coverage(r).cells.find(c => c.path === "aiPublic" && c.turn === 1)!;
test("AI coverage is recomputed from stage, commit, next application and graph evidence", () => {
  const r = coverageFixture(); assert.equal(aiCell(r).classification, "live_demonstrated");
  row(row(rows(rows(r.trials[0].turns)[0].trace)[0].aiPublic).stages).ai_function = { status: "error" };
  assert.equal(aiCell(r).classification, "wiring_failed");
});
test("partial AI application remains candidate-level partial demonstration", () => {
  const r = coverageFixture(), turn = rows(r.trials[0].turns)[1];
  row(row(rows(turn.trace)[0].aiPublic).application).status = "partial";
  assert.equal(aiCell(r).classification, "partial_demonstrated"); assert.equal(aiCell(r).acceptedCandidates, 2);
});
test("last pending and failed pending have different coverage classifications", () => {
  const r = coverageFixture(); r.trials[0].turns = [rows(r.trials[0].turns)[0]];
  assert.equal(aiCell(r).classification, "not_reached");
  row(row(rows(rows(r.trials[0].turns)[0].trace)[0].aiPublic).pending).status = "failed";
  assert.equal(aiCell(r).classification, "wiring_failed");
});
test("a conservative-rejection reason alone never proves correct contract execution", () => {
  const r = coverageFixture(), next = rows(r.trials[0].turns)[1];
  row(rows(next.trace)[0].aiPublic).application = { aiSeq: 2, status: "not_applied", reasons: ["prior_pruned"], claims: [] };
  assert.equal(aiCell(r).classification, "not_reached");
});
test("repair's initial unknown is not an actual next-turn progress evaluation", () => {
  const r = coverageFixture(), turns = rows(r.trials[0].turns);
  rows(turns[0].trace)[0].finalAction = { action: "repair" };
  for (const turn of turns) row(turn.state).repairHistory = [{ turn: 1, progress: "unknown" }];
  const repair = () => coverage(r).cells.find(c => c.path === "repair" && c.turn === 1)!;
  assert.equal(repair().classification, "not_reached");
  rows(row(turns[1].state).repairHistory)[0].progress = "unchanged";
  assert.equal(repair().classification, "live_demonstrated");
});
test("naming ledger cannot replace independent public-agreement judgment", () => {
  const r = fixture(); row(rows(r.trials[0].turns)[0].state).ledger = { status: "agreed", name: "synthetic" };
  assert.equal(coverage(r).cells.find(c => c.path === "naming")!.classification, "not_reached");
});

test("setup failure before cache read is explicitly not_reached with no fabricated validation", () => {
  const r = fixture(), trial = r.trials[0]; trial.failure = "client_setup_failed"; trial.cache = null;
  r.evidence!.cache = [rows(r.evidence!.cache)[0], { trialOrder: 0, status: "not_attempted", reason: "setup_failed:luna_client" }, ...rows(r.evidence!.cache).slice(2)];
  for (const id of ["cache.trial.0", "cache.memo.identity.0", "cache.immutable.0", "cache.receipt.1.validation", "gate.G1"])
    assert.equal(result(r, id).status, "not_reached");
  rows(r.evidence!.cache)[1].validated = true;
  assert.equal(result(r, "cache.receipt.1.memo").status, "mismatch");
});
test("later-trial unknown billing and leaked public text cannot retroactively invalidate smoke gates", () => {
  const r = fixture(); rows(row(r.summary!.budget).sends).find(s => s.provider === "jev" && s.logicalCallId === 8)!.costUsd = null;
  rows(r.trials[2].publicTurns)[1].text = "Bearer synthetic-later-trial-token";
  assert.equal(result(r, "gate.G4").status, "pass");
  assert.equal(result(r, "privacy.public").status, "mismatch");
});
test("warm-up permits three actual POST attempts but rejects a fourth", () => {
  const r = fixture(), post = rows(r.warmup!.http).find(h => h.kind === "completion_post")!;
  (r.warmup!.http as Row[]).push(structuredClone(post), structuredClone(post));
  assert.equal(result(r, "cache.warmup").status, "pass");
  (r.warmup!.http as Row[]).push(structuredClone(post));
  assert.equal(result(r, "cache.warmup").status, "mismatch");
});
test("coverage cannot promote stage-status assertions without actual stage calls", () => {
  const r = coverageFixture(); r.trials[0].calls = rows(r.trials[0].calls).filter(c => c.phase !== "ai_function");
  assert.equal(aiCell(r).classification, "wiring_failed");
});
test("conservative public-window rejection needs independently observable contract facts", () => {
  const r = coverageFixture(), trial = r.trials[0], next = rows(trial.turns)[1]; next.turn = 35;
  row(rows(next.trace)[0].aiPublic).application = { aiSeq: 2, status: "not_applied", reasons: ["source_out_of_window"], claims: [] };
  const events = [{ seq: 1, speaker: "human", text: "initial" }, { seq: 2, speaker: "ai", text: "見てみよう。" },
    ...Array.from({ length: 33 }, (_, i) => ({ seq: i + 3, speaker: "human", text: "synthetic continuation" }))];
  (trial.replay as Row[]).push({ tape: { state: structuredClone(row(next.state)), events } });
  assert.equal(aiCell(r).classification, "conservative_reject");
  row(row(rows(next.trace)[0].aiPublic).application).reasons = ["prior_pruned"];
  assert.equal(aiCell(r).classification, "not_reached");
});
test("reobservation demonstration requires validated result, memo merge and follow-up decision", () => {
  const r = fixture(), trial = r.trials[0], turn = rows(trial.turns)[0], trace = rows(turn.trace)[0];
  trace.decisions = [{ action: "request_observation" }, { action: "describe" }];
  const issue = { aspect: "shape", question: "Which shape?", partnerConstrual: null };
  const figure = { figureId: "own-1", supports: ["synthetic"], contradicts: [], unknown: [] };
  const observedAt = "2026-10-21T00:00:01Z";
  trace.reobservations = [{ result: { observedAt, issue, figures: [figure] } }];
  rows(row(row(turn.state).observationMemo).figures)[0].reobservations = [{ ...figure, issue, observedAt }];
  (trial.calls as Row[]).push({ turn: 1, phase: "observation_targeted", status: "ok", model: "test-luna", requestedModel: "test-luna" });
  const cell = () => coverage(r).cells.find(c => c.path === "reobservation")!;
  assert.equal(cell().classification, "live_demonstrated");
  rows(row(row(turn.state).observationMemo).figures)[0].reobservations = [];
  assert.equal(cell().classification, "not_reached");
});
test("accepted human response links prove only existing-prior wiring", () => {
  const r = fixture(), turn = rows(r.trials[0].turns)[0];
  const records = [{ id: "0:pub1", kind: "claim", speaker: "ai", sourceTurn: 0 },
    { id: "1:local1", kind: "claim", speaker: "human", turn: 1, respondsTo: "0:pub1" }];
  row(row(turn.state).graph).records = records;
  const cell = () => coverage(r).cells.find(c => c.path === "humanResponseLinks")!;
  assert.equal(cell().classification, "live_demonstrated");
  records[1].respondsTo = "unrecorded-prior";
  assert.equal(cell().classification, "wiring_failed");
});
test("all already-sent in-flight calls are listed, not just the last call", () => {
  const r = fixture(), events = rows(r.evidence!.events), first = events.findIndex(e => e.type === "response");
  const response = events.splice(first, 1)[0], secondSend = events.findIndex((e, i) => i > first && e.type === "send");
  const inFlight = [response.sendId, events[secondSend].sendId];
  events.splice(secondSend + 1, 0, { type: "stop", reason: "timeout", scope: "run", at: response.at, inFlight }, response);
  events.forEach((e, i) => { e.seq = i + 1; }); r.evidence!.events = events;
  assert.deepEqual(verifyRecords(r).inFlightAtStops[0].sendIds, inFlight);
  const check = verifyRecords(r).checks.find(c => c.reason === "all_in_flight_at_stop_listed")!;
  assert.equal(check.status, "pass");
  (events.find(e => e.type === "stop")!.inFlight as unknown[]).pop();
  assert.equal(verifyRecords(r).checks.find(c => c.reason === "all_in_flight_at_stop_listed")!.status, "mismatch");
});
test("observed token threshold stops later sends without calling the threshold a hard consumption cap", () => {
  const r = fixture(), events = rows(r.evidence!.events);
  events.find(e => e.type === "response" && e.provider === "luna")!.inputTokens = 1500001;
  assert.ok(verifyRecords(r).checks.some(c => c.reason === "no_send_after_stop_or_threshold" && c.status === "mismatch"));
});
test("a separate policy GET is still forbidden after a run stop", () => {
  const r = fixture(), events = rows(r.evidence!.events), at = events.at(-1)!.at;
  events.push({ seq: events.length + 1, at, type: "stop", scope: "run", reason: "end", inFlight: [] },
    { seq: events.length + 2, at, type: "policy_get", provider: "luna" });
  r.evidence!.events = events;
  assert.ok(verifyRecords(r).checks.some(c => c.reason === "policy_get_separate_and_not_after_stop" && c.status === "mismatch"));
});
test("memo validation flag cannot certify a structurally invalid initial memo", () => {
  const r = fixture(), receipt = rows(r.evidence!.cache)[0];
  rows(row(receipt.memo).figures)[0].region = null;
  assert.equal(result(r, "cache.receipt.0.memo_schema").status, "mismatch");
});

test("file loader uses actual permissions, reads JSONL and verifies CLI with no network", async t => {
  const dir = await mkdtemp(join(tmpdir(), "parity-verify-")); await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = fixture();
  const files: Array<[string, unknown]> = [["run.private.json", r.run], ["summary.private.json", r.summary], ["warmup.private.json", r.warmup],
    ["verifier-evidence.private.json", r.evidence], ...r.trials.map(tr => [`trial-${tr.order}.private.json`, tr] as [string, unknown]),
    ...r.packets!.map(p => [p.name, p.value] as [string, unknown])];
  for (const [name, value] of files) await writeFile(join(dir, name), JSON.stringify(value), { mode: 0o600 });
  await writeFile(join(dir, "billing.private.jsonl"), r.billing!.map(x => JSON.stringify(x)).join("\n") + "\n", { mode: 0o600 });
  assert.deepEqual((await verifyDirectory(dir)).checks.filter(c => c.status === "mismatch"), []);
  await chmod(join(dir, "run.private.json"), 0o644);
  assert.equal(result(await loadRecords(dir), "gate.G3").status, "mismatch");
  const cli = spawnSync(process.execPath, ["dialogue-model/runtime/diagnostics/parity-verify/index.ts", dir], { encoding: "utf8" });
  assert.equal(cli.status, 2); assert.equal(JSON.parse(cli.stdout).status, "mismatch");
});
test("loader rejects symlinks and malformed JSON without disclosing contents", async t => {
  const dir = await mkdtemp(join(tmpdir(), "parity-verify-invalid-")); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "source"), "private-body", { mode: 0o600 }); await symlink(join(dir, "source"), join(dir, "run.private.json"));
  await assert.rejects(loadRecords(dir), /unsafe_or_oversized_record_file/u);
  assert.equal(verifyRecords({ trials: [], run: { value: undefined } }).status, "mismatch");
});
