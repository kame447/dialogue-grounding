import test from "node:test";
import assert from "node:assert/strict";
import { SLOTS } from "../dialogue-model/runtime/stimuli/board.mjs";
import {
  createReferenceGraph, validateReferenceUpdate, applyReferenceUpdate,
  snapshotReferenceGraph, summarizeForJudge, REFERENCE_LIMITS, ReferenceGraphError,
} from "../dialogue-model/runtime/memory/reference-graph.mjs";
import {
  createOwnLedger, applyJudgment, SAFE_JUDGMENT, JudgmentValidationError,
} from "../dialogue-model/runtime/judgment/schema.mjs";
import { createDialogueSession } from "../dialogue-model/runtime/session.mjs";
import { createNamingTask } from "../dialogue-model/runtime/naming-task.mjs";

// All speech, images, names and observations below are synthetic. These tests
// check typed state/provenance, not whether a model correctly identifies a shape.
const [A, B, C] = SLOTS;
const copy = (value) => JSON.parse(JSON.stringify(value));
const mention = (turn, id = "m", fields = {}) => ({
  kind: "mention", id: `${turn}:${id}`, sourceTurn: turn, speaker: "human",
  quote: "くぼみのある候補", slots: [A], confidence: 0.7,
  epistemic: "grounded", intent: "refer", antecedent: null, ...fields,
});
const naming = (turn, fields = {}) => ({
  kind: "name", id: `${turn}:n`, slot: A, name: "鳥", agreement: "none",
  mentionIds: [`${turn}:m`], replaces: null, ...fields,
});
const feature = (turn, fields = {}) => ({
  kind: "feature", id: `${turn}:f`, slot: A, feature: "くぼみ",
  polarity: "confirmed", mentionId: `${turn}:m`, ...fields,
});
const focus = (turn, fields = {}) => ({
  kind: "focus", id: `${turn}:focus`, slot: A, mode: "defer",
  mentionId: `${turn}:m`, ...fields,
});
const transaction = (graph, turn, operations) => ({ expectedRevision: graph.revision, turn, operations });
function publicEvidence(operations) {
  const evidence = new Map();
  for (const op of operations.filter((op) => op.kind === "mention")) {
    const key = `${op.sourceTurn}:${op.speaker}`;
    const previous = evidence.get(key);
    evidence.set(key, { turn: op.sourceTurn, speaker: op.speaker, text: [previous?.text, op.quote].filter(Boolean).join("\n") });
  }
  return [...evidence.values()];
}
function commit(graph, turn, operations, options = {}) {
  return applyReferenceUpdate(graph, transaction(graph, turn, operations), {
    publicTurns: publicEvidence(operations), generationSucceeded: true, ...options,
  });
}
const slotView = (graph, slot = A) => snapshotReferenceGraph(graph).ownSlots[slot];
function rejectsUnchanged(graph, action, code) {
  const before = copy(graph);
  assert.throws(action, (error) => error instanceof ReferenceGraphError && (code === undefined || error.code === code));
  assert.deepEqual(graph, before, "rejection must leave even a mutable rehydrated graph unchanged");
}
function proposal(slot = A, name = "鳥") {
  return commit(createReferenceGraph(), 1, [
    mention(1, "m", { speaker: "ai", slots: [slot], quote: `${name}という名前はどうですか`, intent: "name_proposal" }),
    naming(1, { slot, name }),
  ]);
}

test("adversarial: bare deictics cannot create agreement on any own slot", () => {
  for (const slot of SLOTS) for (const quote of ["それ", "はい", "それ。", "はい！"]) {
    const graph = copy(proposal(slot));
    const bare = mention(2, "m", { quote, slots: [slot], intent: "name_acceptance" });
    rejectsUnchanged(graph, () => commit(graph, 2, [bare,
      naming(2, { slot, agreement: "explicit", replaces: "1:n" })]), "ungrounded_deictic");
    const unresolved = commit(graph, 2, [{ ...bare, slots: [], confidence: 0, epistemic: "unresolved" }]);
    assert.equal(slotView(unresolved, slot).status, "tentative");
    assert.deepEqual(snapshotReferenceGraph(unresolved).mentions.at(-1).slots, []);
  }
});

