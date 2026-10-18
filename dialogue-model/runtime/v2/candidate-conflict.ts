// Opt-in v2 judge intervention (default off; researcher-unapproved, not adopted).
// When an impression fits two or more of the AI's OWN figures, Luna lists them
// with one feature each and declares which listed candidates its chosen
// discriminatingFeature fits in its own image. A feature that fits every listed
// candidate (or none) cannot separate them and is rejected deterministically.
// The block is private research data: never generator input, never public.
// It says nothing about the partner's board; fits are Luna's own claims.
// Problems with the block are recorded by the judge and never discard a valid
// act. Key-consuming scoring lives in diagnostics/, never imported here.

export type CandidateEntry = { id: string; feature: string };
export type CandidateConflict = { candidates: CandidateEntry[]; featureFits: string[] | null };
type Act = { targetSlot: string | null; discriminatingFeature: string | null };

export const CONFLICT_KEY = "conflict";
export const MAX_CANDIDATES = 3;
const FEATURE_LIMIT = 200;

export const CONFLICT_CODES = Object.freeze(["invalid_conflict", "conflict_target_not_candidate",
  "conflict_fits_required", "non_discriminating_feature"] as const);
export type ConflictCode = typeof CONFLICT_CODES[number];

export class CandidateConflictError extends Error {
  code: ConflictCode;
  constructor(code: ConflictCode) {
    super("Invalid candidate conflict: " + code);
    this.name = "CandidateConflictError";
    this.code = code;
  }
}

// Identical across strategies; the choice to confirm, defer or move on stays in
// JUDGE_POLICIES and the shared analysis triggers.
export const CANDIDATE_CONFLICT_INSTRUCTIONS = [
  "【候補の衝突の記録】この判断では、上記の5個の必須キーに加えて conflict キーも必須です。conflict は {\"candidates\": [...], \"featureFits\": [...] または null} です。",
  "現在の対象について、公開された見立て・特徴に当てはまりうる自分の図形が2つ以上あるときだけ、candidates に {\"id\": 自分の内部参照ID, \"feature\": その図形を他の候補から区別する、自分の画像で観察できる特徴1つ} を2〜3個、当てはまりやすい順に入れてください。当てはまる図形が1つ以下なら candidates は空配列にしてください。",
  "candidates があるとき、targetSlot はその中の1つか null にしてください。",
  "candidates があり discriminatingFeature を使うときは、その特徴が自分の画像で当てはまる候補のIDだけを featureFits に入れてください。全ての候補に当てはまる特徴、どの候補にも当てはまらない特徴は候補を区別しないので、discriminatingFeature に使わないでください。それ以外のとき featureFits は null です。",
  "候補が複数あること自体は確認のトリガーではありません。衝突を記録したうえで、受け止め・確認・保留・別の対象への移行のどれを選ぶかは、共通教示の分析トリガーと方略に従ってください。以前の確認で示した特徴が候補を区別しなかったときは、同じ特徴を繰り返さないでください。",
  "candidates と feature は非公開の作業メモです。内部参照IDや候補の数を相手に言わないでください。",
].join("\n");

export const CONFLICT_RETRY_HINTS: Readonly<Record<ConflictCode, string>> = Object.freeze({
  invalid_conflict: "conflict は {candidates: 0個または2〜3個の{id, feature}, featureFits: IDの配列またはnull} の形にしてください。",
  conflict_target_not_candidate: "candidates があるとき、targetSlot はその中の1つか null にしてください。",
  conflict_fits_required: "candidates があり discriminatingFeature を使うときは featureFits が必要です。それ以外は null にしてください。",
  non_discriminating_feature: "前回の discriminatingFeature は全ての候補に当てはまるか、どの候補にも当てはまらず、候補を区別しませんでした。候補の間で異なる特徴を1つ選ぶか、特徴を使わない判断を選んでください。",
});

const isText = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= limit;
const isPlain = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/** Split the private conflict block from a parsed judge response without mutating it. */
export function splitConflict(parsed: unknown): { core: unknown; conflict: unknown; present: boolean } {
  if (!isPlain(parsed) || !Object.hasOwn(parsed, CONFLICT_KEY)) return { core: parsed, conflict: undefined, present: false };
  const core: Record<string, unknown> = { ...parsed };
  delete core[CONFLICT_KEY];
  return { core, conflict: parsed[CONFLICT_KEY], present: true };
}

/** Validate against the AI's own ids and the already validated primary act. */
export function validateCandidateConflict(value: unknown, { ownIds, judgment }: { ownIds: readonly string[]; judgment: Act }): CandidateConflict {
  if (!isPlain(value) || !exactKeys(value, ["candidates", "featureFits"]) || !Array.isArray(value.candidates)) {
    throw new CandidateConflictError("invalid_conflict");
  }
  const raw = value.candidates;
  if (raw.length === 1 || raw.length > MAX_CANDIDATES) throw new CandidateConflictError("invalid_conflict");
  const candidates = raw.map((entry: unknown) => {
    if (!isPlain(entry) || !exactKeys(entry, ["id", "feature"]) || typeof entry.id !== "string" ||
        !ownIds.includes(entry.id) || !isText(entry.feature, FEATURE_LIMIT)) throw new CandidateConflictError("invalid_conflict");
    return { id: entry.id, feature: entry.feature.trim() };
  });
  const ids = candidates.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) throw new CandidateConflictError("invalid_conflict");
  const fits = value.featureFits;
  if (!(fits === null || (Array.isArray(fits) && fits.every((id) => typeof id === "string")))) {
    throw new CandidateConflictError("invalid_conflict");
  }
  if (candidates.length === 0) {
    if (fits !== null) throw new CandidateConflictError("conflict_fits_required");
    return { candidates, featureFits: null };
  }
  if (judgment.targetSlot !== null && !ids.includes(judgment.targetSlot)) throw new CandidateConflictError("conflict_target_not_candidate");
  if (judgment.discriminatingFeature === null) {
    if (fits !== null) throw new CandidateConflictError("conflict_fits_required");
    return { candidates, featureFits: null };
  }
  if (fits === null) throw new CandidateConflictError("conflict_fits_required");
  if (new Set(fits).size !== fits.length || !fits.every((id) => ids.includes(id))) throw new CandidateConflictError("invalid_conflict");
  // The one deterministic content rule: the feature must split the listed set.
  if (fits.length === 0 || fits.length === ids.length) throw new CandidateConflictError("non_discriminating_feature");
  return { candidates, featureFits: [...fits] };
}
