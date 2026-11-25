// Fixed synthetic producer records; no runtime harness/model/credential imports.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, chmod, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { canonical, hash, profileHash, sha256, loadRecords, verifyDirectory, verifyRecords } from "../dialogue-model/runtime/diagnostics/parity-verify/index.ts";
import type { Records, Row } from "../dialogue-model/runtime/diagnostics/parity-verify/index.ts";
import { row, rows, list } from "../dialogue-model/runtime/diagnostics/parity-verify/core.ts";
import { ledger } from "../dialogue-model/runtime/diagnostics/parity-verify/ledger.ts";
import { coverage } from "../dialogue-model/runtime/diagnostics/parity-verify/coverage.ts";
import { cacheChecks } from "../dialogue-model/runtime/diagnostics/parity-verify/fairness.ts";

const captured: Record<string, Records> = JSON.parse(readFileSync(new URL("./fixtures/parity-verify/producer-records.json", import.meta.url), "utf8"));
const fixture = (scenario = "known"): Records => structuredClone(captured[scenario]);
const report = (r: Records) => verifyRecords(r);
function result(r: Records, id: string) {
  const found = report(r).checks.find(c => c.id === id); assert.ok(found, `missing ${id}`); return found;
}
const pair = (r: Records) => rows(r.evidence!.pairedReplay)[0];
const firstRequest = (r: Records, side = "left", provider = "luna", phase?: string) => rows(row(pair(r)[side]).requests).find(q => q.provider === provider && (!phase || q.phase === phase))!;
const firstTape = (r: Records) => row(rows(r.trials[0].replay)[0].tape);
function lua(r: Records) {
  const tape = firstTape(r), turn = row(rows(tape.events).at(-1)).seq;
  const response = rows(tape.luna).find(e => e.phase === "generation")!;
  const call = rows(r.trials[0].calls).find(c => c.turn === turn && c.phase === "generation")!;
  const index = rows(tape.luna).indexOf(response);
  return { response: row(response.response), call, id: `validation.luna_usage.0.${turn}.${index}` };
}
function jevAnswer(r: Records) { return row(Object.values(row(rows(firstTape(r).jev)[0].answers))[0]); }
function rehashPacket(r: Records, i = 0) { r.packets![i].value.sha256 = hash(r.packets![i].value.prefix); }
function reseal(r: Records, side: string, req: Row) { req.payloadSha256 = hash(req.payload); return req; }
function change(name: string, mutate: (r: Records) => void, id: string) {
  test(name, () => { const r = fixture(); assert.equal(result(r, id).status, "pass"); mutate(r); assert.equal(result(r, id).status, "mismatch"); });
}