test("adversarial: a yes with a feature antecedent cannot accept a name", () => {
  let graph = proposal();
  graph = commit(graph, 2, [mention(2, "m", { speaker: "ai", quote: "くぼみがありますか", intent: "feature_assertion" }), feature(2)]);
  const response = mention(3, "m", { quote: "はい", intent: "name_acceptance", antecedent: "2:m" });
  rejectsUnchanged(graph, () => commit(graph, 3, [response,
    naming(3, { agreement: "explicit", replaces: "1:n" })]), "unsupported_name");
  const acceptedFeature = commit(graph, 3, [{ ...response, intent: "feature_acceptance" }, feature(3)]);
  assert.equal(slotView(acceptedFeature).status, "tentative");
  assert.deepEqual(slotView(acceptedFeature).features.map(({ speaker }) => speaker), ["ai", "human"]);
});

test("adversarial: candidate sets never become a unique agreed correspondence", () => {
  for (const candidates of [[A, B], [A, C, B], SLOTS]) {
    const m = mention(1, "m", { quote: "鳥に見える候補", slots: candidates, epistemic: "hypothesis", confidence: 0.4, intent: "name_acceptance" });
    const ops = [m, ...candidates.map((slot, i) => naming(1, { id: `1:n${i}`, slot }))];
    const graph = commit(createReferenceGraph(), 1, ops);
    const snapshot = snapshotReferenceGraph(graph);
    for (const slot of SLOTS) assert.equal(snapshot.ownSlots[slot].status, candidates.includes(slot) ? "tentative" : "unassigned");
    assert.deepEqual(snapshot.mentions[0].slots, candidates);
    assert.equal(snapshot.mentions[0].scope, "human_reference_interpretation");
    for (const slot of candidates) rejectsUnchanged(createReferenceGraph(), () => commit(createReferenceGraph(), 1,
      [m, naming(1, { slot, agreement: "explicit" })]), "unsupported_agreement");
    assert.equal(JSON.parse(summarizeForJudge(graph)).scope, "private_own_slots_not_ground_truth");
  }
});

test("adversarial: quote provenance binds text to both its public turn and speaker", () => {
  const graph = copy(proposal());
  const m = mention(3, "m", { sourceTurn: 2, quote: "鳥でいいです", intent: "name_acceptance" });
  const ops = [m, naming(3, { agreement: "explicit", replaces: "1:n" })];
  for (const publicTurns of [
    [], [{ turn: 2, speaker: "ai", text: m.quote }],
    [{ turn: 1, speaker: "human", text: m.quote }],
    [{ turn: 2, speaker: "human", text: "くぼみの話をしています" }],
    [{ turn: 2, speaker: "human", text: "鳥で" }, { turn: 2, speaker: "ai", text: "いいです" }],
  ]) rejectsUnchanged(graph, () => commit(graph, 3, ops, { publicTurns }), "nonpublic_evidence");
  for (const publicTurns of [
    [{ turn: 4, speaker: "human", text: m.quote }],
    [{ turn: 2, speaker: "human", text: m.quote }, { turn: 2, speaker: "human", text: m.quote }],
    [{ turn: 2, speaker: "human", text: m.quote, gold: "PRIVATE" }],
  ]) rejectsUnchanged(graph, () => commit(graph, 3, ops, { publicTurns }), "invalid_public_turns");
  const next = commit(graph, 3, ops, { publicTurns: [{ turn: 2, speaker: "human", text: `公開文：${m.quote}。` }] });
  assert.deepEqual(slotView(next).candidate.sourceTurns, [2]);
  assert.equal(next.lastTurn, 3);
});

test("adversarial: later-added evidence cannot act as an earlier utterance's antecedent", () => {
  const graph = commit(createReferenceGraph(), 2, [mention(2)]);
  rejectsUnchanged(graph, () => commit(graph, 3, [mention(3, "m", { sourceTurn: 1, quote: "それ", antecedent: "2:m" })]), "inconsistent_antecedent");
  rejectsUnchanged(graph, () => commit(graph, 3, [mention(3, "m", { quote: "はい", antecedent: "3:later" }), mention(3, "later")]), "missing_provenance");
});

