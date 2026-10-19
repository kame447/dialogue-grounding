import test from "node:test";
import assert from "node:assert/strict";
import { deriveLocalIssues, summarizeLocalIssues, priorClaimViews } from "../dialogue-model/runtime/local-grounding/derive.ts";
import { createReferenceGraph, applyReferenceUpdate } from "../dialogue-model/runtime/memory/reference-graph.mjs";
import { SLOTS } from "../dialogue-model/runtime/stimuli/board.mjs";
import type { LocalClaimFields, PublicTurn } from "../dialogue-model/runtime/local-grounding/contract.ts";

const [A, B] = SLOTS;
const claim = (turn: number, extra: Partial<LocalClaimFields & { id: string }> = {}) => ({ kind: "claim" as const, id: `${turn}:c`, issueId: `${turn}:c`, targets: [A], aspect: "part" as const,
  act: "assert" as const, proposition: "四角がある", name: null, speaker: "ai" as const, sourceTurn: turn, quote: "四角がある", respondsTo: null, source: "ai_hypothesis" as const, ...extra });
function apply(graph: ReturnType<typeof createReferenceGraph>, turn: number, operations: ReturnType<typeof claim>[]) {
  const turns = new Map<string, PublicTurn>();
  for (const c of operations) {
    const key = `${c.sourceTurn}:${c.speaker}`;
    turns.set(key, { turn: c.sourceTurn, speaker: c.speaker, text: (turns.get(key)?.text ?? "") + c.quote });
  }
  return applyReferenceUpdate(graph, { expectedRevision: graph.revision, turn, operations }, { generationSucceeded: true, publicTurns: [...turns.values()] });
}
const proposal = (turn: number, extra: Partial<LocalClaimFields & { id: string }> = {}) => claim(turn, { aspect: "name", act: "name_propose", name: "船", quote: "船と呼ぼう", ...extra });
const human = { speaker: "human" as const, source: "partner_statement" as const };

test("AI hypotheses stay unconfirmed; support, denial and independent issues derive separately", () => {
  let graph = apply(createReferenceGraph(), 1, [claim(1), claim(1, { id: "1:other", issueId: "1:other", aspect: "orientation", targets: [B] })]);
  assert.deepEqual(deriveLocalIssues(graph).map(i => i.state), ["unconfirmed", "unconfirmed"]);
  graph = apply(graph, 2, [claim(2, { ...human, act: "agree", issueId: "1:c", respondsTo: "1:c" })]);
  graph = apply(graph, 3, [claim(3, { ...human, act: "deny", issueId: "1:c", respondsTo: "1:c" })]);
  assert.deepEqual(deriveLocalIssues(graph).map(i => i.state), ["contested", "unconfirmed"]);
});

test("defer persists until revisit and neither step invents agreement", () => {
  let graph = apply(createReferenceGraph(), 1, [claim(1)]);
  graph = apply(graph, 2, [claim(2, { ...human, act: "defer", issueId: "1:c" })]);
  assert.equal(deriveLocalIssues(graph)[0].state, "deferred");
  graph = apply(graph, 3, [claim(3, { ...human, act: "revisit", issueId: "1:c" })]);
  assert.equal(deriveLocalIssues(graph)[0].state, "unconfirmed");
});

test("names require a verified opposite-speaker acceptance, with reject/withdraw/rename overturning it", () => {
  const proposed = apply(createReferenceGraph(), 1, [proposal(1)]);
  assert.equal(deriveLocalIssues(proposed)[0].nameState, "unclear");
  const accepted = apply(proposed, 2, [proposal(2, { ...human, act: "name_accept", issueId: "1:c", respondsTo: "1:c", quote: "船でいいです" })]);
  assert.equal(deriveLocalIssues(accepted)[0].nameState, "agreed");
  const rejected = apply(accepted, 3, [proposal(3, { ...human, act: "name_reject", issueId: "1:c", respondsTo: "1:c", quote: "船という名前はやめたい" })]);
  assert.equal(deriveLocalIssues(rejected)[0].nameState, "not_agreed");
  const withdrawn = apply(accepted, 3, [proposal(3, { act: "withdraw", issueId: "1:c", respondsTo: "1:c", quote: "船という提案を撤回" })]);
  assert.notEqual(deriveLocalIssues(withdrawn)[0].nameState, "agreed");
  assert.equal(deriveLocalIssues(withdrawn)[0].state, "withdrawn");
  const renamed = apply(accepted, 3, [proposal(3, { ...human, name: "鳥", quote: "鳥と呼ぼう" })]);
  assert.deepEqual(deriveLocalIssues(renamed).map(i => i.nameState), ["not_agreed", "unclear"]);
  const other = apply(accepted, 3, [proposal(3, { ...human, name: "鳥", quote: "鳥と呼ぼう", targets: [B] })]);
  assert.equal(deriveLocalIssues(other)[0].nameState, "agreed");
});

