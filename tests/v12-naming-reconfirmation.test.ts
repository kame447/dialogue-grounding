import assert from "node:assert/strict";
import test from "node:test";
import type { AgreeNameScopeVersion } from "../dialogue-model/runtime/decision/naming-request.ts";
import type { NamingResponseEvidence } from "../dialogue-model/runtime/decision/naming-reconfirmation.ts";
import type { LocalClaimView, LocalSegmentProposal, PublicTurn } from "../dialogue-model/runtime/local-grounding/contract.ts";
import { createOwnLedger } from "../dialogue-model/runtime/judgment/schema.mjs";
import { buildAgreeNamesV3 } from "../dialogue-model/runtime/v2/jev-turn.ts";
import { verifyRecords } from "../dialogue-model/runtime/diagnostics/parity-verify/index.ts";
import { buildRecords, OWN, OLD, type Turn, type runTurn } from "./support/s4-v3-records.ts";

const slots = ["s-0001", "s-0002", "s-0003", "s-0004", "s-0005", "s-0006"];
const [primary, alternate] = slots;
const name = "音符";
const previousName = "丸み";
const previousNaming = "「丸み」と呼びませんか。";
const introduction = "細い棒があります。";
const question = "端に切れ目が見えますか？";
const no = "いいえ、私が見ているのは別の場所です。";
const yes = "はい、切れ目があります。";
const identity = "私が見ている図形と同じです。";
const naming = "「音符」と呼びませんか。";
const orientation = "傾きがある形です。";
const position = "細い部分のそばに切れ目があります。";

function claim(id: string, sourceTurn: number, speaker: LocalClaimView["speaker"], act: LocalClaimView["act"],
  aspect: LocalClaimView["aspect"], targets: string[], quote: string, respondsTo: string | null = null, label: string | null = null): LocalClaimView {
  return { id, sourceTurn, turn: Number(id.split(":")[0]), speaker, act, aspect, targets, quote,
    proposition: quote, respondsTo, issueId: respondsTo ?? id, name: label,
    source: speaker === "ai" ? "ai_hypothesis" : "partner_statement" };
}

function judgment(turnIndex: number, action: "confirm" | "repair" | "accept", figureId: string, multiple = false) {
  return { turnIndex, judgment: { action }, aiPublic: { aiSeq: turnIndex + 1 }, generationGuard: { fallback: false },
    jevTurn: { executed: { target: multiple ? { kind: "multiple", figureIds: [primary, alternate] } : { kind: "single", figureId } } } };
}

function segment(segmentId: string, quote: string, aspect: LocalSegmentProposal["aspect"], targets: string[],
  respondsToTurn: number | null = null, label: string | null = null): LocalSegmentProposal {
  return { segmentId, quote, aspect, targets, respondsToTurn, name: label, proposition: quote, linkedIssueId: null };
}

function candidates(claims: readonly LocalClaimView[], judgments: ReturnType<typeof judgment>[], scope: AgreeNameScopeVersion,
  extra = "", response?: NamingResponseEvidence, focus = alternate) {
  const turn = claims.at(-1)!.sourceTurn;
  const publicTurns: PublicTurn[] = [...new Map(claims.map(c => [c.sourceTurn, {
    turn: c.sourceTurn, speaker: c.speaker,
    text: (c.sourceTurn === turn ? extra : "") + claims.filter(p => p.sourceTurn === c.sourceTurn).map(p => p.quote).join(""),
  }])).values()].sort((a, b) => a.turn - b.turn);
  return buildAgreeNamesV3(claims, publicTurns, turn, slots, {
    ledger: createOwnLedger(slots), judgments: judgments as never, agreeNameScopeVersion: scope,
  }, { status: "ok", scores: { [focus]: 1, none: 0 } }, true, new Set(), true, true, true, response);
}

