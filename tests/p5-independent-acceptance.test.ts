// Independent P5 expectations. All dialogue and provider responses are synthetic.
import assert from "node:assert/strict";
import test from "node:test";
import type { LocalClaimView } from "../dialogue-model/runtime/local-grounding/contract.ts";
import { verifyRecords } from "../dialogue-model/runtime/diagnostics/parity-verify/index.ts";
import { hash } from "../dialogue-model/runtime/diagnostics/parity-verify/core.ts";
import { promptSourceManifest } from "../dialogue-model/runtime/diagnostics/parity-live/audit.ts";
import { validGenerationRetryVersion } from "../dialogue-model/runtime/v2/generation-guard.ts";
import { deriveLocalIssues, priorClaimViews } from "../dialogue-model/runtime/local-grounding/derive.ts";
import { buildRecords, OWN, runTurn, type Label, type Plan, type Turn } from "./support/s4-v3-records.ts";

const conditions = ["repair-first", "bypass-enabled"] as const;
const [left, right] = OWN.ownAnchors.map((a: { id: string }) => a.id) as [string, string];
const sail = "帆";
const flute = "笛";
const detail = "切れ込みの形";
const looseEnd = "切れ込みの形はまだ照合できていません。";
const useSail = "その見立ては共通の目印になります。" + looseEnd;
const acknowledgement = "帆に見えるというお話ですね。";
const rejectSail = "帆という見立ては今回は目印に使いません。";
const request = "その見立てを目印に、次の特徴を話せますか？";
const v12 = "jev_generation_retry_v12";
const p5Version: string = "jev_generation_retry_v13";
const supportedP5Version = validGenerationRetryVersion(p5Version, "two_stage_v3", "holistic_v5") &&
  p5Version !== "jev_generation_retry_v1" ? p5Version : undefined;
const technicalTrial = { version: "adaptive_repair_v3" } as const;
// Independently measured with P5 off on both producer lineages. S4 also checks
// the complete manifest of the code that actually issued the requests.
const v12HttpDigests = new Map([
  // 671acdb
  ["aa8b84ba60f10780328521457fc3abf4bfaa6db6efd32a725924075a9584f884", "a69b96be57143a984f2c7c7fc5c78f7bd82982c97119700a1498776d5ef6f13b"],
  // 17e56bc, 1171a04, 9bc0587
  ["9d686330aa34a516a1e2d95df94d0b030e7308a6463757861b9c94e561e5197a", "fd431c3fa99aef1ab219980d38d44cae3e3167c86f4b2230aaa7c64d99176f00"],
  // dffce2a separates participant prompts and restores the 671acdb research request bytes.
  ["0add2f40aaaa01bfdacd1b99418b94e288eb45da6593595304f8d36d0f22de27", "a69b96be57143a984f2c7c7fc5c78f7bd82982c97119700a1498776d5ef6f13b"],
]);
const promptSources = await promptSourceManifest();

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

async function run(label: Label, turns: Turn[], version: "p5" | "v12" = "p5") {
  // The original base predates the v13 parser. Probe its v12 path so a red
  // assertion can name the absent behavior. Once supported, P5 pins v13.
  const generationRetryVersion = version === "p5" ? supportedP5Version ?? v12 : v12;
  const outcomes: Record<Label, Awaited<ReturnType<typeof runTurn>>[]> = { "repair-first": [], "bypass-enabled": [] };
  const records = await buildRecords({ label, turns, dialoguePolicy: "holistic_v5", generationRetryVersion,
    technicalTrial, promptSources,
    onTurn: (side, outcome) => outcomes[side].push(outcome) }).catch(error => {
    const trace = error.traces?.at(-1);
    if (!trace) throw error;
    throw new Error(JSON.stringify({ error: trace.errorCode, guard: trace.generationGuard,
      decision: trace.decisionFailure, turn: trace.turnIndex }), { cause: error });
  });
  if (version === "p5" && supportedP5Version) assert.equal(records.trials[0].replay[0].tape.generationRetryVersion, p5Version);
  return { records, outcomes };
}
type Run = Awaited<ReturnType<typeof run>>;
type Records = Run["records"];
type Choice = { criteria: Record<string, string> };
function observed({ records, outcomes }: Run, label: Label) {
  const trial = records.trials[0];
  const replay = trial.replay[0];
  const side = replay.result.sides.find((s: { label: Label }) => s.label === label);
  assert.ok(side);
  const menus: Choice["criteria"][] = side.requests.flatMap((r: { payload?: { questions?: Record<string, Choice> } }) =>
    r.payload?.questions?.[question] ? [r.payload.questions[question].criteria] : []);
  const outcome = outcomes[label].at(-1)!;
  return { trial, replay, side, menus, outcome, trace: outcome.trace, text: outcome.speech,
    judgment: outcome.state.judgments.at(-1).jevTurn,
    claims: priorClaimViews(outcome.state.graph, { limit: outcome.state.graph.records.length }) };
}
type Observation = ReturnType<typeof observed>;