test("adversarial: contradictory speakers remain attributed reports separate from the own image", () => {
  let graph = createReferenceGraph({ ownObservations: [{ slot: A, feature: "くぼみ" }] });
  graph = commit(graph, 1, [mention(1, "m", { speaker: "ai", intent: "feature_assertion" }), feature(1)]);
  graph = commit(graph, 2, [mention(2, "m", { quote: "くぼみはありません", intent: "denial" }), feature(2, { polarity: "denied" })]);
  const before = slotView(graph);
  assert.deepEqual(before.features.map(({ speaker, polarity, sourceTurn, epistemic }) => ({ speaker, polarity, sourceTurn, epistemic })), [
    { speaker: "ai", polarity: "confirmed", sourceTurn: 1, epistemic: "public_report" },
    { speaker: "human", polarity: "denied", sourceTurn: 2, epistemic: "public_report" },
  ]);
  graph = commit(graph, 3, [mention(3, "m", { quote: "自分の説明は訂正します", speaker: "ai", intent: "correction" }),
    { kind: "retract", id: "3:r", targetId: "1:f", mentionId: "3:m", reason: "説明の訂正" }]);
  assert.deepEqual(slotView(graph).ownObservations, before.ownObservations);
  assert.deepEqual(slotView(graph).features.map(({ speaker, polarity }) => [speaker, polarity]), [["human", "denied"]]);
  for (const slot of SLOTS.filter((slot) => slot !== A)) assert.deepEqual(slotView(graph, slot).features, []);
});

test("adversarial: switching targets then revisiting preserves separate tentative candidates", () => {
  let graph = proposal();
  graph = commit(graph, 2, [mention(2), focus(2)]);
  graph = commit(graph, 3, [mention(3, "m", { slots: [B], quote: "船という候補", intent: "name_proposal" }), naming(3, { slot: B, name: "船" })]);
  graph = commit(graph, 4, [mention(4, "m", { quote: "最初の候補へ戻ります" }), focus(4, { mode: "revisit" })]);
  assert.deepEqual([slotView(graph).candidate.name, slotView(graph).status], ["鳥", "tentative"]);
  assert.deepEqual([slotView(graph, B).candidate.name, slotView(graph, B).status], ["船", "tentative"]);
  rejectsUnchanged(graph, () => commit(graph, 5, [mention(5, "m", { slots: [C] }), focus(5, { slot: C, mode: "revisit" })]), "not_deferred");
  rejectsUnchanged(graph, () => commit(graph, 5, [mention(5), focus(5, { mode: "revisit" })]), "not_deferred");
});

test("adversarial: duplicate and same-sounding graph names never merge own slots", () => {
  for (const [left, right] of [["鳥", "とり"], ["鳥", "鳥"]]) {
    let graph = proposal(A, left);
    graph = commit(graph, 2, [mention(2, "m", { slots: [B], quote: `${right}という候補`, intent: "name_proposal" }), naming(2, { slot: B, name: right })]);
    graph = commit(graph, 3, [mention(3, "m", { quote: `${left}で合意します`, intent: "name_acceptance" }), naming(3, { name: left, agreement: "explicit", replaces: "1:n" })]);
    assert.equal(slotView(graph).status, "agreed");
    assert.equal(slotView(graph, B).status, "tentative");
    assert.equal(slotView(graph, B).candidate.name, right);
    assert.deepEqual(slotView(graph, B).candidate.sourceTurns, [2]);
  }
  const act = (slot, name) => ({ ...SAFE_JUDGMENT, action: "propose_name", targetSlot: slot, candidateName: name });
  const ledger = applyJudgment(createOwnLedger(), act(A, "鳥"));
  assert.equal(applyJudgment(ledger, act(B, "とり"))[B].status, "tentative");
  const before = copy(ledger);
  assert.throws(() => applyJudgment(ledger, act(B, " 鳥 ")), (e) => e instanceof JudgmentValidationError && e.code === "duplicate_name_requires_repair");
  assert.deepEqual(ledger, before);
});

