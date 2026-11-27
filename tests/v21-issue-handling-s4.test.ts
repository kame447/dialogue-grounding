import test from "node:test";
import assert from "node:assert/strict";
import { hash, sha256 } from "../dialogue-model/runtime/diagnostics/parity-verify/core.ts";
import { extractionEvidenceForJob, issueHandlingBasisMatches, issueHandlingCloseMatches, issueHandlingExtraRequestsMatch,
  issueHandlingFeatureScope, issueHandlingLedger, issueHandlingPartsMatch, issueHandlingPublicationPath,
  issueHandlingRelation, issueHandlingReplayBoundary, issueHandlingRequestMatches,
  issueHandlingSourcesMatch, publishedIssueHandlings } from "../dialogue-model/runtime/diagnostics/parity-verify/issue-handling-records.ts";
import type { IssueHandlingContext } from "../dialogue-model/runtime/diagnostics/parity-verify/issue-handling-records.ts";
import { interventionChecks } from "../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts";
import { buildRecords, OWN } from "./support/s4-v3-records.ts";

const own = ["one", "two", "three", "four", "five", "six"];
const none = { kind: "none" } as const;
const target = (figureId: string) => ({ kind: "single" as const, figureId });
const unknown = { kind: "unknown" } as const;
const issue = { kind: "resolve_issue", issueId: "q", claimId: "3:local1", sourceTurn: 3 } as const;
const request = (action: string, choices: Record<string, string> = {}, source = "other", commitment = "insufficient") => {
  const menu: Record<string, string[]> = { human_move_on_source: ["human_request", "other", "unclear"],
    commitment_state: ["not_due", "supported", "conflicting", "insufficient", "unclear"],
    non_bypass_alternative: ["confirm", "repair", "consult"],
    switch_function: ["resolve_old_issue", "secure_progress", "unclear"] };
  const stage = (name: string, values: Record<string, string>) => ({
    stage: name, choices: values, scores: Object.fromEntries(Object.entries(values).map(([key, value]) =>
      [key, Object.fromEntries((menu[key] ?? [value]).map(item => [item, item === value ? 1 : 0]))])),
  });
  return { stages: [stage("action", { action, human_move_on_source: source, commitment_state: commitment }),
    stage("target", { target: "none" }), stage("detail", choices)] };
};
const plan = (action: string, actionTarget: NonNullable<IssueHandlingContext["prior"]>["target"]) =>
  ({ action, target: actionTarget, name: null, feature: null, observe: null });

function trace(original: object, planned: object, props: Record<string, unknown>, repairFirst = true, substitute: object | null = null) {
  return { schemaVersion: "jev_intervention_v2", policy: repairFirst ? "bypass_acceptance_v3:veto" : "bypass_acceptance_v3:accept",
    original, planned, disposition: substitute ? "rejected" : "adopted",
    reasonCode: substitute ? "vetoed_issue_handling" : repairFirst ? "not_in_veto_set" : "no_intervention",
    alternative: substitute, handling: { schemaVersion: "jev_issue_handling_v1", class: "other", via: null,
      source: null, destination: null, initiator: null, anchor: null, switchFunction: null, flags: [],
      commitmentState: "insufficient", alternative: null, ...props }, failure: null };
}