test("fixed producer fixture connects nested usage, native full HTTP bodies, images and gates", () => {
  const r = fixture(), v = report(r);
  assert.deepEqual(v.checks.filter(c => c.status === "mismatch"), []);
  assert.ok(v.checks.filter(c => c.id.startsWith("validation.luna_usage.")).length > 0);
  assert.ok(v.checks.filter(c => c.id.startsWith("validation.luna_usage.")).every(c => c.status === "pass"));
  assert.equal(result(r, "replay.0.parity").status, "pass");
  assert.ok(v.checks.some(c => c.reason === "original_image_bytes_not_present_self_reported_hash_is_not_full_proof" && c.status === "not_reached"));
  for (const gate of ["G1", "G2", "G3", "G4"]) assert.equal(result(r, `gate.${gate}`).status, "pass");
  const { response, call } = lua(r); assert.equal(row(response.usage).inputTokens, 10); assert.equal(call.inputTokens, 10);
});
test("fixed producer explicit output limit and real injected retry bind every HTTP attempt", () => {
  const r = fixture("explicit_retry"), v = report(r), budget = row(r.summary!.budget);
  assert.deepEqual(v.checks.filter(c => c.status === "mismatch"), []);
  assert.ok(Number(budget.lunaPosts) > Number(budget.lunaCalls));
  const request = firstRequest(r), maximum = row(row(r.trials[0].profile).lunaRequest).maxCompletionTokens;
  assert.ok(Number.isSafeInteger(maximum)); assert.equal(row(request.payload).max_completion_tokens, maximum);
  assert.ok(v.checks.some(c => c.reason === "each_actual_post_and_retry_bound_to_full_http_hash" && c.status === "pass"));
  assert.ok(v.checks.some(c => c.reason === "exact_luna_body_keys_purpose_explicit_limit" && c.status === "pass"));
});
function explicitRetry() {
  const r = fixture("explicit_retry"), trial = r.trials.find(t => rows(t.calls).some(c => c.id === 8))!;
  const call = rows(trial.calls).find(c => c.id === 8)!;
  const receipts = rows(trial.http).filter(h => h.kind === "completion_post" && h.callId === call.id);
  const pairIndex = rows(r.evidence!.pairedReplay).findIndex(p => p.trialOrder === trial.order && p.turn === call.turn);
  const replay = rows(trial.replay).find(e => row(rows(row(e.tape).events).at(-1)).seq === call.turn)!;
  const requestIndex = rows(row(replay.tape).expectedRequests).findIndex(q => list(q.sendIds).includes(8));
  assert.deepEqual(call.sendIds, [8, 9]); assert.deepEqual(receipts.map(h => h.sendId), [8, 9]);
  return { r, call, receipts, id: `replay.${pairIndex}.left.${requestIndex}.actual_http` };
}
test("POSTAUDIT-17: one duplicated receipt ID cannot cover two actual retry sends", () => {
  const { r, call, receipts, id } = explicitRetry(); assert.equal(result(r, id).status, "pass");
  const budget = hash(r.summary!.budget), tape = hash(r.trials.map(t => t.replay));
  receipts[1].sendId = 8; // Sole corruption: receipt [8,9] -> [8,8].
  assert.deepEqual(receipts.map(h => h.sendId), [8, 8]); assert.deepEqual(call.sendIds, [8, 9]);
  assert.equal(hash(r.summary!.budget), budget); assert.equal(hash(r.trials.map(t => t.replay)), tape);
  assert.equal(result(r, id).status, "mismatch"); assert.equal(result(r, "replay.http_receipts").status, "mismatch");
});
test("POSTAUDIT-17: unmatched ID within an owned call is retained and rejected", () => {
  const { r, receipts, id } = explicitRetry(); receipts[1].sendId = 999999;
  assert.equal(result(r, id).status, "mismatch"); assert.equal(result(r, "replay.http_receipts").status, "mismatch");
});
test("POSTAUDIT-17: wholly unmatched receipt cannot disappear through per-request filtering", () => {
  const { r, receipts } = explicitRetry(), trial = r.trials.find(t => rows(t.calls).some(c => c.id === 8))!;
  (trial.http as Row[]).push({ ...receipts[1], callId: 999999, sendId: 999999 });
  assert.equal(result(r, "replay.http_receipts").status, "mismatch");
});
test("POSTAUDIT-17: correct send ID with wrong call ownership is rejected", () => {
  const { r, receipts, id } = explicitRetry(); receipts[1].callId = 999999;
  assert.equal(result(r, id).status, "mismatch"); assert.equal(result(r, "replay.http_receipts").status, "mismatch");
});

test("independent canonical JSON and SHA use fixed vectors and preserve array order", () => {
  assert.equal(canonical({ z: [2, 1], a: { c: false, b: "日本語" } }), '{"a":{"b":"日本語","c":false},"z":[2,1]}');
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(hash({ a: 2, b: 1 }), hash({ b: 1, a: 2 })); assert.notEqual(hash([1, 2]), hash([2, 1]));
  assert.equal(profileHash({ feature: true, label: "a" }), profileHash({ feature: true, label: "b" }));
  for (const v of [undefined, NaN, Infinity, new Date(), [undefined], new Array(1)]) assert.throws(() => canonical(v));
});
for (const scenario of ["input_missing", "both_missing"]) test(`real producer nested usage preserves ${scenario}`, () => {
  const r = fixture(scenario), { response, call, id } = lua(r);
  assert.equal(result(r, id).status, "pass"); assert.equal(row(response.usage).inputTokens, null); assert.equal(call.inputTokens, null);
  assert.deepEqual(report(r).checks.filter(c => c.status === "mismatch"), []);
  assert.ok(Number(report(r).totals.unknownInputTokens) > 0);
  if (scenario === "input_missing") { assert.equal(row(response.usage).outputTokens, 2); assert.equal(call.outputTokens, 2); }
  else { assert.equal(row(response.usage).outputTokens, null); assert.equal(call.outputTokens, null); }
});
test("known nested usage cannot be downgraded to null or hidden by flat values", () => {
  const r = fixture(), { response, call, id } = lua(r); call.inputTokens = null; response.inputTokens = null;
  assert.equal(row(response.usage).inputTokens, 10); assert.equal(result(r, id).status, "mismatch");
});

for (const confidence of [2, -0.1, "0.5", {}, []]) test(`Jev confidence rejects native-contract invalid ${JSON.stringify(confidence)}`, () => {
  const r = fixture(); jevAnswer(r).confidence = confidence; assert.equal(result(r, "gate.G2").status, "mismatch");
});
for (const confidence of [undefined, null, 0, 0.5, 1]) test(`Jev confidence permits native-contract value ${confidence}`, () => {
  const r = fixture(), answer = jevAnswer(r); if (confidence === undefined) delete answer.confidence; else answer.confidence = confidence;
  assert.equal(result(r, "gate.G2").status, "pass");
});
test("probabilities do not gain a new sum-to-one rule", () => {
  const r = fixture(), values = row(jevAnswer(r).probabilities); for (const k of Object.keys(values)) values[k] = 0.8;
  assert.equal(result(r, "gate.G2").status, "pass");
});

