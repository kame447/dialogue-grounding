import test from "node:test";
import assert from "node:assert/strict";
import { SLOTS } from "../dialogue-model/runtime/stimuli/board.mjs";
import {
  createReferenceGraph, validateReferenceUpdate, applyReferenceUpdate,
  snapshotReferenceGraph, summarizeForJudge, REFERENCE_LIMITS, ReferenceGraphError,
} from "../dialogue-model/runtime/memory/reference-graph.mjs";

const [A, B, C] = SLOTS;
const mention = (turn, local = "m", extra = {}) => ({ kind: "mention", id: `${turn}:${local}`, sourceTurn: turn,
  speaker: "human", quote: "細長い図形", slots: [A], confidence: 0.8, epistemic: "grounded",
  intent: "refer", antecedent: null, ...extra });
const name = (turn, extra = {}) => ({ kind: "name", id: `${turn}:name`, slot: A, name: "鳥",
  agreement: "none", mentionIds: [`${turn}:m`], replaces: null, ...extra });
const feature = (turn, extra = {}) => ({ kind: "feature", id: `${turn}:feature`, slot: A,
  feature: "細長い", polarity: "confirmed", mentionId: `${turn}:m`, ...extra });
const question = (turn, extra = {}) => ({ kind: "question", id: `${turn}:q`, slots: [A, B],
  text: "尖りは二つありますか？", status: "open", mentionIds: [`${turn}:m`], replaces: null, ...extra });
const update = (graph, turn, operations) => ({ expectedRevision: graph.revision, turn, operations });
const publicTurnsFor = (ops) => {
  const turns = new Map();
  for (const op of ops.filter((op) => op.kind === "mention")) {
    const key = `${op.sourceTurn}:${op.speaker}`, previous = turns.get(key);
    turns.set(key, { turn: op.sourceTurn, speaker: op.speaker, text: (previous?.text ?? "") + op.quote });
  }
  return [...turns.values()];
};
function apply(graph, turn, operations, options = {}) {
  return applyReferenceUpdate(graph, update(graph, turn, operations), {
    generationSucceeded: true, publicTurns: publicTurnsFor(operations), ...options,
  });
}
const view = (graph, slot = A) => snapshotReferenceGraph(graph).ownSlots[slot];
const throws = (fn, code) => assert.throws(fn, (error) => error instanceof ReferenceGraphError && error.code === code);
function proposed() {
  return apply(createReferenceGraph(), 1, [mention(1, "m", { speaker: "ai", quote: "鳥にしませんか", intent: "name_proposal" }), name(1)]);
}

test("own-image observations stay immutable and separate from human-reference interpretations", () => {
  const input = [{ slot: A, feature: "細長い" }];
  const graph = createReferenceGraph({ ownObservations: input });
  input[0].feature = "変更";
  assert.deepEqual(view(graph).ownObservations, [{ feature: "細長い", source: "own_image" }]);
  const next = apply(graph, 1, [mention(1)]);
  assert.equal(snapshotReferenceGraph(next).mentions[0].scope, "human_reference_interpretation");
  assert.equal(next.records.length, 1); assert.equal(graph.records.length, 0);
  assert.ok(Object.isFrozen(next.records[0]));
  assert.throws(() => { next.records[0].slots[0] = B; }, TypeError);
  const snapshot = snapshotReferenceGraph(next); snapshot.ownSlots[A].ownObservations[0].feature = "別";
  assert.equal(view(next).ownObservations[0].feature, "細長い");
});

test("zero-target and two-slot referents retain uncertainty without choosing a target", () => {
  const graph = apply(createReferenceGraph(), 1, [
    mention(1, "none", { quote: "それ", slots: [], confidence: 0, epistemic: "unresolved" }),
    mention(1, "two", { slots: [A, B], confidence: 0.45, epistemic: "hypothesis" }),
    question(1, { mentionIds: ["1:two"] }),
  ]);
  const snapshot = snapshotReferenceGraph(graph);
  assert.deepEqual(snapshot.mentions.map((m) => m.slots), [[], [A, B]]);
  assert.equal(snapshot.questions.length, 1);
  assert.ok(SLOTS.every((slot) => snapshot.ownSlots[slot].status === "unassigned"));
});

