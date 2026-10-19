// Synthetic public utterances and injected local models only. No external API.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDialogueV2 } from "../dialogue-model/runtime/v2/dialogue-v2.mjs";
import { createNamingTaskV2 } from "../dialogue-model/runtime/v2/naming-task-v2.mjs";
import { createHumanMessageQueue } from "../dialogue-model/runtime/web/human-message-queue.mjs";
import type { LocalGroundingOptions, LocalSegmentProposal, LocalClassificationInput } from "../dialogue-model/runtime/local-grounding/contract.ts";

const ids = Array.from({ length: 6 }, (_, i) => `s-000${i + 1}`);
const anchors = ids.map((id, x) => ({ id, bbox: { x, y: 0, w: 1, h: 1 }, centroid: { x, y: 0 } }));
const image = { mimeType: "image/png", base64: "c3ludGhldGlj" };
const utterance = "四角い部分があります";
const events = [{ id: "event-1", seq: 1, speaker: "human", text: utterance }];
const core = { action: "accept", targetSlot: null, candidateName: null, discriminatingFeature: null, note: null };
const reference = (slot: string) => ({ slots: [slot], epistemic: "grounded", intent: "feature_assertion",
  feature: { slot, feature: "四角い部分", polarity: "confirmed" }, nameAcceptance: null, deferSlot: null, revisitSlot: null });
const segment = (slot: string, quote = utterance): LocalSegmentProposal => ({ segmentId: "s1", quote, targets: [slot],
  aspect: "part", proposition: "四角い部分がある", name: null, linkedIssueId: null, respondsToTurn: null });
const options = (): LocalGroundingOptions => ({
  extractor: { async extract(input) { return [segment(input.ownSlots[0], input.publicTurns.at(-1)!.text)]; } },
  classifier: { async classify(input) { return input.segments.map(s => ({ segmentId: s.segmentId, act: "assert", respondsToClaimId: null, rawScore: 0.01 })); } },
});
function harness(extra: Record<string, unknown> = {}) {
  const calls: unknown[] = [];
  const client = { async complete(messages: unknown, request: unknown) { calls.push({ messages, request }); return { text: "そう見えるんですね。" }; } };
  const judge = { async judge(input: { ownLedger: Record<string, unknown> }) { return { ...core, reference: reference(Object.keys(input.ownLedger)[0]) }; } };
  const dialogue = createDialogueV2({ client, judge, image, anchors, strategy: "repair-first", referenceMemory: true, ...extra } as any);
  const initial = dialogue.initialPrivateState();
  const run = (input: Record<string, unknown> = {}) => dialogue.runAiTurn({ events, privateState: initial, lastEventId: "event-1", ...input });
  return { dialogue, initial, calls, run, client, judge };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("local grounding omitted and null keep requests, private state and traces byte identical", async () => {
  const implicit = harness(), explicit = harness({ localGrounding: null });
  const a = await implicit.run(), b = await explicit.run();
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(JSON.stringify(implicit.calls), JSON.stringify(explicit.calls));
  assert.equal(JSON.stringify(implicit.dialogue.getAttempts()), JSON.stringify(explicit.dialogue.getAttempts()));
  // Captured from the pre-integration e06b04e implementation with this synthetic
  // fixture: guards the request, output state and trace bytes, not just null's alias.
  const bytes = JSON.stringify({ result: a, calls: implicit.calls, attempts: implicit.dialogue.getAttempts() });
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "9e7bdb6acab26c266a2bcf8a33f838acff172815f15b6c2964a7be524b88a442");
  assert.ok(!JSON.stringify(implicit.dialogue.getAttempts()).includes("localGrounding"));
  assert.ok(!JSON.stringify(implicit.calls).includes("局所問題の作業メモ"));
});

test("options require reference memory and validate both local functions and a positive finite timeout", () => {
  assert.throws(() => harness({ localGrounding: options(), referenceMemory: false }), /requires reference memory/);
  for (const value of [{}, { extractor: {} }, { ...options(), classifier: {} },
    ...[0, -1, NaN, Infinity, null, "20"].map(timeoutMs => ({ ...options(), timeoutMs }))]) {
    assert.throws(() => harness({ localGrounding: value }), /Invalid local grounding/);
  }
  harness({ localGrounding: { ...options(), timeoutMs: 0.5 } });
  harness({ localGrounding: { ...options(), timeoutMs: Number.MAX_VALUE } });
});

