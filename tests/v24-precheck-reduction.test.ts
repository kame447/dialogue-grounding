import assert from "node:assert/strict";
import { test } from "node:test";
import { GENERATION_RETRY_V23, GENERATION_RETRY_V24, findOrientationLeaks, type RecordedGenerationRetryVersion } from "../dialogue-model/runtime/v2/generation-guard.ts";
import { researchTrialProfileV3 } from "../dialogue-model/runtime/v2/research-profile.ts";
import { approveReception, createReception, PILOT012_V23_PARTICIPANT_PROFILE, PILOT012_V24_PARTICIPANT_PROFILE,
  receptionProtocolSha256, validateReceptionPlan, type ReceptionProtocolV2 } from "../dialogue-model/runtime/v2/reception.ts";
import { INITIAL_OBSERVATION_STRUCTURED_V2 } from "../dialogue-model/runtime/observation/initial-observation-generation.ts";
import { CLAIM_PRUNE_V3 } from "../dialogue-model/runtime/memory/reference-graph.mjs";
import { PARTICIPANT_PRODUCTION_PROFILE } from "../dialogue-model/runtime/web/participant-usage-policy.ts";
import { initialState, normal, OLD, OWN, runTurn, type Label, type Plan } from "./support/s4-v3-records.ts";

const { lunaRequest, timeouts } = normal.run.manifest;
const profile = researchTrialProfileV3(lunaRequest, timeouts, "two_stage_v3", "holistic_v5", "bypass_acceptance_v3", "jev_repair_quality_v1");
const technical = { version: "adaptive_repair_v3" } as const;
const figure = OWN.ownAnchors[0].id;
const labels: Label[] = ["repair-first", "bypass-enabled"];
const suggested = "鳥のような形に見えます。";
const ordinary = "「鳥」にしませんか？";
const alternatives = ["では、「鳥」にしませんか？", "「鳥」はどうですか？"];
const stay = "今の図形の話を続けたいです。";

test("受付計画は両方略で OFF を固定し、明示 ON と旧版を区別する", async () => {
  const protocol: ReceptionProtocolV2 = { schemaVersion: "reception_protocol_v2", protocolId: "22222222-2222-4222-8222-222222222222",
    revision: 1, allowedOrders: [["repair-first", "bypass-enabled"], ["bypass-enabled", "repair-first"]], seedPolicy: "shared", referenceMemory: true,
    betweenTrials: "none", receptionNumberFormat: "daily_seq3", rotationMode: "relative_0" };
  const time = "2026-11-01T00:00:00.000Z";
  const pending = createReception({ receptionId: "11111111-1111-4111-8111-111111111111", objectId: "a".repeat(64), createdAt: time, number: null });
  const params: Parameters<typeof approveReception>[1] = { expectedRevision: 0, order: 0, protocol, expected: { protocolId: protocol.protocolId, revision: 1,
    sha256: receptionProtocolSha256(JSON.stringify(protocol)) }, approvedAt: time, randomSeed: () => 211,
    participantModelPin: { schemaVersion: "participant_model_pin_v3" as const, terraModelId: "gpt-6.1-terra-2026-11-01", jevModelId: "typesafe/jev-1.14-20261001" },
    participantRuntimeProfile: PARTICIPANT_PRODUCTION_PROFILE, initialObservationGeneration: INITIAL_OBSERVATION_STRUCTURED_V2,
    memoryPruneVersion: CLAIM_PRUNE_V3, participantDialogueProfile: PILOT012_V24_PARTICIPANT_PROFILE };
  const plan = (await approveReception(pending, params)).plan;
  const explicit = (await approveReception(pending, { ...params, order: 1, postGenerationCheck: "on" })).plan;
  assert.ok(plan && plan.schemaVersion === "reception_plan_v2" && explicit && explicit.schemaVersion === "reception_plan_v2");
  assert.equal(plan.postGenerationCheck, "off");
  assert.equal(explicit.postGenerationCheck, "on");
  assert.deepEqual(plan.order, ["repair-first", "bypass-enabled"]);
  assert.deepEqual(explicit.order, ["bypass-enabled", "repair-first"]);
  const { postGenerationCheck, ...missing } = plan;
  assert.throws(() => validateReceptionPlan(missing));
  assert.throws(() => validateReceptionPlan({ ...plan, postGenerationCheck: false }));
  const old = (await approveReception(pending, { ...params, participantDialogueProfile: PILOT012_V23_PARTICIPANT_PROFILE })).plan;
  assert.ok(old);
  assert.equal(Object.hasOwn(old, "postGenerationCheck"), false);
  assert.throws(() => validateReceptionPlan({ ...old, postGenerationCheck }));
});

