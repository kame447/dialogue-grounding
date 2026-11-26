// Independent P5 expectations. All dialogue and provider responses are synthetic.
import assert from "node:assert/strict";
import test from "node:test";
import { verifyRecords } from "../dialogue-model/runtime/diagnostics/parity-verify/index.ts";
import { priorClaimViews } from "../dialogue-model/runtime/local-grounding/derive.ts";
import { buildRecords, OWN, type Label, type Plan, type Turn } from "./support/s4-v3-records.ts";

const conditions = ["repair-first", "bypass-enabled"] as const;
const [left, right] = OWN.ownAnchors.map((a: { id: string }) => a.id) as [string, string];
const sail = "帆";
const flute = "笛";
const looseEnd = "切れ込みの形はまだ照合できていません。";
const useSail = "その見立ては共通の目印になります。" + looseEnd;
const acknowledgement = "帆に見えるというお話ですね。";
const rejectSail = "帆という見立ては今回は目印に使いません。";
const request = "その見立てを目印に、次の特徴を話せますか？";

function segment(quote: string, targets: string[], proposition: string, respondsToTurn: number | null = null,
  linkedIssueId: string | null = null, aspect = "construal", name: string | null = null) {
  return JSON.stringify([{ segmentId: "s1", quote, targets, proposition, respondsToTurn, linkedIssueId, aspect, name }]);
}

function responseTo(claimId: string): Plan["choose"] {
  return (key, criteria) => key.endsWith("_antecedent")
    ? Object.entries(criteria).find(([, description]) => description.includes(JSON.stringify(claimId)))?.[0] ?? "none"
    : undefined;
}

function neutral(speech = "そう見えるんですね。", target = "figure_0"): Plan {
  return { action: "accept", target, referent: target.startsWith("figures_") ? "multiple" : target, speech };
}

function humanFirst(targets = [left], target = "figure_0", reading = sail): Turn {
  const human = `私には大まかに${reading}に見えます。`;
  const ai = `こちらでも大まかには${reading}に見えます。`;
  return { human, plan: { ...neutral(ai, target), extraction: segment(human, targets, reading), act: "construe",
    aiExtraction: segment(ai, targets, reading, 1), aiActs: ["agree"], choose: responseTo("1:local1") } };
}

function aiFirst({ targets = [left], target = "figure_0", reading = sail, start = 1,
  issue = null }: { targets?: string[]; target?: string; reading?: string; start?: number; issue?: string | null } = {}): Turn[] {
  const ai = `私の側では大まかに${reading}に見えます。`;
  const human = `こちらでも大まかに${reading}に見える点は同意します。`;
  if (issue) {
    const proposed = `こちらの別の形は大まかに${reading}に見えます。`;
    return [{ human: proposed, plan: { ...neutral(ai, target), act: "construe",
      extraction: segment(proposed, targets, reading, null, issue), aiExtraction: segment(ai, targets, reading, start),
      aiActs: ["agree"], choose: responseTo(`${start}:local1`) } }];
  }
  return [
    { human: "どんな全体の形に見えますか？", plan: { ...neutral(ai, target),
      aiExtraction: segment(ai, targets, reading), aiActs: ["construe"] } },
    { human, plan: { ...neutral(undefined, target), act: "agree",
      extraction: segment(human, targets, reading, start + 1), choose: responseTo(`${start + 2}:pub1`) } },
  ];
}

type Candidate = { construal: string; figureIds: string[]; claimIds: string[] };
const question = "shared_construal";

// This is the existing #192 wire vocabulary. Keep field-name mappings here
// if the new pin changes them, so the acceptance assertions stay independent.
function candidates(criteria: Readonly<Record<string, string>>) {
  return Object.entries(criteria).filter(([key]) => key !== "none").map(([key, value]) =>
    ({ key, ...JSON.parse(value) as Candidate }));
}
function finish(speech = useSail, reading = sail, target = "figure_0", chooseUse = true): Turn {
  return { human: request, plan: { ...neutral(speech, target), choose: (key, criteria) => key === question
    ? (chooseUse ? candidates(criteria).find(c => c.construal === reading)?.key : "none") ?? "none" : undefined } };
}

