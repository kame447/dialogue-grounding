// Who the partner means by an unbound name proposal ("これ、〇〇とかどう？"): Jev's own estimate of the partner's referent is the only human-side evidence, and it is
// read here as a typed value. The AI having described and focused a figure does not bind the partner's proposal to it when the partner's own utterances since point
// elsewhere or at several figures. Pure; the run and the independent verifier both call it. No sentence is interpreted.
export type ReferentEstimateValue = { status: string; scores: Record<string, number> | null } | null | undefined;

/** `estimates`: the partner referent estimates of the human turns after the AI's last public claim about the figure, oldest first, the current turn last.
 * A figure stays bound unless an estimate scores another figure, or multiple, positively and at least as high as it; a later estimate that puts the figure strictly above every
 * other figure and multiple binds it again. none says nothing about which figure; no estimate or a failed one changes nothing. */
export function unboundNameBindsFigure(figureId: string, estimates: readonly ReferentEstimateValue[]): boolean {
  let bound = true;
  for (const m of estimates) {
    if (!m || m.status !== "ok" || !m.scores || typeof m.scores[figureId] !== "number") continue;
    const own = m.scores[figureId];
    const others = Object.entries(m.scores).filter(([key]) => key !== figureId && key !== "none").map(([, value]) => value);
    const strongestOther = Math.max(0, ...others);
    // Only a score that actually points elsewhere contests; an estimate that scores no figure at all (everything at zero) says nothing.
    if (strongestOther > 0 && strongestOther >= own) bound = false;
    else if (own > strongestOther) bound = true;
  }
  return bound;
}
