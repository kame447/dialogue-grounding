import { literalSpan } from "../judgment/public-evidence.mjs";
import { normalizeName } from "../judgment/name-evidence.mjs";
import type { LocalClaimView, LocalFunctionVerdict, LocalSegmentProposal, PublicTurn } from "../local-grounding/contract.ts";
import { isFigureReplyAspect } from "../local-grounding/verify.ts";
import type { NamingJudgmentLike } from "./naming-request.ts";

type NamingTurn = PublicTurn & { nonReferential?: boolean };
type ReferentEstimate = { status: string; scores: Record<string, number> | null };
export type NamingResponseEvidence = {
  extractor: { segments: readonly LocalSegmentProposal[] };
  classifier: { status: string; verdicts: readonly Pick<LocalFunctionVerdict, "segmentId" | "act" | "respondsToClaimId" | "answersChecked">[] };
};
type Reconfirmation = { figureId: string; denialId: string; names: ReadonlySet<string> };

function publishedClaim(claim: LocalClaimView, event: NamingTurn | undefined): boolean {
  return event?.speaker === "ai" && !event.nonReferential && claim.speaker === "ai" &&
    claim.sourceTurn === event.turn && !!claim.quote && event.text.includes(claim.quote);
}

function singleCheckTarget(event: NamingTurn, judgments: readonly NamingJudgmentLike[]): string | undefined {
  const publication = judgments.find(j => j.aiPublic?.aiSeq === event.turn);
  const executed = publication?.jevTurn?.executed?.target;
  if (publication?.generationGuard?.fallback !== true && executed?.kind === "single" &&
      (publication?.judgment?.action === "confirm" || publication?.judgment?.action === "repair")) return executed.figureId;
}

/** A local denial of a mixed extraction still addresses the one figure actually checked in public. */
export function namingDenialTargets(denial: LocalClaimView, antecedent: LocalClaimView | undefined,
  turns: readonly NamingTurn[], judgments: readonly NamingJudgmentLike[], scope: unknown): readonly string[] {
  const original = Array.isArray(denial.targets) && denial.targets.length ? denial.targets : antecedent?.targets ?? [];
  if (scope !== "scoped_v11" || denial.aspect !== "question" || denial.targets.length < 2 ||
      antecedent?.act !== "ask" || antecedent.aspect !== "question" || antecedent.targets.length < 2) return original;
  const preceding = turns.filter(t => t.turn < denial.sourceTurn).at(-1);
  if (!preceding || !publishedClaim(antecedent, preceding)) return original;
  const target = singleCheckTarget(preceding, judgments);
  return target && antecedent.targets.includes(target) && original.includes(target) ? [target] : original;
}

/** Reconcile a direct feature answer and a distinct identity answer to the same
 * published check. Both remain local evidence, and this dispenses only with the
 * one denial for names the partner proposed for this figure on this turn. */
export function namingReconfirmation(claims: readonly LocalClaimView[], turns: readonly NamingTurn[],
  judgments: readonly NamingJudgmentLike[], turn: number, boundary: number,
  current: ReferentEstimate | null, evidence: NamingResponseEvidence | undefined): Reconfirmation | null {
  if (current?.status !== "ok" || !current.scores || evidence?.classifier?.status !== "ok" ||
      !Array.isArray(evidence.extractor?.segments) || !Array.isArray(evidence.classifier.verdicts)) return null;
  const human = turns.find(t => t.turn === turn && t.speaker === "human");
  const previous = turns.filter(t => t.turn < turn).at(-1);
  if (!human || !previous || previous.turn <= boundary) return null;
  const figureId = singleCheckTarget(previous, judgments);
  const score = figureId === undefined ? undefined : current.scores[figureId];
  if (figureId === undefined || typeof score !== "number" ||
      !Object.entries(current.scores).every(([id, value]) => id === figureId || score > value)) return null;
  const publicClaims = claims.filter(c => publishedClaim(c, previous));
  const questions = publicClaims.filter(c => c.act === "ask");
  const question = questions[0];
  if (questions.length !== 1 || question.aspect !== "question" ||
      question.targets.length !== 1 || question.targets[0] !== figureId) return null;
  const names = new Set(claims.filter(c => c.speaker === "human" && c.sourceTurn === turn && c.act === "name_propose" &&
    c.name !== null && c.targets.includes(figureId)).map(c => normalizeName(c.name)));
  if (names.size === 0) return null;

  const priorDenial = claims.filter(c => c.speaker === "human" && c.act === "deny" && c.aspect === "question" &&
    c.sourceTurn > boundary && c.sourceTurn < turn && c.targets.length === 1 && c.targets[0] === figureId &&
    claims.some(q => q.id === c.respondsTo && q.speaker === "ai" && q.act === "ask" && q.aspect === "question" &&
      q.sourceTurn < c.sourceTurn && q.targets.length === 1 && q.targets[0] === figureId)).at(-1);
  if (!priorDenial || question.sourceTurn <= priorDenial.sourceTurn ||
      claims.some(c => c.speaker === "human" && c.sourceTurn === turn &&
        (c.act === "deny" && c.targets.includes(figureId) ||
          c.aspect === "referent" && (c.act === "ask" || c.act === "assert" && c.targets.length > 1)))) return null;

  const replies = evidence.extractor.segments.flatMap(segment => {
    const span = literalSpan(human.text, segment.quote);
    const matches = evidence.classifier.verdicts.filter(v => v.segmentId === segment.segmentId);
    if (!span || matches.length !== 1) return [];
    return [{ segment, span, verdict: matches[0] }];
  });
  if (replies.some(({ segment, verdict }) => verdict.act === "deny" &&
      (segment.targets.includes(figureId) || publicClaims.some(c => c.id === verdict.respondsToClaimId && c.targets.includes(figureId))))) return null;
  const affirmative = replies.filter(({ segment, verdict }) => verdict.act === "agree" && verdict.answersChecked === "yes" &&
    segment.name === null && segment.targets.includes(figureId) &&
    (segment.respondsToTurn === null || segment.respondsToTurn === previous.turn));
  const features = affirmative.filter(({ segment, verdict }) => isFigureReplyAspect(segment.aspect) &&
    segment.aspect !== "referent" && segment.aspect !== "question" && segment.targets.length === 1 && verdict.respondsToClaimId === question.id);
  const identities = affirmative.filter(({ segment, verdict }) => segment.aspect === "referent" &&
    publicClaims.some(c => c.id === verdict.respondsToClaimId && c.act !== "ask" && c.targets.includes(figureId)));
  const paired = features.some(feature => identities.some(identity =>
    feature.span.end <= identity.span.start || identity.span.end <= feature.span.start));
  return paired ? { figureId, denialId: priorDenial.id, names } : null;
}
