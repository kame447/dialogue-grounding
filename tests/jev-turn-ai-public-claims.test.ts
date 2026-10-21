// Slice A deterministic mock oracles. These assert wiring, not semantic accuracy.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createMockJevDecisionClient } from "../dialogue-model/runtime/decision/mocks.ts";
import { createHumanMessageQueue } from "../dialogue-model/runtime/web/human-message-queue.mjs";
import { createDialogueV2 } from "../dialogue-model/runtime/v2/dialogue-v2.mjs";
import { createJevTurnRuntime, settleAiPublicClaims, updateRepairHistory } from "../dialogue-model/runtime/v2/jev-turn.ts";
import type { JevPrivateState, JevTurnTrace } from "../dialogue-model/runtime/v2/jev-turn.ts";
import type { AiPublicInput, LocalSegmentProposal, LocalClaimView, AiSupport, AiPublicPending } from "../dialogue-model/runtime/local-grounding/contract.ts";
import { createReferenceGraph, applyReferenceUpdate, REFERENCE_LIMITS } from "../dialogue-model/runtime/memory/reference-graph.mjs";
import { initialAiPublicState, validateAiPublicState, prependAiPublic, verifyAiPublicUpdate } from "../dialogue-model/runtime/local-grounding/verify-ai.ts";
import { buildMemoAiExtractionMessages, createMemoAiExtractor, parseAiExtraction, MEMO_AI_PUBLIC_EXTRACTION_INSTRUCTIONS } from "../dialogue-model/runtime/local-grounding/extract-ai.ts";
import { buildJevAiFunctionPayload, buildJevAiSupportPayload, createJevAiSupportChecker, parseJevAiSupport, parseJevAiFunctions, AI_FUNCTION_INSTRUCTIONS,
  AI_FUNCTION_CRITERIA, AI_SUPPORT_INSTRUCTIONS, AI_ACT_DESCRIPTIONS, AI_SUPPORT_CHOICES } from "../dialogue-model/runtime/local-grounding/jev-ai-public.ts";
import { priorClaimViews, deriveLocalIssues } from "../dialogue-model/runtime/local-grounding/derive.ts";
import { createJevLocalTestClassifier } from "../dialogue-model/runtime/local-grounding/jev-local-test.ts";
import type { RepairHistoryEntry } from "../dialogue-model/runtime/decision/contract.ts";

const ids = Array.from({ length: 6 }, (_, i) => `s-000${i + 1}`);
const anchors = ids.map((id, x) => ({ id, bbox: { x, y: 0, w: 1, h: 1 }, centroid: { x, y: 0 } }));
const image = { mimeType: "image/png" as const, base64: "U1lOVEhFVElDX09XTl9JTUFHRQ==" };
const KEY = "sk-or-SYNTHETIC-ai-public-choice-key-0000";
const TEXT = "四角い部分があって、そこから長さの違う出っ張りが二本出ています。";
const memo = () => ({ observedAt: "2026-10-20T00:00:00.000Z", figures: anchors.map(a => ({ id: a.id, region: { ...a.bbox },
  holistic: [{ construal: "馬", basis: ["細長い部分"], status: "hypothesis" as const }],
  analytic: { shapes: ["四角い部分"], composition: "三角と四角がつながる", relations: ["二つの部分が接する"] }, unknowns: [], reobservations: [] })) });
const segment = (overrides: Partial<LocalSegmentProposal> = {}): LocalSegmentProposal => ({ segmentId: "s1", quote: "四角い部分があって",
  targets: [ids[0]], aspect: "part", proposition: "四角い部分がある", name: null, linkedIssueId: null, respondsToTurn: null, ...overrides });
const pair = () => [segment(), segment({ segmentId: "s2", quote: "長さの違う出っ張りが二本出ています", proposition: "長さの違う出っ張りが二本ある" })];
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const accept = { action: "accept", target: { kind: "none" }, name: null, feature: null, observe: null };
const pause = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
function answer(payload: any, select: (name: string, labels: string[]) => string, cost = 0.001) {
  return { model: "typesafe/jev-1.14", id: "gen-ai-mock", usage: { cost }, answers: Object.fromEntries(Object.entries(payload.questions).map(([name, q]: [string, any]) => {
    const labels = Object.keys(q.criteria), selected = select(name, labels);
    return [name, { type: "choice", choice: selected, probabilities: Object.fromEntries(labels.map(label => [label, label === selected ? 1 : 0])), confidence: 1 }];
  })) };
}
function harness(config: any = {}) {
  const records: JevTurnTrace[] = [], calls: any[] = [], network: any[] = [], decisions: any[] = [];
  let generations = 0;
  const classifier = config.classifier ?? { async classify(input: any) { return input.segments.map((s: any, i: number) => ({ segmentId: s.segmentId,
    act: config.humanActs?.[i] ?? "assert", respondsToClaimId: config.humanTargets?.[i] ?? null, rawScore: null })); } };
  const client = { async complete(messages: any[], options: any) {
    calls.push({ phase: options.phase, messages: structuredClone(messages), timeoutMs: options.timeoutMs });
    await config.onCall?.(options.phase, messages, options);
    if (config.fail === options.phase) throw new Error("PRIVATE_ERROR_CANARY");
    if (options.phase === "local_extraction") return { text: JSON.stringify(typeof config.humanSegments === "function" ? config.humanSegments(messages) : config.humanSegments ?? []) };
    if (options.phase === "ai_extraction") return { text: JSON.stringify(typeof config.segments === "function" ? config.segments(messages) : config.segments ?? pair()) };
    return { text: Array.isArray(config.text) ? config.text[generations++] : config.text ?? TEXT };
  } };
  const fetchImpl = async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(init.body as string), phase = Object.keys(payload.questions).some(k => k.endsWith("_support")) ? "ai_support" : "ai_function";
    network.push({ phase, payload });
    await config.onFetch?.(phase, payload, init);
    if (config.fail === phase) throw new Error("PRIVATE_NETWORK_CANARY");
    const data = answer(payload, (name, labels) => name.endsWith("_act") ? config.act ?? "assert" : name.endsWith("_antecedent") ? config.antecedent ?? "none"
      : config.support ?? (labels.includes("expressed") ? "expressed" : "expressed_responds"), config.cost ?? 0.001);
    return Response.json(config.patchReply ? config.patchReply(phase, data) : data);
  };
  const options = { client, ownImage: image, ownAnchors: anchors,
    observer: { async observeAll() { return memo(); }, async reobserve(input: any) { return { observedAt: "2026-10-20T00:00:01.000Z", issue: input.issue,
      figures: input.figureIds.map((figureId: string) => ({ figureId, supports: ["後のメモ"], contradicts: [], unknown: [] })) }; } },
    jevDecision: createMockJevDecisionClient((input: any) => { decisions.push(structuredClone(input)); return structuredClone(typeof config.decision === "function" ? config.decision(input) : config.decision ?? accept); }),
    localGrounding: { classifier, timeoutMs: config.timeoutMs ?? 1000, ...(config.enabled === false ? {} : { aiPublicClaims: config.enabled ?? true, aiPublicTransport: { readKey: async () => KEY, fetchImpl } }) },
    onJevTurnTrace: (record: JevTurnTrace) => records.push(record),
    generation: { task: "synthetic task", instructions: "synthetic generation", actionScope: { accept: "受け止める", repair: "修復", confirm: "確認", propose_name: "命名" }, final: "final", timeoutMs: 1000 } };
  const runtime = config.dialogue ? createDialogueV2({ client, image, anchors, strategy: config.strategy ?? "repair-first", referenceMemory: true,
    decisionMode: "jev", observer: options.observer, jevDecision: options.jevDecision, localGrounding: options.localGrounding, onJevTurnTrace: options.onJevTurnTrace } as any) : createJevTurnRuntime(options as any);
  const events: any[] = [{ id: "e1", seq: 1, speaker: "human", text: "形を教えてください" }];
  const run = (state = runtime.initialPrivateState(), extra: any = {}) => runtime.runAiTurn({ events, privateState: state, lastEventId: events.at(-1).id, ...extra });
  const next = async (first: any, text = "四角はあるね。でも出っ張りは同じ長さだと思う。", extra: any = {}) => {
    events.push({ id: `e${events.length + 1}`, seq: events.at(-1).seq + 1, speaker: "ai", text: first.text },
      { id: `e${events.length + 2}`, seq: events.at(-1).seq + 2, speaker: "human", text });
    return run(first.privateState, extra);
  };
  return { runtime, run, next, events, records, calls, network, decisions, client, options };
}
const aiClaims = (state: JevPrivateState) => priorClaimViews(state.graph, { limit: 160 }).filter(c => c.speaker === "ai");
function extractionInput(extra: any = {}): AiPublicInput { return { turn: 1, aiSeq: 2, candidateText: TEXT,
  publicTurns: [{ turn: 1, speaker: "human", text: "形を教えてください" }], ownSlots: ids, ownAnchors: anchors, observations: memo(), issueSummary: "", ...extra }; }
