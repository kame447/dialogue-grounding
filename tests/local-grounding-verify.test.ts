import test from "node:test";
import assert from "node:assert/strict";
import { verifyLocalUpdate, recordAiClaims } from "../dialogue-model/runtime/local-grounding/verify.ts";
import { deriveLocalIssues } from "../dialogue-model/runtime/local-grounding/derive.ts";
import type { LocalClaimFields, LocalSegmentProposal, LocalFunctionVerdict, PublicTurn } from "../dialogue-model/runtime/local-grounding/contract.ts";
import { createReferenceGraph, applyReferenceUpdate } from "../dialogue-model/runtime/memory/reference-graph.mjs";
import { SLOTS } from "../dialogue-model/runtime/stimuli/board.mjs";

const [A, B] = SLOTS;
const segment = (extra: Partial<LocalSegmentProposal> = {}): LocalSegmentProposal => ({ segmentId: "s1", quote: "四角は合ってる", targets: [A], aspect: "part",
  proposition: "四角がある", name: null, linkedIssueId: null, respondsToTurn: null, ...extra });
const verdict = (extra: Partial<LocalFunctionVerdict> = {}): LocalFunctionVerdict => ({ segmentId: "s1", act: "assert", respondsToClaimId: null, rawScore: null, ...extra });
const claim = (turn: number, extra: Partial<LocalClaimFields & { id: string }> = {}) => ({ kind: "claim" as const, id: `${turn}:ai1`, issueId: `${turn}:ai1`, targets: [A],
  aspect: "part" as const, act: "assert" as const, proposition: "四角がある", name: null, speaker: "ai" as const, sourceTurn: turn, quote: "四角がある", respondsTo: null, source: "ai_hypothesis" as const, ...extra });
function commit(graph: ReturnType<typeof createReferenceGraph>, turn: number, operations: ReturnType<typeof claim>[], publicTurns?: PublicTurn[]) {
  const grouped = new Map<string, PublicTurn>();
  for (const c of operations) {
    const key = `${c.sourceTurn}:${c.speaker}`;
    grouped.set(key, { turn: c.sourceTurn, speaker: c.speaker, text: (grouped.get(key)?.text ?? "") + c.quote });
  }
  return applyReferenceUpdate(graph, { expectedRevision: graph.revision, turn, operations }, { generationSucceeded: true, publicTurns: publicTurns ?? [...grouped.values()] });
}

test("one composite utterance agrees with a local feature and denies a different proposition", () => {
  let graph = commit(createReferenceGraph(), 1, [claim(1), claim(1, { id: "1:ai2", issueId: "1:ai2", aspect: "position", quote: "三角は上", proposition: "三角は上" })]);
  const publicTurns: PublicTurn[] = [{ turn: 1, speaker: "ai", text: "四角がある、三角は上" }, { turn: 2, speaker: "human", text: "四角は合ってるけど三角は上じゃない" }];
  const result = verifyLocalUpdate({ graph, turn: 2, publicTurns,
    segments: [segment(), segment({ segmentId: "s2", quote: "三角は上じゃない", aspect: "position", proposition: "三角は上ではない" })],
    verdicts: [verdict({ act: "agree", respondsToClaimId: "1:ai1" }), verdict({ segmentId: "s2", act: "deny", respondsToClaimId: "1:ai2" })] });
  assert.equal(result.operations.length, 2); assert.deepEqual(result.rejected, []);
  graph = commit(graph, 2, result.operations, publicTurns);
  assert.deepEqual(deriveLocalIssues(graph).map(i => [i.aspect, i.state]), [["part", "supported"], ["position", "denied"]]);
});