function run(label: Label, turns: Turn[]) {
  return buildRecords({ label, turns, dialoguePolicy: "holistic_v5", generationRetryVersion: "jev_generation_retry_v12",
    technicalTrial: { version: "adaptive_repair_v3" } }).catch(error => {
    const trace = error.traces?.at(-1);
    if (!trace) throw error;
    throw new Error(JSON.stringify({ error: trace.errorCode, guard: trace.generationGuard,
      decision: trace.decisionFailure, turn: trace.turnIndex }), { cause: error });
  });
}
type Records = Awaited<ReturnType<typeof run>>;
type Choice = { criteria: Record<string, string> };
function observed(records: Records, label: Label) {
  const trial = records.trials[0];
  const replay = trial.replay[0];
  const side = replay.result.sides.find((s: { label: Label }) => s.label === label);
  assert.ok(side);
  const menus = side.requests.flatMap((r: { payload?: { questions?: Record<string, Choice> } }) =>
    r.payload?.questions?.[question] ? [r.payload.questions[question].criteria] : []);
  return { trial, replay, side, menus, trace: trial.attempts[0], text: trial.turns[0].publicText,
    judgment: trial.lastCommittedState.judgments.at(-1).jevTurn,
    claims: priorClaimViews(trial.lastCommittedState.graph, { limit: trial.lastCommittedState.graph.records.length }) };
}
type Observation = ReturnType<typeof observed>;

function pair(o: Observation, reading: string, targets: string[], sourceTurns: [number, number]) {
  const [source, support] = sourceTurns.map(turn => o.claims.find(c => c.sourceTurn === turn &&
    c.aspect === "construal" && c.proposition === reading));
  assert.ok(source && support, "fixture must produce verified public construal and support: " +
    JSON.stringify(o.claims.map(({ id, sourceTurn, speaker, act, aspect, proposition, respondsTo }) =>
      ({ id, sourceTurn, speaker, act, aspect, proposition, respondsTo }))));
  assert.notEqual(source.speaker, support.speaker);
  assert.equal(support.respondsTo, source.id);
  assert.equal(o.menus.length, 1, "decision must offer a closed common-reference choice");
  assert.ok(Object.hasOwn(o.menus[0], "none"), "ordinary acknowledgement stays available");
  const choices = candidates(o.menus[0]);
  const selected = choices.find(c => c.construal === reading);
  assert.ok(selected, "the jointly supported reading must be offered");
  assert.deepEqual([...selected.figureIds].sort(), [...targets].sort());
  assert.deepEqual([...selected.claimIds].sort(), [source.id, support.id].sort());
  return selected;
}

function s4(records: Records, o: Observation) {
  assert.equal(o.replay.result.status, "same_material_intervention_verified");
  assert.equal(o.replay.result.recordedPayloadsReproduced, true);
  const checks = verifyRecords(records).checks.filter(c => c.id.startsWith("intervention.trial.0.attempt.0."));
  assert.ok(checks.some(c => c.id.endsWith(".replay")), "S4 must actually check replay");
  assert.ok(checks.every(c => c.status === "pass"), JSON.stringify(checks));
}

function effects(o: Observation, candidate: Candidate, published: boolean) {
  assert.deepEqual([...o.judgment.executed.sharedClaimIds].sort(), [...candidate.claimIds].sort(),
    "typed choice retains the actual evidence regardless of what gets published");
  assert.equal(o.trace.sharedPublished, published, "publication reflects the meaning of the delivered utterance");
  assert.equal(o.trace.publicSpeech, o.text, "public result is tied to the delivered utterance");
  assert.deepEqual(o.trial.lastCommittedState.ledger, o.replay.tape.state.ledger, "P5 must not agree a name");
}

