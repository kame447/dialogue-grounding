import assert from "node:assert/strict";
import test from "node:test";
import type { LocalClaimView, LocalIssueView } from "../dialogue-model/runtime/local-grounding/contract.ts";
import { verifyLocalUpdate } from "../dialogue-model/runtime/local-grounding/verify.ts";
import { deriveLocalIssues, priorClaimViews } from "../dialogue-model/runtime/local-grounding/derive.ts";
import { deriveSharedConstruals, deriveSharedConstrualsFromGraph } from "../dialogue-model/runtime/local-grounding/shared-construal.ts";
import { applyReferenceUpdate, createReferenceGraph } from "../dialogue-model/runtime/memory/reference-graph.mjs";
import {
  allowsOrientationFallback, defaultGenerationRetryVersion, hasVersionedViewpoint, isGenerationV5,
  isGenerationV6, isGenerationV7, isGenerationV8, isGenerationV9, isGenerationV10, isGenerationV11,
  isGenerationV12, isGenerationV13, validAgreeNameScope, validGenerationRetryVersion,
} from "../dialogue-model/runtime/v2/generation-guard.ts";

const SLOTS = ["s-a", "s-b", "s-c", "s-d", "s-e", "s-f"];
const [A, B, C] = SLOTS;

function claim(turn: number, fields: Partial<LocalClaimView> = {}): LocalClaimView {
  const speaker = fields.speaker ?? "ai";
  return {
    id: `${turn}:claim`, turn, sourceTurn: turn, speaker, issueId: "1:reading", targets: [A],
    act: "construe", aspect: "construal", proposition: "風車のように見える", name: null,
    quote: "風車みたいですね。", respondsTo: null,
    source: speaker === "ai" ? "ai_hypothesis" : "partner_statement",
    ...fields,
  };
}

function agree(turn: number, reading: LocalClaimView, fields: Partial<LocalClaimView> = {}): LocalClaimView {
  return claim(turn, { act: "agree", respondsTo: reading.id, targets: [], proposition: "同じ見立てです",
    speaker: reading.speaker === "ai" ? "human" : "ai", ...fields });
}

const derive = (claims: LocalClaimView[], issues: LocalIssueView[] = []) =>
  deriveSharedConstruals(claims, issues, SLOTS);

function commitClaims(graph: ReturnType<typeof createReferenceGraph>, ...claims: LocalClaimView[]) {
  const { turn, speaker } = claims[0];
  const operations = claims.map(({ turn: _turn, ...fields }) => ({ kind: "claim", ...fields }));
  return applyReferenceUpdate(graph, { expectedRevision: graph.revision, turn, operations }, {
    generationSucceeded: true, publicTurns: [{ turn, speaker, text: claims.map(c => c.quote).join("") }],
  });
}

test("04b-1: either speaker can state the reading and receive the other's support", () => {
  const readings = [claim(1), claim(1, { speaker: "human", act: "assert" })];
  for (const reading of readings) {
    const support = agree(2, reading);
    assert.deepEqual(derive([reading, support]), [{
      id: `sc:${reading.id}`, claimIds: [reading.id, support.id], figureIds: [A],
      construal: reading.proposition, openDetails: [],
    }]);
  }
});

test("04b-1: only the other speaker's linked agree for a covered figure supplies support", () => {
  const reading = claim(1);
  for (const fields of [
    { act: "ask" },
    { act: "construe", proposition: "水車のように見える" },
    { act: "acknowledge" },
    { speaker: reading.speaker },
    { aspect: "part" },
    { respondsTo: null },
    { targets: [B] },
  ] satisfies Partial<LocalClaimView>[]) {
    assert.deepEqual(derive([reading, agree(2, reading, fields)]), [], JSON.stringify(fields));
  }
  const unbound = claim(1, { targets: [] });
  assert.deepEqual(derive([unbound, agree(2, unbound, { targets: [A] })]), []);
});

