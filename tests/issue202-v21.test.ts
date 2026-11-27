import assert from "node:assert/strict";
import test from "node:test";
import type { LocalClaimView, LocalSegmentProposal } from "../dialogue-model/runtime/local-grounding/contract.ts";
import { verifyLocalUpdate } from "../dialogue-model/runtime/local-grounding/verify.ts";
import { ISSUE_HANDLING_GENERATION } from "../dialogue-model/runtime/v2/deferred-ai-extraction.ts";
import { researchTrialProfileV3 } from "../dialogue-model/runtime/v2/research-profile.ts";
import { initialState, normal, OWN, runTurn, type Label, type Plan } from "./support/s4-v3-records.ts";

const { lunaRequest, timeouts } = normal.run.manifest;
const profile = researchTrialProfileV3(lunaRequest, timeouts, "two_stage_v3", "holistic_v5", "bypass_acceptance_v3", "jev_repair_quality_v1");
const technicalTrial = { version: "adaptive_repair_v3" } as const;
const [a, b] = OWN.ownAnchors.map(({ id }: { id: string }) => id);
const name = "舟の輪";
const description = "丸い切り込みが見えます。";
const partQuestion = "そちらにも丸い切り込みがありますか？";
const referentQuestion = "話しているのはこの図形ですか？";
const nonAnswer = "質問の意味は分かりました。";
const actualAnswer = "はい、こちらの図形にも丸い切り込みがあります。";
const proposedName = `「${name}」と呼びませんか？`;
const agreeText = `はい、「${name}」と呼びましょう。`;
const draft = (text: string) => JSON.stringify({ text, observationFeatures: [] });
const segment = (id: string, quote: string, aspect: LocalSegmentProposal["aspect"],
  targets: string[] = [], respondsToTurn: number | null = null, proposed: string | null = null): LocalSegmentProposal =>
  ({ segmentId: id, quote, proposition: quote, aspect, targets, respondsToTurn, name: proposed, linkedIssueId: null });
const check = (target: string, text: string, segments: LocalSegmentProposal[] = [], aiActs: string[] = [], action = "confirm"): Plan =>
  ({ action, target, speech: draft(text), aiActs, aiExtraction: JSON.stringify({ segments, visualFeatures: { sources: [] } }) });
const accept = { action: "accept", target: "none", speech: "お話は分かりました。" };
const link = (key: string, criteria: Readonly<Record<string, string>>, id: string) =>
  key.endsWith("_antecedent") ? Object.keys(criteria).find(label => criteria[label].includes(JSON.stringify(id))) : undefined;

type ClaimRow = [string, number, string, string, string[], string | null, string | null, string, string];
type DecisionState = { claims: ClaimRow[]; namingEvidence: { names: { name: string; figureId: string | null; sourceTurn: number }[] };
  repairHistory: unknown[][]; publicationRecoveryContext?: unknown };
type Event = { id: string; seq: number; speaker: "human" | "ai"; text: string };

function dialogue(strategy: Label) {
  let state = initialState({ profile, generationRetryVersion: ISSUE_HANDLING_GENERATION, agreeNameScopeVersion: "jev_naming_v2" });
  let events: Event[] = [];
  return async (text: string, plan: Plan) => {
    const turn = events.length + 1;
    const inputs: DecisionState[] = [];
    const result = await runTurn(profile, strategy, state, [...events, { id: `event-${turn}`, seq: turn, speaker: "human", text }], {
      ...plan, choose: (key, criteria, context) => {
        if (key === "action") inputs.push(JSON.parse(context.state));
        return plan.choose?.(key, criteria, context) ?? ({
          human_move_on_source: "other", commitment_state: "insufficient",
          visual_purpose: "unknown", publication_continuation: "acknowledge_unresolved",
        } as Record<string, string>)[key];
      },
    }, technicalTrial, ISSUE_HANDLING_GENERATION);
    assert.equal(result.publication.status, "committed");
    state = result.state;
    events = result.publication.publicEvents.map(({ id, seq, speaker, text }: Event) => ({ id, seq, speaker, text }));
    assert.ok(inputs[0]);
    return { ...result, turn, inputs, material: inputs[0] };
  };
}

