// Synthetic observations, utterances and local model clients only.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDialogueV2 } from "../dialogue-model/runtime/v2/dialogue-v2.mjs";
import { createMockJevDecisionClient } from "../dialogue-model/runtime/decision/mocks.ts";
import { createJevDecisionClient, buildHumanReferentPayload, JevDecisionError, JEV_DECISION_MODEL, type JevDecisionPayload } from "../dialogue-model/runtime/decision/jev-decision.ts";
import { createHumanMessageQueue } from "../dialogue-model/runtime/web/human-message-queue.mjs";
import { JevTurnError, JEV_GENERATION_ERROR_CODES, normalizeGenerationErrorCode, settleJevTurnTraces, updateRepairHistory, type JevTurnTrace, type JevPrivateState } from "../dialogue-model/runtime/v2/jev-turn.ts";
import { settleLocalTraces, type LocalGroundingResearchRecord } from "../dialogue-model/runtime/v2/local-grounding-turn.ts";
import type { ObservationMemo, ObservationObserver } from "../dialogue-model/runtime/observation/contract.ts";
import type { JevDecision, JevDecisionClient, JevDecisionInput, RepairHistoryEntry, HumanReferentEstimate } from "../dialogue-model/runtime/decision/contract.ts";
import type { LocalClaimView, LocalFunctionClassifier } from "../dialogue-model/runtime/local-grounding/contract.ts";
import { MEMO_LOCAL_EXTRACTION_INSTRUCTIONS } from "../dialogue-model/runtime/local-grounding/extract.ts";
import { ObservationError, type ObservationErrorCode } from "../dialogue-model/runtime/observation/observe.ts";
import { recordAiClaims } from "../dialogue-model/runtime/local-grounding/verify.ts";
import { createReferenceGraph, applyReferenceUpdate } from "../dialogue-model/runtime/memory/reference-graph.mjs";
import { AIConnectionError } from "../dialogue-model/runtime/client.mjs";

const ids = Array.from({ length: 6 }, (_, i) => `s-000${i + 1}`);
const anchors = ids.map((id, x) => ({ id, bbox: { x, y: 0, w: 1, h: 1 }, centroid: { x, y: 0 } }));
const image = { mimeType: "image/png", base64: "U1lOVEhFVElDX09XTl9JTUFHRQ==" };
const memo = (): ObservationMemo => ({ observedAt: "2026-10-20T00:00:00.000Z", figures: anchors.map(a => ({ id: a.id, region: { ...a.bbox },
  holistic: [{ construal: "馬", basis: ["細長い部分"], status: "hypothesis" }], analytic: { shapes: ["四角い部分"], composition: "三角と四角がつながる", relations: ["二つの部分が接する"] },
  unknowns: ["見立ては未確定"], reobservations: [] })) });
const accept = { action: "accept", target: { kind: "none" }, name: null, feature: null, observe: null } as const;
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function harness(extra: Record<string, unknown> = {}) {
  const records: JevTurnTrace[] = [], localRecords: LocalGroundingResearchRecord[] = [], calls: Array<{ messages: any[]; options: any }> = [];
  const inputs: JevDecisionInput[] = []; let initialCalls = 0, targetedCalls = 0, judgeCalls = 0;
  const observer: ObservationObserver = { async observeAll() { initialCalls++; return memo(); }, async reobserve(input) {
    targetedCalls++; return { observedAt: "2026-10-20T00:00:01.000Z", issue: input.issue,
      figures: input.figureIds.map(figureId => ({ figureId, supports: ["牛という見立てを支える二つの尖り"], contradicts: ["蹄は確認できない"], unknown: ["向きは不明"] })) };
  } };
  const classifier: LocalFunctionClassifier = { async classify(input) { return input.segments.map(s => ({ segmentId: s.segmentId, act: "assert", respondsToClaimId: null, rawScore: null })); } };
  const client = { async complete(messages: any[], options: any) {
    calls.push(structuredClone({ messages, options: { ...options, signal: undefined } }));
    if (options.phase === "local_extraction") return { text: "[]" };
    if (options.phase === "final_submission") return { text: JSON.stringify(Object.fromEntries(ids.map(id => [id, ""]))) };
    return { text: "そう見えるんですね。" };
  } };
  const jevDecision = createMockJevDecisionClient(input => { inputs.push(input); return structuredClone(accept); });
  const dialogue = createDialogueV2({ client, image, anchors, strategy: "repair-first", referenceMemory: true, decisionMode: "jev",
    observer, jevDecision, localGrounding: { classifier }, onJevTurnTrace: (r: JevTurnTrace) => records.push(r),
    onLocalGroundingTrace: (r: LocalGroundingResearchRecord) => localRecords.push(r),
    judge: { async judge() { judgeCalls++; throw new Error("Luna must not judge"); } }, ...extra } as any);
  const events = [{ id: "e1", seq: 1, speaker: "human" as const, text: "牛に見えます" }];
  const run = (state = dialogue.initialPrivateState(), overrides: Record<string, unknown> = {}) => dialogue.runAiTurn({ events, privateState: state, lastEventId: "e1", ...overrides });
  return { dialogue, records, localRecords, calls, inputs, events, run, client, observer, classifier,
    counts: () => ({ initialCalls, targetedCalls, judgeCalls }) };
}

test("Jev mode observes once, never calls Luna judge, and sends no image outside observation", async () => {
  const h = harness(), initial = await h.dialogue.initializePrivateState!();
  const before = JSON.stringify(initial);
  const first = await h.run(initial);
  const second = await h.run(first.privateState, { events: [...h.events, { id: "e2", seq: 2, speaker: "ai", text: first.text },
    { id: "e3", seq: 3, speaker: "human", text: "馬にも見えます" }], lastEventId: "e3" });
  await h.dialogue.finalRequest({ events: h.events, privateState: second.privateState });
  assert.deepEqual(h.counts(), { initialCalls: 1, targetedCalls: 0, judgeCalls: 0 });
  assert.equal(JSON.stringify(initial), before);
  assert.ok(h.calls.every(c => c.messages.every(m => typeof m.content === "string")));
  assert.ok(!JSON.stringify(h.calls).includes(image.base64));
  assert.ok(!JSON.stringify(h.calls).includes("repair-first"));
  assert.equal(h.records[0].initialObservation?.figures.length, 6);
  assert.equal(h.records[1].initialObservation, null);
  assert.equal(h.inputs[1].previousAction?.turn, 2);
  assert.deepEqual(h.records.map(r => r.intervention), ["none_pending_researcher_decision", "none_pending_researcher_decision"]);
  assert.deepEqual(settleJevTurnTraces(h.records, second.privateState).map(r => r.status), ["committed", "committed"]);
  assert.deepEqual(settleLocalTraces(h.localRecords, second.privateState).map(r => r.status), ["committed", "committed"]);
});

test("Jev can select agreement directly from a verified human proposal without a Luna action", async () => {
  const inputs: JevDecisionInput[] = [];
  const classifier: LocalFunctionClassifier = { async classify(input) { return input.segments.map(s => ({ segmentId: s.segmentId, act: "name_propose", respondsToClaimId: null, rawScore: null })); } };
  const h = harness({ localGrounding: { classifier }, jevDecision: createMockJevDecisionClient(input => {
    inputs.push(input); return { action: "agree", target: { kind: "single", figureId: ids[0] }, name: "牛", feature: null, observe: null };
  }), client: { async complete(_messages: unknown, options: { phase: string }) {
    return { text: options.phase === "local_extraction" ? JSON.stringify([{ segmentId: "s1", quote: "牛と呼ぼう", targets: [ids[0]], aspect: "name", proposition: "牛という名前を提案する", name: "牛", linkedIssueId: null, respondsToTurn: null }]) : "牛でいいですね。" };
  } } });
  const initial = h.dialogue.initialPrivateState();
  assert.equal(initial.ledger[ids[0]].status, "unassigned");
  const result = await h.run(initial, { events: [{ ...h.events[0], text: "牛と呼ぼう" }] });
  assert.equal(result.privateState.ledger[ids[0]].status, "agreed");
  assert.equal(h.records[0].finalAction?.action, "agree");
  assert.equal(h.counts().judgeCalls, 0);
  assert.ok(!Object.hasOwn(inputs[0], "strategy")); assert.ok(!Object.hasOwn(inputs[0], "lunaAction"));
  assert.equal(h.records[0].local?.claims[0].source, "partner_statement");
  assert.ok(!Object.hasOwn(h.records[0], "decisionRejectionCode"));
});

test("strategies receive the same materials while intervention remains pending", async () => {
  const a = harness({ strategy: "repair-first" }), b = harness({ strategy: "bypass-enabled" });
  await a.run(); await b.run();
  assert.deepEqual(a.inputs, b.inputs);
  const requests = (h: ReturnType<typeof harness>) => h.calls.map(c => ({ phase: c.options.phase, messages: c.messages }));
  assert.deepEqual(requests(a), requests(b));
});

test("a private observation's name cannot establish shared agreement", async () => {
  const h = harness({ jevDecision: createMockJevDecisionClient(() => ({ action: "agree", target: { kind: "single", figureId: ids[0] },
    name: "馬", feature: null, observe: null })) });
  await assert.rejects(h.run(), (e: unknown) => e instanceof JevTurnError && e.code === "invalid_decision" && e.decisionRejectionCode === "agree_without_public_proposal");
  assert.equal(h.records[0].decisions[0].action, "agree");
  assert.equal(h.records[0].publicSpeech, null);
  assert.equal(h.records[0].decisionRejectionCode, "agree_without_public_proposal");
});