test("adversarial: implicit agreement and AI-only acceptance do not substitute for human naming acceptance", () => {
  const base = proposal();
  for (const speaker of ["human", "ai"]) for (const intent of ["name_proposal", "refer", "acknowledgment"]) {
    const m = mention(2, "m", { speaker, quote: "鳥について話します", intent });
    rejectsUnchanged(base, () => commit(base, 2, [m, naming(2, { agreement: "explicit", replaces: "1:n" })]));
  }
  const implicit = commit(base, 2, [mention(2, "m", { quote: "鳥が候補ですね", intent: "name_proposal" }), naming(2, { agreement: "implicit", replaces: "1:n" })]);
  assert.equal(slotView(implicit).status, "tentative");
  const yes = mention(3, "m", { quote: "はい", intent: "name_acceptance", antecedent: "1:m" });
  const next = commit(implicit, 3, [yes, naming(3, { agreement: "explicit", replaces: "2:n" })]);
  assert.deepEqual(slotView(next).candidate.sourceTurns, [1, 3]);
  assert.equal(slotView(next).status, "agreed");
  rejectsUnchanged(implicit, () => commit(implicit, 3, [{ ...yes, speaker: "ai" }, naming(3, { agreement: "explicit", replaces: "2:n" })]), "unsupported_agreement");
});

test("adversarial: stale competing updates and changed public evidence are revalidated at commit", () => {
  const base = copy(proposal());
  const operations = [mention(2), focus(2)];
  const publicTurns = publicEvidence(operations);
  const staged = validateReferenceUpdate(base, transaction(base, 2, operations), { publicTurns });
  const winner = commit(base, 2, [mention(2, "other", { slots: [B] })]);
  rejectsUnchanged(winner, () => applyReferenceUpdate(winner, staged, { publicTurns, generationSucceeded: true }), "stale_revision");
  publicTurns[0].text = "別の公開文";
  rejectsUnchanged(base, () => applyReferenceUpdate(base, staged, { publicTurns, generationSucceeded: true }), "nonpublic_evidence");
  assert.equal(base.revision, 1);
  assert.equal(slotView(base).status, "tentative");
});

test("adversarial: validation is not a commit and only literal generation success opens the gate", () => {
  const graph = copy(proposal());
  const ops = [mention(2), focus(2)];
  const publicTurns = publicEvidence(ops), before = copy(graph);
  const staged = validateReferenceUpdate(graph, transaction(graph, 2, ops), { publicTurns });
  assert.deepEqual(graph, before);
  assert.ok(Object.isFrozen(staged.operations[0].slots));
  for (const generationSucceeded of [false, undefined, null, 0, 1, "true", {}, []]) {
    rejectsUnchanged(graph, () => applyReferenceUpdate(graph, staged, { publicTurns, generationSucceeded }), "generation_not_succeeded");
  }
  const next = applyReferenceUpdate(graph, staged, { publicTurns, generationSucceeded: true });
  assert.equal(slotView(next).status, "deferred");
  assert.deepEqual(graph, before);
  assert.deepEqual(ops, [mention(2), focus(2)], "caller operations are not rewritten");
});

test("adversarial: an invalid final operation rolls back all preceding valid operations", () => {
  const graph = copy(proposal());
  const prefix = [mention(2, "m", { quote: "訂正を保留します", intent: "correction" }), focus(2)];
  const invalid = [
    naming(2, { slot: B, replaces: "1:n" }),
    { ...focus(2), id: "2:bad", mode: "agreed" },
    { kind: "retract", id: "2:bad", targetId: "99:missing", mentionId: "2:m", reason: "取り消し" },
    mention(2, "bad", { antecedent: "99:missing" }),
    { ...feature(2), slot: "相手の上段左" },
    { kind: "phase", id: "2:bad", status: "completed" },
  ];
  for (const bad of invalid) {
    const ops = [...prefix, bad], tx = transaction(graph, 2, ops), publicTurns = publicEvidence(ops);
    rejectsUnchanged(graph, () => validateReferenceUpdate(graph, tx, { publicTurns }));
    rejectsUnchanged(graph, () => applyReferenceUpdate(graph, tx, { publicTurns, generationSucceeded: true }));
    assert.equal(slotView(graph).status, "tentative");
  }
});

