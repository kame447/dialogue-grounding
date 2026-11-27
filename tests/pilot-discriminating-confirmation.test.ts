import assert from "node:assert/strict";
import test from "node:test";
import { verifyRecords } from "../dialogue-model/runtime/diagnostics/parity-verify/index.ts";
import { hash } from "../dialogue-model/runtime/diagnostics/parity-verify/core.ts";
import { buildRecords, OLD, OWN } from "./support/s4-v3-records.ts";
import type { Label, Turn } from "./support/s4-v3-records.ts";

const common = "直線の輪郭";
const repeated = "輪郭が直線で囲まれている";
const useful = "細長い板に三角形が接している";
const notch = "板に四角い切れ目がある";
const genericQuestion = "輪郭が直線で囲まれていますか？";
const repeatedQuestion = "先ほどの形も輪郭が直線ですか？";
const name = "帆かけ";
const options = { dialoguePolicy: "holistic_v5", agreeNameScopeVersion: "scoped_v11",
  technicalTrial: { version: "adaptive_repair_v3" } } as const;
const oldVersion = "jev_generation_retry_v15" as const;
const newVersion = "jev_generation_retry_v16" as const;
const memo = structuredClone(OLD.state.observationMemo);
for (const figure of memo.figures) figure.analytic.shapes = [common, repeated];
memo.figures[0].analytic.shapes.push(useful, notch);
const ownIds: string[] = OWN.ownAnchors.map((a: { id: string }) => a.id);

function segment(quote: string, proposition: string, aspect: string, targets: string[], label: string | null = null) {
  return JSON.stringify([{ segmentId: "1", quote, proposition, targets, respondsToTurn: null,
    linkedIssueId: null, aspect, name: label }]);
}

function draft(feature: string): Turn["plan"]["choose"] {
  return (key, criteria) => key === "feature"
    ? Object.keys(criteria).find(label => JSON.parse(criteria[label]).value === feature) : undefined;
}

const confirmationDraft = (checkedFeature: string, text: string) => JSON.stringify({ checkedFeature, text });

function structuredTurn(turn: Turn, feature: string): Turn {
  assert.ok(turn.plan.speech);
  return { ...turn, plan: { ...turn.plan, speech: confirmationDraft(feature, turn.plan.speech) } };
}

const first: Turn = { human: "この形の特徴を確認できますか？",
  plan: { action: "confirm", target: "figure_0", referent: "multiple", speech: genericQuestion, choose: draft(common) } };
const affirmed: Turn = { human: "どれもその特徴があります。",
  plan: { action: "confirm", target: "figure_0", referent: "multiple", speech: repeatedQuestion, choose: draft(repeated),
    extraction: segment("どれもその特徴があります。", common, "contour", ownIds) } };
const finalize: Turn = { human: "ひとまず先ほどの帆かけで決めましょう。",
  plan: { action: "confirm", target: "figure_0", referent: "multiple", speech: genericQuestion, choose: draft(common),
    extraction: segment("ひとまず先ほどの帆かけで決めましょう。", "先ほどの帆かけで決めましょう", "name", [], name),
    act: "name_propose" } };

test("v15 can send the selected universal detail even after it is publicly affirmed", async () => {
  const actual: { feature: string | null; speech: string | null; local: unknown }[] = [];
  const records = await buildRecords({ ...options, generationRetryVersion: oldVersion, memo, turns: [first, affirmed, finalize],
    onTurn: (label, result) => {
      if (label === "repair-first") actual.push({ feature: result.trace.executed.feature, speech: result.speech, local: result.trace.local?.claims });
    } });
  assert.deepEqual(actual.map(({ feature, speech }) => [feature, speech]), [
    [common, genericQuestion], [repeated, repeatedQuestion], [useful, genericQuestion],
  ]);
  assert.ok((actual[1].local as any[]).some(claim => claim.speaker === "human" && claim.targets.length === ownIds.length));
  assert.ok((actual[2].local as any[]).some(claim => claim.act === "name_propose" && claim.name === name));
  assert.equal(records.trials[0].attempts[0].executed.action, "confirm");
  assert.equal(records.trials[0].lastCommittedState.ledger[ownIds[0]].name, null);
  assertS4(records);
});

type Request = { provider: string; phase: string; preProjectionPayloadSha256: string;
  payload: { state?: string; questions?: Record<string, { instructions: string; criteria: Record<string, string> }>;
    messages?: { role: string; content: string }[] } };

function requests(records: Awaited<ReturnType<typeof buildRecords>>, label: Label): Request[] {
  return records.trials[0].replay[0].result.sides.find((side: { label: string }) => side.label === label).requests;
}

