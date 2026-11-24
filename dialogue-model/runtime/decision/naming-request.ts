import { nameBindsFigure, meaningfulEstimate } from "./referent-binding.ts";
import type { ReferentEstimateValue } from "./referent-binding.ts";
// holistic_v3 turn kinds from the turn's verified claims and the ledger before the turn. Pure and import-free: the run, the state validation, the participant restore
// and S4 recompute the markers `namingRequest` and `namingReconfirm` with these functions.
//  - a name proposal of the partner this turn that is not already agreed is a naming request (an approval request is itself a name proposal that carries the earlier
//    proposal's name, see local-grounding/verify.ts; an ordinary question about a name is not);
//  - a proposal is a reconfirmation of an agreed name only when the figure it binds to is determined (a single target, unless the target was inherited from an earlier
//    proposal and the partner's newest meaningful referent estimate points elsewhere; otherwise the figure that decision/referent-binding.ts binds) and the ledger before
//    the turn has that same name agreed for that figure. A proposal whose figure is undetermined stays an open request.
export type NamingClaimLike = { speaker?: unknown; act?: unknown; name?: unknown; sourceTurn?: unknown; targets?: unknown; id?: unknown; respondsTo?: unknown };
export type NamingLedgerLike = Record<string, { status?: unknown; name?: unknown } | undefined>;
export const namingNameKey = (s: string) => s.normalize("NFKC").trim().replace(/\s/gu, "").replace(/[ァ-ヶ]/gu, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));

/** The partner's name proposals of this turn (any state of the ledger). */
export function turnNameProposals(claims: readonly NamingClaimLike[], turn: number): NamingClaimLike[] {
  return claims.filter(c => !!c && c.speaker === "human" && c.act === "name_propose" && typeof c.name === "string" && c.name !== "" && c.sourceTurn === turn);
}
export const hasNameProposal = (claims: readonly NamingClaimLike[], turn: number): boolean => turnNameProposals(claims, turn).length > 0;

export type NamingJudgmentLike = { turnIndex?: unknown; judgment?: { action?: unknown } | null; jevTurn?: { humanReferent?: unknown } | null };
/** The partner's referent estimates of the current naming interval (after the last agree, defer or move_on, before this turn), oldest first, then this turn's. */
export function namingIntervalEstimates(judgments: readonly NamingJudgmentLike[], turn: number, current: ReferentEstimateValue): ReferentEstimateValue[] {
  const lastBoundary = judgments.filter(j => typeof j?.turnIndex === "number" && ["agree", "defer", "move_on"].includes(j.judgment?.action as string)).at(-1)?.turnIndex as number | undefined ?? 0;
  return [...judgments.filter(j => typeof j?.turnIndex === "number" && j.turnIndex > lastBoundary && j.turnIndex < turn).map(j => (j.jevTurn?.humanReferent ?? null) as ReferentEstimateValue), current];
}

/** The proposal's name is agreed already for the figure it binds to. A single target is that figure, except a target the proposal inherited from the earlier proposal it
 * answers when the newest meaningful estimate does not select it. Otherwise (unbound, several figures, or such an inherited target) the figure is the one the partner's
 * estimate binds (nameBindsFigure) among the targets, or among all figures when unbound. No bound figure: not a reconfirmation. */
function reconfirmsAgreedName(p: NamingClaimLike, claims: readonly NamingClaimLike[], ledger: NamingLedgerLike, estimates: readonly ReferentEstimateValue[]): boolean {
  const targets = Array.isArray(p.targets) ? p.targets.filter((t): t is string => typeof t === "string") : [];
  const key = namingNameKey(p.name as string);
  const agreed = (id: string) => ledger[id]?.status === "agreed" && typeof ledger[id]?.name === "string" && namingNameKey(ledger[id]!.name as string) === key;
  const antecedent = typeof p.respondsTo === "string" ? claims.find(c => c.id === p.respondsTo) : undefined;
  const antecedentTargets = Array.isArray(antecedent?.targets) ? antecedent!.targets as unknown[] : [];
  const inherited = !!antecedent && inheritsProposalName(p, claims) && targets.length > 0 && targets.length === antecedentTargets.length && targets.every(t => antecedentTargets.includes(t));
  const contradicted = inherited && estimates.some(meaningfulEstimate) && !nameBindsFigure(targets[0], estimates);
  if (targets.length === 1 && !contradicted) return agreed(targets[0]);
  const candidates = targets.length > 1 ? targets : Object.keys(ledger);
  const figure = candidates.find(id => nameBindsFigure(id, estimates));
  return figure !== undefined && agreed(figure);
}
export function namingTurnKind(claims: readonly NamingClaimLike[], turn: number, ledger: NamingLedgerLike, estimates: readonly ReferentEstimateValue[]): "none" | "request" | "reconfirm" {
  const proposals = turnNameProposals(claims, turn);
  if (!proposals.length) return "none";
  return proposals.every(p => reconfirmsAgreedName(p, claims, ledger, estimates)) ? "reconfirm" : "request";
}
/** A name proposal that answers an earlier name proposal and carries its name (the approval request of local-grounding/verify.ts). */
export function inheritsProposalName(c: NamingClaimLike, claims: readonly NamingClaimLike[]): boolean {
  return c.act === "name_propose" && typeof c.respondsTo === "string" && claims.some(p => p.id === c.respondsTo && p.act === "name_propose" && p.name === c.name);
}