test("adversarial: forged target/status/phase fields are rejected at each write boundary", () => {
  const graph = copy(proposal());
  for (const key of ["humanSlot", "figureId", "correspondence", "gold", "annotation", "phase", "status", "model", "generatedText", "__proto__", "constructor"]) {
    const op = JSON.parse(JSON.stringify(mention(2)).replace(/}$/, `,${JSON.stringify(key)}:"PRIVATE"}`));
    rejectsUnchanged(graph, () => commit(graph, 2, [op]), "invalid_record");
    const tx = { ...transaction(graph, 2, []), [key]: "PRIVATE" };
    rejectsUnchanged(graph, () => applyReferenceUpdate(graph, tx, { generationSucceeded: true }), "stale_revision");
  }
  for (const slot of ["F1", "human:1", "__proto__", null, {}, 1]) {
    rejectsUnchanged(graph, () => commit(graph, 2, [mention(2, "m", { slots: [slot] })]), "invalid_mention");
  }
  for (const turn of [0, 1, -1, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "2"]) {
    rejectsUnchanged(graph, () => commit(graph, turn, []), "invalid_update");
  }
});

test("adversarial: restoring JSON rejects malformed top-level, observation and record keys", () => {
  const original = proposal();
  const malformed = [
    (g) => { g.schemaVersion = 2; },
    (g) => { delete g.lastTurn; },
    (g) => { g.revision = g.lastTurn + 1; },
    (g) => { g.lastTurn = -1; },
    (g) => { g.records[0].slots = ["human:1"]; },
    (g) => { g.records[0].sourceTurn = 99; },
    (g) => { g.records[0].antecedent = g.records[0].id; },
    (g) => { g.records[0].confidence = null; },
    (g) => { g.records[0].epistemic = "ground_truth"; },
    (g) => { g.records[1].mentionIds = ["99:missing"]; },
    (g) => { g.records[1].agreement = "explicit"; },
    (g) => { g.records.reverse(); },
    (g) => { g.records.push(copy(g.records[1])); },
    (g) => { g.ownObservations = [{ slot: "F1", feature: "秘密" }]; },
  ];
  for (const mutate of malformed) {
    const graph = copy(original); mutate(graph);
    rejectsUnchanged(graph, () => snapshotReferenceGraph(graph));
    rejectsUnchanged(graph, () => summarizeForJudge(graph));
    rejectsUnchanged(graph, () => commit(graph, 2, []));
  }
  for (const key of ["humanSlot", "gold", "__proto__", "constructor", "toString"]) {
    for (const target of ["graph", "mention", "name", "observation"]) {
      const graph = copy(original);
      graph.ownObservations = [{ slot: A, feature: "くぼみ" }];
      const object = { graph, mention: graph.records[0], name: graph.records[1], observation: graph.ownObservations[0] }[target];
      Object.defineProperty(object, key, { value: "PRIVATE", enumerable: true });
      const restored = copy(graph);
      rejectsUnchanged(restored, () => snapshotReferenceGraph(restored));
      rejectsUnchanged(restored, () => commit(restored, 2, []));
    }
  }
});

test("adversarial: snapshots are detached, while snapshot views cannot masquerade as persisted graphs", () => {
  const graph = commit(proposal(), 2, [mention(2, "m", { intent: "feature_assertion" }), feature(2)]);
  const before = copy(graph), snapshot = snapshotReferenceGraph(graph);
  snapshot.mentions[0].slots[0] = B;
  snapshot.ownSlots[A].features[0].candidateOwnSlots.push(C);
  snapshot.ownSlots[A].candidate.name = "改変";
  assert.deepEqual(graph, before);
  rejectsUnchanged(snapshot, () => commit(snapshot, 3, []), "invalid_graph");
  const restored = copy(graph);
  assert.deepEqual(snapshotReferenceGraph(restored), snapshotReferenceGraph(graph));
  assert.deepEqual(commit(restored, 3, []), commit(graph, 3, []));
});