test("candidate names can be ambiguous, but uncertain targets cannot establish agreement", () => {
  const ops = [mention(1, "m", { quote: "鳥でいいです", slots: [A, B], epistemic: "hypothesis", intent: "name_acceptance" }), name(1)];
  const graph = apply(createReferenceGraph(), 1, ops);
  assert.equal(view(graph).status, "tentative"); assert.equal(view(graph, B).candidate, null);
  throws(() => apply(createReferenceGraph(), 1, [ops[0], { ...ops[1], agreement: "explicit" }]), "unsupported_agreement");
  throws(() => apply(createReferenceGraph(), 1, [ops[0], { ...ops[1], slot: C }]), "wrong_slot");
});

test("bare deictics and acknowledgments cannot ground a slot without grounded antecedent evidence", () => {
  for (const quote of ["それ", "はい", "うん", "yes!", "ok"]) {
    throws(() => apply(createReferenceGraph(), 1, [mention(1, "m", { quote })]), "ungrounded_deictic");
  }
  const graph = apply(createReferenceGraph(), 1, [mention(1, "m", { slots: [A, B], epistemic: "hypothesis" })]);
  throws(() => apply(graph, 2, [mention(2, "m", { quote: "それ", antecedent: "1:m" })]), "ungrounded_deictic");
  throws(() => apply(graph, 2, [mention(2, "m", { slots: [C], antecedent: "1:m" })]), "inconsistent_antecedent");
  throws(() => apply(graph, 2, [mention(2, "m", { quote: "", slots: [], epistemic: "unresolved", confidence: 0 })],
    { publicTurns: [{ turn: 2, speaker: "human", text: "公開発話" }] }), "invalid_mention");
});

test("yes to a feature confirms only that attributed feature, never the candidate name", () => {
  let graph = proposed();
  graph = apply(graph, 2, [mention(2, "m", { speaker: "ai", quote: "細長いですか", intent: "feature_assertion" }), feature(2)]);
  const ops = [mention(3, "m", { quote: "はい", intent: "feature_acceptance", antecedent: "2:m" }), feature(3)];
  const next = apply(graph, 3, ops);
  assert.equal(view(next).status, "tentative");
  assert.deepEqual(view(next).features.map((f) => [f.speaker, f.polarity, f.sourceTurn]), [["ai", "confirmed", 2], ["human", "confirmed", 3]]);
  throws(() => apply(graph, 3, [...ops, name(3, { agreement: "explicit", replaces: "1:name" })]), "unsupported_name");
  throws(() => apply(graph, 3, [ops[0], feature(3, { polarity: "denied" })]), "unsupported_feature");
});

test("implicit acceptance stays tentative; explicit named acceptance agrees", () => {
  const graph = proposed();
  const implicit = apply(graph, 2, [mention(2, "m", { quote: "鳥の話を続けましょう", intent: "name_proposal" }),
    name(2, { agreement: "implicit", replaces: "1:name" })]);
  assert.equal(view(implicit).status, "tentative");
  const explicit = apply(implicit, 3, [mention(3, "m", { quote: "鳥で合意します", intent: "name_acceptance" }),
    name(3, { agreement: "explicit", replaces: "2:name" })]);
  assert.equal(view(explicit).status, "agreed");
  assert.equal(view(explicit, B).candidate, null);
});

test("yes to a grounded naming proposal has an antecedent and can explicitly agree", () => {
  const graph = proposed();
  const next = apply(graph, 2, [mention(2, "m", { quote: "はい", intent: "name_acceptance", antecedent: "1:m" }),
    name(2, { agreement: "explicit", replaces: "1:name" })]);
  assert.equal(view(next).status, "agreed");
  assert.deepEqual(view(next).candidate.sourceTurns, [1, 2]);
  const aiOnly = [mention(2, "m", { quote: "鳥で決定", speaker: "ai", intent: "name_acceptance" }),
    name(2, { agreement: "explicit", replaces: "1:name" })];
  throws(() => apply(graph, 2, aiOnly), "unsupported_agreement");
});