function pair(o: Observation, reading: string, targets: string[], sourceTurns: [number, number]) {
  const [source, support] = sourceTurns.map(turn => o.claims.find(c => c.sourceTurn === turn &&
    c.aspect === "construal" && c.proposition === reading));
  assert.ok(source && support, "fixture must produce verified public construal and support: " +
    JSON.stringify(o.claims.map(({ id, sourceTurn, speaker, act, aspect, proposition, respondsTo }) =>
      ({ id, sourceTurn, speaker, act, aspect, proposition, respondsTo }))));
  assert.ok(source.act === "construe" || source.act === "assert");
  assert.equal(support.act, "agree");
  assert.notEqual(source.speaker, support.speaker);
  assert.equal(support.respondsTo, source.id);
  assert.equal(o.menus.length, 1, "decision must offer a closed common-reference choice");
  assert.ok(Object.hasOwn(o.menus[0], "none"), "ordinary acknowledgement stays available");
  const choices = candidates(o.menus[0]);
  const selected = choices.find(c => c.construal === reading);
  assert.ok(selected, "the jointly supported reading must be offered");
  assert.deepEqual([...selected.figureIds].sort(), [...targets].sort());
  assert.ok(selected.claimIds.includes(source.id) && selected.claimIds.includes(support.id));
  for (const id of selected.claimIds) {
    if (id === source.id) continue;
    const evidence: LocalClaimView | undefined = o.claims.find(claim => claim.id === id);
    assert.ok(evidence && evidence.act === "agree" && evidence.speaker !== source.speaker &&
      evidence.respondsTo === source.id && evidence.targets.some(figure => targets.includes(figure)));
  }
  return selected;
}

function interventionChecks(records: Records) {
  return verifyRecords(records).checks.filter(c => c.id.startsWith("intervention.trial.0.attempt.0."));
}

function s4({ records }: Run, o: Observation) {
  assert.equal(o.replay.result.status, "same_material_intervention_verified");
  assert.equal(o.replay.result.recordedPayloadsReproduced, true);
  const checks = interventionChecks(records);
  assert.ok(checks.some(c => c.id.endsWith(".replay")), "S4 must actually check replay");
  assert.ok(checks.every(c => c.status === "pass"), JSON.stringify(checks));
}

function effects(o: Observation, candidate: Candidate | null, publicSpeech: string, expectedLedger = o.replay.tape.state.ledger) {
  const expectedIds = candidate ? [...candidate.claimIds].sort() : [];
  assert.deepEqual([...(o.judgment.executed.sharedClaimIds ?? [])].sort(), expectedIds);
  assert.deepEqual([...(o.trace.executed?.sharedClaimIds ?? [])].sort(), expectedIds);
  assert.equal(o.outcome.publication.status, "committed");
  assertPublication(o.outcome.publication, o.replay.tape.events, publicSpeech);
  assert.equal(o.text, publicSpeech, "the response delivered to the participant");
  assert.equal(o.trace.publicSpeech, o.text, "the trace matches the delivered utterance");
  if (o.trial.label === o.side.label) assert.equal(o.trial.turns[0].publicText, o.text);
  assert.deepEqual(o.outcome.state.ledger, expectedLedger, "only an explicitly expected ledger change is allowed");
}

type Publication = Observation["outcome"]["publication"];
type PublicEvent = { id: string; seq: number; speaker: string; text: string };
function visible(events: readonly PublicEvent[]) {
  return events.map(({ id, seq, speaker, text }) => ({ id, seq, speaker, text }));
}
function assertPublication(outcome: Publication, prior: readonly PublicEvent[], speech: string | null) {
  const published = outcome.publicEvents.slice(prior.length);
  assert.deepEqual(visible(outcome.publicEvents.slice(0, prior.length)), visible(prior));
  assert.deepEqual(visible(outcome.durable.events), visible(outcome.publicEvents));
  assert.deepEqual(published.map(({ speaker, text }) => ({ speaker, text })),
    speech === null ? [] : [{ speaker: "ai", text: speech }]);
}

function checkS4Rejects(records: Records) {
  const checks = interventionChecks(records);
  assert.ok(checks.some(c => c.id.endsWith(".replay") && c.status === "mismatch"), JSON.stringify(checks));
}

function unresolved(targets = [left], target = "figure_0"): Turn {
  const human = "切れ込みの形はどんな形ですか？";
  return { human, plan: { ...neutral(looseEnd, target), act: "ask",
    extraction: segment(human, targets, detail, null, null, "contour") } };
}

