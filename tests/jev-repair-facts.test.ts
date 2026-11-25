// Issue #14 A2: synthetic records only. Cases pre-reviewed by LoyalHooke
// against SPEC.md (ORRERY 11944/11946); no live models or private run data.
import test from "node:test";
import assert from "node:assert/strict";
import { deriveRepairFacts, validateRepairFacts } from "../dialogue-model/runtime/decision/repair-facts.ts";
import { buildJevDecisionPayload, buildJevDecisionDetailPayload, buildHumanReferentPayload, buildRepairProspectPayload,
  createJevDecisionClient, JEV_DECISION_MODEL, REPAIR_FACTS_GUIDANCE } from "../dialogue-model/runtime/decision/jev-decision.ts";
import type { JevDecisionInput, RepairHistoryEntry, RepairFact, JevDecisionClient } from "../dialogue-model/runtime/decision/contract.ts";
import { createDialogueV2 } from "../dialogue-model/runtime/v2/dialogue-v2.mjs";
import { createMockJevDecisionClient } from "../dialogue-model/runtime/decision/mocks.ts";
import { interventionForStrategy, BYPASS_ACCEPTANCE_V1_TABLE_SHA256 } from "../dialogue-model/runtime/decision/bypass-acceptance.ts";
import { settleJevTurnTraces, validateJevPrivateStateV2 } from "../dialogue-model/runtime/v2/jev-turn.ts";

const slots = Array.from({ length: 6 }, (_, i) => `s-000${i + 1}`);
const anchors = slots.map((id, x) => ({ id, bbox: { x, y: 0, w: 1, h: 1 }, centroid: { x, y: 0 } }));
const memo = { observedAt: "2026-10-20T00:00:00.000Z", figures: anchors.map(a => ({ id: a.id, region: a.bbox,
  holistic: [], analytic: { shapes: ["三角"], composition: "二つの部分が接する", relations: [] }, unknowns: [], reobservations: [] })) };
const entry = (turn: number, targets: string[], question = "三角"): RepairHistoryEntry => ({ turn, issueId: `${turn}:local1`, action: "confirm", question,
  partnerClaims: [{ id: `${turn + 2}:local1`, act: "assert", proposition: "尖った部分", targets }],
  // Deliberately unrelated action targets: these must not decide reply comparisons.
  candidatesBefore: [slots[5]], candidatesAfter: slots.slice(2, 5), addedClaimIds: [], removedClaimIds: [], progress: "changed" });
const facts = (history: RepairHistoryEntry[], judgments: { turnIndex: number }[] = history.map(r => ({ turnIndex: r.turn }))) =>
  deriveRepairFacts(history, judgments, history);
function input(history = [entry(1, slots.slice(0, 2)), entry(3, [slots[0]])]): JevDecisionInput {
  return { turn: 9, ownSlots: slots, publicTurns: [{ turn: 9, speaker: "human", text: "尖った部分です" }], observations: structuredClone(memo),
    issueSummary: "", priorClaims: [], repairHistory: history, previousAction: null, publicNames: [] };
}

test("reply sets use information acts, ignore order/duplicates/action targets, and retain incomparability", () => {
  const first = [slots[0], slots[1]];
  const cases: [string[], string[], RepairFact["replyVsPrevious"]][] = [
    [first, [slots[1], slots[0], slots[0]], "same"], [first, [slots[0]], "narrowed"],
    [[slots[0]], first, "widened_or_shifted"], [first, [slots[2]], "widened_or_shifted"],
    [[], first, "not_comparable"], [first, [], "not_comparable"], [[], [], "not_comparable"],
  ];
  for (const [before, after, expected] of cases) {
    const h = [entry(1, before), entry(3, after)];
    h[1].partnerClaims = [...h[1].partnerClaims, { id: "ignored", act: "ask", proposition: "質問", targets: [slots[5]] }];
    const result = facts(h);
    assert.equal(result[0].replyVsPrevious, "not_comparable");
    assert.equal(result[1].replyVsPrevious, expected);
    assert.equal(result[1].previousTurn, 1);
    h[1].candidatesBefore = []; h[1].candidatesAfter = [];
    assert.deepEqual(facts(h), result);
  }
  for (const act of ["assert", "agree", "deny", "construe", "name_propose", "name_accept", "name_reject"] as const) {
    const h = [entry(1, first), entry(3, first)]; h[1].partnerClaims[0].act = act;
    assert.equal(facts(h)[1].replyVsPrevious, "same");
  }
});

