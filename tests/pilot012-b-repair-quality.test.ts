import assert from "node:assert/strict";
import test from "node:test";
import { buildHumanReferentPayload, buildJevDecisionDetailPayload, buildJevDecisionPayload, buildRepairProspectPayload,
  createJevDecisionClient, validateJevDecision } from "../dialogue-model/runtime/decision/jev-decision.ts";
import type { JevDecisionInput, RepairHistoryEntry } from "../dialogue-model/runtime/decision/contract.ts";
import { JEV_REPAIR_QUALITY_VERSION, PUBLICATION_CONTINUATION_QUESTION, readPublicationContinuation,
  repairQualityPublicQuestions } from "../dialogue-model/runtime/decision/repair-quality.ts";
import { updateRepairHistory } from "../dialogue-model/runtime/v2/jev-turn.ts";
import { verifyRecords } from "../dialogue-model/runtime/diagnostics/parity-verify/index.ts";
import { s4Probe } from "../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts";
import type { LocalClaimView } from "../dialogue-model/runtime/local-grounding/contract.ts";
import { LABELLED_ANSWER_SOURCE } from "../dialogue-model/runtime/local-grounding/contract.ts";
import { MOVE_ON_SOURCE_QUESTION } from "../dialogue-model/runtime/decision/human-led-move-on.ts";
import { buildRecords, OLD, OWN } from "./support/s4-v3-records.ts";
import type { Label, Turn } from "./support/s4-v3-records.ts";

const layout = { questionLayout: "two_stage_v3" } as const;
const generationRetryVersion = "jev_generation_retry_v17" as const;
const profile = { dialoguePolicy: "holistic_v5", agreeNameScopeVersion: "jev_naming_v1",
  technicalTrial: { version: "adaptive_repair_v3" }, interventionVersion: "bypass_acceptance_v2" } as const;
const ownSlots: string[] = OWN.ownAnchors.map((anchor: { id: string }) => anchor.id);
const firstTarget = { kind: "single", figureId: ownSlots[0] } as const;
const shared = "縁が直線でできている";
const contrast = "小さな三角が輪郭から張り出す";
const memo: JevDecisionInput["observations"] = structuredClone(OLD.state.observationMemo);
for (const figure of memo.figures) figure.analytic = { shapes: [shared], composition: shared, relations: [] };
memo.figures[0].analytic.shapes.push(contrast);
memo.figures[0].holistic = [{ construal: "風見鶏", basis: [contrast], status: "hypothesis" }];

function claim(overrides: Partial<LocalClaimView>): LocalClaimView {
  return { id: "3:local1", turn: 3, sourceTurn: 3, issueId: "3:issue1", targets: [ownSlots[0]], aspect: "part",
    act: "ask", proposition: "三角の先がつながっていますか", quote: "三角の先がつながっていますか",
    name: null, speaker: "human", respondsTo: null, source: "partner_statement", ...overrides };
}
const check: RepairHistoryEntry = { turn: 1, issueId: "1:issue1", action: "confirm", question: shared,
  partnerClaims: [], candidatesBefore: [ownSlots[0]], candidatesAfter: [ownSlots[0]], addedClaimIds: [], removedClaimIds: [], progress: "unknown" };
const input: JevDecisionInput = { turn: 3, ownSlots, observations: memo, repairHistory: [check], judgmentLedger: [],
  issueSummary: "", priorClaims: [],
  publicTurns: [{ turn: 1, speaker: "human", text: "この形を確かめたいです。" },
    { turn: 2, speaker: "ai", text: "輪郭は直線ですか？" },
    { turn: 3, speaker: "human", text: "三角の先がつながっていますか。もう一つは穴がありますか。" }],
  previousAction: { turn: 2, action: "confirm", target: firstTarget, name: null, feature: shared }, publicNames: [],
  nameSource: "public_only", p5Enabled: true, discriminatingConfirmation: true };
const quality: JevDecisionInput = { ...input, judgmentMaterialVersion: JEV_REPAIR_QUALITY_VERSION };