test("claims join existing mention/feature operations only in the returned detached state", async () => {
  const h = harness({ localGrounding: options() });
  const before = JSON.stringify(h.initial);
  const result = await h.run();
  assert.equal(JSON.stringify(h.initial), before);
  assert.deepEqual(result.privateState.graph.records.map((r: any) => r.kind), ["mention", "feature", "claim"]);
  const trace = h.dialogue.getAttempts()[0].localGrounding;
  assert.equal(trace.status, "ok"); assert.equal(trace.segments, 1); assert.equal(trace.accepted, 1);
  assert.deepEqual(trace.rejected, []);
  assert.ok(JSON.stringify(h.calls).includes("1:local1"), "generation sees the current staged issue");
  assert.ok(JSON.stringify(h.calls).includes("四角い部分がある"), "generation sees the issue's proposition, not only its state");
});

test("both strategies receive identical extraction, classification and generation information", async () => {
  const seen: unknown[][] = [], generation: unknown[][] = [];
  for (const strategy of ["repair-first", "bypass-enabled"]) {
    const local = options(), inputs: unknown[] = [];
    const extract = local.extractor.extract, classify = local.classifier.classify;
    local.extractor.extract = async (input, opts) => { inputs.push(structuredClone(input)); return extract(input, opts); };
    local.classifier.classify = async (input, opts) => { inputs.push(structuredClone(input)); return classify(input, opts); };
    const h = harness({ strategy, localGrounding: local }); await h.run();
    seen.push(inputs); generation.push(h.calls);
  }
  assert.deepEqual(seen[0], seen[1]);
  assert.deepEqual(generation[0], generation[1]);
});

test("one rejected segment preserves valid local claims and the existing memory", async () => {
  const local = options();
  local.extractor.extract = async () => [segment(ids[0]), { ...segment(ids[0], "SYNTHETIC_PRIVATE_CANARY"), segmentId: "PRIVATE_CANARY_ID" }];
  const h = harness({ localGrounding: local }); const result = await h.run();
  assert.deepEqual(result.privateState.graph.records.map((r: any) => r.kind), ["mention", "feature", "claim"]);
  const trace = h.dialogue.getAttempts()[0].localGrounding;
  assert.equal(trace.rejected.length, 1);
  assert.ok(!JSON.stringify(trace).includes("CANARY"));
});

test("trace permits only known classifier kinds and extraction diagnostic codes", async () => {
  for (const classifierKind of ["unverified_injected", "luna_standin", "jev", "SYNTHETIC_PRIVATE_CANARY"]) {
    const local = options();
    Object.assign(local.classifier, { metadata: { classifierKind } });
    Object.assign(local.extractor, { lastDiagnostics: { rejectedSegments: 1, reasons: ["quote_not_found"] } });
    const h = harness({ localGrounding: local }); await h.run();
    const trace = h.dialogue.getAttempts()[0].localGrounding;
    assert.equal(trace.classifierKind, classifierKind === "luna_standin" ? "luna_standin" : "unverified_injected");
    assert.deepEqual(trace.extraction, { rejectedSegments: 1, reasons: ["quote_not_found"] });
    assert.ok(!JSON.stringify(trace).includes("CANARY"));
  }
  const local = options();
  Object.assign(local.extractor, { lastDiagnostics: { rejectedSegments: 1, reasons: ["SYNTHETIC_PRIVATE_CANARY"] } });
  const h = harness({ localGrounding: local }); await h.run();
  assert.equal(h.dialogue.getAttempts()[0].localGrounding.extraction, undefined);
});

test("graph operation budget drops only overflowing claims and keeps the original mention", async () => {
  const local = options();
  const quotes = Array.from({ length: 16 }, (_, i) => `特徴${i + 1}`);
  local.extractor.extract = async () => quotes.map((quote, i) => ({ ...segment(ids[0], quote), segmentId: `s${i + 1}`, proposition: quote }));
  const h = harness({ localGrounding: local });
  const result = await h.run({ events: [{ ...events[0], text: quotes.join("、") }] });
  const trace = h.dialogue.getAttempts()[0].localGrounding;
  assert.equal(trace.status, "ok");
  assert.equal(trace.accepted, 15);
  assert.equal(trace.rejected.length, 1);
  assert.equal(trace.rejected[0].reason, "memory_invalid_update");
  assert.equal(result.privateState.graph.records[0].kind, "mention");
  assert.equal(result.privateState.graph.records.length, 16);
});