test("a rejected segment never cancels another valid segment and raw score cannot promote unknown", () => {
  const result = verifyLocalUpdate({ graph: createReferenceGraph(), turn: 1,
    publicTurns: [{ turn: 1, speaker: "human", text: "四角は合ってる" }],
    segments: [segment(), segment({ segmentId: "s2", quote: "公開されていない" }), segment({ segmentId: "s3" })],
    verdicts: [verdict(), verdict({ segmentId: "s2" }), verdict({ segmentId: "s3", act: "unknown", rawScore: 100 })] });
  assert.equal(result.operations.length, 1); assert.equal(result.rejected.length, 2);
  assert.equal(result.operations[0].source, "partner_statement"); assert.equal(result.operations[0].id, "1:local1");
});

test("quote is relocated to the original public span and never comes from AI or an earlier human turn", () => {
  const input = { graph: createReferenceGraph(), turn: 2, publicTurns: [{ turn: 1, speaker: "human" as const, text: "四角は合ってる" },
    { turn: 2, speaker: "human" as const, text: "しかくは合ってる" }], segments: [segment()], verdicts: [verdict()] };
  assert.equal(verifyLocalUpdate(input).operations.length, 0);
  const normalized = verifyLocalUpdate({ ...input, segments: [segment({ quote: "シカクは合ってる" })] });
  assert.equal(normalized.operations[0].quote, "しかくは合ってる");
  assert.equal(verifyLocalUpdate({ ...input, publicTurns: [{ turn: 2, speaker: "ai", text: "四角は合ってる" }] }).operations.length, 0);
});

test("name responses require the partner proposal on the SAME candidate slots and aspect", () => {
  const graph = commit(createReferenceGraph(), 1, [claim(1, { aspect: "name", act: "name_propose", name: "船", quote: "この図形を船と呼ぼう" })]);
  const run = (targets: string[], aspect: LocalSegmentProposal["aspect"] = "name") => verifyLocalUpdate({ graph, turn: 2,
    publicTurns: [{ turn: 2, speaker: "human", text: "船でいいです" }],
    segments: [segment({ quote: "船でいいです", aspect, targets, name: aspect === "name" ? "船" : null })],
    verdicts: [verdict({ act: "name_accept", respondsToClaimId: "1:ai1" })] });
  assert.equal(run([B]).operations.length, 0); assert.equal(run([A, B]).operations.length, 0); assert.equal(run([A], "part").operations.length, 0);
  const accepted = run([A]); assert.equal(accepted.operations.length, 1); assert.equal(accepted.operations[0].issueId, "1:ai1");
});

test("bare acknowledgments bind ONLY an explicit previous primary, never a secondary or missing pointer", () => {
  const ai: PublicTurn = { turn: 1, speaker: "ai", text: "この図形を船と呼ぼう、四角がある" };
  const ops = recordAiClaims({ graph: createReferenceGraph(), turn: 2, publicTurns: [ai], priorAct: { turn: 1, action: "propose_name", targetSlot: A, candidateName: "船", discriminatingFeature: "四角がある" } }).operations;
  const graph = commit(createReferenceGraph(), 2, ops, [ai]);
  const run = (id: string | null, aspect: "name" | "part" = "name", name: string | null = null) => verifyLocalUpdate({ graph, turn: 3,
    publicTurns: [ai, { turn: 3, speaker: "human", text: "うん" }], segments: [segment({ quote: "うん", aspect, name })],
    verdicts: [verdict({ act: aspect === "name" ? "name_accept" : "agree", respondsToClaimId: id })] });
  assert.equal(run("2:ai1").operations[0].act, "name_accept");
  for (const result of [run(null), run("2:ai2", "part")]) {
    assert.equal(result.operations[0].act, "acknowledge"); assert.deepEqual(result.operations[0].targets, []); assert.equal(result.operations[0].respondsTo, null);
  }
  assert.equal(run("2:missing").operations.length, 0);
});