for (const count of [4, 6]) test(`v21 S4 independently checks an unscoped hold and its fallback for ${count} figures`, () => {
  const slots = own.slice(0, count), ctx: IssueHandlingContext = { slots, turn: 3, claims: [], history: [], prior: null };
  const original = { ...plan("hold_open", none), issue: unknown };
  const decision = { ...original, evidence: request("hold_open", { handled_issue: "unknown", non_bypass_alternative: "confirm" }) };
  const substitute = { ...plan("confirm", { kind: "multiple", figureIds: slots }), visualPurpose: unknown, detailFigureIds: [] };
  const expected = { class: "hold_open", source: { target: none, issue: unknown, derivation: "selected" },
    initiator: "ai", anchor: { kind: "human_turn", turn: 3 }, alternative: "confirm" };
  const vetoed = trace(original, original, expected, true, substitute);
  const adopted = trace(original, original, expected, false);
  assert.equal(issueHandlingRelation(decision, adopted, original, "bypass-enabled", ctx), true);
  assert.equal(issueHandlingRelation(decision, vetoed, substitute, "repair-first", ctx), true);
  assert.equal(issueHandlingRelation(decision, vetoed, substitute, "bypass-enabled", ctx), false);
  assert.equal(issueHandlingRelation(decision, { ...vetoed, reasonCode: "unanchored" }, substitute, "repair-first", ctx), false);
  assert.equal(issueHandlingRelation(decision, vetoed, { ...substitute, target: target(slots[0]) }, "repair-first", ctx), false);
  assert.equal(issueHandlingRelation(decision, vetoed, { ...substitute, action: "close" }, "repair-first", ctx), false);
  const bad = { ...vetoed, handling: { ...vetoed.handling, anchor: { kind: "previous_action", turn: 1 } } };
  assert.equal(issueHandlingRelation(decision, bad, substitute, "repair-first", ctx), false);
});

test("v21 S4 checks previously published issue handling, not its labelling score", () => {
  const history = [{ turn: 1, issueId: "first", candidatesAfter: ["one"] }, { turn: 3, issueId: "late", candidatesAfter: ["one"] }];
  const ctx: IssueHandlingContext = { slots: own.slice(0, 4), turn: 7, history, claims: [], prior: null,
    prospect: { status: "ok", prospect: "stalled", issue: { choice: "issue", turn: 1, issueId: "first" } } };
  const original = { ...plan("revisit", target("two")), issue: unknown, detailFigureIds: [] };
  const destination = { kind: "old_issue", issue: unknown, targets: ["two"] };
  const decision = { ...original, evidence: request("revisit", { handled_issue: "unknown", switch_function: "secure_progress",
    non_bypass_alternative: "consult" }) };
  const planned = { ...plan("carry_over", target("one")), issue: unknown, destination };
  const substitute = { ...plan("consult", target("one")), issue: unknown };
  const expected = { class: "carry_over", via: "revisit", destination, initiator: "ai",
    source: { target: target("one"), issue: unknown, derivation: "repair_prospect_issue" },
    anchor: { kind: "repair_history", turn: 3 }, switchFunction: "secure_progress", alternative: "consult" };
  const vetoed = trace(original, planned, expected, true, substitute);
  assert.equal(issueHandlingRelation(decision, vetoed, substitute, "repair-first", ctx), true);
  assert.equal(issueHandlingRelation(decision, { ...vetoed, planned: original }, substitute, "repair-first", ctx), false);
  assert.equal(issueHandlingRelation(decision, vetoed, substitute, "repair-first", { ...ctx, history: [] }), false);
  const wrongAnchor = { ...vetoed, handling: { ...vetoed.handling, anchor: { kind: "repair_history", turn: 1 } } };
  assert.equal(issueHandlingRelation(decision, wrongAnchor, substitute, "repair-first", ctx), false);
});

test("v21 S4 separates initiator and commitment from treatment", () => {
  const ctx: IssueHandlingContext = { slots: own, turn: 3, claims: [], history: [], prior: null };
  const original = plan("accept", target("one"));
  const decision = { ...original, evidence: request("accept", {}, "other", "conflicting") };
  assert.equal(issueHandlingRelation(decision, trace(original, original, { commitmentState: "conflicting" }), original, "repair-first", ctx), true);
  const carry = { ...plan("carry_over", target("one")), issue: unknown, destination: { kind: "partner_choice" } };
  const proof = (source: string) => ({ ...carry, evidence: request("carry_over", { handled_issue: "unknown", non_bypass_alternative: "repair" }, source) });
  const handling = { class: "carry_over", initiator: "ai", source: { target: carry.target, issue: unknown, derivation: "selected" },
    destination: carry.destination, alternative: "repair" };
  const unanchored = { ...trace(carry, carry, handling), reasonCode: "unanchored" };
  assert.equal(issueHandlingRelation(proof("other"), unanchored, carry, "repair-first", ctx), true);
  const human = { ...trace(carry, carry, { ...handling, initiator: "human" }), reasonCode: "human_led",
    humanMoveOn: { source: "human", publicTurn: 3, openRepairTurns: [] } };
  assert.equal(issueHandlingRelation(proof("human_request"), human, carry, "repair-first", ctx), true);
  assert.equal(issueHandlingRelation(proof("unclear"), human, carry, "repair-first", ctx), false);
});