test("adversarial: slot permutations preserve semantic state and never create other-board mappings", () => {
  for (let offset = 0; offset < SLOTS.length; offset++) {
    const slot = SLOTS[offset], other = SLOTS[(offset + 1) % SLOTS.length];
    let graph = proposal(slot);
    graph = commit(graph, 2, [mention(2, "m", { slots: [slot, other], epistemic: "hypothesis", confidence: 0.3 })]);
    graph = commit(graph, 3, [mention(3, "m", { slots: [slot], quote: "鳥で合意します", intent: "name_acceptance" }), naming(3, { slot, agreement: "explicit", replaces: "1:n" })]);
    const snapshot = snapshotReferenceGraph(copy(graph));
    for (const ownSlot of SLOTS) {
      assert.equal(snapshot.ownSlots[ownSlot].status, ownSlot === slot ? "agreed" : "unassigned");
      assert.equal(snapshot.ownSlots[ownSlot].candidate?.name ?? null, ownSlot === slot ? "鳥" : null);
    }
    assert.deepEqual(snapshot.mentions.find((m) => m.id === "2:m").slots, [slot, other]);
    assert.equal(snapshot.mentions.find((m) => m.id === "2:m").scope, "human_reference_interpretation");
    assert.doesNotMatch(JSON.stringify(snapshot), /"(?:humanSlot|figureId|gold|correspondence)"/);
  }
});

test("adversarial: long seeded dialogue preserves six candidates, uncertainty, attribution and bounded JSON", () => {
  let graph = createReferenceGraph();
  let seed = 0x51a7, turn = 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (const [i, slot] of SLOTS.entries()) {
    turn++;
    const name = `候補名${i}`;
    graph = commit(graph, turn, [mention(turn, "m", { slots: [slot], quote: name, intent: "name_proposal" }), naming(turn, { slot, name })]);
  }
  for (; turn < 420;) {
    turn++;
    const slot = SLOTS[random() % SLOTS.length], other = SLOTS[(SLOTS.indexOf(slot) + 1) % SLOTS.length];
    const speaker = random() % 2 ? "human" : "ai", label = `合成特徴${turn}`;
    const ops = [mention(turn, "m", { slots: [slot, other], epistemic: "hypothesis", confidence: 0.25, speaker, quote: label, intent: "feature_assertion" }),
      feature(turn, { slot, feature: label })];
    graph = commit(graph, turn, ops);
    assert.ok(graph.records.length <= REFERENCE_LIMITS.records);
    assert.ok(JSON.stringify(graph).length <= REFERENCE_LIMITS.graphChars);
    if (turn % 17 === 0) graph = copy(graph);
  }
  const snapshot = snapshotReferenceGraph(graph);
  for (const [i, slot] of SLOTS.entries()) {
    assert.equal(snapshot.ownSlots[slot].candidate.name, `候補名${i}`);
    assert.equal(snapshot.ownSlots[slot].status, "tentative");
    assert.deepEqual(snapshot.ownSlots[slot].candidate.sourceTurns, [i + 1]);
    assert.ok(snapshot.ownSlots[slot].features.length <= REFERENCE_LIMITS.featuresPerSlot);
    assert.ok(snapshot.ownSlots[slot].features.every((f) => f.targetEpistemic === "hypothesis" && f.candidateOwnSlots.length === 2));
  }
  for (const maxChars of [1400, 2500, 6000]) {
    const summary = summarizeForJudge(graph, { maxChars });
    assert.ok(summary.length <= maxChars);
    const parsed = JSON.parse(summary);
    assert.deepEqual(Object.keys(parsed.ownSlots), SLOTS);
    for (const [i, slot] of SLOTS.entries()) assert.equal(parsed.ownSlots[slot].candidate.name, `候補名${i}`);
    assert.equal(parsed.scope, "private_own_slots_not_ground_truth");
    assert.ok(parsed.recentHumanReferences.every((m) => m.epistemic === "hypothesis"));
  }
  assert.equal(graph.lastTurn, 420);
  assert.equal(graph.revision, 420);
});

test("adversarial: bounded summaries reject impossible budgets without truncating valid names", () => {
  const longName = "合成名".repeat(26);
  const graph = proposal(A, longName), before = copy(graph);
  for (const maxChars of [1, 20, 100]) rejectsUnchanged(graph, () => summarizeForJudge(graph, { maxChars }), "summary_budget_too_small");
  const result = summarizeForJudge(graph, { maxChars: 1600 });
  assert.ok(result.length <= 1600);
  assert.equal(JSON.parse(result).ownSlots[A].candidate.name, longName);
  assert.deepEqual(graph, before);
});