test("named rename preserves provenance and does not change another slot", () => {
  const graph = proposed();
  const ops = [mention(2, "m", { quote: "鳥ではなく白鳥と呼びましょう", intent: "correction" }),
    name(2, { name: "白鳥", replaces: "1:name" })];
  const next = apply(graph, 2, ops);
  assert.equal(view(next).candidate.name, "白鳥"); assert.equal(view(next).status, "tentative");
  assert.equal(view(next, B).candidate, null); assert.equal(view(graph).candidate.name, "鳥");
  assert.equal(snapshotReferenceGraph(next).repairs.find((r) => r.id === "2:name").replaces, "1:name");
  throws(() => apply(graph, 2, [ops[0], { ...ops[1], replaces: null }]), "replacement_required");
  throws(() => apply(graph, 2, [ops[0], { ...ops[1], slot: B }]), "wrong_slot");
});

test("contradictory human feature reports never rewrite observed own-image evidence", () => {
  let graph = createReferenceGraph({ ownObservations: [{ slot: A, feature: "細長い" }] });
  graph = apply(graph, 1, [mention(1, "m", { speaker: "ai", intent: "feature_assertion" }), feature(1)]);
  graph = apply(graph, 2, [mention(2, "m", { quote: "いいえ", intent: "denial", antecedent: "1:m" }), feature(2, { polarity: "denied" })]);
  assert.deepEqual(view(graph).features.map((f) => f.polarity), ["confirmed", "denied"]);
  assert.ok(view(graph).features.every((f) => f.epistemic === "public_report"));
  assert.equal(view(graph).ownObservations[0].feature, "細長い");
  assert.equal(view(graph, B).features.length, 0);
});

test("explicit correction retracts a wrong reference and invalidates its dependent name", () => {
  const graph = proposed();
  const next = apply(graph, 2, [mention(2, "m", { quote: "取り違えました", slots: [B], intent: "correction" }),
    { kind: "retract", id: "2:repair", targetId: "1:m", mentionId: "2:m", reason: "先の参照を撤回" }]);
  assert.equal(view(next).status, "unassigned"); assert.equal(view(next).candidate, null);
  assert.equal(view(next, B).candidate, null, "retraction never transfers the name");
  assert.equal(next.records.find((r) => r.id === "1:m").quote, "鳥にしませんか", "evidence remains immutable");
  assert.deepEqual(snapshotReferenceGraph(next).mentions.map((m) => m.id), ["2:m"]);
  assert.equal(snapshotReferenceGraph(next).repairs[0].targetId, "1:m");
  throws(() => apply(next, 3, [name(3, { mentionIds: ["1:m"], replaces: "1:name" })]), "missing_provenance");
});

test("retracting a replacement cannot resurrect an older agreed name", () => {
  let graph = apply(proposed(), 2, [mention(2, "m", { quote: "鳥で合意", intent: "name_acceptance" }), name(2, { agreement: "explicit", replaces: "1:name" })]);
  graph = apply(graph, 3, [mention(3, "m", { quote: "白鳥へ訂正", intent: "correction" }), name(3, { name: "白鳥", replaces: "2:name" })]);
  graph = apply(graph, 4, [mention(4, "m", { quote: "その訂正も撤回", intent: "correction" }),
    { kind: "retract", id: "4:r", targetId: "3:name", mentionId: "4:m", reason: "再検討" }]);
  assert.equal(view(graph).status, "unassigned"); assert.equal(view(graph).candidate, null);
});

test("repair plus replacement is atomic and remains tentative until separately accepted", () => {
  const graph = proposed();
  const next = apply(graph, 2, [mention(2, "m", { quote: "白鳥に訂正します", intent: "correction" }),
    { kind: "retract", id: "2:r", targetId: "1:name", mentionId: "2:m", reason: "名前の訂正" },
    name(2, { name: "白鳥", replaces: "1:name" })]);
  assert.equal(view(next).candidate.name, "白鳥"); assert.equal(view(next).status, "tentative");
  const ops = [mention(2, "m", { quote: "白鳥に訂正します", intent: "correction" }),
    { kind: "retract", id: "2:r", targetId: "1:name", mentionId: "2:m", reason: "名前の訂正" },
    name(2, { name: "白鳥", slot: B, replaces: "1:name" })];
  throws(() => apply(graph, 2, ops), "wrong_slot");
  assert.equal(view(graph).candidate.name, "鳥");
});