test("v21 S4 binds issue provenance to a real public span, including the current unscoped claim", () => {
  const planWithSource = { ...plan("hold_open", none), issue };
  const claim = { id: issue.claimId, issueId: "q", sourceTurn: 3, targets: [], speaker: "human", quote: "どちらの形ですか" };
  const events = [{ seq: 3, speaker: "human", text: "どちらの形ですか。" }];
  const publication = { visualPurposeSources: [claim] };
  assert.equal(issueHandlingSourcesMatch(publication, [planWithSource], own, 3, events, [claim]), true);
  assert.equal(issueHandlingSourcesMatch(publication, [planWithSource], own, 5, events, [claim]), false);
  const prior = { ...planWithSource, target: target("one"), turn: 3 };
  const inherited = { ...plan("confirm", target("one")), visualPurpose: issue, detailFigureIds: [] };
  assert.equal(issueHandlingSourcesMatch(publication, [inherited], own, 5, events, [claim], prior), true);
  assert.equal(issueHandlingSourcesMatch(publication, [inherited], own, 5, events, [claim], { ...prior, target: target("two") }), false);
  assert.equal(issueHandlingSourcesMatch({ visualPurposeSources: [{ ...claim, quote: "合意しました" }] }, [planWithSource], own, 3, events), false);
  assert.equal(issueHandlingSourcesMatch({ visualPurposeSources: [claim, claim] }, [planWithSource], own, 3, events), false);
});

test("v21 S4 binds the saved handling basis to the turn, including publication recovery", () => {
  const claim = { id: issue.claimId, issueId: issue.issueId, sourceTurn: 3, turn: 3,
    targets: ["one"], speaker: "human", act: "ask", aspect: "referent", quote: "この形ですか" };
  const history = [{ turn: 3, issueId: issue.issueId, candidatesAfter: ["one"] }];
  const events = [{ seq: 3, speaker: "human", text: "この形ですか。" }];
  const ctx: IssueHandlingContext = { slots: own, turn: 5, claims: [claim, { ...claim, id: "2:else", issueId: "other" }],
    history, prior: null, prospect: { status: "ok", issue: { choice: "issue", issueId: issue.issueId, turn: 3 } }, events };
  const publication = { handlingBasis: { repairHistory: history, priorClaims: [claim] } };
  const recovery = [{ action: "accept" }, { action: "hold_open" }];
  assert.equal(issueHandlingBasisMatches(publication, recovery, ctx), true);
  assert.equal(issueHandlingBasisMatches(publication, [recovery[0]], ctx), false);
  assert.equal(issueHandlingBasisMatches({}, recovery, ctx), false);
  assert.equal(issueHandlingBasisMatches(publication, recovery, { ...ctx, history: [{ ...history[0], candidatesAfter: ["two"] }] }), false);
  assert.equal(issueHandlingBasisMatches(publication, recovery, { ...ctx, events: [{ ...events[0], text: "別の発話" }] }), false);
});

test("v21 S4 verifies the close initiator from decision evidence and unresolved from the ledger", () => {
  const decision = { evidence: request("close", {}, "human_request") };
  const ledger = { one: { status: "agreed", name: "鳥" }, two: { status: "tentative", name: "舟" } };
  const publication = { close: { unresolved: true, initiator: "human" } };
  assert.equal(issueHandlingCloseMatches(publication, "close", decision, ledger), true);
  assert.equal(issueHandlingCloseMatches(publication, "accept", decision, ledger), false);
  assert.equal(issueHandlingCloseMatches(publication, "close", decision, { one: ledger.one }), false);
  assert.equal(issueHandlingCloseMatches({ close: { unresolved: true, initiator: "ai" } }, "close", decision, ledger), false);
});

