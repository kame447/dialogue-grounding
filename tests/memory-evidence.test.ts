// Memory -> Jev shadow evidence: a closed-vocabulary view of the AI's own reference
// graph. Local data only; no model or network calls.
import test from "node:test";
import assert from "node:assert/strict";
import { createReferenceGraph, applyReferenceUpdate } from "../dialogue-model/runtime/memory/reference-graph.mjs";
import { buildMemoryEvidence, MEMORY_EVIDENCE_MAX_CHARS, MemoryEvidenceError, type MemoryEvidence }
  from "../dialogue-model/runtime/grounding/memory-evidence.ts";

const ids = Array.from({ length: 6 }, (_, i) => `s-000${i + 1}`);
const [A, B, C] = ids;
type Op = Record<string, unknown>;
type Event = { seq: number; speaker: "human" | "ai"; text: string };
const mention = (turn: number, local: string, extra: Op = {}): Op => ({ kind: "mention", id: `${turn}:${local}`, sourceTurn: turn,
  speaker: "human", quote: "細長い図形", slots: [A], confidence: 0.9, epistemic: "grounded", intent: "refer", antecedent: null, ...extra });

// Builds a graph turn by turn the way dialogue-v2 does: each update cites only public turns so far.
function build(steps: { turn: number; ops: Op[] }[], events: Event[]) {
  let graph = createReferenceGraph({ slots: ids });
  for (const { turn, ops } of steps) {
    const publicTurns = events.filter((e) => e.seq <= turn).map(({ seq, speaker, text }) => ({ turn: seq, speaker, text }));
    graph = applyReferenceUpdate(graph, { expectedRevision: graph.revision, turn, operations: ops }, { publicTurns: publicTurns as never[], generationSucceeded: true });
  }
  return graph;
}

const events: Event[] = [
  { seq: 1, speaker: "human", text: "細長い図形は鳥っぽいです" },
  { seq: 2, speaker: "ai", text: "鳥にしませんか" },
  { seq: 3, speaker: "human", text: "鳥でいいです" },
  { seq: 4, speaker: "human", text: "あれは違いました、細長い図形じゃないです" },
  { seq: 5, speaker: "human", text: "どれか分からない形があります" },
  { seq: 6, speaker: "human", text: "その丸い図形は後にしましょう" },
];
const dialogueSteps = [
  { turn: 1, ops: [mention(1, "m", { quote: "細長い図形は鳥っぽい", slots: [A, B], epistemic: "hypothesis", confidence: 0.6, intent: "feature_assertion" }),
    { kind: "feature", id: "1:f", slot: A, feature: "細長い", polarity: "confirmed", mentionId: "1:m" },
    { kind: "question", id: "1:q", slots: [A, B], text: "尖りはM2ですか？", status: "open", mentionIds: ["1:m"], replaces: null }] },
  { turn: 2, ops: [mention(2, "m", { speaker: "ai", quote: "鳥にしませんか", intent: "name_proposal" }),
    { kind: "name", id: "2:n", slot: A, name: "鳥", agreement: "none", mentionIds: ["2:m"], replaces: null }] },
  { turn: 3, ops: [mention(3, "m", { quote: "鳥でいいです", intent: "name_acceptance", antecedent: "2:m" }),
    { kind: "name", id: "3:n", slot: A, name: "鳥", agreement: "explicit", mentionIds: ["3:m"], replaces: "2:n" }] },
  { turn: 4, ops: [mention(4, "m", { quote: "細長い図形じゃない", intent: "denial", slots: [B], epistemic: "grounded" }),
    { kind: "feature", id: "4:f", slot: B, feature: "細長い", polarity: "denied", mentionId: "4:m" }] },
  { turn: 5, ops: [mention(5, "m", { quote: "どれか分からない形", slots: [], epistemic: "unresolved", confidence: 0 })] },
  { turn: 6, ops: [mention(6, "m", { quote: "その丸い図形は後にしましょう", slots: [C] }),
    { kind: "focus", id: "6:d", slot: C, mode: "defer", mentionId: "6:m" }] },
];
const figure = (evidence: MemoryEvidence | null, ref: string) => evidence!.figures.find((f) => f.ref === ref)!;