test("defer and revisit retain a candidate without inventing agreement", () => {
  let graph = proposed();
  graph = apply(graph, 2, [mention(2, "m", { quote: "この話は後で", intent: "refer" }),
    { kind: "focus", id: "2:f", slot: A, mode: "defer", mentionId: "2:m" }]);
  assert.equal(view(graph).status, "deferred"); assert.equal(view(graph).candidate.name, "鳥");
  graph = apply(graph, 3, [mention(3, "m", { quote: "この話に戻ります", intent: "refer" }),
    { kind: "focus", id: "3:f", slot: A, mode: "revisit", mentionId: "3:m" }]);
  assert.equal(view(graph).status, "tentative");
  throws(() => apply(graph, 4, [mention(4), { kind: "focus", id: "4:f", slot: A, mode: "revisit", mentionId: "4:m" }]), "not_deferred");
  assert.equal(view(graph, B).status, "unassigned");
});

test("same-transaction operation order determines the current focus and name status", () => {
  const base = proposed();
  const m = mention(2, "m", { quote: "鳥の話", intent: "name_acceptance" });
  const defer = { kind: "focus", id: "2:f", slot: A, mode: "defer", mentionId: "2:m" };
  const agreed = name(2, { agreement: "explicit", replaces: "1:name" });
  assert.equal(view(apply(base, 2, [m, defer, agreed])).status, "agreed");
  assert.equal(view(apply(base, 2, [m, agreed, defer])).status, "deferred");
});

test("questions distinguish unresolved, deferred, revisited and resolved discrimination", () => {
  let graph = apply(createReferenceGraph(), 1, [mention(1, "m", { slots: [A, B], epistemic: "hypothesis" }), question(1)]);
  graph = apply(graph, 2, [mention(2, "m", { slots: [A, B], epistemic: "hypothesis" }), question(2, { status: "deferred", replaces: "1:q" })]);
  assert.equal(snapshotReferenceGraph(graph).questions[0].status, "deferred");
  graph = apply(graph, 3, [mention(3, "m", { slots: [A, B], epistemic: "hypothesis" }), question(3, { status: "open", replaces: "2:q" })]);
  assert.equal(snapshotReferenceGraph(graph).questions[0].status, "open");
  graph = apply(graph, 4, [mention(4, "m", { slots: [A, B], epistemic: "hypothesis" }), question(4, { status: "resolved", replaces: "3:q" })]);
  assert.equal(snapshotReferenceGraph(graph).questions[0].status, "resolved");
  assert.ok(SLOTS.every((slot) => view(graph, slot).status === "unassigned"));
});

test("generation errors and validation errors cannot commit any part of a transaction", () => {
  const graph = createReferenceGraph(), ops = [mention(1)], tx = update(graph, 1, ops);
  const before = JSON.stringify(graph), publicTurns = publicTurnsFor(ops);
  const validated = validateReferenceUpdate(graph, tx, { publicTurns });
  assert.ok(Object.isFrozen(validated.operations[0])); assert.equal(JSON.stringify(graph), before);
  for (const generationSucceeded of [false, undefined, "true", 1]) {
    throws(() => applyReferenceUpdate(graph, validated, { publicTurns, generationSucceeded }), "generation_not_succeeded");
  }
  throws(() => apply(graph, 1, [mention(1), feature(1)]), "unsupported_feature");
  assert.equal(JSON.stringify(graph), before);
  const next = applyReferenceUpdate(graph, validated, { publicTurns, generationSucceeded: true });
  assert.equal(next.revision, 1); assert.equal(graph.revision, 0);
});

