// A rough reading (見立て) that both sides have stated in public and nobody has denied, derived from verified claims only.
// Private material for Jev: no keyword, no threshold, no decision. It never names a figure's identity, a name or an agreement.
import type { LocalClaimView, LocalIssueView } from "./contract.ts";
import type { SharedConstrual } from "../decision/contract.ts";

const HUMAN_ACTS = ["construe", "assert", "agree", "ask"];
const AI_ACTS = ["construe", "assert", "agree"];
const DETAIL_ASPECTS = ["referent", "part", "contour", "orientation", "position"];
const OPEN_STATES = ["unconfirmed", "deferred", "contested", "denied"];
const MAX_FACTS = 3, MAX_DETAILS = 4, TEXT = 160;

export function deriveSharedConstruals(claims: readonly LocalClaimView[], issues: readonly LocalIssueView[], ownSlots: readonly string[]): SharedConstrual[] {
  const facts: { lastTurn: number; fact: SharedConstrual }[] = [];
  for (const issue of issues) {
    if (issue.aspect !== "construal" || ["denied", "contested", "withdrawn"].includes(issue.state)) continue;
    const group = claims.filter(c => c.issueId === issue.issueId && c.aspect === "construal");
    const ai = group.filter(c => c.speaker === "ai" && AI_ACTS.includes(c.act));
    const human = group.filter(c => c.speaker === "human" && HUMAN_ACTS.includes(c.act));
    if (!ai.length || !human.length || group.some(c => ["deny", "name_reject", "withdraw"].includes(c.act))) continue;
    const figureIds = ownSlots.filter(id => ai.some(c => c.targets.includes(id)));
    // A human claim that names figures must overlap the AI's own candidates; an unbound one speaks of the same reading.
    if (!figureIds.length || human.every(c => c.targets.length && !c.targets.some(id => figureIds.includes(id)))) continue;
    const construal = ai.at(-1)!.proposition.trim().slice(0, TEXT);
    if (!construal) continue;
    const openDetails = issues.filter(o => DETAIL_ASPECTS.includes(o.aspect) && OPEN_STATES.includes(o.state) &&
      o.targets.some(id => figureIds.includes(id))).sort((a, b) => b.lastTurn - a.lastTurn).slice(0, MAX_DETAILS).map(o => ({
      issueId: o.issueId, aspect: o.aspect, state: o.state,
      proposition: (claims.find(c => c.issueId === o.issueId)?.proposition ?? "").trim().slice(0, TEXT) }));
    facts.push({ lastTurn: issue.lastTurn, fact: { id: `sc:${issue.issueId}`, claimIds: group.map(c => c.id), figureIds, construal, openDetails } });
  }
  return facts.sort((a, b) => b.lastTurn - a.lastTurn).slice(0, MAX_FACTS).map(f => f.fact);
}
