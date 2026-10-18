// Two-axis grounding evidence state: whitelist, future-turn guard, cross-turn context, bounds. Synthetic text only.
import test from "node:test";
import assert from "node:assert/strict";
import { buildGroundingEvidence, GroundingEvidenceError, GROUNDING_PUBLIC_TURNS } from "../dialogue-model/runtime/grounding/evidence.ts";
import { GROUNDING_MAX_STATE_CHARS } from "../workers/research-ai-proxy/src/grounding.ts";

const notes = { "s-0001": { status: "tentative" as const, name: "鳥" }, "s-0002": { status: "unassigned" as const, name: null } };
const events = [
  { seq: 1, speaker: "ai", text: "まず、どの図形から話しましょうか？" },
  { seq: 2, speaker: "human", text: "三角が二つくっついたのから" },
  { seq: 3, speaker: "ai", text: "尖りが二つあるものですね" },
  { seq: 4, speaker: "human", text: "そう、それを鳥にしませんか" },
];
const hypothesis = { action: "propose_name", targetSlot: "s-0001", candidateName: "鳥", discriminatingFeature: "尖りが二つ" };
const parse = (state: string) => JSON.parse(state);
const code = (fn: () => unknown) => { try { fn(); } catch (error) { assert.ok(error instanceof GroundingEvidenceError); return (error as GroundingEvidenceError).code; } return "ok"; };

test("only whitelisted public and AI-side fields reach the state (answer-key leakage guard)", () => {
  const leaky = events.map((event) => ({ ...event, id: "event-" + event.seq, partnerSlot: "h-SECRET", gold: "SECRET_GOLD", figureId: "SECRET_FIG" }));
  const { state } = buildGroundingEvidence({
    events: leaky, asOfSeq: 4, ownNamingNotes: notes,
    aiHypothesis: { ...hypothesis, note: "SECRET_NOTE", answerKey: { "s-0001": "SECRET_FIG" } } as never,
    priorAiActs: [{ turn: 2, action: "confirm", targetSlot: "s-0001", candidateName: null, gold: "SECRET" } as never],
    ...({ answerKey: "SECRET_KEY", partnerImage: "SECRET_IMG", strategy: "bypass-enabled", goldLabels: ["M4"] } as object),
  } as never);
  assert.doesNotMatch(state, /SECRET|partnerSlot|figureId|answerKey|gold|bypass|repair-first|strategy|M4/);
  const value = parse(state);
  assert.deepEqual(Object.keys(value), ["task", "judgedPoint", "publicDialogue", "omittedEarlierTurns", "aiSideClaims", "aiOwnNotes", "aiPriorActsOnTarget"]);
  assert.deepEqual(value.publicDialogue[1], { turn: 2, speaker: "相手", text: "三角が二つくっついたのから" });
  assert.match(value.aiSideClaims.status, /未検証の仮説/);
  assert.match(value.aiOwnNotes.status, /正解表ではなく/);
});

test("future turns are dropped: the judgment is about the evidence before the next AI utterance", () => {
  const future = [...events, { seq: 5, speaker: "ai", text: "FUTURE_AI では鳥で決まりですね" }, { seq: 6, speaker: "human", text: "FUTURE_HUMAN はい" }];
  const { state, turns } = buildGroundingEvidence({ events: future, asOfSeq: 4, aiHypothesis: hypothesis, ownNamingNotes: notes,
    priorAiActs: [{ turn: 5, action: "agree", targetSlot: "s-0001", candidateName: "鳥" }] });
  assert.doesNotMatch(state, /FUTURE/);
  assert.equal(turns, 4);
  assert.deepEqual(parse(state).aiPriorActsOnTarget, []);
  assert.match(parse(state).judgedPoint, /turn 4/);
});

test("cross-turn references keep turn numbers and earlier AI acts on the same target only", () => {
  const { state } = buildGroundingEvidence({ events, asOfSeq: 4, aiHypothesis: hypothesis, ownNamingNotes: notes,
    priorAiActs: [{ turn: 2, action: "confirm", targetSlot: "s-0001", candidateName: null },
      { turn: 2, action: "propose_name", targetSlot: "s-0002", candidateName: "船" }] });
  const value = parse(state);
  assert.deepEqual(value.publicDialogue.map((turn: { turn: number }) => turn.turn), [1, 2, 3, 4]);
  assert.deepEqual(value.aiPriorActsOnTarget, [{ turn: 2, action: "confirm", candidateName: null }]);
  assert.deepEqual(value.aiSideClaims.targetRef, "s-0001");
});