test("memory OFF yields null so the shadow can omit the field", () => {
  assert.equal(buildMemoryEvidence(null, { asOfSeq: 3, events }), null);
  assert.equal(buildMemoryEvidence(undefined, { asOfSeq: 3, events }), null);
});

test("a multi-turn dialogue keeps epistemic status, provenance, agreement, negation, questions and defer", () => {
  const graph = build(dialogueSteps, events);
  const evidence = buildMemoryEvidence(graph, { asOfSeq: 6, events })!;
  assert.equal(evidence.schema, "memory_evidence_v1");
  assert.equal(evidence.scope, "ai_private_interpretation_not_ground_truth");
  assert.deepEqual(evidence.figures.map((f) => f.ref), ids);
  const a = figure(evidence, A);
  assert.deepEqual(a.name, { text: "鳥", agreement: "explicit", visibility: "public", proposedBy: ["human"], sourceTurns: [2, 3] });
  assert.equal(a.memoryStatus, "agreed");
  assert.deepEqual(a.hypothesis, [{ turn: 1, speaker: "human", intent: "feature_assertion", alternatives: 2 }]);
  assert.deepEqual(a.grounded.map((r) => r.turn), [2, 3]);
  assert.deepEqual(a.featureReports, { confirmedTurns: [1], deniedTurns: [] });
  assert.deepEqual(a.questions, { openTurns: [1], deferredTurns: [] });
  // The negation stays a negative report about B, never support for anything.
  assert.deepEqual(figure(evidence, B).featureReports, { confirmedTurns: [], deniedTurns: [4] });
  assert.deepEqual(figure(evidence, B).name, null);
  assert.deepEqual(figure(evidence, C).focus, { mode: "defer", turn: 6 });
  assert.equal(figure(evidence, C).memoryStatus, "deferred");
  assert.deepEqual(evidence.unresolvedReferences, [{ turn: 5, speaker: "human", intent: "refer" }]);
  assert.equal(evidence.memoryTurn, 6);
});

test("unresolved or hypothesis interpretations never surface as grounded or agreed", () => {
  const ev: Event[] = [{ seq: 1, speaker: "human", text: "鳥でいいです、どれかな" }];
  const graph = build([{ turn: 1, ops: [
    mention(1, "h", { quote: "鳥でいいです", slots: [A, B], epistemic: "hypothesis", intent: "name_acceptance", confidence: 0.99 }),
    mention(1, "u", { quote: "どれかな", slots: [], epistemic: "unresolved", confidence: 0 }),
    { kind: "name", id: "1:n", slot: A, name: "鳥", agreement: "none", mentionIds: ["1:h"], replaces: null },
  ] }], ev);
  const evidence = buildMemoryEvidence(graph, { asOfSeq: 1, events: ev })!;
  for (const f of evidence.figures) assert.deepEqual(f.grounded, []);
  assert.equal(figure(evidence, A).name!.agreement, "none");
  assert.equal(figure(evidence, A).memoryStatus, "tentative");
  assert.deepEqual(figure(evidence, B).hypothesis.map((r) => r.alternatives), [2]);
  assert.equal(evidence.unresolvedReferences.length, 1);
  // Confidence is not P(correct) and is never forwarded.
  assert.ok(!JSON.stringify(evidence).includes("confidence"));
  assert.ok(!JSON.stringify(evidence).includes("0.99"));
});

