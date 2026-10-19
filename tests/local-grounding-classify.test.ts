// Closed-set adapters and deterministic mocks only; no real Jev/Luna calls.
import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { createLocalFunctionClassifier, createLunaLocalClassifier, buildLocalClassificationState, parseLocalFunctionVerdicts,
  LocalClassificationError } from "../dialogue-model/runtime/local-grounding/classify.ts";
import { createMockLocalClassifier, LocalMockError } from "../dialogue-model/runtime/local-grounding/mocks.ts";
import type { LocalClassificationInput, LocalClaimView, LocalFunctionVerdict } from "../dialogue-model/runtime/local-grounding/contract.ts";

const input: LocalClassificationInput = { turn: 3,
  publicTurns: [{ turn: 1, speaker: "human", text: "船みたい" }, { turn: 2, speaker: "ai", text: "船と呼びませんか" },
    { turn: 3, speaker: "human", text: "船にしましょう。向きは保留です" }],
  segments: [{ segmentId: "s1", quote: "船にしましょう", targets: ["own-a"], aspect: "name", proposition: "船という名前を採用",
    name: "船", linkedIssueId: "1:name", respondsToTurn: 2 }],
  priorClaims: [{ id: "2:ai1", turn: 2, issueId: "1:name", targets: ["own-a"], aspect: "name", act: "name_propose",
    proposition: "船という名前を提案", name: "船", speaker: "ai", sourceTurn: 2, quote: "船と呼びませんか",
    respondsTo: null, source: "ai_hypothesis" }] };
const verdict: LocalFunctionVerdict = { segmentId: "s1", act: "name_accept", respondsToClaimId: "2:ai1", rawScore: 0.7 };
const code = (wanted: string) => (e: unknown) => e instanceof LocalClassificationError && e.code === wanted;

test("state builder carries public context and candidate AI claims, with identical bytes for both strategies", () => {
  const states = ["repair-first", "bypass-enabled"].map((strategy) => buildLocalClassificationState({ ...input, strategy,
    gold: "GOLD_CANARY", partnerImage: "PARTNER_CANARY", publicTurns: [...input.publicTurns.map((t) => ({ ...t, secret: "SECRET_CANARY" })),
      { turn: 4, speaker: "human", text: "FUTURE_CANARY" }, { turn: 3, speaker: "ai", text: "UNPUBLISHED_CANARY" }],
    segments: input.segments.map((s) => ({ ...s, gold: "GOLD_CANARY" })),
    priorClaims: input.priorClaims.map((c) => ({ ...c, gold: "GOLD_CANARY" })) } as LocalClassificationInput));
  assert.equal(states[0], states[1]);
  assert.doesNotMatch(states[0], /CANARY|strategy|repair-first|bypass-enabled/);
  const state = JSON.parse(states[0]);
  assert.equal(state.priorClaims[0].id, "2:ai1");
  assert.deepEqual(Object.keys(state.priorClaims[0]), ["id", "aspect", "targets", "act", "speaker", "sourceTurn", "proposition", "name"]);
});

test("AI claims staged on this update remain eligible; future and out-of-window source claims are excluded", () => {
  const original = input.priorClaims[0];
  const state = JSON.parse(buildLocalClassificationState({ ...input, priorClaims: [{ ...original, turn: 3 },
    { ...original, id: "4:future", turn: 4, sourceTurn: 4, proposition: "FUTURE_CANARY" },
    { ...original, id: "1:old", turn: 1, sourceTurn: 1, speaker: "ai", proposition: "WINDOW_CANARY" }] }));
  assert.equal(state.priorClaims.length, 1);
  assert.equal(state.priorClaims[0].id, original.id);
  assert.doesNotMatch(JSON.stringify(state), /CANARY/);
});

test("strict parser normalizes only out-of-set acts to unknown, preserving raw score as research data", () => {
  assert.deepEqual(parseLocalFunctionVerdicts(JSON.stringify([verdict]), input), [verdict]);
  assert.deepEqual(parseLocalFunctionVerdicts([{ ...verdict, act: "gold_agreed" }], input),
    [{ ...verdict, act: "unknown", respondsToClaimId: null }]);
  assert.deepEqual(parseLocalFunctionVerdicts([{ ...verdict, rawScore: -5 }], input), [{ ...verdict, rawScore: -5 }]);
});