function prior(overrides: Partial<LocalClaimView> = {}): LocalClaimView { return { id: "1:local1", turn: 1, issueId: "1:local1", targets: [ids[0]], aspect: "part", act: "assert",
  proposition: "四角い部分がある", name: null, speaker: "human", sourceTurn: 1, quote: "四角い部分がある", respondsTo: null, source: "partner_statement", ...overrides }; }
function graphWith(claims: LocalClaimView[]) {
  let graph = createReferenceGraph({ slots: ids });
  const turns = [...new Map(claims.map(c => [c.sourceTurn, { turn: c.sourceTurn, speaker: c.speaker, text: c.quote }])).values()];
  for (const turn of [...new Set(claims.map(c => c.turn))].sort((a, b) => a - b)) {
    graph = applyReferenceUpdate(graph, { expectedRevision: graph.revision, turn, operations: claims.filter(c => c.turn === turn).map(({ turn: _t, ...c }) => ({ kind: "claim", ...c })) },
      { publicTurns: turns.filter(t => t.turn <= turn), generationSucceeded: true });
  }
  return graph;
}

test("SA-1: off omission, false and unknown opt-ins keep identical calls/state/trace and no aiPublic fields", async t => {
  t.mock.method(performance, "now", () => 0);
  const off = harness({ enabled: false }), unknown = harness({ enabled: "true" });
  const a = await off.run(), b = await unknown.run();
  assert.deepEqual(a, b); assert.deepEqual(off.calls, unknown.calls); assert.deepEqual(off.records, unknown.records);
  assert.deepEqual(off.network, []); assert.deepEqual(unknown.network, []);
  assert.equal(Object.hasOwn(a.privateState, "aiPublic"), false); assert.equal(Object.hasOwn(off.records[0], "aiPublic"), false);
});

test("SA-2/15: separate public clauses become separate next-turn issues; advisory links cannot recombine them", async () => {
  const h = harness({ segments: pair().map(s => ({ ...s, linkedIssueId: "1:local1" })), dialogue: true });
  const first = await h.run();
  assert.deepEqual(aiClaims(first.privateState), []);
  assert.deepEqual(first.privateState.aiPublic.pending.candidates.map((c: any) => c.candidateKey), ["2#1", "2#2"]);
  const next = await h.next(first), claims = aiClaims(next.privateState);
  assert.deepEqual(claims.map(c => [c.id, c.issueId, c.sourceTurn, c.respondsTo]), [["3:pub1", "3:pub1", 2, null], ["3:pub2", "3:pub2", 2, null]]);
  assert.deepEqual(h.records[1].local?.aiClaims, []);
  assert.deepEqual(h.records[1].aiPublic?.application?.claims.map(c => c.id), ["3:pub1", "3:pub2"]);
});

test("SA-3: explicit human responses support and deny the two different issues", async () => {
  const h = harness({ humanSegments: (messages: any[]) => JSON.parse(messages[1].content).turn === 1 ? [] : [
    segment({ quote: "四角はあるね", proposition: "四角い部分がある" }),
    segment({ segmentId: "s2", quote: "出っ張りは同じ長さだと思う", proposition: "出っ張りは同じ長さである", respondsToTurn: 2 })],
    humanActs: ["agree", "deny"], humanTargets: ["3:pub1", "3:pub2"] });
  const second = await h.next(await h.run());
  assert.deepEqual(deriveLocalIssues(second.privateState.graph).map(i => [i.issueId, i.state]), [["3:pub1", "supported"], ["3:pub2", "denied"]]);
});

test("SA-4: public quote with an unsupported private-plan proposition does not become a claim", async () => {
  const h = harness({ segments: [segment({ proposition: "PRIVATE_PLAN_CANARY" })], support: "not_expressed" });
  const first = await h.run(); assert.deepEqual(first.privateState.aiPublic.pending.candidates, []);
  const extraction = h.calls.find(c => c.phase === "ai_extraction");
  assert.ok(!JSON.stringify(extraction.messages).includes("PRIVATE_PLAN_CANARY"));
  const second = await h.next(first); assert.deepEqual(aiClaims(second.privateState), []);
});

test("SA-5: literal name recovery remains exactly once; name extraction and name acts cannot create duplicates", async () => {
  const h = harness({ text: "「馬」と呼ぶのはどうでしょう？", decision: { action: "propose_name", target: { kind: "single", figureId: ids[0] }, name: "馬", feature: null, observe: null },
    segments: [segment({ quote: "馬", aspect: "name", proposition: "馬と呼ぶ", name: "馬" })] });
  const first = await h.run(); assert.deepEqual(h.network, []);
  assert.ok(first.privateState.aiPublic.pending.reasons.includes("name_by_literal_path"));
  const second = await h.next(first);
  assert.deepEqual(aiClaims(second.privateState).map(c => [c.id, c.aspect, c.name]), [["3:ai1", "name", "馬"]]);
  assert.deepEqual(h.records[1].aiPublic?.application?.nameIds, ["3:ai1"]);
  const payload = buildJevAiFunctionPayload({ ...extractionInput(), segments: [segment()], priorClaims: [] });
  assert.equal(Object.hasOwn(payload.questions.segment_0_act.criteria, "name_propose"), false);
  assert.throws(() => parseJevAiFunctions(answer(payload, name => name.endsWith("_act") ? "name_propose" : "none").answers, payload));
});