function assertS4(records: Awaited<ReturnType<typeof buildRecords>>) {
  const checks = verifyRecords(records).checks.filter(check => check.id.startsWith("intervention.trial.0.attempt.0."));
  assert.equal(checks.length, 4);
  for (const check of checks) assert.equal(check.status, "pass", check.id);
}

function assertConfirmWire(wire: Request[], feature: string) {
  const detail = wire.find(request => request.payload.questions?.feature)?.payload.questions?.feature;
  assert.ok(detail);
  assert.match(detail.instructions, /全候補に共通するだけの特徴/);
  assert.match(detail.instructions, /肯定・否定・訂正/);
  assert.match(detail.instructions, /呼び名の決定の申し出/);
  const generation = wire.find(request => request.phase === "generation")?.payload.messages;
  assert.ok(generation);
  const confirmation = generation.find(message => message.role === "system" && message.content.includes("選ばれた特徴を根拠に"));
  assert.ok(confirmation);
  assert.match(confirmation.content, /別の特徴を選び直さず/);
  assert.match(confirmation.content, /checkedFeatureとtext/);
  assert.ok(confirmation.content.includes(JSON.stringify({ discriminatingFeature: feature }).slice(1, -1)));
}

for (const label of ["repair-first", "bypass-enabled"] as const) {
  test(`v16 ${label} retains an ambiguous naming request and uses the recorded detail`, async () => {
    const betterAfterYes = { ...affirmed, plan: { ...affirmed.plan, choose: draft(useful),
      speech: "細長い板に三角形が接している形のことですか？" } };
    const betterAfterName = { ...finalize, plan: { ...finalize.plan, choose: draft(notch),
      speech: "今の案の形は、板に四角い切れ目があるものですか？" } };
    const turns = [first, betterAfterYes, betterAfterName];
    const before = await buildRecords({ ...options, label, generationRetryVersion: oldVersion, memo, turns });
    const after = await buildRecords({ ...options, label, generationRetryVersion: newVersion, memo,
      turns: [structuredTurn(first, common), structuredTurn(betterAfterYes, useful), structuredTurn(betterAfterName, notch)] });
    const trial = after.trials[0];
    const original = before.trials[0].attempts[0];
    const updated = trial.attempts[0];
    assert.equal(updated.namingRequest, true);
    assert.equal(updated.humanReferent.scores.multiple, 1);
    assert.equal(updated.executed.action, "confirm");
    assert.deepEqual(updated.executed, original.executed);
    assert.deepEqual(updated.intervention, original.intervention);
    assert.equal(updated.executed.feature, notch);
    assert.equal(trial.turns[0].publicText, betterAfterName.plan.speech);
    assert.ok(Object.values(trial.lastCommittedState.ledger).every(value => (value as { name: string | null }).name === null));
    const oldWire = requests(before, label), newWire = requests(after, label);
    assert.equal(newWire.length, oldWire.length);
    assertConfirmWire(newWire, notch);
    for (const [i, request] of oldWire.entries()) {
      if (request.payload.questions?.feature) {
        assert.equal(newWire[i].payload.state, request.payload.state);
        assert.deepEqual(newWire[i].payload.questions?.feature.criteria, request.payload.questions.feature.criteria);
        assert.doesNotMatch(request.payload.questions.feature.instructions, /全候補に共通するだけの特徴/);
      } else if (request.phase !== "generation") {
        assert.equal(newWire[i].preProjectionPayloadSha256, request.preProjectionPayloadSha256);
      }
    }
    assertS4(before);
    assertS4(after);
  });
}

test("v16 keeps repair-first veto and bypass-enabled's original action on the same material", async () => {
  const turns: Turn[] = [{ human: "この形はまだ見分けられません。", plan: { action: "defer", target: "figure_0",
    actionScores: { defer: 0.6, confirm: 0.3, repair: 0.1 }, choose: draft(useful),
    speechByLabel: { "repair-first": confirmationDraft(useful, "細長い板に三角形が接している形ですか？"),
      "bypass-enabled": "この形の話には、あとで戻りましょう。" } } }];
  const records = await buildRecords({ ...options, generationRetryVersion: newVersion, memo, turns });
  const result = records.trials[0].replay[0].result;
  assert.equal(result.commonEqual, true);
  assert.deepEqual(result.sides.map((side: any) => [side.label, side.executed.action, side.intervention.disposition]), [
    ["repair-first", "confirm", "rejected"], ["bypass-enabled", "defer", "adopted"],
  ]);
  assertConfirmWire(requests(records, "repair-first"), useful);
  assert.ok(!requests(records, "bypass-enabled").some(request => request.payload.questions?.feature));
  assertS4(records);
});