test("unknown/missing keys, malformed JSON, bad ids and duplicate/missing verdicts reject the response", () => {
  assert.throws(() => parseLocalFunctionVerdicts("RAW_SECRET", input), code("invalid_json"));
  for (const v of [[{ ...verdict, confidence: 1 }], [{ ...verdict, rawScore: "1" }], [{ ...verdict, rawScore: Infinity }],
    [{ ...verdict, respondsToClaimId: false }], [{ ...verdict, act: "" }], [{ ...verdict, rawScore: undefined }],
    [{ ...verdict, act: "x".repeat(65) }], [{ ...verdict, respondsToClaimId: "x".repeat(129) }]]) {
    assert.throws(() => parseLocalFunctionVerdicts(v, input), code("invalid_response"));
  }
  for (const v of [[], [{ ...verdict, segmentId: "future-segment" }], [verdict, verdict], { verdicts: [verdict] }, null]) {
    assert.throws(() => parseLocalFunctionVerdicts(v, input), code("segment_mismatch"));
  }
  const two = { segments: [input.segments[0], { ...input.segments[0], segmentId: "s2" }] };
  assert.throws(() => parseLocalFunctionVerdicts([verdict, verdict], two), code("segment_mismatch"));
  assert.deepEqual(parseLocalFunctionVerdicts([{ ...verdict, segmentId: "s2" }, verdict], two), [verdict, { ...verdict, segmentId: "s2" }]);
});

test("Luna stand-in uses its own phase and immutable classifierKind metadata", async () => {
  const requests: string[] = [];
  const classifier = createLunaLocalClassifier({ async complete(messages, options) {
    assert.equal(options.phase, "local_classification");
    assert.equal(options.timeoutMs, 1234);
    assert.equal(options.signal.aborted, false);
    requests.push(JSON.stringify(messages));
    return { text: JSON.stringify([verdict]) };
  } });
  assert.deepEqual(classifier.metadata, { classifierKind: "luna_standin", calibrated: false });
  assert.equal(Object.isFrozen(classifier.metadata), true);
  for (const strategy of ["repair-first", "bypass-enabled"]) {
    assert.deepEqual(await classifier.classify({ ...input, strategy } as LocalClassificationInput, { timeoutMs: 1234 }), [verdict]);
  }
  assert.equal(requests[0], requests[1]);
  assert.doesNotMatch(requests[0], /strategy|repair-first|bypass-enabled/);
});

test("transport-independent classifier labels injected calls as unverified and records scores without promotion", async () => {
  const classifier = createLocalFunctionClassifier({ classifierKind: "unverified_injected", call: async (state) => {
    assert.equal(state, buildLocalClassificationState(input));
    return [{ ...verdict, rawScore: 1 }];
  } });
  assert.deepEqual(classifier.metadata, { classifierKind: "unverified_injected", calibrated: false });
  assert.deepEqual(await classifier.classify(input), [{ ...verdict, rawScore: 1 }]);
});

test("classifierKind is required and verified Jev labels are rejected before any call", () => {
  let calls = 0;
  const call = async () => { calls++; return [verdict]; };
  // @ts-expect-error Omission must fail both the public type and runtime validation.
  assert.throws(() => createLocalFunctionClassifier({ call }), code("invalid_input"));
  // @ts-expect-error A verified Jev route is not implemented or validated.
  assert.throws(() => createLocalFunctionClassifier({ call, classifierKind: "jev" }), code("invalid_input"));
  // @ts-expect-error Arbitrary injected metadata must not claim a verified classifier.
  assert.throws(() => createLocalFunctionClassifier({ call, classifierKind: "verified" }), code("invalid_input"));
  assert.equal(calls, 0);
});

