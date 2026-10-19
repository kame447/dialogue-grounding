// Synthetic observations, utterances and local model clients only.
import test from "node:test";
import assert from "node:assert/strict";
import { createDialogueV2 } from "../dialogue-model/runtime/v2/dialogue-v2.mjs";
import { createMockJevDecisionClient } from "../dialogue-model/runtime/decision/mocks.ts";
import { createHumanMessageQueue } from "../dialogue-model/runtime/web/human-message-queue.mjs";
import { JevTurnError, settleJevTurnTraces, updateRepairHistory, type JevTurnTrace, type JevPrivateState } from "../dialogue-model/runtime/v2/jev-turn.ts";
import { settleLocalTraces, type LocalGroundingResearchRecord } from "../dialogue-model/runtime/v2/local-grounding-turn.ts";
import type { ObservationMemo, ObservationObserver } from "../dialogue-model/runtime/observation/contract.ts";
import type { JevDecision, JevDecisionClient, JevDecisionInput, RepairHistoryEntry } from "../dialogue-model/runtime/decision/contract.ts";
import type { LocalClaimView, LocalFunctionClassifier } from "../dialogue-model/runtime/local-grounding/contract.ts";
import { MEMO_LOCAL_EXTRACTION_INSTRUCTIONS } from "../dialogue-model/runtime/local-grounding/extract.ts";

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
  const result = await h.run(undefined, { events: [{ ...h.events[0], text: "牛と呼ぼう" }] });
  assert.equal(result.privateState.ledger[ids[0]].status, "agreed");
  assert.equal(h.records[0].finalAction?.action, "agree");
  assert.equal(h.counts().judgeCalls, 0);
  assert.ok(!Object.hasOwn(inputs[0], "strategy")); assert.ok(!Object.hasOwn(inputs[0], "lunaAction"));
  assert.equal(h.records[0].local?.claims[0].source, "partner_statement");
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
  await assert.rejects(h.run(), (e: unknown) => e instanceof JevTurnError && e.code === "invalid_decision");
  assert.equal(h.records[0].decisions[0].action, "agree");
  assert.equal(h.records[0].publicSpeech, null);
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