test("retracted evidence and its dependents are listed as retracted, never as support", () => {
  const ev: Event[] = [
    { seq: 1, speaker: "ai", text: "鳥にしませんか" },
    { seq: 2, speaker: "human", text: "いえ、それは違う図形です。訂正します" },
  ];
  const graph = build([
    { turn: 1, ops: [mention(1, "m", { speaker: "ai", quote: "鳥にしませんか", intent: "name_proposal" }),
      { kind: "name", id: "1:n", slot: A, name: "鳥", agreement: "none", mentionIds: ["1:m"], replaces: null }] },
    { turn: 2, ops: [mention(2, "c", { quote: "訂正します", intent: "correction", slots: [A] }),
      { kind: "retract", id: "2:r", targetId: "1:m", mentionId: "2:c", reason: "誤った図形 ER1 a11" }] },
  ], ev);
  const a = figure(buildMemoryEvidence(graph, { asOfSeq: 2, events: ev }), A);
  assert.equal(a.name, null);
  assert.equal(a.memoryStatus, "unassigned");
  assert.deepEqual(a.grounded.map((r) => r.intent), ["correction"]);
  assert.deepEqual(a.retracted, [
    { kind: "mention", sourceTurn: 1, cause: "retracted" },
    { kind: "name", sourceTurn: 1, cause: "dependent" },
  ]);
  // Before the retraction turn, the proposal was still current.
  const before = figure(buildMemoryEvidence(graph, { asOfSeq: 1, events: ev }), A);
  assert.equal(before.name!.text, "鳥");
  assert.deepEqual(before.retracted, []);
});

test("revisit after defer is kept, and a later name supersedes the focus", () => {
  const ev: Event[] = [
    { seq: 1, speaker: "human", text: "丸い図形は後で" },
    { seq: 2, speaker: "human", text: "丸い図形に戻りましょう" },
    { seq: 3, speaker: "ai", text: "丸い図形は月にしませんか" },
  ];
  const steps = [
    { turn: 1, ops: [mention(1, "m", { quote: "丸い図形は後で", slots: [C] }), { kind: "focus", id: "1:d", slot: C, mode: "defer", mentionId: "1:m" }] },
    { turn: 2, ops: [mention(2, "m", { quote: "丸い図形に戻りましょう", slots: [C] }), { kind: "focus", id: "2:r", slot: C, mode: "revisit", mentionId: "2:m" }] },
    { turn: 3, ops: [mention(3, "m", { speaker: "ai", quote: "月にしませんか", intent: "name_proposal", slots: [C] }),
      { kind: "name", id: "3:n", slot: C, name: "月", agreement: "none", mentionIds: ["3:m"], replaces: null }] },
  ];
  // The shadow always reads the committed graph at the judged point (pre-turn graph), so build each one.
  const at = (turn: number) => figure(buildMemoryEvidence(build(steps.slice(0, turn), ev), { asOfSeq: turn, events: ev }), C);
  assert.deepEqual(at(1).focus, { mode: "defer", turn: 1 });
  assert.equal(at(1).memoryStatus, "deferred");
  assert.deepEqual(at(2).focus, { mode: "revisit", turn: 2 });
  assert.equal(at(2).memoryStatus, "unassigned");
  const after = at(3);
  assert.equal(after.focus, null);
  assert.deepEqual(after.name, { text: "月", agreement: "none", visibility: "public", proposedBy: ["ai"], sourceTurns: [3] });
});

