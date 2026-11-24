// The Jev decisions response contract for choice questions, as pure functions with no imports. The real client (jev-decision.ts) and the independent S4
// verifier both call these, so "usable answer", "reported cost" and "response id" mean the same in the run and in its verification.
const object = (v: unknown): v is Record<string, unknown> => !!v && Object.getPrototypeOf(v) === Object.prototype;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const probability = (v: unknown): v is number => finite(v) && v >= 0 && v <= 1;
const exactKeys = (v: unknown, keys: readonly string[]): v is Record<string, unknown> => object(v) && Reflect.ownKeys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));

/** `answers` holds exactly the asked questions; each answer is a choice of one offered label with one probability per label (0..1) and an optional confidence (0..1). */
export function jevChoiceAnswersValid(answers: unknown, labelsByQuestion: Readonly<Record<string, readonly string[]>>): boolean {
  if (!exactKeys(answers, Object.keys(labelsByQuestion))) return false;
  for (const [name, labels] of Object.entries(labelsByQuestion)) {
    const a = (answers as Record<string, unknown>)[name];
    if (!object(a) || !Object.keys(a).every(k => ["type", "choice", "probabilities", "confidence"].includes(k)) || a.type !== "choice" ||
        typeof a.choice !== "string" || !labels.includes(a.choice) || !exactKeys(a.probabilities, labels) || !Object.values(a.probabilities).every(probability) ||
        !(a.confidence === undefined || a.confidence === null || probability(a.confidence))) return false;
  }
  return true;
}
/** The cost the response reports (finite, non-negative), else null: an unreported cost is a failed send. */
export const jevReportedCost = (data: unknown): number | null =>
  object(data) && object(data.usage) && finite(data.usage.cost) && data.usage.cost >= 0 ? data.usage.cost : null;
/** The response id kept as evidence: the gen- form only. */
export const jevResponseId = (data: unknown): string | null =>
  object(data) && typeof data.id === "string" && /^gen-[A-Za-z0-9_-]{1,124}$/.test(data.id) ? data.id : null;