test("targeted observation appends only requested evidence, then Jev chooses again", async () => {
  const inputs: JevDecisionInput[] = [];
  const h = harness({ jevDecision: createMockJevDecisionClient(input => {
    inputs.push(input);
    return inputs.length === 1 ? { action: "request_observation", target: { kind: "single", figureId: ids[0] }, name: null, feature: null,
      observe: { figureIds: [ids[0]], aspect: "construal", question: "牛という見立ての根拠と反証", partnerConstrual: "牛" } } : structuredClone(accept);
  }) });
  const result = await h.run();
  assert.deepEqual(h.counts(), { initialCalls: 1, targetedCalls: 1, judgeCalls: 0 });
  assert.deepEqual(h.records[0].decisions.map(d => d.action), ["request_observation", "accept"]);
  assert.equal(inputs[1].reobservationAllowed, false);
  assert.equal(inputs[1].observations.figures[0].reobservations.length, 1);
  assert.deepEqual(result.privateState.observationMemo.figures.slice(1), memo().figures.slice(1));
  assert.deepEqual(result.privateState.observationMemo.figures[0].holistic, memo().figures[0].holistic);
  assert.equal(h.records[0].reobservations[0].result.figures[0].contradicts.length, 1);
  assert.equal(h.records[0].finalAction?.action, "accept");
});

test("Jev failure is typed, emits no speech and cannot mutate local memory", async () => {
  const h = harness({ jevDecision: { async decide() { throw Object.assign(new Error("Bearer SYNTHETIC_PRIVATE_CANARY"), { code: "synthetic_private_canary" }); } } });
  const initial = h.dialogue.initialPrivateState(), before = JSON.stringify(initial);
  await assert.rejects(h.run(initial), (e: unknown) => e instanceof JevTurnError && e.code === "decision_failed");
  assert.equal(JSON.stringify(initial), before);
  assert.equal(h.calls.filter(c => c.options.phase === "generation").length, 0);
  assert.equal(h.records[0].publicSpeech, null);
  assert.ok(!JSON.stringify(h.records).includes("CANARY"));
  assert.equal(settleJevTurnTraces(h.records, initial)[0].status, "error");
});

test("local extraction timeout retains its reason without changing the Jev action", async () => {
  const late = gate();
  const h = harness({ localGrounding: { classifier: { async classify() { throw new Error("must not classify"); } }, timeoutMs: 5 },
    client: { async complete(_messages: unknown, options: { phase: string }) {
      if (options.phase === "local_extraction") { await late.promise; return { text: "[]" }; }
      return { text: "そう見えるんですね。" };
    } } });
  const result = await h.run();
  assert.equal(h.records[0].local?.extractor.errorCode, "timeout");
  assert.equal(h.records[0].finalAction?.action, "accept");
  assert.deepEqual(result.privateState.graph.records, []);
  const before = JSON.stringify(h.records); late.release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.stringify(h.records), before);
});

test("aborted initial observation is shared by the next attempt and completed only once", async () => {
  const entered = gate(), late = gate(); let initialCalls = 0;
  const h = harness({ observer: { async observeAll() { initialCalls++; entered.release(); await late.promise; return memo(); }, async reobserve() { throw new Error("unused"); } } });
  const controller = new AbortController(), initial = h.dialogue.initialPrivateState();
  const first = h.run(initial, { signal: controller.signal }); await entered.promise; controller.abort();
  await assert.rejects(first, { name: "AbortError" });
  const second = h.run(initial); late.release(); await second;
  assert.equal(initialCalls, 1);
  assert.deepEqual(h.records.map(r => r.status), ["aborted", "staged"]);
  assert.equal(h.records[1].initialObservation?.figures.length, 6);
  assert.equal(initial.observationMemo, null);
});

test("failed or excessive reobservation never changes the caller's memo", async () => {
  const request = { action: "request_observation", target: { kind: "single", figureId: ids[0] }, name: null, feature: null,
    observe: { figureIds: [ids[0]], aspect: "construal", question: "牛という見立ての根拠", partnerConstrual: "牛" } } as const;
  const h = harness({ jevDecision: createMockJevDecisionClient(() => structuredClone(request) as any),
    observer: { async observeAll() { return memo(); }, async reobserve() { throw new Error("SYNTHETIC_PRIVATE_CANARY"); } } });
  const initial = await h.dialogue.initializePrivateState!(), before = JSON.stringify(initial);
  await assert.rejects(h.run(initial), (e: unknown) => e instanceof JevTurnError && e.code === "observation_failed");
  assert.equal(JSON.stringify(initial), before); assert.equal(h.records[0].publicSpeech, null);
  const repeated = harness({ jevDecision: createMockJevDecisionClient(() => structuredClone(request) as any) });
  await assert.rejects(repeated.run(), JevTurnError);
  assert.equal(repeated.counts().targetedCalls, 1);
  assert.equal(repeated.records[0].publicSpeech, null);
});

test("private trace redacts image bodies, credentials and memo-extractor prompt echoes", async () => {
  const privateMemo = memo();
  const actInstruction = "Jevが選んだ行動だけを文章にしてください。行動・対象・名前・特徴を変更しないでください。観察メモは仮説で、局所的な支持を図形全体の理解や名称決定へ拡張しないでください。";
  privateMemo.figures[0].unknowns = [image.base64, "Bearer synthetic-private-canary-12345", MEMO_LOCAL_EXTRACTION_INSTRUCTIONS.split("\n")[0], actInstruction];
  const h = harness({ observer: { async observeAll() { return privateMemo; }, async reobserve() { throw new Error("unused"); } } });
  await h.run();
  assert.equal(h.records[0].redacted, true);
  assert.ok(!JSON.stringify(h.records).includes(image.base64));
  assert.ok(!JSON.stringify(h.records).includes("synthetic-private-canary"));
  assert.ok(!JSON.stringify(h.records).includes(MEMO_LOCAL_EXTRACTION_INSTRUCTIONS.split("\n")[0]));
  assert.ok(!JSON.stringify(h.records).includes(actInstruction));
});

test("large observation contexts are split within the existing message budget", async () => {
  const large = memo();
  for (const figure of large.figures) figure.analytic.relations = Array.from({ length: 16 }, (_, i) => `関係${i}` + "形".repeat(230));
  const h = harness({ observer: { async observeAll() { return large; }, async reobserve() { throw new Error("unused"); } } });
  const result = await h.run(); await h.dialogue.finalRequest({ events: h.events, privateState: result.privateState });
  assert.ok(h.calls.every(c => c.messages.every(m => m.content.length <= 20000)));
  assert.ok(h.calls.find(c => c.options.phase === "generation")!.messages.some(m => m.content.startsWith("同じJSON文脈の続き")));
});

test("generation failure and unsafe rewrite keep the entire candidate state unpublished", async () => {
  for (const unsafe of [false, true]) {
    const h = harness({ client: { async complete(_messages: unknown, options: { phase: string }) {
      if (options.phase === "local_extraction") return { text: JSON.stringify([{ segmentId: "s1", quote: "牛に見えます", targets: [ids[0]],
        aspect: "construal", proposition: "牛に見える", name: null, linkedIssueId: null, respondsToTurn: null }]) };
      if (unsafe) return { text: "ownLedger s-ab12 Bearer synthetic-test-secret-12345" };
      throw new Error("SYNTHETIC_PRIVATE_CANARY");
    } } });
    const initial = await h.dialogue.initializePrivateState!(), before = JSON.stringify(initial);
    await assert.rejects(h.run(initial), (e: unknown) => e instanceof JevTurnError && e.code === (unsafe ? "unsafe_generation" : "generation_failed"));
    assert.equal(JSON.stringify(initial), before);
    assert.equal(h.records[0].status, "error"); assert.equal(h.records[0].publicSpeech, null);
    assert.equal(h.records[0].local?.verification.accepted.length, 1, "a verified proposal remains uncommitted when generation fails");
    assert.equal(h.records[0].generationGuard.regenerated, unsafe);
    assert.ok(!JSON.stringify(h.records).includes("secret"));
  }
});

test("a safe guard rewrite publishes the Jev action without choosing another action", async () => {
  let generations = 0;
  const h = harness({ client: { async complete(_messages: unknown, options: { phase: string }) {
    if (options.phase === "local_extraction") return { text: "[]" };
    return { text: ++generations === 1 ? "牛で決まりですね。" : "牛にも見えるんですね。" };
  } } });
  const result = await h.run();
  assert.equal(result.text, "牛にも見えるんですね。");
  assert.equal(h.records[0].generationGuard.regenerated, true);
  assert.equal(h.records[0].finalAction?.action, "accept");
  assert.equal(result.privateState.judgments[0].judgment.action, "accept");
});

test("a superseded decision settles promptly and its late result never installs", async () => {
  const entered = gate(), late = gate(); let decisions = 0;
  const delegate = createMockJevDecisionClient(() => structuredClone(accept));
  const h = harness({ jevDecision: { async decide(input: JevDecisionInput) { if (++decisions === 1) { entered.release(); await late.promise; } return delegate.decide(input); } } });
  const queue = createHumanMessageQueue({ runAiTurn: h.dialogue.runAiTurn, initialPrivateState: await h.dialogue.initializePrivateState!() });
  queue.enqueue({ text: "牛に見えます" }); await entered.promise;
  queue.enqueue({ text: "馬にも見えます" }); await queue.whenIdle();
  assert.deepEqual(h.records.map(r => r.status), ["aborted", "staged"]);
  assert.equal(queue.getPrivateState().judgments.length, 1);
  const before = JSON.stringify(queue.getPrivateState());
  late.release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.stringify(queue.getPrivateState()), before);
  assert.deepEqual(h.counts(), { initialCalls: 1, targetedCalls: 0, judgeCalls: 0 });
});

