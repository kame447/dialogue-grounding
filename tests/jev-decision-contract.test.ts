import test from "node:test";
import assert from "node:assert/strict";
import { ACTIONS } from "../dialogue-model/runtime/judgment/schema.mjs";
import { JEV_ACTIONS } from "../dialogue-model/runtime/decision/contract.ts";
import type { JevDecision, JevDecisionInput } from "../dialogue-model/runtime/decision/contract.ts";
import { buildJevDecisionPayload, validateJevDecision, JevDecisionError, JEV_ACTION_CRITERIA } from "../dialogue-model/runtime/decision/jev-decision.ts";
import { createMockJevDecisionClient } from "../dialogue-model/runtime/decision/mocks.ts";

function fixture(): JevDecisionInput {
  const slots = Array.from({ length: 6 }, (_, i) => `own-${i}`);
  return { turn: 2, ownSlots: slots,
    publicTurns: [{ turn: 1, speaker: "ai", text: "この形を船と呼ぶのはどうですか" }, { turn: 2, speaker: "human", text: "牛に見えるけど、名前は船でいいです" }],
    observations: { observedAt: "2026-10-20T00:00:00.000Z", figures: slots.map((id, i) => ({ id, region: { x: i * 10, y: 0, w: 9, h: 9 },
      holistic: [{ construal: i === 0 ? "馬" : `見立て${i}`, basis: ["頭のような部分"], status: "hypothesis" }],
      analytic: { shapes: [`三角${i}`, "四角が一つ"], composition: `構成${i}`, relations: [`関係${i}`] }, unknowns: ["向きは不明"], reobservations: [] })) },
    issueSummary: "向きは未解決", priorClaims: [], publicNames: [{ name: "船", figureId: slots[0], sourceTurn: 1 }], repairHistory: [],
    previousAction: { turn: 1, action: "propose_name", target: { kind: "single", figureId: slots[0] }, name: "船", feature: null } };
}
const code = (wanted: string) => (e: unknown) => e instanceof JevDecisionError && e.code === wanted;
function mockValue(patch: Partial<JevDecision> = {}): JevDecision {
  return { action: "accept", target: { kind: "none" }, name: null, feature: null, observe: null, decisionKind: "mock", calibrated: false,
    evidence: { model: null, responseId: null, choices: {}, scores: {}, latencyMs: 0, costUsd: 0 }, ...patch };
}

test("closed action vocabulary includes existing acts plus an observation request", () => {
  assert.deepEqual([...JEV_ACTIONS], [...ACTIONS, "request_observation"]);
  assert.deepEqual(Object.keys(JEV_ACTION_CRITERIA), [...JEV_ACTIONS]);
  const input = fixture(), payload = buildJevDecisionPayload(input);
  assert.equal(Object.keys(payload.questions).length, 16);
  assert.deepEqual(Object.keys(payload.questions.target.criteria), ["none", "multiple", ...input.ownSlots.map((_s, i) => `figure_${i}`)]);
  assert.match(payload.questions.action.instructions, /Lunaの事前actionは与えられません/);
  assert.match(payload.questions.action.instructions, /AIが馬、相手が牛/);
  assert.match(payload.questions.action.criteria.move_on, /固定Nターンで強制しない/);
  assert.match(payload.questions.action.criteria.defer, /P3/);
  assert.match(payload.questions.action.criteria.move_on, /P4/);
  assert.match(payload.questions.action.criteria.agree, /P5/);
});

