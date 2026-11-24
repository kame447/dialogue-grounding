// Which figure a name binds to when the partner's proposal does not itself name exactly one figure (an unbound name, or a name proposed for several figures):
// only the partner's own evidence decides, and the only human-side evidence is Jev's estimate of the partner's referent, read here as a typed value.
// What the AI said, explained or asked about never binds or unbinds a name. No sentence is interpreted. Pure: the run and the independent verifier both call it.
export type ReferentEstimateValue = { status: string; scores: Record<string, number> | null } | null | undefined;

/** An estimate that points somewhere: status ok, the strongest figure-or-multiple value above zero and strictly above none. Failed, missing, none-first and
 * all-zero estimates say nothing about which figure is meant. */
export function meaningfulEstimate(m: ReferentEstimateValue): m is { status: string; scores: Record<string, number> } {
  if (!m || m.status !== "ok" || !m.scores) return false;
  const strongest = Math.max(-Infinity, ...Object.entries(m.scores).filter(([key]) => key !== "none").map(([, value]) => value));
  const none = typeof m.scores.none === "number" ? m.scores.none : 0;
  return Number.isFinite(strongest) && strongest > 0 && strongest > none;
}

/** `estimates`: the partner's referent estimates of the human turns of the current naming interval (after the last agree, defer or move_on, up to this turn),
 * oldest first. The newest meaningful one decides: the name binds to the figure only if that estimate puts the figure strictly above every other figure and
 * above multiple. With no meaningful estimate in the interval nothing binds. */
export function nameBindsFigure(figureId: string, estimates: readonly ReferentEstimateValue[]): boolean {
  for (let i = estimates.length - 1; i >= 0; i--) {
    const m = estimates[i];
    if (!meaningfulEstimate(m)) continue;
    const own = m.scores[figureId];
    if (typeof own !== "number") return false;
    return Object.entries(m.scores).every(([key, value]) => key === figureId || key === "none" || value < own);
  }
  return false;
}