test("multiple and unresolved targets remain unclear even with partner acceptance", () => {
  let graph = apply(createReferenceGraph(), 1, [proposal(1, { targets: [A, B] })]);
  graph = apply(graph, 2, [proposal(2, { ...human, targets: [A, B], act: "name_accept", issueId: "1:c", respondsTo: "1:c", quote: "船でいいです" })]);
  assert.equal(deriveLocalIssues(graph)[0].nameState, "unclear");
  assert.deepEqual(deriveLocalIssues(graph)[0].targets, [A, B]);
  const unresolved = apply(createReferenceGraph(), 1, [proposal(1, { targets: [] })]);
  assert.equal(deriveLocalIssues(unresolved)[0].nameState, "unclear");
});

test("construal cannot create any name state and a name question has no_name", () => {
  const graph = apply(createReferenceGraph(), 1, [claim(1, { ...human, aspect: "construal", act: "construe", quote: "船っぽい" }),
    claim(1, { id: "1:ask", issueId: "1:ask", aspect: "name", act: "ask", quote: "何と呼ぼう" })]);
  assert.deepEqual(deriveLocalIssues(graph).map(i => i.nameState), [null, "no_name"]);
});

test("withdrawal removes responses from classifier candidates and cannot resurrect an earlier proposal", () => {
  let graph = apply(createReferenceGraph(), 1, [proposal(1)]);
  graph = apply(graph, 2, [proposal(2, { ...human, act: "name_accept", issueId: "1:c", respondsTo: "1:c" })]);
  graph = apply(graph, 3, [proposal(3, { act: "withdraw", issueId: "1:c", respondsTo: "1:c" })]);
  assert.deepEqual(priorClaimViews(graph).map(c => c.id), ["3:c"]);
  assert.equal(deriveLocalIssues(graph)[0].nameState, "unknown");
});

test("delayed insertion uses public-source chronology rather than insertion order", () => {
  const graph = apply(createReferenceGraph(), 3, [proposal(3, { id: "3:accept", ...human, act: "name_accept", issueId: "3:proposal", respondsTo: "3:proposal", sourceTurn: 2 }),
    proposal(3, { id: "3:proposal", issueId: "3:proposal", sourceTurn: 1 })]);
  assert.equal(deriveLocalIssues(graph)[0].nameState, "agreed");
});

test("private summaries and candidate views are deterministic, bounded detached copies", () => {
  let graph = apply(createReferenceGraph(), 1, [proposal(1)]);
  graph = apply(graph, 2, [claim(2, { targets: [B] })]);
  const before = JSON.stringify(graph);
  const summary = summarizeLocalIssues(graph), restored = JSON.parse(JSON.stringify(graph));
  assert.equal(summary, summarizeLocalIssues(restored)); assert.equal(summary, summarizeLocalIssues(graph));
  const bounded = JSON.parse(summarizeLocalIssues(graph, { maxChars: 100 }));
  assert.equal(bounded.omitted, 2); assert.equal(bounded.issues.length, 0);
  const views = priorClaimViews(graph, { limit: 1 }); views[0].targets[0] = "changed";
  assert.equal(JSON.stringify(graph), before); assert.deepEqual(priorClaimViews(graph, { limit: 0 }), []);
  assert.equal(Object.hasOwn(priorClaimViews(graph)[0], "kind"), false);
  assert.throws(() => summarizeLocalIssues(graph, { maxChars: 1 }), /summary_budget_too_small/);
  assert.throws(() => priorClaimViews(graph, { limit: -1 }), /invalid_claim_limit/);
});