async function partCheck(send: ReturnType<typeof dialogue>, extractedTarget: boolean) {
  const prefix = extractedTarget ? "" : description;
  await send("この図形の特徴を確かめたいです。", check("figure_0", prefix + partQuestion,
    [...(extractedTarget ? [] : [segment("description", description, "part", [a])]),
      segment("question", partQuestion, "part", extractedTarget ? [a] : [])],
    extractedTarget ? ["ask"] : ["assert", "ask"]));
}

function classify(text: string, act: string, aspect: LocalSegmentProposal["aspect"], prior: string | null, sourceTurn: number,
  answers: Plan["answers"], targets: string[] = [], responseTurn = sourceTurn): Plan {
  return { ...accept, act, answers, extraction: JSON.stringify([segment("reply", text, aspect, targets, responseTurn)]),
    choose: (key, options) => prior ? link(key, options, prior) : undefined };
}

function localClaim(result: Awaited<ReturnType<ReturnType<typeof dialogue>>>) {
  return result.trace.local?.claims.find(claim => claim.sourceTurn === result.turn && claim.speaker === "human");
}

const unresolvedText = "どの図形を指しているか、まだ分かりません。";
function namingPlan(ground: (material: DecisionState) => boolean, expected: boolean): Plan {
  let grounded = false;
  return { ...accept, speech: agreeText, name, act: "name_propose",
    drafts: [expected ? agreeText : unresolvedText],
    extraction: JSON.stringify([segment("proposal", proposedName, "name", [], null, name)]),
    choose: (key, _options, context) => {
      const state: DecisionState = JSON.parse(context.state);
      if (key === "action") return state.publicationRecoveryContext ? "accept" : "agree";
      if (key === "target") return state.publicationRecoveryContext ? "none" : "figure_0";
      if (key === "naming_grounding") {
        grounded = ground(state);
        return grounded ? "grounded_name_0" : "unresolved";
      }
      if (key === "naming_evidence") return `turn_${state.namingEvidence.names.at(-1)?.sourceTurn}`;
      if (key === "draft_naming") return grounded ? "adopt_chosen" : "none";
    } };
}