test("input insufficiency is explicit: no partner utterance fails, a missing hypothesis is a recorded gap", () => {
  assert.equal(code(() => buildGroundingEvidence({ events: [events[0]], asOfSeq: 1 })), "no_partner_utterance");
  assert.equal(code(() => buildGroundingEvidence({ events, asOfSeq: 1 })), "no_partner_utterance");
  const bare = buildGroundingEvidence({ events: [events[1]], asOfSeq: 2 });
  assert.deepEqual(bare.gaps, ["no_target_hypothesis", "no_ai_turn_yet"]);
  assert.equal(parse(bare.state).aiSideClaims, null);
  const nameless = buildGroundingEvidence({ events, asOfSeq: 4, aiHypothesis: { action: "accept", targetSlot: null, candidateName: null, discriminatingFeature: null } });
  assert.deepEqual(nameless.gaps, ["no_target_hypothesis"]);
});

test("malformed input is rejected rather than forwarded", () => {
  assert.equal(code(() => buildGroundingEvidence({ events: [{ ...events[1], speaker: "partner" }], asOfSeq: 2 })), "invalid_public_events");
  assert.equal(code(() => buildGroundingEvidence({ events: [events[1], events[0]], asOfSeq: 2 })), "invalid_public_events");
  assert.equal(code(() => buildGroundingEvidence({ events: [{ ...events[1], text: "x".repeat(2001) }], asOfSeq: 2 })), "invalid_public_events");
  assert.equal(code(() => buildGroundingEvidence({ events, asOfSeq: 0 })), "invalid_public_events");
  assert.equal(code(() => buildGroundingEvidence({ events, asOfSeq: 4, ownNamingNotes: notes,
    aiHypothesis: { ...hypothesis, targetSlot: "h-partner-id" } })), "invalid_ai_hypothesis");
  assert.equal(code(() => buildGroundingEvidence({ events, asOfSeq: 4, ownNamingNotes: { x: { status: "correct", name: null } } as never })), "invalid_own_notes");
  assert.equal(code(() => buildGroundingEvidence({ events, asOfSeq: 4, priorAiActs: [{ turn: "2" }] as never })), "invalid_prior_acts");
});

test("long dialogues keep the newest turns within the state bound and record the omission", () => {
  const many = Array.from({ length: 60 }, (_, index) => ({ seq: index + 1, speaker: index % 2 ? "ai" : "human", text: `turn${index + 1} ` + "あ".repeat(1_900) }));
  const { state, gaps, turns } = buildGroundingEvidence({ events: many, asOfSeq: 60, aiHypothesis: hypothesis, ownNamingNotes: notes });
  assert.ok(state.length <= GROUNDING_MAX_STATE_CHARS);
  assert.ok(turns < GROUNDING_PUBLIC_TURNS && turns > 0);
  assert.ok(gaps.includes("earlier_turns_omitted"));
  const value = parse(state);
  assert.equal(value.publicDialogue.at(-1).turn, 60);
  assert.equal(value.omittedEarlierTurns, 60 - turns);
  const short = buildGroundingEvidence({ events: many.map((event) => ({ ...event, text: "短い" })), asOfSeq: 60 });
  assert.equal(short.turns, GROUNDING_PUBLIC_TURNS);
});

test("the state is identical whatever strategy the caller runs (no strategy input exists)", () => {
  const a = buildGroundingEvidence({ events, asOfSeq: 4, aiHypothesis: hypothesis, ownNamingNotes: notes });
  const b = buildGroundingEvidence({ events, asOfSeq: 4, aiHypothesis: hypothesis, ownNamingNotes: notes, ...({ strategy: "bypass-enabled" } as object) } as never);
  assert.equal(a.state, b.state);
});

test("memoryEvidence is optional: absent keeps the state byte-identical; present is bounded and labelled unverified", () => {
  const base = { events, asOfSeq: 4, aiHypothesis: hypothesis, ownNamingNotes: notes };
  const off = buildGroundingEvidence(base).state;
  assert.equal(buildGroundingEvidence({ ...base, memoryEvidence: null }).state, off);
  assert.equal(buildGroundingEvidence({ ...base, memoryEvidence: undefined }).state, off);
  const summary = { target: { epistemic: "hypothesized", nameAgreement: "proposed", openQuestions: 1, retracted: false } };
  const on = parse(buildGroundingEvidence({ ...base, memoryEvidence: summary }).state);
  const { status, ...memory } = on.aiMemory;
  assert.deepEqual(memory, summary);
  assert.match(status, /正解表でも照合済みの事実でもなく/);
  assert.deepEqual(Object.keys(on).at(-1), "aiMemory");
  assert.deepEqual({ ...on, aiMemory: undefined }, { ...parse(off), aiMemory: undefined });
  for (const bad of [[], "text", { "bad key": 1 }, { a: { b: { c: { d: { e: { f: 1 } } } } } }, { status: "spoofed" }, { a: "x".repeat(201) },
    { a: Array.from({ length: 25 }, () => 1) }, { a: Number.NaN }, { a: new Date() }, { a: Array.from({ length: 24 }, () => "y".repeat(190)) }]) {
    assert.equal(code(() => buildGroundingEvidence({ ...base, memoryEvidence: bad as never })), "invalid_memory_evidence");
  }
});
