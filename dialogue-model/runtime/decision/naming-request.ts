// holistic_v3: a turn carries a typed naming request when the partner's utterance of that turn holds a name proposal. An approval request ("is that name fine?")
// is itself a name proposal (it carries the earlier proposal's name, see local-grounding/verify.ts); an ordinary question about a name is not. Pure and import-free:
// the run, the state validation, the participant restore and S4 all recompute the marker `namingRequest` from the turn's verified claims with this one function.
export type NamingClaimLike = { speaker?: unknown; act?: unknown; name?: unknown; sourceTurn?: unknown };
export function hasNamingRequest(claims: readonly NamingClaimLike[], turn: number): boolean {
  return claims.some(c => !!c && c.speaker === "human" && c.act === "name_propose" && typeof c.name === "string" && c.name !== "" && c.sourceTurn === turn);
}
