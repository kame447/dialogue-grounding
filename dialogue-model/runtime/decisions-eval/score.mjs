/**
 * Local-only scoring against researcher-unapproved dialogue-level labels.
 * Rates use ALL planned eligible cases, including no-answers; zero denominators
 * are null. Risk subsets overlap: never add their rates or produce a winner.
 * Unneeded confirm is a separate cost/burden indicator, NOT an error: agree is
 * acceptable but confirm is not acceptable (it may still be neutral).
 * Macro rates weight nonempty strata equally; p90 uses the nearest-rank rule,
 * median averages the middle pair. Agreement uses paired valid replies only.
 * probabilityOnly is exclusively for the uniform baseline's expected counts;
 * actual model replies always require a valid categorical action.
 */
import { DECISION_ACTIONS, DECISION_MODELS } from "../../../workers/research-ai-proxy/src/decisions.mjs";

export const PURPOSES = Object.freeze(Object.keys(DECISION_MODELS));
const finite = (value) => Number.isFinite(value) && value >= 0;
const probability = (value) => finite(value) && value <= 1;
const ratio = (n, d) => d ? n / d : null;
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const fail = () => { throw new Error("invalid_eval_results"); };

function validate(cases, rows, purposes) {
  if (!Array.isArray(cases) || !Array.isArray(rows) || !Array.isArray(purposes) || !purposes.length ||
      new Set(purposes).size !== purposes.length || purposes.some((purpose) => !PURPOSES.includes(purpose))) fail();
  const ids = new Set();
  for (const value of cases) {
    if (!value || typeof value.id !== "string" || ids.has(value.id) || typeof value.strategy !== "string" || typeof value.stratum !== "string" ||
        !Array.isArray(value.acceptable) || !value.acceptable.length || !Array.isArray(value.dangerous) ||
        new Set(value.acceptable).size !== value.acceptable.length || new Set(value.dangerous).size !== value.dangerous.length ||
        [...value.acceptable, ...value.dangerous].some((action) => !DECISION_ACTIONS.includes(action)) ||
        value.acceptable.some((action) => value.dangerous.includes(action))) fail();
    ids.add(value.id);
  }
  const lookup = new Map();
  for (const row of rows) {
    if (!row || !ids.has(row.caseId) || !purposes.includes(row.purpose)) fail();
    const key = JSON.stringify([row.purpose, row.caseId]);
    if (lookup.has(key)) fail();
    lookup.set(key, row);
  }
  return lookup;
}

function weights(row, probabilityOnly) {
  if (!row || row.error) return null;
  if (probabilityOnly) {
    if (!DECISION_ACTIONS.every((action) => probability(row.probabilities?.[action])) ||
        Math.abs(DECISION_ACTIONS.reduce((sum, action) => sum + row.probabilities[action], 0) - 1) > 1e-8) return null;
    return row.probabilities;
  }
  return DECISION_ACTIONS.includes(row.action) ? Object.fromEntries(DECISION_ACTIONS.map((action) => [action, action === row.action ? 1 : 0])) : null;
}

function summarize(cases, lookup, purpose, probabilityOnly) {
  const records = cases.map((value) => {
    const row = lookup.get(JSON.stringify([purpose, value.id]));
    return { value, row, weights: weights(row, probabilityOnly) };
  });
  const select = (record, actions) => record.weights ? actions.reduce((sum, action) => sum + record.weights[action], 0) : 0;
  const answered = records.filter((record) => record.weights).length;
  const acceptable = records.reduce((sum, record) => sum + select(record, record.value.acceptable), 0);
  const dangerous = records.reduce((sum, record) => sum + select(record, record.value.dangerous), 0);
  const neutral = records.reduce((sum, record) => sum + select(record, DECISION_ACTIONS.filter((action) =>
    !record.value.acceptable.includes(action) && !record.value.dangerous.includes(action))), 0);
  function subset(action, predicate) {
    const eligible = records.filter((record) => predicate(record.value));
    const valid = eligible.filter((record) => record.weights).length;
    const selected = eligible.reduce((sum, record) => sum + select(record, [action]), 0);
    return { cases: eligible.length, bases: new Set(eligible.map((record) => record.value.baseId ?? record.value.id)).size,
      answered: valid, noAnswer: eligible.length - valid, selected, rate: ratio(selected, eligible.length) };
  }
  const agreeProbabilities = records.filter((record) => record.weights && record.value.dangerous.includes("agree") &&
    probability(record.row?.probabilities?.agree)).map((record) => record.row.probabilities.agree);
  const latencies = records.map((record) => record.row?.latencyMs).filter(finite).sort((a, b) => a - b);
  const middle = Math.floor(latencies.length / 2);
  const costs = records.map((record) => record.row?.costUsd).filter(finite);
  return {
    planned: cases.length, answered, coverage: ratio(answered, cases.length),
    acceptable, dangerous, neutral, noAnswer: cases.length - answered,
    acceptableRate: ratio(acceptable, cases.length), dangerousRate: ratio(dangerous, cases.length),
    neutralRate: ratio(neutral, cases.length), noAnswerRate: ratio(cases.length - answered, cases.length),
    falseAgree: subset("agree", (value) => value.dangerous.includes("agree")),
    overConfirm: subset("confirm", (value) => value.dangerous.includes("confirm")),
    unjustRepair: subset("repair", (value) => value.dangerous.includes("repair")),
    unneededConfirm: subset("confirm", (value) => value.acceptable.includes("agree") && !value.acceptable.includes("confirm")),
    falseAgreeProbability: { count: agreeProbabilities.length, mean: mean(agreeProbabilities), max: agreeProbabilities.length ? Math.max(...agreeProbabilities) : null },
    latencyMs: { count: latencies.length, median: !latencies.length ? null : latencies.length % 2 ? latencies[middle] : (latencies[middle - 1] + latencies[middle]) / 2,
      p90: latencies.length ? latencies[Math.ceil(latencies.length * 0.9) - 1] : null },
    costUsd: costs.reduce((sum, value) => sum + value, 0), costKnown: costs.length,
    runtimeGuard: subset("agree", (value) => value.runtimeGuardBlocks === true),
  };
}

