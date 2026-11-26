import assert from "node:assert/strict";
import test from "node:test";
import { publiclyCheckedNamingTarget } from "../dialogue-model/runtime/decision/naming-request.ts";
import type { AgreeNameScopeVersion } from "../dialogue-model/runtime/decision/naming-request.ts";
import { createOwnLedger } from "../dialogue-model/runtime/judgment/schema.mjs";
import { createReferenceGraph } from "../dialogue-model/runtime/memory/reference-graph.mjs";
import { LOCAL_QUESTION_ANSWER_SOURCE } from "../dialogue-model/runtime/local-grounding/contract.ts";
import type { LocalClaimView, LocalFunctionVerdict, LocalSegmentProposal, PublicTurn } from "../dialogue-model/runtime/local-grounding/contract.ts";
import { priorClaimViews } from "../dialogue-model/runtime/local-grounding/derive.ts";
import { verifyLocalUpdate } from "../dialogue-model/runtime/local-grounding/verify.ts";
import { buildAgreeNamesV3 } from "../dialogue-model/runtime/v2/jev-turn.ts";
import { s4LocalReverify } from "../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts";
import { verifyRecords } from "../dialogue-model/runtime/diagnostics/parity-verify/index.ts";
import { buildRecords, OWN, OLD, type Turn, type runTurn } from "./support/s4-v3-records.ts";

const slots = ["s-0001", "s-0002", "s-0003", "s-0004", "s-0005", "s-0006"];
const [figure, other] = slots;

function claim(id: string, sourceTurn: number, speaker: LocalClaimView["speaker"], act: LocalClaimView["act"],
  aspect: LocalClaimView["aspect"], quote: string, extra: Partial<LocalClaimView> = {}): LocalClaimView {
  return { id, sourceTurn, turn: sourceTurn, speaker, act, aspect, quote, proposition: quote, issueId: id,
    targets: [figure], name: null, respondsTo: null, source: speaker === "ai" ? "ai_hypothesis" : "partner_statement", ...extra };
}

const description = claim("4:pub1", 3, "ai", "assert", "part", "細い棒が付いています。", { turn: 4 });
const question = claim("4:pub2", 3, "ai", "ask", "question", "棒のある形ですか？", { turn: 4 });
const proposal = (turn: number) => claim(`${turn}:local2`, turn, "human", "name_propose", "name", "「音符」と呼びませんか。", { name: "音符" });
const judgment = (turnIndex: number, action: "confirm" | "repair") => ({
  turnIndex, judgment: { action }, aiPublic: { aiSeq: turnIndex + 1 },
  jevTurn: { executed: { target: { kind: "single", figureId: figure } } },
});

function turnsFor(claims: readonly LocalClaimView[]): PublicTurn[] {
  return [...new Map(claims.map(c => [c.sourceTurn, {
    turn: c.sourceTurn, speaker: c.speaker,
    text: claims.filter(d => d.sourceTurn === c.sourceTurn).map(d => d.quote).join(""),
  }])).values()].sort((a, b) => a.turn - b.turn);
}

function candidates(claims: readonly LocalClaimView[], turn: number, scope: AgreeNameScopeVersion,
  judgments = [judgment(2, "confirm")]) {
  const ledger = createOwnLedger(slots);
  const current = { status: "ok", scores: { [figure]: 1, [other]: 0, none: 0 } };
  return buildAgreeNamesV3(claims, turnsFor(claims), turn, slots,
    { ledger, judgments: judgments as never, agreeNameScopeVersion: scope }, current, true, new Set(), true, true, true);
}

