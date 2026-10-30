// Opt-in mechanical summaries of recorded clarifications. No model calls,
// strategy, answer key, semantic comparison or action-selection rule.
import { REPAIR_LOCAL_GAPS, REPAIR_REPLY_COMPARISONS } from "./contract.ts";
import type { RepairFact, RepairHistoryEntry } from "./contract.ts";

const INFORMATION_ACTS = new Set(["assert", "agree", "deny", "construe", "name_propose", "name_accept", "name_reject"]);
const replyTargets = (entry: RepairHistoryEntry) => new Set(entry.partnerClaims
  .filter(c => INFORMATION_ACTS.has(c.act)).flatMap(c => c.targets));

/** Compare human-reply target sets, never Jev's candidatesBefore/After. */
export function deriveRepairFacts(history: readonly RepairHistoryEntry[], judgments: readonly { turnIndex: number }[],
  inferenceHistory: readonly RepairHistoryEntry[]): RepairFact[] {
  const ordered = [...history].sort((a, b) => a.turn - b.turn);
  return inferenceHistory.map(entry => {
    const index = ordered.findIndex(e => e.turn === entry.turn);
    const prior = index > 0 ? ordered[index - 1] : undefined;
    const previous = prior && !judgments.some(j => prior.turn < j.turnIndex && j.turnIndex < entry.turn) ? prior : undefined;
    const currentSet = replyTargets(entry), previousSet = previous ? replyTargets(previous) : new Set<string>();
    let replyVsPrevious: RepairFact["replyVsPrevious"] = "not_comparable";
    if (previous && currentSet.size && previousSet.size) {
      replyVsPrevious = [...currentSet].every(id => previousSet.has(id))
        ? currentSet.size < previousSet.size ? "narrowed" : "same" : "widened_or_shifted";
    }
    return { turn: entry.turn, previousTurn: previous?.turn ?? null, replyVsPrevious,
      sameQuestionAsPrevious: !!previous && entry.question !== "" && entry.question === previous.question,
      localGaps: REPAIR_LOCAL_GAPS.filter(reason => entry.missingReasons?.includes(reason)),
      localRejections: entry.humanRejections?.length ?? 0 };
  });
}

const object = (v: unknown): v is Record<string, unknown> => !!v && Object.getPrototypeOf(v) === Object.prototype;
const keys = ["turn", "previousTurn", "replyVsPrevious", "sameQuestionAsPrevious", "localGaps", "localRejections"];
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

/** Closed material boundary. Adjacency needs committed judgments and is not
 * inferred again by the adapter or from a later saved repair history. */
export function validateRepairFacts(value: unknown, history: readonly Pick<RepairHistoryEntry, "turn">[], turn: number): RepairFact[] {
  const invalid = (): never => { throw new Error("invalid_repair_facts"); };
  if (!Array.isArray(value) || value.length > history.length) invalid();
  const facts = value as unknown[], seen = new Set<number>();
  return facts.map(f => {
    if (!object(f) || Reflect.ownKeys(f).length !== keys.length || !keys.every(k => Object.hasOwn(f, k)) ||
        !positive(f.turn) || f.turn >= turn || seen.has(f.turn) || history.filter(e => e.turn === f.turn).length !== 1 ||
        !(f.previousTurn === null || positive(f.previousTurn) && f.previousTurn < f.turn) ||
        !REPAIR_REPLY_COMPARISONS.includes(f.replyVsPrevious as RepairFact["replyVsPrevious"]) || typeof f.sameQuestionAsPrevious !== "boolean" ||
        !Array.isArray(f.localGaps) || new Set(f.localGaps).size !== f.localGaps.length ||
        !f.localGaps.every(g => REPAIR_LOCAL_GAPS.includes(g)) ||
        !Number.isSafeInteger(f.localRejections) || (f.localRejections as number) < 0 || (f.localRejections as number) > 64) invalid();
    const fact = f as RepairFact;
    seen.add(fact.turn);
    return { turn: fact.turn, previousTurn: fact.previousTurn, replyVsPrevious: fact.replyVsPrevious,
      sameQuestionAsPrevious: fact.sameQuestionAsPrevious, localGaps: [...fact.localGaps], localRejections: fact.localRejections };
  });
}
