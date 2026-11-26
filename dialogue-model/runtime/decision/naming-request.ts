import { nameBindsFigure, meaningfulEstimate } from "./referent-binding.ts";
import type { ReferentEstimateValue } from "./referent-binding.ts";
import { directsToFigure, isFigureReplyAspect } from "../local-grounding/verify.ts";
import { LABELLED_ANSWER_SOURCE } from "../local-grounding/contract.ts";
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
/** The claims of a reference graph as the turn `turn` saw them: only records that existed by then, without the claims a withdrawal, a retraction or a dead response had
 * already killed. The decision of a turn derives its naming marker from this view (priorClaimViews), so a later withdrawal, rename or pruning cannot change it. */
export function claimsLiveAsOf(records: readonly { kind?: unknown; id?: unknown; turn?: unknown; sourceTurn?: unknown; act?: unknown; respondsTo?: unknown; targetId?: unknown }[],
  turn: number): NamingClaimLike[] {
  // A saved trace's claims carry no update turn; their source turn stands for it.
  const known = records.filter(r => { const at = r && (typeof r.turn === "number" ? r.turn : r.sourceTurn); return typeof at === "number" && at <= turn; });
  const claims = known.filter(r => r.kind === "claim");
  const dead = new Set<unknown>(known.filter(r => r.kind === "retract").map(r => r.targetId));
  for (const c of claims) if (c.act === "withdraw" && c.respondsTo && !dead.has(c.id)) dead.add(c.respondsTo);
  for (let changed = true; changed;) {
    changed = false;
    for (const c of claims) if (c.act !== "withdraw" && c.respondsTo && dead.has(c.respondsTo) && !dead.has(c.id)) { dead.add(c.id); changed = true; }
  }
  return claims.filter(c => !dead.has(c.id)) as NamingClaimLike[];
}
export type NamingJudgmentEvidence = { turnIndex?: unknown; judgment?: { action?: unknown; targetSlot?: unknown; candidateName?: unknown; discriminatingFeature?: unknown; followUp?: unknown } | null;
  jevTurn?: { executed?: { action?: unknown; name?: unknown } | null } | null };
/** The names the judgments before `turn` left agreed, replayed over an empty ledger with the same acts the run applies (a judgment on no single figure and a feature-only
 * repair leave the ledger alone). A later defer or repair of an agreed name takes it out again. */
function namesAgreedBefore(judgments: readonly NamingJudgmentEvidence[], turn: number): Set<string> {
  const ledger = new Map<string, { status: string; name: string | null }>();
  const apply = (g: NonNullable<NamingJudgmentEvidence["judgment"]> | null | undefined) => {
    if (!g || typeof g.targetSlot !== "string") return;
    const slot = g.targetSlot, current = ledger.get(slot) ?? { status: "unassigned", name: null };
    const name = typeof g.candidateName === "string" ? g.candidateName : null;
    if (g.action === "repair") ledger.set(slot, name === null ? { status: "unassigned", name: null } : { status: "tentative", name });
    else if (g.action === "agree") ledger.set(slot, { status: "agreed", name: name ?? current.name });
    else if (g.action === "defer") ledger.set(slot, { status: "deferred", name: name ?? current.name });
    else if (g.action === "revisit") ledger.set(slot, { status: current.status === "agreed" ? "agreed" : (name ?? current.name) === null ? "unassigned" : "tentative", name: name ?? current.name });
    else if (g.action === "confirm" && name !== null) ledger.set(slot, { status: "tentative", name });
    else if (name !== null && (g.action === "accept" || g.action === "propose_name")) ledger.set(slot, { status: current.status === "agreed" ? "agreed" : "tentative", name });
  };
  for (const x of judgments) {
    if (typeof x?.turnIndex !== "number" || x.turnIndex >= turn || !x.judgment) continue;
    const g = x.judgment;
    if (g.action === "repair" && g.candidateName === null && g.discriminatingFeature !== null && g.discriminatingFeature !== undefined) continue;
    apply(g);
    if (g.followUp && typeof g.followUp === "object") apply(g.followUp as NonNullable<NamingJudgmentEvidence["judgment"]>);
  }
  return new Set([...ledger.values()].filter(e => e.status === "agreed" && typeof e.name === "string").map(e => namingNameKey(e.name as string)));
}
/** Whether a reconfirmation marker is possible for `turn`: every proposal of the turn names something the judgments before it left agreed (a name agreed and then deferred
 * is not). A ledger that holds the name although no judgment ever agreed it (a ledger the run started with) counts too. The turn that first agreed a name, or a later one,
 * can never be a reconfirmation, whatever the ledger says afterwards. Uses only what a saved judgment history holds: no graph, so pruning and renaming cannot change it. */