function openDetail(state: Observation["outcome"]["state"], targets: string[]) {
  const issue = deriveLocalIssues(state.graph).find(value => value.aspect === "contour" &&
    targets.every(id => value.targets.includes(id)));
  assert.ok(issue && ["unconfirmed", "deferred", "contested", "denied"].includes(issue.state),
    "the verified detail remains unresolved");
  return issue;
}

function assertGenerationScope(o: Observation, targets: string[]) {
  const request = o.side.requests.find((value: { phase: string }) => value.phase === "generation");
  const messages = request?.payload?.messages as { role: string; content: unknown }[] | undefined;
  assert.ok(messages);
  const instructions = messages.filter(m => m.role === "system").map(m => String(m.content)).join("\n");
  assert.equal(o.judgment.executed.target.kind, "multiple");
  assert.deepEqual([...o.judgment.executed.target.figureIds].sort(), [...targets].sort());
  assert.ok(instructions.includes('"target":' + JSON.stringify({ kind: "multiple", figureIds: targets })));
  assert.ok(instructions.includes(detail) && instructions.includes(openDetail(o.replay.tape.state, targets).issueId),
    "generation must receive the verified unresolved detail");
}

// The approved ordering can be changed without replacing the fixture.
function namingRequestMode(): "same-turn" | "separate-turn" {
  return "same-turn";
}