test("apply revalidates staged data, rejects stale revisions, and never consumes generated prose", () => {
  const graph = createReferenceGraph(), ops = [mention(1)];
  const tx = update(graph, 1, ops);
  validateReferenceUpdate(graph, tx, { publicTurns: publicTurnsFor(ops) });
  tx.operations[0].slots = ["F1"];
  throws(() => applyReferenceUpdate(graph, tx, { generationSucceeded: true, publicTurns: publicTurnsFor(ops) }), "invalid_mention");
  const next = apply(graph, 1, [mention(1)]);
  throws(() => applyReferenceUpdate(next, update(graph, 2, []), { generationSucceeded: true }), "stale_revision");
  throws(() => apply(next, 1, []), "invalid_update");
  throws(() => applyReferenceUpdate(graph, { expectedRevision: 0, turn: 1, operations: [], generatedText: "鳥で合意しました" },
    { generationSucceeded: true }), "stale_revision");
  assert.equal(view(apply(graph, 1, [], { publicTurns: [{ turn: 1, speaker: "ai", text: "鳥で合意しました" }] })).candidate, null);
});

test("mentions must quote actual public speech, with no future/private evidence", () => {
  const graph = createReferenceGraph(), op = mention(1);
  throws(() => apply(graph, 1, [op], { publicTurns: [] }), "nonpublic_evidence");
  throws(() => apply(graph, 1, [op], { publicTurns: [{ turn: 1, speaker: "ai", text: op.quote }] }), "nonpublic_evidence");
  throws(() => apply(graph, 1, [op], { publicTurns: [{ turn: 2, speaker: "human", text: op.quote }] }), "invalid_public_turns");
  throws(() => apply(graph, 1, [op], { publicTurns: [{ turn: 1, speaker: "human", text: "非公開の別発話" }] }), "nonpublic_evidence");
  const next = apply(graph, 1, [op]);
  const remembered = apply(next, 2, [mention(2, "m", { sourceTurn: 1 })]);
  assert.equal(snapshotReferenceGraph(remembered).mentions.find((m) => m.id === "2:m").sourceTurn, 1);
  throws(() => apply(graph, 1, [mention(1, "m", { antecedent: "2:m" })]), "missing_provenance");
});

test("a previous public AI naming proposal can be identified later to ground a human yes", () => {
  const graph = apply(createReferenceGraph(), 1, []);
  const next = apply(graph, 2, [
    mention(2, "proposal", { sourceTurn: 1, speaker: "ai", quote: "鳥", intent: "name_proposal" }),
    mention(2, "m", { quote: "はい", intent: "name_acceptance", antecedent: "2:proposal" }),
    name(2, { agreement: "explicit" }),
  ]);
  assert.equal(view(next).status, "agreed"); assert.deepEqual(view(next).candidate.sourceTurns, [1, 2]);
});

test("transitions are deterministic and support strict JSON graph roundtrips", () => {
  const graph = proposed(), restored = JSON.parse(JSON.stringify(graph));
  const ops = [mention(2, "m", { quote: "鳥でいいです", intent: "name_acceptance" }), name(2, { agreement: "explicit", replaces: "1:name" })];
  assert.deepEqual(apply(graph, 2, ops), apply(restored, 2, ops));
  assert.deepEqual(snapshotReferenceGraph(graph), snapshotReferenceGraph(restored));
  const forged = JSON.parse(JSON.stringify(graph));
  forged.records[1].agreement = "explicit";
  throws(() => snapshotReferenceGraph(forged), "unsupported_agreement");
  throws(() => apply(createReferenceGraph(), 1, [mention(1, "m", { quote: function PRIVATE_RAW_MODEL_TEXT() {} })],
    { publicTurns: [] }), "invalid_mention");
});

test("feature retraction preserves an independent contrary report and never updates another slot", () => {
  let graph = apply(createReferenceGraph(), 1, [mention(1, "m", { intent: "feature_assertion" }), feature(1)]);
  graph = apply(graph, 2, [mention(2, "m", { quote: "細長いとは言えません", intent: "denial" }), feature(2, { polarity: "denied" })]);
  graph = apply(graph, 3, [mention(3, "m", { quote: "最初の特徴は訂正します", intent: "correction" }),
    { kind: "retract", id: "3:r", targetId: "1:feature", mentionId: "3:m", reason: "特徴訂正" }]);
  assert.deepEqual(view(graph).features.map((f) => f.polarity), ["denied"]);
  assert.equal(view(graph).features[0].speaker, "human");
  assert.equal(view(graph).features[0].targetEpistemic, "grounded");
  assert.equal(view(graph, B).features.length, 0);
});