test("SA-6/13/16: response support and speaker permissions are strict, with positive controls", () => {
  for (const act of ["agree", "deny", "withdraw", "defer", "revisit"] as const) {
    const own = act === "withdraw", base = prior(own ? { speaker: "ai", source: "ai_hypothesis" } : {});
    const deferred = prior({ id: "2:local1", turn: 2, sourceTurn: 2, act: "defer", respondsTo: base.id, issueId: base.issueId });
    const claims = act === "revisit" ? [base, deferred] : [base];
    const graph = graphWith(claims), publicTurns = claims.map(c => ({ turn: c.sourceTurn, speaker: c.speaker, text: c.quote }));
    const verify = (support: AiSupport, pointer: string | null = base.id) => verifyAiPublicUpdate({ graph, aiSeq: 4, candidateText: TEXT, publicTurns,
      segments: [segment()], verdicts: [{ segmentId: "s1", act, respondsToClaimId: pointer, rawScore: 1 }], supports: [{ segmentId: "s1", support }] });
    assert.equal(verify("expressed_responds").candidates.length, 1, act);
    for (const support of ["expressed_not_response", "not_expressed", "unclear"] as const) assert.equal(verify(support).candidates.length, 0, act + support);
    assert.equal(verify("expressed_responds", null).candidates.length, 0);
    assert.equal(verify("expressed_responds", "1:missing").candidates.length, 0);
    if (["agree", "deny", "withdraw"].includes(act)) {
      const wrong = { ...base, speaker: own ? "human" as const : "ai" as const, source: own ? "partner_statement" as const : "ai_hypothesis" as const };
      const result = verifyAiPublicUpdate({ graph: graphWith([wrong]), aiSeq: 4, candidateText: TEXT,
        publicTurns: [{ turn: wrong.sourceTurn, speaker: wrong.speaker, text: wrong.quote }], segments: [segment()],
        verdicts: [{ segmentId: "s1", act, respondsToClaimId: wrong.id, rawScore: null }], supports: [{ segmentId: "s1", support: "expressed_responds" }] });
      assert.equal(result.candidates.length, 0); assert.equal(result.rejected[0].reason, "inconsistent_claim_speaker");
    }
    if (act === "revisit") {
      const result = verifyAiPublicUpdate({ graph: graphWith([base]), aiSeq: 4, candidateText: TEXT, publicTurns: publicTurns.slice(0, 1),
        segments: [segment()], verdicts: [{ segmentId: "s1", act, respondsToClaimId: base.id, rawScore: null }], supports: [{ segmentId: "s1", support: "expressed_responds" }] });
      assert.equal(result.rejected[0].reason, "not_deferred");
    }
  }
});

for (const phase of ["ai_extraction", "ai_function", "ai_support"]) test(`SA-7: ${phase} failure retains publication with failed pending and closed diagnostics`, async () => {
  const h = harness({ fail: phase }), initial = h.runtime.initialPrivateState(), before = JSON.stringify(initial);
  const result = await h.run(initial);
  assert.equal(result.text, TEXT); assert.equal(result.privateState.aiPublic.pending.status, "failed");
  assert.deepEqual(result.privateState.aiPublic.pending.candidates, []); assert.equal(JSON.stringify(initial), before);
  assert.ok(!JSON.stringify(h.records).includes("CANARY"));
  const settled = await settleAiPublicClaims(h.records, result.privateState);
  assert.equal(settled[0].status, "published_failed");
});

test("SA-7: phase timeout publishes failed pending; caller abort publishes nothing", async () => {
  const hold = pause(), h = harness({ timeoutMs: 5, onCall: async (phase: string) => { if (phase === "ai_extraction") await hold.promise; } });
  const first = await h.run(); assert.equal(first.privateState.aiPublic.pending.status, "failed");
  assert.ok(first.privateState.aiPublic.pending.reasons.includes("ai_extraction_timeout")); hold.release();
  const entered = pause(), wait = pause(), controller = new AbortController();
  const stopped = harness({ onCall: async (phase: string) => { if (phase === "ai_extraction") { entered.release(); await wait.promise; } } });
  const state = stopped.runtime.initialPrivateState(), before = JSON.stringify(state);
  const pending = stopped.run(state, { signal: controller.signal }); await entered.promise; controller.abort();
  await assert.rejects(pending, (e: any) => e.code === "aborted"); wait.release();
  assert.equal(JSON.stringify(state), before); assert.equal(stopped.records[0].publicSpeech, null);
});

test("SA-7 regression: timed-out extraction records the complete call even when the client ignores abort", async t => {
  let clock = 0; t.mock.method(performance, "now", () => clock); t.mock.timers.enable({ apis: ["setTimeout"] });
  const hold = pause(), entered = pause(), h = harness({ timeoutMs: 1000, onCall: async (phase: string) => {
    if (phase === "ai_extraction") { entered.release(); await hold.promise; }
  } });
  try {
    const work = h.run(); await entered.promise; clock = 1000; t.mock.timers.tick(1000);
    const result = await work;
    assert.equal(result.text, TEXT);
    assert.equal(result.privateState.aiPublic.pending.status, "failed");
    assert.equal(h.calls.filter(c => c.phase === "ai_extraction").length, 1);
    assert.deepEqual(h.records[0].aiPublic?.stages.ai_extraction, {
      status: "error", calls: 1, model: null, responseId: null, callIndex: null, costUsd: null, error: "timeout", choices: [],
    });
    assert.equal(h.records[0].aiPublic?.stages.ai_function.calls, 0);
    assert.equal(h.records[0].aiPublic?.stages.ai_support.calls, 0);
    assert.equal(h.network.length, 0);
    const committed = JSON.stringify(h.records[0]); hold.release();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(JSON.stringify(h.records[0]), committed);
  } finally { hold.release(); }
});

test("SA-7 regression: a stale extraction cannot contaminate the next turn's successful evidence", async t => {
  let clock = 0; t.mock.method(performance, "now", () => clock); t.mock.timers.enable({ apis: ["setTimeout"] });
  const old = pause(), next = pause(), enteredOld = pause(), enteredNext = pause(); let count = 0;
  const h = harness({ timeoutMs: 1000, onCall: async (phase: string) => {
    if (phase !== "ai_extraction") return;
    if (++count === 1) { enteredOld.release(); await old.promise; }
    else { enteredNext.release(); await next.promise; }
  } });
  try {
    const firstWork = h.run(); await enteredOld.promise; clock = 1000; t.mock.timers.tick(1000);
    const first = await firstWork;
    assert.equal(first.privateState.aiPublic.pending.status, "failed");
    const committed = JSON.stringify(h.records[0]);
    const second = h.next(first); await enteredNext.promise;
    old.release(); await new Promise<void>(resolve => setImmediate(resolve));
    next.release(); const result = await second;
    assert.equal(result.privateState.aiPublic.pending.status, "ready");
    assert.equal(h.records[1].aiPublic?.stages.ai_extraction.status, "ok");
    assert.equal(h.records[1].aiPublic?.stages.ai_extraction.error, null);
    assert.equal(h.records[1].aiPublic?.stages.ai_extraction.calls, 1);
    assert.equal(JSON.stringify(h.records[0]), committed);
  } finally { old.release(); next.release(); }
});

test("SA-7/17 regression: caller-aborted stale extraction leaves committed state and the retry's evidence intact", async () => {
  const config: any = {}, h = harness(config), first = await h.run(), before = JSON.stringify(first.privateState);
  const old = pause(), next = pause(), enteredOld = pause(), enteredNext = pause(), controller = new AbortController(); let count = 0;
  config.onCall = async (phase: string) => {
    if (phase !== "ai_extraction") return;
    if (++count === 1) { enteredOld.release(); await old.promise; }
    else { enteredNext.release(); await next.promise; }
  };
  try {
    const stale = h.next(first, "次の発話", { signal: controller.signal });
    await enteredOld.promise; controller.abort();
    await assert.rejects(stale, (e: any) => e.code === "aborted");
    assert.equal(h.records[1].publicSpeech, null); assert.equal(h.records[1].aiPublic?.pending, null);
    const rejected = JSON.stringify(h.records[1]);
    const retry = h.run(first.privateState); await enteredNext.promise;
    old.release(); await new Promise<void>(resolve => setImmediate(resolve)); next.release();
    const result = await retry;
    assert.equal(result.privateState.aiPublic.pending.status, "ready");
    assert.equal(h.records[2].aiPublic?.stages.ai_extraction.status, "ok");
    assert.equal(h.records[2].aiPublic?.stages.ai_extraction.error, null);
    assert.equal(JSON.stringify(h.records[1]), rejected);
    assert.equal(JSON.stringify(first.privateState), before);
    assert.equal(first.privateState.aiPublic.pending.aiSeq, 2);
    assert.equal(h.events[1].text, first.text);
  } finally { old.release(); next.release(); }
});

