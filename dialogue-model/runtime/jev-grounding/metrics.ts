// Agreement metrics between judged evidence levels and the eval-set gold.
// Only cases with a non-null expected value enter an axis. Scores reported here
// are agreement with label-derived gold, not "probability correct"; any judge
// confidence stays a relative score until calibrated against human gold.
import type { FailureTag, GroundingEvalCase, LabelQuality, NameEvidence, TargetEvidence } from "./evalcase.ts";
import { FAILURE_TAGS, NAME_LEVELS, TARGET_LEVELS } from "./evalcase.ts";

export interface Prediction {
  caseId: string;
  target: TargetEvidence | null;
  name: NameEvidence | null;
}

export interface AxisReport {
  n: number;
  missingPrediction: number;
  accuracy: number | null;
  macroF1: number | null;
  /** Share of predictions that were "unknown" (abstentions). */
  unknownRate: number | null;
  perLevel: Record<string, { gold: number; predicted: number; precision: number | null; recall: number | null; f1: number | null }>;
  /** confusion[gold][predicted] */
  confusion: Record<string, Record<string, number>>;
}

function ratio(a: number, b: number): number | null {
  return b === 0 ? null : a / b;
}

export function axisReport<L extends string>(levels: readonly L[], pairs: readonly { gold: L; predicted: L | null }[]): AxisReport {
  const confusion: Record<string, Record<string, number>> = {};
  for (const g of levels) confusion[g] = Object.fromEntries(levels.map((p) => [p, 0]));
  let missing = 0, correct = 0, unknown = 0, scored = 0;
  for (const { gold, predicted } of pairs) {
    if (predicted === null) { missing++; continue; }
    scored++;
    confusion[gold][predicted]++;
    if (gold === predicted) correct++;
    if (predicted === "unknown") unknown++;
  }
  const perLevel: AxisReport["perLevel"] = {};
  const f1s: number[] = [];
  for (const level of levels) {
    const tp = confusion[level][level];
    const goldCount = levels.reduce((s, p) => s + confusion[level][p], 0);
    const predCount = levels.reduce((s, g) => s + confusion[g][level], 0);
    const precision = ratio(tp, predCount), recall = ratio(tp, goldCount);
    const f1 = precision === null || recall === null ? null : precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    perLevel[level] = { gold: goldCount, predicted: predCount, precision, recall, f1 };
    if (goldCount > 0) f1s.push(f1 ?? 0);
  }
  return {
    n: pairs.length, missingPrediction: missing, accuracy: ratio(correct, scored),
    macroF1: f1s.length === 0 ? null : f1s.reduce((a, b) => a + b, 0) / f1s.length,
    unknownRate: ratio(unknown, scored), perLevel, confusion,
  };
}

/** Quality of one axis' gold: the per-axis value when present, else the case-level one. */
export function axisQualityOf(c: GroundingEvalCase, axis: "target" | "name"): LabelQuality {
  return c.axisQuality?.[axis] ?? c.labelQuality;
}

/**
 * Per-axis agreement. `qualities` restricts which gold enters (for example
 * ["explicit", "derived"] for a headline that excludes weak, M-derived labels);
 * report weak gold separately rather than mixing it in.
 */
export function evaluate(cases: readonly GroundingEvalCase[], predictions: readonly Prediction[], qualities?: readonly LabelQuality[]): { target: AxisReport; name: AxisReport } {
  const byId = new Map(predictions.map((p) => [p.caseId, p]));
  const keep = (c: GroundingEvalCase, axis: "target" | "name") => !qualities || qualities.includes(axisQualityOf(c, axis));
  const target = cases.filter((c) => c.expected.target !== null && keep(c, "target"))
    .map((c) => ({ gold: c.expected.target as TargetEvidence, predicted: byId.get(c.caseId)?.target ?? null }));
  const name = cases.filter((c) => c.expected.name !== null && keep(c, "name"))
    .map((c) => ({ gold: c.expected.name as NameEvidence, predicted: byId.get(c.caseId)?.name ?? null }));
  return { target: axisReport(TARGET_LEVELS, target), name: axisReport(NAME_LEVELS, name) };
}

/** Default flag: the judge says the target evidence is not there. Callers may pass their own policy. */
export function defaultFlag(prediction: Prediction): boolean {
  return prediction.target === "insufficient" || prediction.target === "contradicted";
}

export interface DetectionReport {
  perTag: Record<string, { tagged: number; flagged: number; rate: number | null }>;
  untagged: number;
  /** Untagged turns that were flagged. Not necessarily wrong: tags are provisional and incomplete. */
  flaggedUntagged: number;
  falseAlarmRate: number | null;
}

/** Detection of tagged failure turns by a flag policy over predictions. */
export function detection(cases: readonly GroundingEvalCase[], predictions: readonly Prediction[], flag: (p: Prediction) => boolean = defaultFlag): DetectionReport {
  const byId = new Map(predictions.map((p) => [p.caseId, p]));
  const perTag: DetectionReport["perTag"] = {};
  for (const tag of FAILURE_TAGS) perTag[tag] = { tagged: 0, flagged: 0, rate: null };
  let untagged = 0, flaggedUntagged = 0;
  for (const c of cases) {
    const p = byId.get(c.caseId);
    const flagged = p ? flag(p) : false;
    const tags: readonly FailureTag[] = c.failureTags ?? [];
    if (tags.length === 0) {
      untagged++;
      if (flagged) flaggedUntagged++;
    }
    for (const tag of tags) {
      perTag[tag].tagged++;
      if (flagged) perTag[tag].flagged++;
    }
  }
  for (const entry of Object.values(perTag)) entry.rate = ratio(entry.flagged, entry.tagged);
  return { perTag, untagged, flaggedUntagged, falseAlarmRate: ratio(flaggedUntagged, untagged) };
}

/** Counts of gold values per axis, split and unit, without any text. */
export function goldCounts(cases: readonly GroundingEvalCase[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  const bump = (key: string, value: string) => {
    out[key] ??= {};
    out[key][value] = (out[key][value] ?? 0) + 1;
  };
  for (const c of cases) {
    const scope = `${c.source}/${c.unit}/${c.split}`;
    bump(`${scope}/cases`, "n");
    bump(`${scope}/target`, c.expected.target ?? "null");
    bump(`${scope}/name`, c.expected.name ?? "null");
    bump(`${scope}/quality`, c.labelQuality);
    if (c.expected.target !== null) bump(`${scope}/targetQuality`, axisQualityOf(c, "target"));
    if (c.expected.name !== null) bump(`${scope}/nameQuality`, axisQualityOf(c, "name"));
    for (const tag of c.failureTags ?? []) bump(`${scope}/failureTags`, tag);
  }
  return out;
}