change("PV-3 rejects private fields at packet top level", r => { r.packets![0].value.privateTrace = { plan: "synthetic" }; }, "records.packet.0");
change("PV-3 rejects private fields in a prefix event even with a recomputed hash", r => { rows(r.packets![0].value.prefix)[0].targets = ["own-1"]; rehashPacket(r); }, "records.packet.0");
change("PV-3 rejects a rehashed future turn", r => { (r.packets![0].value.prefix as Row[]).push({ speaker: "ai", turn: 99, text: "synthetic future" }); rehashPacket(r); }, "records.packet.0");
change("PV-3 rejects duplicated turns", r => { (r.packets![0].value.prefix as Row[]).push(structuredClone(rows(r.packets![0].value.prefix)[0])); rehashPacket(r); }, "records.packet.0");
change("PV-3 rejects non-public speaker", r => { rows(r.packets![0].value.prefix)[0].speaker = "system"; rehashPacket(r); }, "records.packet.0");
change("PV-3 rejects another trial's recorded utterance", r => {
  const other = rows(r.trials[1].publicTurns).find(e => e.seq === 3)!;
  assert.notEqual(other.text, rows(r.packets![0].value.prefix)[0].text);
  rows(r.packets![0].value.prefix)[0].text = other.text; rehashPacket(r);
}, "records.packet.0");
change("PV-3 binds filename checkpoint to prefix", r => { r.packets![0].name = "public-0-99.packet.json"; }, "records.packet.0");
test("PV-3 reversed order and duplicate checkpoint files are contradictions", () => {
  const r = fixture(), i = r.packets!.findIndex(p => p.name === "public-0-2.packet.json");
  r.packets![i].value.prefix = rows(r.packets![i].value.prefix).reverse(); rehashPacket(r, i);
  assert.equal(result(r, `records.packet.${i}`).status, "mismatch");
  const other = fixture(); other.packets!.push(structuredClone(other.packets![0]));
  assert.equal(result(other, `records.packet.${other.packets!.length - 1}`).status, "mismatch");
});
test("PV-3 incomplete public evidence is not_reached, while known contradiction stays mismatch", () => {
  const r = fixture(); delete r.trials[0].publicTurns; r.trials[0].replay = []; r.trials[0].turns = [];
  assert.equal(result(r, "records.packet.0").status, "not_reached");
  const other = fixture(); rows(other.trials[0].publicTurns)[0].text = "contradictory recorded public event";
  assert.equal(result(other, "records.packet.0").status, "mismatch");
});
change("PV-3 malformed packet also fails the storage gate", r => { r.packets![0].value.privateTrace = {}; }, "gate.G3");

// Minimal event sequences test stop semantics, with native records retained separately.
function timeline(items: Row[]) { return items.map((e, i) => ({ seq: i + 1, at: "2026-10-21T00:00:00.000Z", ...e })); }
function ctx(provider: "luna" | "jev", callId: number, instanceId = `${provider}-unit`): Row {
  return { provider, callId, instanceId, trialOrder: 0, label: "repair-first", phase: provider === "luna" ? "generation" : "decision", requestedModel: "synthetic" };
}
function send(context: Row, sendId: number): Row[] { return [{ ...context, type: "reserve", sendId }, { ...context, type: "send", sendId }]; }
function response(context: Row, sendId: number, cost: number | null = 0.001): Row {
  return { ...context, type: "response", sendId, status: "ok", model: "synthetic", ...(context.provider === "jev" ? { costUsd: cost } : { inputTokens: 1, outputTokens: 1 }) };
}
function account(items: Row[], r = fixture()) { r.evidence!.events = timeline(items); return ledger(r); }
function stopStatus(items: Row[], r = fixture()) { return account(items, r).checks.find(c => c.id === "ledger.stop_discipline")!.status; }
const stop = (scope: string, ids: number[], fields: Row = {}): Row => ({ type: "stop", scope, inFlight: ids, reason: "phase_aborted", ...fields });