function choose(key: string) {
  return ({ human_move_on_source: "other", commitment_state: "insufficient", draft_topic_shift: "within_plan" } as Record<string, string>)[key];
}
const propose = (drafts: string[], firstAct = "propose_chosen"): Plan => ({
  action: "propose_name", target: "figure_0", name: "鳥", referent: "figure_0", act: "construe", drafts, aiExtraction: "[]",
  extraction: JSON.stringify([{ segmentId: "construal", quote: suggested, proposition: suggested, targets: [figure],
    aspect: "construal", name: null, linkedIssueId: null, respondsToTurn: null }]),
  choose: (key, _criteria, context) => key === "draft_naming" ? context.generationCalls === 1 ? firstAct : "propose_chosen" : choose(key),
});

async function run(label: Label, version: RecordedGenerationRetryVersion, human: string, plan: Plan,
  history?: { state: ReturnType<typeof initialState>; events: { seq: number; speaker: "human" | "ai"; text: string }[] }) {
  const memo = structuredClone(OLD.state.observationMemo);
  memo.figures.find((entry: { id: string }) => entry.id === figure).holistic =
    [{ construal: "鳥", basis: ["とがった先"], status: "hypothesis" }];
  const state = history?.state ?? initialState({ profile, generationRetryVersion: version, agreeNameScopeVersion: "jev_naming_v3", memo });
  const jev: { body: string; keys: string[] }[] = [];
  const terra: string[] = [];
  const result = await runTurn(profile, label, state, [...(history?.events ?? []), { seq: (history?.events.at(-1)?.seq ?? 0) + 1, speaker: "human", text: human }],
    { ...(version === GENERATION_RETRY_V24 ? { postGenerationCheck: "on" as const } : {}), ...plan, captureRequest(provider, body) {
      plan.captureRequest?.(provider, body);
      if (provider === "jev") jev.push({ body, keys: Object.keys(JSON.parse(body).questions) });
      else terra.push(body);
    } }, technical, version);
  assert.equal(result.publication.status, "committed");
  const generations = result.luna.filter(call => call.phase === "generation").length;
  return { ...result, generations, decisions: jev.filter(call => call.keys.includes("action")).length, jev, terra };
}

test("v24 は選定した名前の自然な提案を既存の Jev 送信で確認し、初稿を公開する", async () => {
  for (const draft of alternatives) {
    const [repair, bypass] = await Promise.all(labels.map(label => run(label, GENERATION_RETRY_V24, suggested, propose([draft]))));
    assert.deepEqual(repair.terra, bypass.terra);
    assert.deepEqual(repair.jev, bypass.jev);
    for (const result of [repair, bypass]) {
      assert.equal(result.trace.executed.action, "propose_name");
      assert.equal(result.speech, draft);
      assert.equal(result.generations, 1);
      assert.equal(result.decisions, 1);
      const checks = result.jev.filter(call => call.keys.includes("draft_topic_shift"));
      assert.deepEqual(checks.map(call => call.keys), [["draft_naming", "draft_topic_shift"]]);
      assert.equal(result.state.ledger[figure].status, "tentative");
    }
  }
  const old = await run("repair-first", GENERATION_RETRY_V23, suggested, propose([alternatives[0], ordinary]));
  assert.equal(old.generations, 2);
  assert.equal(old.decisions, 1);
  assert.equal(old.speech, ordinary);
});

