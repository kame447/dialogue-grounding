import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildLocalClassificationState } from "../dialogue-model/runtime/local-grounding/classify.ts";
import type { LocalClaimView, PublicTurn } from "../dialogue-model/runtime/local-grounding/contract.ts";
import { priorClaimViews } from "../dialogue-model/runtime/local-grounding/derive.ts";
import { buildRetainedReferenceHistory, REFERENCE_EVIDENCE_MAX_CHARS } from "../dialogue-model/runtime/local-grounding/reference-evidence.ts";
import { applyReferenceUpdate, createReferenceGraph } from "../dialogue-model/runtime/memory/reference-graph.mjs";
import { GENERATION_RETRY_V22 } from "../dialogue-model/runtime/v2/generation-guard.ts";
import { researchTrialProfileV3 } from "../dialogue-model/runtime/v2/research-profile.ts";
import { initialState, normal, OWN, runTurn, type Label, type Plan } from "./support/s4-v3-records.ts";

const { lunaRequest, timeouts } = normal.run.manifest;
const profile = researchTrialProfileV3(lunaRequest, timeouts, "two_stage_v3", "holistic_v5",
  "bypass_acceptance_v3", "jev_repair_quality_v1");
const technicalTrial = { version: "adaptive_repair_v3" } as const;
const baseline = "jev_generation_retry_v21";
const figure = OWN.ownAnchors[0].id;
const question = "舟の帆には切り込みが二つありますか？";
const metaphor = "細長い三角が紙の帆のように見えます。";
const answer = "帆の切り込みは二つです。";
const draft = (text: string) => JSON.stringify({ text, observationFeatures: [] });
const segment = (quote: string, aspect: string, respondsToTurn: number | null, targets = [figure]) =>
  ({ segmentId: "s", quote, targets, aspect, proposition: quote, name: null, linkedIssueId: null, respondsToTurn });
const emptyObservation = (segments: ReturnType<typeof segment>[]) => JSON.stringify({ segments, visualFeatures: { sources: [] } });
const selected = (key: string) => ({ human_move_on_source: "other", commitment_state: "insufficient" } as Record<string, string>)[key];
const filler: Plan = { action: "accept", target: "none", speech: "ありがとうございます。", aiExtraction: "[]", choose: selected };

let history: ReturnType<typeof makeHistory> | undefined;
async function makeHistory() {
  const state = initialState({ profile, generationRetryVersion: baseline, agreeNameScopeVersion: "jev_naming_v2" });
  state.graph.memoryPruneVersion = "claim_prune_v3";
  const opening = await runTurn(profile, "repair-first", state,
    [{ id: "event-1", seq: 1, speaker: "human", text: metaphor }],
    { action: "confirm", target: "figure_0", speech: draft(question), act: "construe",
      extraction: JSON.stringify([segment(metaphor, "construal", null)]),
      aiExtraction: emptyObservation([segment(question, "part", null)]), aiActs: ["ask"], choose: selected },
    technicalTrial, baseline);
  const name = "灯台";
  const naming = "この形を灯台と呼びましょう。";
  const named = await runTurn(profile, "repair-first", opening.state,
    [...opening.publication.publicEvents, { id: "event-3", seq: 3, speaker: "human", text: naming }],
    { action: "agree", target: "figure_1", referent: "figure_1", name, act: "name_propose",
      speech: "はい、「灯台」と呼びましょう。", aiExtraction: "[]",
      extraction: JSON.stringify([{ ...segment(naming, "name", null, [OWN.ownAnchors[1].id]), name }]),
      choose: key => selected(key) ?? ({ naming_grounding: "grounded_name_0", naming_evidence: "turn_3" } as Record<string, string>)[key] },
    technicalTrial, baseline);
  let saved = named.state;
  let events = named.publication.publicEvents;
  for (let i = 2; i < 75; i++) {
    const seq = events.length + 1;
    const response = await runTurn(profile, "repair-first", saved,
      [...events, { id: `event-${seq}`, seq, speaker: "human", text: `照合の途中の発話 ${i}。` }],
      filler, technicalTrial, baseline);
    assert.equal(response.publication.status, "committed");
    saved = response.state;
    events = response.publication.publicEvents;
  }
  assert.equal(events.length, 150);
  return { saved, events };
}

async function final(label: Label, version: Parameters<typeof runTurn>[6], text: string, plan: Partial<Plan>, turnHistory?: Awaited<typeof history>) {
  const { saved, events } = turnHistory ?? await (history ??= makeHistory());
  const requests: { provider: "luna" | "jev"; body: any; bytes: number }[] = [];
  const seq = events.length + 1;
  const result = await runTurn(profile, label, saved,
    [...events, { id: `event-${seq}`, seq, speaker: "human", text }],
    { ...filler, ...plan, captureRequest: (provider, body) => requests.push({ provider, body: JSON.parse(body), bytes: Buffer.byteLength(body) }) },
    technicalTrial, version, OWN, "repair-first");
  return { ...result, requests };
}