test("restore keeps observations and uses staged versus installed attempt identities", async () => {
  const first = harness(), a = await first.run();
  const restored = JSON.parse(JSON.stringify(a.privateState)) as JevPrivateState;
  const h = harness({ observer: { async observeAll() { throw new Error("should not reobserve"); }, async reobserve() { throw new Error("unused"); } } });
  const b = await h.run(restored, { events: [...h.events, { id: "e2", seq: 2, speaker: "ai", text: a.text },
    { id: "e3", seq: 3, speaker: "human", text: "牛かもしれません" }], lastEventId: "e3", requestSeq: 7 });
  assert.equal(h.records[0].initialObservation, null);
  assert.equal(settleJevTurnTraces(h.records, restored)[0].status, "superseded");
  assert.equal(settleJevTurnTraces(h.records, b.privateState)[0].status, "committed");
  assert.equal(settleJevTurnTraces([{ ...h.records[0], attemptNumber: 6 }], b.privateState)[0].status, "superseded");
  assert.equal(h.records[0].status, "staged");
});

test("research callback mutation and rejection cannot change the candidate", async () => {
  const h = harness({ onJevTurnTrace: async (record: JevTurnTrace) => { record.finalAction!.action = "close"; throw new Error("SYNTHETIC_PRIVATE_CANARY"); } });
  const result = await h.run(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.privateState.judgments[0].judgment.action, "accept");
  assert.equal(h.dialogue.getAttempts()[0].finalAction.action, "accept");
});

test("progress records repeated content as unchanged, not new information from new ids", () => {
  const claim = { id: "2:local1", turn: 2, issueId: "1:ai1", targets: [ids[0]], aspect: "part", act: "deny", proposition: "四角はない", name: null,
    speaker: "human", sourceTurn: 2, quote: "四角はない", respondsTo: "1:ai1", source: "partner_statement" } as LocalClaimView;
  const history: RepairHistoryEntry[] = [{ turn: 3, issueId: "1:ai1", action: "confirm", question: "四角い部分", partnerClaims: [],
    candidatesBefore: [ids[0]], candidatesAfter: [ids[0]], addedClaimIds: [], removedClaimIds: [], progress: "unknown" }];
  const duplicate = { ...claim, id: "5:local1", turn: 5, sourceTurn: 5 };
  const unchanged = updateRepairHistory(history, [claim], [claim, duplicate], 5);
  assert.equal(unchanged[0].progress, "unchanged"); assert.deepEqual(unchanged[0].addedClaimIds, []);
  const changed = updateRepairHistory(history, [claim], [claim, { ...duplicate, proposition: "三角が二つある" }], 5);
  assert.equal(changed[0].progress, "changed"); assert.deepEqual(changed[0].addedClaimIds, [duplicate.id]);
  assert.equal(history[0].progress, "unknown");
});

function progressFixture(candidates = ids.slice(0, 2)) {
  const claim: LocalClaimView = { id: "5:local1", turn: 5, issueId: "1:ai1", targets: [...candidates], aspect: "part", act: "assert",
    proposition: "三角が二つある", name: null, speaker: "human", sourceTurn: 5, quote: "三角が二つある", respondsTo: "1:ai1", source: "partner_statement" };
  const history: RepairHistoryEntry[] = [{ turn: 3, issueId: "1:ai1", action: "confirm", question: "四角い部分", partnerClaims: [],
    candidatesBefore: [...candidates], candidatesAfter: [...candidates], addedClaimIds: [], removedClaimIds: [], progress: "unknown" }];
  return { claim, history };
}

test("difficulty and backchannels add no figure information or candidate narrowing", () => {
  for (const act of ["defer", "ask", "acknowledge", "withdraw", "revisit"] as const) {
    const { claim, history } = progressFixture();
    const reply = { ...claim, act, targets: [ids[0]], proposition: "まだよく分からない" };
    const result = updateRepairHistory(history, [], [reply], 5)[0];
    assert.equal(result.progress, "unchanged", act);
    assert.deepEqual(result.addedClaimIds, []);
    assert.deepEqual(result.candidatesAfter, history[0].candidatesBefore);
    assert.equal(result.partnerClaims[0].act, act);
    assert.equal(history[0].progress, "unknown");
  }
  for (const aspect of ["progress", "question"] as const) {
    const { claim, history } = progressFixture();
    assert.equal(updateRepairHistory(history, [], [{ ...claim, aspect }], 5)[0].progress, "unchanged");
  }
});

test("all seven information acts can add grounded new content to a repair", () => {
  for (const act of ["assert", "agree", "deny", "construe", "name_propose", "name_accept", "name_reject"] as const) {
    const { claim, history } = progressFixture();
    const aspect = act.startsWith("name_") ? "name" : act === "construe" ? "construal" : "part";
    const proposition = aspect === "name" ? "牛という名前" : aspect === "construal" ? "牛に見える" : claim.proposition;
    const reply = { ...claim, act, aspect, proposition, quote: proposition, name: aspect === "name" ? "牛" : null } as LocalClaimView;
    const result = updateRepairHistory(history, [], [reply], 5)[0];
    assert.equal(result.progress, "changed", act); assert.deepEqual(result.addedClaimIds, [claim.id]);
    assert.deepEqual(result.partnerClaims[0].targets, claim.targets);
  }
});

test("a nonempty strict subset is progress, while expansion and loss of candidates are not", () => {
  for (const change of ["narrowed", "expanded", "unresolved"] as const) {
    const beforeTargets = change === "expanded" ? [ids[0]] : ids.slice(0, 2);
    const { claim, history } = progressFixture(beforeTargets);
    const prior = { ...claim, id: "2:local1", turn: 2, sourceTurn: 2 };
    const nextTargets = change === "narrowed" ? [ids[0]] : change === "expanded" ? ids.slice(0, 2) : [];
    const reply = { ...claim, targets: nextTargets };
    const result = updateRepairHistory(history, [prior], [prior, reply], 5)[0];
    assert.equal(result.progress, change === "narrowed" ? "changed" : "unchanged");
    assert.deepEqual(result.addedClaimIds, [], "a candidate-only change is not a new proposition");
    assert.deepEqual(result.candidatesAfter, nextTargets);
  }
});

test("removal alone remains observable without counting as figure-information progress", () => {
  const { claim, history } = progressFixture();
  const prior = { ...claim, id: "2:local1", turn: 2, sourceTurn: 2 };
  const result = updateRepairHistory(history, [prior], [], 5, { answeredRepairTurn: 3 })[0];
  assert.equal(result.progress, "unchanged"); assert.deepEqual(result.removedClaimIds, [prior.id]);
  assert.deepEqual(result.addedClaimIds, []); assert.deepEqual(result.candidatesAfter, history[0].candidatesBefore);
});

test("unanswered questions stay unknown, but a public reply without verified claims stagnates", () => {
  const { history, claim } = progressFixture();
  assert.equal(updateRepairHistory(history, [], [], 5)[0].progress, "unknown");
  assert.equal(updateRepairHistory(history, [], [], 5, { answeredRepairTurn: 1 })[0].progress, "unknown");
  assert.equal(updateRepairHistory(history, [], [], 5, { answeredRepairTurn: 3 })[0].progress, "unchanged");
  assert.equal(updateRepairHistory(history, [], [], 3, { answeredRepairTurn: 3 })[0].progress, "unknown");
  const other = { ...claim, issueId: "1:other", respondsTo: null, targets: [ids[2]] };
  const result = updateRepairHistory(history, [], [other], 5, { answeredRepairTurn: 3 })[0];
  assert.equal(result.progress, "unchanged"); assert.deepEqual(result.addedClaimIds, []); assert.deepEqual(result.partnerClaims, []);
});

test("new same-figure information can answer a public repair without an explicit claim pointer", () => {
  const { history, claim } = progressFixture([ids[0]]);
  const reply = { ...claim, issueId: "5:local1", respondsTo: null };
  assert.equal(updateRepairHistory(history, [], [reply], 5)[0].progress, "unknown");
  const result = updateRepairHistory(history, [], [reply], 5, { answeredRepairTurn: 3 })[0];
  assert.equal(result.progress, "changed"); assert.deepEqual(result.addedClaimIds, [reply.id]);
});

test("difficulty and an unknown classification stagnate in the actual committed pipeline", async () => {
  let extraction = 0;
  const classifier: LocalFunctionClassifier = { async classify(input) {
    const prior = [...input.priorClaims].reverse().find(c => c.speaker === "ai");
    return input.segments.map(s => ({ segmentId: s.segmentId, act: s.quote === "まだよく分からない" ? "defer" : "unknown", respondsToClaimId: prior?.id ?? null, rawScore: null }));
  } };
  const h = harness({ localGrounding: { classifier }, jevDecision: createMockJevDecisionClient(() => ({ action: "confirm", target: { kind: "single", figureId: ids[0] },
    name: null, feature: "四角い部分", observe: null })), client: { async complete(_messages: unknown, options: { phase: string }) {
    if (options.phase !== "local_extraction") return { text: "四角い部分がある形ですか？" };
    const quote = ++extraction === 2 ? "まだよく分からない" : "さっきと同じところで迷ってる";
    return { text: extraction === 1 ? "[]" : JSON.stringify([{ segmentId: "s1", quote, targets: [ids[0]], aspect: "progress", proposition: quote,
      name: null, linkedIssueId: null, respondsToTurn: null }]) };
  } } });
  const first = await h.run();
  const secondEvents = [...h.events, { id: "e2", seq: 2, speaker: "ai", text: first.text }, { id: "e3", seq: 3, speaker: "human", text: "まだよく分からない" }];
  const second = await h.run(first.privateState, { events: secondEvents, lastEventId: "e3" });
  const third = await h.run(second.privateState, { events: [...secondEvents, { id: "e4", seq: 4, speaker: "ai", text: second.text },
    { id: "e5", seq: 5, speaker: "human", text: "さっきと同じところで迷ってる" }], lastEventId: "e5" });
  assert.deepEqual(third.privateState.repairHistory.map((r: RepairHistoryEntry) => r.progress), ["unchanged", "unchanged", "unknown"]);
  assert.ok(third.privateState.repairHistory.every((r: RepairHistoryEntry) => r.addedClaimIds.length === 0));
  assert.equal(h.records[1].local?.claims[0].act, "defer"); assert.equal(h.records[1].local?.claims[0].aspect, "part");
  assert.equal(h.records[2].local?.claims.length, 0);
});