test("a part description without an answer link cannot establish the naming target in scoped_v9", () => {
  const observation = claim("4:local3", 4, "human", "assert", "part", "こちらの形にも細い棒があります。");
  const claims = [description, question, observation, proposal(4)];
  assert.equal(candidates(claims, 4, "scoped_v7").length, 1);
  assert.deepEqual(candidates(claims, 4, "scoped_v9"), []);
  const linkedAnswer = claim("4:local1", 4, "human", "agree", "question", "はい、棒が付いています。", {
    respondsTo: question.id, issueId: question.issueId, source: "partner_labelled_answer",
  });
  for (const extra of [[], [observation]]) {
    const supported = [description, question, ...extra, linkedAnswer, proposal(4)];
    assert.equal(publiclyCheckedNamingTarget(supported, turnsFor(supported), [judgment(2, "confirm")], 4, false, "scoped_v9"), figure);
    assert.deepEqual(candidates(supported, 4, "scoped_v9").map(c => c.figureId), [figure]);
  }
});

function verifyReply(prior: LocalClaimView, act: "agree" | "deny", bindDirectQuestionReplies: boolean, respondsToTurn = 3,
  targets = [other]) {
  const graph = { ...createReferenceGraph({ slots }), lastTurn: 4, records: [
    { ...prior, kind: "claim" as const },
  ] };
  const quote = act === "deny" ? "いいえ、棒はありません。" : "はい、細い棒があります。";
  const segment: LocalSegmentProposal = { segmentId: "seg", quote, targets, aspect: "part", proposition: quote,
    name: null, linkedIssueId: null, respondsToTurn };
  const verdict: LocalFunctionVerdict = { segmentId: "seg", act, respondsToClaimId: prior.id,
    rawScore: null, answersChecked: act === "agree" ? "yes" : "no" };
  return verifyLocalUpdate({ graph, turn: 4, publicTurns: turnsFor([prior, claim("4:local1", 4, "human", act, "part", quote)]),
    segments: [segment], verdicts: [verdict], referenceQuestionBindings: new Map([[prior.id, figure]]),
    directReferenceReplies: true, refinedReplyRules: true, answerFieldRules: true, bindDirectQuestionReplies });
}

test("only a direct affirmation or denial of a public singleton question takes its verified target", () => {
  for (const act of ["agree", "deny"] as const) {
    for (const targets of [[other], [other, figure], [figure, other]]) {
      const old = verifyReply(question, act, false, 3, targets);
      assert.deepEqual(old.operations, []);
      assert.equal(old.rejected[0]?.reason, "inconsistent_claim_response");
      const current = verifyReply(question, act, true, 3, targets);
      assert.deepEqual(current.rejected, []);
      assert.deepEqual(current.operations.map(c => [c.act, c.aspect, c.targets, c.respondsTo]),
        [[act, "question", [figure], question.id]]);
    }
    assert.deepEqual(verifyReply({ ...question, targets: [figure, slots[2]] }, act, true).operations, []);
    assert.deepEqual(verifyReply(question, act, true, 2).operations, []);
  }
});

test("a later question does not erase a denied target, but a confirmed public repair can", () => {
  const verified = verifyReply(question, "deny", true, 3, [other, figure]).operations[0];
  assert.ok(verified);
  const denial = { ...verified, turn: 4 };
  const laterDescription = { ...description, id: "6:pub1", issueId: "6:pub1", sourceTurn: 5, turn: 6 };
  const laterQuestion = { ...question, id: "6:pub2", issueId: "6:pub2", sourceTurn: 5, turn: 6 };
  const answer = claim("6:local1", 6, "human", "agree", "question", "それです。", {
    respondsTo: laterQuestion.id, issueId: laterQuestion.issueId, source: "partner_labelled_answer",
  });
  const evidence = [description, question, denial, laterDescription, laterQuestion, answer, proposal(6)];
  assert.equal(candidates(evidence.filter(c => c !== denial), 6, "scoped_v7", [judgment(2, "confirm"), judgment(4, "confirm")]).length, 1);
  assert.deepEqual(candidates(evidence, 6, "scoped_v9", [judgment(2, "confirm"), judgment(4, "confirm")]), []);
  const featureOnly = evidence.map(c => c === answer ? { ...c, quote: "そこに丸い切り込みがあります。" } : c);
  assert.deepEqual(candidates(featureOnly, 6, "scoped_v9", [judgment(2, "confirm"), judgment(4, "repair")]), []);
  assert.deepEqual(candidates(evidence, 6, "scoped_v9", [judgment(2, "confirm"), judgment(4, "repair")]).map(c => c.figureId), [figure]);
});