test("future turns are cut: records and names after asOfSeq never appear", () => {
  const graph = build(dialogueSteps, events);
  const early = buildMemoryEvidence(graph, { asOfSeq: 2, events })!;
  assert.equal(early.asOfTurn, 2);
  assert.equal(early.memoryTurn, 2);
  assert.equal(figure(early, A).name!.agreement, "none");
  assert.deepEqual(figure(early, B).featureReports.deniedTurns, []);
  assert.equal(figure(early, C).focus, null);
  assert.deepEqual(early.unresolvedReferences, []);
  const turns = JSON.stringify(early).match(/"(?:turn|sourceTurn)":(\d+)|Turns":\[([\d,]*)\]/g) ?? [];
  assert.ok(turns.every((t) => (t.match(/\d+/g) ?? []).every((n) => Number(n) <= 2)), turns.join(" "));
});

test("a name nobody said publicly up to the judged point is AI-private and never agreed", () => {
  const graph = build(dialogueSteps, events);
  // Simulate the public record being unavailable for that name (e.g. a different event list).
  const redacted = events.map((e) => ({ ...e, text: e.text.replaceAll("鳥", "○") }));
  const a = figure(buildMemoryEvidence(graph, { asOfSeq: 6, events: redacted }), A);
  assert.deepEqual(a.name, { text: null, agreement: "none", visibility: "ai_private", proposedBy: ["human"], sourceTurns: [2, 3] });
  assert.equal(a.memoryStatus, "tentative");
  assert.ok(!JSON.stringify(buildMemoryEvidence(graph, { asOfSeq: 6, events: redacted })).includes("鳥"));
});

test("a short name that appears elsewhere but not in its own cited turns is not public", () => {
  const ev: Event[] = [
    { seq: 1, speaker: "ai", text: "家にしませんか" },
    { seq: 2, speaker: "human", text: "家の近くで見た形かも" },
  ];
  const graph = build([{ turn: 1, ops: [mention(1, "m", { speaker: "ai", quote: "家にしませんか", intent: "name_proposal" }),
    { kind: "name", id: "1:n", slot: A, name: "家", agreement: "none", mentionIds: ["1:m"], replaces: null }] }], ev.slice(0, 1));
  assert.equal(figure(buildMemoryEvidence(graph, { asOfSeq: 2, events: ev }), A).name!.visibility, "public");
  // Same dialogue, but the cited turn is unavailable: "家" in an unrelated turn does not make the name public.
  const elsewhere = [{ seq: 1, speaker: "ai" as const, text: "これにしませんか" }, ev[1]];
  const a = figure(buildMemoryEvidence(graph, { asOfSeq: 2, events: elsewhere }), A);
  assert.deepEqual([a.name!.visibility, a.name!.text, a.name!.agreement], ["ai_private", null, "none"]);
});

test("no free text, labels or private fields leak: only closed vocabulary, own ids, numbers and public names", () => {
  const graph = build(dialogueSteps, events);
  const evidence = buildMemoryEvidence(graph, { asOfSeq: 6, events })!;
  const json = JSON.stringify(evidence);
  for (const secret of ["M2", "尖り", "細長い", "後にしましょう", "1:q", "3:n", "own_image", "key", "gold", "label", "partner"]) {
    assert.ok(!json.includes(secret), secret);
  }
  const vocabulary = new Set([...ids, "鳥", "memory_evidence_v1", "ai_private_interpretation_not_ground_truth",
    "human", "ai", "refer", "name_proposal", "name_acceptance", "feature_assertion", "feature_acceptance", "denial", "correction",
    "acknowledgment", "unassigned", "tentative", "agreed", "deferred", "none", "implicit", "explicit", "public", "ai_private",
    "defer", "revisit", "mention", "feature", "name", "question", "focus", "retracted", "dependent"]);
  const strings: string[] = [];
  JSON.parse(json, (_key, value) => { if (typeof value === "string") strings.push(value); return value; });
  assert.ok(strings.every((s) => vocabulary.has(s)), strings.filter((s) => !vocabulary.has(s)).join(","));
  // Extra fields smuggled into events are ignored.
  const smuggled = events.map((e) => ({ ...e, label: "ER1", gold: "P3", partnerSlot: "x" }));
  assert.deepEqual(buildMemoryEvidence(graph, { asOfSeq: 6, events: smuggled }), evidence);
});

test("output is deterministic and restoring a persisted graph yields the same summary", () => {
  const graph = build(dialogueSteps, events);
  const first = JSON.stringify(buildMemoryEvidence(graph, { asOfSeq: 6, events }));
  assert.equal(JSON.stringify(buildMemoryEvidence(graph, { asOfSeq: 6, events })), first);
  const restored = JSON.parse(JSON.stringify(graph));
  assert.equal(JSON.stringify(buildMemoryEvidence(restored, { asOfSeq: 6, events })), first);
  // A graph rebuilt from the same steps is identical too.
  assert.equal(JSON.stringify(buildMemoryEvidence(build(dialogueSteps, events), { asOfSeq: 6, events })), first);
  // Building does not mutate the graph.
  assert.deepEqual(restored, JSON.parse(JSON.stringify(graph)));
});

test("the size cap holds with many records and reports omissions", () => {
  const ev: Event[] = [];
  const steps: { turn: number; ops: Op[] }[] = [];
  for (let turn = 1; turn <= 30; turn++) {
    const name = "とても長い名前".repeat(11) + turn;
    ev.push({ seq: turn, speaker: "human", text: `細長い図形 ${name}にしましょう` });
    const slot = ids[turn % 6];
    steps.push({ turn, ops: [
      mention(turn, "m", { quote: `${name}にしましょう`, slots: [slot], intent: "name_proposal" }),
      mention(turn, "h", { quote: "細長い図形", slots: [slot, ids[(turn + 1) % 6]], epistemic: "hypothesis" }),
      mention(turn, "u", { quote: "細長い図形", slots: [], epistemic: "unresolved", confidence: 0 }),
      { kind: "name", id: `${turn}:n`, slot, name, agreement: "none", mentionIds: [`${turn}:m`],
        replaces: turn > 6 ? `${turn - 6}:n` : null },
    ] });
  }
  const graph = build(steps, ev);
  const evidence = buildMemoryEvidence(graph, { asOfSeq: 30, events: ev })!;
  assert.ok(JSON.stringify(evidence).length <= MEMORY_EVIDENCE_MAX_CHARS);
  assert.ok(evidence.omitted.entries > 0);
  // Current names are never dropped by the cap.
  assert.ok(evidence.figures.every((f) => f.name?.visibility === "public" && f.name.text));
});

test("invalid inputs fail closed with a code", () => {
  const graph = build(dialogueSteps, events);
  const code = (fn: () => unknown, expected: string) =>
    assert.throws(fn, (error: unknown) => error instanceof MemoryEvidenceError && error.code === expected);
  code(() => buildMemoryEvidence(graph, { asOfSeq: 0, events }), "invalid_as_of");
  code(() => buildMemoryEvidence(graph, { asOfSeq: 2, events: [events[1], events[0]] }), "invalid_public_events");
  code(() => buildMemoryEvidence({ ...graph, schemaVersion: 2 }, { asOfSeq: 2, events }), "invalid_graph");
  code(() => buildMemoryEvidence({ ...graph, records: [{ ...graph.records[0], label: "M1" }, ...graph.records.slice(1)] }, { asOfSeq: 2, events }), "invalid_graph");
});

test("the summary fits the grounding evidence's generic JSON bounds", () => {
  const graph = build(dialogueSteps, events);
  const evidence = buildMemoryEvidence(graph, { asOfSeq: 6, events })!;
  assert.ok(!Object.hasOwn(evidence, "status"));
  const check = (node: unknown, depth: number): void => {
    if (node === null || typeof node === "boolean" || typeof node === "number") return;
    if (typeof node === "string") { assert.ok(node.length <= 200); return; }
    assert.ok(depth < 5, "depth");
    const entries = Array.isArray(node) ? node : Object.entries(node as object);
    assert.ok(entries.length <= 24);
    if (Array.isArray(node)) node.forEach((item) => check(item, depth + 1));
    else for (const [key, value] of Object.entries(node as object)) { assert.match(key, /^[A-Za-z][A-Za-z0-9_]{0,39}$/); check(value, depth + 1); }
  };
  check(evidence, 0);
});