test("adjacency uses complete history and committed turns; repetition is nonempty exact question equality", () => {
  const h = [entry(1, slots), entry(5, slots.slice(0, 2))];
  assert.equal(facts(h)[1].sameQuestionAsPrevious, true);
  assert.deepEqual(facts(h, [{ turnIndex: 1 }, { turnIndex: 3 }])[1], {
    turn: 5, previousTurn: null, replyVsPrevious: "not_comparable", sameQuestionAsPrevious: false, localGaps: [], localRejections: 0 });
  for (const question of ["", "三角形", "三角 "]) {
    h[1].question = question;
    assert.equal(facts(h)[1].sameQuestionAsPrevious, false);
  }
  h[0].question = ""; h[1].question = "";
  assert.equal(facts(h)[1].sameQuestionAsPrevious, false);
  // A gated-out predecessor still establishes which clarification was immediately before E.
  const full = [entry(1, slots), entry(3, slots.slice(0, 2)), entry(5, [slots[0]])];
  const before = structuredClone(full);
  assert.equal(deriveRepairFacts(full, full.map(r => ({ turnIndex: r.turn })), [full[2]])[0].previousTurn, 3);
  assert.deepEqual(full, before);
});

test("local gaps are closed codes and local rejections expose only the count", () => {
  const h = [entry(1, [])];
  assert.deepEqual(facts(h)[0].localGaps, []);
  h[0].missingReasons = ["RAW_PRIVATE_CANARY", "ai_source_incomplete", "human_local_missing", "human_local_missing", "human_capacity_dropped"];
  h[0].humanRejections = [{ segmentId: "RAW_PRIVATE_CANARY", reason: "RAW_PRIVATE_CANARY" }];
  const result = facts(h);
  assert.deepEqual(result[0].localGaps, ["human_local_missing", "human_capacity_dropped", "ai_source_incomplete"]);
  assert.equal(result[0].localRejections, 1);
  assert.doesNotMatch(JSON.stringify(result), /CANARY/);
});

test("adapter rejects unknown, duplicate, future and malformed facts with a closed input error", () => {
  const v = input(), valid = facts(v.repairHistory as RepairHistoryEntry[]), f = valid[0];
  for (const patch of [{ turn: 9 }, { turn: 7 }, { previousTurn: 1 }, { previousTurn: 0 }, { replyVsPrevious: "stalled" },
    { sameQuestionAsPrevious: "yes" }, { localGaps: ["RAW_PRIVATE_CANARY"] }, { localGaps: ["human_local_missing", "human_local_missing"] },
    { localRejections: -1 }, { localRejections: 65 }, { localRejections: 0.5 }, { gold: "RAW_PRIVATE_CANARY" }]) {
    assert.throws(() => buildJevDecisionPayload({ ...v, repairFacts: [{ ...f, ...patch }] } as JevDecisionInput), { code: "invalid_input" });
  }
  assert.throws(() => buildJevDecisionPayload({ ...v, repairFacts: [f, f] }), { code: "invalid_input" });
  assert.throws(() => buildJevDecisionPayload({ ...v, repairFacts: null } as unknown as JevDecisionInput), { code: "invalid_input" });
  assert.deepEqual(validateRepairFacts(valid, v.repairHistory, v.turn), valid);
});

test("spacious payload differs only by attached facts and one guidance line; referent stays byte identical", () => {
  const v = input(), on = { ...v, repairFacts: facts(v.repairHistory as RepairHistoryEntry[]) };
  const selected = { action: "repair", target: { kind: "single", figureId: slots[0] } } as const;
  for (const build of [buildJevDecisionPayload, (value: JevDecisionInput) => buildJevDecisionDetailPayload(value, selected)!, buildRepairProspectPayload]) {
    const old = build(v), next = build(on), material = JSON.parse(next.state);
    assert.ok(material.repairHistory.every((r: any) => r.facts));
    for (const r of material.repairHistory) delete r.facts;
    assert.equal(JSON.stringify(material), old.state);
    const withoutGuidance = structuredClone(next);
    withoutGuidance.state = JSON.stringify(material);
    for (const q of Object.values(withoutGuidance.questions)) {
      assert.equal(q.instructions.split(REPAIR_FACTS_GUIDANCE).length - 1, 1);
      q.instructions = q.instructions.replace("\n" + REPAIR_FACTS_GUIDANCE, "");
    }
    assert.deepEqual(withoutGuidance, old);
  }
  assert.equal(JSON.stringify(buildHumanReferentPayload(on)), JSON.stringify(buildHumanReferentPayload(v)));
  assert.equal(JSON.stringify(buildJevDecisionPayload(v)), JSON.stringify(buildJevDecisionPayload({ ...v, repairFacts: undefined })));
});

