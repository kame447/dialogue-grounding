// Node-only research harness profile. Historical runtime defaults are untouched.
import { createHash } from "node:crypto";
import { GENERATION_TIMEOUT_MS } from "./dialogue-v2.mjs";
import { JEV_DECISION_MODEL } from "../decision/jev-decision.ts";
import { UPSTREAM_TIMEOUT_MS } from "../diagnostics/jev-shadow-eval/local-openrouter.ts";

/** JSON objects only; keys are sorted recursively, array order is significant. */
export function normalizedJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(normalizedJson).join(",") + "]";
  if (value && Object.getPrototypeOf(value) === Object.prototype) return "{" + Object.keys(value).sort()
    .map(k => JSON.stringify(k) + ":" + normalizedJson((value as Record<string, unknown>)[k])).join(",") + "}";
  throw new TypeError("invalid_json_value");
}
export const researchHash = (value: unknown) => createHash("sha256").update(normalizedJson(value)).digest("hex");
function frozen<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
export const RESEARCH_TRIAL_PROFILE_V1 = frozen({
  id: "research_trial_profile_v1", referenceMemory: true, decisionMode: "jev", humanReferent: true,
  localGrounding: { enabled: true, aiPublicClaims: true }, initialObservation: "cache_required",
  questionLayout: "two_stage_v1", utteranceStyle: "default", maxReobservations: 1,
  modelPolicy: { purpose: "dialogue_turn", resolver: "research_worker", jevModel: JEV_DECISION_MODEL },
  timeouts: { observationMs: 20000, localMs: 20000, decisionMs: UPSTREAM_TIMEOUT_MS, generationMs: GENERATION_TIMEOUT_MS },
} as const);
export const RESEARCH_TRIAL_PROFILE_SHA256 = researchHash(RESEARCH_TRIAL_PROFILE_V1);
export type LunaRequestSettings = { timeoutMs: number | null; maxCompletionTokens: number | null };
/** Explicit parent-selected execution values; no pending example becomes a live default. */
export function researchTrialProfile(lunaRequest: LunaRequestSettings) {
  if (!lunaRequest || lunaRequest.timeoutMs !== null && (!Number.isSafeInteger(lunaRequest.timeoutMs) || lunaRequest.timeoutMs < 1 || lunaRequest.timeoutMs > 120000) ||
      lunaRequest.maxCompletionTokens !== null && (!Number.isSafeInteger(lunaRequest.maxCompletionTokens) || lunaRequest.maxCompletionTokens < 1 || lunaRequest.maxCompletionTokens > 8192)) throw new Error("invalid_luna_settings");
  return frozen({ ...RESEARCH_TRIAL_PROFILE_V1, lunaRequest: { ...lunaRequest },
    outputLimit: lunaRequest.maxCompletionTokens === null ? "worker_dependent_effective_value_unverified" : "explicit_client_request" });
}