test("PV-4 unresolved sent Jev logical abort requires run scope before other-instance sends/commit", () => {
  const a = ctx("jev", 1), b = ctx("jev", 2, "different-jev");
  const items = [...send(a, 1), stop("instance", [1], { ...a, scopeDetail: "logical_call" }), ...send(b, 2), response(b, 2), { type: "commit", trialOrder: 0 }, response(a, 1)];
  const v = account(items); assert.equal(v.checks.find(c => c.id === "ledger.stop_discipline")!.status, "mismatch");
  assert.ok(v.checks.some(c => c.reason === "no_new_work_before_required_run_stop" && c.status === "mismatch"));
});
test("PV-4 omitted run stop stays a violation even if late billing becomes known", () => {
  const a = ctx("jev", 1); const items = [...send(a, 1), { ...response(a, 1, null), status: "unknown" }, response(a, 1)];
  assert.equal(stopStatus(items), "mismatch");
  assert.ok(account(items).checks.some(c => c.reason === "fact_derived_run_stop_recorded" && c.status === "mismatch"));
});
test("PV-4 native sent-abort evidence prevents a missing abort event from hiding obligation", () => {
  const r = fixture(), c = rows(r.trials[0].calls).find(c => c.provider === "jev")!;
  c.status = "error"; c.error = "aborted"; c.costUsd = null;
  const a = ctx("jev", Number(c.id)), sid = Number(list(c.sendIds)[0]);
  assert.equal(stopStatus([...send(a, sid), { type: "commit", trialOrder: 0 }, response(a, sid)], r), "mismatch");
});
test("PV-4 proper run stop allows late known billing without dialogue commit", () => {
  const a = ctx("jev", 1);
  assert.equal(stopStatus([...send(a, 1), stop("run", [1]), stop("instance", [1], { ...a, scopeDetail: "logical_call" }), response(a, 1)]), "pass");
});
function producerAbortOrder(): Row[] {
  const a = ctx("jev", 1);
  return [...send(a, 1), stop("instance", [1], { ...a, scopeDetail: "logical_call" }),
    { ...response(a, 1, null), status: "unknown" }, stop("run", [1], { reason: "jev_cost_unknown" }), response(a, 1)];
}
test("parent8054: real 225122d descriptive-abort / unknown / run-stop order passes", () => {
  const v = account(producerAbortOrder()); assert.equal(v.checks.find(c => c.id === "ledger.stop_discipline")!.status, "pass");
  const obligations = rows(v.totals.stopObligations); assert.ok(obligations.length > 0);
  assert.ok(obligations.every(o => Number(o.runStopSeq) >= Number(o.seq)));
});
for (const kind of ["reserve", "complete", "send", "commit", "policy_get"]) test(`parent8054: one ${kind} before run-stop acknowledgment fails`, () => {
  const items = producerAbortOrder(), b = ctx(kind === "complete" || kind === "policy_get" ? "luna" : "jev", 2, "other-instance");
  if (kind === "send") items.splice(2, 0, { ...b, type: "reserve", sendId: 2 });
  const index = items.findIndex(e => e.type === "stop" && e.scope === "instance");
  const work = kind === "commit" ? { type: kind, trialOrder: 0 } : { ...b, type: kind, ...(kind === "reserve" || kind === "send" ? { sendId: 2 } : {}) };
  items.splice(index + 1, 0, work);
  if (kind === "send") { items.find(e => e.type === "stop" && e.scope === "run")!.inFlight = [1, 2]; items.push(response(b, 2)); }
  const v = account(items); assert.equal(v.checks.find(c => c.id === "ledger.stop_discipline")!.status, "mismatch");
  assert.ok(v.checks.some(c => c.reason === "no_new_work_before_required_run_stop" && c.status === "mismatch"));
});
test("parent8054: deleting run stop is a violation even with late known billing", () => {
  const items = producerAbortOrder().filter(e => !(e.type === "stop" && e.scope === "run"));
  assert.equal(stopStatus(items), "mismatch");
  assert.ok(account(items).checks.some(c => c.reason === "fact_derived_run_stop_recorded" && c.status === "mismatch"));
});
test("parent8054: unrelated response is not contiguous same-send bookkeeping", () => {
  const a = ctx("jev", 1), b = ctx("jev", 2, "other-instance");
  const items = [...send(a, 1), ...send(b, 2), stop("instance", [1], { ...a, scopeDetail: "logical_call" }), response(b, 2),
    { ...response(a, 1, null), status: "unknown" }, stop("run", [1]), response(a, 1)];
  const v = account(items); assert.equal(v.checks.find(c => c.id === "ledger.stop_discipline")!.status, "mismatch");
  assert.ok(v.checks.some(c => c.reason === "only_same_send_bookkeeping_before_run_stop" && c.status === "mismatch"));
});
test("PV-4 pre-send Jev refusal has no unknown-charge stop obligation", () => {
  const a = ctx("jev", 1), b = ctx("jev", 2, "different-jev");
  assert.equal(stopStatus([{ ...a, type: "refused", reason: "phase_aborted" }, ...send(b, 2), response(b, 2), { type: "commit", trialOrder: 0 }]), "pass");
});
test("PV-4 billed Jev cleanup abort stops only that logical call", () => {
  const a = ctx("jev", 1), b = ctx("jev", 2);
  assert.equal(stopStatus([...send(a, 1), response(a, 1), stop("instance", [], { ...a, scopeDetail: "logical_call" }), ...send(b, 2), response(b, 2), { type: "commit", trialOrder: 0 }]), "pass");
});
test("PV-4 Luna logical abort does not permanently stop a reusable client", () => {
  const a = ctx("luna", 1), b = ctx("luna", 2);
  const items = [{ ...a, type: "complete" }, ...send(a, 1), stop("instance", [1], { ...a, scopeDetail: "logical_call" }),
    { ...b, type: "complete" }, ...send(b, 2), response(b, 2), response(a, 1), { type: "commit", trialOrder: 0 }];
  assert.equal(stopStatus(items), "pass");
  assert.equal(stopStatus(items.map(e => { const copy = { ...e }; delete copy.scopeDetail; return copy; })), "mismatch");
});
for (const provider of ["jev", "luna"] as const) test(`PV-4 ${provider} threshold applies directly to commit with missing stop`, () => {
  const r = fixture(), c = ctx(provider, 1); row(row(r.run!.manifest).caps)[provider === "jev" ? "jevUsd" : "lunaTokens"] = provider === "jev" ? 0.001 : 2;
  const items = [...(provider === "luna" ? [{ ...c, type: "complete" }] : []), ...send(c, 1), response(c, 1), { type: "commit", trialOrder: 0 }];
  const v = account(items, r); assert.equal(v.checks.find(c => c.id === "ledger.stop_discipline")!.status, "mismatch");
  assert.ok(v.checks.some(c => c.reason === "no_commit_after_stop_or_threshold" && c.status === "mismatch"));
});
test("PV-4 all in-flight calls and later consumption remain visible; revisions counted once", () => {
  const a = ctx("luna", 1), b = ctx("luna", 2), items = [{ ...a, type: "complete" }, ...send(a, 1), { ...b, type: "complete" }, ...send(b, 2), stop("run", [1, 2]), response(a, 1), response(b, 2), response(a, 1)];
  const v = account(items); assert.equal(v.checks.find(c => c.id === "ledger.stop_discipline")!.status, "pass");
  assert.deepEqual(v.inFlightAtStops[0].sendIds, [1, 2]); assert.equal(v.totals.latestKnownLunaTokens, 4);
  assert.equal(v.inFlightAtStops[0].calls![0].knownInputTokensAtStop, null); assert.equal(v.inFlightAtStops[0].calls![0].latestKnownInputTokens, 1);
  const partial = structuredClone(items); (partial.find(e => e.type === "stop")!.inFlight as number[]).pop(); assert.equal(stopStatus(partial), "mismatch");
});
test("Jev instance .05 predicted-spend rule is distinct from final overshoot", () => {
  const a = ctx("jev", 1), b = ctx("jev", 2);
  assert.equal(stopStatus([...send(a, 1), response(a, 1, 0.03), ...send(b, 2), response(b, 2)]), "mismatch");
  assert.equal(stopStatus([...send(a, 1), response(a, 1, 0.06)]), "pass");
});