for (const label of conditions) {
  test(`P5 ${label}: partner-first support enables joint use, keeps details open, and does not name`, async () => {
    const records = await run(label, [humanFirst(), finish()]);
    const o = observed(records, label);
    effects(o, pair(o, sail, [left], [1, 2]), true);
    assert.equal(o.text, useSail);
    s4(records, o);
  });

  test(`P5 ${label}: a question or a different reading supplies no second voice`, async () => {
    const [proposal] = aiFirst();
    for (const [text, act, reading] of [
      ["それは帆に見えるということですか？", "ask", sail],
      ["こちらでは笛に見えます。", "construe", flute],
    ]) {
      const records = await run(label, [proposal, { human: text, plan: { ...neutral(), act,
        extraction: segment(text, [left], reading, act === "ask" ? 2 : null) } }, finish(acknowledgement)]);
      const o = observed(records, label);
      assert.ok(o.claims.some(c => c.sourceTurn === 2 && c.act === "construe"));
      assert.deepEqual(o.menus.flatMap(candidates), []);
      assert.deepEqual(o.trial.lastCommittedState.ledger, o.replay.tape.state.ledger);
    }
  });

  test(`P5 ${label}: direct support in a common issue stays tied to each figure`, async () => {
    const turns = [...aiFirst({ targets: [left, right] }), ...aiFirst({ targets: [right], target: "figure_1",
      reading: flute, start: 5, issue: "3:pub1" }), finish()];
    // The first ratification is only about the left-hand shape.
    turns[1].plan.extraction = segment(turns[1].human, [left], sail, 2);
    const records = await run(label, turns);
    const o = observed(records, label);
    const a = o.claims.find(c => c.sourceTurn === 3 && c.aspect === "construal");
    const b = o.claims.find(c => c.sourceTurn === 5 && c.aspect === "construal");
    assert.ok(a && b);
    assert.equal(a.issueId, b.issueId, "the two evidence pairs must share the same issue");
    const rightRecords = await run(label, [...turns.slice(0, -1), finish("笛に見える形を目印にしましょう。", flute, "figure_1")]);
    const rightObserved = observed(rightRecords, label);
    const offered = pair(o, sail, [left], [2, 3]);
    assert.ok(!candidates(o.menus[0]).some(c => c.construal === flute && c.figureIds.includes(left)));
    effects(o, offered, true);
    effects(rightObserved, pair(rightObserved, flute, [right], [5, 6]), true);
  });

  test(`P5 ${label}: a chosen one-character reading survives paraphrase, acknowledgement and refusal`, async () => {
    for (const [speech, published] of [[`帆に見える形を目印にしましょう。`, true], [useSail, true],
      [acknowledgement, false], [rejectSail, false]] as const) {
      const records = await run(label, [...aiFirst(), finish(speech)]);
      const o = observed(records, label);
      effects(o, pair(o, sail, [left], [2, 3]), published);
      assert.equal(o.text, speech);
    }
  });

  test(`P5 ${label}: an ambiguous pair permits coarse use and blocks invented identity or detail agreement`, async () => {
    const targets = [left, right], target = "figures_0_1";
    const prior = aiFirst({ targets, target });
    const safe = "その見立てを目印にしましょう。細部まで同じではありません。";
    const control = observed(await run(label, [...prior, finish(safe, sail, target)]), label);
    effects(control, pair(control, sail, targets, [2, 3]), true);
    assert.equal(control.text, safe);
    for (const overclaim of [
      "帆を目印にしましょう。これで互いに見ている形を一つに特定できました。",
      "帆を目印にしましょう。切れ込みの形も双方で完全に一致しています。",
      "帆を目印にしましょう。この図形の名前は帆に決まりました。",
    ]) {
      const turn = finish(overclaim, sail, target);
      turn.plan.drafts = [overclaim, safe];
      const o = observed(await run(label, [...prior, turn]), label);
      assert.equal(o.text, safe, "a semantically unsafe draft must be corrected before delivery");
      effects(o, pair(o, sail, targets, [2, 3]), true);
    }
  });

  test(`P5 ${label}: a naming request gets a separate clarifying response`, async () => {
    const human = "この図形を「羽」と呼びませんか？";
    const speech = "その見立ては目印にできます。羽と呼びたいのは、切れ込みのある形ですか？";
    const turn = finish(speech);
    turn.human = human;
    Object.assign(turn.plan, { action: "confirm", act: "name_propose",
      extraction: segment(human, [], "羽という名前の提案", null, null, "name", "羽") });
    const records = await run(label, [...aiFirst(), turn]);
    const o = observed(records, label);
    assert.equal(o.trace.namingRequest, true);
    assert.equal(o.trace.executed.action, "confirm");
    assert.equal(o.text, speech);
    effects(o, pair(o, sail, [left], [2, 3]), true);
  });

  test(`P5 ${label}: later repair can reopen the unresolved feature on the same reference`, async () => {
    const human = "さっきの見立ての形ですが、切れ込みはありますか？";
    const speech = "切れ込みの形をもう一度比べましょう。";
    const follow = { human, plan: { ...neutral(speech), action: "confirm", act: "ask",
      extraction: segment(human, [left], "切れ込みの形", null, null, "contour") } };
    const records = await run(label, [...aiFirst(), finish(), follow]);
    const o = observed(records, label);
    const earlier = o.replay.tape.state.judgments.at(-1).jevTurn;
    assert.ok(earlier.executed.sharedClaimIds?.length, "the previous turn actually chose P5");
    assert.equal(o.trace.executed.action, "confirm");
    assert.equal(o.trace.executed.target.figureId, left);
    assert.equal(o.text, speech);
    assert.deepEqual(o.trial.lastCommittedState.ledger, o.replay.tape.state.ledger);
    s4(records, o);
  });
}