for (const phase of ["ai_function", "ai_support"] as const) test(`SA-7 regression: ${phase} timeout keeps the sent call and unknown cost`, async t => {
  let clock = 0; t.mock.method(performance, "now", () => clock); t.mock.timers.enable({ apis: ["setTimeout"] });
  const hold = pause(), entered = pause(), h = harness({ timeoutMs: 1000, onFetch: async (stage: string) => {
    if (stage === phase) { entered.release(); await hold.promise; }
  } });
  try {
    const work = h.run(); await entered.promise;
    clock = 1000; t.mock.timers.tick(1000);
    const result = await work;
    assert.equal(result.text, TEXT); assert.equal(result.privateState.aiPublic.pending.status, "failed");
    assert.deepEqual(result.privateState.aiPublic.pending.reasons, [phase + "_timeout"]);
    const stages = h.records[0].aiPublic!.stages;
    for (const name of ["ai_extraction", "ai_function", "ai_support"] as const) {
      const actual = name === "ai_extraction" ? h.calls.filter(c => c.phase === name).length : h.network.filter(c => c.phase === name).length;
      assert.equal(stages[name].calls, actual, name);
    }
    assert.equal(stages[phase].status, "error"); assert.equal(stages[phase].error, "timeout");
    assert.equal(stages[phase].costUsd, null);
    const committed = JSON.stringify(h.records[0]); hold.release();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(JSON.stringify(h.records[0]), committed);
  } finally { hold.release(); }
});

test("SA-11 regression: restore rejects impossible application logs without requiring retained graph claims", async () => {
  const h = harness(), first = await h.run(), second = await h.next(first);
  const original = JSON.parse(JSON.stringify(second.privateState.aiPublic));
  assert.deepEqual(validateAiPublicState(original, ids, 4, second.privateState.graph), original);
  const reject = (change: (log: any) => void) => {
    const state = structuredClone(original); change(state.log[0]);
    assert.throws(() => validateAiPublicState(state, ids, 4, second.privateState.graph), (e: any) => e.code === "invalid_state");
  };
  reject(log => { log.appliedAtTurn = 999; log.ids = ["999:pub1"]; });
  // Within maxSeq, but ahead of the committed graph's last turn.
  reject(log => { log.appliedAtTurn = 4; log.ids = ["4:pub1"]; });
  for (const status of ["applied", "partial"]) reject(log => { log.status = status; log.ids = []; });
  reject(log => { log.ids = ["4:pub1"]; });
  reject(log => { log.ids = ["3:local1"]; });
  reject(log => { log.status = "not_applied"; });
  let pruned = second.privateState.graph;
  const oldClaims = aiClaims(second.privateState), text = "四角も二本の出っ張りもあります";
  pruned = applyReferenceUpdate(pruned, { expectedRevision: pruned.revision, turn: 5, operations: oldClaims.map((c, i) => ({
    kind: "claim", id: `5:close${i + 1}`, issueId: c.issueId, targets: c.targets, aspect: c.aspect, act: "agree", proposition: c.proposition,
    name: null, speaker: "human", sourceTurn: 5, quote: text, respondsTo: c.id, source: "partner_statement",
  })) }, { publicTurns: [{ turn: 5, speaker: "human", text }], generationSucceeded: true });
  for (const turn of [6, 7]) {
    pruned = applyReferenceUpdate(pruned, { expectedRevision: pruned.revision, turn, operations: Array.from({ length: REFERENCE_LIMITS.operations }, (_, i) => ({
      kind: "claim", id: `${turn}:recent${i + 1}`, issueId: `${turn}:recent${i + 1}`, targets: [ids[0]], aspect: "part", act: "assert",
      proposition: text, name: null, speaker: "human", sourceTurn: turn, quote: text, respondsTo: null, source: "partner_statement",
    })) }, { publicTurns: [{ turn, speaker: "human", text }], generationSucceeded: true });
  }
  assert.ok(original.log[0].ids.every((id: string) => !pruned.records.some((r: { id: string }) => r.id === id)));
  const historical = { ...original, pending: null };
  assert.deepEqual(validateAiPublicState(historical, ids, 7, pruned), historical);
  const omitted = { ...historical, log: [], omitted: 1 };
  assert.deepEqual(validateAiPublicState(omitted, ids, 7, pruned), omitted);
});

test("SA-8: retry reuses the old source without re-extraction, preserves failed state and inserts no duplicates", async () => {
  const config: any = {}, h = harness(config), first = await h.run(), before = JSON.stringify(first.privateState);
  config.fail = "generation";
  await assert.rejects(h.next(first), (e: any) => e.code === "generation_failed");
  assert.equal(JSON.stringify(first.privateState), before);
  assert.equal(h.calls.filter(c => c.phase === "ai_extraction").length, 1);
  config.fail = null;
  const retried = await h.run(first.privateState);
  assert.deepEqual(h.calls.filter(c => c.phase === "ai_extraction").map(c => JSON.parse(c.messages[1].content).aiSeq), [2, 4]);
  assert.deepEqual(aiClaims(retried.privateState).map(c => c.id), ["3:pub1", "3:pub2"]);
  assert.equal(retried.privateState.aiPublic.log.filter((l: any) => l.aiSeq === 2).length, 1);
});

for (const reason of ["hash_mismatch", "event_missing", "not_ai", "non_referential", "duplicate_seq"]) test(`SA-9: ${reason} is logged as not_applied`, async () => {
  const h = harness(), first = await h.run();
  const event: any = { id: "e2", seq: 2, speaker: "ai", text: first.text };
  if (reason === "hash_mismatch") event.text = "different public text";
  if (reason === "not_ai") event.speaker = "human";
  if (reason === "non_referential") event.nonReferential = true;
  if (reason !== "event_missing") h.events.push(event);
  if (reason === "duplicate_seq") h.events.push({ ...event, id: "duplicate" });
  h.events.push({ id: "e3", seq: 3, speaker: "human", text: "続きを教えて" });
  const result = await h.run(first.privateState);
  assert.deepEqual(aiClaims(result.privateState), []);
  assert.deepEqual(result.privateState.aiPublic.log[0], { aiSeq: 2, status: "not_applied", reasons: [reason], appliedAtTurn: 3, ids: [] });
});

test("SA-10: settle distinguishes same-text attempts by committed identity; final pending stays outside graph", async () => {
  const h = harness(), initial = h.runtime.initialPrivateState();
  const first = await h.run(initial, { requestSeq: 11 }); await h.run(initial, { requestSeq: 12 });
  const settled = await settleAiPublicClaims(h.records, first.privateState);
  assert.deepEqual(settled.map(r => [r.attemptNumber, r.status]), [[11, "published_unapplied"], [12, "unpublished"]]);
  assert.deepEqual(aiClaims(first.privateState), []); assert.equal(first.privateState.aiPublic.pending.aiSeq, 2);
  const forged = structuredClone(h.records); forged[0].publicSpeech = "changed";
  assert.equal((await settleAiPublicClaims(forged, first.privateState))[0].status, "unpublished");
});

test("SA-11/9: on initializes and JSON-restores; malformed schema, candidate authority and duplicate sources reject", async () => {
  const h = harness(), initial = await h.runtime.initializePrivateState!();
  assert.deepEqual(initial.aiPublic, initialAiPublicState());
  const first = await h.run(JSON.parse(JSON.stringify(initial))), saved = JSON.parse(JSON.stringify(first.privateState));
  await h.next({ ...first, privateState: saved });
  for (const change of [(s: any) => delete s.aiPublic, (s: any) => s.aiPublic.schema = 0,
    (s: any) => s.aiPublic.pending.candidates[0].speaker = "human", (s: any) => s.aiPublic.pending.candidates.push(s.aiPublic.pending.candidates[0]),
    (s: any) => s.aiPublic.pending.candidates[0].source = "partner_statement", (s: any) => s.aiPublic.pending.aiSeq = 999]) {
    const state = structuredClone(saved); change(state);
    await assert.rejects(h.run(state), (e: any) => e.code === "invalid_state");
  }
  const state = initialAiPublicState(); state.log = [{ aiSeq: 2, status: "empty", reasons: [], appliedAtTurn: 3, ids: [] }, { aiSeq: 2, status: "empty", reasons: [], appliedAtTurn: 3, ids: [] }];
  assert.throws(() => validateAiPublicState(state, ids));
});