test("D1: a labelled answer to an ask does not establish a shared construal", () => {
  const question = claim(1, { act: "ask", quote: "風車のように見えますか？" });
  const answer = agree(2, question, { source: "partner_labelled_answer", targets: [A] });
  assert.deepEqual(derive([question, answer]), []);
});

test("04b-2: separate readings in the same issue retain their own figures", () => {
  const windmill = claim(1, { targets: [A, C] });
  const waterwheel = claim(3, { targets: [B], proposition: "水車のように見える" });
  const windmillSupport = agree(2, windmill, { targets: [A, B] });
  const waterwheelSupport = agree(4, waterwheel);
  assert.deepEqual(derive([windmill, windmillSupport, waterwheel, waterwheelSupport]), [
    { id: `sc:${waterwheel.id}`, claimIds: [waterwheel.id, waterwheelSupport.id], figureIds: [B],
      construal: waterwheel.proposition, openDetails: [] },
    { id: `sc:${windmill.id}`, claimIds: [windmill.id, windmillSupport.id], figureIds: [A],
      construal: windmill.proposition, openDetails: [] },
  ]);
});

test("04b-6: a long history keeps the proposition and the latest support per figure", () => {
  const reading = claim(1, { targets: SLOTS });
  const earlier = Array.from({ length: 40 }, (_, index) => agree(index + 2, reading, { targets: [A] }));
  const latest = SLOTS.map((id, index) => agree(index + 42, reading, { targets: [id] }));
  const common = agree(48, reading, { targets: [A, B] });
  const [fact, extra] = derive([reading, ...earlier, ...latest, common].reverse());
  assert.equal(extra, undefined);
  assert.deepEqual(fact.figureIds, SLOTS);
  assert.deepEqual(fact.claimIds, [reading.id, common.id, ...latest.slice(2).map(c => c.id)]);
});

test("every supported figure and its unresolved details survive derivation", () => {
  const readings = SLOTS.map((id, index) => claim(2 * index + 1, { targets: [id] }));
  const pairs = readings.flatMap(reading => [reading, agree(reading.turn + 1, reading)]);
  const details = Array.from({ length: 65 }, (_, index) => claim(index + 13, {
    issueId: `detail-${index}`, aspect: "part", act: "ask", proposition: `部品 ${index} の特徴`,
  }));
  const issues: LocalIssueView[] = details.map(detail => ({
    issueId: detail.issueId, aspect: detail.aspect, targets: [A], state: "unconfirmed",
    nameState: null, name: null, claimIds: [detail.id], lastTurn: detail.turn,
  }));
  const closed: LocalIssueView = { ...issues[0], issueId: "closed", state: "supported" };
  const facts = derive([...pairs, ...details], [...issues, closed]);
  assert.deepEqual(facts.map(fact => fact.figureIds), SLOTS.map(id => [id]).reverse());
  assert.deepEqual(facts.at(-1)?.openDetails, [...details].reverse().map(detail => ({
    issueId: detail.issueId, aspect: "part", proposition: detail.proposition, state: "unconfirmed",
  })));
  assert.ok(facts.slice(0, -1).every(fact => fact.openDetails.length === 0));
});

test("65 distinct readings retain all of their own evidence", () => {
  const pairs = Array.from({ length: 65 }, (_, index) => {
    const reading = claim(2 * index + 1);
    return [reading, agree(reading.turn + 1, reading)];
  });
  assert.deepEqual(derive(pairs.flat()).map(fact => fact.claimIds),
    pairs.map(pair => pair.map(entry => entry.id)).reverse());
});

test("withdrawal or denial of a reading or its support removes just that candidate", () => {
  const reading = claim(1);
  const support = agree(2, reading);
  const unrelated = claim(3, { targets: [B], proposition: "水車のように見える" });
  const unrelatedSupport = agree(4, unrelated);
  const live = [reading, support, unrelated, unrelatedSupport];
  assert.equal(derive(live).length, 2);
  for (const antecedent of [reading, support]) {
    for (const act of ["deny", "withdraw"] as const) {
      const speaker = act === "withdraw" ? antecedent.speaker : antecedent.speaker === "ai" ? "human" : "ai";
      const reversal = claim(5, { act, respondsTo: antecedent.id, speaker });
      assert.deepEqual(derive([...live, reversal]), derive([unrelated, unrelatedSupport]));
    }
  }
});

