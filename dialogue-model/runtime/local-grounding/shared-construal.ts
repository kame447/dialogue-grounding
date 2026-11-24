// A rough reading (見立て) that the AI stated in public and the partner themself accepted, derived from verified claims only.
// Private material for Jev: no keyword, no threshold, no decision. It never names a figure's identity, a name or an agreement.
// The partner's acceptance is a human `agree` that answers an AI claim of the issue: asking about the reading, or stating another one, is not acceptance.
// The figures are those BOTH sides' claims actually cover: the AI claim's figures that the human claim also concerns (its own targets, else its answer's).
import type { LocalClaimView, LocalIssueView } from "./contract.ts";
import type { SharedConstrual } from "../decision/contract.ts";

const AI_ACTS = ["construe", "assert", "agree"];
const DETAIL_ASPECTS = ["referent", "part", "contour", "orientation", "position"];
const OPEN_STATES = ["unconfirmed", "deferred", "contested", "denied"];
const MAX_FACTS = 3, MAX_DETAILS = 4, MAX_CLAIMS = 32, TEXT = 160;

export function deriveSharedConstruals(claims: readonly LocalClaimView[], issues: readonly LocalIssueView[], ownSlots: readonly string[]): SharedConstrual[] {
  const facts: { lastTurn: number; fact: SharedConstrual }[] = [];
  for (const issue of issues) {
    if (issue.aspect !== "construal" || ["denied", "contested", "withdrawn"].includes(issue.state)) continue;
    const group = claims.filter(c => c.issueId === issue.issueId && c.aspect === "construal");
    if (group.some(c => ["deny", "name_reject", "withdraw"].includes(c.act))) continue;
    const covered = new Set<string>(), aiIds: string[] = [], humanIds: string[] = [];
    let latest: LocalClaimView | null = null;
    for (const human of group.filter(c => c.speaker === "human" && c.act === "agree")) {
      const ai = group.find(c => c.id === human.respondsTo && c.speaker === "ai" && AI_ACTS.includes(c.act));
      if (!ai) continue;
      const concerned = human.targets.length ? human.targets : ai.targets;
      const both = ownSlots.filter(id => ai.targets.includes(id) && concerned.includes(id));
      if (!both.length) continue;
      both.forEach(id => covered.add(id));
      if (!aiIds.includes(ai.id)) aiIds.push(ai.id);
      if (!humanIds.includes(human.id)) humanIds.push(human.id);
      latest = ai;
    }
    const construal = latest?.proposition.trim().slice(0, TEXT);
    if (!construal || !covered.size) continue;
    const figureIds = ownSlots.filter(id => covered.has(id));
    const openDetails = issues.filter(o => DETAIL_ASPECTS.includes(o.aspect) && OPEN_STATES.includes(o.state) &&
      o.targets.some(id => figureIds.includes(id))).sort((a, b) => b.lastTurn - a.lastTurn).slice(0, MAX_DETAILS).map(o => ({
      issueId: o.issueId, aspect: o.aspect, state: o.state,
      proposition: (claims.find(c => c.issueId === o.issueId)?.proposition ?? "").trim().slice(0, TEXT) }));
    facts.push({ lastTurn: issue.lastTurn, fact: { id: `sc:${issue.issueId}`, claimIds: [...aiIds, ...humanIds.slice(-Math.max(1, MAX_CLAIMS - aiIds.length))].slice(0, MAX_CLAIMS), figureIds, construal, openDetails } });
  }
  return facts.sort((a, b) => b.lastTurn - a.lastTurn).slice(0, MAX_FACTS).map(f => f.fact);
}
