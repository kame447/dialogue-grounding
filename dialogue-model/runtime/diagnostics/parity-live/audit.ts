// Mechanical wiring/identity receipts only. Semantic evaluation is not installed.
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { outsideRepositoryDirectory } from "../../naming-task.mjs";
import { assertPublicText } from "../local-grounding-eval/run.ts";
import { researchHash } from "../../v2/research-profile.ts";

export type Label = "repair-first" | "bypass-enabled";
export type Phase = "observation_initial" | "observation_targeted" | "local_extraction" | "local_function" |
  "human_referent" | "decision" | "generation" | "ai_extraction" | "ai_function" | "ai_support";
export const CALL_CAPS: Readonly<Record<Phase, number>> = Object.freeze({ observation_initial: 1, observation_targeted: 1,
  local_extraction: 1, local_function: 1, human_referent: 1, decision: 4, generation: 2, ai_extraction: 1, ai_function: 1, ai_support: 1 });
export const ENGINEERING_LIMITS = Object.freeze({ trialMs: 15 * 60 * 1000 });
export type BudgetLimits = { lunaCalls: number; lunaTokens: number; lunaPosts: number; jevPosts: number; jevUsd: number };
export type SendReceipt = { id: number; provider: "luna" | "jev"; phase: string | null; turn: number | null;
  logicalCallId: number | null;
  status: "in_flight" | "sent_result_unknown" | "observed_response"; costUsd: number | null;
  inputTokens: number | null; outputTokens: number | null; model: string | null; modelMatches: boolean | null };
