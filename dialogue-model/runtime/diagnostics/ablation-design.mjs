// Researcher-only, descriptive diagnostic; not an adopted experiment protocol.
// Pure functions only: no file I/O, prompts, fixtures, clients or paid inference.
// Keep raw records in a private directory outside Git. Only summarizeAblation's
// numeric aggregates are suitable for documentation, never plans or trial rows.
import { conditionOf, dialogueMetrics, outcomeMetrics } from "./grounding-metrics.mjs";
import { SLOTS } from "../stimuli/board.mjs";

const STRATEGIES = ["repair-first", "bypass-enabled"];
const ACTIONS = ["accept", "propose_name", "confirm", "repair", "defer", "revisit", "agree", "move_on", "close"];
const STATUSES = ["dialogue", "submitting", "completed", "submission_error", "scoring_error", "aborted"];
const RATE_ACTIONS = ["defer", "revisit", "repair", "confirm"];
const plain = (v) => v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const digest = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const identifier = (v) => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(v);
const fail = (code) => { throw new AblationDesignError(code); };
function keys(v, required) {
  if (!plain(v) || Reflect.ownKeys(v).length !== required.length || !required.every((k) => Object.hasOwn(v, k))) fail("invalid_schema");
}
function freeze(v) {
  if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); }
  return v;
}
const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const sum = (values) => values.reduce((a, b) => a + b, 0);
const canonical = (v) => JSON.stringify(v, (_, value) => plain(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);

export class AblationDesignError extends Error {
  constructor(code) { super("Ablation diagnostic rejected: " + code); this.name = "AblationDesignError"; this.code = code; }
}

/** Runtime-validated schema. Missing measurements are null, never implicit zero.
 * Model config is researcher-attested, not a client model-selection request.
 * Image revisions name the renderer/aid procedure; SHA-256 values bind actual
 * own-board/rotation-sheet bytes, supplied by the researcher's local adapter.
 * No partner image or answer key is accepted by planning/aggregation APIs.
 * @typedef {{model:string, purpose:'dialogue_turn', maxCompletionTokens:number}} ModelConfig
 * @typedef {{stimulusVersion:string, visualAidVersion:string}} ImageConfig
 * @typedef {{status:string, turns:{human:number, ai:number}|null, score:number|null,
 *   api:{requests:number, errors:number, retries:number}|null,
 *   ledgerFinalDifferences:number|null, actions:Object<string,number>|null}} TrialOutcome
 * @typedef {{seed:number, strategy:string, options:{visualAid:boolean, referenceMemory:boolean},
 *   modelConfig:ModelConfig, imageConfig:ImageConfig, ownImageSha256:string,
 *   visualAidSha256:string|null, outcome:TrialOutcome}} TrialRun
 */
export const ABLATION_SCHEMA = freeze({ version: 1, researcherOnly: true,
  strategies: [...STRATEGIES], actions: [...ACTIONS], statuses: [...STATUSES],
  factors: ["strategy", "visualAid", "referenceMemory"],
});

function modelConfig(v) {
  keys(v, ["model", "purpose", "maxCompletionTokens"]);
  if (!identifier(v.model) || v.purpose !== "dialogue_turn" || !count(v.maxCompletionTokens) || v.maxCompletionTokens < 1) fail("invalid_model_config");
  return { model: v.model, purpose: v.purpose, maxCompletionTokens: v.maxCompletionTokens };
}
function imageConfig(v) {
  keys(v, ["stimulusVersion", "visualAidVersion"]);
  if (!identifier(v.stimulusVersion) || !identifier(v.visualAidVersion)) fail("invalid_image_config");
  return { stimulusVersion: v.stimulusVersion, visualAidVersion: v.visualAidVersion };
}
function options(v) {
  keys(v, ["visualAid", "referenceMemory"]);
  if (typeof v.visualAid !== "boolean" || typeof v.referenceMemory !== "boolean") fail("invalid_options");
  return { visualAid: v.visualAid, referenceMemory: v.referenceMemory };
}

/** Deterministic 2 x 2 x 2 plan. No turn floor, stopping rule or default seeds.
 * This function never creates trials or sends model requests.
 */
export function planAblation(config) {
  keys(config, ["seeds", "modelConfig", "imageConfig"]);
  if (!Array.isArray(config.seeds) || !config.seeds.length || !config.seeds.every(Number.isSafeInteger) ||
      new Set(config.seeds).size !== config.seeds.length) fail("invalid_seeds");
  const seeds = [...config.seeds].sort((a, b) => a - b);
  const model = modelConfig(config.modelConfig), image = imageConfig(config.imageConfig);
  const runs = seeds.flatMap((seed) => STRATEGIES.flatMap((strategy) => [false, true].flatMap((visualAid) =>
    [false, true].map((referenceMemory) => ({ seed, strategy, options: { visualAid, referenceMemory },
      modelConfig: { ...model }, imageConfig: { ...image } })))));
  return freeze({ schemaVersion: 1, researcherOnly: true, dryRun: true, seeds, modelConfig: model, imageConfig: image, runs });
}

function validateOutcome(v) {
  keys(v, ["status", "turns", "score", "api", "ledgerFinalDifferences", "actions"]);
  if (!STATUSES.includes(v.status)) fail("invalid_status");
  if (v.turns !== null) {
    keys(v.turns, ["human", "ai"]);
    if (!count(v.turns.human) || !count(v.turns.ai)) fail("invalid_turns");
  }
  if (v.score !== null && (v.status !== "completed" || !count(v.score) || v.score > 6)) fail("invalid_score");
  if (v.api !== null) {
    keys(v.api, ["requests", "errors", "retries"]);
    if (!Object.values(v.api).every(count) || v.api.errors > v.api.requests) fail("invalid_api_counts");
  }
  if (v.ledgerFinalDifferences !== null && (!count(v.ledgerFinalDifferences) || v.ledgerFinalDifferences > 6)) fail("invalid_memory_counts");
  if (v.actions !== null) {
    keys(v.actions, ACTIONS);
    if (!Object.values(v.actions).every(count)) fail("invalid_actions");
  }
  return structuredClone(v);
}

/** Private-record adapter; output contains counts only. Never reads humanSubmission,
 * scoring.key, figure identities, private transcripts, images or annotation labels.
 * Counts use typed committed judgments (including followUp), never utterance NLP.
 * A rate's denominator is all committed acts, rather than dialogue turns. Cells
 * pool act counts; paired differences compare each seed's per-trial rate.
 * API retries count transport retries, separately from judgment format retries.
 * Incomplete trials never read scoring, even when a caller accidentally supplies it.
 */
export function normalizeTrialOutcome(record) {
  if (!plain(record) || !STATUSES.includes(record.status)) fail("invalid_record");
  const projected = {};
  if (record.publicHistory != null) {
    if (!Array.isArray(record.publicHistory) || !record.publicHistory.every((m) => plain(m) &&
        ["user", "assistant"].includes(m.role) && typeof m.content === "string")) fail("invalid_history");
    projected.publicHistory = record.publicHistory.map((m) => ({ role: m.role, content: m.content }));
  }
  if (record.judgments != null) {
    if (!Array.isArray(record.judgments)) fail("invalid_judgments");
    projected.judgments = record.judgments.map((entry) => {
      if (!plain(entry) || typeof entry.status !== "string") fail("invalid_judgments");
      if (entry.status !== "committed") return { status: entry.status };
      const act = (a) => {
        if (!plain(a) || !ACTIONS.includes(a.action)) fail("invalid_judgments");
        return { action: a.action }; // no names, features, notes or hidden labels
      };
      const judgment = act(entry.judgment);
      if (entry.judgment.followUp != null) judgment.followUp = act(entry.judgment.followUp);
      return { status: "committed", judgment };
    });
  }
  let differences = null;
  if (record.ownLedger != null && record.aiSubmission != null) {
    // Only the AI's own literal ledger/final differences, not joint success.
    if (!plain(record.ownLedger) || !plain(record.aiSubmission)) fail("invalid_memory");
    const slots = SLOTS;
    if (Object.keys(record.ownLedger).length !== 6 || Object.keys(record.aiSubmission).length !== 6 || !slots.every((slot) =>
        Object.hasOwn(record.ownLedger, slot) &&
        Object.hasOwn(record.aiSubmission, slot) && plain(record.ownLedger[slot]) &&
        (record.ownLedger[slot].name === null || typeof record.ownLedger[slot].name === "string") &&
        typeof record.aiSubmission[slot] === "string")) fail("invalid_memory");
    projected.ownLedger = Object.fromEntries(slots.map((slot) => [slot, { name: record.ownLedger[slot].name }]));
    projected.aiSubmission = Object.fromEntries(slots.map((slot) => [slot, record.aiSubmission[slot]]));
  }
  const metrics = dialogueMetrics(projected);
  if (projected.aiSubmission) differences = metrics.ledgerFinalMismatch;
  let score = null;
  if (record.status === "completed" && record.scoring != null) {
    const result = record.scoring.result;
    // matchedCount is the scoring.mjs field; never guess from score/correct/total.
    if (result != null) {
      if (!plain(result) || !count(result.matchedCount) || result.matchedCount > 6 || result.total !== 6) fail("invalid_score");
      score = outcomeMetrics({ status: "completed", scoring: { result: {
        matchedCount: result.matchedCount, total: result.total,
      } } }).matchedCount;
    }
  }
  let api = null;
  if (record.requests != null) {
    if (!Array.isArray(record.requests) || !record.requests.every((r) => plain(r) && ["ok", "error"].includes(r.status) && count(r.retryCount))) fail("invalid_requests");
    api = { requests: record.requests.length, errors: record.requests.filter((r) => r.status === "error").length,
      retries: sum(record.requests.map((r) => r.retryCount)) };
  }
  return freeze(validateOutcome({ status: record.status,
    turns: projected.publicHistory ? { human: metrics.utterances.human.count, ai: metrics.utterances.ai.count } : null,
    score, api, ledgerFinalDifferences: differences, actions: projected.judgments ? metrics.actionCounts : null }));
}

/** Bind an existing private record to researcher-attested generation settings and
 * SHA-256 fingerprints. Compute fingerprints locally from createTrial({seed}).ai.png
 * and the enabled own-image rotation sheet, never the human board. No new fields
 * need to be persisted on the runtime record. Successful responses must all name
 * the planned model; failed requests may have null model. No success => unverifiable.
 */
export function trialRunFromRecord(record, metadata) {
  keys(metadata, ["modelConfig", "imageConfig", "ownImageSha256", "visualAidSha256"]);
  const model = modelConfig(metadata.modelConfig);
  if (!plain(record) || !Array.isArray(record.requests) || !record.requests.length) fail("missing_model_evidence");
  let successes = 0;
  for (const request of record.requests) {
    if (!plain(request) || !["ok", "error"].includes(request.status)) fail("invalid_requests");
    if (request.status === "ok") successes++;
    if ((request.status === "ok" || request.model != null) && request.model !== model.model) fail("model_mismatch");
  }
  if (!successes) fail("missing_model_evidence");
  return freeze(validateRun({ seed: record.seed, strategy: record.strategy, options: options(record.options),
    modelConfig: model, imageConfig: imageConfig(metadata.imageConfig), ownImageSha256: metadata.ownImageSha256,
    visualAidSha256: metadata.visualAidSha256, outcome: normalizeTrialOutcome(record) }));
}

function validateRun(v) {
  keys(v, ["seed", "strategy", "options", "modelConfig", "imageConfig", "ownImageSha256", "visualAidSha256", "outcome"]);
  if (!Number.isSafeInteger(v.seed) || !STRATEGIES.includes(v.strategy)) fail("invalid_condition");
  const opts = options(v.options);
  if (!digest(v.ownImageSha256) || (opts.visualAid ? !digest(v.visualAidSha256) : v.visualAidSha256 !== null)) fail("invalid_image_fingerprint");
  return { seed: v.seed, strategy: v.strategy, options: opts, modelConfig: modelConfig(v.modelConfig),
    imageConfig: imageConfig(v.imageConfig), ownImageSha256: v.ownImageSha256, visualAidSha256: v.visualAidSha256,
    outcome: validateOutcome(v.outcome) };
}

function measurements(outcome) {
  const acts = outcome.actions ? sum(Object.values(outcome.actions)) : 0;
  return { humanTurns: outcome.turns?.human ?? null, aiTurns: outcome.turns?.ai ?? null,
    totalTurns: outcome.turns ? outcome.turns.human + outcome.turns.ai : null,
    provisionalScore: outcome.score, apiRequests: outcome.api?.requests ?? null,
    apiErrors: outcome.api?.errors ?? null, apiRetries: outcome.api?.retries ?? null,
    ledgerFinalDifferences: outcome.ledgerFinalDifferences,
    ...Object.fromEntries(RATE_ACTIONS.map((a) => [a + "Rate", acts ? outcome.actions[a] / acts : null])) };
}
function stats(values) {
  const observed = values.filter((v) => v !== null);
  return { observed: observed.length, missing: values.length - observed.length, mean: mean(observed),
    total: observed.length ? sum(observed) : null };
}
function cellSummary(rows) {
  const outcomes = rows.map((r) => r.outcome), measures = outcomes.map(measurements);
  const observedActions = outcomes.filter((o) => o.actions !== null);
  const totalActs = sum(observedActions.map((o) => sum(Object.values(o.actions))));
  return { trials: rows.length, completed: outcomes.filter((o) => o.status === "completed").length,
    metrics: Object.fromEntries(Object.keys(measures[0]).filter((k) => !k.endsWith("Rate"))
      .map((k) => [k, stats(measures.map((m) => m[k]))])),
    actions: { observedTrials: observedActions.length, missingTrials: rows.length - observedActions.length, totalActs,
      counts: Object.fromEntries(ACTIONS.map((a) => [a, sum(observedActions.map((o) => o.actions[a]))])),
      rates: Object.fromEntries(RATE_ACTIONS.map((a) => [a, totalActs ? sum(observedActions.map((o) => o.actions[a])) / totalActs : null])) } };
}

/** Aggregate a complete matched factorial. Missing trial rows, duplicate cells,
 * changed seeds/models/settings/rendering/aid bytes throw. Missing measurements
 * in an existing row remain visible as null/coverage. The visualAid factor alone
 * deliberately changes the own-image sheet; within each enabled cell its bytes
 * must match across memory and policy conditions. Comparisons report paired mean
 * (to - from) differences only, with complete-pair counts. No p values, significance,
 * equivalence/noninferiority decisions or causal effects are inferred.
 */
export function summarizeAblation(input) {
  keys(input, ["plan", "runs"]);
  const p = input.plan;
  keys(p, ["schemaVersion", "researcherOnly", "dryRun", "seeds", "modelConfig", "imageConfig", "runs"]);
  const plan = planAblation({ seeds: p.seeds, modelConfig: p.modelConfig, imageConfig: p.imageConfig });
  if (canonical(p) !== canonical(plan)) fail("invalid_plan");
  if (!Array.isArray(input.runs) || input.runs.length !== plan.runs.length) fail("unmatched_runs");
  const rows = input.runs.map(validateRun), byId = new Map();
  const id = (r) => r.seed + "|" + conditionOf(r);
  const expected = new Set(plan.runs.map(id));
  for (const row of rows) {
    if (!expected.has(id(row)) || byId.has(id(row))) fail("unmatched_runs");
    if (canonical(row.modelConfig) !== canonical(plan.modelConfig)) fail("model_mismatch");
    if (canonical(row.imageConfig) !== canonical(plan.imageConfig)) fail("image_config_mismatch");
    byId.set(id(row), row);
  }
  for (const seed of plan.seeds) {
    const matched = rows.filter((r) => r.seed === seed);
    if (new Set(matched.map((r) => r.ownImageSha256)).size !== 1 ||
        new Set(matched.filter((r) => r.options.visualAid).map((r) => r.visualAidSha256)).size !== 1) fail("image_mismatch");
  }
  const cells = plan.runs.filter((r) => r.seed === plan.seeds[0]);
  const cellRows = (cell) => plan.seeds.map((seed) => byId.get(id({ ...cell, seed })));
  const comparisons = [];
  for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
    const a = cells[i], b = cells[j];
    const changed = ["strategy", "visualAid", "referenceMemory"].filter((key) =>
      (key === "strategy" ? a[key] !== b[key] : a.options[key] !== b.options[key]));
    if (changed.length !== 1) continue;
    const before = cellRows(a).map((r) => measurements(r.outcome)), after = cellRows(b).map((r) => measurements(r.outcome));
    comparisons.push([conditionOf(a) + " -> " + conditionOf(b), { pairedTrials: plan.seeds.length,
      differences: Object.fromEntries(Object.keys(before[0]).map((key) => {
        const deltas = before.flatMap((v, index) => v[key] === null || after[index][key] === null ? [] : [after[index][key] - v[key]]);
        return [key, { paired: deltas.length, missingPairs: plan.seeds.length - deltas.length, meanDifference: mean(deltas) }];
      })) }]);
  }
  // Fixed labels and aggregate numbers only: no seeds, IDs, models, hashes or text.
  return freeze({ schemaVersion: 1, researcherOnly: true, trials: rows.length, matchedSeeds: plan.seeds.length,
    cells: Object.fromEntries(cells.map((c) => [conditionOf(c), cellSummary(cellRows(c))])),
    pairedComparisons: Object.fromEntries(comparisons) });
}