test("a verified denial of B's support leaves the original reading and support for A", () => {
  const reading = claim(1, { speaker: "human", targets: [A, B], proposition: "鳥のように見える", quote: "どちらも鳥みたいです。" });
  const supportA = agree(2, reading, { targets: [A], quote: "A は鳥に見えます。" });
  const supportB = agree(2, reading, { id: "2:other", targets: [B], quote: "B も鳥に見えます。" });
  const graph = commitClaims(commitClaims(createReferenceGraph({ slots: SLOTS }), reading), supportA, supportB);
  const candidates = (source: typeof graph) => deriveSharedConstruals(priorClaimViews(source), deriveLocalIssues(source), SLOTS);
  const [before] = candidates(graph);
  assert.deepEqual(before.figureIds, [A, B]);
  assert.deepEqual(before.claimIds, [reading.id, supportA.id, supportB.id]);

  const denyB = claim(3, { speaker: "human", act: "deny", targets: [B], respondsTo: supportB.id, quote: "B は鳥ではなさそうです。" });
  assert.deepEqual(candidates(commitClaims(graph, denyB)), [{
    ...before, figureIds: [A], claimIds: [reading.id, supportA.id],
  }]);
  const withdrawB = claim(3, { act: "withdraw", targets: [B], respondsTo: supportB.id, quote: "B を鳥とした見立ては撤回します。" });
  assert.deepEqual(candidates(commitClaims(graph, withdrawB)), [{
    ...before, figureIds: [A], claimIds: [reading.id, supportA.id],
  }]);
  const withdrawReading = claim(3, { speaker: "human", act: "withdraw", targets: [A, B], respondsTo: reading.id, quote: "鳥という見立ては撤回します。" });
  assert.deepEqual(candidates(commitClaims(graph, withdrawReading)), []);
});

test("partial withdrawal of a multi-figure support or reading keeps the same evidence for the other figure", () => {
  const reading = claim(1, { targets: [A, B] });
  const support = agree(2, reading, { targets: [A, B] });
  const graph = commitClaims(commitClaims(createReferenceGraph({ slots: SLOTS }), reading), support);
  const [original] = derive(priorClaimViews(graph));
  assert.deepEqual(original.figureIds, [A, B]);
  for (const antecedent of [support, reading]) {
    const withdraw = claim(3, { act: "withdraw", targets: [B], respondsTo: antecedent.id, speaker: antecedent.speaker });
    const partial = commitClaims(graph, withdraw);
    const { sharedConstruals, proofClaims } = deriveSharedConstrualsFromGraph(partial, SLOTS);
    assert.deepEqual(sharedConstruals, [{ ...original, figureIds: [A] }]);
    assert.deepEqual(proofClaims.map(claim => claim.id), original.claimIds);
    assert.deepEqual(proofClaims.find(claim => claim.id === antecedent.id)?.targets, [A]);
    assert.ok(!priorClaimViews(partial).some(claim => claim.id === antecedent.id));
    const whole = commitClaims(graph, { ...withdraw, targets: [A, B] });
    assert.deepEqual(deriveSharedConstrualsFromGraph(whole, SLOTS), { sharedConstruals: [], proofClaims: [] });
  }
});

test("a denial directed at the original reading applies to the figures it covers", () => {
  const reading = claim(1, { targets: [A, B] });
  const support = agree(2, reading, { targets: [A, B] });
  const denyB = claim(3, { speaker: "human", act: "deny", targets: [B], respondsTo: reading.id });
  const [candidate] = derive([reading, support, denyB]);
  assert.deepEqual(candidate?.figureIds, [A]);
  assert.deepEqual(candidate?.claimIds, [reading.id, support.id]);
  assert.deepEqual(derive([reading, support, { ...denyB, targets: [A, B] }]), []);
  const denySharedSupport = claim(3, { act: "deny", targets: [B], respondsTo: support.id });
  assert.deepEqual(derive([reading, support, denySharedSupport]), [candidate]);
});

