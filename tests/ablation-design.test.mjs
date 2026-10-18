import test from "node:test";
import assert from "node:assert/strict";
import { ABLATION_SCHEMA, AblationDesignError, planAblation, normalizeTrialOutcome,
  trialRunFromRecord, summarizeAblation } from "../dialogue-model/runtime/diagnostics/ablation-design.mjs";
import { conditionOf } from "../dialogue-model/runtime/diagnostics/grounding-metrics.mjs";
import { SLOTS } from "../dialogue-model/runtime/stimuli/board.mjs";

const MODEL = { model: "synthetic-model-v1", purpose: "dialogue_turn", maxCompletionTokens: 8192 };
const IMAGES = { stimulusVersion: "synthetic-stimulus-v1", visualAidVersion: "synthetic-rotation-v1" };
// Entirely model-free synthetic measurements; no participant data or answer keys.
const actions = (extra = {}) => Object.fromEntries(ABLATION_SCHEMA.actions.map((a) => [a, extra[a] ?? 0]));
const config = () => ({ seeds: [12, -3], modelConfig: { ...MODEL }, imageConfig: { ...IMAGES } });
const outcome = (overrides = {}) => ({ status: "completed", turns: { human: 2, ai: 3 }, score: 4,
  api: { requests: 6, errors: 1, retries: 2 }, ledgerFinalDifferences: 1,
  actions: actions({ confirm: 2, defer: 1, accept: 1 }), ...overrides });
const records = (plan = planAblation(config())) => plan.runs.map((r) => ({ ...structuredClone(r),
  ownImageSha256: (r.seed < 0 ? "a" : "b").repeat(64),
  visualAidSha256: r.options.visualAid ? (r.seed < 0 ? "c" : "d").repeat(64) : null,
  outcome: outcome() }));
const cell = "repair-first|visualAid=false|referenceMemory=false";
const reject = (fn, code) => assert.throws(fn, (error) => error instanceof AblationDesignError && error.code === code);
function rawRecord(overrides = {}) {
  return { seed: -3, strategy: "repair-first", options: { visualAid: false, referenceMemory: false }, status: "completed",
    publicHistory: [{ role: "user", content: "synthetic public turn" }, { role: "assistant", content: "synthetic response" }],
    judgments: [
      { status: "committed", judgment: { action: "defer", followUp: { action: "confirm" } } },
      { status: "generation_error", judgment: { action: "repair" } },
      { status: "committed", judgment: { action: "revisit" } },
    ],
    ownLedger: Object.fromEntries(SLOTS.map((slot) => [slot, { name: null, status: "unassigned" }])),
    aiSubmission: Object.fromEntries(SLOTS.map((slot) => [slot, ""])),
    scoring: { result: { matchedCount: 4, total: 6, provisional: true } },
    requests: [{ status: "ok", model: MODEL.model, retryCount: 0 }, { status: "error", model: null, retryCount: 2 }],
    ...overrides };
}
const metadata = () => ({ modelConfig: { ...MODEL }, imageConfig: { ...IMAGES }, ownImageSha256: "a".repeat(64), visualAidSha256: null });

test("plans eight cells per seed deterministically, detached and frozen, without a turn floor", () => {
  const input = config(), snapshot = structuredClone(input), plan = planAblation(input);
  assert.deepEqual(input, snapshot);
  assert.equal(plan.runs.length, 16);
  assert.deepEqual(plan.seeds, [-3, 12]);
  assert.equal(new Set(plan.runs.map((r) => r.seed + "|" + conditionOf(r))).size, 16);
  assert.ok(plan.researcherOnly && plan.dryRun);
  assert.deepEqual(plan, planAblation({ ...config(), seeds: [-3, 12] }));
  assert.throws(() => { plan.runs[0].options.visualAid = true; }, TypeError);
  input.modelConfig.model = "other-model";
  assert.equal(plan.modelConfig.model, MODEL.model);
  assert.ok(!JSON.stringify(plan).includes("60"));
});

test("planning rejects empty, duplicate, unsafe, nonnumeric and missing seeds", () => {
  for (const seeds of [[], [1, 1], [1.5], [NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1], ["1"], undefined]) {
    reject(() => planAblation({ ...config(), seeds }), "invalid_seeds");
  }
  reject(() => planAblation(), "invalid_schema");
});