const failDraftCheck = () => assert.fail("OFF の稿を意味判定に渡した");
const proposal = "この形を鳥と呼びませんか？";
const proposalSegment = { segmentId: "name", quote: proposal, proposition: proposal, targets: [figure],
  aspect: "name", name: "鳥", linkedIssueId: null, respondsToTurn: null };

test("v24 OFF は命名提案を初稿で公開し、別の発話を合意として台帳に反映しない", async () => {
  for (const label of labels) {
    for (const draft of [...alternatives, "では、「鳥」に決めて、次の図形を見ましょう。"]) {
      let checkCalls = 0;
      const result = await run(label, GENERATION_RETRY_V24, suggested, { ...propose([draft]), postGenerationCheck: "off",
        onDraftCheck() { checkCalls++; failDraftCheck(); } });
      assert.equal(checkCalls, 0);
      assert.equal(result.generations, 1);
      assert.equal(result.decisions, 1);
      assert.equal(result.speech, draft);
      assert.equal(result.trace.executed.action, "propose_name");
      assert.equal(result.trace.generatedPublication?.recovery, null);
      assert.equal(result.trace.generatedPublication?.continuation, null);
      assert.equal(Object.hasOwn(result.trace, "draftActs"), false);
      assert.equal(Object.hasOwn(result.trace, "draftSharedClaims"), false);
      assert.equal(result.state.ledger[figure].status, "tentative");
    }
  }
});

test("v24 OFF は根拠が足りない合意の稿も保持し、再開後の台帳と再確認に反映しない", async () => {
  const speech = "はい、「鳥」で決まりですね。";
  for (const label of labels) {
    const first = await run(label, GENERATION_RETRY_V24, proposal, { postGenerationCheck: "off", action: "agree", target: "figure_0",
      name: "鳥", referent: "figure_0", act: "name_propose", extraction: JSON.stringify([proposalSegment]), drafts: [speech],
      onDraftCheck: failDraftCheck, choose: key => key === "naming_grounding" ? "unresolved" : key === "naming_evidence" ? "none" : choose(key) });
    assert.equal(first.speech, speech);
    assert.equal(first.decisions, 1);
    assert.equal(first.generations, 1);
    assert.equal(first.trace.generatedPublication?.agreementWithheld, true);
    assert.equal(first.state.ledger[figure].status, "unassigned");
    const next = await run(label, GENERATION_RETRY_V24, proposal, { postGenerationCheck: "off", action: "agree", target: "figure_0",
      name: "鳥", referent: "figure_0", act: "name_propose", extraction: JSON.stringify([proposalSegment]), drafts: [speech],
      onDraftCheck: failDraftCheck, choose: key => key === "naming_grounding" ? "grounded_name_0" : key === "naming_evidence" ? "turn_3" : choose(key) },
    { state: first.state, events: first.publication.publicEvents });
    assert.equal(next.trace.namingReconfirm, undefined);
    assert.equal(next.trace.generatedPublication?.agreementWithheld, undefined);
    assert.equal(next.state.ledger[figure].status, "agreed");
  }
});

const featureQuestion = "細い部分はどうつながっていますか？";
const featureAnswer = "私には右向きの鳥に見えます。細い部分は端でつながっています。";
const source = { figureId: figure, path: ["holistic", 0, "basis", 0] };
const featureSegment = { segmentId: "shape", quote: "細い部分は端でつながっています。", aspect: "part", targets: [figure],
  proposition: "細い部分は端でつながっている", name: null, linkedIssueId: null, respondsToTurn: null };
const confirm = (drafts: string[], on = false): Plan => ({ action: "confirm", target: "figure_0", drafts, referent: "figure_0",
  aiExtraction: JSON.stringify(on ? { segments: [featureSegment], visualFeatures: { sources: [{ source, quote: featureSegment.quote }] } }
    : [featureSegment]), aiActs: ["assert"], choose });