test("facts remain only on budget-retained history; no future, strategy, unknown or raw diagnostic fields pass", () => {
  const v = input(Array.from({ length: 100 }, (_, i) => entry(i * 2 + 1, [slots[0]], "三角".repeat(50)))); v.turn = 501;
  v.publicTurns = [{ turn: 501, speaker: "human", text: "尖った部分です" }];
  const on = { ...v, repairFacts: facts(v.repairHistory as RepairHistoryEntry[]) };
  const state = JSON.parse(buildJevDecisionPayload(on).state);
  assert.ok(state.inputBudget.omitted.repairHistory > 0);
  assert.ok(state.repairHistory.length < 100);
  assert.ok(!Object.hasOwn(state, "repairFacts"));
  assert.deepEqual(state.repairHistory.map((r: any) => r.facts.previousTurn), state.repairHistory.map((r: any) => r.turn === 1 ? null : r.turn - 2));
  const clean = input(), original = buildJevDecisionPayload({ ...clean, repairFacts: facts(clean.repairHistory as RepairHistoryEntry[]) });
  const poisoned = { ...clean, strategy: "BYPASS_CANARY", gold: "GOLD_CANARY", partnerImage: "IMAGE_CANARY",
    publicTurns: [...clean.publicTurns, { turn: 11, speaker: "ai", text: "FUTURE_CANARY" }],
    repairHistory: clean.repairHistory.map(r => ({ ...r, missingReasons: ["GAP_CANARY"], humanRejections: [{ segmentId: "SEGMENT_CANARY", reason: "REASON_CANARY" }], gold: "GOLD_CANARY" })),
    repairFacts: facts(clean.repairHistory as RepairHistoryEntry[]) };
  assert.deepEqual(buildJevDecisionPayload(poisoned as JevDecisionInput), original);
  assert.doesNotMatch(JSON.stringify(original), /CANARY/);
});

test("completeDetail accepts v3 input and sends facts without another action-stage call", async () => {
  const v = input(), on = { ...v, repairFacts: facts(v.repairHistory as RepairHistoryEntry[]) }, requests: any[] = [];
  const client = createJevDecisionClient({ enabled: true, readKey: async () => "sk-or-SYNTHETIC-facts-key-000000", fetchImpl: async (_url, init) => {
    const p = JSON.parse(String(init.body)); requests.push(p);
    return Response.json({ model: JEV_DECISION_MODEL, id: "gen-facts", usage: { cost: 0.0001 },
      answers: Object.fromEntries(Object.entries(p.questions).map(([name, q]: [string, any]) => {
        const labels = Object.keys(q.criteria);
        return [name, { type: "choice", choice: labels[0], probabilities: Object.fromEntries(labels.map(label => [label, 1 / labels.length])) }];
      })) });
  } })!;
  const result = await client.completeDetail(on, { action: "repair", target: { kind: "single", figureId: slots[0] } });
  assert.equal(result.executed.feature, "三角");
  assert.equal(requests.length, 1);
  assert.deepEqual(Object.keys(requests[0].questions), ["feature"]);
  assert.ok(JSON.parse(requests[0].state).repairHistory[0].facts);
});