test("model and image settings must be explicit, bounded metadata with no secrets or prompt fields", () => {
  for (const model of [null, "", "model with prompt text", "https://model?token=value"]) {
    reject(() => planAblation({ ...config(), modelConfig: { ...MODEL, model } }), "invalid_model_config");
  }
  for (const maxCompletionTokens of [0, -1, 1.5, "8192", Infinity]) {
    reject(() => planAblation({ ...config(), modelConfig: { ...MODEL, maxCompletionTokens } }), "invalid_model_config");
  }
  reject(() => planAblation({ ...config(), modelConfig: { ...MODEL, purpose: "other" } }), "invalid_model_config");
  reject(() => planAblation({ ...config(), imageConfig: { ...IMAGES, stimulusVersion: "data:image/png;base64,forbidden" } }), "invalid_image_config");
  for (const key of ["apiKey", "prompt", "gold", "humanImage", "privateTranscript", "hiddenLabels", "runDir", "live"]) {
    reject(() => planAblation({ ...config(), [key]: "forbidden-payload" }), "invalid_schema");
    reject(() => planAblation({ ...config(), modelConfig: { ...MODEL, [key]: "forbidden-payload" } }), "invalid_schema");
  }
  reject(() => planAblation(Object.create(config())), "invalid_schema");
});

test("private adapter normalizes matchedCount, committed acts, speaker counts, retry errors and literal memory difference", () => {
  const record = rawRecord();
  record.aiSubmission[SLOTS[0]] = "synthetic final name";
  const result = normalizeTrialOutcome(record);
  assert.deepEqual(result.turns, { human: 1, ai: 1 });
  assert.equal(result.score, 4);
  assert.deepEqual(result.api, { requests: 2, errors: 1, retries: 2 });
  assert.equal(result.ledgerFinalDifferences, 1);
  assert.deepEqual(result.actions, actions({ defer: 1, confirm: 1, revisit: 1 }));
  assert.ok(Object.isFrozen(result.actions));
  assert.ok(!JSON.stringify(result).includes("synthetic"));
});

test("zero final score is preserved; a six-point total is not mistaken for the achieved score", () => {
  for (const matchedCount of [0, 1, 6]) {
    assert.equal(normalizeTrialOutcome(rawRecord({ scoring: { result: { matchedCount, total: 6 } } })).score, matchedCount);
  }
  for (const result of [{ score: 6, total: 6 }, { correct: 6, total: 6 }, { matchedCount: 7, total: 6 },
    { matchedCount: -1, total: 6 }, { matchedCount: 1.5, total: 6 }, { matchedCount: "4", total: 6 },
    { matchedCount: 4 }, { matchedCount: 4, total: 8 }]) {
    reject(() => normalizeTrialOutcome(rawRecord({ scoring: { result } })), "invalid_score");
  }
});

test("normalization never reads gold, human submission, images, hidden labels or private transcripts", () => {
  const record = rawRecord();
  for (const key of ["humanSubmission", "humanImage", "key", "privateTranscript", "gold", "hiddenLabels", "referenceGraph"]) {
    Object.defineProperty(record, key, { get() { throw new Error("Forbidden field accessed"); } });
  }
  Object.defineProperty(record.scoring, "key", { get() { throw new Error("Answer key accessed"); } });
  Object.defineProperty(record.scoring.result, "figures", { get() { throw new Error("Scored identities accessed"); } });
  assert.equal(normalizeTrialOutcome(record).score, 4);
  assert.equal(trialRunFromRecord(record, metadata()).outcome.score, 4);
});

test("unfinished trials do not read scoring, and missing measurements remain null rather than zero", () => {
  const record = { status: "dialogue" };
  Object.defineProperty(record, "scoring", { get() { throw new Error("Premature scoring accessed"); } });
  assert.deepEqual(normalizeTrialOutcome(record), { status: "dialogue", turns: null, score: null,
    api: null, actions: null, ledgerFinalDifferences: null });
  assert.equal(normalizeTrialOutcome({ status: "completed", scoring: null }).score, null);
  const empty = normalizeTrialOutcome(rawRecord({ status: "dialogue", publicHistory: [], judgments: [], requests: [], aiSubmission: null }));
  assert.deepEqual(empty.turns, { human: 0, ai: 0 });
  assert.deepEqual(empty.api, { requests: 0, errors: 0, retries: 0 });
  assert.deepEqual(empty.actions, actions());
  assert.equal(empty.ledgerFinalDifferences, null);
});