for (const label of conditions) {
  test(`P5 ${label}: partner-first support enables joint use, keeps details open, and does not name`, async () => {
    const records = await run(label, [humanFirst(), finish()]);
    const o = observed(records, label);
    effects(o, pair(o, sail, [left], [1, 2]), useSail);
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
      assert.equal(o.claims.find(c => c.sourceTurn === 3 && c.quote === text)?.act, act,
        "the other speaker's utterance was actually classified");
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
    assert.ok(candidates(o.menus[0]).every(c => c.figureIds.includes(left) && c.construal !== flute));
    const rightOffered = pair(rightObserved, flute, [right], [5, 6]);
    assert.ok(candidates(rightObserved.menus[0]).every(c => c.figureIds.includes(right) && c.construal !== sail));
    effects(o, offered, useSail);
    effects(rightObserved, rightOffered, "笛に見える形を目印にしましょう。");
  });

  test(`P5 ${label}: a chosen one-character reading survives paraphrase, acknowledgement and refusal`, async () => {
    for (const [reading, speech] of [[sail, "帆に見える形を目印にしましょう。"], [sail, useSail],
      [sail, acknowledgement], [sail, rejectSail], ["帆船", "帆船に見えるというお話ですね。"],
      ["帆船", "帆船という見立ては今回は共通の目印には使いません。"]]) {
      const records = await run(label, [...aiFirst({ reading }), finish(speech, reading)]);
      const o = observed(records, label);
      effects(o, pair(o, reading, [left], [2, 3]), speech);
    }
  });

  test(`P5 ${label}: an ambiguous pair retains the open detail and permits coarse use`, async () => {
    const targets = [left, right], target = "figures_0_1";
    const prior = [...aiFirst({ targets, target }), unresolved(targets, target)];
    for (const speech of ["その見立てを目印にしましょう。細部まで同じではありません。",
      "同じだと言えるのは大まかな見立てまでです。それを目印にしましょう。"]) {
      const o = observed(await run(label, [...prior, finish(speech, sail, target)]), label);
      assertGenerationScope(o, targets);
      const before = openDetail(o.replay.tape.state, targets);
      const after = openDetail(o.outcome.state, targets);
      assert.equal(after.issueId, before.issueId);
      assert.equal(after.state, before.state);
      assert.equal(o.trace.generationGuard.regenerated, false);
      effects(o, pair(o, sail, targets, [2, 3]), speech);
    }
  });

  test(`P5 ${label}: the existing naming check blocks a draft that adopts a name`, async () => {
    const unsafe = "帆を目印にしましょう。この図形の名前は「帆」に決まりました。";
    const safe = "その見立てを目印にしましょう。名前はまだ決めていません。";
    const turn = finish(safe);
    const choose = turn.plan.choose!;
    turn.plan.drafts = [unsafe, safe];
    turn.plan.choose = (key, criteria, context) => key === "draft_naming"
      ? context.generationCalls === 1 ? "adopt_other" : "none"
      : choose(key, criteria, context);
    const o = observed(await run(label, [...aiFirst(), turn]), label);
    assert.ok(o.trace.generationGuard.violations.includes("draft_act_mismatch"));
    assert.equal(o.trace.generationGuard.regenerated, true);
    effects(o, pair(o, sail, [left], [2, 3]), safe);
  });

  test(`P5 ${label}: a naming request gets a separate clarifying response`, async () => {
    const prior = aiFirst();
    const human = "この図形を「羽」と呼びませんか？";
    const clarification = "羽と呼びたいのは、切れ込みのある形ですか？";
    const sameTurn = namingRequestMode() === "same-turn";
    const speech = sameTurn ? "その見立ては目印にできます。" + clarification : clarification;
    const turn = finish(speech, sail, "figure_0", sameTurn);
    turn.human = human;
    Object.assign(turn.plan, { action: "confirm", act: "name_propose",
      extraction: segment(human, [], "羽という名前の提案", null, null, "name", "羽") });
    const records = await run(label, [...prior, turn]);
    const o = observed(records, label);
    assert.equal(o.trace.namingRequest, true);
    assert.equal(o.trace.executed.action, "confirm");
    const actionMenu = o.side.requests.find((r: { payload?: { questions?: { action?: Choice } } }) =>
      r.payload?.questions?.action)?.payload.questions.action.criteria;
    assert.ok(actionMenu && !Object.hasOwn(actionMenu, "accept"));
    if (sameTurn) {
      effects(o, pair(o, sail, [left], [2, 3]), speech);
    } else {
      effects(o, null, speech);
      assert.deepEqual(o.menus, []);
      const later = observed(await run(label, [...prior, turn, finish()]), label);
      effects(later, pair(later, sail, [left], [2, 3]), useSail);
    }
  });

  test(`P5 ${label}: later repair can reopen the unresolved feature on the same reference`, async () => {
    const human = "さっきの見立ての形ですが、切れ込みはありますか？";
    const speech = "切れ込みの形をもう一度比べましょう。";
    const follow = { human, plan: { ...neutral(speech), action: "confirm", act: "ask",
      extraction: segment(human, [left], "切れ込みの形", null, null, "contour") } };
    const records = await run(label, [...aiFirst(), unresolved(), finish(), follow]);
    const o = observed(records, label);
    const earlier = o.replay.tape.state.judgments.at(-1).jevTurn;
    assert.ok(earlier.executed.sharedClaimIds?.length, "the previous turn actually chose P5");
    const beforeAdoption = records.outcomes[label].at(-3)!.state;
    assert.equal(openDetail(o.replay.tape.state, [left]).issueId, openDetail(beforeAdoption, [left]).issueId);
    assert.equal(o.trace.executed.action, "confirm");
    assert.equal(o.trace.executed.target.kind, "single");
    assert.equal(o.trace.executed.target.figureId, left);
    assert.equal(o.text, speech);
    assert.deepEqual(o.trial.lastCommittedState.ledger, o.replay.tape.state.ledger);
    s4(records, o);
  });

  test(`P5 ${label}: v12 on the same public evidence has no P5 choice`, async () => {
    const control = await run(label, [humanFirst(), finish()], "v12");
    const o = observed(control, label);
    assert.equal(o.replay.tape.generationRetryVersion, v12);
    const source = o.claims.find(c => c.sourceTurn === 1 && c.act === "construe");
    const support = o.claims.find(c => c.sourceTurn === 2 && c.act === "agree");
    assert.ok(source && support && support.respondsTo === source.id);
    assert.deepEqual(o.menus, []);
    effects(o, null, useSail);
    const lineage = promptSources.files["judgment/instructions.mjs"];
    const expected = v12HttpDigests.get(lineage);
    assert.ok(expected, `v12 sends have no frozen control for instruction source ${lineage}`);
    assert.deepEqual(control.records.run.promptSources, promptSources);
    assert.equal(o.trial.identity.prompts, hash(promptSources));
    assert.equal(hash(control.outcomes[label].flatMap(outcome => outcome.httpBodies)), expected);
    s4(control, o);
  });

  test(`P5 ${label}: denying only the right support preserves the left common reading`, async () => {
    const first = humanFirst([left, right]);
    first.plan.aiExtraction = segment(first.plan.speech!, [left], sail, 1);
    const rightSupport = "右の形も大まかに帆に見えます。";
    const separateSupport: Turn = {
      human: "右の形についても、どう見えますか？",
      plan: { ...neutral(rightSupport, "figure_1"), aiExtraction: segment(rightSupport, [right], sail, 1),
        aiActs: ["agree"], choose: responseTo("1:local1") },
    };
    const human = "右の形については、やはり帆に見えるという見立てには同意しません。";
    const denial: Turn = {
      human, plan: { ...neutral(acknowledgement, "figure_1"), act: "deny",
        extraction: segment(human, [right], sail, 4), choose: responseTo("5:pub1") },
    };
    const prior = [first, separateSupport, denial];
    const leftRun = await run(label, [...prior, finish()]);
    const leftResult = observed(leftRun, label);
    const rightResult = observed(await run(label, [...prior, finish(acknowledgement, sail, "figure_1")]), label);
    const removed = leftResult.claims.find(c => c.sourceTurn === 4 && c.act === "agree");
    const correction = leftResult.claims.find(c => c.sourceTurn === 5 && c.act === "deny");
    assert.ok(removed && correction, JSON.stringify({
      claims: leftResult.claims.map(({ id, sourceTurn, targets, act, respondsTo }) => ({ id, sourceTurn, targets, act, respondsTo })),
      verification: leftRun.outcomes[label].at(-2)?.trace.local?.verification?.rejected,
    }));
    assert.deepEqual(removed.targets, [right]);
    assert.deepEqual(correction.targets, [right]);
    assert.equal(correction.respondsTo, removed.id);
    assert.ok(!rightResult.menus.flatMap(candidates).some(c => c.construal === sail));
    effects(rightResult, null, acknowledgement);
    const rightBefore = observed(await run(label, [first, separateSupport, finish(useSail, sail, "figure_1")]), label);
    assert.ok(rightBefore.menus.flatMap(candidates).some(c => c.construal === sail &&
      c.figureIds.includes(right) && c.claimIds.includes(removed.id)), "the right support was usable before the denial");
    effects(leftResult, pair(leftResult, sail, [left], [1, 2]), useSail);
  });
}