function macro(groups) {
  const summaries = Object.values(groups).filter((group) => group.planned);
  const average = (select) => mean(summaries.map(select).filter((value) => value !== null));
  const result = { strata: summaries.length };
  for (const key of ["acceptableRate", "dangerousRate", "neutralRate", "noAnswerRate", "coverage"]) result[key] = average((group) => group[key]);
  for (const key of ["falseAgree", "overConfirm", "unjustRepair", "unneededConfirm"]) {
    result[key] = { contributingStrata: summaries.filter((group) => group[key].cases).length, rate: average((group) => group[key].rate) };
  }
  result.falseAgreeProbabilityMean = average((group) => group.falseAgreeProbability.mean);
  return result;
}

/** Missing or invalid categorical replies are no-answers; duplicate/unknown rows fail closed. */
export function scoreResults(cases, rows, { purposes = PURPOSES, probabilityOnly = false } = {}) {
  const lookup = validate(cases, rows, purposes);
  const strategies = [...new Set(cases.map((value) => value.strategy))];
  const strata = [...new Set(cases.map((value) => value.stratum))];
  const byPurpose = Object.fromEntries(purposes.map((purpose) => {
    const group = (subset) => summarize(subset, lookup, purpose, probabilityOnly);
    const byStratum = Object.fromEntries(strata.map((stratum) => [stratum, group(cases.filter((value) => value.stratum === stratum))]));
    const byStrategyAndStratum = Object.fromEntries(strategies.map((strategy) => [strategy, Object.fromEntries(strata.map((stratum) =>
      [stratum, group(cases.filter((value) => value.strategy === strategy && value.stratum === stratum))]))]));
    return [purpose, { model: DECISION_MODELS[purpose], overall: group(cases),
      byStrategy: Object.fromEntries(strategies.map((strategy) => [strategy, group(cases.filter((value) => value.strategy === strategy))])),
      byStratum, byStrategyAndStratum, macro: macro(byStratum),
      macroByStrategy: Object.fromEntries(strategies.map((strategy) => [strategy, macro(byStrategyAndStratum[strategy])])) }];
  }));
  function agreement(subset) {
    let paired = 0, matched = 0;
    if (purposes.length === 2 && !probabilityOnly) for (const value of subset) {
      const replies = purposes.map((purpose) => lookup.get(JSON.stringify([purpose, value.id])));
      if (replies.every((row) => weights(row, false))) { paired++; if (replies[0].action === replies[1].action) matched++; }
    }
    return { planned: subset.length, paired, matched, coverage: ratio(paired, subset.length), rate: ratio(matched, paired) };
  }
  return { byPurpose, modelAgreement: { overall: agreement(cases),
    byStrategy: Object.fromEntries(strategies.map((strategy) => [strategy, agreement(cases.filter((value) => value.strategy === strategy))])),
    byStratum: Object.fromEntries(strata.map((stratum) => [stratum, agreement(cases.filter((value) => value.stratum === stratum))])),
    byStrategyAndStratum: Object.fromEntries(strategies.map((strategy) => [strategy, Object.fromEntries(strata.map((stratum) =>
      [stratum, agreement(cases.filter((value) => value.strategy === strategy && value.stratum === stratum))]))])) } };
}

/** Engineering references, not competing models. Uniform counts are exact expectations, not sampled choices. */
export function scoreBaselines(cases) {
  const purpose = PURPOSES[0];
  const options = { purposes: [purpose] };
  const reference = ({ model: _model, ...metrics }) => metrics;
  const constant = Object.fromEntries(DECISION_ACTIONS.map((action) => [action, reference(scoreResults(cases, cases.map((value) => ({
    caseId: value.id, purpose, action, probabilities: Object.fromEntries(DECISION_ACTIONS.map((key) => [key, key === action ? 1 : 0])),
  })), options).byPurpose[purpose])]));
  const uniform = scoreResults(cases, cases.map((value) => ({ caseId: value.id, purpose,
    probabilities: Object.fromEntries(DECISION_ACTIONS.map((action) => [action, 1 / DECISION_ACTIONS.length])),
  })), { ...options, probabilityOnly: true }).byPurpose[purpose];
  return { constant, noAnswer: reference(scoreResults(cases, [], options).byPurpose[purpose]), uniform: { ...reference(uniform), expectedCounts: true } };
}