test("Jev receives each new question with a public source in every decision stage", () => {
  const second = claim({ id: "3:local2", issueId: "3:issue2", targets: [ownSlots[1]],
    proposition: "もう一つは穴がありますか", quote: "もう一つは穴がありますか" });
  const current = { ...quality, priorClaims: [claim({}), second] };
  const evidence = { questions: ["3:local1", "3:local2"], acknowledgements: [], otherHumanClaims: [],
    checks: [{ turn: 1, support: [], objections: [], progress: "unknown" }] };
  for (const payload of [buildHumanReferentPayload(current), buildRepairProspectPayload(current, layout),
    buildJevDecisionPayload(current, layout), buildJevDecisionDetailPayload(current, { action: "repair", target: firstTarget }, layout)]) {
    assert.ok(payload);
    const state = JSON.parse(payload.state);
    assert.equal(state.judgmentMaterialVersion, JEV_REPAIR_QUALITY_VERSION);
    assert.deepEqual(state.repairQuality, evidence);
  }
  assert.deepEqual(repairQualityPublicQuestions(current.turn, current.publicTurns, current.priorClaims)
    .map(({ sourceTurn, targets }) => [sourceTurn, targets]), [[3, [ownSlots[0]]], [3, [ownSlots[1]]]]);
  const acknowledgement = claim({ act: "acknowledge", proposition: "分かりました", quote: "分かりました" });
  const separate = { ...current, priorClaims: [acknowledgement], publicTurns: [...input.publicTurns.slice(0, 2),
    { turn: 3, speaker: "human" as const, text: "分かりました。" }] };
  const state = JSON.parse(buildJevDecisionPayload(separate, layout).state);
  assert.deepEqual(state.repairQuality.questions, []);
  assert.deepEqual(state.repairQuality.acknowledgements, [acknowledgement.id]);
});

test("both detail actions offer the existing observations and mark prior work through evidence", () => {
  for (const action of ["confirm", "repair"] as const) {
    const chosen = { action, target: firstTarget };
    const old = buildJevDecisionDetailPayload(input, chosen, layout);
    const current = buildJevDecisionDetailPayload(quality, chosen, layout);
    assert.ok(old && current);
    assert.deepEqual(Object.values(old.questions.feature.criteria).map(value => JSON.parse(value).value), [contrast]);
    assert.deepEqual(Object.values(current.questions.feature.criteria).map(value => JSON.parse(value).value), [shared, contrast]);
    assert.match(current.questions.feature.instructions, /同意・否定・訂正/);
  }
  const prospect = buildRepairProspectPayload(quality, layout);
  assert.match(prospect.questions.prospect.instructions, /別の論点の新発話、相槌/);
  assert.match(prospect.questions.basis.criteria.new_information, /実質的な内容/);
});

test("unrelated new material on the same target does not advance the repair", () => {
  const unrelated = claim({ act: "assert", proposition: "縁にくぼみがある" });
  const linked = claim({ act: "deny", issueId: check.issueId!, proposition: "直線で囲まれていない" });
  const acknowledgement = claim({ act: "acknowledge", issueId: check.issueId!, proposition: "分かりました" });
  const predecessor = { answeredRepairTurn: 1, aiPublic: { humanOk: true, aiComplete: true, rejected: [] } };
  assert.equal(updateRepairHistory([check], [], [unrelated], 3, predecessor)[0].progress, "changed");
  const bounded = { ...predecessor, linkedEvidenceOnly: true as const };
  assert.equal(updateRepairHistory([check], [], [unrelated], 3, bounded)[0].progress, "unchanged");
  assert.equal(updateRepairHistory([check], [], [acknowledgement], 3, bounded)[0].progress, "unchanged");
  assert.equal(updateRepairHistory([check], [], [linked], 3, bounded)[0].progress, "changed");
  const candidates = ownSlots.slice(0, 2);
  const two = { ...check, candidatesBefore: candidates, candidatesAfter: candidates };
  assert.deepEqual(updateRepairHistory([two], [], [linked], 3, bounded)[0].candidatesAfter, candidates);
  const referring = claim({ act: "assert", issueId: check.issueId!, aspect: "referent" });
  assert.deepEqual(updateRepairHistory([two], [], [referring], 3, bounded)[0].candidatesAfter, candidates.slice(0, 1));
  const confirmed = claim({ act: "agree", issueId: check.issueId!, aspect: "question",
    source: LABELLED_ANSWER_SOURCE, respondsTo: "2:pub1" });
  assert.equal(updateRepairHistory([two], [], [confirmed], 3, bounded)[0].progress, "changed");
  assert.deepEqual(updateRepairHistory([two], [], [confirmed], 3, bounded)[0].candidatesAfter, candidates);
});