const [own, mistaken] = OWN.ownAnchors.map((anchor: { id: string }) => anchor.id);
const repairedName = "音符";
const openingDescription = "細い棒があります。";
const openingQuestion = "端に三角が見えますか？";
const repairedDescription = "訂正します。端に丸い切り込みのある形です。";
const repairedQuestion = "その切り込みのある形を指していますか？";
const denial = "いいえ、先は三角ではありません。";
const confirmation = "それです。";
const naming = "「音符」と呼びませんか。";

function segment(segmentId: string, quote: string, aspect: LocalSegmentProposal["aspect"], targets: string[],
  respondsToTurn: number | null = null, name: string | null = null): LocalSegmentProposal {
  return { segmentId, quote, aspect, targets, respondsToTurn, name, proposition: quote, linkedIssueId: null };
}

for (const label of ["repair-first", "bypass-enabled"] as const) {
  test(`scoped_v9 commits the same figure after a public correction in ${label}`, async () => {
    const memo = structuredClone(OLD.state.observationMemo);
    memo.figures[0].analytic.shapes = ["端に三角がある", "端に丸い切り込みがある"];
    const turns: Turn[] = [
      { human: "細い棒のある形を比べたいです。", plan: {
        action: "confirm", target: "figure_0", referent: "figure_0", speech: openingDescription + openingQuestion,
        aiActs: ["assert", "ask"], aiExtraction: JSON.stringify([
          segment("part", openingDescription, "part", [own]), segment("check", openingQuestion, "question", [own]),
        ]),
      } },
      { human: denial, plan: {
        action: "repair", target: "figure_0", referent: "figure_0", speech: repairedDescription + repairedQuestion,
        act: "deny", antecedent: "claim_1", answers: "not_an_answer",
        extraction: JSON.stringify([segment("denial", denial, "contour", [mistaken, own], 2)]),
        aiActs: ["assert", "ask"], aiExtraction: JSON.stringify([
          segment("part", repairedDescription, "part", [own]), segment("check", repairedQuestion, "question", [own]),
        ]),
      } },
      { human: confirmation + naming, plan: {
        action: "agree", target: "figure_0", referent: "figure_0", name: repairedName, speech: "はい、「音符」と呼びましょう。",
        answers: "answers_checked_point",
        extraction: JSON.stringify([segment("yes", confirmation, "question", [own], 4), segment("name", naming, "name", [own], null, repairedName)]),
        choose: (key, choices) => {
          if (key === "segment_0_act") return "agree";
          if (key === "segment_1_act") return "name_propose";
          if (key === "segment_0_antecedent") return Object.entries(choices).find(([, detail]) => detail.includes("5:pub2"))?.[0];
        },
      } },
    ];
    const outcomes: Awaited<ReturnType<typeof runTurn>>[] = [];
    const records = await buildRecords({ label, dialoguePolicy: "holistic_v5", generationRetryVersion: "jev_generation_retry_v12",
      agreeNameScopeVersion: "scoped_v9", technicalTrial: { version: "adaptive_repair_v3" }, memo, turns,
      onTurn: (side, outcome) => { if (side === label) outcomes.push(outcome); },
    });
    const trial = records.trials[0];
    assert.ok(outcomes[1].trace.local?.claims.some(c => c.act === "deny" && c.targets[0] === own && c.respondsTo === "3:pub2"));
    assert.equal(outcomes[2].publication.status, "committed");
    assert.equal(outcomes[2].state.judgments.at(-1).jevTurn.executed.action, "agree");
    assert.deepEqual(outcomes[2].state.ledger[own], { status: "agreed", name: repairedName });
    assert.equal(trial.turns[0].publicText, turns[2].plan.speech);
    assert.deepEqual(verifyRecords(records).checks.filter(c => c.id.startsWith("intervention.trial.0.attempt.0.")).map(c => c.status),
      ["pass", "pass", "pass", "pass"]);
  });
}