export class RunBudget {
  lunaCalls = 0; halted = false; jevUnknown = false;
  haltReason: string | null = null;
  syntheticInputTokens = 0; syntheticOutputTokens = 0; syntheticInputUnknown = 0; syntheticOutputUnknown = 0;
  readonly sends: SendReceipt[] = []; readonly refusals: Array<{ kind: string; reason: string; logicalCallId?: number | null }> = [];
  readonly stops: Array<{ reason: string; inFlight: SendReceipt[] }> = [];
  onChange: ((entry: SendReceipt) => void) | null = null;
  onRefusal: ((entry: { kind: string; reason: string; logicalCallId?: number | null }) => void) | null = null;
  onLedgerEvent: ((event: { type: "reserve" | "send" | "response" | "stop"; entry?: SendReceipt; reason?: string; inFlight?: number[] }) => void) | null = null;
  readonly limits: BudgetLimits;
  constructor(limits: BudgetLimits) {
    if (![limits.lunaCalls, limits.lunaTokens, limits.lunaPosts, limits.jevPosts].every(v => Number.isSafeInteger(v) && v > 0) ||
        !Number.isFinite(limits.jevUsd) || limits.jevUsd <= 0) throw new Error("invalid_budget");
    this.limits = { ...limits };
  }
  get observedJevUsd() { return this.sends.reduce((n, s) => n + (s.provider === "jev" ? s.costUsd ?? 0 : 0), 0); }
  get lunaPosts() { return this.sends.filter(s => s.provider === "luna").length; }
  get jevPosts() { return this.sends.filter(s => s.provider === "jev").length; }
  get observedInputTokens() { return this.syntheticInputTokens + this.sends.reduce((n, s) => n + (s.provider === "luna" ? s.inputTokens ?? 0 : 0), 0); }
  get observedOutputTokens() { return this.syntheticOutputTokens + this.sends.reduce((n, s) => n + (s.provider === "luna" ? s.outputTokens ?? 0 : 0), 0); }
  get observedLunaTokens() { return this.observedInputTokens + this.observedOutputTokens; }
  stopReason(): string | null { return this.jevUnknown ? "jev_cost_unknown" : this.halted ? "budget_stop" : this.observedJevUsd >= this.limits.jevUsd ? "observed_jev_budget"
    : this.lunaCalls >= this.limits.lunaCalls ? "luna_call_budget" : this.lunaPosts >= this.limits.lunaPosts ? "luna_http_budget"
      : this.jevPosts >= this.limits.jevPosts ? "jev_http_budget" : this.observedLunaTokens >= this.limits.lunaTokens ? "luna_token_budget" : null; }
  beforeSend(reservedLunaCall = false, logicalCallId: number | null = null) {
    const reason = this.stopReason();
    if (reason && !(reservedLunaCall && reason === "luna_call_budget" && !this.halted && !this.jevUnknown &&
        this.observedJevUsd < this.limits.jevUsd && this.lunaPosts < this.limits.lunaPosts && this.jevPosts < this.limits.jevPosts &&
        this.observedLunaTokens < this.limits.lunaTokens)) { this.stop(reason); this.refuse(reservedLunaCall ? "luna_post" : "call", reason, logicalCallId); throw new Error("budget_stop"); }
  }
  refuse(kind: string, reason: string, logicalCallId?: number | null) { const entry = { kind, reason, logicalCallId }; this.refusals.push(entry); this.onRefusal?.(entry); }
  stop(reason: string) { this.halted = true; this.haltReason ??= reason; if (!this.stops.some(s => s.reason === reason)) { this.stops.push({ reason,
    inFlight: structuredClone(this.sends.filter(s => s.status === "in_flight" || s.status === "sent_result_unknown")) });
    this.onLedgerEvent?.({ type: "stop", reason, inFlight: this.stops.at(-1)!.inFlight.map(s => s.id) }); } }
  reserve(provider: "luna" | "jev", phase: string | null, turn: number | null, logicalCallId: number | null = null) {
    this.beforeSend(provider === "luna", logicalCallId);
    const entry: SendReceipt = { id: this.sends.length + 1, provider, phase, turn, logicalCallId, status: "in_flight", costUsd: null,
      inputTokens: null, outputTokens: null, model: null, modelMatches: null };
    this.sends.push(entry); this.onLedgerEvent?.({ type: "reserve", entry: structuredClone(entry) }); this.onChange?.(structuredClone(entry)); return entry;
  }
  sent(entry: SendReceipt) { this.onLedgerEvent?.({ type: "send", entry: structuredClone(entry) }); }
  observe(entry: SendReceipt, values: Partial<Pick<SendReceipt, "costUsd" | "inputTokens" | "outputTokens" | "model" | "modelMatches">>) {
    Object.assign(entry, values); entry.status = "observed_response";
    this.onLedgerEvent?.({ type: "response", entry: structuredClone(entry) });
    if (entry.provider === "jev" && entry.costUsd === null) { this.jevUnknown = true; this.stop("jev_cost_unknown"); }
    this.checkObservedLimits();
    this.onChange?.(structuredClone(entry));
  }
  checkObservedLimits() {
    if (this.observedJevUsd >= this.limits.jevUsd) this.stop("observed_jev_budget");
    if (this.observedLunaTokens >= this.limits.lunaTokens) this.stop("luna_token_budget");
  }
  unknown(entry: SendReceipt) {
    if (entry.status !== "in_flight") return;
    entry.status = "sent_result_unknown";
    this.onLedgerEvent?.({ type: "response", entry: structuredClone(entry) });
    if (entry.provider === "jev") { this.jevUnknown = true; this.stop("jev_cost_unknown"); }
    this.onChange?.(structuredClone(entry));
  }
  snapshot() { return { observedJevUsd: this.observedJevUsd, lunaCalls: this.lunaCalls, observedLunaTokens: this.observedLunaTokens,
    observedInputTokens: this.observedInputTokens, observedOutputTokens: this.observedOutputTokens,
    missingInputTokens: this.syntheticInputUnknown + this.sends.filter(s => s.provider === "luna" && s.inputTokens === null).length,
    missingOutputTokens: this.syntheticOutputUnknown + this.sends.filter(s => s.provider === "luna" && s.outputTokens === null).length,
    inFlight: this.sends.filter(s => s.status === "in_flight").map(s => s.id), sends: structuredClone(this.sends), refusals: structuredClone(this.refusals),
    lunaPosts: this.lunaPosts, jevPosts: this.jevPosts, jevUnknown: this.jevUnknown,
    halted: this.halted, haltReason: this.haltReason, stops: structuredClone(this.stops), unresolvedJevSends: this.sends.filter(s => s.provider === "jev" && s.costUsd === null).map(s => s.id),
    lunaCostUsd: null, totalUsd: null, limits: { ...this.limits },
    countLimit: "atomic_pre_send_reservation", usdScope: "observed_jev_stop_threshold_all_in_flight_may_overshoot",
    tokenScope: "observed_lower_bound_stop_threshold_unknown_fields_excluded" }; }
}
export type CallReceipt = { id: number; sendIds: number[]; phase: Phase; turn: number | null; provider: "luna" | "jev"; requestSha256: string; instructionSha256: string;
  expectedHttpRequestSha256?: string; httpRequestSha256?: string;
  requestedModel: string; model: string | null; status: "started" | "ok" | "error"; error: string | null;
  costUsd: number | null; inputTokens: number | null; outputTokens: number | null; imageCount: number; latencyMs: number | null };
export type IdentityTurn = { turn: number; prefixSha256: string; publicText: string | null; humanReferent: string[]; actionInputs: string[];
  humanMaterial: string[]; actionMaterial: string[]; internalSha256: string };