test("malformed raw counts and structures are rejected, not silently converted", () => {
  for (const [patch, code] of [
    [{ status: "unknown" }, "invalid_record"],
    [{ publicHistory: [{ role: "system", content: "synthetic" }] }, "invalid_history"],
    [{ publicHistory: [{ role: "user", content: null }] }, "invalid_history"],
    [{ judgments: [{ status: "committed", judgment: { action: "invented" } }] }, "invalid_judgments"],
    [{ judgments: {} }, "invalid_judgments"],
    [{ requests: [{ status: "ok", retryCount: undefined }] }, "invalid_requests"],
    [{ requests: [{ status: "error", retryCount: -1 }] }, "invalid_requests"],
    [{ ownLedger: {} }, "invalid_memory"],
    [{ aiSubmission: {} }, "invalid_memory"],
  ]) reject(() => normalizeTrialOutcome(rawRecord(patch)), code);
});

test("record binding derives conditions and verifies every observed response model", () => {
  const record = rawRecord(), bound = trialRunFromRecord(record, metadata());
  assert.equal(bound.seed, record.seed);
  assert.equal(bound.strategy, record.strategy);
  assert.deepEqual(bound.options, record.options);
  assert.deepEqual(bound.modelConfig, MODEL);
  assert.equal(bound.ownImageSha256, metadata().ownImageSha256);
  assert.deepEqual(bound.outcome, normalizeTrialOutcome(record));
  for (const requests of [
    [{ status: "ok", model: "other-model", retryCount: 0 }],
    [{ status: "ok", model: null, retryCount: 0 }],
    [...record.requests, { status: "ok", model: "other-model", retryCount: 0 }],
    [...record.requests, { status: "error", model: "other-model", retryCount: 0 }],
  ]) reject(() => trialRunFromRecord(rawRecord({ requests }), metadata()), "model_mismatch");
  for (const requests of [undefined, [], [{ status: "error", model: null, retryCount: 0 }]]) {
    reject(() => trialRunFromRecord(rawRecord({ requests }), metadata()), "missing_model_evidence");
  }
  reject(() => trialRunFromRecord(rawRecord({ options: undefined }), metadata()), "invalid_schema");
});

test("matched factorial aggregates cells and the twelve one-factor paired comparisons", () => {
  const plan = planAblation(config()), runs = records(plan);
  const result = summarizeAblation({ plan, runs });
  assert.equal(result.trials, 16);
  assert.equal(result.matchedSeeds, 2);
  assert.equal(Object.keys(result.cells).length, 8);
  assert.equal(Object.keys(result.pairedComparisons).length, 12);
  assert.equal(result.cells[cell].trials, 2);
  assert.equal(result.cells[cell].completed, 2);
  assert.deepEqual(result.cells[cell].metrics.humanTurns, { observed: 2, missing: 0, mean: 2, total: 4 });
  assert.deepEqual(result.cells[cell].metrics.provisionalScore, { observed: 2, missing: 0, mean: 4, total: 8 });
  assert.equal(result.cells[cell].metrics.apiErrors.total, 2);
  assert.equal(result.cells[cell].metrics.apiRetries.total, 4);
  assert.equal(result.cells[cell].actions.rates.defer, 0.25);
  assert.equal(result.cells[cell].actions.rates.confirm, 0.5);
  for (const pair of Object.values(result.pairedComparisons)) {
    assert.equal(pair.pairedTrials, 2);
    assert.deepEqual(pair.differences.provisionalScore, { paired: 2, missingPairs: 0, meanDifference: 0 });
  }
  assert.deepEqual(result, summarizeAblation({ plan, runs: [...runs].reverse() }));
});