test("strategy, current Luna action, images and unknown nested keys never reach Jev", () => {
  const a = fixture();
  const requests = ["repair-first", "bypass-enabled"].map(strategy => buildJevDecisionPayload({ ...a, strategy, lunaAction: "SECRET_ACTION",
    gold: "GOLD_CANARY", image: "IMAGE_CANARY", partnerImage: "PARTNER_CANARY",
    publicTurns: [...a.publicTurns.map(t => ({ ...t, gold: "GOLD_CANARY" })), { turn: 3, speaker: "ai", text: "FUTURE_CANARY" }],
    observations: { ...a.observations, gold: "GOLD_CANARY", figures: a.observations.figures.map(f => ({ ...f, gold: "GOLD_CANARY",
      holistic: f.holistic.map(h => ({ ...h, gold: "GOLD_CANARY" })), analytic: { ...f.analytic, key: "SECRET_CANARY" } })) },
  } as JevDecisionInput));
  assert.deepEqual(requests[0], requests[1]);
  assert.doesNotMatch(JSON.stringify(requests[0]), /CANARY|SECRET_ACTION|strategy|repair-first|bypass-enabled|"region"|observedAt/);
  const names = requests[0].questions.name_0.criteria;
  assert.deepEqual(Object.values(names).slice(1), ["馬", "船"]);
  assert.equal(Object.values(requests[0].questions.name_1.criteria).includes("船"), false, "names retain their target provenance");
});

test("all actions can be injected without a Luna pre-action and preserve mock provenance", () => {
  const input = fixture(), single = { kind: "single" as const, figureId: "own-0" };
  for (const action of JEV_ACTIONS) {
    const name = action === "propose_name" || action === "agree" ? "船" : null;
    const feature = action === "confirm" || action === "repair" ? "三角0" : null;
    const observe = action === "request_observation" ? { figureIds: ["own-0"], aspect: "construal" as const, question: "牛に見える部位はあるか", partnerConstrual: "牛" } : null;
    const result = validateJevDecision(mockValue({ action, target: single, name, feature, observe }), input);
    assert.equal(result.action, action);
    assert.equal(result.decisionKind, "mock");
    assert.equal(result.evidence.model, null);
  }
  assert.equal(validateJevDecision(mockValue({ action: "defer", target: { kind: "multiple", figureIds: ["own-0", "own-1"] } }), input).target.kind, "multiple");
});

test("unknown action, target, keys, calibration and unverifiable mock provenance are rejected", () => {
  const input = fixture();
  for (const patch of [{ action: "Luna_override" }, { target: { kind: "single", figureId: "partner-a" } }, { calibrated: true }, { private: "RAW_CANARY" },
    { evidence: { model: "typesafe/jev-1.14", responseId: null, choices: {}, scores: {}, latencyMs: 0, costUsd: 0 } }]) {
    assert.throws(() => validateJevDecision({ ...mockValue(), ...patch }, input), (e: unknown) => e instanceof JevDecisionError);
  }
});

test("names/features are closed, target-scoped, action-scoped, and never selected by a threshold", () => {
  const input = fixture(), single = { kind: "single" as const, figureId: "own-0" };
  for (const decision of [mockValue({ action: "agree", target: single, name: "not-in-candidates" }),
    mockValue({ action: "agree", target: { kind: "single", figureId: "own-1" }, name: "船" }),
    mockValue({ action: "propose_name", target: { kind: "multiple", figureIds: ["own-0", "own-1"] }, name: "船" }),
    mockValue({ action: "confirm", target: single, feature: "三角1" }), mockValue({ action: "repair", target: single }),
    mockValue({ action: "accept", target: single, name: "船" }), mockValue({ action: "agree", target: single, name: "船", feature: "三角0" })]) {
    assert.throws(() => validateJevDecision(decision, input), code("inconsistent_decision"));
  }
});

test("reobservation is engineering-limited and requires an own figure and closed aspect", () => {
  const input = fixture();
  assert.equal(Object.hasOwn(buildJevDecisionPayload({ ...input, reobservationAllowed: false }).questions.action.criteria, "request_observation"), false);
  const request = mockValue({ action: "request_observation", target: { kind: "single", figureId: "own-0" },
    observe: { figureIds: ["own-0"], aspect: "construal", question: "牛の見立てを確認", partnerConstrual: "牛" } });
  assert.throws(() => validateJevDecision(request, { ...input, reobservationAllowed: false }), code("inconsistent_decision"));
  assert.throws(() => validateJevDecision({ ...request, observe: { ...request.observe, aspect: "gold" } }, input), code("inconsistent_decision"));
  assert.throws(() => validateJevDecision({ ...request, observe: { ...request.observe, figureIds: ["own-1"] } }, input), code("inconsistent_decision"));
});