test("v21 S4 derives the handlings window from actual publication and keeps names intact", () => {
  const hold = { ...plan("hold_open", none), issue };
  const revisit = { ...plan("revisit", target("two")), issue: unknown };
  const judgments = [{ turnIndex: 1, jevTurn: { executed: hold } }, { turnIndex: 3, jevTurn: { executed: hold },
    generatedPublication: { recovery: { executed: revisit } } }, { turnIndex: 5, jevTurn: { executed: revisit },
    generatedPublication: { continuation: { choice: "ask_unresolved" } } }];
  assert.deepEqual(publishedIssueHandlings(judgments, own), [[1, "hold_open", [], "q", null], [3, "revisit", ["f1"], "unknown", null]]);
  const ledger = { one: { status: "agreed", name: "鳥" }, two: { status: "tentative", name: "舟" } };
  assert.deepEqual(issueHandlingLedger(ledger, revisit, null), ledger);
  assert.deepEqual(issueHandlingLedger(ledger, { ...plan("repair", target("one")), visualPurpose: unknown }, { figureId: "one", prior: ledger.one }),
    { ...ledger, one: { status: "unassigned", name: null } });
  assert.equal(issueHandlingLedger({ one: { status: "deferred", name: "鳥" } }, hold, null), null);
});

test("v21 S4 distinguishes live visual evidence from a published deferred extraction", () => {
  const carry = { ...plan("carry_over", target("one")), issue: unknown, destination: { kind: "other_figure" as const, figureId: "two" } };
  assert.deepEqual(issueHandlingFeatureScope(carry, own, false), ["one", "two"]);
  const hold = { ...plan("hold_open", none), issue: unknown };
  assert.deepEqual(issueHandlingFeatureScope(hold, own, false), own);
  const speech = "まだ合わせきれません。", pending = { aiSeq: 4, textSha256: sha256(speech) }, observationMemo = { figures: [] };
  const visual = { visualFeatures: { sources: [] } };
  assert.equal(issueHandlingPublicationPath(visual, carry, own, { aiPublic: { pending } }, 3, speech), true);
  const consult = { ...plan("consult", target("one")), issue: unknown };
  const job = { ...pending, eventId: "event-4", humanEventId: "event-3", schemaVersion: "deferred_ai_extraction_v1",
    graphRevision: 2, memoSha256: sha256(JSON.stringify(observationMemo)) };
  const state = { deferredAiExtraction: job, observationMemo, graph: { revision: 2 } };
  assert.equal(issueHandlingPublicationPath({}, consult, own, state, 3, speech), true);
  assert.equal(issueHandlingPublicationPath(visual, consult, own, state, 3, speech), false);
  assert.equal(issueHandlingPublicationPath({}, consult, own, { ...state, graph: { revision: 3 } }, 3, speech), false);
  assert.equal(issueHandlingPublicationPath({}, consult, own, state, 3, "別の発話"), false);
});

test("v21 S4 reconstructs a handled issue choice from the public turn material", () => {
  const decision = { ...plan("hold_open", none), issue };
  const stage = request("hold_open", { handled_issue: "issue_0", non_bypass_alternative: "confirm" }).stages[2];
  Object.assign(stage.scores.handled_issue, { clarify_reference: 0, resolve_mismatch: 0, unknown: 0 });
  const input = { issueHandlingVersion: "jev_issue_handling_v1", turn: 3, selected: { action: "hold_open", target: none },
    priorClaims: [{ id: issue.claimId, issueId: issue.issueId, sourceTurn: 3, targets: [], speaker: "human",
      act: "ask", aspect: "referent" }] };
  const criteria = { clarify_reference: "指示対象の不明", resolve_mismatch: "食い違い", unknown: "不明", issue_0: JSON.stringify(issue) };
  const questions = { handled_issue: { criteria }, non_bypass_alternative: { criteria: stage.scores.non_bypass_alternative } };
  assert.equal(issueHandlingRequestMatches(input, questions, stage, decision, own, false, false), true);
  assert.equal(issueHandlingRequestMatches({ ...input, strategy: "repair-first" }, questions, stage, decision, own, false, false), false);
  assert.equal(issueHandlingRequestMatches({ ...input, turn: 5 }, questions, stage, decision, own, false, false), false);
  assert.equal(issueHandlingRequestMatches(input, { ...questions, handled_issue: { criteria: { ...criteria, issue_0: JSON.stringify(unknown) } } },
    stage, decision, own, false, false), false);
});