test("committed confirmations retain partner replies and distinguish repeated information", async () => {
  let extraction = 0;
  const classifier: LocalFunctionClassifier = { async classify(input) {
    const prior = [...input.priorClaims].reverse().find(c => c.speaker === "ai");
    return input.segments.map(s => ({ segmentId: s.segmentId, act: "deny", respondsToClaimId: prior?.id ?? null, rawScore: null }));
  } };
  const h = harness({ localGrounding: { classifier }, jevDecision: createMockJevDecisionClient(() => ({ action: "confirm", target: { kind: "single", figureId: ids[0] },
    name: null, feature: "四角い部分", observe: null })), client: { async complete(_messages: unknown, options: { phase: string }) {
    if (options.phase === "local_extraction") return { text: ++extraction === 1 ? "[]" : JSON.stringify([{ segmentId: "s1", quote: "四角はない", targets: [ids[0]],
      aspect: "part", proposition: "四角はない", name: null, linkedIssueId: null, respondsToTurn: null }]) };
    return { text: "四角い部分がある形ですか？" };
  } } });
  const first = await h.run();
  const secondEvents = [...h.events, { id: "e2", seq: 2, speaker: "ai", text: first.text }, { id: "e3", seq: 3, speaker: "human", text: "四角はない" }];
  const second = await h.run(first.privateState, { events: secondEvents, lastEventId: "e3" });
  const third = await h.run(second.privateState, { events: [...secondEvents, { id: "e4", seq: 4, speaker: "ai", text: second.text },
    { id: "e5", seq: 5, speaker: "human", text: "四角はない" }], lastEventId: "e5" });
  assert.deepEqual(third.privateState.repairHistory.map((r: RepairHistoryEntry) => r.progress), ["changed", "unchanged", "unknown"]);
  assert.equal(third.privateState.repairHistory[1].partnerClaims[0].act, "deny");
  assert.deepEqual(third.privateState.repairHistory[1].addedClaimIds, []);
  assert.equal(third.privateState.repairHistory[0].question, "四角い部分");
});

test("new mode rejects incomplete opt-ins and incompatible legacy decision paths", () => {
  for (const extra of [{ observer: null }, { jevDecision: null }, { referenceMemory: false }, { localGrounding: null },
    { localGrounding: { classifier: {} } }, { maxReobservations: 2 }, { decisionMode: "unknown" },
    { activeDecision: { purpose: "decision_jev", client: { chooseAction() {} } } }]) assert.throws(() => harness(extra));
});

function failingObservation(error: unknown, phase: "initial" | "targeted") {
  return harness({ observer: { async observeAll() { if (phase === "initial") throw error; return memo(); }, async reobserve() { throw error; } },
    jevDecision: createMockJevDecisionClient(() => ({ action: "request_observation", target: { kind: "single", figureId: ids[0] }, name: null, feature: null,
      observe: { figureIds: [ids[0]], aspect: "construal", question: "牛という見立ての根拠", partnerConstrual: "牛" } })) });
}

test("initialization and both observation phases retain only existing fixed error codes", async () => {
  const codes: ObservationErrorCode[] = ["invalid_input", "invalid_json", "invalid_response", "timeout", "aborted", "unavailable"];
  for (const path of ["initialize", "initial", "targeted"] as const) for (const code of codes) {
    const phase = path === "targeted" ? "targeted" : "initial";
    const root = Object.assign(new ObservationError(code), { message: "Bearer SYNTHETIC_PRIVATE_CANARY", response: image.base64 });
    const h = failingObservation(root, phase);
    await assert.rejects(path === "initialize" ? h.dialogue.initializePrivateState!() : h.run(), (error: unknown) => {
      assert.ok(error instanceof JevTurnError);
      assert.equal(error.code, "observation_failed");
      assert.equal(error.observationErrorCode, code); assert.equal(error.observationPhase, phase);
      assert.equal(error.message, "observation_failed");
      assert.ok(!JSON.stringify(error).includes("CANARY")); assert.ok(!JSON.stringify(error).includes(image.base64));
      return true;
    });
    if (path === "initialize") assert.deepEqual(h.records, [], "initialization fails before a human turn exists");
    else {
      assert.equal(h.records[0].observationErrorCode, code); assert.equal(h.records[0].observationPhase, phase);
      assert.equal(h.records[0].publicSpeech, null); assert.equal(h.records[0].status, "error");
      assert.equal(h.dialogue.getAttempts()[0].observationErrorCode, code);
      assert.ok(!JSON.stringify(h.records).includes("CANARY")); assert.ok(!JSON.stringify(h.records).includes(image.base64));
    }
  }
});

test("spoofed, modified and throwing observation codes become unavailable", async () => {
  const modified = Object.assign(new ObservationError("timeout"), { code: "synthetic_private_canary" });
  const getter = new ObservationError("timeout");
  Object.defineProperty(getter, "code", { get() { throw new Error("SYNTHETIC_PRIVATE_CANARY"); } });
  const ownGetter = new JevTurnError("invalid_state");
  Object.defineProperty(ownGetter, "code", { get() { throw new Error("SYNTHETIC_PRIVATE_CANARY"); } });
  const errors: unknown[] = [new Error("SYNTHETIC_PRIVATE_CANARY"), { name: "ObservationError", code: "timeout", response: image.base64 }, modified, getter, ownGetter];
  for (const phase of ["initial", "targeted"] as const) for (const error of errors) {
    const h = failingObservation(error, phase);
    await assert.rejects(h.run(), (failure: unknown) => failure instanceof JevTurnError && failure.observationErrorCode === "unavailable" && failure.observationPhase === phase);
    assert.equal(h.records[0].observationErrorCode, "unavailable");
    assert.ok(!JSON.stringify(h.records).toLowerCase().includes("canary"));
    assert.ok(!JSON.stringify(h.records).includes(image.base64));
  }
});

test("observation abort diagnostics identify the interrupted phase and stay immutable", async () => {
  for (const phase of ["initial", "targeted"] as const) {
    const entered = gate(), late = gate(), controller = new AbortController();
    const pending = async (): Promise<never> => { entered.release(); await late.promise; throw new ObservationError("invalid_json"); };
    // Each attempt below uses a fresh runtime with an observer that ignores abort.
    const observer = { observeAll: phase === "initial" ? pending : async () => memo(), reobserve: pending };
    const runtime = harness({ observer, jevDecision: createMockJevDecisionClient(() => ({ action: "request_observation", target: { kind: "single", figureId: ids[0] }, name: null, feature: null,
      observe: { figureIds: [ids[0]], aspect: "construal", question: "牛の根拠", partnerConstrual: "牛" } })) });
    const running = runtime.run(undefined, { signal: controller.signal }); await entered.promise; controller.abort();
    await assert.rejects(running, (error: unknown) => error instanceof JevTurnError && error.code === "aborted" && error.observationErrorCode === "aborted" && error.observationPhase === phase);
    assert.equal(runtime.records[0].observationErrorCode, "aborted"); assert.equal(runtime.records[0].observationPhase, phase);
    const before = JSON.stringify(runtime.records); late.release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.stringify(runtime.records), before);
  }
});

test("observation failures leave no stale diagnostics on success or unrelated errors", async () => {
  let calls = 0;
  const h = harness({ observer: { async observeAll() { if (++calls === 1) throw new ObservationError("timeout"); return memo(); }, async reobserve() { throw new Error("unused"); } } });
  await assert.rejects(h.run(), JevTurnError); await h.run();
  assert.equal(h.records[0].observationErrorCode, "timeout");
  assert.ok(!Object.hasOwn(h.records[1], "observationErrorCode")); assert.ok(!Object.hasOwn(h.records[1], "observationPhase"));
  const decision = harness({ jevDecision: { async decide() { throw new ObservationError("invalid_json"); } } });
  await assert.rejects(decision.run(), (error: unknown) => error instanceof JevTurnError && error.code === "decision_failed" && error.observationErrorCode === undefined);
  assert.ok(!Object.hasOwn(decision.records[0], "observationErrorCode"));
});

test("ambiguous defer and move_on keep all candidates without changing any ledger entry", async () => {
  for (const action of ["defer", "move_on"] as const) for (const target of [{ kind: "none" }, { kind: "multiple", figureIds: ids.slice(0, 2) }] as const) {
    const h = harness({ jevDecision: createMockJevDecisionClient(() => ({ ...accept, action, target: structuredClone(target) as any })) });
    const initial = h.dialogue.initialPrivateState(), result = await h.run(initial);
    assert.equal(h.records[0].finalAction?.action, action);
    assert.equal(h.records[0].finalAction?.targetSlot, null);
    assert.deepEqual(h.records[0].decisions[0].target, target);
    assert.deepEqual(result.privateState.ledger, initial.ledger);
    const actMessage = h.calls.find(c => c.options.phase === "generation")!.messages.find(m => m.content.startsWith("Jevが選んだ行動"));
    assert.deepEqual(JSON.parse(actMessage.content.split("\n").at(-1)).target, target);
  }
  const h = harness({ jevDecision: createMockJevDecisionClient(() => ({ ...accept, action: "revisit", target: { kind: "multiple", figureIds: ids.slice(0, 2) } })) });
  await assert.rejects(h.run(), (e: unknown) => e instanceof JevTurnError && e.code === "invalid_decision");
  assert.equal(h.records[0].publicSpeech, null);
});