test("generation failure rolls back all claims and existing reference updates", async () => {
  const h = harness({ localGrounding: options(), client: { async complete() { throw new Error("SYNTHETIC_PRIVATE_CANARY"); } } });
  await assert.rejects(h.run());
  assert.deepEqual(h.initial.graph.records, []);
  assert.equal(h.dialogue.getAttempts()[0].localGrounding.accepted, 1);
  assert.ok(!JSON.stringify(h.dialogue.getAttempts()).includes("CANARY"));
});

test("supersede during extraction settles promptly and ignores late extractor output", async () => {
  const entered = gate(), late = gate(); let classifications = 0, extractions = 0;
  const local = options();
  local.extractor.extract = async input => {
    if (++extractions === 1) { entered.release(); await late.promise; }
    return [segment(input.ownSlots[0], input.publicTurns.at(-1)!.text)];
  };
  const classify = local.classifier.classify;
  local.classifier.classify = async (input, opts) => { classifications++; return classify(input, opts); };
  const h = harness({ localGrounding: local });
  const queue = createHumanMessageQueue({ runAiTurn: h.dialogue.runAiTurn, initialPrivateState: h.initial });
  queue.enqueue({ text: utterance }); await entered.promise;
  queue.enqueue({ text: "四角い部分ではありません" }); await queue.whenIdle();
  const state = queue.getPrivateState();
  assert.equal(state.judgments.length, 1);
  assert.equal(state.graph.records.filter((r: any) => r.kind === "claim").length, 1);
  assert.equal(state.graph.records.find((r: any) => r.kind === "claim").sourceTurn, 2);
  assert.equal(h.dialogue.getAttempts()[0].localGrounding.status, "aborted");
  const snapshot = JSON.stringify(state);
  late.release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(classifications, 1, "abandoned extraction cannot start a classifier later");
  assert.equal(JSON.stringify(queue.getPrivateState()), snapshot);
});

test("supersede after local verification cannot install a stale generation snapshot", async () => {
  const entered = gate(), late = gate(); let calls = 0;
  const h = harness({ localGrounding: options(), client: { async complete() {
    if (++calls === 1) { entered.release(); await late.promise; }
    return { text: "そう見えるんですね。" };
  } } });
  const queue = createHumanMessageQueue({ runAiTurn: h.dialogue.runAiTurn, initialPrivateState: h.initial });
  queue.enqueue({ text: utterance }); await entered.promise;
  queue.enqueue({ text: "細長い部分です" }); late.release(); await queue.whenIdle();
  const state = queue.getPrivateState();
  assert.equal(state.judgments.length, 1);
  assert.ok(state.graph.records.filter((r: any) => r.kind === "claim").every((r: any) => r.sourceTurn === 2));
  assert.deepEqual(queue.getSnapshot().events.map((e: any) => e.speaker), ["human", "human", "ai"]);
});

for (const phase of ["extractor", "classifier"] as const) {
  test(`${phase} timeout keeps the turn and legacy memory, and ignores late operations`, async () => {
    const local = options(), late = gate();
    local.timeoutMs = 5;
    if (phase === "extractor") local.extractor.extract = async () => { await late.promise; return [segment(ids[0])]; };
    else local.classifier.classify = async () => { await late.promise; return [{ segmentId: "s1", act: "assert", respondsToClaimId: null, rawScore: 1 }]; };
    const h = harness({ localGrounding: local }); const result = await h.run();
    assert.deepEqual(result.privateState.graph.records.map((r: any) => r.kind), ["mention", "feature"]);
    assert.equal(h.dialogue.getAttempts()[0].localGrounding.status, "timeout");
    const before = JSON.stringify(h.dialogue.getAttempts());
    late.release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.stringify(h.dialogue.getAttempts()), before);
  });
  test(`${phase} exception records only a fixed reason and does not fail the turn`, async () => {
    const local = options();
    const fail = async (): Promise<never> => { throw Object.assign(new Error("SYNTHETIC_PRIVATE_CANARY"), { code: "private_canary" }); };
    if (phase === "extractor") local.extractor.extract = fail; else local.classifier.classify = fail;
    const h = harness({ localGrounding: local }); const result = await h.run();
    assert.equal(result.privateState.graph.records.filter((r: any) => r.kind === "claim").length, 0);
    const trace = h.dialogue.getAttempts()[0].localGrounding;
    assert.equal(trace.status, "error");
    assert.equal(trace.rejected[0].reason, `${phase}_failed`);
    assert.ok(!JSON.stringify(h.dialogue.getAttempts()).toLowerCase().includes("canary"));
  });
}

