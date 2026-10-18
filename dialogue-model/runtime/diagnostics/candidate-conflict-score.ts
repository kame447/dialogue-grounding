// RESEARCHER ONLY, offline. Scores candidate-conflict judgments against a
// private gold referent annotation (which partner figure the human meant at
// each turn) mapped into the AI's id space through the held-out trial key.
// Never imported by the runtime; never send its inputs or outputs to a model.
// Pure functions, no I/O: callers load the private files outside the repo.
import type { CandidateConflict } from "../v2/candidate-conflict.ts";

export type TrialKey = { human: Record<string, string>; ai: Record<string, string> };
export type GoldAnnotation = { schema: "gold-referent/v1"; source: string; turns: { turn: number; goldHumanId: string | null }[] };
/** Produced only by goldReferentsInAiSpace; never from the AI's own choice. */
export type GoldReferent = Readonly<{ provenance: "gold_annotation"; source: string; turn: number; aiId: string | null }>;

const isPlain = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function validateKey(key: unknown): TrialKey {
  if (!isPlain(key) || !isPlain(key.human) || !isPlain(key.ai)) throw new TypeError("invalid_key");
  for (const side of [key.human, key.ai]) {
    const figures = Object.values(side);
    if (!figures.every((f) => typeof f === "string") || new Set(figures).size !== figures.length) throw new TypeError("invalid_key");
  }
  return key as TrialKey;
}

/** Map each annotated turn's partner figure into the AI's own id space. */
export function goldReferentsInAiSpace(annotation: unknown, key: unknown): Map<number, GoldReferent> {
  const k = validateKey(key);
  if (!isPlain(annotation) || annotation.schema !== "gold-referent/v1" || typeof annotation.source !== "string" ||
      !annotation.source.trim() || !Array.isArray(annotation.turns)) throw new TypeError("invalid_gold_annotation");
  const aiByFigure = new Map(Object.entries(k.ai).map(([id, figure]) => [figure, id]));
  const out = new Map<number, GoldReferent>();
  for (const entry of annotation.turns as unknown[]) {
    if (!isPlain(entry) || !Number.isSafeInteger(entry.turn) || out.has(entry.turn as number) ||
        !(entry.goldHumanId === null || (typeof entry.goldHumanId === "string" && Object.hasOwn(k.human, entry.goldHumanId)))) {
      throw new TypeError("invalid_gold_annotation");
    }
    const aiId = entry.goldHumanId === null ? null : aiByFigure.get(k.human[entry.goldHumanId]) ?? null;
    out.set(entry.turn as number, Object.freeze({ provenance: "gold_annotation", source: annotation.source, turn: entry.turn as number, aiId }));
  }
  return out;
}

export type FeatureSplitScore = {
  fitCount: number;
  fitsTarget: boolean | null;
  fitsGold: boolean | null;
  separatesTargetFromGold: boolean | null;
  goldInCandidates: boolean | null;
  splitsCandidates: boolean | null;
  claimMatchesScorer: boolean | null;
};

/**
 * `scorerFits`: own ids the feature fits per a separate scorer over own crops.
 * `targetSlot`: the AI's own choice, scored only as "fits the AI's target".
 * `gold`: from goldReferentsInAiSpace, or null when no gold exists (synthetic).
 */
export function scoreFeatureSplit({ scorerFits, scoredIds, targetSlot, gold, conflict = null }: {
  scorerFits: readonly string[]; scoredIds: readonly string[]; targetSlot: string | null;
  gold: GoldReferent | null; conflict?: CandidateConflict | null;
}): FeatureSplitScore {
  if (!scorerFits.every((id) => scoredIds.includes(id))) throw new TypeError("scorer fits outside scored ids");
  if (gold !== null && (gold?.provenance !== "gold_annotation" || !Object.isFrozen(gold))) throw new TypeError("gold must come from an annotation");
  const has = (id: string | null) => id === null || !scoredIds.includes(id) ? null : scorerFits.includes(id);
  const goldId = gold?.aiId ?? null;
  const fitsTarget = has(targetSlot), fitsGold = has(goldId);
  const listed = conflict?.candidates.map((entry) => entry.id) ?? [];
  const scorable = listed.length >= 2 && listed.every((id) => scoredIds.includes(id));
  const listedFits = listed.filter((id) => scorerFits.includes(id));
  return {
    fitCount: scorerFits.length,
    fitsTarget, fitsGold,
    separatesTargetFromGold: fitsTarget === null || fitsGold === null || targetSlot === goldId ? null : fitsTarget !== fitsGold,
    goldInCandidates: goldId === null || listed.length === 0 ? null : listed.includes(goldId),
    splitsCandidates: scorable ? listedFits.length > 0 && listedFits.length < listed.length : null,
    claimMatchesScorer: scorable && conflict?.featureFits ? listed.every((id) => conflict.featureFits!.includes(id) === scorerFits.includes(id)) : null,
  };
}