test("multiple-candidate feature confirmation and repair preserve candidate and provenance sets", async () => {
  for (const action of ["confirm", "repair"] as const) for (const shared of [false, true]) {
    const observations = memo(); observations.figures[0].analytic.shapes = ["くぼみがある"];
    if (shared) observations.figures[1].analytic.shapes = ["くぼみがある"];
    const provenance = shared ? ids.slice(0, 2) : [ids[0]];
    const target = { kind: "multiple" as const, figureIds: ids.slice(0, 2) };
    const h = harness({ observer: { async observeAll() { return observations; }, async reobserve() { throw new Error("unused"); } },
      jevDecision: createMockJevDecisionClient(() => ({ action, target, name: null, feature: "くぼみがある", observe: null, detailFigureIds: provenance })),
      client: { async complete(messages: any[], options: { phase: string }) {
        if (options.phase === "local_extraction") return { text: "[]" };
        const message = messages.find(m => m.content.startsWith("Jevが選んだ行動"));
        const received = JSON.parse(message.content.split("\n").at(-1));
        assert.deepEqual(received.target, target); assert.deepEqual(received.detailFigureIds, provenance);
        assert.ok(messages.some(m => m.content.includes("特徴の出典図形であり、対象の確定ではありません")));
        return { text: action === "repair" ? "捉え方を訂正します。くぼみのある形でしょうか？" : "くぼみのある形ですか？" };
      } } });
    const initial = h.dialogue.initialPrivateState();
    initial.ledger[ids[0]] = { status: "tentative", name: "名前A" };
    initial.ledger[ids[1]] = { status: "tentative", name: "名前B" };
    const before = JSON.stringify(initial), result = await h.run(initial);
    assert.equal(JSON.stringify(initial), before); assert.deepEqual(result.privateState.ledger, initial.ledger);
    assert.equal(result.privateState.judgments[0].judgment.action, action);
    assert.equal(result.privateState.judgments[0].judgment.targetSlot, null);
    assert.deepEqual(result.privateState.judgments[0].jevTurn.decision.detailFigureIds, provenance);
    assert.deepEqual(h.records[0].decisions[0].target, target);
    assert.deepEqual(h.records[0].decisions[0].detailFigureIds, provenance);
    assert.deepEqual(result.privateState.repairHistory[0].candidatesBefore, target.figureIds);
  }
});

test("multiple feature provenance must be complete and belong to the selected candidates", async () => {
  for (const provenance of [undefined, [ids[0]], [ids[2]]]) {
    const h = harness({ jevDecision: createMockJevDecisionClient(() => ({ action: "confirm", target: { kind: "multiple", figureIds: ids.slice(0, 2) },
      name: null, feature: "四角い部分", observe: null, ...(provenance ? { detailFigureIds: provenance } : {}) })) });
    await assert.rejects(h.run(), JevTurnError);
    assert.equal(h.records[0].publicSpeech, null); assert.deepEqual(h.dialogue.initialPrivateState().graph.records, []);
  }
});

function jevResponse(payload: JevDecisionPayload, preferences: Record<string, string>, index: number) {
  return new Response(JSON.stringify({ model: JEV_DECISION_MODEL + "-20261014", id: `gen-c-stage-${index}`,
    answers: Object.fromEntries(Object.entries(payload.questions).map(([key, question]) => {
      const selected = preferences[key] ?? (key.startsWith("candidate_") ? "exclude" : Object.keys(question.criteria)[0]);
      return [key, { type: "choice", choice: selected,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map(label => [label, label === selected ? 1 : 0])), confidence: 1 }];
    })), usage: { cost: 0.0001 } }), { headers: { "Content-Type": "application/json" } });
}

test("both real-adapter stage receipts survive the runtime transaction and settlement", async () => {
  const requests: JevDecisionPayload[] = [];
  const jevDecision = createJevDecisionClient({ enabled: true, readKey: async () => "sk-or-SYNTHETIC-c-pipeline-key-000000", fetchImpl: async (_url, init) => {
    const payload = JSON.parse(String(init.body)) as JevDecisionPayload; requests.push(payload);
    if (payload.questions.human_referent) return jevResponse(payload, {}, requests.length);
    return jevResponse(payload, payload.questions.action ? { action: "confirm", target: "multiple", candidate_0: "include", candidate_1: "include" } : { feature: Object.keys(payload.questions.feature.criteria)[0] }, requests.length);
  } })!;
  const h = harness({ jevDecision }), result = await h.run();
  assert.equal(requests.length, 3);
  assert.deepEqual(Object.keys(requests[0].questions), ["human_referent"]);
  assert.deepEqual(Object.keys(requests[2].questions), ["feature"]);
  const evidence = h.records[0].decisions[0].evidence;
  assert.deepEqual(evidence.stages?.map(s => s.stage), ["action_target", "detail"]);
  assert.deepEqual(evidence.stages?.map(s => s.responseId), ["gen-c-stage-2", "gen-c-stage-3"]);
  assert.ok(evidence.stages?.every(s => s.model === JEV_DECISION_MODEL + "-20261014" && s.inputBudget?.stateChars! <= 20000));
  assert.equal(evidence.costUsd, 0.0002);
  assert.equal(h.records[0].humanReferent?.responseId, "gen-c-stage-1");
  assert.equal(h.records[0].humanReferent?.costUsd, 0.0001);
  assert.deepEqual(settleJevTurnTraces(h.records, result.privateState)[0].decisions[0].evidence, evidence);
  assert.deepEqual(result.privateState.judgments[0].jevTurn.decision.target, { kind: "multiple", figureIds: ids.slice(0, 2) });
});

test("name decisions with unresolved or multiple targets fail before detail and publish nothing", async () => {
  for (const action of ["propose_name", "agree"] as const) for (const target of ["none", "multiple"]) {
    let calls = 0;
    const jevDecision = createJevDecisionClient({ enabled: true, readKey: async () => "sk-or-SYNTHETIC-c-pipeline-key-000000", fetchImpl: async (_url, init) => {
      const payload = JSON.parse(String(init.body)) as JevDecisionPayload; calls++;
      if (payload.questions.human_referent) return jevResponse(payload, {}, calls);
      return jevResponse(payload, { action, target, candidate_0: "include", candidate_1: "include" }, calls);
    } })!;
    const h = harness({ jevDecision }), initial = h.dialogue.initialPrivateState();
    await assert.rejects(h.run(initial), (error: unknown) => error instanceof JevTurnError && error.code === "invalid_decision");
    assert.equal(calls, 2); assert.equal(h.records[0].publicSpeech, null); assert.equal(h.records[0].errorCode, "invalid_decision");
    assert.equal(jevDecision.lastEvidence?.rejectionCode, "name_requires_single_target");
    assert.equal(jevDecision.lastEvidence?.stages[0].choices.action, action);
    assert.deepEqual(initial.graph.records, []);
  }
});

test("public AI features retain unresolved candidates without inventing a name or duplicate claim", () => {
  const graph = createReferenceGraph({ slots: ids });
  const publicTurns = [{ turn: 2, speaker: "ai" as const, text: "牛のような、四角い部分がある形ですか？" }];
  const priorAct = { turn: 2, action: "confirm", targetSlot: null, targetCandidates: ids.slice(0, 2), candidateName: "牛", discriminatingFeature: "四角い部分" };
  const before = JSON.stringify(graph), result = recordAiClaims({ graph, turn: 3, publicTurns, priorAct });
  assert.equal(JSON.stringify(graph), before);
  assert.deepEqual(result.rejected, []); assert.equal(result.operations.length, 1);
  assert.deepEqual(result.operations[0], { kind: "claim", id: "3:ai1", issueId: "3:ai1", targets: ids.slice(0, 2), aspect: "part", act: "ask",
    proposition: "四角い部分", name: null, speaker: "ai", sourceTurn: 2, quote: publicTurns[0].text, respondsTo: null, source: "ai_hypothesis" });
  const installed = applyReferenceUpdate(graph, { expectedRevision: graph.revision, turn: 3, operations: result.operations }, { generationSucceeded: true, publicTurns });
  assert.deepEqual(recordAiClaims({ graph: installed, turn: 5, publicTurns, priorAct: { ...priorAct, targetCandidates: [...priorAct.targetCandidates].reverse() } }).operations, []);
  for (const candidates of [[], [ids[0]], [ids[0], ids[0]], [ids[0], "foreign-slot"], [...ids, ids[0]]]) {
    const invalid = recordAiClaims({ graph, turn: 3, publicTurns, priorAct: { ...priorAct, targetCandidates: candidates } });
    assert.deepEqual(invalid.operations, []); assert.deepEqual(invalid.rejected, [{ segmentId: "ai", reason: "invalid_ai_target" }]);
  }
  const fallback = recordAiClaims({ graph, turn: 3, publicTurns, priorAct: { ...priorAct, publishedFallback: true } });
  assert.deepEqual(fallback.operations, []); assert.deepEqual(fallback.rejected, [{ segmentId: "ai", reason: "ai_fallback_utterance" }]);
});