test("a mixed denial vetoes the figure actually checked, while a genuinely multiple check keeps all denials", () => {
  const checked = claim("4:pub2", 3, "ai", "ask", "question", [primary, alternate], question);
  const denial = claim("4:local1", 4, "human", "deny", "question", [primary, alternate], no, checked.id);
  const nextFocus = claim("8:pub1", 7, "ai", "assert", "referent", [alternate], introduction);
  const proposal = claim("8:local1", 8, "human", "name_propose", "name", [alternate], naming, null, name);
  const claims = [checked, denial, nextFocus, proposal];
  const checks = [judgment(2, "confirm", primary), judgment(6, "accept", alternate)];
  assert.deepEqual(candidates(claims, checks, "scoped_v10"), []);
  assert.deepEqual(candidates(claims, checks, "scoped_v11").map(c => c.figureId), [alternate]);
  assert.deepEqual(candidates(claims, [judgment(2, "confirm", primary, true), checks[1]], "scoped_v11"), []);
  assert.deepEqual(candidates([checked, { ...denial, aspect: "referent" }, nextFocus, proposal], checks, "scoped_v11"), []);
  assert.deepEqual(candidates([checked, denial, { ...nextFocus, targets: [primary] }, { ...proposal, targets: [primary] }],
    [checks[0], judgment(6, "accept", primary)], "scoped_v11", "", undefined, primary), []);
});

test("reconfirmation requires distinct linked feature and identity answers, with no new denial", () => {
  const original = claim("2:local1", 2, "human", "name_propose", "name", [alternate], previousNaming, null, previousName);
  const earlier = claim("4:pub2", 3, "ai", "ask", "question", [alternate], question);
  const denial = claim("4:local1", 4, "human", "deny", "question", [alternate], no, earlier.id);
  const orientationClaim = claim("6:pub1", 5, "ai", "assert", "orientation", [primary, alternate], orientation);
  const checked = claim("6:pub2", 5, "ai", "ask", "question", [alternate], question);
  const proposal = claim("6:local1", 6, "human", "name_propose", "name", [primary, alternate], naming, null, name);
  const claims = [original, earlier, denial, orientationClaim, checked, proposal];
  const checks = [judgment(2, "confirm", alternate), judgment(4, "confirm", alternate)];
  const feature = segment("feature", yes, "contour", [alternate], 5);
  const referent = segment("identity", identity, "referent", [primary, alternate], 5);
  const featureVerdict = { segmentId: feature.segmentId, act: "agree", respondsToClaimId: checked.id, answersChecked: "yes" } as const;
  const identityVerdict = { segmentId: referent.segmentId, act: "agree", respondsToClaimId: orientationClaim.id, answersChecked: "yes" } as const;
  const response: NamingResponseEvidence = { extractor: { segments: [feature, referent] },
    classifier: { status: "ok", verdicts: [featureVerdict, identityVerdict] } };
  assert.deepEqual(candidates(claims, checks, "scoped_v10", yes + identity, response), []);
  const renewed = { name, figureId: alternate, sourceTurn: 6 };
  assert.deepEqual(candidates(claims, checks, "scoped_v11", yes + identity, response), [renewed]);
  const sameName = { ...original, name, quote: naming, proposition: naming };
  assert.deepEqual(candidates([sameName, ...claims.slice(1)], checks, "scoped_v11", yes + identity, response),
    [{ ...renewed, sourceTurn: 2 }, renewed]);
  for (const missing of [
    { ...response, classifier: { ...response.classifier, verdicts: [featureVerdict] } },
    { ...response, classifier: { ...response.classifier, verdicts: [featureVerdict, { ...identityVerdict, respondsToClaimId: null }] } },
    { ...response, classifier: { ...response.classifier, verdicts: [featureVerdict, { ...identityVerdict, act: "deny" as const }] } },
    { ...response, extractor: { segments: [feature, { ...referent, quote: yes }] } },
  ]) {
    assert.deepEqual(candidates(claims, checks, "scoped_v11", yes + identity, missing), []);
  }
  assert.deepEqual(candidates(claims.filter(c => c !== denial), checks, "scoped_v11", yes + identity, response), []);
});