test("v21 retains the old claim and the ledger, while outbound extraction, classification and generation omit its public source", async () => {
  const control = await final("repair-first", baseline, answer, { extraction: JSON.stringify([segment(answer, "part", null)]), act: "acknowledge" });
  assert.equal(control.publication.status, "committed");
  assert.equal(control.state.ledger[OWN.ownAnchors[1].id].name, "灯台");
  assert.ok(control.state.graph.records.some((record: { quote?: string }) => record.quote === question));
  const luna = control.requests.filter(request => request.provider === "luna").map(request => request.body.messages);
  const extraction = JSON.parse(luna[0][1].content);
  assert.equal(extraction.publicTurns.length, 32);
  assert.equal(extraction.publicTurns.some((turn: { turn: number }) => turn.turn <= 2), false);
  const classification = control.requests.find(request => request.provider === "jev" && request.body.questions.segment_0_antecedent);
  assert.ok(classification);
  assert.equal(JSON.parse(classification.body.state).priorClaims.some((claim: { sourceTurn: number }) => claim.sourceTurn <= 2), false);
  assert.equal(luna[1].some((message: { content: string }) => message.content === question || message.content === metaphor), false);
  const httpPin = createHash("sha256").update(JSON.stringify(control.httpBodies)).digest("hex");
  assert.equal(httpPin, "6c5111774bfa5bd131b927182c2595ffb0bab8794e5605c0f7dfeba69ac033de");
});

function requestInputs(result: Awaited<ReturnType<typeof final>>) {
  const luna = result.requests.filter(request => request.provider === "luna").map(request => request.body.messages);
  const extraction = JSON.parse(luna[0][1].content);
  const classification = result.requests.find(request => request.provider === "jev" && request.body.questions.segment_0_antecedent);
  const context = luna[1].find((message: { content: string }) => message.content.includes('\n{"retainedReferenceHistory":'));
  return { extraction, classification: classification && JSON.parse(classification.body.state),
    generation: context && JSON.parse(context.content.slice(context.content.indexOf("\n") + 1)).retainedReferenceHistory };
}

test("v22 can link a delayed substantive reply using a retained source without adding calls", async t => {
  const prior = await (history ??= makeHistory());
  const ask = prior.saved.graph.records.find((record: { quote?: string }) => record.quote === question);
  assert.ok(ask);
  const plan: Partial<Plan> = { extraction: JSON.stringify([segment(answer, "part", 2)]), act: "agree",
    choose: (key, criteria) => key === "segment_0_antecedent" ?
      Object.keys(criteria).find(value => criteria[value].includes(JSON.stringify(ask.id))) : selected(key) };
  const left = await final("repair-first", GENERATION_RETRY_V22, answer, plan, prior);
  const right = await final("bypass-enabled", GENERATION_RETRY_V22, answer, plan, prior);
  const { extraction, classification, generation } = requestInputs(left);
  assert.equal(extraction.publicTurns.length, 32);
  assert.equal(extraction.publicTurns.at(-1).text, answer);
  for (const archive of [extraction.retainedReferenceHistory, generation]) {
    assert.ok(archive.length <= 16);
    assert.ok(JSON.stringify(archive).length <= REFERENCE_EVIDENCE_MAX_CHARS);
    assert.ok(archive.some((row: { speaker: string; quote: string }) => row.speaker === "human" && row.quote === metaphor));
    assert.ok(archive.some((row: { claimId: string; sourceTurn: number; quote: string }) =>
      row.claimId === ask.id && row.sourceTurn === 2 && row.quote === question));
  }
  assert.equal(classification.priorClaims.find((row: { id: string }) => row.id === ask.id)?.quote, question);
  assert.equal(classification.segments[0].respondsToTurn, 2);
  assert.deepEqual(left.httpBodies, right.httpBodies);
  const control = await final("repair-first", baseline, answer, { extraction: JSON.stringify([segment(answer, "part", null)]), act: "acknowledge" }, prior);
  assert.deepEqual(left.httpBodies.map(row => row.provider), control.httpBodies.map(row => row.provider));
  t.diagnostic("v21/v22 outbound bytes: " + [control, left].map(result => result.requests.reduce((total, request) => total + request.bytes, 0)).join(" / ") +
    "; calls: " + left.httpBodies.length + "; archive chars: " + JSON.stringify(extraction.retainedReferenceHistory).length);
  assert.ok(left.state.graph.records.some((row: { respondsTo?: string; quote?: string; act?: string }) =>
    row.respondsTo === ask.id && row.quote === answer && row.act === "agree"));
  assert.deepEqual(left.state.ledger, prior.saved.ledger);
  assert.deepEqual(right.state.ledger, prior.saved.ledger);

  const oldTurns = left.publication.publicEvents.map(({ seq, speaker, text }: { seq: number; speaker: "human" | "ai"; text: string }) =>
    ({ turn: seq, speaker, text }));
  const archived = buildRetainedReferenceHistory(left.state.graph, oldTurns, [{ turn: 185, speaker: "human", text: "続きです。" }], 185);
  assert.ok(archived.some(row => row.quote === question && row.claimId === ask.id));
  assert.ok(archived.some(row => row.quote === answer && row.respondsTo === ask.id));
  const mismatched = oldTurns.map(turn => turn.turn === 2 ? { ...turn, text: "別の引用。" } : turn);
  assert.ok(!buildRetainedReferenceHistory(left.state.graph, mismatched, [{ turn: 185, speaker: "human", text: "続きです。" }], 185)
    .some(row => row.claimId === ask.id));
});