test("v21 S4 rejects extraction crossing the publication boundary", () => {
  const values = { turn: 3, requestSeq: 8, speech: "まだ合わせきれません。", memo: { figures: [] },
    publicTurns: [{ turn: 3, speaker: "human", text: "この形かな。" }], profileSha256: sha256("profile"), graphRevision: 5 };
  const generation = { phase: "generation", role: "generation", provider: "luna" };
  const extraction = { phase: "ai_extraction", role: "post_generation", provider: "luna" };
  const functionLabels = { phase: "ai_function", role: "post_generation", provider: "jev" };
  const requests = [generation, extraction, functionLabels];
  const job = { schemaVersion: "deferred_ai_extraction_v1", eventId: "event-4", humanEventId: "event-3", aiSeq: 4,
    requestSeq: 8, textSha256: sha256(values.speech), memoSha256: sha256(JSON.stringify(values.memo)),
    profileSha256: values.profileSha256, publicTurnsSha256: sha256(JSON.stringify(values.publicTurns)),
    graphRevision: 5, state: "queued", error: null };
  const deferred = { requestsBeforePublication: 1, graphRevision: 5, job };
  assert.equal(issueHandlingReplayBoundary(deferred, requests, false, values), true);
  assert.equal(issueHandlingReplayBoundary({ ...deferred, requestsBeforePublication: 2 }, requests, false, values), false);
  assert.equal(issueHandlingReplayBoundary({ ...deferred, job: { ...job, requestSeq: 7 } }, requests, false, values), false);
  assert.equal(issueHandlingReplayBoundary(deferred, [...requests, generation], false, values), false);
  const segment = { segmentId: "s1", quote: values.speech, targets: ["one"], aspect: "referent",
    proposition: values.speech, name: null, linkedIssueId: null, respondsToTurn: null };
  const extractionData = { segments: [segment], rejected: [] };
  const validated = extractionEvidenceForJob([segment], values.speech, own, values.turn, values.publicTurns);
  assert.deepEqual(validated, { ...extractionData, sha256: hash(extractionData) });
  const classification = { ...deferred, requestsBeforePublication: 2,
    job: { ...job, schemaVersion: "deferred_ai_classification_v1", extraction: validated } };
  const supported = { ...values, extraction: validated! };
  assert.equal(issueHandlingReplayBoundary(classification, requests, true, supported), true);
  assert.equal(issueHandlingReplayBoundary({ ...classification, requestsBeforePublication: 3 }, requests, true, supported), false);
  assert.equal(issueHandlingReplayBoundary(classification, [generation, functionLabels], true, supported), false);
  assert.equal(issueHandlingReplayBoundary(classification, requests, true, { ...supported, extraction: { ...validated, sha256: sha256("changed") } }), false);
  assert.equal(issueHandlingReplayBoundary(classification, [...requests, extraction], true, supported), false);
});