test("adversarial: dependent agreement cannot survive retraction or be re-used as new support", () => {
  let graph = proposal();
  graph = commit(graph, 2, [mention(2, "m", { quote: "はい", intent: "name_acceptance", antecedent: "1:m" }), naming(2, { agreement: "explicit", replaces: "1:n" })]);
  graph = commit(graph, 3, [mention(3, "m", { quote: "先ほどの対象を取り違えました", slots: [B], intent: "correction" }),
    { kind: "retract", id: "3:r", targetId: "1:m", mentionId: "3:m", reason: "参照を撤回" }]);
  assert.equal(slotView(graph).candidate, null);
  assert.equal(slotView(graph, B).candidate, null);
  rejectsUnchanged(graph, () => commit(graph, 4, [mention(4, "m", { quote: "はい", intent: "name_acceptance", antecedent: "2:m" })]), "missing_provenance");
  for (let turn = 4; turn < 90; turn++) graph = commit(graph, turn, [mention(turn, "m", { slots: [C] })]);
  assert.equal(slotView(copy(graph)).candidate, null);
  assert.equal(JSON.parse(summarizeForJudge(graph)).ownSlots[A].candidate, null);
});

test("adversarial: session generation errors and empty output leave public history and typed notes unchanged", async () => {
  let mode = "ok", act = { ...SAFE_JUDGMENT, action: "propose_name", targetSlot: A, candidateName: "鳥", note: "PRIVATE-NOTE" };
  const calls = [];
  const session = createDialogueSession({ strategy: "bypass-enabled", judge: { async judge() { return copy(act); } },
    client: { async complete(messages) {
      calls.push(copy(messages));
      if (mode === "error") throw new Error("PRIVATE-UPSTREAM");
      return { text: mode === "empty" ? "  " : "鳥という名前はどうですか" };
    } } });
  await session.turn("最初の対象です");
  const history = session.getHistory(), ledger = session.getOwnLedger();
  act = { ...SAFE_JUDGMENT, action: "agree", targetSlot: A, candidateName: "鳥", note: "PRIVATE-NOTE" };
  for (mode of ["error", "empty"]) {
    await assert.rejects(session.turn("はい"));
    assert.deepEqual(session.getHistory(), history);
    assert.deepEqual(session.getOwnLedger(), ledger);
  }
  mode = "ok";
  await session.turn("鳥で合意します");
  assert.equal(session.getOwnLedger()[A].status, "agreed");
  assert.deepEqual(session.getHistory().map((m) => m.content), ["最初の対象です", "鳥という名前はどうですか", "鳥で合意します", "鳥という名前はどうですか"]);
  assert.doesNotMatch(JSON.stringify(session.getHistory()), /PRIVATE|ownLedger|referenceGraph|memoryOps/);
  assert.doesNotMatch(JSON.stringify(calls), /PRIVATE-NOTE|PRIVATE-UPSTREAM/);
});

test("adversarial: synthetic naming-task participant state excludes judge memory and cross-board key", async () => {
  const ownPng = Buffer.from("SYNTHETIC-OWN-IMAGE"), humanPng = Buffer.from("SYNTHETIC-OTHER-IMAGE");
  const calls = [];
  const task = await createNamingTask({ strategy: "repair-first", seed: 7, runDir: "",
    createTrial: ({ seed }) => ({ seed, trialId: "synthetic-trial", ai: { png: ownPng, mimeType: "image/png" }, human: { png: humanPng, mimeType: "image/png" }, key: { gold: "PRIVATE-KEY" } }),
    scoreTrial() { assert.fail("dialogue must never score"); },
    createJudge: () => ({ async judge() { return { ...SAFE_JUDGMENT, action: "propose_name", targetSlot: A, candidateName: "鳥", note: "PRIVATE-NOTE" }; } }),
    client: { async complete(messages) { calls.push(copy(messages)); return { text: "鳥という名前はどうですか" }; } },
  });
  await task.turn("候補の話です");
  const state = task.getState();
  for (const key of ["ownLedger", "referenceGraph", "ownReferences", "judgments", "memoryOps", "referenceMemory", "options"]) assert.equal(Object.hasOwn(state, key), false);
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE|SYNTHETIC|private_own_slots_not_ground_truth/);
  assert.doesNotMatch(JSON.stringify(calls), /PRIVATE|gold|humanSlot|figureId/);
  assert.ok(!JSON.stringify(calls).includes(humanPng.toString("base64")));
  assert.ok(JSON.stringify(calls).includes(ownPng.toString("base64")));
});