test("repair progress and latest targeted evidence survive deterministic input compaction", () => {
  const input = fixture();
  input.repairHistory = Array.from({ length: 30 }, (_, i) => ({ turn: 1, issueId: `issue-${i}`, action: "confirm" as const, question: "確認".repeat(180), partnerClaims: [],
    candidatesBefore: ["own-0", "own-1"], candidatesAfter: ["own-0", "own-1"], addedClaimIds: [], removedClaimIds: [], progress: "unchanged" as const }));
  for (const f of input.observations.figures) f.reobservations = Array.from({ length: 20 }, (_, i) => ({ figureId: f.id,
    observedAt: "2026-10-20T00:00:00.000Z", issue: { aspect: "construal", question: "相手の見立ての確認", partnerConstrual: null },
    supports: [`証拠${i}` + "形".repeat(200)], contradicts: ["反証"], unknown: ["不明"] }));
  const p = buildJevDecisionPayload(input), state = JSON.parse(p.state);
  assert.ok(p.state.length <= 20000);
  assert.deepEqual(buildJevDecisionPayload(input), p);
  assert.ok(state.inputBudget.omitted.repairHistory > 0);
  assert.ok(state.inputBudget.omitted.reobservations > 0);
  assert.ok(state.repairHistory.some((r: { issueId: string }) => r.issueId === "issue-29"));
  assert.ok(state.observations.every((o: { reobservations: Array<{ supports: string[] }> }) => o.reobservations.at(-1)!.supports[0].startsWith("証拠19")));
  assert.equal(state.publicTurns.at(-1).text, input.publicTurns.at(-1)!.text);
  assert.match(p.questions.action.instructions, /省略された履歴や論点が無い、解決した、合意したとは判断しない/);
});

test("long indispensible public utterances fail explicitly rather than being silently cut", () => {
  const input = fixture();
  input.previousAction = null;
  input.publicNames = [];
  input.publicTurns = [{ turn: 1, speaker: "ai", text: "あ".repeat(12000) }, { turn: 2, speaker: "human", text: "い".repeat(12000) }];
  assert.throws(() => buildJevDecisionPayload(input), code("invalid_input"));
});

test("invalid public name provenance, observation ids and current pre-actions fail before transport", () => {
  const input = fixture();
  for (const value of [{ ...input, publicNames: [{ name: "未来名", figureId: "own-0", sourceTurn: 1 }] },
    { ...input, ownSlots: ["own-0", "own-0"] }, { ...input, observations: { ...input.observations, figures: input.observations.figures.slice(1) } },
    { ...input, previousAction: { ...input.previousAction!, turn: 2 } }]) assert.throws(() => buildJevDecisionPayload(value), code("invalid_input"));
});

test("mocks simulate callbacks, delay, abort, timeout and fixed-code failures without claiming Jev", async () => {
  const input = fixture();
  const indexes: number[] = [];
  const mock = createMockJevDecisionClient((_i, o) => { indexes.push(o.callIndex); return mockValue(); }, { delayMs: 1 });
  assert.equal((await mock.decide(input)).decisionKind, "mock");
  await mock.decide(input);
  assert.deepEqual(indexes, [1, 2]);
  assert.equal(mock.metadata.decisionKind, "mock");
  await assert.rejects(createMockJevDecisionClient(() => mockValue(), { delayMs: 30 }).decide(input, { timeoutMs: 5 }), code("timeout"));
  const controller = new AbortController();
  controller.abort("SECRET_CANARY");
  await assert.rejects(mock.decide(input, { signal: controller.signal }), code("aborted"));
  await assert.rejects(createMockJevDecisionClient(() => { throw new Error("SECRET_CANARY"); }).decide(input), code("invalid_response"));
});
