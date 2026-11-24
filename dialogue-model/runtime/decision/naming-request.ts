// holistic_v3 turn kinds from the turn's verified claims and the ledger before the turn. Pure and import-free: the run, the state validation, the participant restore
// and S4 recompute the markers `namingRequest` and `namingReconfirm` with these functions.
//  - a name proposal of the partner this turn that is not already agreed is a naming request (an approval request is itself a name proposal that carries the earlier
//    proposal's name, see local-grounding/verify.ts; an ordinary question about a name is not);
//  - a proposal whose name is already agreed for the figure it binds to is a reconfirmation of an agreed name: it is not an open request.
export type NamingClaimLike = { speaker?: unknown; act?: unknown; name?: unknown; sourceTurn?: unknown; targets?: unknown; id?: unknown; respondsTo?: unknown };
export type NamingLedgerLike = Record<string, { status?: unknown; name?: unknown } | undefined>;
export const namingNameKey = (s: string) => s.normalize("NFKC").trim().replace(/\s/gu, "").replace(/[ァ-ヶ]/gu, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));

/** The partner's name proposals of this turn (any state of the ledger). */
export function turnNameProposals(claims: readonly NamingClaimLike[], turn: number): NamingClaimLike[] {
  return claims.filter(c => !!c && c.speaker === "human" && c.act === "name_propose" && typeof c.name === "string" && c.name !== "" && c.sourceTurn === turn);
}
export const hasNameProposal = (claims: readonly NamingClaimLike[], turn: number): boolean => turnNameProposals(claims, turn).length > 0;

/** The proposal's name is agreed already for the figure it binds to: that one figure for a single target; for several figures, or none (unbound), the figures
 * (among them) on which that name is agreed. */
function reconfirmsAgreedName(p: NamingClaimLike, ledger: NamingLedgerLike): boolean {
  const targets = Array.isArray(p.targets) ? p.targets.filter((t): t is string => typeof t === "string") : [];
  const figures = targets.length ? targets : Object.keys(ledger);
  const key = namingNameKey(p.name as string);
  return figures.some(id => ledger[id]?.status === "agreed" && typeof ledger[id]?.name === "string" && namingNameKey(ledger[id]!.name as string) === key);
}
export function namingTurnKind(claims: readonly NamingClaimLike[], turn: number, ledger: NamingLedgerLike): "none" | "request" | "reconfirm" {
  const proposals = turnNameProposals(claims, turn);
  if (!proposals.length) return "none";
  return proposals.every(p => reconfirmsAgreedName(p, ledger)) ? "reconfirm" : "request";
}
/** A name proposal that answers an earlier name proposal and carries its name (the approval request of local-grounding/verify.ts). */
export function inheritsProposalName(c: NamingClaimLike, claims: readonly NamingClaimLike[]): boolean {
  return c.act === "name_propose" && typeof c.respondsTo === "string" && claims.some(p => p.id === c.respondsTo && p.act === "name_propose" && p.name === c.name);
}