test("strict schemas exclude external IDs, board matching keys and private metadata", () => {
  const graph = createReferenceGraph();
  for (const field of ["figureId", "humanSlot", "gold", "annotation", "scoring", "model", "image"]) {
    throws(() => apply(graph, 1, [{ ...mention(1), [field]: "PRIVATE" }]), "invalid_record");
    throws(() => snapshotReferenceGraph({ ...graph, [field]: "PRIVATE" }), "invalid_graph");
  }
  throws(() => apply(graph, 1, [mention(1, "m", { slots: [A, A], epistemic: "hypothesis" })]), "invalid_mention");
  throws(() => apply(graph, 1, [mention(1, "m", { confidence: NaN })]), "invalid_mention");
  throws(() => apply(graph, 1, [mention(1, "m", { slots: [], epistemic: "grounded" })]), "invalid_mention");
  throws(() => createReferenceGraph({ ownObservations: [{ slot: "F1", feature: "秘密" }] }), "invalid_observations");
  throws(() => createReferenceGraph({ gold: "PRIVATE" }), "invalid_observations");
  throws(() => apply(graph, 1, [{ ...mention(1), kind: "__proto__" }]), "invalid_record");
  const badRecord = { ...mention(1), turn: 1 };
  throws(() => snapshotReferenceGraph({ ...graph, revision: 1, lastTurn: 1, records: [badRecord, badRecord] }), "invalid_graph");
});

test("long-history pruning preserves named-slot evidence and never shifts it to another slot", () => {
  let graph = proposed();
  for (let turn = 2; turn <= 300; turn++) {
    graph = apply(graph, turn, [mention(turn, "m", { quote: `特徴${turn}`, slots: [B], intent: "feature_assertion" }),
      feature(turn, { slot: B, feature: `特徴${turn}` })]);
  }
  assert.ok(graph.records.length <= REFERENCE_LIMITS.records);
  assert.ok(JSON.stringify(graph).length <= REFERENCE_LIMITS.graphChars);
  assert.equal(graph.lastTurn, 300); assert.equal(graph.revision, 300);
  assert.equal(view(graph).candidate.name, "鳥"); assert.equal(view(graph, B).candidate, null);
  assert.equal(view(graph, B).features.length, REFERENCE_LIMITS.featuresPerSlot);
  assert.ok(graph.records.some((r) => r.id === "1:m")); assert.ok(!graph.records.some((r) => r.id === "2:m"));
  assert.ok(snapshotReferenceGraph(graph).mentions.length <= REFERENCE_LIMITS.recentMentions + 1);
});

test("pruning retains retraction provenance and cannot revive a wrong old slot", () => {
  let graph = apply(proposed(), 2, [mention(2, "m", { quote: "先ほどの話を撤回", intent: "correction" }),
    { kind: "retract", id: "2:r", targetId: "1:m", mentionId: "2:m", reason: "誤参照" }]);
  for (let turn = 3; turn <= 150; turn++) graph = apply(graph, turn, [mention(turn, "m", { slots: [B] })]);
  assert.equal(view(graph).candidate, null); assert.equal(view(graph, B).candidate, null);
  assert.ok(graph.records.some((r) => r.id === "2:r"));
  assert.ok(!snapshotReferenceGraph(graph).mentions.some((r) => r.id === "1:m"));
});

test("pinned provenance overflow fails atomically instead of dropping support for a current name", () => {
  let graph = proposed(), failed = false;
  for (let turn = 2; turn <= REFERENCE_LIMITS.records + 5; turn++) {
    const before = JSON.stringify(graph), previous = `${turn - 1}:m`;
    try {
      graph = apply(graph, turn, [mention(turn, "m", { quote: "鳥", intent: "name_proposal", antecedent: previous }),
        name(turn, { replaces: `${turn - 1}:name` })]);
    } catch (error) {
      assert.equal(error.code, "capacity_exceeded"); assert.equal(JSON.stringify(graph), before);
      assert.equal(view(graph).candidate.name, "鳥"); failed = true; break;
    }
  }
  assert.ok(failed);
});

