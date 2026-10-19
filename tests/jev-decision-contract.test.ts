import test from "node:test";
import assert from "node:assert/strict";
import { ACTIONS } from "../dialogue-model/runtime/judgment/schema.mjs";
import { JEV_ACTIONS } from "../dialogue-model/runtime/decision/contract.ts";
import type { JevDecision, JevDecisionInput } from "../dialogue-model/runtime/decision/contract.ts";
import { buildJevDecisionPayload, buildJevDecisionDetailPayload, validateJevDecision, JevDecisionError, JEV_ACTION_CRITERIA, JEV_DECISION_INPUT_LIMITS } from "../dialogue-model/runtime/decision/jev-decision.ts";
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
  assert.equal(Object.keys(payload.questions).length, 8);
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
  const names = buildJevDecisionDetailPayload(a, { action: "agree", target: { kind: "single", figureId: "own-0" } })!.questions.name.criteria;
  assert.deepEqual(Object.values(names).map(s => JSON.parse(s).value), ["馬", "船"]);
  const other = buildJevDecisionDetailPayload(a, { action: "agree", target: { kind: "single", figureId: "own-1" } })!;
  assert.equal(Object.values(other.questions.name.criteria).some(s => JSON.parse(s).value === "船"), false);
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

test("more than 64 repairs and 128 public names compact with exact counts and retain the newest entries", () => {
  const input = fixture();
  const names = Array.from({ length: 200 }, (_, i) => `名称${i}`);
  input.publicTurns = [{ turn: 1, speaker: "ai", text: names.join("、") }, input.publicTurns[1]];
  input.previousAction = null;
  input.publicNames = names.map(name => ({ name, figureId: "own-0", sourceTurn: 1 }));
  input.repairHistory = Array.from({ length: 200 }, (_, i) => ({ turn: 1, issueId: `issue-${i}`, action: "confirm" as const,
    question: "確認", partnerClaims: [], candidatesBefore: ["own-0"], candidatesAfter: ["own-0"], addedClaimIds: [], removedClaimIds: [], progress: "unknown" as const }));
  const state = JSON.parse(buildJevDecisionPayload(input).state);
  assert.ok(state.publicNames.some((n: { name: string }) => n.name === "名称199"));
  assert.ok(state.repairHistory.some((r: { issueId: string }) => r.issueId === "issue-199"));
  assert.equal(state.inputBudget.omitted.publicNames, 200 - state.publicNames.length);
  assert.equal(state.inputBudget.omitted.repairHistory, 200 - state.repairHistory.length);
  assert.ok(JSON.stringify(state).length <= 20000);
  assert.equal(input.publicNames.length, 200);
  assert.equal(input.repairHistory.length, 200, "the caller's retained history is never modified");
});

test("large retained public histories compact, and A's 64-entry visual history is accepted", () => {
  const input = fixture();
  input.turn = 301; input.previousAction = null; input.publicNames = [];
  input.publicTurns = [...Array.from({ length: 300 }, (_, i) => ({ turn: i + 1, speaker: i % 2 ? "ai" as const : "human" as const, text: `公開${i}` })),
    { turn: 301, speaker: "human", text: "現在の発話" }];
  const state = JSON.parse(buildJevDecisionPayload(input).state);
  assert.equal(state.publicTurns.at(-1).text, "現在の発話");
  assert.ok(state.publicTurns.some((t: { turn: number }) => t.turn === 300));
  assert.equal(state.inputBudget.omitted.publicTurns, 301 - state.publicTurns.length);
  const f = input.observations.figures[0];
  f.reobservations = Array.from({ length: 64 }, (_, i) => ({ observedAt: "2026-10-20T00:00:00.000Z", figureId: f.id,
    issue: { aspect: "part", question: "部分の確認", partnerConstrual: null }, supports: [`最新特徴${i}`], contradicts: [], unknown: [] }));
  assert.doesNotThrow(() => buildJevDecisionPayload(input));
});

