// Private derived views only. These states describe public interpretations onto
// own slots, never ground truth or a participant-facing agreement flag.
import type { LocalClaimView, LocalIssueView, LocalNameState } from "./contract.ts";
import type { LocalGraph } from "./verify.ts";
import { snapshotReferenceGraph, REFERENCE_LIMITS } from "../memory/reference-graph.mjs";

type Claim = LocalClaimView & { kind: "claim" };
function evidence(graph: LocalGraph) {
  snapshotReferenceGraph(graph); // includes runtime validation of restored records
  const records = graph.records as readonly { kind: string; id: string; targetId?: string }[];
  const claims = (records.filter(r => r.kind === "claim") as Claim[]).sort((a, b) => a.sourceTurn - b.sourceTurn || a.turn - b.turn);
  const dead = new Set(records.filter(r => r.kind === "retract").map(r => r.targetId!));
  for (const claim of claims) if (claim.act === "withdraw" && claim.respondsTo && !dead.has(claim.id)) dead.add(claim.respondsTo);
  let changed = true;
  while (changed) {
    changed = false;
    for (const claim of claims) {
      if (claim.act !== "withdraw" && claim.respondsTo && dead.has(claim.respondsTo) && !dead.has(claim.id)) {
        dead.add(claim.id); changed = true;
      }
    }
  }
  return { claims, dead };
}
const overlap = (a: Claim, b: Claim) => a.targets.some(slot => b.targets.includes(slot));

/** Recomputed on each call; no mutable state is kept beside the claim log. */
export function deriveLocalIssues(graph: LocalGraph): LocalIssueView[] {
  const { claims, dead } = evidence(graph);
  const groups = new Map<string, Claim[]>();
  for (const claim of claims) {
    const issue = groups.get(claim.issueId) ?? [];
    issue.push(claim); groups.set(claim.issueId, issue);
  }
  return [...groups].map(([issueId, records]) => {
    const latest = records[records.length - 1];
    const active = records.filter(c => !dead.has(c.id) && c.act !== "withdraw");
    const substantive = active.filter(c => !["acknowledge", "defer", "revisit"].includes(c.act));
    const supporting = substantive.some(c => ["agree", "name_accept"].includes(c.act));
    const denying = substantive.some(c => ["deny", "name_reject"].includes(c.act));
    const focus = active.filter(c => ["defer", "revisit"].includes(c.act)).at(-1);
    let state: LocalIssueView["state"] = supporting && denying ? "contested" : denying ? "denied" : supporting ? "supported" : "unconfirmed";
    if (!substantive.length && (records.some(c => dead.has(c.id)) || latest.act === "withdraw")) state = "withdrawn";
    else if (focus?.act === "defer") state = "deferred";
    let nameState: LocalNameState | null = null;
    let name: string | null = null;
    if (latest.aspect === "name") {
      const proposal = records.filter(c => c.act === "name_propose").at(-1);
      name = proposal?.name ?? null;
      nameState = !proposal ? "no_name" : dead.has(proposal.id) ? "unknown" : "unclear";
      if (proposal && !dead.has(proposal.id) && proposal.targets.length === 1) {
        if (active.some(c => c.act === "name_reject" && c.respondsTo === proposal.id)) nameState = "not_agreed";
        const acceptance = active.filter(c => c.act === "name_accept" && c.respondsTo === proposal.id &&
          c.speaker !== proposal.speaker && c.targets.length === 1 && c.targets[0] === proposal.targets[0] && (c.name === null || c.name === proposal.name)).at(-1);
        if (acceptance) {
          const after = claims.slice(claims.indexOf(acceptance) + 1);
          const overturned = after.some(c => c.aspect === "name" && overlap(c, proposal) &&
            ((c.act === "name_propose" && c.name !== proposal.name) ||
              (c.act === "name_reject" && c.respondsTo === proposal.id) ||
              (c.act === "withdraw" && (c.respondsTo === proposal.id || c.respondsTo === acceptance.id))));
          nameState = overturned ? "not_agreed" : "agreed";
        }
      }
    }
    return { issueId, aspect: latest.aspect, targets: [...latest.targets], state, nameState, name,
      claimIds: records.map(c => c.id), lastTurn: latest.turn };
  });
}

/** Bounded, deterministic JSON. Whole issues are omitted, never partial strings. */
export function summarizeLocalIssues(graph: LocalGraph, { maxChars = 6000 }: { maxChars?: number } = {}): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > REFERENCE_LIMITS.graphChars) throw new RangeError("invalid_summary_budget");
  const summary = { scope: "private_local_issues_not_ground_truth", issues: deriveLocalIssues(graph), omitted: 0 };
  while (JSON.stringify(summary).length > maxChars && summary.issues.length) { summary.issues.shift(); summary.omitted++; }
  const result = JSON.stringify(summary);
  if (result.length > maxChars) throw new RangeError("summary_budget_too_small");
  return result;
}

/** Detached recent claims for Jev; no derived success/score is fed back as proof. */
export function priorClaimViews(graph: LocalGraph, { limit = 24 }: { limit?: number } = {}): LocalClaimView[] {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > REFERENCE_LIMITS.records) throw new RangeError("invalid_claim_limit");
  const { claims, dead } = evidence(graph);
  return structuredClone((limit === 0 ? [] : claims.filter(c => !dead.has(c.id)).slice(-limit)).map(({ kind: _kind, ...claim }) => claim));
}