test("invalid input fails locally; empty segments make no call", async () => {
  let calls = 0;
  const classifier = createLocalFunctionClassifier({ classifierKind: "unverified_injected", call: async () => { calls++; return [verdict]; } });
  const badClaim = { ...input.priorClaims[0], quote: "公開されていない名前" };
  for (const value of [{ ...input, turn: 0 }, { ...input, publicTurns: [] }, { ...input, segments: [input.segments[0], input.segments[0]] },
    { ...input, segments: [{ ...input.segments[0], quote: "別発話" }] }, { ...input, priorClaims: [badClaim] },
    { ...input, priorClaims: [{ ...input.priorClaims[0], source: "gold" } as unknown as LocalClaimView] }]) {
    await assert.rejects(classifier.classify(value), code("invalid_input"));
  }
  assert.deepEqual(await classifier.classify({ ...input, segments: [] }), []);
  assert.equal(calls, 0);
});

test("timeout and caller abort are enforced around a call ignoring cancellation", async () => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  const classifier = createLocalFunctionClassifier({ classifierKind: "unverified_injected", call: (_state, options) => { calls++; signal = options.signal; return new Promise(() => {}); } });
  await assert.rejects(classifier.classify(input, { timeoutMs: 5 }), code("timeout"));
  assert.equal(signal?.aborted, true);
  const controller = new AbortController();
  const pending = classifier.classify(input, { signal: controller.signal });
  await Promise.resolve();
  controller.abort("sk-secret");
  await assert.rejects(pending, code("aborted"));
  await assert.rejects(classifier.classify(input, { signal: controller.signal }), code("aborted"));
  assert.equal(calls, 2);
});

test("errors never retain raw provider text, arbitrary codes, prompts, secrets or causes", async () => {
  for (const call of [async () => { throw Object.assign(new Error("sk-secret PROMPT_CANARY RAW_CANARY"), { code: "SECRET_CODE", cause: "RAW_CANARY" }); },
    async () => "RAW_CANARY sk-secret", async () => [{ ...verdict, private: "RAW_CANARY sk-secret" }]]) {
    await assert.rejects(createLocalFunctionClassifier({ classifierKind: "unverified_injected", call }).classify(input), (e: unknown) => {
      assert.ok(e instanceof LocalClassificationError);
      assert.doesNotMatch(inspect(e, { showHidden: true }) + JSON.stringify(e), /sk-secret|CANARY|SECRET_CODE/);
      assert.equal(Object.hasOwn(e, "cause"), false);
      return true;
    });
  }
  const forged = Object.assign(new LocalClassificationError("invalid_response"), { code: "sk-secret", prompt: "PROMPT_CANARY" });
  await assert.rejects(createLocalFunctionClassifier({ classifierKind: "unverified_injected", call: async () => { throw forged; } }).classify(input), (e: unknown) => {
    assert.ok(e instanceof LocalClassificationError);
    assert.equal(e.code, "unavailable");
    assert.doesNotMatch(inspect(e), /sk-secret|CANARY/);
    return true;
  });
  await assert.rejects(createLocalFunctionClassifier({ classifierKind: "unverified_injected", call: async () => { throw { code: "timeout", raw: "RAW_CANARY" }; } }).classify(input), code("timeout"));
});

test("classification snapshots segment ids before awaiting the injected call", async () => {
  const mutable = structuredClone(input);
  const classifier = createLocalFunctionClassifier({ classifierKind: "unverified_injected", call: async () => {
    mutable.segments[0].segmentId = "changed";
    return [verdict];
  } });
  assert.deepEqual(await classifier.classify(mutable), [verdict]);
});

test("classifier mocks support callbacks, delayed failures, timeout and abort", async () => {
  let signal: AbortSignal | undefined;
  const mock = createMockLocalClassifier((_input, options) => { signal = options.signal; return [verdict]; });
  assert.deepEqual(await mock.classify(input), [verdict]);
  assert.equal(signal?.aborted, false);
  await assert.rejects(createMockLocalClassifier(() => { throw new Error("SECRET_CANARY"); }, { delayMs: 1 }).classify(input),
    (e: unknown) => e instanceof LocalMockError && e.code === "mock_failure" && !inspect(e).includes("SECRET_CANARY"));
  const hanging = createMockLocalClassifier(() => new Promise(() => {}));
  await assert.rejects(hanging.classify(input, { timeoutMs: 5 }), (e: unknown) => e instanceof LocalMockError && e.code === "timeout");
  const controller = new AbortController();
  const pending = hanging.classify(input, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (e: unknown) => e instanceof LocalMockError && e.code === "aborted");
});