test("PV-2 projected image body has an independent hash and a separately bound original hash", () => {
  const r = fixture(), req = firstRequest(r, "left", "luna", "observation_targeted");
  assert.ok(req); assert.notEqual(req.payloadSha256, req.preProjectionPayloadSha256);
  const v = report(r); assert.ok(v.checks.some(c => c.reason === "post_projection_canonical_payload_sha256" && c.status === "pass"));
  assert.ok(v.checks.some(c => c.reason === "original_image_bytes_not_present_self_reported_hash_is_not_full_proof" && c.status === "not_reached"));
});
test("PV-2 changing both projected image bodies is detected against the frozen own image", () => {
  const r = fixture();
  for (const side of ["left", "right"]) {
    const req = firstRequest(r, side, "luna", "observation_targeted"), image = rows(row(req.payload).messages).flatMap(m => rows(m.content)).find(p => p.type === "image_url")!;
    row(row(image.image_url).url).byteSha256 = hash("different image bytes"); reseal(r, side, req);
  }
  assert.ok(report(r).checks.some(c => c.reason === "only_enumerated_own_image_url_projection" && c.status === "mismatch"));
});
test("PV-2 changing one model-facing field cannot be normalized away", () => {
  const r = fixture(), req = firstRequest(r, "right"); row(req.payload).label = "model-visible"; reseal(r, "right", req);
  assert.equal(result(r, "replay.0.parity").status, "mismatch");
  assert.ok(report(r).checks.some(c => c.reason === "exact_luna_body_keys_purpose_explicit_limit" && c.status === "mismatch"));
});
test("PV-2 only the fixed top-level envelope metadata list may differ", () => {
  const r = fixture(), req = firstRequest(r, "right"); req.label = "measurement-label"; req.startedAt = "measurement-time";
  assert.equal(result(r, "replay.0.parity").status, "pass");
  const other = fixture(); other.evidence!.normalizedEnvelopeFields = [...list(other.evidence!.normalizedEnvelopeFields), "temperature"];
  assert.equal(result(other, "replay.normalization").status, "mismatch");
});
test("PV-2 changing original HTTP, complete-message or injected-POST domains is detected separately", () => {
  for (const field of ["preProjectionPayloadSha256", "completeMessagesSha256"]) {
    const r = fixture(); firstRequest(r)[field] = hash("wrong hash domain");
    assert.ok(report(r).checks.some(c => c.reason === (field === "preProjectionPayloadSha256" ? "pre_projection_hash_association_to_recorded_http" : "complete_messages_diagnostic_association_only") && c.status === "mismatch"));
  }
  const r = fixture(); rows(r.trials[0].http).find(h => h.kind === "completion_post")!.requestSha256 = hash("wrong actual HTTP body");
  assert.ok(report(r).checks.some(c => c.reason === "each_actual_post_and_retry_bound_to_full_http_hash" && c.status === "mismatch"));
});
test("PV-2 moving projection to a non-image subtree does not grant a new normalization", () => {
  const r = fixture(), req = firstRequest(r, "right"); row(req.payload).messages = [{ role: "user", content: row(row(row(pair(r).right).material).own).ownImage }]; reseal(r, "right", req);
  assert.ok(report(r).checks.some(c => c.reason === "only_enumerated_own_image_url_projection" && c.status === "mismatch"));
});
test("different upstream materials are not comparable; absent raw proof remains not_reached", () => {
  const r = fixture(), side = row(pair(r).right); row(side.material).state = { graph: { records: [] }, syntheticDifference: true }; side.materialSha256 = hash(side.material);
  assert.equal(result(r, "replay.0.parity").status, "not_comparable");
  const absent = fixture(); delete absent.evidence; assert.equal(result(absent, "replay.prewire").status, "not_reached");
});

