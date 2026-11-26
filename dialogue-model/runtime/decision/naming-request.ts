import { nameBindsFigure, meaningfulEstimate } from "./referent-binding.ts";
import type { ReferentEstimateValue } from "./referent-binding.ts";
import { directsToFigure, isFigureReplyAspect } from "../local-grounding/verify.ts";
import type { LocalClaimView, PublicTurn } from "../local-grounding/contract.ts";
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

export type AgreeNameScopeVersion = "scoped_v1" | "scoped_v2" | "scoped_v3" | "scoped_v4" | "scoped_v5" | "scoped_v6";
export function usesPublicNamingTarget(scope: unknown): scope is "scoped_v2" | "scoped_v3" | "scoped_v4" | "scoped_v5" | "scoped_v6" {
  return scope === "scoped_v2" || scope === "scoped_v3" || scope === "scoped_v4" || scope === "scoped_v5" || scope === "scoped_v6";
}

export type NamingJudgmentLike = {
  turnIndex?: unknown; judgment?: { action?: unknown } | null; generationGuard?: { fallback?: boolean } | null;
  jevTurn?: { humanReferent?: unknown; executed?: { target: { kind: string; figureId?: string; figureIds?: readonly string[] } } } | null;
  aiPublic?: { aiSeq?: number };
};

const isFigureEvidence = (c: LocalClaimView) => c.name === null &&
  ["referent", "part", "contour", "construal"].includes(c.aspect);

/** Find the figure supported by the open public exchange. Naming claims and
 * referent scores can suggest candidates; neither supplies figure evidence.
 * The caller supplies live claims and their public source turns. */