test("Jev can propose an observation-based name without being required to", () => {
  const old = buildJevDecisionPayload(input, layout);
  assert.equal(Object.hasOwn(old.questions.action.criteria, "propose_name"), false);
  const current = buildJevDecisionPayload(quality, layout);
  for (const available of ["accept", "propose_name", "confirm", "repair", "request_observation", "close"]) {
    assert.ok(Object.hasOwn(current.questions.action.criteria, available), available);
  }
  const detail = buildJevDecisionDetailPayload(quality, { action: "propose_name", target: firstTarget }, layout);
  assert.ok(detail);
  assert.deepEqual(Object.values(detail.questions.name.criteria).map(value => JSON.parse(value).value), ["風見鶏"]);
  assert.match(current.questions.action.criteria.close, /未命名の図形/);
  assert.match(current.questions.action.criteria.request_observation, /以前の観察でも不明/);
});

test("the recovery-only input is closed and does not offer withdrawal for another figure", () => {
  const previous = { action: "agree", target: firstTarget, name: "風見鶏", feature: null } as const;
  const nameLedger = Object.fromEntries(ownSlots.map((id, index) => [id,
    index === 0 ? { status: "agreed" as const, name: "見晴らし台" } : { status: "unassigned" as const, name: null }]));
  const previousTurn = { ...quality, nameLedger, publicationRecoveryContext: { previous, reason: "naming_conflict" as const } };
  const matched = buildJevDecisionDetailPayload(previousTurn, { action: "repair", target: firstTarget }, layout);
  assert.ok(matched);
  assert.deepEqual(Object.keys(matched.questions.naming_withdrawal.criteria), ["retain", "withdraw_prior_name"]);
  const other = buildJevDecisionDetailPayload(previousTurn, { action: "repair", target: { kind: "single", figureId: ownSlots[1] } }, layout);
  assert.ok(other);
  assert.equal(other.questions.naming_withdrawal, undefined);
  assert.throws(() => buildJevDecisionPayload({ ...previousTurn, judgmentMaterialVersion: undefined }, layout), { code: "invalid_input" });
  const normal = buildJevDecisionDetailPayload({ ...quality, nameLedger }, { action: "repair", target: firstTarget }, layout);
  assert.ok(normal);
  assert.equal(normal.questions.naming_withdrawal, undefined);
});