test("v21 S4 reconstructs extra choices and replays an AI hold alternative independently", () => {
  const primary = plan("accept", none);
  const extra = { ...plan("hold_open", target("one")), issue };
  const scores = { extra_0: { leave: 0, confirm: 0, repair: 0, hold_open: 1 },
    extra_alt_0: { confirm: 1, repair: 0, consult: 0 } };
  const stage = { stage: "extras", choices: { extra_0: "hold_open", extra_alt_0: "confirm" }, scores };
  const stages = request("accept").stages.slice(0, 2);
  const decision = { ...primary, extras: [{ index: 0, original: extra }], evidence: { stages: [...stages, stage] } };
  const quote = "手前に細い部分がありますか";
  const claim = { id: issue.claimId, issueId: issue.issueId, sourceTurn: 3, turn: 3, speaker: "human",
    act: "ask", aspect: "part", targets: ["one"], quote };
  const ctx: IssueHandlingContext = { slots: own, turn: 3, claims: [claim], history: [], prior: null,
    events: [{ seq: 3, speaker: "human", text: quote + "？" }] };
  const question = (labels: string[], source = quote) => ({ type: "choice",
    instructions: "論点を扱うか決めてください。\n公開の出所: " +
      JSON.stringify({ quote: source, speaker: "human", sourceTurn: 3, targets: ["f0"] }),
    criteria: Object.fromEntries(labels.map(label => [label, "この論点の" + label])) });
  const questions = { extra_0: question(Object.keys(scores.extra_0)), extra_alt_0: question(Object.keys(scores.extra_alt_0)) };
  const state = { selected: { action: primary.action, target: primary.target }, priorClaims: [claim] };
  assert.equal(issueHandlingExtraRequestsMatch(decision, state, ctx, questions, stage), true);
  assert.equal(issueHandlingExtraRequestsMatch(decision, state, ctx, { ...questions, extra_0: question(Object.keys(scores.extra_0), "ウソ") }, stage), false);
  assert.equal(issueHandlingExtraRequestsMatch(decision, state, ctx), false);
  assert.equal(issueHandlingExtraRequestsMatch(decision, { ...state, priorClaims: [] }, ctx), true);
  const substitute = { ...plan("confirm", target("one")), visualPurpose: issue, detailFigureIds: [] };
  const execution = { ...primary, extras: [substitute] };
  const committed = { ...trace(primary, primary, {}), extras: [{ index: 0, original: extra,
    handling: { class: "hold_open", initiator: "ai", anchor: { kind: "human_turn", turn: 3 }, alternative: "confirm" },
    disposition: "rejected", reasonCode: "vetoed_issue_handling", executed: substitute }] };
  assert.equal(issueHandlingRelation(decision, committed, execution, "repair-first", ctx), true);
  assert.equal(issueHandlingRelation(decision, committed, { ...primary, extras: [extra] }, "repair-first", ctx), false);
});

test("v21 S4 checks publication positions, including a different public order", () => {
  const extra = { ...plan("confirm", target("two")), action: "confirm" as const, visualPurpose: issue, detailFigureIds: [] };
  const execution = { ...plan("agree", target("one")), name: "月の舟", extras: [extra] };
  assert.deepEqual(issueHandlingFeatureScope(execution, own, false), ["two"]);
  const draft = [{ item: 1, text: "ここを教えてください。" }, { item: 0, text: "月の舟ですね。" }];
  const speech = draft.map(part => part.text).join("\n");
  const parts = [{ item: 1, start: 0, end: draft[0].text.length, textSha256: sha256(draft[0].text) },
    { item: 0, start: draft[0].text.length + 1, end: speech.length, textSha256: sha256(draft[1].text) }];
  assert.equal(issueHandlingPartsMatch({ parts }, execution, speech, draft), true);
  assert.equal(issueHandlingPartsMatch({ parts }, execution, speech, [...draft].reverse()), false);
  assert.equal(issueHandlingPartsMatch({ parts: [parts[0], { ...parts[1], item: 1 }] }, execution, speech, draft), false);
  assert.equal(issueHandlingPartsMatch({ parts: [parts[0], { ...parts[1], start: parts[1].start + 1 }] }, execution, speech), false);
});