for (const strategy of ["repair-first", "bypass-enabled"] as const) {
  test(`#202-1 ${strategy}: a delayed non-answer cannot inherit a supplied target`, async () => {
    const send = dialogue(strategy);
    await partCheck(send, false);
    const ack = await send("話は分かりました。", accept);
    const question = (ack.state.graph.records as LocalClaimView[]).find(claim => claim.act === "ask" && claim.quote === partQuestion);
    assert.ok(question);
    assert.deepEqual([question.targets, question.source], [[a], "ai_bound_target"]);
    const delayed = await send(nonAnswer, classify(nonAnswer, "agree", "part", question.id, 2, "not_an_answer"));
    const reply = localClaim(delayed);
    assert.deepEqual([reply?.act, reply?.targets, reply?.respondsTo], ["acknowledge", [], null]);
    assert.equal(delayed.material.claims.some(row => row[1] === delayed.turn && row[2] === "agree"), false);
    assert.equal(delayed.state.ledger[a].status, "unassigned");
    const named = await send(proposedName, namingPlan(material => material.claims.some(row =>
      row[1] === delayed.turn && row[2] === "agree" && row[4].includes("f0") && row[6] === question.id), false));
    assert.equal(named.state.ledger[a].status, "unassigned");
  });

  test(`#202-1 ${strategy}: the new scope keeps an explicit delayed answer local`, async () => {
    const send = dialogue(strategy);
    await partCheck(send, false);
    const ack = await send("話は分かりました。", accept);
    const question = (ack.state.graph.records as LocalClaimView[]).find(claim => claim.act === "ask" && claim.quote === partQuestion);
    assert.ok(question);
    const delayed = await send(actualAnswer, classify(actualAnswer, "agree", "part", question.id, 2, "unknown", [a]));
    assert.equal(localClaim(delayed), undefined);
    assert.ok(delayed.trace.local?.verification.rejected.some(r => r.reason === "inconsistent_claim_response"));
    const publicTurns = delayed.publication.publicEvents.filter((event: Event) => event.seq <= delayed.turn)
      .map(({ seq, speaker, text }: Event) => ({ turn: seq, speaker, text }));
    const verify = (targets: string[], respondsToTurn: number, answersChecked: "no" | "unknown",
      events = publicTurns, retainDelayedPartAnswers = true) => verifyLocalUpdate({ graph: ack.state.graph, turn: delayed.turn,
      publicTurns: events, answerFieldRules: true, directReferenceReplies: true, unbindPartNonAnswers: true, retainDelayedPartAnswers,
      segments: [segment("reply", actualAnswer, "part", targets, respondsToTurn)],
      verdicts: [{ segmentId: "reply", act: "agree", respondsToClaimId: question.id, rawScore: null, answersChecked }],
    });
    const [reply] = verify([a], 2, "unknown").operations;
    assert.deepEqual([reply?.act, reply?.targets, reply?.respondsTo], ["agree", [a], question.id]);
    assert.equal(reply.source, "partner_statement");
    assert.deepEqual(verify([a], 2, "unknown", publicTurns, false).operations, []);
    assert.deepEqual(verify([a], 4, "unknown").operations, []);
    assert.deepEqual(verify([], 2, "unknown").operations, []);
    assert.deepEqual(verify([OWN.ownAnchors[1].id], 2, "unknown").operations, []);
    assert.deepEqual(verify([a], 2, "no").operations, []);
    assert.deepEqual(verify([a], 2, "unknown", publicTurns.filter((event: { turn: number }) => event.turn !== 2)).operations, []);
    assert.equal(delayed.state.ledger[a].status, "unassigned");
  });

  test(`#202-2 ${strategy}: an independent assertion does not inherit a supplied target`, async () => {
    const send = dialogue(strategy);
    await partCheck(send, false);
    const independent = "別の特徴として、小さい三角の部分も見えます。";
    const assertion = await send(independent, classify(independent, "assert", "part", "3:pub2", 2, "not_an_answer"));
    const reply = localClaim(assertion);
    assert.deepEqual([reply?.act, reply?.targets, reply?.respondsTo, reply?.quote], ["assert", [], null, independent]);
    assert.equal(assertion.material.claims.some(row => row[1] === assertion.turn && row[4].length > 0), false);
    assert.equal(assertion.state.ledger[a].status, "unassigned");
    const named = await send(proposedName, namingPlan(material => material.claims.some(row =>
      row[1] === assertion.turn && row[2] === "assert" && row[4].includes("f0") && row[6] === "3:pub2"), false));
    assert.equal(named.state.ledger[a].status, "unassigned");
    assert.equal(named.speech, unresolvedText);
  });

  test(`#202-2 ${strategy}: a direct positive reply can use the target of the actual check`, async () => {
    const send = dialogue(strategy);
    await partCheck(send, false);
    const answer = await send(actualAnswer,
      classify(actualAnswer, "agree", "part", "3:pub2", 2, "answers_checked_point"));
    const proof = localClaim(answer);
    assert.deepEqual([proof?.act, proof?.targets, proof?.respondsTo, proof?.source],
      ["agree", [a], "3:pub2", "partner_labelled_answer"]);
  });

  for (const control of ["non-answer", "acknowledge", "actual-answer"] as const) {
    test(`#202-3 ${strategy}: v21 attaches only the actual answer (${control})`, async () => {
      const send = dialogue(strategy);
      await partCheck(send, true);
      const expected = control === "actual-answer";
      const response = expected ? actualAnswer : nonAnswer;
      const reply = await send(response, classify(response, control === "acknowledge" ? "acknowledge" : "agree", "part",
        control === "acknowledge" ? null : "3:pub1", 2, expected ? "answers_checked_point" : "not_an_answer"));
      const proof = localClaim(reply);
      assert.deepEqual([proof?.act, proof?.targets, proof?.respondsTo], expected ? ["agree", [a], "3:pub1"] : ["acknowledge", [], null]);
      assert.equal(reply.state.ledger[a].status, "unassigned");
      const named = await send(proposedName, namingPlan(material => material.claims.some(row =>
        row[1] === reply.turn && row[2] === "agree" && row[4].includes("f0") && row[6] === "3:pub1"), expected));
      assert.deepEqual(named.material.namingEvidence.names, [{ name, figureId: null, sourceTurn: named.turn }]);
      assert.equal(named.state.ledger[a].status, expected ? "agreed" : "unassigned");
    });
  }

  test(`#202-4 ${strategy}: a new referent question does not inherit an older mismatched antecedent`, async () => {
    for (const matching of [false, true]) {
      const send = dialogue(strategy);
      await send("どの図形か確かめたいです。", check("figure_0", description + referentQuestion,
        [segment("description", description, "part", [a]), segment("question", referentQuestion, "question", [a])], ["assert", "ask"]));
      const yes = "はい、その図形です。";
      const confirmed = await send(yes, classify(yes, "agree", "referent", "3:pub2", 2, "answers_checked_point", [a]));
      assert.deepEqual([localClaim(confirmed)?.act, localClaim(confirmed)?.respondsTo], ["agree", "3:pub2"]);
      const question = "いま話しているのは同じ図形ですか？";
      const asking = await send(question, classify(question, "ask", "referent", "3:pub2", 2, "not_an_answer", [], matching ? 2 : 4));
      const reply = localClaim(asking);
      assert.deepEqual([reply?.aspect, reply?.targets, reply?.respondsTo],
        matching ? ["question", [a], "3:pub2"] : ["referent", [], null]);
      assert.equal(asking.state.ledger[a].status, "unassigned");
    }
  });

  test(`#202-5 ${strategy}: a normalized reference denial remains public evidence after an AI restatement`, async () => {
    const send = dialogue(strategy);
    await send("まず、どの図形か確かめましょう。", check("figure_0", referentQuestion,
      [segment("question", referentQuestion, "question", [a])], ["ask"]));
    const denial = "いえ、話しているのはその図形ではありません。";
    const denied = await send(denial, { ...classify(denial, "deny", "referent", "3:pub1", 2, "not_an_answer", [a]),
      target: "figure_0", speech: description, aiExtraction: JSON.stringify([segment("description", description, "part", [a])]) });
    const proof = localClaim(denied);
    assert.ok(proof);
    assert.deepEqual([proof.act, proof.aspect, proof.targets, proof.respondsTo], ["deny", "question", [a], "3:pub1"]);
    const isDenial = (row: ClaimRow) => row[0] === proof.id && row[2] === "deny" && row[3] === "question" &&
      row[4].length === 1 && row[4][0] === "f0" && row[6] === "3:pub1";
    const named = await send(proposedName, namingPlan(material => !material.claims.some(isDenial), false));
    assert.ok(named.material.claims.some(isDenial));
    assert.deepEqual(named.material.namingEvidence.names, [{ name, figureId: null, sourceTurn: named.turn }]);
    assert.equal(named.trace.generatedPublication?.recovery?.reason, "naming_unresolved");
    assert.equal(named.speech, unresolvedText);
    assert.equal(named.state.ledger[a].status, "unassigned");
  });

  test(`#202-5 ${strategy}: a denial of the other figure does not deny the confirmed figure`, async () => {
    const send = dialogue(strategy);
    await send("別の候補のことか確かめたいです。", check("figure_1", referentQuestion,
      [segment("question", referentQuestion, "question", [b])], ["ask"]));
    const denial = "いいえ、話しているのはその図形ではありません。";
    const denied = await send(denial, {
      ...classify(denial, "deny", "referent", "3:pub1", 2, "not_an_answer", [b]),
      ...check("figure_0", referentQuestion, [segment("question", referentQuestion, "question", [a])], ["ask"], "repair"),
    });
    assert.deepEqual(localClaim(denied)?.targets, [b]);
    const reply = "はい、この図形で合っています。";
    const confirmed = await send(reply, classify(reply, "agree", "question", "5:pub1", 4, "answers_checked_point", [a]));
    const named = await send(proposedName, namingPlan(material =>
      material.claims.some(row => row[1] === confirmed.turn && row[2] === "agree" && row[4].includes("f0")) &&
      !material.claims.some(row => row[2] === "deny" && row[4].includes("f0")), true));
    assert.ok(named.material.claims.some(row => row[1] === denied.turn && row[2] === "deny" && row[4][0] === "f1"));
    assert.deepEqual(named.state.ledger[a], { name, status: "agreed" });
    assert.equal(named.state.ledger[b].status, "unassigned");
  });

  for (const identityAnswered of [false, true]) test(`#202-6 ${strategy}: a repaired feature and identity stay distinct (${identityAnswered})`, async () => {
    const send = dialogue(strategy);
    await send("まず、どの図形か確かめましょう。", check("figure_0", referentQuestion,
      [segment("question", referentQuestion, "question", [a])], ["ask"]));
    const denial = "いえ、話しているのはその図形ではありません。";
    await send(denial, { ...classify(denial, "deny", "referent", "3:pub1", 2, "not_an_answer", [a]),
      ...check("figure_0", partQuestion + referentQuestion, [
        segment("part", partQuestion, "part", [a]), segment("reference", referentQuestion, "question", [a]),
      ], ["ask", "ask"], "repair") });
    const explicit = "はい、いまは同じ図形のことです。";
    const repaired = await send(actualAnswer + (identityAnswered ? explicit : ""), { ...accept,
      extraction: JSON.stringify([segment("feature", actualAnswer, "part", [a], 4),
        ...(identityAnswered ? [segment("identity", explicit, "referent", [a], 4)] : [])]),
      choose: (key, criteria) => key.endsWith("_act") ? "agree" : key.endsWith("_answer") ? "answers_checked_point"
        : link(key, criteria, key.startsWith("segment_0") ? "5:pub1" : "5:pub2") });
    assert.deepEqual(repaired.trace.local?.claims.filter(c => c.speaker === "human" && c.sourceTurn === repaired.turn)
      .map(c => [c.act, c.aspect, c.targets, c.respondsTo]),
      [["agree", "part", [a], "5:pub1"], ...(identityAnswered ? [["agree", "question", [a], "5:pub2"]] : [])]);
    const liveAnswers = (material: DecisionState) => ["5:pub1", "5:pub2"].every(id => material.claims.some(row =>
      row[1] === repaired.turn && row[2] === "agree" && row[4].length === 1 && row[4][0] === "f0" && row[6] === id));
    const named = await send(proposedName, namingPlan(liveAnswers, identityAnswered));
    assert.equal(liveAnswers(named.material), identityAnswered);
    assert.equal(named.speech, identityAnswered ? agreeText : unresolvedText);
    assert.deepEqual(named.state.ledger[a], identityAnswered ? { name, status: "agreed" } : { name: null, status: "unassigned" });
  });

  test(`#202-7 ${strategy}: a three-candidate check survives without a description claim`, async () => {
    const send = dialogue(strategy);
    const focus = await send("まず、切り込みのある形の話です。", { ...accept, target: "figure_0", speech: description,
      aiExtraction: JSON.stringify([segment("focus", description, "part", [a])]) });
    const choice = "似ている三つの図形のうち、どれを指していますか？";
    const checked = await send("似た形がいくつかあるので迷っています。", check("figures_0_1_2", choice,
      [segment("question", choice, "question")], ["ask"]));
    const named = await send(proposedName, namingPlan(material =>
      material.claims.some(row => row[2] === "agree" && row[4].length === 1 && row[4][0] === "f0"), false));
    assert.ok(named.material.claims.some(row => row[1] === focus.turn + 1 && row[2] === "assert" && row[4][0] === "f0"));
    assert.ok(named.material.claims.filter(row => row[1] === checked.turn + 1).every(row => row[2] === "ask"));
    const repair = named.material.repairHistory.find(row => row[0] === checked.turn);
    assert.ok(repair);
    assert.deepEqual(repair[6], ["f0", "f1", "f2"]);
    assert.deepEqual(repair[4], []);
    assert.equal(repair[9], "unchanged");
    assert.equal(named.state.ledger[a].status, "unassigned");
    assert.deepEqual(named.material.namingEvidence.names, [{ name, figureId: null, sourceTurn: named.turn }]);

    const narrowing = "切り込みのある最初の図形のことです。";
    const narrowedPlan = namingPlan(material => material.claims.some(row => row[1] > named.turn && row[2] === "assert" &&
      row[3] === "referent" && row[4].length === 1 && row[4][0] === "f0"), true);
    const confirmed = await send(narrowing + proposedName, {
      ...narrowedPlan,
      extraction: JSON.stringify([segment("referent", narrowing, "referent", [a]), segment("proposal", proposedName, "name", [], null, name)]),
      choose: (key, criteria, context) => key === "segment_0_act" ? "assert" : narrowedPlan.choose?.(key, criteria, context),
    });
    assert.deepEqual(confirmed.state.ledger[a], { name, status: "agreed" });
  });
}