test("scoped_v10 retains a direct feature answer to an explicit question only as local evidence", () => {
  const quote = "はい、細い棒があります。";
  const reply = claim("4:local1", 4, "human", "agree", "part", quote);
  const publicTurns = turnsFor([question, reply]);
  const extraction = segment("answer", quote, "part", [figure], 3);
  const verdict: LocalFunctionVerdict = { segmentId: "answer", act: "agree", respondsToClaimId: question.id, rawScore: null, answersChecked: "yes" };
  function verify(retainLocalQuestionAnswers: boolean, prior = question, raw = extraction, answer = verdict) {
    return verifyLocalUpdate({
      graph: { ...createReferenceGraph({ slots }), lastTurn: 4, records: [{ kind: "claim", ...prior }] },
      turn: 4, publicTurns, segments: [raw], verdicts: [answer],
      directReferenceReplies: true, refinedReplyRules: true, answerFieldRules: true, bindDirectQuestionReplies: true, retainLocalQuestionAnswers,
    });
  }

  assert.equal(verify(false).rejected[0]?.reason, "inconsistent_claim_response");
  const retained = verify(true);
  assert.deepEqual(retained.rejected, []);
  assert.deepEqual(retained.operations.map(c => [c.act, c.aspect, c.targets, c.respondsTo, c.source]),
    [["agree", "question", [figure], question.id, LOCAL_QUESTION_ANSWER_SOURCE]]);
  for (const targets of [[], [other], [figure, other]]) {
    assert.equal(verify(true, question, { ...extraction, targets }).operations.length, 0);
  }
  assert.equal(verify(true, { ...question, targets: [figure, other] }).operations.length, 0);
  assert.equal(verify(true, question, { ...extraction, respondsToTurn: 2 }).operations.length, 0);
  assert.equal(verify(true, question, extraction, { ...verdict, answersChecked: "unknown" }).operations.length, 0);

  // The local answer marker also excludes a reply with literal pointing words.
  const pointingAnswer = claim("4:local1", 4, "human", "agree", "question", "それです。", {
    respondsTo: question.id, issueId: question.issueId,
  });
  const evidence = [description, question, pointingAnswer, proposal(4)];
  assert.deepEqual(candidates(evidence, 4, "scoped_v10").map(c => c.figureId), [figure]);
  const localEvidence = evidence.map(c => c === pointingAnswer ? { ...c, source: LOCAL_QUESTION_ANSWER_SOURCE } : c);
  assert.deepEqual(candidates(localEvidence, 4, "scoped_v10"), []);
  const earlierDeny = claim("2:local1", 2, "human", "deny", "referent", "そこではありません。");
  assert.deepEqual(candidates([earlierDeny, ...evidence], 4, "scoped_v10", [judgment(2, "repair")]).map(c => c.figureId), [figure]);
  assert.deepEqual(candidates([earlierDeny, ...localEvidence], 4, "scoped_v10", [judgment(2, "repair")]), []);
});