test("SA-12/24/25: extraction freezes and whitelists the generation memo while awaiting", async () => {
  const hold = pause(), entered = pause(); let messages: any[] = [];
  const input = extractionInput({ strategy: "PRIVATE_STRATEGY", plan: "PRIVATE_PLAN", gold: "PRIVATE_GOLD", ownImage: image,
    publicTurns: [{ turn: 1, speaker: "human", text: "公開文" }, { turn: 99, speaker: "human", text: "FUTURE_CANARY" }] });
  const extractor = createMemoAiExtractor({ async complete(value) { messages = structuredClone(value); entered.release(); await hold.promise; return { text: JSON.stringify(pair()) }; } });
  const originalMemo = structuredClone(input.observations), work = extractor.extract(input, { timeoutMs: 1000, signal: new AbortController().signal });
  await entered.promise;
  input.observations.figures[0].analytic.shapes[0] = "LATER_CANARY"; input.issueSummary = "LATER_CANARY";
  input.publicTurns = [...input.publicTurns, { turn: 1, speaker: "ai", text: "MUTATION_CANARY" }];
  hold.release(); assert.equal((await work).length, 2);
  assert.deepEqual(JSON.parse(messages[1].content).observations, originalMemo);
  assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_|CANARY|image_url|base64/);
  assert.equal(extractor.lastEvidence.costUsd, null);
});

for (const leaked of ["2:pub1", "２：ｐｕｂ１", "2 : p u b 1", "0:pub0"]) test(`SA-14: on guard catches ${leaked} and the final rewrite`, async () => {
  const h = harness({ text: [leaked, TEXT] }); assert.equal((await h.run()).text, TEXT);
  assert.ok(h.records[0].generationGuard.violations.includes("internal_id"));
  const failed = harness({ text: [leaked, leaked] }); await assert.rejects(failed.run(), (e: any) => e.code === "unsafe_generation");
  assert.equal(failed.records[0].publicSpeech, null); assert.equal(failed.records[0].aiPublic?.pending, null);
});
test("SA-14: off keeps pub IDs unchanged; on guards new prompt bodies without exposing them in trace", async () => {
  const off = harness({ enabled: false, text: "2:pub1" }); assert.equal((await off.run()).text, "2:pub1");
  const on = harness({ text: [MEMO_AI_PUBLIC_EXTRACTION_INSTRUCTIONS, TEXT] }); await on.run();
  assert.ok(on.records[0].generationGuard.violations.includes("internal_prompt_echo"));
  assert.ok(!JSON.stringify(on.records).includes(MEMO_AI_PUBLIC_EXTRACTION_INSTRUCTIONS));
  assert.match(on.records[0].aiPublic!.prompts.extraction.sha256, /^[a-f0-9]{64}$/);
});

test("SA-15/16: independent support discards pointers and never inherits targets; response inconsistency is not rescued", () => {
  const claim = prior(), graph = graphWith([claim]);
  const publicTurns = [{ turn: 1, speaker: "human" as const, text: claim.quote }];
  const s = segment({ targets: [], linkedIssueId: claim.issueId, respondsToTurn: 1 });
  const verdicts = [{ segmentId: s.segmentId, act: "assert" as const, respondsToClaimId: claim.id, rawScore: 1 }];
  const support = buildJevAiSupportPayload({ turn: 1, aiSeq: 2, candidateText: TEXT, publicTurns, priorClaims: [claim], segments: [s], verdicts });
  assert.ok(!support.state.includes(claim.id)); assert.ok(!support.state.includes("selectedAntecedent"));
  const result = verifyAiPublicUpdate({ graph, aiSeq: 2, candidateText: TEXT, publicTurns, segments: [s], verdicts,
    supports: [{ segmentId: s.segmentId, support: "expressed" }] });
  assert.deepEqual(result.candidates[0].targets, []); assert.equal(result.candidates[0].issueId, null); assert.equal(result.candidates[0].respondsTo, null);
  assert.deepEqual(result.diagnostics, ["antecedent_ignored_independent"]);
  const inconsistent = verifyAiPublicUpdate({ graph, aiSeq: 2, candidateText: TEXT, publicTurns,
    segments: [segment({ aspect: "orientation" })], verdicts: [{ ...verdicts[0], act: "agree" }], supports: [{ segmentId: "s1", support: "expressed_responds" }] });
  assert.equal(inconsistent.candidates.length, 0); assert.equal(inconsistent.rejected[0].reason, "inconsistent_claim_response");
});

test("SA-17: stale work from an existing committed pending leaves old publication and pending intact", async () => {
  const config: any = {}, h = harness(config), first = await h.run(), before = JSON.stringify(first.privateState);
  const hold = pause(), entered = pause(), controller = new AbortController();
  config.onCall = async (phase: string) => { if (phase === "generation") { entered.release(); await hold.promise; } };
  const pending = h.next(first, "次の発話", { signal: controller.signal }); await entered.promise; controller.abort();
  await assert.rejects(pending, (e: any) => e.code === "aborted"); hold.release();
  assert.equal(JSON.stringify(first.privateState), before); assert.equal(first.privateState.aiPublic.pending.aiSeq, 2);
  assert.equal(h.events[1].text, first.text); assert.equal(h.records[1].publicSpeech, null); assert.equal(h.records[1].aiPublic?.pending, null);
});

test("SA-18: human local failure retains staged pub and names; whole-turn generation failure rolls them back", async () => {
  const config: any = { text: "「馬」と呼ぶのはどうでしょう？" + TEXT, decision: { action: "propose_name", target: { kind: "single", figureId: ids[0] }, name: "馬", feature: null, observe: null } };
  const h = harness(config), first = await h.run(); config.fail = "local_extraction";
  const second = await h.next(first);
  assert.deepEqual(aiClaims(second.privateState).map(c => c.id), ["3:pub1", "3:pub2", "3:ai1"]);
  assert.equal(h.records[1].local?.localStatus, "error"); assert.deepEqual(h.records[1].local?.aiClaims, []);
  assert.deepEqual(h.records[1].aiPublic?.application?.nameIds, ["3:ai1"]);
  const before = JSON.stringify(first.privateState); config.fail = "generation";
  await assert.rejects(h.run(first.privateState), (e: any) => e.code === "generation_failed");
  assert.equal(JSON.stringify(first.privateState), before); assert.equal(first.privateState.aiPublic.log.length, 0);
});

function pendingFrom(count: number, text = TEXT): AiPublicPending {
  const verified = verifyAiPublicUpdate({ graph: createReferenceGraph({ slots: ids }), aiSeq: 2, candidateText: text, publicTurns: [],
    segments: Array.from({ length: count }, (_, i) => segment({ segmentId: `s${i + 1}` })),
    verdicts: Array.from({ length: count }, (_, i) => ({ segmentId: `s${i + 1}`, act: "assert", respondsToClaimId: null, rawScore: null })),
    supports: Array.from({ length: count }, (_, i) => ({ segmentId: `s${i + 1}`, support: "expressed" })) });
  return { aiSeq: 2, textSha256: hash(text), status: "ready", reasons: [], candidates: verified.candidates };
}
async function preflight(pending: AiPublicPending, extra: any = {}) {
  const graph = extra.graph ?? createReferenceGraph({ slots: ids }), text = extra.text ?? TEXT;
  return prependAiPublic({ graph, update: { expectedRevision: graph.revision, turn: 3, operations: [] },
    state: { ...initialAiPublicState(), pending }, events: [{ seq: 2, speaker: "ai", text }],
    publicTurns: extra.publicTurns ?? [{ turn: 2, speaker: "ai", text }], priorAct: extra.priorAct });
}