export function publiclyCheckedNamingTarget(claims: readonly LocalClaimView[], publicTurns: readonly PublicTurn[],
  judgments: readonly NamingJudgmentLike[], turn: number, includeAgreed = false, scope: AgreeNameScopeVersion = "scoped_v2"): string | null {
  const directReferenceReplies = scope === "scoped_v5" || scope === "scoped_v6";
  const before = judgments.filter((j): j is NamingJudgmentLike & { turnIndex: number } => typeof j.turnIndex === "number" && j.turnIndex < turn);
  const lastBoundary = before.filter(j => ["agree", "defer", "move_on"].includes(j.judgment?.action as string)).at(-1);
  const boundary = lastBoundary?.turnIndex ?? 0;
  const publicByTurn = new Map(publicTurns.map(t => [t.turn, t]));
  const live = claims.filter(c => {
    const event = publicByTurn.get(c.sourceTurn);
    return c.sourceTurn > boundary && c.sourceTurn <= turn &&
      (isFigureEvidence(c) || c.aspect === "question" &&
        (c.speaker === "ai" && c.act === "ask" || scope === "scoped_v4" && c.speaker === "human" && c.act === "agree") ||
        directReferenceReplies && c.name === null && isFigureReplyAspect(c.aspect) &&
          (c.speaker === "ai" ? c.act === "ask" : c.act === "agree" || c.act === "deny" || c.act === "ask")) &&
      event?.speaker === c.speaker && !!c.quote && event.text.includes(c.quote);
  });
  const publications = new Map<number, typeof before[number]>();
  for (const judgment of before) {
    const seq = judgment.aiPublic?.aiSeq;
    if (seq !== undefined && judgment.turnIndex > boundary && judgment.generationGuard?.fallback !== true &&
        publicByTurn.get(seq)?.speaker === "ai") publications.set(seq, judgment);
  }
  const ai = new Map<string, { claim: LocalClaimView; singleton: boolean }>();
  const describedChecks = new Set<number>();
  for (const c of live) {
    if (c.speaker !== "ai" || !["ask", "assert", "construe", "agree"].includes(c.act)) continue;
    const published = publications.get(c.sourceTurn);
    const target = published?.jevTurn?.executed?.target;
    const ids = target?.kind === "single" ? [target.figureId] : target?.kind === "multiple" ? target.figureIds : undefined;
    if (ids && c.targets.length > 0 && c.targets.every(id => ids.includes(id))) {
      ai.set(c.id, { claim: c, singleton: target?.kind === "single" });
      // Public descriptions corroborate the executed check even when its
      // question has no extracted target or was missed by extraction entirely.
      // scoped_v6: a described check counts for any number of candidates, not only two. A confirm that only states something stays a check awaiting an answer (it never becomes public focus).
      if ((scope === "scoped_v3" || scope === "scoped_v4" || directReferenceReplies) && c.act !== "ask" && (scope === "scoped_v6" || ids.length <= 2) &&
          (published?.judgment?.action === "confirm" || published?.judgment?.action === "repair")) {
        describedChecks.add(c.sourceTurn);
      }
    }
  }

  // Distinguishing the figure, or answering a documented single-figure check,
  // is evidence even when the function classifier emits assert instead of agree.
  const answers: LocalClaimView[] = [];
  for (const reply of live) {
    if (reply.speaker !== "human" || reply.targets.length !== 1) continue;
    if (reply.act === "assert" && reply.aspect === "referent") { answers.push(reply); continue; }
    const antecedent = reply.respondsTo === null ? undefined : ai.get(reply.respondsTo);
    if (directReferenceReplies && antecedent?.claim.act === "ask" && reply.act === "agree" &&
        (reply.aspect === "question" || directsToFigure(reply.quote, true))) {
      // The original question must still be the direct antecedent, and a
      // newer live denial or reopening of that check voids this positive proof.
      const question = antecedent.claim;
      const previousTurn = publicTurns.filter(event => event.turn < reply.sourceTurn).at(-1);
      if (previousTurn?.turn !== question.sourceTurn || !directsToFigure(reply.quote, true) ||
          live.some(c => c.speaker === "human" && c.sourceTurn > reply.sourceTurn &&
            (c.respondsTo === question.id || c.respondsTo === reply.id || c.issueId === question.issueId ||
              c.aspect === "referent" && c.targets.includes(reply.targets[0])) &&
            (c.act === "deny" || c.act === "ask"))) continue;
    }
    if (reply.act === "agree" && antecedent && (antecedent.singleton || describedChecks.has(antecedent.claim.sourceTurn)) &&
        antecedent.claim.sourceTurn < reply.sourceTurn && antecedent.claim.aspect === reply.aspect &&
        antecedent.claim.targets.length === 1 && antecedent.claim.targets[0] === reply.targets[0] &&
        (reply.aspect !== "question" || antecedent.claim.act === "ask" && antecedent.singleton && describedChecks.has(antecedent.claim.sourceTurn) && directsToFigure(reply.quote, directReferenceReplies))) {
      answers.push(reply); continue;
    }
    if (reply.act !== "assert" && reply.act !== "construe") continue;
    const previousAi = publicTurns.filter(event => event.speaker === "ai" && event.turn < reply.sourceTurn).at(-1);
    if (!previousAi || publicTurns.some(event => event.speaker === "human" && event.turn > previousAi.turn && event.turn < reply.sourceTurn)) continue;
    const check = publications.get(previousAi.turn);
    const target = check?.jevTurn?.executed?.target;
    if (target?.kind === "single" && target.figureId === reply.targets[0] &&
        ["confirm", "repair"].includes(check?.judgment?.action as string)) answers.push(reply);
  }
  const answerAt = Math.max(0, ...answers.map(c => c.sourceTurn));
  const ambiguityAt = Math.max(0, ...live.filter(c => c.speaker === "human" && c.aspect === "referent" &&
    (c.act === "ask" || c.act === "assert" && c.targets.length > 1)).map(c => c.sourceTurn));
  if (ambiguityAt > 0 && ambiguityAt >= answerAt) return null;

  // A check's preamble establishes what was asked, but cannot answer the
  // check. A later public focus or a human answer can supply the evidence.
  const focus = [...ai.values()].filter(({ claim, singleton }) =>
    singleton && claim.act !== "ask" && claim.targets.length === 1 && !describedChecks.has(claim.sourceTurn));
  const focusAt = Math.max(0, ...focus.map(({ claim }) => claim.sourceTurn));
  // An AI question in the active exchange remains open when the human reply
  // just asks about a name. A public description on a later turn can establish
  // a new public focus, while explicit human ambiguity needs a human answer.
  if ([...ai.values()].some(({ claim }) => claim.act === "ask" && claim.sourceTurn >= focusAt && claim.sourceTurn >= answerAt)) return null;
  if ([...describedChecks].some(sourceTurn => sourceTurn >= focusAt && !answers.some(reply =>
    reply.sourceTurn > sourceTurn && (reply.act !== "agree" ||
      (ai.get(reply.respondsTo!)?.claim.sourceTurn ?? 0) >= sourceTurn)))) return null;

  const supported = new Set<string>();
  const evidenceAt = Math.max(focusAt, answerAt);
  if (focusAt === evidenceAt) for (const { claim } of focus) if (claim.sourceTurn === focusAt) supported.add(claim.targets[0]);
  if (answerAt === evidenceAt) for (const reply of answers) if (reply.sourceTurn === answerAt) supported.add(reply.targets[0]);
  const agreed = lastBoundary?.jevTurn?.executed?.target;
  if (!evidenceAt && includeAgreed && lastBoundary?.judgment?.action === "agree" && agreed?.kind === "single" && agreed.figureId) {
    supported.add(agreed.figureId);
  }
  if (supported.size !== 1) return null;
  const [figure] = supported;
  if (live.some(c => c.speaker === "human" && c.sourceTurn >= evidenceAt && c.act === "deny" && c.targets.includes(figure))) return null;
  return figure;
}
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
function reconfirmsAgreedName(p: NamingClaimLike, ledger: NamingLedgerLike, estimates: readonly ReferentEstimateValue[], inherited: ReadonlySet<string>,
  publiclyChecked: string | null | undefined): boolean {
  const targets = Array.isArray(p.targets) ? p.targets.filter((t): t is string => typeof t === "string") : [];
  const key = namingNameKey(p.name as string);
  const agreed = (id: string) => (publiclyChecked === undefined || publiclyChecked === id) &&
    ledger[id]?.status === "agreed" && typeof ledger[id]?.name === "string" && namingNameKey(ledger[id]!.name as string) === key;
  if (targets.length === 1) {
    // The partner's own single target of this turn decides. A target carried over from the proposal answered stands until the partner's estimate says otherwise.
    if (!inherited.has(p.id as string) || !estimates.some(meaningfulEstimate)) return agreed(targets[0]);
    return nameBindsFigure(targets[0], estimates) && agreed(targets[0]);
  }
  const figure = (targets.length ? targets : Object.keys(ledger)).find(id => nameBindsFigure(id, estimates));
  return figure !== undefined && agreed(figure);
}
export function namingTurnKind(claims: readonly NamingClaimLike[], turn: number, ledger: NamingLedgerLike, estimates: readonly ReferentEstimateValue[],
  inherited: ReadonlySet<string> = new Set(), publiclyChecked?: string | null): "none" | "request" | "reconfirm" {
  const proposals = turnNameProposals(claims, turn);
  if (!proposals.length) return "none";
  return proposals.every(p => reconfirmsAgreedName(p, ledger, estimates, inherited, publiclyChecked)) ? "reconfirm" : "request";
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

/** Generation context for one selected figure, using only live proposals of this turn and its pre-turn ledger entry. */
export function targetNamingConflict(claims: readonly NamingClaimLike[], turn: number, entry: NamingLedgerLike[string], figureId: string,
  estimates: readonly ReferentEstimateValue[], inherited: ReadonlySet<string>): { agreedName: string; proposedNames: string[] } | null {
  if (entry?.status !== "agreed" || typeof entry.name !== "string") return null;
  const agreedKey = namingNameKey(entry.name);
  const proposals = new Map<string, string>();
  for (const proposal of turnNameProposals(claims, turn)) {
    if (!Array.isArray(proposal.targets) || (proposal.targets.length > 0 && !proposal.targets.includes(figureId)) ||
        !agreeCandidateAllowed(proposal, figureId, turn, true, inherited, estimates)) continue;
    const name = proposal.name as string;
    const key = namingNameKey(name);
    if (key && key !== agreedKey && !proposals.has(key)) proposals.set(key, name);
  }
  return proposals.size ? { agreedName: entry.name, proposedNames: [...proposals.values()] } : null;
}
/** A name proposal that answers an earlier name proposal and carries its name (the approval request of local-grounding/verify.ts); from holistic_v4 the answered claim may also be a public adoption (name_accept) that carries the name. */
export function inheritsProposalName(c: NamingClaimLike, claims: readonly NamingClaimLike[], fromNamedClaim = false): boolean {
  return c.act === "name_propose" && typeof c.respondsTo === "string" && claims.some(p => p.id === c.respondsTo && (p.act === "name_propose" || fromNamedClaim && p.act === "name_accept") && p.name === c.name);
}