test("paired differences use the same seed, correct direction, and complete pairs only", () => {
  const plan = planAblation(config()), runs = records(plan);
  for (const r of runs) {
    if (r.strategy === "bypass-enabled") {
      r.outcome.score = r.seed < 0 ? 6 : 3;
      r.outcome.turns.human = 1;
    } else r.outcome.score = r.seed < 0 ? 3 : 5;
  }
  const missing = runs.find((r) => r.seed === 12 && r.strategy === "bypass-enabled" && !r.options.visualAid && !r.options.referenceMemory);
  missing.outcome.status = "dialogue";
  missing.outcome.score = null;
  const result = summarizeAblation({ plan, runs });
  const pair = result.pairedComparisons[cell + " -> bypass-enabled|visualAid=false|referenceMemory=false"];
  assert.deepEqual(pair.differences.provisionalScore, { paired: 1, missingPairs: 1, meanDifference: 3 });
  assert.deepEqual(pair.differences.humanTurns, { paired: 2, missingPairs: 0, meanDifference: -1 });
  assert.equal(result.cells["bypass-enabled|visualAid=false|referenceMemory=false"].completed, 1);
});

test("zero-action rates and unmeasured outcomes preserve explicit coverage", () => {
  const plan = planAblation(config()), runs = records(plan);
  for (const r of runs) r.outcome = outcome({ status: "dialogue", score: null, turns: null, api: null,
    ledgerFinalDifferences: null, actions: null });
  runs[0].outcome.actions = actions();
  const result = summarizeAblation({ plan, runs }), summary = result.cells[cell];
  assert.deepEqual(summary.metrics.provisionalScore, { observed: 0, missing: 2, mean: null, total: null });
  assert.equal(summary.actions.rates.confirm, null);
  assert.equal(summary.actions.observedTrials, 1);
  assert.equal(summary.actions.missingTrials, 1);
  for (const p of Object.values(result.pairedComparisons)) {
    assert.deepEqual(p.differences.confirmRate, { paired: 0, missingPairs: 2, meanDifference: null });
  }
});

test("missing, duplicated, extra or mismatched seeds reject the whole comparison", () => {
  const plan = planAblation(config());
  reject(() => summarizeAblation({ plan, runs: [] }), "unmatched_runs");
  reject(() => summarizeAblation({ plan, runs: records(plan).slice(1) }), "unmatched_runs");
  const duplicate = records(plan); duplicate[0] = duplicate[1];
  reject(() => summarizeAblation({ plan, runs: duplicate }), "unmatched_runs");
  const changed = records(plan); changed[0].seed = 999;
  reject(() => summarizeAblation({ plan, runs: changed }), "unmatched_runs");
});

test("changed model, generation configuration, renderer or image bytes reject analysis", () => {
  const plan = planAblation(config());
  for (const [mutate, code] of [
    [(r) => { r.modelConfig.model = "different-model"; }, "model_mismatch"],
    [(r) => { r.modelConfig.maxCompletionTokens = 1024; }, "model_mismatch"],
    [(r) => { r.imageConfig.visualAidVersion = "different-aid"; }, "image_config_mismatch"],
    [(r) => { r.imageConfig.stimulusVersion = "different-renderer"; }, "image_config_mismatch"],
    [(r) => { r.ownImageSha256 = "f".repeat(64); }, "image_mismatch"],
  ]) {
    const runs = records(plan); mutate(runs[0]);
    reject(() => summarizeAblation({ plan, runs }), code);
  }
  const runs = records(plan);
  runs.find((r) => r.options.visualAid).visualAidSha256 = "f".repeat(64);
  reject(() => summarizeAblation({ plan, runs }), "image_mismatch");
});

test("image aid is intentional only in ON cells; unknown flags and invalid fingerprints are rejected", () => {
  const plan = planAblation(config());
  for (const mutate of [
    (r) => { r.options.visualAid = "false"; },
    (r) => { r.options.referenceMemory = undefined; },
  ]) {
    const runs = records(plan); mutate(runs[0]);
    reject(() => summarizeAblation({ plan, runs }), "invalid_options");
  }
  for (const mutate of [
    (r) => { r.ownImageSha256 = "not-a-hash"; },
    (r) => { r.visualAidSha256 = "e".repeat(64); },
  ]) {
    const runs = records(plan); mutate(runs[0]);
    reject(() => summarizeAblation({ plan, runs }), "invalid_image_fingerprint");
  }
  const runs = records(plan); runs.find((r) => r.options.visualAid).visualAidSha256 = null;
  reject(() => summarizeAblation({ plan, runs }), "invalid_image_fingerprint");
});