export type Identity = { image: string; anchors: string; memo: string; prompts: string; profile: string;
  timeouts: string; requestedModels: string; returnedModels: string[] };
export type ComparableTrial = { scriptId: string; label: Label; completed: boolean; identity: Identity; turns: IdentityTurn[] };
export function compareParity(a: ComparableTrial, b: ComparableTrial) {
  const unmet: string[] = [], comparedTurns: number[] = [];
  if (a.scriptId !== b.scriptId || a.label === b.label) unmet.push("pair_identity");
  if (!a.completed || !b.completed) unmet.push("trial_incomplete");
  for (const key of ["image", "anchors", "memo", "prompts", "profile", "timeouts", "requestedModels"] as const) {
    if (!a.identity[key] || a.identity[key] !== b.identity[key]) unmet.push(key + "_mismatch");
  }
  if (researchHash(a.identity.returnedModels) !== researchHash(b.identity.returnedModels)) unmet.push("returned_models_mismatch");
  let publicDivergenceTurn: number | null = null, internalDivergenceTurn: number | null = null;
  const cells: Array<{ turn: number; stage: string; status: string }> = [];
  for (let i = 0; i < Math.max(a.turns.length, b.turns.length); i++) {
    const x = a.turns[i], y = b.turns[i];
    if (!x || !y) { unmet.push("turn_unreached"); continue; }
    if (publicDivergenceTurn === null && x.publicText !== y.publicText) publicDivergenceTurn = x.turn + 1;
    if (internalDivergenceTurn === null && x.internalSha256 !== y.internalSha256) internalDivergenceTurn = x.turn;
    for (const [key, materials] of [["humanReferent", "humanMaterial"], ["actionInputs", "actionMaterial"]] as const) {
      const status = !x[key].length || !y[key].length ? "not_reached" : researchHash(x[materials]) !== researchHash(y[materials])
        ? "not_comparable_upstream_material_difference" : researchHash(x[key]) === researchHash(y[key]) ? "same_material_same_payload" : "same_material_payload_mismatch";
      cells.push({ turn: x.turn, stage: key, status });
      if (status === "same_material_payload_mismatch") unmet.push(`${key}_${x.turn}_mismatch`);
    }
    comparedTurns.push(x.turn);
  }
  if (!comparedTurns.length) unmet.push("no_identical_prefix_measured");
  return { status: "independent_run_material_report", unmet: [...new Set(unmet)], comparedTurns, publicDivergenceTurn, internalDivergenceTurn, cells,
    postDivergence: "compare_only_demonstrably_identical_materials", divergenceCause: "upstream_sampling_not_intervention",
    comparison: "not_implemented_pending_researcher_decision" };
}
export async function promptSourceManifest() {
  // These source digests cover every instruction, including private non-exported
  // act/decision/guard strings. Actual sent instructions are hashed per call too.
  const files = ["v2/dialogue-v2.mjs", "v2/jev-turn.ts", "v2/generation-guard.ts", "judgment/instructions.mjs",
    "observation/observe.ts", "local-grounding/extract.ts", "local-grounding/jev-local-test.ts",
    "decision/jev-decision.ts", "local-grounding/extract-ai.ts", "local-grounding/jev-ai-public.ts"];
  return { scheme: "complete_instruction_source_sha256", files: Object.fromEntries(await Promise.all(files.map(async file =>
    [file, createHash("sha256").update(await readFile(new URL("../../" + file, import.meta.url))).digest("hex")])) ) };
}
export function publicText(text: unknown, secrets: readonly string[]) {
  assertPublicText(text, secrets);
  if (/\d+:pub\d+/u.test((text as string).normalize("NFKC").replace(/\s+/gu, ""))) throw new Error("privacy_rejected");
}
export async function privateDirectory(path: string) {
  const directory = await outsideRepositoryDirectory(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) throw new Error("unsafe_directory");
  if (await outsideRepositoryDirectory(directory) !== directory) throw new Error("unsafe_directory");
  return directory;
}
export async function privateWrite(directory: string, file: string, value: unknown, unsafe: (s: string) => boolean) {
  await privateDirectory(directory);
  let redacted = false;
  const sanitize = (v: unknown): unknown => {
    if (typeof v === "string" && unsafe(v)) { redacted = true; return "[redacted]"; }
    if (Array.isArray(v)) return v.map(sanitize);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, child]) => [k, sanitize(child)]));
    return v;
  };
  const safe = sanitize(value);
  await writeFile(join(directory, file), JSON.stringify(safe) + "\n", { flag: "wx", mode: 0o600 });
  return redacted;
}