for (const label of ["repair-first", "bypass-enabled"] as const) {
  test(`scoped_v10 retains the answer after an orientation or position description in ${label}`, async () => {
    const memo = structuredClone(OLD.state.observationMemo);
    memo.figures[0].analytic.shapes = ["端に三角がある", "細い切れ目がある"];
    const orientation = "傾きがある形です。";
    const position = "棒のそばに細い部分があります。";
    const followup = "細い部分に切れ目がありますか？";
    const affirmed = "はい、細い切れ目があります。";
    const turns: Turn[] = [
      { human: "細い棒の形を比べたいです。", plan: {
        action: "confirm", target: "figure_0", referent: "figure_0", speech: openingDescription + openingQuestion,
        aiActs: ["assert", "ask"], aiExtraction: JSON.stringify([
          segment("part", openingDescription, "part", [own]), segment("check", openingQuestion, "question", [own]),
        ]),
      } },
      { human: denial, plan: {
        action: "repair", target: "figure_0", referent: "figure_0", speech: orientation + position + followup,
        act: "deny", antecedent: "claim_1", answers: "not_an_answer",
        extraction: JSON.stringify([segment("denial", denial, "contour", [mistaken, own], 2)]),
        aiActs: ["assert", "assert", "ask"], aiExtraction: JSON.stringify([
          segment("orientation", orientation, "orientation", [own]),
          segment("position", position, "position", [own]),
          segment("check", followup, "question", [own]),
        ]),
      } },
      { human: affirmed + naming, plan: {
        action: "confirm", target: "figure_0", referent: "figure_0", speech: openingDescription + openingQuestion,
        drafts: [openingDescription + openingQuestion],
        answers: "answers_checked_point",
        extraction: JSON.stringify([segment("yes", affirmed, "part", [own], 4), segment("name", naming, "name", [own], null, repairedName)]),
        aiActs: ["assert", "ask"], aiExtraction: JSON.stringify([
          segment("part", openingDescription, "part", [own]), segment("check", openingQuestion, "question", [own]),
        ]),
        choose: (key, choices, { generationCalls }) => {
          if (generationCalls > 0) return undefined;
          if (key === "segment_0_act") return "agree";
          if (key === "segment_1_act") return "name_propose";
          if (key === "segment_0_antecedent") return Object.entries(choices).find(([, detail]) => detail.includes("5:pub3"))?.[0];
        },
      } },
      { human: "はい、棒は細いです。" + naming, plan: {
        action: "confirm", target: "figure_0", referent: "figure_0", speech: "細い棒について確認しましょう。",
        answers: "answers_checked_point",
        extraction: JSON.stringify([segment("yes", "はい、棒は細いです。", "part", [own], 6), segment("name", naming, "name", [own], null, repairedName)]),
        choose: (key, choices) => {
          if (key === "segment_0_act") return "agree";
          if (key === "segment_1_act") return "name_propose";
          if (key === "segment_0_antecedent") return Object.entries(choices).find(([, detail]) => detail.includes("7:pub2"))?.[0];
        },
      } },
    ];
    const outcomes: Awaited<ReturnType<typeof runTurn>>[] = [];
    const records = await buildRecords({ label, dialoguePolicy: "holistic_v5", generationRetryVersion: "jev_generation_retry_v12",
      agreeNameScopeVersion: "scoped_v10", technicalTrial: { version: "adaptive_repair_v3" }, memo, turns,
      onTurn: (side, outcome) => { if (side === label) outcomes.push(outcome); },
    });
    assert.ok(outcomes[1].trace.local?.claims.some(c => c.act === "deny" && c.targets[0] === own && c.respondsTo === "3:pub2"));
    assert.ok(priorClaimViews(outcomes[2].state.graph).some(c => c.source === LOCAL_QUESTION_ANSWER_SOURCE &&
      c.aspect === "question" && c.respondsTo === "5:pub3" && c.targets[0] === own));
    assert.deepEqual(outcomes[2].state.judgments.at(-1).jevTurn.agreeNames, []);
    assert.ok(outcomes[3].trace.local?.claims.some(c => c.source === "partner_labelled_answer" && c.targets[0] === own));
    assert.deepEqual(outcomes[3].state.judgments.at(-1).jevTurn.agreeNames, []);
    assert.equal(outcomes[3].state.ledger[own].status, "unassigned");
    assert.deepEqual(verifyRecords(records).checks.filter(c => c.id.startsWith("intervention.trial.0.attempt.0.")).map(c => c.status),
      ["pass", "pass", "pass", "pass"]);
    const tape = records.trials[0].replay[0].tape;
    const oldScope = { ...tape, state: { ...tape.state, agreeNameScopeVersion: "scoped_v9" } };
    assert.equal(s4LocalReverify(oldScope, outcomes[3].trace, "holistic_v5", outcomes[3].state.graph), "mismatch");
  });
}