for (const figureCount of [4, 6] as const) {
  test(`v21 S4 replays separate issue handling and the classification job for ${figureCount} figures`, async () => {
    const questions = ["手前の台は細いですか？", "切り込みは丸いですか？", "横はふくらんでいますか？"];
    const extraction = JSON.stringify(questions.map((quote, index) => ({ segmentId: "q" + index,
      quote, proposition: quote, targets: [OWN.ownAnchors[index].id], name: null, aspect: "question",
      linkedIssueId: null, respondsToTurn: null })));
    const asks = "どんな切り込みに見えますか？";
    const hold = "うーん、切り込みの形は…";
    const first = "台の細さをもう少し教えてください。";
    const draft = (second: string) => JSON.stringify({
      parts: [{ item: 1, text: second }, { item: 0, text: first }], observationFeatures: [],
    });
    const newSegment = { segmentId: "new", quote: first, proposition: first, targets: [OWN.ownAnchors[0].id],
      name: null, aspect: "part", linkedIssueId: null, respondsToTurn: null };
    const records = await buildRecords({
      figureCount, dialoguePolicy: "holistic_v5", interventionVersion: "bypass_acceptance_v3",
      judgmentMaterialVersion: "jev_repair_quality_v1", technicalTrial: { version: "adaptive_repair_v3" },
      generationRetryVersion: "jev_generation_retry_v21", agreeNameScopeVersion: "jev_naming_v1",
      turns: [{ human: questions.join(" "), plan: {
        action: "confirm", target: "figure_0", act: "ask", extraction, aiActs: ["ask"],
        speechByLabel: { "repair-first": draft(asks), "bypass-enabled": draft(hold) },
        aiExtraction: JSON.stringify({ segments: [newSegment], visualFeatures: { sources: [] } }),
        choose: (key, criteria) => key === "visual_purpose" ? Object.keys(criteria).find(label => label.startsWith("issue_")) :
          ({ human_move_on_source: "other", commitment_state: "insufficient", extra_0: "hold_open",
            extra_alt_0: "confirm", extra_1: "leave", extra_alt_1: "confirm" } as Record<string, string>)[key],
      } }],
    });
    const checks = interventionChecks(records);
    assert.equal(checks.length, 5);
    assert.ok(checks.every(check => check.status === "pass"), JSON.stringify(checks));
    const { result } = records.trials[0].replay[0];
    for (const side of result.sides) {
      const { requestsBeforePublication, job } = side.publicationBoundary;
      assert.equal(job.schemaVersion, "deferred_ai_classification_v1");
      assert.deepEqual(side.requests.slice(requestsBeforePublication).map((request: { phase: string }) => request.phase),
        ["ai_function", "ai_support"]);
    }
    const altered = structuredClone(records);
    for (const side of [altered.trials[0].replay[0].result.sides[0], altered.evidence.pairedReplay[0].left]) {
      side.publicationBoundary.job.extraction.sha256 = "0".repeat(64);
    }
    assert.ok(interventionChecks(altered).some(check => check.id.endsWith(".replay") && check.status === "mismatch"));
    if (figureCount === 4) {
      const changedScope = structuredClone(records);
      for (const side of [changedScope.trials[0].replay[0].result.sides[1], changedScope.evidence.pairedReplay[0].right]) {
        const request = side.requests.find((entry: { phase: string }) => entry.phase === "generation");
        const message = request.payload.messages.find((entry: { content: string }) => entry.content.includes("items の 1 番: 相手の提示に短く反応し"));
        message.content = message.content.replace(/items の 1 番: [^\n]+/u, "items の 1 番: 相手に次の図形を選んでもらってください。");
        request.payloadSha256 = hash(request.payload);
      }
      assert.ok(interventionChecks(changedScope).some(check => check.id.endsWith(".replay") && check.status === "mismatch"));
    }
  });
}