test("v22 retains only budgeted excerpts and does not displace the recent classifier input", () => {
  let graph = createReferenceGraph({ slots: OWN.ownAnchors.map((anchor: { id: string }) => anchor.id) });
  const older: PublicTurn[] = [];
  for (let turn = 1; turn <= 24; turn++) {
    const quote = `${turn}番の見立て ` + "輪郭が曲がっている細い部分".repeat(11);
    const source = { turn, speaker: "ai" as const, text: quote };
    older.push(source);
    const id = `${turn}:ai1`;
    graph = applyReferenceUpdate(graph, { expectedRevision: graph.revision, turn, operations: [{ kind: "claim", id,
      issueId: id, targets: [figure], aspect: "construal", act: "construe", proposition: quote, name: null,
      speaker: "ai", sourceTurn: turn, quote, source: "ai_hypothesis", respondsTo: null }] },
    { generationSucceeded: true, publicTurns: [source] });
  }
  const current = { turn: 151, speaker: "human" as const, text: answer };
  const recent: PublicTurn[] = Array.from({ length: 31 }, (_, index) => ({ turn: 120 + index, speaker: "ai", text: "続".repeat(575) }));
  recent.push(current);
  const archive = buildRetainedReferenceHistory(graph, older, recent, current.turn);
  assert.ok(archive.length > 1 && archive.length <= 16);
  assert.ok(JSON.stringify(archive).length <= REFERENCE_EVIDENCE_MAX_CHARS);
  const response = { ...segment(answer, "part", null), aspect: "part" as const };
  const recentClaim: LocalClaimView = { id: "150:ai1", issueId: "150:ai1", turn: 150, speaker: "ai",
    sourceTurn: 150, quote: "続", targets: [figure], aspect: "part", act: "assert", proposition: "続", name: null,
    source: "ai_hypothesis", respondsTo: null };
  const priorClaims = [...priorClaimViews(graph), recentClaim];
  const classified = buildLocalClassificationState({ turn: current.turn, publicTurns: recent, segments: [response], priorClaims,
    retainedReferenceHistory: archive });
  const { publicTurns, priorClaims: kept } = JSON.parse(classified);
  assert.ok(classified.length <= 20000);
  assert.deepEqual(publicTurns, recent);
  assert.ok(kept.some((row: { id: string }) => row.id === recentClaim.id));
  assert.ok(kept.some((row: { retained?: true }) => row.retained));
  assert.ok(kept.length < archive.length + 1);
});

test("v22 leaves unavailable antecedents and acknowledgements out of positive local and naming evidence", async () => {
  const prior = await (history ??= makeHistory());
  const missing = await final("repair-first", GENERATION_RETRY_V22, answer,
    { extraction: JSON.stringify([segment(answer, "part", 6)]), act: "agree" }, prior);
  assert.equal(missing.trace.local?.extractor.errorCode, "invalid_response");
  assert.ok(!missing.state.graph.records.some((row: { quote?: string }) => row.quote === answer));

  const text = "なるほど。";
  const ack = await final("repair-first", GENERATION_RETRY_V22, text,
    { act: "acknowledge", extraction: JSON.stringify([segment(text, "part", 2, [])]) }, prior);
  assert.ok(!ack.state.graph.records.some((row: { act?: string; quote?: string }) => row.quote === text && row.act !== "acknowledge"));
  const ask = prior.saved.graph.records.find((record: { quote?: string }) => record.quote === question);
  const nonAnswer = await final("repair-first", GENERATION_RETRY_V22, text,
    { act: "agree", answers: "not_an_answer", extraction: JSON.stringify([segment(text, "part", 2)]),
      choose: (key, criteria) => key === "segment_0_antecedent" ?
        Object.keys(criteria).find(value => criteria[value].includes(JSON.stringify(ask.id))) : selected(key) }, prior);
  assert.ok(nonAnswer.trace.local?.verification.rejected.some(rejection => rejection.reason === "inconsistent_claim_response"));
  assert.ok(!nonAnswer.state.graph.records.some((row: { quote?: string }) => row.quote === text));
  for (const run of [missing, ack, nonAnswer]) {
    assert.equal(run.publication.status, "committed");
    assert.deepEqual(run.state.ledger, prior.saved.ledger);
  }
});