export function reconfirmationPossible(proposals: readonly NamingClaimLike[], turn: number, judgments: readonly NamingJudgmentEvidence[], ledger: NamingLedgerLike): boolean {
  if (!proposals.length) return false;
  const before = namesAgreedBefore(judgments, turn);
  const everAgreed = (key: string) => judgments.some(x => x?.jevTurn?.executed?.action === "agree" && typeof x.jevTurn.executed.name === "string" && namingNameKey(x.jevTurn.executed.name) === key);
  return proposals.every(p => {
    if (typeof p.name !== "string") return false;
    const key = namingNameKey(p.name);
    return before.has(key) || !everAgreed(key) && Object.values(ledger ?? {}).some(e => e?.status === "agreed" && typeof e.name === "string" && namingNameKey(e.name) === key);
  });
}

export type AgreeNameScopeVersion = "scoped_v1" | "scoped_v2" | "scoped_v3" | "scoped_v4" | "scoped_v5" | "scoped_v6" | "scoped_v7" | "scoped_v8" | "scoped_v9";
export function usesPublicNamingTarget(scope: unknown): scope is Exclude<AgreeNameScopeVersion, "scoped_v1"> {
  return scope === "scoped_v2" || scope === "scoped_v3" || scope === "scoped_v4" || scope === "scoped_v5" || scope === "scoped_v6" || scope === "scoped_v7" || scope === "scoped_v8" || scope === "scoped_v9";
}

export type NamingJudgmentLike = {
  turnIndex?: unknown; judgment?: { action?: unknown } | null; generationGuard?: { fallback?: boolean } | null;
  jevTurn?: { humanReferent?: unknown; executed?: { target: { kind: string; figureId?: string; figureIds?: readonly string[] } } } | null;
  aiPublic?: { aiSeq?: number };
};

/** A feature answer can lift a denial after the AI has publicly repaired that check. */
export function answersRepairedNamingCheck(reply: LocalClaimView, question: LocalClaimView, denial: LocalClaimView,
  judgments: readonly NamingJudgmentLike[]): boolean {
  return question.act === "ask" && question.sourceTurn > denial.sourceTurn &&
    (question.aspect === "referent" || directsToFigure(reply.quote, true)) && judgments.some(j =>
    j.aiPublic?.aiSeq === question.sourceTurn && j.generationGuard?.fallback !== true && j.judgment?.action === "repair" &&
    j.jevTurn?.executed?.target.kind === "single" && j.jevTurn.executed.target.figureId === question.targets[0]);
}

const isFigureEvidence = (c: LocalClaimView) => c.name === null &&
  ["referent", "part", "contour", "construal"].includes(c.aspect);

/** Find the figure supported by the open public exchange. Naming claims and
 * referent scores can suggest candidates; neither supplies figure evidence.
 * The caller supplies live claims and their public source turns. */