test("agreement and denial can answer the public multiple-candidate AI primary without resolving a figure or name", async () => {
  for (const act of ["agree", "deny"] as const) {
    const text = act === "agree" ? "はい" : "四角い部分はありません";
    let decisions = 0, extractions = 0;
    const classifier: LocalFunctionClassifier = { async classify(input) {
      const primary = input.priorClaims.find(c => c.speaker === "ai" && c.sourceTurn === 2)!;
      assert.ok(primary); assert.deepEqual(primary.targets, ids.slice(0, 2));
      return input.segments.map(s => ({ segmentId: s.segmentId, act, respondsToClaimId: primary.id, rawScore: null }));
    } };
    const h = harness({ localGrounding: { classifier },
      jevDecision: createMockJevDecisionClient(() => ++decisions === 1 ? { action: "confirm", target: { kind: "multiple", figureIds: ids.slice(0, 2) },
        name: null, feature: "四角い部分", observe: null, detailFigureIds: ids.slice(0, 2) } : accept),
      client: { async complete(_messages: unknown, options: { phase: string }) {
        if (options.phase === "local_extraction") return { text: ++extractions === 1 ? "[]" : JSON.stringify([{ segmentId: "reply", quote: text,
          targets: [], aspect: "part", proposition: act === "agree" ? "四角い部分がある" : "四角い部分はない", name: null, linkedIssueId: null, respondsToTurn: 2 }]) };
        return { text: decisions === 1 ? "四角い部分がある形ですか？" : "そう見えるんですね。" };
      } } });
    const first = await h.run();
    const result = await h.run(first.privateState, { events: [...h.events, { id: "e2", seq: 2, speaker: "ai", text: first.text },
      { id: "e3", seq: 3, speaker: "human", text }], lastEventId: "e3" });
    const local = h.records[1].local!;
    assert.equal(local.aiClaims.length, 1); assert.equal(local.claims.length, 1);
    assert.deepEqual(local.aiClaims[0].targets, ids.slice(0, 2)); assert.equal(local.aiClaims[0].id, "3:ai1");
    assert.equal(local.claims[0].act, act); assert.equal(local.claims[0].respondsTo, "3:ai1");
    assert.deepEqual(local.claims[0].targets, ids.slice(0, 2)); assert.deepEqual(local.verification.rejected, []);
    assert.ok([...local.aiClaims, ...local.claims].every(c => c.aspect === "part" && c.name === null));
    assert.deepEqual(result.privateState.ledger, first.privateState.ledger);
    assert.equal(settleLocalTraces(h.localRecords, result.privateState)[1].status, "committed");
  }
});

function referentResult(input: JevDecisionInput): HumanReferentEstimate {
  const payload = buildHumanReferentPayload(input), budget = JSON.parse(payload.state).inputBudget;
  return { status: "ok", scores: Object.fromEntries([...ids, "none", "multiple"].map((id, i) => [id, i < 2 ? 0.731 : 0.217])),
    model: JEV_DECISION_MODEL + "-20261014", responseId: `gen-c-referent-${input.turn}`, costUsd: 0.0001, latencyMs: 7,
    inputBudget: { maxChars: budget.maxChars, stateChars: payload.state.length, omitted: budget.omitted }, calibrated: false };
}

test("human referent raw scores are private evidence independent of the action target", async () => {
  const order: string[] = [], estimates: JevDecisionInput[] = [], decisions: JevDecisionInput[] = [];
  const delegate = createMockJevDecisionClient(input => {
    order.push("decide"); decisions.push(structuredClone(input));
    return { ...accept, action: "confirm", target: { kind: "single", figureId: ids[5] }, feature: "四角い部分" };
  });
  const h = harness({ observer: { async observeAll() { order.push("observe"); return memo(); }, async reobserve() { throw new Error("unused"); } },
    jevDecision: { ...delegate, async estimateReferent(input: JevDecisionInput) { order.push("estimate"); estimates.push(structuredClone(input)); return referentResult(input); } } });
  const result = await h.run(), referent = h.records[0].humanReferent!;
  assert.deepEqual(order, ["observe", "estimate", "decide"]); assert.equal(estimates.length, 1);
  assert.ok(!Object.hasOwn(estimates[0], "humanReferent"));
  assert.deepEqual(referent.scores, referentResult(estimates[0]).scores);
  assert.ok(Object.values(referent.scores!).reduce((a, b) => a + b, 0) > 1, "raw scores are not normalized");
  assert.deepEqual(decisions[0].humanReferent, { status: "ok", scores: referent.scores });
  assert.deepEqual(h.records[0].decisions[0].target, { kind: "single", figureId: ids[5] });
  assert.equal(referent.turnIndex, 1); assert.equal(referent.calibrated, false);
  assert.deepEqual(referent.observationMemo, { version: 1, sha256: createHash("sha256").update(JSON.stringify(memo())).digest("hex") });
  assert.deepEqual(result.privateState.judgments[0].jevTurn.humanReferent, referent);
  assert.deepEqual(result.privateState.graph.records, [], "a score map adds no grounding claim");
  assert.ok(!JSON.stringify({ ledger: result.privateState.ledger, speech: result.text, calls: h.calls }).includes("humanReferent"));
  assert.ok(!JSON.stringify(h.calls).includes("0.731"));
  await h.dialogue.finalRequest({ events: h.events, privateState: result.privateState });
  assert.ok(!JSON.stringify(h.calls).includes("gen-c-referent"));
  const restored = JSON.parse(JSON.stringify(result.privateState));
  assert.deepEqual(settleJevTurnTraces(h.records, restored)[0].humanReferent, referent);
  assert.equal(settleJevTurnTraces(h.records, restored)[0].status, "committed");
});

test("reobservation reuses one estimate while a new human turn estimates the updated memo", async () => {
  const estimates: JevDecisionInput[] = [], decisions: JevDecisionInput[] = [];
  const delegate = createMockJevDecisionClient(input => {
    decisions.push(structuredClone(input));
    return decisions.length === 1 ? { action: "request_observation", target: { kind: "single", figureId: ids[0] }, name: null, feature: null,
      observe: { figureIds: [ids[0]], aspect: "construal", question: "牛という見立ての根拠", partnerConstrual: "牛" } } : structuredClone(accept);
  });
  const h = harness({ jevDecision: { ...delegate, async estimateReferent(input: JevDecisionInput) {
    estimates.push(structuredClone(input)); const result = referentResult(input);
    if (estimates.length > 1) result.scores![ids[0]] = 0.123;
    return result;
  } } });
  const first = await h.run();
  assert.equal(estimates.length, 1); assert.equal(decisions.length, 2);
  assert.deepEqual(decisions[0].humanReferent, decisions[1].humanReferent);
  assert.equal(decisions[0].observations.figures[0].reobservations.length, 0);
  assert.equal(decisions[1].observations.figures[0].reobservations.length, 1);
  assert.equal(h.records[0].humanReferent!.observationMemo.sha256, createHash("sha256").update(JSON.stringify(estimates[0].observations)).digest("hex"));
  const second = await h.run(first.privateState, { events: [...h.events, { id: "e2", seq: 2, speaker: "ai", text: first.text },
    { id: "e3", seq: 3, speaker: "human", text: "牛にも見えるけれど角が違う" }], lastEventId: "e3" });
  assert.equal(estimates.length, 2); assert.equal(estimates[1].observations.figures[0].reobservations.length, 1);
  assert.notEqual(h.records[0].humanReferent!.observationMemo.sha256, h.records[1].humanReferent!.observationMemo.sha256);
  assert.equal(h.records[1].humanReferent!.scores![ids[0]], 0.123);
  assert.deepEqual(second.privateState.judgments[0].jevTurn.humanReferent, first.privateState.judgments[0].jevTurn.humanReferent);
});

test("missing, failed or malformed referent estimates become unknown without leaking their payload", async () => {
  const secret = "Bearer SYNTHETIC_REFERENT_PRIVATE_CANARY";
  const variants: Array<((input: JevDecisionInput) => unknown) | null> = [null,
    () => { throw Object.assign(new Error(secret), { code: "synthetic_private_canary", response: secret }); },
    input => { const r = referentResult(input); delete r.scores![ids[0]]; return r; },
    input => ({ ...referentResult(input), scores: { ...referentResult(input).scores, foreign: 1 } }),
    input => ({ ...referentResult(input), scores: { ...referentResult(input).scores, [ids[0]]: 1.01 } }),
    input => ({ ...referentResult(input), scores: { ...referentResult(input).scores, [ids[0]]: NaN } }),
    input => ({ ...referentResult(input), status: "unknown" }),
    input => ({ ...referentResult(input), model: secret }),
    input => ({ ...referentResult(input), responseId: secret }),
    input => ({ ...referentResult(input), inputBudget: null }),
    input => ({ ...referentResult(input), rawResponse: secret }),
    input => Object.defineProperty(referentResult(input), "scores", { get() { throw new Error(secret); } }),
  ];
  for (const variant of variants) {
    const inputs: JevDecisionInput[] = [];
    const delegate = createMockJevDecisionClient(input => { inputs.push(input); return structuredClone(accept); });
    const jevDecision = { ...delegate, ...(variant ? { async estimateReferent(input: JevDecisionInput) { return variant(input) as HumanReferentEstimate; } } : {}) };
    const h = harness({ jevDecision }), result = await h.run();
    assert.deepEqual(inputs[0].humanReferent, { status: "unknown", scores: null });
    assert.equal(h.records[0].humanReferent!.status, "unknown"); assert.equal(h.records[0].humanReferent!.scores, null);
    assert.equal(h.records[0].humanReferent!.model, null); assert.equal(h.records[0].humanReferent!.responseId, null);
    assert.equal(result.text, "そう見えるんですね。");
    assert.ok(!JSON.stringify({ records: h.records, state: result.privateState }).includes("CANARY"));
  }
  const delegate = createMockJevDecisionClient(() => structuredClone(accept));
  const h = harness({ jevDecision: Object.defineProperty({ ...delegate }, "estimateReferent", { get() { throw new Error(secret); } }) });
  assert.equal((await h.run()).privateState.judgments[0].jevTurn.humanReferent.status, "unknown");
});