test("multiple primary candidates and intervening human turns cannot create agreement from a bare token", () => {
  let graph = commit(createReferenceGraph(), 2, [claim(2, { sourceTurn: 1 }), claim(2, { id: "2:other", issueId: "2:other", targets: [B], sourceTurn: 1 })]);
  // Different insertion turns can both expose ai1 for the same public AI source.
  graph = commit(graph, 3, [claim(3, { sourceTurn: 1, targets: [B] })]);
  const input = { graph, turn: 4, publicTurns: [{ turn: 1, speaker: "ai" as const, text: "四角がある" }, { turn: 4, speaker: "human" as const, text: "はい" }],
    segments: [segment({ quote: "はい" })], verdicts: [verdict({ act: "agree", respondsToClaimId: "2:ai1" })] };
  assert.equal(verifyLocalUpdate(input).operations[0].act, "acknowledge");
  const noPreviousAi = { ...input, publicTurns: [input.publicTurns[0], { turn: 3, speaker: "human" as const, text: "別の話" }, input.publicTurns[1]] };
  assert.equal(verifyLocalUpdate(noPreviousAi).operations[0].act, "acknowledge");
});

test("construal and naming stay separate, and a proposed name must be literal in its segment", () => {
  const result = verifyLocalUpdate({ graph: createReferenceGraph(), turn: 1,
    publicTurns: [{ turn: 1, speaker: "human", text: "船っぽい。この図形を『船』と呼ぼう" }],
    segments: [segment({ quote: "船っぽい", aspect: "construal", proposition: "船に見える" }),
      segment({ segmentId: "s2", quote: "この図形を『船』と呼ぼう", aspect: "name", proposition: "船と命名", name: "船" })],
    verdicts: [verdict({ act: "construe" }), verdict({ segmentId: "s2", act: "name_propose" })] });
  assert.deepEqual(result.operations.map(c => [c.aspect, c.act, c.name]), [["construal", "construe", null], ["name", "name_propose", "船"]]);
  const forged = verifyLocalUpdate({ graph: createReferenceGraph(), turn: 1, publicTurns: [{ turn: 1, speaker: "human", text: "形を相談しよう" }],
    segments: [segment({ quote: "形を相談しよう", aspect: "name", name: "船" })], verdicts: [verdict({ act: "name_propose" })] });
  assert.equal(forged.operations.length, 0);
});

test("wrong speaker, wrong issue, missing IDs and duplicate model-local IDs are rejected", () => {
  const graph = commit(createReferenceGraph(), 1, [claim(1)]);
  const run = (seg: Partial<LocalSegmentProposal>, v: Partial<LocalFunctionVerdict>) => verifyLocalUpdate({ graph, turn: 2,
    publicTurns: [{ turn: 2, speaker: "human", text: "四角は合ってる" }], segments: [segment(seg)], verdicts: [verdict(v)] });
  assert.equal(run({}, { act: "withdraw", respondsToClaimId: "1:ai1" }).operations.length, 0);
  assert.equal(run({ linkedIssueId: "1:missing" }, {}).operations.length, 0);
  assert.equal(run({}, { act: "agree" }).operations.length, 0);
  const repeated = verifyLocalUpdate({ graph, turn: 2, publicTurns: [{ turn: 2, speaker: "human", text: "四角は合ってる" }],
    segments: [segment(), segment()], verdicts: [verdict()] });
  assert.equal(repeated.operations.length, 0); assert.equal(repeated.rejected.length, 2);
});