function harness(version: "adaptive_repair_v2" | "adaptive_repair_v3" | "off" = "adaptive_repair_v3", strategy = "repair-first", speech = "なるほど。", failObservation = false) {
  const inputs: JevDecisionInput[] = [], phases: string[] = [];
  const jevDecision = createMockJevDecisionClient(v => { inputs.push(structuredClone(v)); return { action: "confirm", target: { kind: "single", figureId: slots[0] },
    name: null, feature: "三角", observe: null }; });
  const runtime = createDialogueV2({ client: { async complete(_messages: unknown, options: { phase: string }) {
    phases.push(options.phase); return { text: options.phase === "local_extraction" ? "[]" : speech };
  } }, image: { mimeType: "image/png", base64: "U1lOVEhFVElDX09XTl9JTUFHRQ==" }, anchors, referenceMemory: true, strategy,
    decisionMode: "jev", jevDecision: jevDecision as JevDecisionClient,
    interventionPolicy: { version: "bypass_acceptance_v1", tableSha256: BYPASS_ACCEPTANCE_V1_TABLE_SHA256 }, decisionTimeoutMs: 20000,
    observer: { async observeAll() { if (failObservation) throw Error("PRIVATE_CANARY"); return structuredClone(memo); }, async reobserve() { throw Error("unused"); } },
    localGrounding: { classifier: { async classify() { return []; } } }, ...(version === "off" ? {} : { technicalTrial: { version } }) } as any);
  const run = (privateState = runtime.initialPrivateState(), turn = 1) => runtime.runAiTurn({ privateState,
    events: [{ id: "h1", seq: 1, speaker: "human", text: "尖った部分です" }, ...(turn > 1 ? [
      { id: "a2", seq: 2, speaker: "ai", text: "三角がありますか。" }, { id: "h3", seq: 3, speaker: "human", text: "尖った部分です" }] : [])], lastEventId: `h${turn}` });
  return { runtime, inputs, phases, run };
}

test("v3 is symmetric, adds no calls, saves its exact input facts, settles and restores without changing v2", async () => {
  const a = harness(), b = harness("adaptive_repair_v3", "bypass-enabled"), old = harness("adaptive_repair_v2");
  const first = await a.run(), paired = await b.run(), legacy = await old.run();
  assert.deepEqual(a.inputs, b.inputs);
  assert.deepEqual(a.inputs[0].repairFacts, []);
  const stripped = structuredClone(a.inputs[0]); delete stripped.repairFacts;
  assert.deepEqual(stripped, old.inputs[0]);
  assert.deepEqual(a.phases, old.phases);
  assert.deepEqual(first.privateState.judgments[0].jevTurn.repairFacts, a.inputs[0].repairFacts);
  assert.deepEqual(paired.privateState.judgments[0].jevTurn.repairFacts, []);
  assert.ok(!Object.hasOwn(legacy.privateState.judgments[0].jevTurn, "repairFacts"));
  assert.deepEqual(validateJevPrivateStateV2(first.privateState, slots, interventionForStrategy("repair-first")), first.privateState);
  assert.equal(settleJevTurnTraces(a.runtime.getAttempts(), first.privateState)[0].status, "committed");
  const second = await a.run(first.privateState, 3);
  assert.equal(a.inputs[1].repairFacts?.[0].turn, 1);
  assert.deepEqual(second.privateState.judgments[1].jevTurn.repairFacts, a.inputs[1].repairFacts);
  assert.deepEqual(a.runtime.getAttempts()[1].repairFacts, a.inputs[1].repairFacts);
  assert.doesNotThrow(() => a.runtime.snapshotGraph(second.privateState));
  assert.throws(() => old.runtime.snapshotGraph(first.privateState), { code: "invalid_state" });
  assert.throws(() => a.runtime.snapshotGraph(legacy.privateState), { code: "invalid_state" });
  assert.throws(() => harness("off").runtime.snapshotGraph(first.privateState), { code: "invalid_state" });
  const invalid = structuredClone(second.privateState); invalid.judgments[1].jevTurn.repairFacts[0].localRejections = 65;
  assert.throws(() => validateJevPrivateStateV2(invalid, slots, interventionForStrategy("repair-first")), { code: "invalid_state" });
});

test("failed v3 attempts still identify their version and new public-field checks apply only to v3", async () => {
  const failed = harness("adaptive_repair_v3", "repair-first", "なるほど。", true);
  await assert.rejects(failed.run(), { code: "observation_failed" });
  assert.deepEqual(failed.runtime.getAttempts()[0].repairFacts, []);
  assert.doesNotMatch(JSON.stringify(failed.runtime.getAttempts()), /CANARY/);
  for (const field of ["repairFacts", "replyVsPrevious", "not_comparable", "widened_or_shifted", "sameQuestionAsPrevious", "localGaps"]) {
    const on = harness("adaptive_repair_v3", "repair-first", field);
    await assert.rejects(on.run(), { code: "unsafe_generation" });
    assert.ok(on.runtime.getAttempts()[0].generationGuard.violations.includes("internal_field"));
    const off = harness("adaptive_repair_v2", "repair-first", field);
    assert.equal((await off.run()).text, field);
  }
});