test("guard fallback keeps claims from public human speech under the same publication boundary", async () => {
  const h = harness({ localGrounding: options(), client: { async complete() { return { text: "船と呼びましょう。" }; } } });
  const result = await h.run();
  assert.equal(h.dialogue.getAttempts()[0].generationGuard.fallback, true);
  assert.equal(result.privateState.graph.records.filter((r: any) => r.kind === "claim").length, 1);
  assert.equal(result.text, "なるほど、そう見えるんですね。");
});

test("a committed public AI naming proposal is staged as a prior claim before human classification", async () => {
  const local = options(); let seen!: LocalClassificationInput;
  local.extractor.extract = async () => [{ ...segment(ids[0], "うん"), aspect: "name", proposition: "船でよい", name: "船", respondsToTurn: 2 }];
  local.classifier.classify = async input => { seen = input; return [{ segmentId: "s1", act: "name_accept", respondsToClaimId: input.priorClaims[0]?.id ?? null, rawScore: 0 }]; };
  const h = harness({ localGrounding: local });
  const initial: any = h.initial;
  initial.judgments.push({ turnIndex: 1, judgment: { ...core, action: "propose_name", targetSlot: ids[0], candidateName: "船" } });
  const result = await h.run({ privateState: initial, events: [events[0], { id: "event-2", seq: 2, speaker: "ai", text: "船と呼ぶのはどうでしょう？" },
    { id: "event-3", seq: 3, speaker: "human", text: "うん" }] });
  assert.equal(seen.priorClaims[0].speaker, "ai");
  assert.equal(seen.priorClaims[0].sourceTurn, 2);
  assert.deepEqual(result.privateState.graph.records.filter((r: any) => r.kind === "claim").map((r: any) => r.act), ["name_propose", "name_accept"]);
  assert.deepEqual(initial.graph.records, [], "AI prior claim also stays detached until publication");
});

test("JSON durable restore round-trips claims and cannot enable an originally off trial", async () => {
  let saved: any;
  const h = harness(); const local = options();
  const args = { client: h.client, judge: h.judge, strategy: "repair-first", seed: 37, referenceMemory: true,
    runDir: "", localGrounding: local, onPersist: async (r: unknown) => { saved = JSON.parse(JSON.stringify(r)); } };
  const first = await createNamingTaskV2(args as any);
  first.message(utterance, "first"); await first.whenIdle();
  const before = first.researcherView().privateState;
  assert.equal(saved.options.localGrounding, true);
  const second = await createNamingTaskV2({ ...args, restore: saved } as any);
  assert.deepEqual(second.researcherView().privateState, before);
  second.message(utterance, "next"); await second.whenIdle();
  assert.equal(second.researcherView().privateState.graph.records.filter((r: any) => r.kind === "claim").length, 2);
  assert.ok(!JSON.stringify(second.getState()).includes("localGrounding"));
  assert.ok(!JSON.stringify(second.getState()).includes("claim"));
  const off = await createNamingTaskV2({ ...args, localGrounding: null } as any);
  await off.persistNow(); const offSaved = saved;
  const restoredOff = await createNamingTaskV2({ ...args, restore: offSaved } as any);
  restoredOff.message(utterance); await restoredOff.whenIdle();
  assert.equal(saved.options.localGrounding, undefined);
  assert.ok(restoredOff.researcherView().attempts.every((a: any) => a.localGrounding === undefined));
});