/** The reply points to the figure by its own words, or (v12) was counted as the answer because the classifier's label said so. */
const pointed = (reply: LocalClaimView, direct: boolean) => reply.source === LABELLED_ANSWER_SOURCE || directsToFigure(reply.quote, direct);
export function publiclyCheckedNamingTarget(claims: readonly LocalClaimView[], publicTurns: readonly PublicTurn[],
  judgments: readonly NamingJudgmentLike[], turn: number, includeAgreed = false, scope: AgreeNameScopeVersion = "scoped_v2"): string | null {
  const directNamingReplies = scope === "scoped_v9";
  const directConstrualAnswer = scope === "scoped_v7" || scope === "scoped_v8" || directNamingReplies;
  const directReferenceReplies = scope === "scoped_v5" || scope === "scoped_v6" || directConstrualAnswer;
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
      if ((scope === "scoped_v3" || scope === "scoped_v4" || directReferenceReplies) && c.act !== "ask" && (scope === "scoped_v6" || directConstrualAnswer || ids.length <= 2) &&
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
    if (!directNamingReplies && reply.act === "assert" && reply.aspect === "referent") { answers.push(reply); continue; }
    const antecedent = reply.respondsTo === null ? undefined : ai.get(reply.respondsTo);
    if (directReferenceReplies && antecedent?.claim.act === "ask" && reply.act === "agree" &&
        (reply.aspect === "question" || pointed(reply, true))) {
      // The original question must still be the direct antecedent, and a
      // newer live denial or reopening of that check voids this positive proof.
      const question = antecedent.claim;
      const previousTurn = publicTurns.filter(event => event.turn < reply.sourceTurn).at(-1);
      if (previousTurn?.turn !== question.sourceTurn || !pointed(reply, true) ||
          live.some(c => c.speaker === "human" && c.sourceTurn > reply.sourceTurn &&
            (c.respondsTo === question.id || c.respondsTo === reply.id || c.issueId === question.issueId ||
              c.aspect === "referent" && c.targets.includes(reply.targets[0])) &&
            (c.act === "deny" || c.act === "ask"))) continue;
    }
    if (reply.act === "agree" && antecedent && (antecedent.singleton || describedChecks.has(antecedent.claim.sourceTurn)) &&
        antecedent.claim.sourceTurn < reply.sourceTurn && antecedent.claim.aspect === reply.aspect &&
        antecedent.claim.targets.length === 1 && antecedent.claim.targets[0] === reply.targets[0] &&
        (!directNamingReplies || !describedChecks.has(antecedent.claim.sourceTurn) || antecedent.claim.act === "ask") &&
        (reply.aspect !== "question" || antecedent.claim.act === "ask" && antecedent.singleton && describedChecks.has(antecedent.claim.sourceTurn) && pointed(reply, directReferenceReplies))) {
      answers.push(reply); continue;
    }
    if (reply.act !== "assert" && reply.act !== "construe") continue;
    const previousAi = publicTurns.filter(event => event.speaker === "ai" && event.turn < reply.sourceTurn).at(-1);
    if (!previousAi || publicTurns.some(event => event.speaker === "human" && event.turn > previousAi.turn && event.turn < reply.sourceTurn)) continue;
    if (directNamingReplies && (antecedent?.claim.act !== "ask" || antecedent.claim.sourceTurn !== previousAi.turn ||
        antecedent.claim.targets.length !== 1 || antecedent.claim.targets[0] !== reply.targets[0])) continue;
    // A construal can be classified as an assertion and still describe a
    // different figure. Count it only if it answers a verified claim in this check.
    const construal = reply.act === "construe" || reply.aspect === "construal";
    if (directConstrualAnswer && construal && antecedent?.claim.sourceTurn !== previousAi.turn) continue;
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

/** Whether a saved trace's naming marker contradicts the claims live when its turn was decided (the restore's check, shared with its tests). A proposal the same utterance
 * withdrew is not live, so it neither requires a marker nor makes one possible. `markerAllowed`: the version and layout carry markers at all; `unmarkedChecked`: the version
 * requires a marker on every committed turn with a live proposal. */
export function traceMarkerInvalid(trace: any, judgments: readonly NamingJudgmentEvidence[], ledger: NamingLedgerLike, { markerAllowed, unmarkedChecked }: { markerAllowed: boolean; unmarkedChecked: boolean },
  earlierClaims: readonly any[] = []): boolean {
  const requested = Object.hasOwn(trace, "namingRequest"), reconfirmed = Object.hasOwn(trace, "namingReconfirm"), marked = requested || reconfirmed;
  // `earlierClaims`: the claims the earlier committed turns' traces hold. A withdrawal reaches a proposal through a confirmation of it that an earlier turn made, and that
  // confirmation (not in this turn's own claims) dies with the proposal, so it must be present for the turn's view to be the one the decision saw.
  const live = Array.isArray(trace.local?.claims) ? claimsLiveAsOf([...earlierClaims, ...trace.local.claims], trace.turnIndex) : null;
  if (marked && (requested && trace.namingRequest !== true || reconfirmed && trace.namingReconfirm !== true || requested && reconfirmed || !markerAllowed ||
      !live || !hasNameProposal(live, trace.turnIndex))) return true;
  // A reconfirmation names only what an earlier turn left agreed. The state check cannot see a proposal the graph pruned, so the trace's own claims decide here.
  if (reconfirmed && trace.status === "committed" && !reconfirmationPossible(turnNameProposals(live ?? [], trace.turnIndex), trace.turnIndex, judgments, ledger)) return true;
  return !marked && unmarkedChecked && trace.status === "committed" && !!live && hasNameProposal(live, trace.turnIndex);
}
