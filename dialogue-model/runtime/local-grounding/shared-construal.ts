import type { SharedConstrual } from "../decision/contract.ts";
import type { LocalClaimView, LocalIssueView } from "./contract.ts";
import { deriveLocalIssues, localIssueState } from "./derive.ts";
import type { LocalGraph } from "./verify.ts";

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
  // An explicit target scopes the revision to that figure, whether the reply
  // answers the reading or one of its supporting claims.
  const disputed = (claimId: string, figureId: string) => disputes.get(claimId)?.some(reply =>
    reply.targets.length === 0 || reply.targets.includes(figureId));

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
    const openDetails = new Map<string, SharedConstrual["openDetails"][number]>();
    const eligibleDetails = issues.filter(issue =>
      DETAIL_ASPECTS.includes(issue.aspect) && OPEN_STATES.includes(issue.state) &&
      issue.targets.some(id => latestByFigure.has(id)),
    ).sort((a, b) => b.lastTurn - a.lastTurn);
    for (const issue of eligibleDetails) {
      if (openDetails.has(issue.issueId)) continue;
      openDetails.set(issue.issueId, { issueId: issue.issueId, aspect: issue.aspect,
        proposition: firstClaimByIssue.get(issue.issueId)?.proposition.trim() ?? "", state: issue.state });
    }
    const lastTurn = latest.reduce((turn, reply) => Math.max(turn, reply.sourceTurn), reading.sourceTurn);
    facts.push({ lastTurn, fact: { id: `sc:${reading.id}`, claimIds, figureIds, construal, openDetails: [...openDetails.values()] } });
  }
  return facts.sort((a, b) => b.lastTurn - a.lastTurn).map(({ fact }) => fact);
}

/** v13-only view. Other graph readers keep their original whole-claim withdrawal rules. */
export function deriveSharedConstrualsFromGraph(graph: LocalGraph, ownSlots: readonly string[]):
  { sharedConstruals: SharedConstrual[]; proofClaims: LocalClaimView[] } {
  const issues = deriveLocalIssues(graph);
  const records = graph.records as readonly { kind: string; targetId?: string }[];
  const claims = records.filter((record): record is { kind: "claim" } & LocalClaimView => record.kind === "claim")
    .sort((a, b) => a.sourceTurn - b.sourceTurn || a.turn - b.turn);
  const retracted = records.filter(record => record.kind === "retract").map(record => record.targetId!);
  const deadByFigure = new Map(ownSlots.map(id => {
    const dead = new Set(retracted);
    for (const claim of claims) {
      if (claim.act === "withdraw" && claim.respondsTo && !dead.has(claim.id) &&
          (!claim.targets.length || claim.targets.includes(id))) dead.add(claim.respondsTo);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const claim of claims) {
        if (claim.act !== "withdraw" && claim.respondsTo && dead.has(claim.respondsTo) && !dead.has(claim.id)) {
          dead.add(claim.id);
          changed = true;
        }
      }
    }
    return [id, dead] as const;
  }));
  const scoped = claims.flatMap(({ kind: _kind, ...claim }) => {
    const targets = claim.targets.filter(id => !deadByFigure.get(id)?.has(claim.id));
    if (claim.targets.length && !targets.length) return [];
    return [{ ...claim, targets }];
  });
  const withdrawnIssues = new Set(claims.filter(claim => claim.act === "withdraw" && DETAIL_ASPECTS.includes(claim.aspect))
    .map(claim => claim.issueId));
  const liveDetails = new Map<string, LocalClaimView[]>();
  for (const claim of scoped) {
    if (claim.act === "withdraw" || !withdrawnIssues.has(claim.issueId)) continue;
    const group = liveDetails.get(claim.issueId) ?? [];
    group.push(claim);
    liveDetails.set(claim.issueId, group);
  }
  const scopedIssues = issues.flatMap(issue => {
    if (!withdrawnIssues.has(issue.issueId)) return [issue];
    // A surviving agreement on one figure does not settle the detail on
    // another figure whose agreement was withdrawn.
    const live = liveDetails.get(issue.issueId) ?? [];
    return ownSlots.flatMap(id => {
      const relevant = live.filter(claim => claim.targets.includes(id) || !claim.targets.length && !deadByFigure.get(id)!.has(claim.id));
      return relevant.some(claim => claim.targets.includes(id))
        ? [{ ...issue, state: localIssueState(relevant, true), targets: [id] }] : [];
    });
  });
  const sharedConstruals = deriveSharedConstruals(scoped, scopedIssues, ownSlots);
  const references = new Set(sharedConstruals.flatMap(candidate => candidate.claimIds));
  return { sharedConstruals, proofClaims: scoped.filter(claim => references.has(claim.id)) };
}