test("recordAiClaims uses public committed literal elements, preserves fixed part aspect and deduplicates", () => {
  const initial = createReferenceGraph();
  const priorAct = { turn: 1, action: "propose_name", targetSlot: A, candidateName: "船", discriminatingFeature: "四角がある" };
  const publicTurns: PublicTurn[] = [{ turn: 1, speaker: "ai", text: "四角があるので船と呼ぼう" }];
  assert.equal(recordAiClaims({ graph: initial, turn: 2, publicTurns: [], priorAct }).operations.length, 0);
  const result = recordAiClaims({ graph: initial, turn: 2, publicTurns, priorAct });
  assert.deepEqual(result.operations.map(c => [c.id, c.aspect, c.act, c.sourceTurn, c.source]), [
    ["2:ai1", "name", "name_propose", 1, "ai_hypothesis"], ["2:ai2", "part", "assert", 1, "ai_hypothesis"],
  ]);
  const graph = commit(initial, 2, result.operations, publicTurns);
  assert.equal(recordAiClaims({ graph, turn: 3, publicTurns, priorAct }).operations.length, 0);
  const absent = recordAiClaims({ graph: initial, turn: 2, publicTurns: [{ turn: 1, speaker: "ai", text: "四角がある" }], priorAct });
  assert.deepEqual(absent.operations.map(c => c.id), ["2:ai2"]);
  assert.equal(deriveLocalIssues(graph).find(i => i.aspect === "name")!.nameState, "unclear");
  const followUp = recordAiClaims({ graph: initial, turn: 2, publicTurns, priorAct: {
    turn: 1, action: "accept", targetSlot: null, candidateName: null, discriminatingFeature: null,
    followUp: { action: "propose_name", targetSlot: A, candidateName: "船", discriminatingFeature: null },
  } });
  assert.deepEqual(followUp.operations.map(c => c.id), ["2:ai2"]);
});

test("name rejection and self withdrawal are verified without inventing partner agreement", () => {
  const aiProposal = commit(createReferenceGraph(), 1, [claim(1, { aspect: "name", act: "name_propose", name: "船", quote: "船と呼ぼう" })]);
  const rejected = verifyLocalUpdate({ graph: aiProposal, turn: 2, publicTurns: [{ turn: 2, speaker: "human", text: "船という名前はやめたい" }],
    segments: [segment({ aspect: "name", name: "船", quote: "船という名前はやめたい" })], verdicts: [verdict({ act: "name_reject", respondsToClaimId: "1:ai1" })] });
  assert.equal(rejected.operations[0].act, "name_reject");
  assert.equal(deriveLocalIssues(commit(aiProposal, 2, rejected.operations))[0].nameState, "not_agreed");
  const own = commit(createReferenceGraph(), 1, [claim(1, { speaker: "human", source: "partner_statement" })]);
  const withdrawn = verifyLocalUpdate({ graph: own, turn: 2, publicTurns: [{ turn: 2, speaker: "human", text: "前の説明を撤回します" }],
    segments: [segment({ quote: "前の説明を撤回します" })], verdicts: [verdict({ act: "withdraw", respondsToClaimId: "1:ai1" })] });
  assert.equal(withdrawn.operations[0].act, "withdraw");
  assert.equal(deriveLocalIssues(commit(own, 2, withdrawn.operations))[0].state, "withdrawn");
});

test("verified defer/revisit keeps a stable program-owned issue ID and rejects an unestablished revisit", () => {
  let graph = commit(createReferenceGraph(), 1, [claim(1)]);
  const run = (turn: number, act: "defer" | "revisit", quote: string) => verifyLocalUpdate({ graph, turn,
    publicTurns: [{ turn, speaker: "human", text: quote }], segments: [segment({ quote, linkedIssueId: "1:ai1" })], verdicts: [verdict({ act })] });
  assert.equal(run(2, "revisit", "戻ろう").operations.length, 0);
  const deferred = run(2, "defer", "この部分はあとで"); graph = commit(graph, 2, deferred.operations);
  assert.equal(deriveLocalIssues(graph)[0].state, "deferred");
  const revisited = run(3, "revisit", "この部分に戻ろう"); graph = commit(graph, 3, revisited.operations);
  assert.equal(revisited.operations[0].issueId, "1:ai1"); assert.equal(deriveLocalIssues(graph)[0].state, "unconfirmed");
});