test("a validated unknown estimate preserves only its bounded response evidence", async () => {
  const delegate = createMockJevDecisionClient(input => { assert.deepEqual(input.humanReferent, { status: "unknown", scores: null }); return structuredClone(accept); });
  const h = harness({ jevDecision: { ...delegate, async estimateReferent(input: JevDecisionInput) {
    return { ...referentResult(input), status: "unknown", scores: null } as HumanReferentEstimate;
  } } });
  await h.run();
  assert.equal(h.records[0].humanReferent!.status, "unknown");
  assert.equal(h.records[0].humanReferent!.model, JEV_DECISION_MODEL + "-20261014");
  assert.equal(h.records[0].humanReferent!.responseId, "gen-c-referent-1");
  assert.equal(h.records[0].humanReferent!.costUsd, 0.0001);
});

test("referent input, estimator result, decision input and callback snapshots stay detached", async () => {
  let returned: HumanReferentEstimate | null = null;
  const delegate = createMockJevDecisionClient(input => { input.humanReferent!.scores![ids[0]] = 0; return structuredClone(accept); });
  const h = harness({ jevDecision: { ...delegate, async estimateReferent(input: JevDecisionInput) {
    returned = referentResult(input); input.observations.figures[0].analytic.composition = "SYNTHETIC_MUTATED"; return returned;
  } }, onJevTurnTrace(record: JevTurnTrace) { record.humanReferent!.scores![ids[0]] = 0; } });
  const initial = await h.dialogue.initializePrivateState!(), before = JSON.stringify(initial), result = await h.run(initial);
  assert.equal(JSON.stringify(initial), before);
  returned!.scores![ids[0]] = 0;
  assert.equal(result.privateState.judgments[0].jevTurn.humanReferent.scores[ids[0]], 0.731);
  assert.equal(h.dialogue.getAttempts()[0].humanReferent.scores[ids[0]], 0.731);
  assert.equal(result.privateState.observationMemo.figures[0].analytic.composition, memo().figures[0].analytic.composition);
});

test("superseding a pending estimate aborts promptly and its late scores cannot install", async () => {
  const entered = gate(), late = gate(); let estimates = 0, decisions = 0;
  const delegate = createMockJevDecisionClient(() => { decisions++; return structuredClone(accept); });
  const h = harness({ jevDecision: { ...delegate, async estimateReferent(input: JevDecisionInput) {
    if (++estimates === 1) { entered.release(); await late.promise; }
    return referentResult(input);
  } } });
  const queue = createHumanMessageQueue({ runAiTurn: h.dialogue.runAiTurn, initialPrivateState: await h.dialogue.initializePrivateState!() });
  queue.enqueue({ text: "牛に見えます" }); await entered.promise;
  queue.enqueue({ text: "馬にも見えます" }); await queue.whenIdle();
  assert.equal(estimates, 2); assert.equal(decisions, 1);
  assert.deepEqual(h.records.map(r => r.status), ["aborted", "staged"]);
  const installed = queue.getPrivateState(), before = JSON.stringify(installed), records = JSON.stringify(h.records);
  assert.equal(installed.judgments.length, 1); assert.equal(installed.judgments[0].jevTurn.humanReferent.turnIndex, 2);
  late.release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.stringify(queue.getPrivateState()), before); assert.equal(JSON.stringify(h.records), records);
});

test("typed referent cancellation aborts instead of becoming an unknown successful turn", async () => {
  let decisions = 0;
  const h = harness({ jevDecision: { async estimateReferent() { throw new JevDecisionError("aborted"); },
    async decide() { decisions++; throw new Error("must not choose"); } } });
  const initial = h.dialogue.initialPrivateState(), before = JSON.stringify(initial);
  await assert.rejects(h.run(initial), (e: unknown) => e instanceof JevTurnError && e.code === "aborted");
  assert.equal(decisions, 0); assert.equal(JSON.stringify(initial), before);
  assert.equal(h.records[0].status, "aborted"); assert.equal(h.records[0].publicSpeech, null);
});

test("failed generation retains private referent evidence without installing it", async () => {
  const h = harness({ jevDecision: { ...createMockJevDecisionClient(() => structuredClone(accept)), async estimateReferent(input: JevDecisionInput) { return referentResult(input); } },
    client: { async complete(_messages: unknown, options: { phase: string }) { if (options.phase === "local_extraction") return { text: "[]" }; throw new Error("SYNTHETIC_PRIVATE_CANARY"); } } });
  const initial = h.dialogue.initialPrivateState(), before = JSON.stringify(initial);
  await assert.rejects(h.run(initial), (e: unknown) => e instanceof JevTurnError && e.code === "generation_failed");
  assert.equal(JSON.stringify(initial), before); assert.equal(h.records[0].humanReferent!.status, "ok");
  assert.equal(settleJevTurnTraces(h.records, initial)[0].status, "error");
});

test("private referent field echoes are rewritten without estimating or choosing again", async () => {
  for (const safeRewrite of [true, false]) {
    let estimates = 0, decisions = 0, generations = 0;
    const h = harness({ jevDecision: { ...createMockJevDecisionClient(() => { decisions++; return structuredClone(accept); }),
      async estimateReferent(input: JevDecisionInput) { estimates++; return referentResult(input); } },
      client: { async complete(_messages: unknown, options: { phase: string }) {
        if (options.phase === "local_extraction") return { text: "[]" };
        return { text: ++generations > 1 && safeRewrite ? "そう見えるんですね。" : "humanReferent multiple 0.731" };
      } } });
    if (safeRewrite) assert.equal((await h.run()).text, "そう見えるんですね。");
    else await assert.rejects(h.run(), (e: unknown) => e instanceof JevTurnError && e.code === "unsafe_generation");
    assert.equal(estimates, 1); assert.equal(decisions, 1); assert.equal(generations, 2);
    assert.ok(h.records[0].generationGuard.violations.includes("internal_field"));
  }
});

test("strategies supply identical human-referent evidence and requests", async () => {
  const inputs: JevDecisionInput[][] = [[], []];
  const harnesses = ["repair-first", "bypass-enabled"].map((strategy, index) => harness({ strategy,
    jevDecision: { ...createMockJevDecisionClient(() => structuredClone(accept)), async estimateReferent(input: JevDecisionInput) {
      inputs[index].push(structuredClone(input)); return referentResult(input);
    } } }));
  await harnesses[0].run(); await harnesses[1].run();
  assert.deepEqual(inputs[0], inputs[1]);
  assert.deepEqual(harnesses[0].records[0].humanReferent, harnesses[1].records[0].humanReferent);
  assert.deepEqual(harnesses[0].calls.map(c => c.messages), harnesses[1].calls.map(c => c.messages));
});

test("default mode ignores an injected referent estimator and preserves its request, state and trace bytes", async () => {
  let estimates = 0, decisions = 0;
  const judge = { async judge() { return { action: "accept", targetSlot: null, candidateName: null, discriminatingFeature: null, note: null }; } };
  const off = { decisionMode: null, localGrounding: null, judge };
  const plain = harness({ ...off, jevDecision: null });
  const injected = harness({ ...off, jevDecision: { async estimateReferent(input: JevDecisionInput) { estimates++; return referentResult(input); },
    async decide() { decisions++; throw new Error("must not choose"); } } });
  const a = await plain.run(), b = await injected.run();
  assert.equal(estimates, 0); assert.equal(decisions, 0);
  const bytes = (h: ReturnType<typeof harness>, result: unknown) => JSON.stringify({ result, calls: h.calls, attempts: h.dialogue.getAttempts() });
  assert.equal(bytes(plain, a), bytes(injected, b));
  assert.ok(!bytes(injected, b).includes("humanReferent"));
});

test("ordinary references to an uncertain figure do not trigger the private referent-field guard", async () => {
  const text = "指している形はまだ一つに絞れません。";
  let generations = 0;
  const h = harness({ client: { async complete(_messages: unknown, options: { phase: string }) {
    if (options.phase === "local_extraction") return { text: "[]" };
    generations++; return { text };
  } } });
  assert.equal((await h.run()).text, text); assert.equal(generations, 1);
  assert.deepEqual(h.records[0].generationGuard.violations, []);
});

test("typed generation failures keep only closed codes on initial generation and guard rewrite", async () => {
  const codes = ["timeout", "network_error", "invalid_json", "empty_response", "provider_http_error", "policy_http_error", "invalid_policy_response"];
  for (const code of codes) for (const rewrite of [false, true]) {
    let generations = 0;
    const h = harness({ client: { async complete(_messages: unknown, options: { phase: string }) {
      if (options.phase === "local_extraction") return { text: "[]" };
      if (++generations === 1 && rewrite) return { text: "牛で決まりですね。" };
      throw Object.assign(new AIConnectionError(code, 503), { message: "Bearer SYNTHETIC_GENERATION_CANARY", response: "SYNTHETIC_GENERATION_CANARY" });
    } } });
    const initial = h.dialogue.initialPrivateState(), before = JSON.stringify(initial);
    await assert.rejects(h.run(initial), (e: unknown) => e instanceof JevTurnError && e.code === "generation_failed" && e.generationErrorCode === code);
    assert.equal(h.records[0].errorCode, "generation_failed"); assert.equal(h.records[0].generationErrorCode, code);
    assert.equal(h.records[0].generationGuard.regenerated, rewrite); assert.equal(h.records[0].publicSpeech, null);
    assert.equal(JSON.stringify(initial), before);
    assert.ok(!JSON.stringify(h.records).includes("CANARY"));
  }
});