test("pruning under pressure cannot reopen an older question by dropping its resolved successor", () => {
  let graph = proposed();
  for (let turn = 2; turn <= 154; turn++) {
    graph = apply(graph, turn, [mention(turn, "m", { quote: "鳥", intent: "name_proposal", antecedent: `${turn - 1}:m` }),
      name(turn, { replaces: `${turn - 1}:name` })]);
  }
  graph = apply(graph, 155, [question(155, { slots: [A], mentionIds: ["1:m"] })]);
  assert.equal(snapshotReferenceGraph(graph).questions[0].status, "open");
  const sources = Array.from({ length: 8 }, (_, i) => mention(156, `m${i}`, { quote: "区別できました" }));
  graph = apply(graph, 156, [...sources, question(156, {
    slots: [A], status: "resolved", mentionIds: sources.map((r) => r.id), replaces: "155:q",
  })]);
  assert.ok(snapshotReferenceGraph(graph).questions.every((r) => r.status === "resolved"));
  assert.equal(view(graph).candidate.name, "鳥");
});

test("bounded private judge JSON includes six states, uncertainty, questions and source turns", () => {
  let graph = proposed();
  graph = apply(graph, 2, [mention(2, "m", { quote: "尖った方", slots: [B, C], epistemic: "hypothesis", confidence: 0.4 }),
    question(2, { slots: [B, C] })]);
  const summary = summarizeForJudge(graph, { maxChars: 6000 }), parsed = JSON.parse(summary);
  assert.ok(summary.length <= 6000); assert.deepEqual(Object.keys(parsed.ownSlots), SLOTS);
  assert.equal(parsed.ownSlots[A].candidate.name, "鳥"); assert.deepEqual(parsed.ownSlots[A].candidate.sourceTurns, [1]);
  assert.deepEqual(parsed.recentHumanReferences[0].candidateOwnSlots, [B, C]);
  assert.equal(parsed.recentHumanReferences[0].sourceTurn, 2); assert.deepEqual(parsed.unresolvedQuestions[0].sourceTurns, [2]);
  assert.equal(parsed.scope, "private_own_slots_not_ground_truth");
  const minimal = JSON.parse(summarizeForJudge(graph, { maxChars: 1100 }));
  assert.equal(minimal.ownSlots[A].candidate.name, "鳥");
  assert.ok(JSON.stringify(minimal).length <= 1100);
  throws(() => summarizeForJudge(graph, { maxChars: 1 }), "summary_budget_too_small");
  for (const maxChars of [NaN, Infinity, -1, 0, 1.2, "1000", REFERENCE_LIMITS.graphChars + 1]) {
    throws(() => summarizeForJudge(graph, { maxChars }), "invalid_summary_budget");
  }
});

test("all hard array/text budgets reject without partial state changes", () => {
  const graph = createReferenceGraph(), before = JSON.stringify(graph);
  throws(() => apply(graph, 1, Array.from({ length: 17 }, (_, i) => mention(1, `m${i}`))), "invalid_update");
  throws(() => apply(graph, 1, [mention(1, "m", { quote: "長".repeat(161) })]), "invalid_mention");
  throws(() => createReferenceGraph({ ownObservations: Array.from({ length: 9 }, (_, i) => ({ slot: A, feature: `特徴${i}` })) }), "invalid_observations");
  throws(() => apply(graph, 1, [mention(1), mention(1)]), "duplicate_id");
  assert.equal(JSON.stringify(graph), before);
  let next = apply(graph, 1, [mention(1, "m", { slots: [A, B], epistemic: "hypothesis" })]);
  for (let turn = 2; turn <= REFERENCE_LIMITS.unresolvedQuestions + 1; turn++) {
    next = apply(next, turn, [question(turn, { mentionIds: ["1:m"] })]);
  }
  const pinned = JSON.stringify(next);
  throws(() => apply(next, 14, [question(14, { mentionIds: ["1:m"] })]), "capacity_exceeded");
  assert.equal(JSON.stringify(next), pinned);
});
