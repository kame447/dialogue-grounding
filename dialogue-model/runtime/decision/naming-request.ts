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

/** The claim ids whose empty extracted targets the verifier copied from the claim they answer (typed diagnostics `targets_inherited` of the turn's verification). */
export function inheritedTargetClaimIds(diagnostics: unknown): Set<string> {
  return new Set(Array.isArray(diagnostics) ? diagnostics.flatMap(d => d?.reason === "targets_inherited" && typeof d.claimId === "string" ? [d.claimId] : []) : []);
}

/** The proposal's name is agreed already for the figure it binds to. The partner's own words of this turn decide first: a single target the segment itself named
 * is that figure; a target carried over from the proposal it answers stands unless a meaningful estimate of the interval selects another. Otherwise (no target, several figures) the figure is the one the partner's estimate binds
 * (nameBindsFigure, newest meaningful estimate of the naming interval) among the targets, or among all figures when there are none. No bound figure: not a reconfirmation. */
function reconfirmsAgreedName(p: NamingClaimLike, ledger: NamingLedgerLike, estimates: readonly ReferentEstimateValue[], inherited: ReadonlySet<string>): boolean {
  const targets = Array.isArray(p.targets) ? p.targets.filter((t): t is string => typeof t === "string") : [];
  const key = namingNameKey(p.name as string);
  const agreed = (id: string) => ledger[id]?.status === "agreed" && typeof ledger[id]?.name === "string" && namingNameKey(ledger[id]!.name as string) === key;
  if (targets.length === 1) {
    // The partner's own single target of this turn decides. A target carried over from the proposal answered stands until the partner's estimate says otherwise.
    if (!inherited.has(p.id as string) || !estimates.some(meaningfulEstimate)) return agreed(targets[0]);
    return nameBindsFigure(targets[0], estimates) && agreed(targets[0]);
  }
  const figure = (targets.length ? targets : Object.keys(ledger)).find(id => nameBindsFigure(id, estimates));
  return figure !== undefined && agreed(figure);
}
export function namingTurnKind(claims: readonly NamingClaimLike[], turn: number, ledger: NamingLedgerLike, estimates: readonly ReferentEstimateValue[],
  inherited: ReadonlySet<string> = new Set()): "none" | "request" | "reconfirm" {
  const proposals = turnNameProposals(claims, turn);
  if (!proposals.length) return "none";
  return proposals.every(p => reconfirmsAgreedName(p, ledger, estimates, inherited)) ? "reconfirm" : "request";
}
/** Whether figure `id` may be an agree candidate of claim `c` (holistic_v3). `estimates` is the naming interval's estimates, oldest first, this turn's last.
 * A claim that does not name exactly one figure needs the interval's binding (nameBindsFigure). A single-target claim is free outside a naming request, and in one
 * when it is the partner's own single target of this very turn. Every other candidate of a naming request (an earlier turn's proposal, single-target or not, or a
 * target inherited this turn) must be strictly first in the newest meaningful estimate: this turn's if it has one, else the interval's latest. With no meaningful
 * estimate in the interval an earlier turn's single target stands as before, and a target inherited this turn does not. */
export function agreeCandidateAllowed(c: NamingClaimLike, id: string, turn: number, turnHasProposal: boolean, inherited: ReadonlySet<string>,
  estimates: readonly ReferentEstimateValue[]): boolean {
  const n = Array.isArray(c.targets) ? c.targets.length : 0;
  if (n !== 1) return nameBindsFigure(id, estimates);
  if (!turnHasProposal) return true;
  const own = c.sourceTurn === turn;
  if (own && !inherited.has(c.id as string)) return true;
  return estimates.some(meaningfulEstimate) ? nameBindsFigure(id, estimates) : !own;
}
/** A name proposal that answers an earlier name proposal and carries its name (the approval request of local-grounding/verify.ts). */
export function inheritsProposalName(c: NamingClaimLike, claims: readonly NamingClaimLike[]): boolean {
  return c.act === "name_propose" && typeof c.respondsTo === "string" && claims.some(p => p.id === c.respondsTo && p.act === "name_propose" && p.name === c.name);
}