test("v24 OFF は任意の出所に依存せず、公開後に一度だけ抽出して修復履歴を保存する", async () => {
  for (const observationFeatures of [undefined, { path: "invalid" }, [{ ...source, path: ["holistic", 0, "construal"] }]]) {
    const draft = JSON.stringify({ text: featureAnswer, observationFeatures });
    const results = [];
    for (const label of labels) {
      const sent: { provider: string; body: string }[] = [];
      let beforePublication = -1;
      const result = await run(label, GENERATION_RETRY_V24, featureQuestion, { ...confirm([draft]), postGenerationCheck: "off",
        onDraftCheck: failDraftCheck,
        captureRequest(provider, body) { sent.push({ provider, body }); },
        onDeferredPublication(job) {
          beforePublication = sent.length;
          assert.equal(job.schemaVersion, "deferred_ai_extraction_v1");
          assert.equal(job.eventId, "event-2");
        } });
      assert.equal(result.speech, featureAnswer);
      assert.equal(result.generations, 1);
      assert.equal(result.decisions, 1);
      assert.ok(beforePublication > 0);
      assert.equal(result.luna.filter(call => call.phase === "ai_extraction").length, 1);
      assert.deepEqual(sent.map(call => call.provider), ["luna", "jev", "jev", "jev", "jev", "luna", "luna", "jev", "jev"]);
      assert.equal(sent[beforePublication]?.provider, "luna");
      assert.equal(result.state.aiPublic.pending.aiSeq, 2);
      assert.equal(result.state.repairHistory.at(-1).question, featureAnswer);
      assert.equal(Object.hasOwn(result.trace.generatedPublication!, "visualFeatures"), false);
      assert.equal(result.state.ledger[figure].status, "unassigned");
      assert.match(JSON.parse(result.terra[1]).messages[2].content, /【出力】text のキーだけ/u);
      results.push(sent);
    }
    assert.deepEqual(results[0], results[1]);
  }
});

test("同じ確認稿で v24 OFF は公開前の抽出と Jev を各1送信減らす", async () => {
  for (const [version, mode] of [[GENERATION_RETRY_V23, undefined], [GENERATION_RETRY_V24, "on"], [GENERATION_RETRY_V24, "off"]] as const) {
    const text = "こちらの画面では、" + featureSegment.quote;
    const draft = JSON.stringify({ text, observationFeatures: [source] });
    const checksOff = mode === "off";
    const sent: string[] = [];
    let beforePublication = -1;
    const result = await run("repair-first", version, featureQuestion, { ...confirm([draft], !checksOff), postGenerationCheck: mode,
      ...(checksOff ? { onDraftCheck: failDraftCheck } : {}),
      captureRequest(provider) { sent.push(provider); },
      onDeferredPublication(job) {
        beforePublication = sent.length;
        assert.equal(job.schemaVersion, checksOff ? "deferred_ai_extraction_v1" : "deferred_ai_classification_v1");
      } });
    assert.equal(result.speech, text);
    assert.equal(result.generations, 1);
    assert.equal(result.decisions, 1);
    assert.equal(result.luna.filter(call => call.phase === "ai_extraction").length, 1);
    assert.equal(result.jev.some(call => call.keys.includes("draft_topic_shift")), !checksOff);
    assert.equal(Boolean(result.trace.generatedPublication?.visualFeatures), !checksOff);
    const count = (phase: string[]) => [phase.filter(provider => provider === "luna").length, phase.filter(provider => provider === "jev").length];
    assert.deepEqual(count(sent.slice(0, beforePublication)), checksOff ? [2, 4] : [3, 5]);
    assert.deepEqual(count(sent.slice(beforePublication)), checksOff ? [1, 2] : [0, 2]);
  }
});

test("v24 OFF は構造の欠落と非公開識別子を機械検査で拒む", async () => {
  for (const [initial, violation] of [[JSON.stringify({ observationFeatures: [] }), "draft_structure_mismatch"],
    [JSON.stringify({ text: "human_referent は鳥です。" }), "internal_field"]]) {
    let checks = 0;
    const result = await run("bypass-enabled", GENERATION_RETRY_V24, featureQuestion,
      { ...confirm([initial, JSON.stringify({ text: featureAnswer })]), postGenerationCheck: "off",
        onDraftCheck() { checks++; failDraftCheck(); } });
    assert.equal(checks, 0);
    assert.equal(result.speech, featureAnswer);
    assert.equal(result.generations, 2);
    assert.equal(result.decisions, 1);
    assert.ok(result.trace.generationGuard.violations.includes(violation));
  }
});