test("v16 reoffers contrast from the same target when the only unasked feature is common", async () => {
  const sparse = structuredClone(memo);
  for (const figure of sparse.figures) figure.analytic = { shapes: [common], composition: common, relations: [] };
  sparse.figures[0].analytic.shapes.push(useful);
  const firstCheck = { ...first, plan: { ...first.plan, choose: draft(useful), speech: "細長い板に三角形が接していますか？" } };
  const followUp: Turn = { human: "その部分がまだよく分かりません。", plan: { ...first.plan, choose: draft(useful),
    speech: "こちらでは細長い板に三角形が接して見えます。そちらではどこがつながっていますか？" } };
  const before = await buildRecords({ ...options, generationRetryVersion: oldVersion, memo: sparse, turns: [firstCheck, followUp] });
  const after = await buildRecords({ ...options, generationRetryVersion: newVersion, memo: sparse,
    turns: [structuredTurn(firstCheck, useful), structuredTurn(followUp, useful)] });
  const criteria = (wire: Request[]) => Object.values(wire.find(r => r.payload.questions?.feature)!.payload.questions!.feature.criteria)
    .map(value => JSON.parse(value));
  for (const label of ["repair-first", "bypass-enabled"] as const) {
    assert.deepEqual(criteria(requests(before, label)), [{ value: common, figureIds: [ownIds[0]] }]);
    const newWire = requests(after, label);
    assert.deepEqual(criteria(newWire), [common, useful].map(value => ({ value, figureIds: [ownIds[0]] })));
    assertConfirmWire(newWire, useful);
  }
  const execution = after.trials[0].attempts[0].executed;
  assert.equal(execution.action, "confirm");
  assert.deepEqual(execution.target, before.trials[0].attempts[0].executed.target);
  assert.equal(execution.feature, useful);
  assert.equal(after.trials[0].turns[0].publicText, followUp.plan.speech);
  assertS4(after);

  for (const figure of sparse.figures) figure.analytic.shapes = [common];
  const noContrast: Turn = { ...followUp, plan: { ...followUp.plan, choose: draft(common),
    speech: "輪郭が直線という見立てですが、どの部分の輪郭を指していますか？" } };
  const stillChecking = await buildRecords({ ...options, generationRetryVersion: newVersion, memo: sparse,
    turns: [structuredTurn(noContrast, common)] });
  assert.deepEqual(criteria(requests(stillChecking, "repair-first")), [{ value: common, figureIds: [ownIds[0]] }]);
  assert.equal(stillChecking.trials[0].attempts[0].executed.action, "confirm");
  assert.equal(stillChecking.trials[0].turns[0].publicText, noContrast.plan.speech);
  assertS4(stillChecking);
});

test("v16 preserves supported naming and the non-confirmation requests byte for byte", async () => {
  const described = "私の側では、細長い板に三角形が接しています。";
  const proposal = `今の形を「${name}」と呼びませんか？`;
  const turns: Turn[] = [{ human: "どんな形に見えますか？", plan: {
    action: "accept", target: "figure_0", referent: "figure_0", speech: described,
    aiExtraction: segment(described, useful, "part", [ownIds[0]]), aiActs: ["assert"],
  } }, { human: proposal, plan: { action: "agree", target: "figure_0", referent: "figure_0", prospect: "no_open_issue",
    act: "name_propose", extraction: segment(proposal, proposal, "name", [ownIds[0]], name), drafts: [`「${name}」にしましょう。`],
  } }];
  const before = await buildRecords({ ...options, generationRetryVersion: oldVersion, memo, turns });
  const after = await buildRecords({ ...options, generationRetryVersion: newVersion, memo, turns });
  assert.deepEqual(after.trials[0].lastCommittedState.ledger[ownIds[0]], { name, status: "agreed" });
  for (const label of ["repair-first", "bypass-enabled"] as const) {
    assert.deepEqual(requests(after, label).map(r => r.preProjectionPayloadSha256), requests(before, label).map(r => r.preProjectionPayloadSha256));
  }
  assertS4(after);
});