test("the recovery action carries a closed fallback choice in the same request", async () => {
  const recovery: JevDecisionInput = { ...quality, humanLedMoveOn: true, reobservationAllowed: false,
    publicationRecoveryContext: { previous: { action: "agree", target: firstTarget, name: "風見鶏", feature: null }, reason: "naming_conflict" } };
  const sent: ReturnType<typeof buildJevDecisionPayload>[] = [];
  const client = createJevDecisionClient({ ...layout, enabled: true, readKey: async () => "sk-or-SYNTHETIC-offline-replay-key-0000",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as ReturnType<typeof buildJevDecisionPayload>;
      sent.push(body);
      const choice: Record<string, string> = { action: "accept", [MOVE_ON_SOURCE_QUESTION]: "other",
        [PUBLICATION_CONTINUATION_QUESTION]: "ask_unresolved", target: "none" };
      return Response.json({ model: "typesafe/jev-1.14", id: "gen-b-recovery-" + sent.length, usage: { cost: 0 },
        answers: Object.fromEntries(Object.entries(body.questions).map(([key, question]) => [key, {
          type: "choice", choice: choice[key], probabilities: Object.fromEntries(Object.keys(question.criteria)
            .map(label => [label, Number(label === choice[key])])) }])) });
    },
  });
  assert.ok(client);
  const decision = await client.decide(recovery);
  assert.equal(sent.length, 2);
  assert.deepEqual(Object.keys(sent[0].questions), ["action", MOVE_ON_SOURCE_QUESTION, PUBLICATION_CONTINUATION_QUESTION]);
  assert.deepEqual(Object.keys(sent[1].questions), ["target"]);
  assert.equal(buildJevDecisionPayload(input, layout).questions[PUBLICATION_CONTINUATION_QUESTION], undefined);
  assert.equal(buildJevDecisionPayload(quality, layout).questions[PUBLICATION_CONTINUATION_QUESTION], undefined);
  const stage = decision.evidence.stages?.[0];
  assert.equal(readPublicationContinuation(stage), "ask_unresolved");
  const state = JSON.parse(sent[0].state);
  assert.equal(s4Probe.publicationContinuationProof(sent[0].questions, state, stage), "ask_unresolved");
  assert.equal(s4Probe.publicationContinuationProof({}, state, stage), null);

  const damaged = structuredClone(decision);
  delete damaged.evidence.stages?.[0].choices[PUBLICATION_CONTINUATION_QUESTION];
  assert.throws(() => validateJevDecision(damaged, recovery, layout), { code: "invalid_response" });
  assert.equal(s4Probe.publicationContinuationProof(sent[0].questions, state, damaged.evidence.stages?.[0]), null);
});

test("normal runtime uses the new judgment material equally in both strategies", async () => {
  const human = "三角の先がつながっていますか。もう一つは穴がありますか。";
  const ask = (segmentId: string, quote: string, index: number) => ({ segmentId, quote, proposition: quote, aspect: "part",
    targets: [ownSlots[index]], name: null, respondsToTurn: null, linkedIssueId: null });
  const turn: Turn = { human, plan: { action: "accept", target: "figures_0_1", referent: "multiple",
    choose: key => key === MOVE_ON_SOURCE_QUESTION ? "other" : undefined,
    act: "ask", extraction: JSON.stringify([ask("q1", "三角の先がつながっていますか", 0), ask("q2", "もう一つは穴がありますか", 1)]),
    speech: "こちらでは片方の三角は輪郭につながっています。もう一つに穴があるかは分かりません。" } };
  const records = await buildRecords({ ...profile, memo, turns: [turn], generationRetryVersion,
    judgmentMaterialVersion: JEV_REPAIR_QUALITY_VERSION });
  const pair = records.trials[0].replay[0].result;
  assert.equal(pair.commonEqual, true);
  for (const side of pair.sides as { label: Label; executed: { action: string; target: unknown }; requests: any[] }[]) {
    const action = side.requests.find(r => r.payload.questions?.action);
    assert.equal(side.executed.action, "accept");
    assert.deepEqual(side.executed.target, { kind: "multiple", figureIds: ownSlots.slice(0, 2) });
    assert.equal(JSON.parse(action.payload.state).repairQuality.questions.length, 2);
    const generation = side.requests.find(r => r.phase === "generation");
    assert.ok(generation.payload.messages.some((message: { content: string }) =>
      message.content.includes('"publicQuestions"') && message.content.includes("もう一つは穴がありますか")));
  }
  assert.equal(records.trials[0].turns[0].publicText, turn.plan.speech);
  const checks = verifyRecords(records).checks.filter(check => check.id.startsWith("intervention.trial.0.attempt.0."));
  assert.equal(checks.length, 4);
  for (const check of checks) assert.equal(check.status, "pass", check.id + " " + check.reason);
});