test("v24 OFF は複数の扱いと人主導の移行の構造・公開順を保つ", async () => {
  const extra = "ふくらみはどんな形ですか？";
  const request = "次の図形に進みましょう。";
  const moveOn = "では、次の図形を見ましょう。";
  const body = "ふくらみは丸いです。";
  const parts = [{ item: 1, text: body }, { item: 0, text: featureAnswer }];
  const drafts = [JSON.stringify({ parts }), JSON.stringify({ parts, moveOn, observationFeatures: 42 })];
  const result = await run("repair-first", GENERATION_RETRY_V24, proposal + extra + request, {
    action: "confirm", target: "figure_0", referent: "figure_0", postGenerationCheck: "off", drafts,
    extraction: JSON.stringify([proposalSegment, { ...proposalSegment, segmentId: "extra", quote: extra, proposition: extra,
      targets: [OWN.ownAnchors[1].id], aspect: "question", name: null }]),
    onDraftCheck: failDraftCheck,
    choose(key, criteria) {
      return ({ segment_0_act: "name_propose", segment_1_act: "ask", extra_0: "repair", human_move_on_source: "human_request" } as Record<string, string>)[key] ??
        (key === "visual_purpose" ? Object.keys(criteria).find(label => label.startsWith("issue_")) ?? "unknown" : choose(key));
    },
  });
  const expected = [body, featureAnswer].join("\n");
  assert.equal(result.generations, 2);
  assert.equal(result.decisions, 1);
  assert.equal(result.speech, expected + "\n" + moveOn);
  assert.equal(result.state.repairHistory.at(-1).question, expected);
  assert.deepEqual(result.trace.generatedPublication?.parts?.map(part => part.item), [1, 0]);
  assert.deepEqual(result.trace.generationGuard.violations, ["draft_structure_mismatch"]);
});

test("v24 の提案では別の名前や選択名の合意を公開しない", async () => {
  const invalid = [["「魚」にしませんか？", "propose_question"], ["では「鳥」で決まりです。", "adopt_chosen"]] as const;
  for (const [draft, verdict] of invalid) {
    const result = await run("bypass-enabled", GENERATION_RETRY_V24, suggested, propose([draft, ordinary], verdict));
    assert.equal(result.speech, ordinary);
    assert.equal(result.decisions, 1);
    assert.equal(result.generations, 2);
    assert.equal(result.state.ledger[figure].status, "tentative");
  }
});

test("v24 は方位語だけで再稿にせず、相手の盤面の断定と計画外の移行を拒む", async () => {
  for (const draft of ["私には右向きの鳥に見えます。", "こちらから見た場合、右向きの鳥に見えます。"]) {
    assert.deepEqual(findOrientationLeaks(draft, "holistic_v5", GENERATION_RETRY_V23), ["orientation_leak"]);
    for (const label of labels) {
      const result = await run(label, GENERATION_RETRY_V24, stay,
        { action: "accept", target: "none", drafts: [draft], aiExtraction: "[]", choose });
      assert.equal(result.speech, draft);
      assert.equal(result.generations, 1);
      assert.equal(result.decisions, 1);
    }
  }
  const next = "この図形をいったん置いて、次のを見よう。";
  const safe = "いま見ている図形のことですね。";
  const partner = "そちらの画面でも同じ右向きです。";
  for (const draft of [partner, next]) {
    for (const label of labels) {
      const result = await run(label, GENERATION_RETRY_V24, stay, {
        action: "accept", target: "none", drafts: [draft, safe], aiExtraction: "[]",
        choose: (key, _criteria, context) => key === "draft_topic_shift" && draft === next && context.generationCalls === 1
          ? "unsupported_shift" : choose(key),
      });
      assert.equal(result.speech, safe);
      assert.equal(result.generations, 2);
      assert.equal(result.decisions, 1);
      assert.ok(result.trace.generationGuard.violations.includes(draft === next ? "unsupported_topic_shift" : "shared_view_assumption"));
    }
  }
});
