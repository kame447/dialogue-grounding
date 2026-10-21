import { readFile, lstat } from "node:fs/promises";
import { outsideRepositoryDirectory } from "../../naming-task.mjs";
import { researchTrialProfile } from "../../v2/research-profile.ts";
import type { LunaRequestSettings, PhaseTimeouts } from "../../v2/research-profile.ts";
import { RunBudget } from "./audit.ts";
import type { Label, BudgetLimits } from "./audit.ts";
export type RunManifest = { id: string; seed: number; figureSets: 1; lunaRequest: LunaRequestSettings; phaseTimeouts?: PhaseTimeouts; caps: BudgetLimits;
  trials: ReadonlyArray<{ stage: "smoke" | "main"; scriptId: string; label: Label }>; approval: "pending" | "approved" };
export function validateRunManifest(value: RunManifest): RunManifest {
  if (!value || Object.keys(value).sort().join(",") !== (Object.hasOwn(value, "phaseTimeouts")
      ? "approval,caps,figureSets,id,lunaRequest,phaseTimeouts,seed,trials" : "approval,caps,figureSets,id,lunaRequest,seed,trials") ||
      Object.hasOwn(value, "phaseTimeouts") && value.phaseTimeouts === undefined ||
      !/^[a-zA-Z0-9_-]{1,80}$/u.test(value.id) || !Number.isSafeInteger(value.seed) || value.figureSets !== 1 ||
      !["pending", "approved"].includes(value.approval) || !Array.isArray(value.trials) || !value.trials.length || value.trials.length > 100 ||
      value.trials.some(t => Object.keys(t).sort().join(",") !== "label,scriptId,stage" || !["smoke", "main"].includes(t.stage) ||
        !["repair-first", "bypass-enabled"].includes(t.label) || !/^[a-zA-Z0-9_-]{1,80}$/u.test(t.scriptId))) throw new Error("invalid_manifest");
  if (Object.keys(value.lunaRequest).sort().join(",") !== "maxCompletionTokens,timeoutMs" ||
      Object.keys(value.caps).sort().join(",") !== "jevPosts,jevUsd,lunaCalls,lunaPosts,lunaTokens") throw new Error("invalid_manifest");
  researchTrialProfile(value.lunaRequest, value.phaseTimeouts); new RunBudget(value.caps);
  return structuredClone(value);
}
export async function loadRunManifest(file: string): Promise<RunManifest> {
  const path = await outsideRepositoryDirectory(file), info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > 32000) throw new Error("unsafe_manifest");
  return validateRunManifest(JSON.parse(await readFile(path, "utf8")));
}
/** Order helper only, never a condition intervention. The manifest records it. */
export function alternatingTrials(ids: readonly string[], first: Label = "bypass-enabled"): RunManifest["trials"] {
  const labels: Label[] = first === "bypass-enabled" ? ["bypass-enabled", "repair-first"] : ["repair-first", "bypass-enabled"];
  return ids.flatMap((scriptId, i) => (i % 2 ? [...labels].reverse() : labels).map(label => ({ stage: "main" as const, scriptId, label })));
}
/** Execution remains parent-owned. This data does not authorize a live run. */
export const APPROVED_RUN_MANIFEST = Object.freeze({
  id: "parity_live_v1", seed: 1701, figureSets: 1 as const, approval: "approved" as const,
  lunaRequest: Object.freeze({ timeoutMs: null, maxCompletionTokens: null }),
  caps: Object.freeze({ jevUsd: 2, jevPosts: 208, lunaCalls: 131, lunaPosts: 393, lunaTokens: 1500000 }),
  trials: Object.freeze([{ stage: "smoke" as const, scriptId: "S0", label: "repair-first" as const },
    ...alternatingTrials(["S0", "S1", "S2", "S3"])].map(t => Object.freeze(t))),
}) satisfies Readonly<RunManifest>;