test("a public confirm with a name is a naming proposal that a primary bare acceptance can adopt", () => {
  const initial = createReferenceGraph();
  const publicTurns: PublicTurn[] = [{ turn: 1, speaker: "ai", text: "『鳥』でいい？" }, { turn: 2, speaker: "human", text: "はい" }];
  const ai = recordAiClaims({ graph: initial, turn: 2, publicTurns, priorAct: {
    turn: 1, action: "confirm", targetSlot: A, candidateName: "鳥", discriminatingFeature: null,
  } });
  assert.equal(ai.operations[0].act, "name_propose"); assert.equal(ai.operations[0].name, "鳥");
  const preview = { ...initial, lastTurn: 2, records: ai.operations.map(op => ({ ...op, turn: 2 })) };
  const humanResult = verifyLocalUpdate({ graph: preview, turn: 2, publicTurns,
    segments: [segment({ aspect: "name", quote: "はい", name: null })],
    verdicts: [verdict({ act: "name_accept", respondsToClaimId: "2:ai1" })] });
  assert.equal(humanResult.operations[0].act, "name_accept");
  const graph = commit(initial, 2, [...ai.operations, ...humanResult.operations], publicTurns);
  assert.equal(deriveLocalIssues(graph)[0].nameState, "agreed");
});

test("a public AI agree accepts only the latest matching public human naming proposal", () => {
  const humanProposal = (turn: number, extra: Partial<LocalClaimFields & { id: string }> = {}) => claim(turn, {
    speaker: "human", source: "partner_statement", aspect: "name", act: "name_propose", name: "鳥", quote: "鳥と呼ぼう", ...extra,
  });
  let graph = commit(createReferenceGraph(), 1, [humanProposal(1)]);
  graph = commit(graph, 2, [humanProposal(2)]);
  const publicTurns: PublicTurn[] = [{ turn: 1, speaker: "human", text: "鳥と呼ぼう" }, { turn: 2, speaker: "human", text: "鳥と呼ぼう" },
    { turn: 3, speaker: "ai", text: "鳥でいいですね" }];
  const priorAct = { turn: 3, action: "agree", targetSlot: A, candidateName: "鳥", discriminatingFeature: null };
  const run = (overrides: Partial<typeof priorAct> = {}, turns = publicTurns, sourceGraph = graph) => recordAiClaims({
    graph: sourceGraph, turn: 4, publicTurns: turns, priorAct: { ...priorAct, ...overrides },
  });
  const accepted = run();
  assert.deepEqual(accepted.operations.map(c => [c.id, c.act, c.respondsTo, c.issueId]), [["4:ai1", "name_accept", "2:ai1", "2:ai1"]]);
  assert.equal(deriveLocalIssues(commit(graph, 4, accepted.operations, publicTurns)).find(i => i.issueId === "2:ai1")!.nameState, "agreed");
  assert.equal(run({ targetSlot: B }).operations.length, 0);
  assert.equal(run({ candidateName: "船" }).operations.length, 0);
  assert.equal(run({}, publicTurns, createReferenceGraph()).operations.length, 0);
  assert.equal(run({}, publicTurns.filter(t => t.speaker === "ai")).operations.length, 0);
  assert.equal(run({}, publicTurns.filter(t => t.turn !== 2)).operations.length, 0);
  const construal = commit(createReferenceGraph(), 1, [claim(1, { speaker: "human", source: "partner_statement", aspect: "construal", act: "construe", quote: "鳥っぽい" })]);
  assert.equal(run({}, [{ turn: 1, speaker: "human", text: "鳥っぽい" }, publicTurns[2]], construal).operations.length, 0);
  const withdrawn = commit(graph, 3, [humanProposal(3, { act: "withdraw", respondsTo: "2:ai1", issueId: "2:ai1" }),
    humanProposal(3, { id: "3:other", act: "withdraw", respondsTo: "1:ai1", issueId: "1:ai1" })]);
  assert.equal(run({}, publicTurns, withdrawn).operations.length, 0);
});