test("P5: S4 accepts each side's own post-veto choice and public result in both saved directions", async () => {
  for (const label of conditions) for (const [speech, chosen] of [
    [acknowledgement, false], [useSail, true], [acknowledgement, true],
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
    assert.deepEqual(bypass.menus, []);
    effects(repair, chosen ? selected : null, speech);
    const previousLedger = bypass.replay.tape.state.ledger;
    assert.deepEqual(previousLedger[left], { status: "unassigned", name: null });
    effects(bypass, null, turn.plan.speechByLabel!["bypass-enabled"]!,
      { ...previousLedger, [left]: { status: "deferred", name: null } });
    const details = repair.side.requests.filter((r: { role: string }) => r.role === "alternative_detail");
    assert.ok(details.some((r: { payload?: { questions?: Record<string, Choice> } }) => r.payload?.questions?.[question]));
    s4(records, label === "repair-first" ? repair : bypass);
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
  effects(o, pair(o, last, [left], [start, start + 1]), "その見立てを目印にしましょう。");
  s4(records, o);
});

test("P5: four supported readings within the request budget remain available", async () => {
  const readings = [sail, flute, "提灯", "木の葉"];
  const turns = [humanFirst(), ...readings.slice(1).flatMap((reading, index) =>
    aiFirst({ reading, start: 3 + 2 * index, issue: "1:local1" }))];
  const o = observed(await run("repair-first", [...turns, finish()]), "repair-first");
  effects(o, pair(o, sail, [left], [1, 2]), useSail);
  assert.deepEqual(candidates(o.menus[0]).map(candidate => candidate.construal).sort(), [...readings].sort());
});

function replaceSelectedEvidence(value: unknown, source: string, replacement: string): void {
  if (!value || typeof value !== "object") return;
  for (const [key, field] of Object.entries(value)) {
    if (key === "sharedClaimIds" && Array.isArray(field)) {
      const index = field.indexOf(source);
      if (index !== -1) field[index] = replacement;
    } else {
      replaceSelectedEvidence(field, source, replacement);
    }
  }
}

// Build the omitted-choice record from the coherent legacy run on the same
// dialogue. Bind all copies to the newer version, including evidence hashes.
function recordWithoutP5(legacy: Records): Records {
  const records = structuredClone(legacy);
  const retag = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    for (const [key, field] of Object.entries(row)) {
      if (key === "generationRetryVersion" && field === v12) row[key] = p5Version;
      else retag(field);
    }
  };
  retag(records);
  const replay = records.trials[0].replay[0];
  for (const side of replay.result.sides) {
    side.materialSha256 = hash(side.material);
  }
  const pair = records.evidence.pairedReplay[0];
  [pair.left, pair.right] = structuredClone(replay.result.sides);
  return records;
}

for (const label of conditions) {
  test(`P5 ${label}: S4 accepts same-turn and next-turn support and rejects forged or omitted evidence`, async () => {
    const unrelated = unresolved([right], "figure_1");
    const [proposal, support] = aiFirst({ start: 3 });
    const adoption = finish();
    const choose = adoption.plan.choose!;
    const sameTurn: Turn = { human: support.human, plan: { ...support.plan, speech: useSail,
      choose: (key, criteria, context) => support.plan.choose?.(key, criteria, context) ?? choose(key, criteria, context) } };
    for (const turns of [[unrelated, proposal, sameTurn], [unrelated, proposal, support, adoption]]) {
      const current = await run(label, turns);
      const o = observed(current, label);
      const selected = pair(o, sail, [left], [4, 5]);
      effects(o, selected, useSail);
      s4(current, o);

      const forged = structuredClone(current.records);
      const supportId = o.claims.find(c => c.sourceTurn === 5 && c.act === "agree")!.id;
      assert.ok(selected.claimIds.includes(supportId));
      replaceSelectedEvidence(forged, supportId, "5:absent");
      checkS4Rejects(forged);

      const wrong = structuredClone(current.records);
      const existingButWrong = o.claims.find(c => c.sourceTurn === 1 && c.aspect === "contour" && c.targets.includes(right))!.id;
      replaceSelectedEvidence(wrong, supportId, existingButWrong);
      checkS4Rejects(wrong);

      const legacy = await run(label, turns, "v12");
      const legacyObservation = observed(legacy, label);
      assert.deepEqual(legacyObservation.menus, []);
      s4(legacy, legacyObservation);
      checkS4Rejects(recordWithoutP5(legacy.records));
    }
  });
}

type ScriptedFailure = Error & { drafts?: string[]; traces?: Observation["trace"][]; publication?: Publication };
type ApprovedDraftCheck = { question: string; accept: string; reject: string };

async function nonNamingDraftOutcome(label: Label, contract?: ApprovedDraftCheck) {
  const targets = [left, right], target = "figures_0_1";
  const prior = [...aiFirst({ targets, target }), unresolved(targets, target)];
  const safe = "その見立てを目印にしましょう。細部まで同じとは言えません。";
  const turn = finish(safe, sail, target);
  const choose = turn.plan.choose!;
  if (contract) {
    turn.plan.choose = (key, criteria, context) => key === contract.question
      ? contract.accept : choose(key, criteria, context);
  }
  const reference = observed(await run(label, [...prior, turn]), label);
  const selected = pair(reference, sail, targets, [2, 3]);
  effects(reference, selected, safe);
  assertGenerationScope(reference, targets);

  // The fixture supplies the interpretations. The publication oracle looks at
  // the actual result, regardless of which authorized validation stopped it.
  const single = [
    "これで両方が見ている図形は一つに特定できました。",
    "もう候補は残っていません。そちらと私が指しているのは一つの同じ図形です。",
  ];
  const unverifiedDetail = [
    "切れ目の形は二人の図形で完全に一致しています。",
    "お互いの切れ込みを比べ終えました。あの部分に差はありません。",
  ];
  for (const variants of [single, unverifiedDetail]) for (const drafts of [
    [variants[0], safe], [variants[1], safe], variants,
  ]) {
    const before = reference.replay.tape.state;
    const inputState = structuredClone(before);
    const plan = { ...turn.plan, drafts };
    let semanticCheckReached = false;
    if (contract) {
      plan.choose = (key, criteria, context) => {
        if (key !== contract.question) return choose(key, criteria, context);
        semanticCheckReached = true;
        return drafts[context.generationCalls - 1] === safe ? contract.accept : contract.reject;
      };
    }
    const outcome = await runTurn(reference.trial.profile, label, inputState, reference.replay.tape.events, plan,
      technicalTrial, supportedP5Version).then(
        result => ({ ok: true as const, result }), (error: ScriptedFailure) => ({ ok: false as const, error }));
    if (contract) assert.equal(semanticCheckReached, true);
    if (outcome.ok) {
      const result = outcome.result;
      assert.equal(result.publication.status, "committed");
      assertPublication(result.publication, reference.replay.tape.events, safe);
      const generated = result.luna.filter(call => call.phase === "generation").map(call => call.response.text);
      assert.deepEqual(generated, drafts);
      assert.ok(drafts.includes(safe));
      assert.equal(result.speech, safe, "the participant must not receive either overclaim");
      assert.equal(result.trace.publicSpeech, result.speech);
      assert.equal(result.state.judgments.length, before.judgments.length + 1);
      assert.equal(result.state.judgments.at(-1).status, "committed");
      assert.deepEqual(result.state.ledger, before.ledger);
      assert.equal(openDetail(result.state, targets).state, openDetail(before, targets).state);
      assert.deepEqual([...(result.trace.executed?.sharedClaimIds ?? [])].sort(), [...selected.claimIds].sort());
    } else {
      const error = outcome.error;
      const trace = error.traces?.at(-1);
      assert.ok(trace, "a guarded stop leaves a trace");
      assert.equal(trace.errorCode, "unsafe_generation");
      assert.equal(trace.publicSpeech, null);
      assert.notEqual(trace.status, "committed");
      assert.deepEqual([...(trace.executed?.sharedClaimIds ?? [])].sort(), [...selected.claimIds].sort());
      assert.ok(error.publication);
      assert.equal(error.publication.status, "error");
      assertPublication(error.publication, reference.replay.tape.events, null);
      assert.ok(error.drafts?.length);
      assert.deepEqual(error.drafts, drafts.slice(0, error.drafts.length));
      assert.deepEqual(error.publication.durable.privateState, before, "a guarded stop keeps the prior saved state");
    }
  }
}

// The publication oracle runs independently of the chosen mechanism. Pass the
// contract here only after approval of the additional semantic-check request.
function registerNonNamingDraftChecks(contract?: ApprovedDraftCheck) {
  for (const label of conditions) {
    test(`P5 ${label}: non-naming overclaims never reach a committed public turn`, () => nonNamingDraftOutcome(label, contract));
  }
  test("P5: the separately approved semantic-check RPC handles the same drafts",
    { skip: !contract && "Pending research approval and a closed response contract" },
    async () => {
      assert.ok(contract);
      for (const label of conditions) await nonNamingDraftOutcome(label, contract);
    });
}

registerNonNamingDraftChecks();

test("P5 v12 control: the publication queue distinguishes commit, regeneration, stop and stale", async () => {
  const label = "repair-first";
  const safe = "その見立ては確かめておきましょう。名前はまだ決めていません。";
  const firstDraft = "この図形の名前は「帆」に決まりました。";
  const secondUnsafeDraft = "名前は「帆」で合意しましたね。";
  const normal = observed(await run(label, [humanFirst(), finish(safe)], "v12"), label);
  const { state, events } = normal.replay.tape;
  const input = { ...neutral(safe), drafts: [firstDraft, safe] };
  const exercise = (plan: Plan) => runTurn(normal.trial.profile, label, state, events, plan, technicalTrial, v12);
  const drafted = (drafts: readonly string[]): Plan => ({ ...input, drafts, choose: (key, _criteria, context) =>
    key === "draft_naming" ? drafts[context.generationCalls - 1] === safe ? "none" : "adopt_other" : undefined });
  effects(normal, null, safe);
  const regenerated = await exercise(drafted([firstDraft, safe]));
  assert.equal(regenerated.trace.generationGuard.regenerated, true);
  assert.deepEqual(regenerated.luna.filter(call => call.phase === "generation").map(call => call.response.text), [firstDraft, safe]);
  assert.equal(regenerated.publication.status, "committed");
  assertPublication(regenerated.publication, events, safe);
  assert.equal(regenerated.state.judgments.length, state.judgments.length + 1);

  const drafts = [firstDraft, secondUnsafeDraft];
  await assert.rejects(exercise(drafted(drafts)), (error: ScriptedFailure) => {
    assert.equal(error.traces?.at(-1)?.errorCode, "unsafe_generation");
    assert.deepEqual(error.drafts, drafts);
    assert.ok(error.publication);
    assert.equal(error.publication.status, "error");
    assertPublication(error.publication, events, null);
    assert.deepEqual(error.publication.durable.privateState, state);
    return true;
  });

  const correction = "すみません、今の質問を訂正します。";
  const stale = await exercise({ ...neutral(safe), correctionBeforeCommit: correction });
  assert.equal(stale.candidateText, normal.text);
  assert.equal(stale.speech, null);
  assert.equal(stale.trace.status, "superseded");
  assert.equal(stale.publication.status, "stale");
  const newest = stale.publication.publicEvents.at(-1);
  assert.ok(newest);
  assert.equal(newest.speaker, "human");
  assert.equal(newest.text, correction);
  assertPublication(stale.publication, [...events, newest], null);
  assert.deepEqual(stale.publication.durable.privateState, state);
});

async function failureWitness(version: "v12" | "p5") {
  const label = "repair-first";
  const human = "この図形を「羽」と呼びませんか？";
  const plan: Plan = { ...neutral("羽と呼びたい図形を確かめられますか？"), action: "confirm", act: "name_propose",
    extraction: segment(human, [], "羽という名前の提案", null, null, "name", "羽"),
    choose: key => key === question ? "none" : undefined };
  const scenario = await run(label, [humanFirst(), { human, plan }], version);
  const o = observed(scenario, label);
  const parsed = o.trace.decisions.at(-1)?.evidence?.stages;
  assert.ok(parsed);
  const detail = parsed.at(-1);
  assert.equal(detail?.stage, "detail");
  assert.ok(detail?.model && detail.responseId && detail.costUsd !== null && detail.inputBudget);
  const inputBudget = detail.inputBudget;
  assert.deepEqual(Object.keys(detail.choices).sort(), version === "p5" ? ["feature", question] : ["feature"]);

  let failure: ScriptedFailure | undefined;
  await assert.rejects(runTurn(o.trial.profile, label, o.replay.tape.state, o.replay.tape.events,
    { ...plan, failQuestion: "feature" }, technicalTrial, o.replay.tape.generationRetryVersion),
  (error: ScriptedFailure) => { failure = error; return true; });
  const trace = failure?.traces?.at(-1);
  const evidence = trace?.decisionFailure?.evidence;
  assert.ok(trace && evidence);
  assert.equal(trace.status, "error");
  const failedDetail = evidence.stages.at(-1);
  assert.ok(failedDetail);
  assert.equal(failedDetail.stage, "detail");
  assert.equal(failedDetail.status, "error");
  assert.deepEqual(failedDetail.choices, {});
  assert.deepEqual(failedDetail.scores, {});
  assert.deepEqual(evidence.stages.slice(0, -1).map(s => s.choices), parsed.slice(0, -1).map(s => s.choices));
  assert.ok(failure?.publication);
  assert.equal(failure.publication.status, "error");
  assertPublication(failure.publication, o.replay.tape.events, null);
  assert.deepEqual(failure.publication.durable.privateState, o.replay.tape.state);
  const records = structuredClone(scenario.records);
  const trial = records.trials[0];
  trial.attempts = [trace];
  trial.turns = [{ ...trial.turns[0], trace: structuredClone(trial.attempts), publicText: null,
    state: failure.publication.durable.privateState }];
  trial.lastCommittedState = failure.publication.durable.privateState;
  trial.calls = [];
  trial.http = [];
  trial.replay = [];
  records.evidence.pairedReplay = [];
  failureChecks(records, "pass");

  // Keep the actual HTTP failure as a positive control. In a separate fixture,
  // model a failure after the detail was parsed, using the successful twin's
  // closed choices, scores, and provenance in both stored copies.
  const parsedFailure = structuredClone(records);
  for (const attempt of failureCopies(parsedFailure)) {
    const parsedEvidence = attempt.decisionFailure!.evidence!;
    parsedEvidence.stages.splice(-1, 1, { ...detail, inputBudget, status: "ok", error: null, rejectionCode: null });
    parsedEvidence.model = detail.model;
    parsedEvidence.responseId = detail.responseId;
    parsedEvidence.costUsd = parsedEvidence.stages.reduce((total, s) => total + (s.costUsd ?? 0), 0);
    parsedEvidence.latencyMs = parsedEvidence.stages.reduce((total, s) => total + s.latencyMs, 0);
  }
  return parsedFailure;
}

function failureChecks(records: Records, expectedShape: "pass" | "mismatch") {
  const checks = interventionChecks(records);
  const shape = checks.find(check => check.id.endsWith(".shape"));
  assert.equal(shape?.status, expectedShape, JSON.stringify(checks));
  if (expectedShape === "pass") {
    assert.equal(checks.find(check => check.id.endsWith(".binding"))?.status, "pass", JSON.stringify(checks));
  } else {
    assert.equal(shape?.reason, "intervention_trace_invalid", JSON.stringify(checks));
  }
}

function failureCopies(records: Records) {
  return [records.trials[0].attempts[0], records.trials[0].turns[0].trace[0]] as Observation["trace"][];
}

test("P5: S4 rejects only the added P5 answer in an otherwise valid v12 failure record", async () => {
  const control = await failureWitness("v12");
  failureChecks(control, "pass");
  const mixed = structuredClone(control);
  for (const attempt of failureCopies(mixed)) {
    const detail = attempt.decisionFailure!.evidence!.stages.at(-1)!;
    detail.choices[question] = "none";
    detail.scores[question] = { none: 1, use_0: 0 };
  }
  failureChecks(mixed, "mismatch");
});

test("P5: S4 accepts the v13 failure evidence and rejects it under v12", async () => {
  assert.ok(supportedP5Version, "P5 v13 runtime and S4 support are required for this acceptance case");
  const control = await failureWitness("p5");
  const originals = failureCopies(control);
  for (const attempt of originals) {
    assert.equal(attempt.generationRetryVersion, p5Version, "the producer identifies the failed decision's version");
  }
  failureChecks(control, "pass");

  // Keep the actual v12 outer trace, including its version and public state.
  // Only the validated v13 failure evidence crosses into that v12 trace.
  const mixed = await failureWitness("v12");
  failureChecks(mixed, "pass");
  for (const [index, attempt] of failureCopies(mixed).entries()) {
    const original = originals[index];
    assert.equal(attempt.generationRetryVersion, undefined);
    assert.deepEqual([attempt.turnIndex, attempt.lastEventId, attempt.attemptNumber, attempt.errorCode],
      [original.turnIndex, original.lastEventId, original.attemptNumber, original.errorCode]);
    const legacy = attempt.decisionFailure!.evidence!;
    const p5 = original.decisionFailure!.evidence!;
    assert.equal(legacy.callIndex, p5.callIndex);
    assert.deepEqual(legacy.stages.slice(0, -1).map(s => s.choices), p5.stages.slice(0, -1).map(s => s.choices));
    attempt.decisionFailure = structuredClone(original.decisionFailure);
  }
  failureChecks(mixed, "mismatch");
});