change("profile corruption is detected", r => { row(r.trials[0].profile).referenceMemory = false; }, "identity.profile.2");
change("memo SHA corruption is detected", r => { rows(r.evidence!.cache)[1].memoSha256 = hash("wrong memo"); }, "cache.receipt.1.memo");
change("cache file mutation is detected", r => { rows(r.evidence!.cache)[1].afterSha256 = hash("changed cache bytes"); }, "cache.immutable.0");
change("known usage totals are independently recomputed", r => { row(r.summary!.budget).observedInputTokens = 0; }, "ledger.total.observedInputTokens");
change("unknown Luna USD cannot become zero", r => { row(r.summary!.budget).lunaCostUsd = 0; }, "ledger.unknown_cost");
test("setup failure before cache read remains not_reached without fabricated HIT", () => {
  const r = fixture(), trial = r.trials[0]; trial.failure = "client_setup_failed"; trial.cache = null;
  r.evidence!.cache = rows(r.evidence!.cache).map(c => c.trialOrder === 0 ? { trialOrder: 0, status: "not_attempted", reason: "setup_failed:luna_client" } : c);
  assert.equal(result(r, "cache.trial.0").status, "not_reached"); assert.equal(result(r, "cache.immutable.0").status, "not_reached");
});
test("technical coverage and naming semantics stay separate", () => {
  const r = fixture(), cells = coverage(r).cells;
  assert.ok(cells.some(c => c.path === "naming" && c.classification === "not_reached"));
  assert.ok(cells.every(c => c.qualification === "mock_only"));
});
const aiCell = (r: Records) => coverage(r).cells.find(c => c.trialOrder === 0 && c.path === "aiPublic" && c.turn === 1)!;
test("producer AI coverage requires real stages, commit and next graph application", () => {
  const r = fixture(); assert.equal(aiCell(r).classification, "live_demonstrated");
  const trace = rows(rows(r.trials[0].turns)[0].trace).find(t => t.status === "committed")!;
  row(row(trace.aiPublic).stages).ai_function = { status: "error" };
  assert.equal(aiCell(r).classification, "wiring_failed");
});
test("producer partial application remains candidate-level partial demonstration", () => {
  const r = fixture(), next = rows(r.trials[0].turns)[1];
  row(row(rows(next.trace).find(t => t.status === "committed")!.aiPublic).application).status = "partial";
  assert.equal(aiCell(r).classification, "partial_demonstrated");
});
test("producer final pending and failed pending remain different coverage classes", () => {
  const r = fixture(); r.trials[0].turns = [rows(r.trials[0].turns)[0]];
  assert.equal(aiCell(r).classification, "not_reached");
  row(row(rows(rows(r.trials[0].turns)[0].trace).find(t => t.status === "committed")!.aiPublic).pending).status = "failed";
  assert.equal(aiCell(r).classification, "wiring_failed");
});
test("producer rejection reason alone cannot certify a conservative contract", () => {
  const r = fixture(), next = rows(r.trials[0].turns)[1];
  row(rows(next.trace).find(t => t.status === "committed")!.aiPublic).application = { aiSeq: 2, status: "not_applied", reasons: ["prior_pruned"], claims: [] };
  assert.equal(aiCell(r).classification, "not_reached");
});
test("restored boundary: warm-up zero POST is rejected; three allowed and four rejected", () => {
  const r = fixture(), warmup = (data: Records) => cacheChecks(data).find(c => c.id === "cache.warmup")!;
  assert.equal(warmup(r).status, "pass");
  const post = rows(r.warmup!.http).find(h => h.kind === "completion_post")!;
  const policies = rows(r.warmup!.http).filter(h => h.kind !== "completion_post");
  r.warmup!.http = policies; assert.equal(warmup(r).status, "mismatch");
  // Scope is the existing cache warm-up count gate, independently of ledger/receipt checks.
  r.warmup!.http = [...policies, ...[1, 2, 3].map(sendId => ({ ...post, sendId }))];
  assert.equal(warmup(r).status, "pass");
  (r.warmup!.http as Row[]).push({ ...post, sendId: 4 }); assert.equal(warmup(r).status, "mismatch");
});
test("restored boundary: validated flag cannot certify a structurally invalid initial memo", () => {
  const r = fixture(), receipt = rows(r.evidence!.cache)[0];
  assert.equal(receipt.validated, true); assert.equal(result(r, "cache.receipt.0.memo_schema").status, "pass");
  rows(row(receipt.memo).figures)[0].region = null;
  assert.equal(receipt.validated, true); assert.equal(result(r, "cache.receipt.0.memo_schema").status, "mismatch");
});
test("restored boundary: later main-trial unknown billing and leakage cannot retroactively fail smoke G4", () => {
  const r = fixture(), later = r.trials.at(-1)!, smoke = r.trials[0];
  assert.equal(later.stage, "main"); const c = rows(later.calls).find(c => c.provider === "jev")!, id = list(c.sendIds)[0];
  assert.ok(!rows(row(smoke.budget).sends).some(s => s.id === id));
  assert.equal(result(r, "gate.G4").status, "pass");
  rows(row(r.summary!.budget).sends).find(s => s.id === id)!.costUsd = null;
  assert.ok(Number(report(r).totals.unknownJevCosts) > 0); assert.equal(result(r, "gate.G4").status, "pass");
  rows(later.publicTurns)[0].text = "Bearer synthetic-later-trial-token";
  assert.equal(result(r, "privacy.public").status, "mismatch"); assert.equal(result(r, "gate.G4").status, "pass");
});
test("restored boundary: conservative public-window rejection needs actual exclusion facts", () => {
  const r = fixture(), trial = r.trials[0], next = rows(trial.turns)[1];
  const trace = rows(next.trace).find(t => t.status === "committed")!, tape = row(rows(trial.replay)[1].tape);
  const original = rows(tape.events); assert.equal(original.at(-1)!.seq, 3);
  row(trace.aiPublic).application = { aiSeq: 2, status: "not_applied", reasons: ["source_out_of_window"], claims: [] };
  const extended = [...original, ...Array.from({ length: 32 }, (_, i) => ({ seq: i + 4, speaker: (i + 4) % 2 ? "human" : "ai", text: "synthetic public window continuation" }))];
  tape.events = extended; next.turn = 35;
  assert.ok(!rows(tape.events).slice(-32).some(e => e.seq === 2 && e.speaker === "ai"));
  assert.equal(aiCell(r).classification, "conservative_reject");
  tape.events = extended.slice(0, 31); next.turn = 31;
  assert.ok(rows(tape.events).slice(-32).some(e => e.seq === 2 && e.speaker === "ai"));
  assert.deepEqual(row(row(trace.aiPublic).application).reasons, ["source_out_of_window"]);
  assert.equal(aiCell(r).classification, "not_reached");
});
test("restored boundary: accepted human response link needs its antecedent claim to exist", () => {
  const r = fixture(), next = rows(r.trials[0].turns)[1], graph = row(row(next.state).graph);
  const antecedent = rows(graph.records).find(c => c.kind === "claim" && c.speaker === "ai" && Number(c.sourceTurn) < Number(next.turn))!;
  assert.ok(antecedent);
  (graph.records as Row[]).push({ id: "synthetic-human-response", kind: "claim", speaker: "human", turn: next.turn, sourceTurn: next.turn, respondsTo: antecedent.id });
  const cell = () => coverage(r).cells.find(c => c.trialOrder === 0 && c.path === "humanResponseLinks" && c.turn === next.turn)!;
  assert.equal(cell().classification, "live_demonstrated");
  graph.records = rows(graph.records).filter(c => c.id !== antecedent.id);
  assert.equal(cell().classification, "wiring_failed");
});
test("stage-status assertions without actual producer calls cannot establish AI coverage", () => {
  const r = fixture(); r.trials[0].calls = rows(r.trials[0].calls).filter(c => !(c.turn === 1 && c.phase === "ai_function"));
  assert.equal(aiCell(r).classification, "wiring_failed");
});
test("repair initial unknown does not prove that progress was evaluated", () => {
  const r = fixture(), turns = rows(r.trials[0].turns);
  rows(turns[0].trace).find(t => t.status === "committed")!.finalAction = { action: "repair" };
  for (const turn of turns) row(turn.state).repairHistory = [{ turn: 1, progress: "unknown" }];
  const cell = () => coverage(r).cells.find(c => c.trialOrder === 0 && c.turn === 1 && c.path === "repair")!;
  assert.equal(cell().classification, "not_reached");
  rows(row(turns[1].state).repairHistory)[0].progress = "unchanged";
  assert.equal(cell().classification, "live_demonstrated");
});
test("producer reobservation requires an actual merge and follow-up decision", () => {
  const r = fixture(), turn = rows(r.trials[0].turns)[0];
  const cell = () => coverage(r).cells.find(c => c.trialOrder === 0 && c.turn === 1 && c.path === "reobservation")!;
  assert.equal(cell().classification, "live_demonstrated");
  for (const figure of rows(row(row(turn.state).observationMemo).figures)) figure.reobservations = [];
  assert.equal(cell().classification, "not_reached");
});
change("producer trial MISS cannot masquerade as cached initial observation", r => { row(r.trials[0].cache).status = "MISS"; }, "cache.trial.0");
change("producer duplicate send IDs are detected", r => { rows(row(r.summary!.budget).sends)[1].id = 1; }, "ledger.ids");
change("non-observation image remains a boundary failure", r => { rows(r.trials[0].calls).find(c => c.provider === "jev")!.imageCount = 1; }, "identity.images");
change("public credential-shaped text remains a leak failure", r => { rows(r.trials[0].publicTurns)[0].text = "Bearer synthetic-private-token"; }, "privacy.public");