test("SA-19(a,b,e,f): pub set is atomic across pre-capacity and structural validation; name recovery keeps its boundary", async () => {
  const excess = await preflight(pendingFrom(17));
  assert.deepEqual(excess.application.reasons, ["op_limit_pre"]); assert.deepEqual(excess.update.operations, []);
  const text = "「馬」と呼ぶのはどうでしょう？" + TEXT;
  const names = await preflight(pendingFrom(16, text), { text, priorAct: { turn: 2, action: "propose_name", targetSlot: ids[0], candidateName: "馬", discriminatingFeature: null } });
  assert.deepEqual(names.application.reasons, ["op_limit_pre"]); assert.deepEqual(names.update.operations.map(o => o.id), ["3:ai1"]);
  const exact = await preflight(pendingFrom(16)); assert.equal(exact.update.operations.length, REFERENCE_LIMITS.operations);
  assert.equal(exact.application.status, "applied");
  const bad = pendingFrom(2); bad.candidates[1].quote = "not public";
  const rejected = await preflight(bad); assert.deepEqual(rejected.update.operations, []); assert.equal(rejected.application.status, "not_applied");
  assert.deepEqual(rejected.application.reasons, ["structural_rejection"]);
});

for (const response of [false, true]) test(`SA-19(${response ? "d" : "c"})/26: human capacity loss keeps all pub and leaves progress unknown`, async () => {
  const config: any = { segments: Array.from({ length: 16 }, (_, i) => segment({ segmentId: `s${i + 1}` })) };
  const h = harness(config), first = await h.run();
  first.privateState.repairHistory = [{ turn: 1, issueId: null, action: "repair", question: "四角い部分", partnerClaims: [],
    candidatesBefore: [ids[0]], candidatesAfter: [ids[0]], addedClaimIds: [], removedClaimIds: [], progress: "unknown" }];
  first.privateState.judgments[0].judgment.action = "repair";
  config.humanSegments = [segment({ quote: "四角はあるね", proposition: "四角い部分がある" })];
  config.humanActs = [response ? "agree" : "assert"]; config.humanTargets = [response ? "3:pub1" : null];
  const second = await h.next(first, "四角はあるね");
  assert.equal(aiClaims(second.privateState).length, 16);
  assert.ok(h.records[1].local?.verification.rejected.some(r => r.reason === "memory_invalid_update"));
  assert.equal(second.privateState.repairHistory[0].progress, "unknown");
  assert.ok(second.privateState.repairHistory[0].missingReasons.includes("human_capacity_dropped"));
  assert.equal(priorClaimViews(second.privateState.graph, { limit: 160 }).filter(c => c.speaker === "human").length, 0);
});

test("SA-19: pruned and out-of-window antecedents remain not_applied, with no partial pub", async () => {
  const base = prior(), graph = graphWith([base]), pending = pendingFrom(2);
  Object.assign(pending.candidates[1], { act: "agree", issueId: base.issueId, respondsTo: base.id });
  const pruned = await preflight(pending);
  assert.deepEqual(pruned.application.reasons, ["prior_pruned"]); assert.deepEqual(pruned.update.operations, []);
  const outside = await preflight(pending, { graph });
  assert.deepEqual(outside.application.reasons, ["source_out_of_window"]); assert.deepEqual(outside.update.operations, []);
  const missingSource = await preflight(pendingFrom(1), { publicTurns: [] });
  assert.deepEqual(missingSource.application.reasons, ["source_out_of_window"]);
});

test("SA-20: support parser rejects missing, extra, duplicate identity, unknown and malformed choices", () => {
  const payload = buildJevAiSupportPayload({ ...extractionInput(), segments: pair(), priorClaims: [],
    verdicts: pair().map(s => ({ segmentId: s.segmentId, act: "assert", respondsToClaimId: null, rawScore: null })) });
  const valid = answer(payload, () => "expressed"); assert.equal(parseJevAiSupport(valid.answers, payload).length, 2);
  const missing: any = structuredClone(valid.answers); delete missing.segment_0_support;
  const extra = { ...valid.answers, extra: valid.answers.segment_0_support };
  const unknown: any = structuredClone(valid.answers); unknown.segment_0_support.choice = "expressed_responds";
  for (const bad of [missing, extra, unknown, [valid.answers.segment_0_support, valid.answers.segment_0_support]]) assert.throws(() => parseJevAiSupport(bad, payload));
  const duplicate = structuredClone(payload), state = JSON.parse(duplicate.state); state.segments[1].segmentId = state.segments[0].segmentId; duplicate.state = JSON.stringify(state);
  assert.throws(() => parseJevAiSupport(valid.answers, duplicate));
});

test("SA-21: one deadline shares residual time; separate transport costs persist and parser failures retain bills", async t => {
  let clock = 0;
  const config: any = { timeoutMs: 1000, cost: 0.03, onCall: async (phase: string) => { if (phase === "ai_extraction") clock += 100; },
    onFetch: async (phase: string) => { if (phase === "ai_function") clock += 100; } };
  // A controlled monotonic clock makes residual budgets deterministic without a latency threshold.
  const timers: number[] = [], originalTimer = setTimeout;
  t.mock.method(globalThis, "setTimeout", ((fn: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    timers.push(ms ?? 0); return originalTimer(fn, ms, ...args);
  }) as typeof setTimeout);
  t.mock.method(performance, "now", () => clock);
  {
    const h = harness(config), first = await h.run();
    const stages = h.records[0].aiPublic!.stages;
    assert.equal(h.calls.find(c => c.phase === "ai_extraction").timeoutMs, 1000);
    assert.equal(stages.ai_function.costUsd, 0.03); assert.equal(stages.ai_support.costUsd, 0.03);
    assert.equal(stages.ai_function.callIndex, 1); assert.equal(stages.ai_support.callIndex, 1);
    assert.ok(timers.includes(900), "function gets only the post-extraction residual budget");
    assert.ok(timers.includes(800), "support gets only the post-function residual budget");
    await h.next(first);
    assert.equal(h.network.filter(c => c.phase === "ai_function").length, 1, "second source cannot reset the instance cap");
    assert.equal(h.records[1].aiPublic?.pending?.status, "failed");
  }
  t.mock.restoreAll();
  const broken = harness({ patchReply: (phase: string, data: any) => phase === "ai_function" ? { ...data, answers: {} } : data });
  await broken.run();
  assert.equal(broken.records[0].aiPublic?.stages.ai_function.status, "error");
  assert.equal(broken.records[0].aiPublic?.stages.ai_function.costUsd, 0.001);
  assert.equal(broken.records[0].aiPublic?.stages.ai_function.error, "invalid_response");
  assert.deepEqual(broken.records[0].aiPublic?.stages.ai_function.choices, []);
});

for (const act of ["acknowledge", "unknown"]) test(`SA-22: ${act} has no claim and skips support`, async () => {
  const h = harness({ act }), first = await h.run();
  assert.deepEqual(first.privateState.aiPublic.pending.candidates, []); assert.equal(h.network.length, 1);
  assert.equal(h.records[0].aiPublic?.stages.ai_support.status, "skipped");
  assert.equal(h.records[0].aiPublic?.stages.ai_support.calls, 0);
});

test("SA-23/24/25: both strategies send identical three-stage bytes and no images; memo hash is the generating snapshot", async () => {
  const a = harness({ strategy: "repair-first", dialogue: true }), b = harness({ strategy: "bypass-enabled", dialogue: true });
  await a.run(); await b.run();
  const extraction = (h: ReturnType<typeof harness>) => JSON.stringify(h.calls.filter(c => c.phase === "ai_extraction").map(c => c.messages));
  assert.equal(extraction(a), extraction(b)); assert.equal(JSON.stringify(a.network), JSON.stringify(b.network));
  assert.doesNotMatch(extraction(a) + JSON.stringify(a.network), /image_url|base64|U1lOVEhFVElD|strategy|PRIVATE_PLAN/);
  assert.deepEqual(a.records[0].aiPublic!.observationMemo, { version: 1, sha256: hash(JSON.stringify(memo())) });
});