test("P5: S4 accepts each side's own post-veto choice and public result in both saved directions", async () => {
  for (const label of conditions) for (const [speech, chosen, published] of [
    [acknowledgement, false, false], [useSail, true, true], [acknowledgement, true, false],
  ] as const) {
    const turn = finish(speech, sail, "figure_0", chosen);
    Object.assign(turn.plan, { action: "defer", actionScores: { defer: 1, accept: 0.9 },
      speechByLabel: { "bypass-enabled": "その点はいったん保留にしましょう。" } });
    const records = await run(label, [...aiFirst(), turn]);
    const repair = observed(records, "repair-first");
    const bypass = observed(records, "bypass-enabled");
    assert.equal(repair.side.executed?.action, "accept", "repair runs the post-veto action");
    assert.equal(bypass.side.executed?.action, "defer", "bypass keeps the original action");
    const selected = pair(repair, sail, [left], [2, 3]);
    assert.deepEqual(bypass.menus.flatMap(candidates), []);
    const o = label === "repair-first" ? repair : bypass;
    if (label === "repair-first" && chosen) effects(o, selected, published);
    else assert.ok(!o.judgment.executed.sharedClaimIds?.length);
    s4(records, o);
  }
});

test("P5: a long public history retains both direct evidence IDs for the adopted reading", async () => {
  const prior = [humanFirst()];
  for (let index = 1; index < 33; index++) {
    prior.push(...aiFirst({ reading: `帆の形の補足${index}`, start: 2 * index + 1, issue: "1:local1" }));
  }
  const start = 2 * 33 + 1;
  const last = "提灯";
  prior.push(...aiFirst({ reading: last, start, issue: "1:local1" }));
  const records = await run("repair-first", [...prior, finish("その見立てを目印にしましょう。", last)]);
  const o = observed(records, "repair-first");
  assert.ok(o.claims.filter(c => c.issueId === "1:local1").length > 32,
    "the synthetic evidence on one issue exceeds the old 32-ID boundary");
  effects(o, pair(o, last, [left], [start, start + 1]), true);
  s4(records, o);
});