test("safe run and outcome schemas reject leaked data, with fixed non-content errors", () => {
  const plan = planAblation(config());
  for (const key of ["key", "gold", "humanImage", "publicHistory", "privateTranscript", "hiddenLabels", "prompt", "apiKey"]) {
    const runs = records(plan); runs[0][key] = "never-echo-this";
    reject(() => summarizeAblation({ plan, runs }), "invalid_schema");
    delete runs[0][key]; runs[0].outcome[key] = "never-echo-this";
    assert.throws(() => summarizeAblation({ plan, runs }), (error) => error.code === "invalid_schema" && !error.message.includes("never-echo-this"));
  }
  const altered = structuredClone(plan); altered.runs[0].options.visualAid = true;
  reject(() => summarizeAblation({ plan: altered, runs: records(plan) }), "invalid_plan");
});

test("invalid numeric outcomes reject instead of becoming success or silently disappearing", () => {
  const plan = planAblation(config());
  for (const [patch, code] of [
    [{ turns: { human: -1, ai: 2 } }, "invalid_turns"],
    [{ score: NaN }, "invalid_score"],
    [{ score: 7 }, "invalid_score"],
    [{ status: "dialogue", score: 4 }, "invalid_score"],
    [{ api: { requests: 1, errors: 2, retries: 0 } }, "invalid_api_counts"],
    [{ api: { requests: 1, errors: 0, retries: 0.5 } }, "invalid_api_counts"],
    [{ ledgerFinalDifferences: 7 }, "invalid_memory_counts"],
    [{ actions: actions({ confirm: -1 }) }, "invalid_actions"],
    [{ actions: {} }, "invalid_schema"],
  ]) {
    const runs = records(plan); runs[0].outcome = outcome(patch);
    reject(() => summarizeAblation({ plan, runs }), code);
  }
});

test("aggregate exports fixed labels and numbers only, never seeds, hashes, model IDs or per-trial payloads", () => {
  const result = summarizeAblation({ plan: planAblation(config()), runs: records() });
  const serialized = JSON.stringify(result);
  for (const text of [MODEL.model, IMAGES.stimulusVersion, IMAGES.visualAidVersion, "a".repeat(64),
    "ownImageSha256", "seed\"", "modelConfig", "publicHistory", "scoring", "pValue", "significant", "causal"]) {
    assert.ok(!serialized.includes(text), text);
  }
  function numericLeaves(value) {
    if (value !== null && typeof value === "object") Object.values(value).forEach(numericLeaves);
    else assert.ok(value === null || typeof value === "number" || typeof value === "boolean");
  }
  numericLeaves(result);
  assert.ok(Object.isFrozen(result.cells[cell].metrics));
});

test("raw-record pipeline uses only public/AI evidence and emits no synthetic utterances or AI names", () => {
  const plan = planAblation(config());
  const runs = plan.runs.map((r) => {
    const record = rawRecord({ seed: r.seed, strategy: r.strategy, options: r.options });
    record.ownLedger[SLOTS[0]].name = "synthetic private AI candidate";
    record.aiSubmission[SLOTS[0]] = "synthetic private AI final name";
    return trialRunFromRecord(record, { ...metadata(), visualAidSha256: r.options.visualAid ? "c".repeat(64) : null });
  });
  const result = summarizeAblation({ plan, runs });
  assert.equal(result.cells[cell].metrics.ledgerFinalDifferences.total, 2);
  assert.equal(result.cells[cell].metrics.apiRetries.total, 4);
  assert.ok(!JSON.stringify(result).includes("synthetic"));
});

test("cell rates pool act counts while paired rates compare each matched seed's rate", () => {
  const plan = planAblation(config()), runs = records(plan);
  for (const r of runs) r.outcome.actions = r.seed < 0 ? actions({ defer: 1 }) : actions({ accept: 9 });
  const result = summarizeAblation({ plan, runs });
  assert.equal(result.cells[cell].actions.rates.defer, 0.1);
  assert.equal(result.cells[cell].actions.totalActs, 10);
  const pair = result.pairedComparisons[cell + " -> bypass-enabled|visualAid=false|referenceMemory=false"];
  assert.deepEqual(pair.differences.deferRate, { paired: 2, missingPairs: 0, meanDifference: 0 });
});
