// adaptive_repair_v2: a past repair issue is closed for Jev's inference once every figure it concerned was later
// jointly adopted by a committed agree (which already requires a public name proposal). Repair history itself is
// research evidence and is never edited; only the open entries are passed on. A later human denial reopens it.
import type { RepairHistoryEntry } from "../decision/contract.ts";

export type RepairGate = { version: "agreement_gate_v1"; closed: { turn: number; issueId: string | null; agreeTurn: number }[] };
type Judged = { turnIndex: number; judgment: { action: string; targetSlot: string | null; candidateName?: string | null } };
type Claim = { speaker: string; act: string; targets: readonly string[]; sourceTurn: number };

const REOPEN_ACTS = ["deny", "name_reject"];
/** Committed agree turns per figure, strictly between `after` and `before`. */
function agreeTurns(judgments: readonly Judged[], figureId: string, after: number, before: number) {
  return judgments.filter(j => j.judgment.action === "agree" && j.judgment.targetSlot === figureId && j.turnIndex > after && j.turnIndex < before)
    .map(j => j.turnIndex);
}
/** A later committed act that moves the figure off "agreed" in the own ledger (judgment/schema.mjs applyAct). */
const demoted = (judgments: readonly Judged[], figureId: string, after: number, before: number) => judgments.some(j =>
  j.judgment.targetSlot === figureId && j.turnIndex > after && j.turnIndex < before &&
  (["repair", "defer"].includes(j.judgment.action) || j.judgment.action === "confirm" && (j.judgment.candidateName ?? null) !== null));

/** Decision-time gate: judgments, claims and the own ledger as they stand when `turn` is decided. */
export function agreementGate(history: readonly RepairHistoryEntry[], judgments: readonly Judged[], claims: readonly Claim[], turn: number,
  ledger?: Readonly<Record<string, { status: string }>>): RepairGate {
  const closed: RepairGate["closed"] = [];
  for (const r of history) {
    if (r.turn >= turn || !r.candidatesAfter.length) continue;
    let agreeTurn = 0;
    const all = r.candidatesAfter.every(figureId => {
      const latest = Math.max(0, ...agreeTurns(judgments, figureId, r.turn, turn));
      const reopened = claims.some(c => c.speaker === "human" && REOPEN_ACTS.includes(c.act) && c.targets.includes(figureId) &&
        c.sourceTurn > latest && c.sourceTurn <= turn);
      agreeTurn = Math.max(agreeTurn, latest);
      return latest > 0 && !reopened && !demoted(judgments, figureId, latest, turn) && (!ledger || ledger[figureId]?.status === "agreed");
    });
    if (all) closed.push({ turn: r.turn, issueId: r.issueId, agreeTurn });
  }
  return { version: "agreement_gate_v1", closed };
}

const isClosed = (gate: RepairGate, r: RepairHistoryEntry) => gate.closed.some(c => c.turn === r.turn && c.issueId === r.issueId);
export function inferenceHistory(history: readonly RepairHistoryEntry[], gate: RepairGate): RepairHistoryEntry[] {
  return history.filter(r => !isClosed(gate, r));
}

const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
/** Restore: every recorded closure must be justified by agrees saved before that turn. A recorded reopening
 * (an entry left open) is kept as recorded, since older claims may have been pruned from the saved graph. */
export function checkRepairGate(gate: unknown, history: readonly RepairHistoryEntry[], judgments: readonly Judged[], turn: number): gate is RepairGate {
  if (!exact(gate, ["version", "closed"]) || gate.version !== "agreement_gate_v1" || !Array.isArray(gate.closed)) return false;
  const seen = new Set<string>();
  for (const c of gate.closed) {
    if (!exact(c, ["turn", "issueId", "agreeTurn"]) || !Number.isSafeInteger(c.turn) || !Number.isSafeInteger(c.agreeTurn) ||
        !(c.issueId === null || typeof c.issueId === "string")) return false;
    const key = JSON.stringify([c.turn, c.issueId]);
    if (seen.has(key)) return false;
    seen.add(key);
    const r = history.find(h => h.turn === c.turn && h.issueId === c.issueId);
    if (!r || r.turn >= turn || !r.candidatesAfter.length) return false;
    const turns = r.candidatesAfter.map(figureId => agreeTurns(judgments, figureId, r.turn, turn));
    if (turns.some(t => !t.length) || !turns.some(t => t.includes(c.agreeTurn as number)) ||
        r.candidatesAfter.some((figureId, i) => demoted(judgments, figureId, Math.max(...turns[i]), turn))) return false;
  }
  return true;
}