function progressCase() {
  const history: RepairHistoryEntry[] = [{ turn: 1, issueId: null, action: "repair", question: "四角い部分", partnerClaims: [],
    candidatesBefore: ids.slice(0, 2), candidatesAfter: ids.slice(0, 2), addedClaimIds: [], removedClaimIds: [], progress: "unknown" }];
  const independent = prior({ id: "3:local1", turn: 3, sourceTurn: 3, targets: ids.slice(0, 2), proposition: "独立した新情報" });
  return { history, independent };
}
for (const item of [
  { oracle: 26, humanOk: true, rejected: [{ segmentId: "s1", reason: "memory_invalid_update" }], aiComplete: true, expected: "unknown", reason: "human_capacity_dropped" },
  { oracle: 28, humanOk: true, rejected: [], aiComplete: true, expected: "unchanged", reason: null },
  { oracle: 29, humanOk: false, rejected: [], aiComplete: true, expected: "unknown", reason: "human_local_missing" },
  { oracle: 7, humanOk: true, rejected: [], aiComplete: false, expected: "unknown", reason: "ai_source_incomplete" },
]) test(`SA-${item.oracle}: progress missing-data boundary ${item.reason ?? "complete"}`, () => {
  const { history } = progressCase();
  const next = updateRepairHistory(history, [], [], 3, { answeredRepairTurn: 1, aiPublic: item }) as any;
  assert.equal(next[0].progress, item.expected);
  assert.deepEqual(next[0].missingReasons, item.reason ? [item.reason] : []);
  assert.equal(history[0].progress, "unknown");
});

test("SA-27: accepted independent information keeps changed and retains partial capacity diagnostics", () => {
  const { history, independent } = progressCase();
  const rejected = [{ segmentId: "s2", reason: "memory_invalid_update" }];
  const next = updateRepairHistory(history, [], [independent], 3, { answeredRepairTurn: 1,
    aiPublic: { humanOk: true, rejected, aiComplete: false } }) as any;
  assert.equal(next[0].progress, "changed"); assert.deepEqual(next[0].addedClaimIds, [independent.id]);
  assert.deepEqual(next[0].humanRejections, rejected); assert.deepEqual(next[0].missingReasons, ["human_capacity_dropped", "ai_source_incomplete"]);
});

test("SA-30: on cannot update an unrelated older unknown repair", () => {
  const { history, independent } = progressCase();
  const next = updateRepairHistory(history, [], [independent], 3, { answeredRepairTurn: 2,
    aiPublic: { humanOk: true, rejected: [], aiComplete: true } });
  assert.deepEqual(next, history);
});

test("SA-21: AI adapters never overwrite the human adapter's evidence", async () => {
  const human = createJevLocalTestClassifier({ enabled: true, readKey: async () => KEY, fetchImpl: async (_url, init) => {
    const payload = JSON.parse(init.body as string);
    return Response.json(answer(payload, name => name.endsWith("_act") ? "assert" : "none"));
  } })!;
  let humanSnapshot: unknown;
  const h = harness({ classifier: human, humanSegments: [segment({ quote: "四角い部分がある" })],
    onCall: async (phase: string) => { if (phase === "ai_extraction") humanSnapshot = human.lastEvidence; } });
  h.events[0].text = "四角い部分がある";
  await h.run();
  assert.deepEqual(human.lastEvidence, humanSnapshot); assert.equal(human.callCount, 1);
  assert.equal(human.lastEvidence?.status, "ok"); assert.equal(human.lastEvidence?.costUsd, 0.001);
  assert.equal(h.records[0].aiPublic?.stages.ai_function.status, "ok"); assert.equal(h.records[0].aiPublic?.stages.ai_support.status, "ok");
  assert.equal(h.records[0].aiPublic?.stages.ai_function.choices[0].rawScore, 1);
  assert.equal(h.records[0].aiPublic?.stages.ai_support.choices[0].rawScore, 1);
});

test("SA-25: later targeted reobservation cannot alter the earlier generation snapshot", async () => {
  const h = harness({ decision: (input: any) => input.turn === 3 && input.reobservationAllowed ? {
    action: "request_observation", target: { kind: "single", figureId: ids[0] }, name: null, feature: null,
    observe: { figureIds: [ids[0]], aspect: "part", question: "四角い部分", partnerConstrual: null } } : accept });
  const first = await h.run(), old = JSON.stringify(h.calls.find(c => c.phase === "ai_extraction"));
  await h.next(first);
  const requests = h.calls.filter(c => c.phase === "ai_extraction").map(c => JSON.parse(c.messages[1].content));
  assert.equal(JSON.stringify(h.calls.find(c => c.phase === "ai_extraction")), old);
  assert.equal(requests[0].observations.figures[0].reobservations.length, 0);
  assert.equal(requests[1].observations.figures[0].reobservations.length, 1);
  assert.equal(h.records[0].aiPublic?.observationMemo?.sha256, hash(JSON.stringify(requests[0].observations)));
  assert.equal(h.records[1].aiPublic?.observationMemo?.sha256, hash(JSON.stringify(requests[1].observations)));
});

test("SA-17: queue keeps an existing public pending while aborting a superseded generation", async () => {
  const config: any = {}, h = harness(config), queue = createHumanMessageQueue({ runAiTurn: h.runtime.runAiTurn, initialPrivateState: h.runtime.initialPrivateState() });
  queue.enqueue({ text: "形を教えてください" }); await queue.whenIdle();
  const old = JSON.stringify(queue.getPrivateState()), oldEvent = queue.getSnapshot().events[1];
  const entered = pause(), hold = pause(); let generations = 0;
  config.onCall = async (phase: string) => { if (phase === "generation" && ++generations === 1) { entered.release(); await hold.promise; } };
  queue.enqueue({ text: "次の形" }); await entered.promise;
  assert.equal(JSON.stringify(queue.getPrivateState()), old);
  queue.enqueue({ text: "訂正した発話" }); await queue.whenIdle(); hold.release();
  const installed = queue.getPrivateState() as any;
  assert.deepEqual(queue.getSnapshot().events.filter((e: any) => e.speaker === "ai").map((e: any) => e.seq), [2, 5]);
  assert.deepEqual(queue.getSnapshot().events[1], oldEvent);
  assert.equal(installed.aiPublic.log[0].aiSeq, 2); assert.equal(installed.aiPublic.log[0].appliedAtTurn, 4);
  assert.equal(installed.aiPublic.pending.aiSeq, 5);
  assert.equal(h.records[1].status, "aborted"); assert.equal(h.records[1].publicSpeech, null);
});

test("SA-9/10: bounded log records omission and never infers omitted application from a committed receipt", async () => {
  const h = harness(), first = await h.run(), pending = pendingFrom(1);
  pending.aiSeq = 130; pending.candidates[0].sourceTurn = 130; pending.candidates[0].candidateKey = "130#1";
  const state = initialAiPublicState();
  state.pending = pending;
  state.log = Array.from({ length: 64 }, (_, i) => ({ aiSeq: 2 + i * 2, status: "empty" as const, reasons: [], appliedAtTurn: 3 + i * 2, ids: [] }));
  validateAiPublicState(state, ids, 130);
  const graph = createReferenceGraph({ slots: ids });
  const pre = await prependAiPublic({ graph, update: { expectedRevision: 0, turn: 131, operations: [] }, state,
    events: [{ seq: 130, speaker: "ai", text: TEXT }], publicTurns: [{ turn: 130, speaker: "ai", text: TEXT }] });
  assert.equal(pre.state.log.length, 64); assert.equal(pre.state.omitted, 1); assert.equal(pre.state.log[0].aiSeq, 4);
  first.privateState.aiPublic = pre.state;
  const settled = await settleAiPublicClaims(h.records, first.privateState);
  assert.equal(settled[0].status, "published_unknown"); assert.equal(settled[0].sourceStatus, "unknown");
});