test("untyped, spoofed and modified generation errors cannot inject trace codes or messages", async () => {
  const secret = "Bearer SYNTHETIC_GENERATION_CANARY";
  const errors = [new Error(secret), Object.assign(new Error(secret), { name: "AIConnectionError", code: "timeout", response: secret }),
    Object.assign(new AIConnectionError("timeout"), { code: "synthetic_generation_canary", response: secret }),
    Object.defineProperty(new AIConnectionError("timeout"), "code", { get() { throw new Error(secret); } }),
    { code: "timeout", message: secret }, new JevDecisionError("timeout"),
    Object.assign(new JevTurnError("generation_failed"), { generationErrorCode: "synthetic_generation_canary" })];
  for (const error of errors) {
    const h = harness({ client: { async complete(_messages: unknown, options: { phase: string }) {
      if (options.phase === "local_extraction") return { text: "[]" }; throw error;
    } } });
    await assert.rejects(h.run(), (e: unknown) => e instanceof JevTurnError && e.code === "generation_failed" && e.generationErrorCode === "unavailable");
    assert.equal(h.records[0].generationErrorCode, "unavailable"); assert.ok(!JSON.stringify(h.records).includes("CANARY"));
    assert.ok(!JSON.stringify(h.records).includes("synthetic_generation_canary"));
  }
  for (const code of JEV_GENERATION_ERROR_CODES) {
    const typed = new JevTurnError("generation_failed", undefined, { generationErrorCode: code });
    assert.equal(normalizeGenerationErrorCode(typed), code);
  }
});

test("malformed returned text has a fixed invalid-response diagnosis, while abort stays an abort", async () => {
  for (const reply of [undefined, {}, { text: "" }, { text: "  \n" }, { text: 7 }]) {
    const h = harness({ client: { async complete(_messages: unknown, options: { phase: string }) {
      return options.phase === "local_extraction" ? { text: "[]" } : reply;
    } } });
    await assert.rejects(h.run(), (e: unknown) => e instanceof JevTurnError && e.code === "generation_failed" && e.generationErrorCode === "invalid_response");
    assert.equal(h.records[0].generationErrorCode, "invalid_response");
  }
  const entered = gate(), late = gate();
  const h = harness({ client: { async complete(_messages: unknown, options: { phase: string }) {
    if (options.phase === "local_extraction") return { text: "[]" };
    entered.release(); await late.promise; throw new AIConnectionError("timeout");
  } } });
  const controller = new AbortController(), pending = h.run(undefined, { signal: controller.signal });
  await entered.promise; controller.abort(); await assert.rejects(pending, { name: "AbortError" });
  assert.equal(h.records[0].errorCode, "aborted"); assert.ok(!Object.hasOwn(h.records[0], "generationErrorCode"));
  const before = JSON.stringify(h.records); late.release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.stringify(h.records), before);
});

test("optional antecedent diagnostics keep only fixed fields and normalized segment identifiers", async () => {
  for (const pointer of ["1:local1", "99:missing", "Bearer SYNTHETIC_ANTECEDENT_CANARY"]) {
    let extractions = 0;
    const classifier: LocalFunctionClassifier = { async classify(input) {
      return input.segments.map(s => ({ segmentId: s.segmentId, act: s.aspect === "name" ? "name_propose" : "assert", respondsToClaimId: s.aspect === "name" ? pointer : null, rawScore: null }));
    } };
    const h = harness({ localGrounding: { classifier }, client: { async complete(_messages: unknown, options: { phase: string }) {
      if (options.phase !== "local_extraction") return { text: "そう見えるんですね。" };
      const first = ++extractions === 1;
      return { text: JSON.stringify([{ segmentId: first ? "s1" : "SYNTHETIC_SEGMENT_CANARY", quote: first ? "四角い部分があります" : "馬と呼ぼう",
        targets: first ? [ids[0]] : [], aspect: first ? "part" : "name", proposition: first ? "四角い部分がある" : "馬という名前を提案する",
        name: first ? null : "馬", linkedIssueId: null, respondsToTurn: first ? null : 2 }]) };
    } } });
    const events = [{ ...h.events[0], text: "四角い部分があります" }], first = await h.run(undefined, { events });
    const second = await h.run(first.privateState, { events: [...events, { id: "e2", seq: 2, speaker: "ai", text: first.text },
      { id: "e3", seq: 3, speaker: "human", text: "馬と呼ぼう" }], lastEventId: "e3" });
    const record = h.records[1].local!, dropped = pointer === "1:local1";
    assert.deepEqual(record.verification.diagnostics, [{ segmentId: "segment_1", reason: dropped ? "antecedent_dropped" : "antecedent_missing",
      respondsToClaimId: pointer.includes("CANARY") ? null : pointer, resolvedIssueId: "3:local1" }]);
    assert.equal(record.claims[0].act, "name_propose"); assert.deepEqual(record.claims[0].targets, []);
    assert.equal(record.claims[0].respondsTo, null); assert.equal(record.claims[0].issueId, "3:local1");
    assert.deepEqual(settleLocalTraces(h.localRecords, second.privateState)[1].verification.diagnostics, record.verification.diagnostics);
    assert.ok(!JSON.stringify(h.records).includes("CANARY"));
  }
});

test("an independently preserved but unresolved name proposal still cannot authorize a single-figure agreement", async () => {
  let extractions = 0, decisions = 0;
  const classifier: LocalFunctionClassifier = { async classify(input) {
    return input.segments.map(s => ({ segmentId: s.segmentId, act: s.aspect === "name" ? "name_propose" : "assert", respondsToClaimId: s.aspect === "name" ? "1:local1" : null, rawScore: null }));
  } };
  const h = harness({ localGrounding: { classifier }, jevDecision: createMockJevDecisionClient(() => ++decisions === 1 ? structuredClone(accept)
    : { ...accept, action: "agree", target: { kind: "single", figureId: ids[0] }, name: "馬" }),
    client: { async complete(_messages: unknown, options: { phase: string }) {
      if (options.phase !== "local_extraction") return { text: "そう見えるんですね。" };
      const first = ++extractions === 1;
      return { text: JSON.stringify([{ segmentId: "s1", quote: first ? "四角い部分があります" : "馬と呼ぼう", targets: first ? [ids[0]] : [],
        aspect: first ? "part" : "name", proposition: first ? "四角い部分がある" : "馬という名前を提案する", name: first ? null : "馬",
        linkedIssueId: null, respondsToTurn: first ? null : 2 }]) };
    } } });
  const events = [{ ...h.events[0], text: "四角い部分があります" }], first = await h.run(undefined, { events });
  const before = JSON.stringify(first.privateState);
  await assert.rejects(h.run(first.privateState, { events: [...events, { id: "e2", seq: 2, speaker: "ai", text: first.text },
    { id: "e3", seq: 3, speaker: "human", text: "馬と呼ぼう" }], lastEventId: "e3" }),
    (e: unknown) => e instanceof JevTurnError && e.code === "invalid_decision" && e.decisionRejectionCode === "agree_without_public_proposal");
  assert.equal(JSON.stringify(first.privateState), before);
  assert.equal(h.records[1].local!.claims[0].act, "name_propose"); assert.deepEqual(h.records[1].local!.claims[0].targets, []);
  assert.equal(h.records[1].decisionRejectionCode, "agree_without_public_proposal"); assert.equal(h.records[1].publicSpeech, null);
});

test("S1-c: none repair/confirm cannot publish or change state even with included candidates", async () => {
  for (const action of ["repair", "confirm"]) {
    const requests: JevDecisionPayload[] = [];
    const jevDecision = createJevDecisionClient({ enabled: true, readKey: async () => "sk-or-SYNTHETIC-slice1-000000", fetchImpl: async (_url, init) => {
      const payload = JSON.parse(String(init.body)) as JevDecisionPayload; requests.push(payload);
      return jevResponse(payload, { action, target: "none", candidate_0: "include", candidate_1: "include" }, requests.length);
    } })!;
    const h = harness({ jevDecision }), initial = h.dialogue.initialPrivateState();
    initial.ledger[ids[0]] = { status: "agreed", name: "舟" };
    const before = structuredClone(initial);
    await assert.rejects(h.run(initial), (error: unknown) => error instanceof JevTurnError && error.code === "invalid_decision");
    assert.deepEqual(initial, before);
    assert.equal(requests.length, 2); // Separate human-referent call, then action/target; no detail.
    assert.deepEqual(Object.keys(requests[0].questions), ["human_referent"]);
    assert.ok(requests[1].questions.action); assert.equal(requests[1].questions.feature, undefined);
    assert.equal(h.calls.filter(c => ["generation", "regeneration", "guard_rewrite"].includes(c.options.phase)).length, 0);
    assert.equal(h.records.length, 1); assert.equal(h.records[0].status, "error");
    assert.equal(h.records[0].publicSpeech, null); assert.equal(h.records[0].finalAction, null);
    assert.equal(h.records[0].errorCode, "invalid_decision"); assert.deepEqual(h.records[0].decisions, []);
    assert.deepEqual(h.records[0].local?.aiClaims, []); assert.deepEqual(h.records[0].local?.claims, []);
    assert.equal(h.dialogue.getAttempts().length, 1); assert.equal(h.dialogue.getAttempts()[0].errorCode, "invalid_decision");
    const failed = jevDecision.lastEvidence!;
    assert.equal(failed.status, "error"); assert.equal(failed.error, "invalid_decision");
    assert.equal(failed.rejectionCode, "detail_target_required"); assert.equal(failed.choices.action, action);
    assert.equal(failed.choices.target, "none"); assert.equal(failed.choices.candidate_0, "include");
    assert.equal(failed.choices.candidate_1, "include"); assert.equal(failed.stages.length, 1);
    assert.equal(failed.stages[0].rejectionCode, "detail_target_required");
  }
});