test("finite ingestion safety bounds remain typed errors rather than unrecorded clipping", () => {
  const input = fixture();
  const repair = { turn: 1, issueId: null, action: "confirm" as const, question: "確認", partnerClaims: [], candidatesBefore: [], candidatesAfter: [], addedClaimIds: [], removedClaimIds: [], progress: "unknown" as const };
  assert.throws(() => buildJevDecisionPayload({ ...input, repairHistory: Array(JEV_DECISION_INPUT_LIMITS.repairHistory + 1).fill(repair) }), code("invalid_input"));
  assert.throws(() => buildJevDecisionPayload({ ...input, publicNames: Array(JEV_DECISION_INPUT_LIMITS.publicNames + 1).fill(input.publicNames[0]) }), code("invalid_input"));
  assert.throws(() => buildJevDecisionPayload({ ...input, publicTurns: Array(JEV_DECISION_INPUT_LIMITS.publicTurns + 1).fill(input.publicTurns[0]) }), code("invalid_input"));
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

test("stage two is action-scoped, strategy-independent, and retains candidate feature provenance", () => {
  const input = fixture();
  const selected = { action: "repair" as const, target: { kind: "multiple" as const, figureIds: ["own-0", "own-2"] } };
  const bodies = ["repair-first", "bypass-enabled"].map(strategy => buildJevDecisionDetailPayload({ ...input, strategy, lunaAction: "SECRET_CANARY" } as JevDecisionInput, selected)!);
  assert.deepEqual(bodies[0], bodies[1]); assert.doesNotMatch(JSON.stringify(bodies), /strategy|SECRET_CANARY/);
  assert.deepEqual(Object.keys(bodies[0].questions), ["feature"]);
  assert.deepEqual(JSON.parse(bodies[0].state).selected, selected);
  const shared = Object.values(bodies[0].questions.feature.criteria).map(s => JSON.parse(s)).find(c => c.value === "四角が一つ");
  assert.deepEqual(shared.figureIds, ["own-0", "own-2"]);
  const value = mockValue({ ...selected, feature: "四角が一つ", detailFigureIds: ["own-0", "own-2"] });
  assert.deepEqual(validateJevDecision(value, input), value);
  assert.throws(() => validateJevDecision({ ...value, detailFigureIds: ["own-0"] }, input), code("inconsistent_decision"));
  const missing = { ...value }; delete missing.detailFigureIds;
  assert.throws(() => validateJevDecision(missing, input), code("inconsistent_decision"));
  for (const action of ["propose_name", "agree"] as const) for (const target of [selected.target, { kind: "none" as const }]) {
    assert.throws(() => buildJevDecisionDetailPayload(input, { action, target }), code("invalid_decision"));
  }
  assert.throws(() => buildJevDecisionPayload(input, { questionLayout: "joint_choices_v1" as never }), code("invalid_options"));
});

test("missing and excessive detail choices fail explicitly, without inventing or clipping candidates", () => {
  const input = fixture();
  input.publicNames = [];
  for (const f of input.observations.figures) { f.holistic = []; f.analytic = { shapes: [], composition: "", relations: [] }; }
  for (const action of ["confirm", "agree"] as const) {
    assert.throws(() => buildJevDecisionDetailPayload(input, { action, target: { kind: "single", figureId: "own-0" } }), code("inconsistent_decision"));
  }
  assert.throws(() => buildJevDecisionDetailPayload(fixture(), { action: "repair", target: { kind: "multiple", figureIds: ["own-0", "partner"] } }), code("invalid_input"));
  const large = fixture();
  large.observations.figures.forEach((f, i) => { f.analytic.shapes = Array.from({ length: 32 }, (_, j) => `形${i}-${j}`); f.analytic.relations = Array.from({ length: 32 }, (_, j) => `関係${i}-${j}`); });
  assert.throws(() => buildJevDecisionDetailPayload(large, { action: "repair", target: { kind: "multiple", figureIds: [...large.ownSlots] } }), code("invalid_input"));
});