test("SA-5/22: empty extraction and name-only extraction skip both Jev calls without invented success", async () => {
  const h = harness({ segments: [] }); await h.run();
  assert.deepEqual(h.network, []);
  assert.equal(h.records[0].aiPublic?.stages.ai_function.status, "skipped"); assert.equal(h.records[0].aiPublic?.stages.ai_function.calls, 0);
  assert.equal(h.records[0].aiPublic?.stages.ai_support.status, "skipped"); assert.equal(h.records[0].aiPublic?.stages.ai_support.costUsd, null);
});

for (const phase of ["ai_function", "ai_support"]) {
  test(`SA-21: ${phase} model check retains cost and safe error`, async () => {
    const h = harness({ patchReply: (stage: string, data: any) => stage === phase ? { ...data, model: "MODEL_PRIVATE_CANARY" } : data });
    const first = await h.run(), evidence = h.records[0].aiPublic!.stages[phase as "ai_function" | "ai_support"];
    assert.equal(first.privateState.aiPublic.pending.status, "failed");
    assert.equal(evidence.error, "model_mismatch"); assert.equal(evidence.costUsd, 0.001); assert.equal(evidence.model, null);
    assert.ok(!JSON.stringify(h.records).includes("CANARY"));
  });
  test(`SA-21: ${phase} unknown cost halts its long-lived instance`, async () => {
    const h = harness({ patchReply: (stage: string, data: any) => stage === phase ? { ...data, usage: {} } : data });
    const first = await h.run();
    assert.equal(h.records[0].aiPublic!.stages[phase as "ai_function" | "ai_support"].error, "cost_unreported");
    assert.equal(h.records[0].aiPublic!.stages[phase as "ai_function" | "ai_support"].costUsd, null);
    await h.next(first);
    assert.equal(h.network.filter(c => c.phase === phase).length, 1);
    assert.equal(h.records[1].aiPublic!.stages[phase as "ai_function" | "ai_support"].error, "cost_cap");
    if (phase === "ai_support") assert.equal(h.network.filter(c => c.phase === "ai_function").length, 2);
  });
}
const repair = { action: "repair", target: { kind: "single", figureId: ids[0] }, name: null, feature: "四角い部分", observe: null };

test("SA-27: runtime preserves changed from accepted independent information when another human operation exceeds capacity", async () => {
  const config: any = { decision: repair, segments: Array.from({ length: 15 }, (_, i) => segment({ segmentId: `s${i + 1}` })) };
  const h = harness(config), first = await h.run();
  config.humanSegments = [segment({ quote: "三角がある", proposition: "三角がある" }), segment({ segmentId: "s2", quote: "四角はあるね" })];
  const second = await h.next(first, "三角がある。四角はあるね");
  const entry = second.privateState.repairHistory[0];
  assert.equal(entry.progress, "changed"); assert.deepEqual(entry.addedClaimIds, ["3:local1"]);
  assert.deepEqual(entry.missingReasons, ["human_capacity_dropped"]);
  assert.ok(entry.humanRejections.some((r: any) => r.reason === "memory_invalid_update"));
});

test("SA-7/27: runtime keeps independent changed despite a partially verified AI source", async () => {
  const config: any = { decision: repair, patchReply: (stage: string, data: any) => {
    if (stage !== "ai_support") return data;
    const answer = data.answers.segment_1_support;
    answer.choice = "not_expressed"; answer.probabilities = { expressed: 0, not_expressed: 1, unclear: 0 };
    return data;
  } };
  const h = harness(config), first = await h.run(); assert.equal(first.privateState.aiPublic.pending.status, "partial");
  config.humanSegments = [segment({ quote: "三角がある", proposition: "三角がある" })];
  const second = await h.next(first, "三角がある");
  assert.equal(second.privateState.aiPublic.log[0].status, "partial");
  assert.equal(second.privateState.repairHistory[0].progress, "changed");
  assert.deepEqual(second.privateState.repairHistory[0].missingReasons, ["ai_source_incomplete"]);
});

test("SA-28/29: runtime distinguishes complete unchanged from missing human extraction", async () => {
  for (const missing of [false, true]) {
    const config: any = { decision: repair }, h = harness(config), first = await h.run();
    config.humanSegments = [segment({ quote: "うん", targets: [], aspect: "progress", proposition: "受け止め" })]; config.humanActs = ["acknowledge"];
    if (missing) config.fail = "local_extraction";
    const second = await h.next(first, "うん"), entry = second.privateState.repairHistory[0];
    assert.equal(entry.progress, missing ? "unknown" : "unchanged");
    assert.deepEqual(entry.missingReasons, missing ? ["human_local_missing"] : []);
  }
});

test("SA-9: restoring a previously inserted source cannot bypass deduplication by omitting its log", async () => {
  const h = harness(), first = await h.run(), second = await h.next(first);
  const restored = structuredClone(second.privateState.aiPublic);
  restored.pending = first.privateState.aiPublic.pending; restored.log = []; restored.omitted = 1;
  assert.throws(() => validateAiPublicState(restored, ids, 4, second.privateState.graph));
});

test("SA-20/21: duplicate JSON answer keys reject after preserving the billed cost", async () => {
  const input = { ...extractionInput(), segments: [segment()], priorClaims: [],
    verdicts: [{ segmentId: "s1", act: "assert" as const, respondsToClaimId: null, rawScore: null }] };
  const checker = createJevAiSupportChecker({ readKey: async () => KEY, fetchImpl: async (_url, init) => {
    const payload = JSON.parse(init.body as string), valid = answer(payload, () => "expressed"), row = JSON.stringify(valid.answers.segment_0_support);
    const raw = JSON.stringify(valid).replace('"segment_0_support":' + row, '"segment_0_support":' + row + ',"segment_0_support":' + row);
    return new Response(raw);
  } });
  await assert.rejects(checker.check(input, { timeoutMs: 1000, signal: new AbortController().signal }), (e: any) => e.code === "invalid_response");
  assert.equal(checker.lastEvidence?.status, "error"); assert.equal(checker.lastEvidence?.costUsd, 0.001); assert.equal(checker.spentUsd, 0.001);
});

test("SA-20/21: a concurrent busy call cannot replace the owned wire-parse check", async () => {
  const entered = pause(), hold = pause();
  const input = { ...extractionInput(), segments: [segment()], priorClaims: [],
    verdicts: [{ segmentId: "s1", act: "assert" as const, respondsToClaimId: null, rawScore: null }] };
  const checker = createJevAiSupportChecker({ readKey: async () => KEY, fetchImpl: async (_url, init) => {
    const payload = JSON.parse(init.body as string), valid = answer(payload, () => "expressed"), row = JSON.stringify(valid.answers.segment_0_support);
    entered.release(); await hold.promise;
    return new Response(JSON.stringify(valid).replace('"segment_0_support":' + row, '"segment_0_support":' + row + ',"segment_0_support":' + row));
  } });
  const options = { timeoutMs: 1000, signal: new AbortController().signal }, first = checker.check(input, options);
  await entered.promise; await assert.rejects(checker.check(input, options), (e: any) => e.code === "busy");
  hold.release(); await assert.rejects(first, (e: any) => e.code === "invalid_response");
  assert.equal(checker.lastEvidence?.callIndex, 2); assert.equal(checker.lastEvidence?.error, "busy"); assert.equal(checker.spentUsd, 0.001);
});
