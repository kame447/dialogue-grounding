// Leakage-safe splits. A whole dialogue goes to one split, so no episode, window
// or neighbouring turn of a holdout dialogue can appear in train or dev.
// The order is a seeded hash of the dialogue key, not a choice made after looking
// at the labels.
import { createHash } from "node:crypto";
import type { GroundingEvalCase, Split } from "./evalcase.ts";

export const SPLIT_VERSION = "jev-grounding-split/v1";

export interface SplitPlan {
  seed: string;
  holdout: number;
  dev: number;
}

export const DEFAULT_SPLIT: SplitPlan = Object.freeze({ seed: SPLIT_VERSION, holdout: 1, dev: 1 });

function rank(seed: string, key: string): string {
  return createHash("sha256").update(`${seed}:${key}`).digest("hex");
}

/** Assigns each dialogue key to a split: the first `holdout` by hash rank, then `dev`, the rest train. */
export function assignSplits(dialogueKeys: readonly string[], plan: SplitPlan = DEFAULT_SPLIT): Map<string, Split> {
  const unique = [...new Set(dialogueKeys)];
  if (plan.holdout + plan.dev >= unique.length) throw new Error("split leaves no training dialogue");
  const ordered = unique.sort((a, b) => (rank(plan.seed, a) < rank(plan.seed, b) ? -1 : 1));
  const out = new Map<string, Split>();
  ordered.forEach((key, i) => out.set(key, i < plan.holdout ? "holdout" : i < plan.holdout + plan.dev ? "dev" : "train"));
  return out;
}

/** Leave-one-dialogue-out folds for auxiliary checks (the 5 dialogues shaped the criteria, so this is not external validity). */
export function leaveOneDialogueOut(dialogueKeys: readonly string[]): { heldOut: string; rest: string[] }[] {
  const unique = [...new Set(dialogueKeys)].sort();
  return unique.map((heldOut) => ({ heldOut, rest: unique.filter((k) => k !== heldOut) }));
}

/** Returns leakage problems: a dialogue or group that appears in more than one split, or duplicate case ids. */
export function findLeakage(cases: readonly GroundingEvalCase[]): string[] {
  const problems: string[] = [];
  const byDialogue = new Map<string, Set<Split>>();
  const byGroup = new Map<string, Set<Split>>();
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.caseId)) problems.push(`duplicate caseId ${c.caseId}`);
    ids.add(c.caseId);
    const d = byDialogue.get(c.dialogueKey) ?? new Set<Split>();
    d.add(c.split);
    byDialogue.set(c.dialogueKey, d);
    const g = byGroup.get(c.groupId) ?? new Set<Split>();
    g.add(c.split);
    byGroup.set(c.groupId, g);
  }
  for (const [key, splits] of byDialogue) if (splits.size > 1) problems.push(`dialogue ${key} in ${[...splits].join("+")}`);
  for (const [key, splits] of byGroup) if (splits.size > 1) problems.push(`group ${key} in ${[...splits].join("+")}`);
  return problems;
}