for (const label of ["repair-first", "bypass-enabled"] as const) {
  test(`scoped_v11 offers and saves only the renewed name after a rename in ${label}`, async () => {
    const [own, other] = OWN.ownAnchors.map((anchor: { id: string }) => anchor.id);
    const memo = structuredClone(OLD.state.observationMemo);
    memo.figures[0].analytic.shapes = ["端に切れ目がある", "傾きがある"];
    const turns: Turn[] = [
      { human: previousNaming, plan: {
        action: "confirm", target: "figure_0", referent: "figure_0", speech: introduction + question,
        act: "name_propose", extraction: JSON.stringify([
          segment("name", previousNaming, "name", [own], null, previousName),
        ]),
        aiActs: ["assert", "ask"], aiExtraction: JSON.stringify([
          segment("part", introduction, "part", [own]), segment("check", question, "question", [own]),
        ]),
      } },
      { human: no, plan: {
        action: "confirm", target: "figure_0", referent: "figure_0", speech: orientation + position + question,
        drafts: [orientation + position + question], act: "deny", answers: "not_an_answer",
        extraction: JSON.stringify([segment("denial", no, "contour", [own], 2)]),
        aiActs: ["assert", "assert", "ask"], aiExtraction: JSON.stringify([
          segment("orientation", orientation, "orientation", [own, other]),
          segment("position", position, "position", [own]),
          segment("check", question, "question", [own]),
        ]),
        choose: (key, choices, { generationCalls }) => {
          if (generationCalls === 0 && key === "segment_0_antecedent") {
            return Object.entries(choices).find(([, detail]) => detail.includes("3:pub2"))?.[0];
          }
        },
      } },
      { human: yes + identity + "呼び名を変えて、" + naming, plan: {
        action: "agree", target: "figure_0", referent: "figure_0", speech: "はい、「音符」と呼びましょう。",
        answers: "answers_checked_point",
        extraction: JSON.stringify([
          segment("yes", yes, "contour", [own], 4), segment("identity", identity, "referent", [own, other], 4),
          segment("name", naming, "name", [own, other], null, name),
        ]),
        choose: (key, choices) => {
          if (key === "segment_0_act" || key === "segment_1_act") return "agree";
          if (key === "segment_2_act") return "name_propose";
          const linked = key === "segment_0_antecedent" ? "5:pub3" : key === "segment_1_antecedent" ? "5:pub1" : undefined;
          if (linked) return Object.entries(choices).find(([, detail]) => detail.includes(linked))?.[0];
        },
      } },
    ];
    const outcomes: Awaited<ReturnType<typeof runTurn>>[] = [];
    const records = await buildRecords({ label, dialoguePolicy: "holistic_v5", generationRetryVersion: "jev_generation_retry_v12",
      agreeNameScopeVersion: "scoped_v11", technicalTrial: { version: "adaptive_repair_v3" }, memo, turns,
      onTurn: (side, outcome) => { if (side === label) outcomes.push(outcome); },
    });
    assert.ok(outcomes[0].trace.local?.claims.some(c => c.act === "name_propose" && c.name === previousName && c.targets[0] === own));
    assert.ok(outcomes[1].trace.local?.claims.some(c => c.act === "deny" && c.targets[0] === own));
    const result = outcomes[2];
    assert.deepEqual(result.state.judgments.at(-1).jevTurn.agreeNames, [{ name, figureId: own, sourceTurn: 5 }]);
    assert.equal(result.state.judgments.at(-1).jevTurn.executed.action, "agree");
    assert.equal(result.publication.status, "committed");
    assert.equal(result.speech, turns[2].plan.speech);
    assert.deepEqual(result.state.ledger[own], { status: "agreed", name });
    assert.deepEqual(verifyRecords(records).checks.filter(c => c.id.startsWith("intervention.trial.0.attempt.0.")).map(c => c.status),
      ["pass", "pass", "pass", "pass"]);
  });
}