test("v21 S4 uses naming detail before extras and keeps the common generation identical", async () => {
  const ask = "切り込みの縁は丸いですか？", name = "帆";
  const proposal = "手前の図形を「帆」と呼びましょう。";
  const segment = (quote: string, index: number, aspect: string, value: string | null) => ({
    segmentId: "s" + index, quote, proposition: quote, targets: [OWN.ownAnchors[index].id], aspect, name: value,
    linkedIssueId: null, respondsToTurn: null,
  });
  const records = await buildRecords({
    figureCount: 4, dialoguePolicy: "holistic_v5", interventionVersion: "bypass_acceptance_v3",
    judgmentMaterialVersion: "jev_repair_quality_v1", technicalTrial: { version: "adaptive_repair_v3" },
    generationRetryVersion: "jev_generation_retry_v21", agreeNameScopeVersion: "jev_naming_v2",
    turns: [{ human: proposal + ask, plan: {
      action: "agree", target: "figure_0", referent: "figure_0", name,
      extraction: JSON.stringify([segment(proposal, 0, "name", name), segment(ask, 1, "question", null)]),
      speech: JSON.stringify({ parts: [{ item: 0, text: "ええ、「帆」と呼びましょう。" },
        { item: 1, text: "その切り込みはどの部分にありますか？" }], observationFeatures: [] }),
      aiExtraction: JSON.stringify({ segments: [], visualFeatures: { sources: [] } }),
      choose: key => ({ segment_0_act: "name_propose", segment_1_act: "ask", extra_0: "confirm", extra_alt_0: "confirm",
        naming_grounding: "grounded_name_0", naming_evidence: "turn_1", human_move_on_source: "other",
        commitment_state: "insufficient" } as Record<string, string>)[key],
    } }],
  });
  const checks = interventionChecks(records);
  assert.equal(checks.length, 5);
  assert.ok(checks.every(check => check.status === "pass"), JSON.stringify(checks));
  const trial = records.trials[0];
  assert.deepEqual(trial.lastCommittedState.ledger[OWN.ownAnchors[0].id], { name, status: "agreed" });
  assert.deepEqual(trial.replay[0].result.sides[0].generatedPublication.visualFeatures, { sources: [] });
});

test("v21 S4 with jev_naming_v2 rejects the old target and antecedent on a non-answer", async () => {
  const figureId = OWN.ownAnchors[0].id;
  const question = "舟の先は尖っていますか？", acknowledgement = "質問の意味は分かりました。";
  const segment = (quote: string, targets: string[], respondsToTurn: number | null) => ({
    segmentId: "s0", quote, targets, aspect: "part", proposition: quote, name: null, linkedIssueId: null, respondsToTurn,
  });
  const records = await buildRecords({
    figureCount: 4, dialoguePolicy: "holistic_v5", interventionVersion: "bypass_acceptance_v3",
    judgmentMaterialVersion: "jev_repair_quality_v1", technicalTrial: { version: "adaptive_repair_v3" },
    generationRetryVersion: "jev_generation_retry_v21", agreeNameScopeVersion: "jev_naming_v2",
    turns: [
      { human: "舟の話から始めましょう。", plan: { action: "confirm", target: "figure_0",
        speech: JSON.stringify({ text: question, observationFeatures: [] }), aiActs: ["ask"],
        aiExtraction: JSON.stringify({ segments: [segment(question, [figureId], null)], visualFeatures: { sources: [] } }),
        choose: key => key === "human_move_on_source" ? "other" : key === "commitment_state" ? "insufficient" : undefined,
      } },
      { human: acknowledgement, plan: { action: "accept", target: "none", speech: "ありがとうございます。",
        act: "agree", antecedent: "claim_0", answers: "not_an_answer", extraction: JSON.stringify([segment(acknowledgement, [], 2)]),
        choose: key => key === "human_move_on_source" ? "other" : key === "commitment_state" ? "not_due" : undefined,
      } },
    ],
  });
  const trial = records.trials[0];
  const claim = trial.attempts[0].local.claims[0];
  assert.equal(claim.act, "acknowledge");
  assert.deepEqual(claim.targets, []);
  assert.equal(claim.respondsTo, null);
  const checks = interventionChecks(records);
  const replay = checks.find(check => check.id.endsWith(".replay") && check.status === "pass");
  assert.ok(replay, JSON.stringify(checks));
  for (const trace of [trial.attempts[0], trial.turns[0].trace[0]]) {
    Object.assign(trace.local.claims[0], { act: "agree", targets: [figureId], respondsTo: "2:pub1" });
  }
  assert.equal(interventionChecks(records).find(check => check.id === replay.id)?.status, "mismatch");
});