test("v16 confirmation retries retain v15 orientation recovery", async () => {
  const leaked = "左側が細長い形ですか？";
  const turns: Turn[] = [{ human: "形の特徴をもう一度お願いします。", plan: {
    action: "confirm", target: "figure_0", referent: "figure_0", choose: draft(useful),
    drafts: [confirmationDraft(useful, leaked), confirmationDraft(useful, leaked)],
  } }];
  const records = await buildRecords({ ...options, generationRetryVersion: newVersion, memo, turns });
  const { executed, generationGuard, publicationRecovery } = records.trials[0].attempts[0];
  assert.equal(executed.feature, useful);
  assert.deepEqual(generationGuard.violations, ["orientation_leak"]);
  assert.equal(publicationRecovery.act, "restate_selected_action");
  assert.equal(records.trials[0].turns[0].publicText, "その形の特徴について、もう少し詳しく教えてもらえますか？");
  assertS4(records);
});

test("v16 rewrites a confirmation that asks about the already affirmed common feature", async () => {
  const correctQuestion = "帯のような部分に三角の先がくっついて見えますか？";
  const wrongDetail = { ...affirmed, plan: { ...affirmed.plan, choose: draft(useful),
    drafts: [repeatedQuestion, confirmationDraft(useful, correctQuestion)] } };
  const records = await buildRecords({ ...options, generationRetryVersion: newVersion, memo,
    turns: [structuredTurn(first, common), wrongDetail] });
  const trial = records.trials[0];
  assert.equal(trial.attempts[0].executed.feature, useful);
  assert.equal(trial.attempts[0].generationGuard.regenerated, true);
  assert.equal(trial.turns[0].publicText, correctQuestion);
  for (const label of ["repair-first", "bypass-enabled"] as const) {
    const wire = requests(records, label);
    assert.equal(wire.filter(request => request.phase === "generation").length, 2);
    assert.equal(wire.filter(request => request.payload.questions?.draft_naming).length, 0);
  }
  assertS4(records);
});

test("v16 recovers the same confirmation after two mismatched feature declarations", async () => {
  const wrongDraft = confirmationDraft(common, repeatedQuestion);
  const mismatch = { ...affirmed, plan: { ...affirmed.plan, choose: draft(useful), drafts: [wrongDraft, wrongDraft] } };
  for (const label of ["repair-first", "bypass-enabled"] as const) {
    const records = await buildRecords({ ...options, label, generationRetryVersion: newVersion, memo,
      turns: [structuredTurn(first, common), mismatch] });
    const trial = records.trials[0];
    const { executed, generationGuard, publicationRecovery } = trial.attempts[0];
    assert.equal(executed.action, "confirm");
    assert.deepEqual(executed.target, { kind: "single", figureId: ownIds[0] });
    assert.equal(executed.feature, useful);
    assert.equal(generationGuard.regenerated, true);
    assert.deepEqual(generationGuard.violations, ["confirmation_detail_mismatch"]);
    assert.equal(publicationRecovery.act, "restate_selected_action");
    assert.equal(trial.turns[0].publicText, "その形の特徴について、もう少し詳しく教えてもらえますか？");
    assert.ok(Object.values(trial.lastCommittedState.ledger).every(value => (value as { name: string | null }).name === null));
    assert.equal(requests(records, label).filter(request => request.phase === "generation").length, 2);
    assert.equal(requests(records, label).filter(request => request.payload.questions?.draft_naming).length, 0);
    assertS4(records);
  }
});

test("v16 S4 rejects a changed feature declaration even when the recorded public text still matches", async () => {
  const good = { ...affirmed, plan: { ...affirmed.plan, choose: draft(useful),
    speech: "帯のような部分に三角の先がくっついて見えますか？" } };
  for (const label of ["repair-first", "bypass-enabled"] as const) {
    const records = await buildRecords({ ...options, label, generationRetryVersion: newVersion, memo,
      turns: [structuredTurn(first, common), structuredTurn(good, useful)] });
    assertS4(records);
    const replay = records.trials[0].replay[0];
    const side = replay.result.sides.find((value: { label: Label }) => value.label === label);
    const rewriteFeature = (tail: { luna: { phase: string; response: { text: string } }[] }) => {
      const completion = tail.luna.find(call => call.phase === "generation");
      assert.ok(completion);
      assert.deepEqual(JSON.parse(completion.response.text), { checkedFeature: useful, text: good.plan.speech });
      completion.response.text = confirmationDraft(common, good.plan.speech);
    };
    rewriteFeature(replay.tape.tails[label]);
    rewriteFeature(side.material.tail);
    side.materialSha256 = hash(side.material);
    const pair = records.evidence.pairedReplay[0];
    [pair.left, pair.right] = structuredClone(replay.result.sides);
    const result = verifyRecords(records).checks.find(check => check.id === "intervention.trial.0.attempt.0.replay");
    assert.equal(result?.status, "mismatch");
  }
});