test("v13 inherits the v12 rules and remains an explicit opt-in", () => {
  const v12 = "jev_generation_retry_v12";
  const v13 = "jev_generation_retry_v13";
  for (const inherits of [
    hasVersionedViewpoint, isGenerationV5, isGenerationV6, isGenerationV7, isGenerationV8,
    isGenerationV9, isGenerationV10, isGenerationV11, isGenerationV12,
  ]) {
    assert.equal(inherits(v12), true, inherits.name);
    assert.equal(inherits(v13), true, inherits.name);
  }
  assert.equal(isGenerationV13(v12), false);
  assert.equal(isGenerationV13(v13), true);
  assert.equal(validGenerationRetryVersion(v13, "two_stage_v3", "holistic_v5"), true);
  assert.equal(validGenerationRetryVersion(v13, "two_stage_v3", "holistic_v4"), false);
  assert.equal(validGenerationRetryVersion(v13, "two_stage_v1", "holistic_v5"), false);
  assert.equal(validAgreeNameScope("scoped_v6", v13), true);
  assert.equal(validAgreeNameScope("scoped_v5", v13), false);
  assert.equal(allowsOrientationFallback(v13), false);
  assert.equal(defaultGenerationRetryVersion("two_stage_v3", "holistic_v5"), v12);
});

test("partial withdrawal of a verified detail leaves it open only for the other figure", () => {
  const reading = claim(1, { speaker: "human", targets: [A, B] });
  const readingB = claim(1, { speaker: "human", id: "1:other", issueId: "1:other", targets: [B], proposition: "鳥にも見える" });
  const detail = claim(1, { speaker: "human", id: "1:tip", issueId: "1:tip", aspect: "part", act: "assert",
    targets: [A, B], quote: "先に切込みがある", proposition: "先に切込み" });
  const support = agree(2, reading, { targets: [A, B] });
  const supportB = agree(2, readingB, { id: "2:other", issueId: readingB.issueId, targets: [B] });
  const graph = commitClaims(commitClaims(createReferenceGraph({ slots: SLOTS }), reading, readingB, detail), support, supportB);
  const open = [{ issueId: detail.issueId, aspect: "part", proposition: detail.proposition, state: "unconfirmed" }];
  const candidates = (source: typeof graph) => deriveSharedConstrualsFromGraph(source, SLOTS).sharedConstruals;
  assert.deepEqual(candidates(graph).map(c => [c.figureIds, c.openDetails]), [[[A, B], open], [[B], open]]);
  const withdraw = (targets: string[]) => {
    const publicTurns = [{ turn: detail.sourceTurn, speaker: detail.speaker, text: detail.quote },
      { turn: 3, speaker: "human" as const, text: "切込みについての説明は撤回します。" }];
    const verified = verifyLocalUpdate({ graph, turn: 3, publicTurns, segments: [{
      segmentId: "withdraw", targets, aspect: "part", proposition: "切込みの説明の撤回",
      quote: publicTurns.at(-1)!.text, name: null, linkedIssueId: detail.issueId, respondsToTurn: 1,
    }], verdicts: [{ segmentId: "withdraw", act: "withdraw", respondsToClaimId: detail.id, rawScore: null }] });
    assert.deepEqual(verified.rejected, []);
    assert.deepEqual(verified.operations[0].targets, targets);
    return applyReferenceUpdate(graph, { expectedRevision: graph.revision, turn: 3, operations: verified.operations },
      { generationSucceeded: true, publicTurns });
  };
  const partial = withdraw([B]);
  assert.equal(deriveLocalIssues(partial).find(issue => issue.issueId === detail.issueId)?.state, "withdrawn");
  assert.deepEqual(candidates(partial).map(c => [c.figureIds, c.openDetails]), [[[A, B], open], [[B], []]]);
  assert.deepEqual(candidates(withdraw([A, B])).map(c => c.openDetails), [[], []]);
});