test("file loader and CLI verify the frozen record files with actual private permissions", async t => {
  const dir = await mkdtemp(join(tmpdir(), "parity-verify-")); await chmod(dir, 0o700); t.after(() => rm(dir, { recursive: true, force: true }));
  const r = fixture(), files: Array<[string, unknown]> = [["run.private.json", r.run], ["summary.private.json", r.summary], ["warmup.private.json", r.warmup],
    ["verifier-evidence.private.json", r.evidence], ...r.trials.map(tr => [`trial-${tr.order}.private.json`, tr] as [string, unknown]), ...r.packets!.map(p => [p.name, p.value] as [string, unknown])];
  for (const [name, value] of files) await writeFile(join(dir, name), JSON.stringify(value), { mode: 0o600 });
  await writeFile(join(dir, "billing.private.jsonl"), r.billing!.map(x => JSON.stringify(x)).join("\n") + "\n", { mode: 0o600 });
  assert.deepEqual((await verifyDirectory(dir)).checks.filter(c => c.status === "mismatch"), []);
  await chmod(join(dir, "run.private.json"), 0o644); assert.equal(result(await loadRecords(dir), "gate.G3").status, "mismatch");
  const cli = spawnSync(process.execPath, ["dialogue-model/runtime/diagnostics/parity-verify/index.ts", dir], { encoding: "utf8" });
  assert.equal(cli.status, 2); assert.equal(JSON.parse(cli.stdout).status, "mismatch");
});
test("loader rejects symlinks and malformed input without exposing record contents", async t => {
  const dir = await mkdtemp(join(tmpdir(), "parity-verify-invalid-")); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "source"), "synthetic private body", { mode: 0o600 }); await symlink(join(dir, "source"), join(dir, "run.private.json"));
  await assert.rejects(loadRecords(dir), /unsafe_or_oversized_record_file/u); assert.equal(verifyRecords({ trials: [], run: { value: undefined } }).status, "mismatch");
});
