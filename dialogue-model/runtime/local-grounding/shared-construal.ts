import type { SharedConstrual } from "../decision/contract.ts";
import type { LocalClaimView, LocalIssueView } from "./contract.ts";

const WITHDRAWING = ["deny", "name_reject", "withdraw"];
const DETAIL_ASPECTS = ["referent", "part", "contour", "orientation", "position"];
const OPEN_STATES = ["unconfirmed", "deferred", "contested", "denied"];

/** Derive private candidates from live, verified public claims and their typed links. */
export function deriveSharedConstruals(
  claims: readonly LocalClaimView[], issues: readonly LocalIssueView[], ownSlots: readonly string[],
): SharedConstrual[] {
  const supports = new Map<string, LocalClaimView[]>();
  const disputes = new Map<string, LocalClaimView[]>();
  const firstClaimByIssue = new Map<string, LocalClaimView>();
  for (const claim of claims) {
    if (!firstClaimByIssue.has(claim.issueId)) firstClaimByIssue.set(claim.issueId, claim);
    if (claim.respondsTo === null) continue;
    const group = WITHDRAWING.includes(claim.act) ? disputes :
      claim.act === "agree" && claim.aspect === "construal" ? supports : null;
    if (!group) continue;
    const replies = group.get(claim.respondsTo) ?? [];
    replies.push(claim);
    group.set(claim.respondsTo, replies);
  }
  // A withdrawal retracts its linked claim. A denial can contest just the
  // figures it names, whether it answers the reading or a supporting claim.
  const disputed = (claimId: string, figureId: string) => disputes.get(claimId)?.some(reply =>
    reply.act === "withdraw" || reply.targets.length === 0 || reply.targets.includes(figureId));

  const facts: { lastTurn: number; fact: SharedConstrual }[] = [];
  for (const reading of claims) {
    if (reading.aspect !== "construal" || (reading.act !== "construe" && reading.act !== "assert")) continue;
    const construal = reading.proposition.trim();
    if (!construal) continue;

    const covered = (supports.get(reading.id) ?? []).filter(reply => reply.speaker !== reading.speaker).map(reply => ({
      reply,
      figures: ownSlots.filter(id => reading.targets.includes(id) && (!reply.targets.length || reply.targets.includes(id))),
    })).filter(({ figures }) => figures.length > 0);
    // Keep the latest direct support of each figure, using the graph's chronological order for ties.
    covered.sort((a, b) => a.reply.sourceTurn - b.reply.sourceTurn || a.reply.turn - b.reply.turn);
    const latestByFigure = new Map<string, LocalClaimView>();
    const disputedFigures = new Set<string>();
    for (const { reply, figures } of covered) {
      for (const id of figures) {
        if (disputed(reading.id, id) || disputed(reply.id, id)) disputedFigures.add(id);
        else latestByFigure.set(id, reply);
      }
    }
    for (const id of disputedFigures) latestByFigure.delete(id);
    if (!latestByFigure.size) continue;
    const figureIds = ownSlots.filter(id => latestByFigure.has(id));
    const latest = figureIds.map(id => latestByFigure.get(id)!);
    const claimIds = [reading.id, ...new Set(latest.map(reply => reply.id))];
    const openDetails = issues.filter(issue =>
      DETAIL_ASPECTS.includes(issue.aspect) && OPEN_STATES.includes(issue.state) &&
      issue.targets.some(id => latestByFigure.has(id)),
    ).sort((a, b) => b.lastTurn - a.lastTurn).map(issue => ({
      issueId: issue.issueId,
      aspect: issue.aspect,
      proposition: firstClaimByIssue.get(issue.issueId)?.proposition.trim() ?? "",
      state: issue.state,
    }));
    const lastTurn = latest.reduce((turn, reply) => Math.max(turn, reply.sourceTurn), reading.sourceTurn);
    facts.push({ lastTurn, fact: { id: `sc:${reading.id}`, claimIds, figureIds, construal, openDetails } });
  }
  return facts.sort((a, b) => b.lastTurn - a.lastTurn).map(({ fact }) => fact);
}
