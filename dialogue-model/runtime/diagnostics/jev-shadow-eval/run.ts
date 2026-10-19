// Offline shadow replay runner. Replays a recorded v2 session turn by turn and
// optional jev-evalset cases through a 2-axis judge client, then compares with
// the old system's recorded actions. It never writes to a record, a ledger or
// a dialogue; results go to a private directory outside the repository.
//
//   node dialogue-model/runtime/diagnostics/jev-shadow-eval/run.ts \
//     --record <record.json> [--cases <cases.jsonl>] [--failures <failures.jsonl>] \
//     --out <private dir> [--client mock|live|local-openrouter --max-calls N]
//
// The mock client is the default. A live client needs --client live and an
// explicit --max-calls budget, and only receives the AI session's own turns and
// cases marked sendable (never historical human dialogue).
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { outsideRepositoryDirectory } from "../../naming-task.mjs";
import { loadConfig } from "../../config.mjs";
import { createGroundingJudgeClient } from "../../grounding/client.ts";
import { buildGroundingEvidence } from "../../grounding/evidence.ts";
import { toJudgeInput as caseJudgeInput } from "../../jev-grounding/evalcase.ts";
import type { GroundingEvalCase } from "../../jev-grounding/evalcase.ts";
import { auditCases, auditRecord, isSendable, toJudgeInput } from "./audit.ts";
import { createMockJevAxesClient } from "./mock-client.ts";
import { createLocalOpenRouterJudge, keychainKeyReader } from "./local-openrouter.ts";
import { caseProbe, summarizeCases, summarizeTurns, turnResult } from "./metrics.ts";
import type { CaseResult, TurnResult } from "./metrics.ts";
import { agreedSlotOutcome, replayItems } from "./replay.ts";
import type { SessionRecordLike } from "./replay.ts";
import { privateMarkdown, sanitizedMarkdown } from "./report.ts";
import { FAILURE_TAGS, NAME_LEVELS, TARGET_LEVELS } from "./types.ts";
import type { AiHypothesis, EvalCaseLike, FailureTag, JevAxesClient, JevAxesInput, JevAxesVerdict, KnownFailure, NameLevel, TargetLevel } from "./types.ts";

/** The parts of the grounding judge (dialogue-model/runtime/grounding/) this runner uses. */
export type GroundingDeps = {
  buildState(input: { events: { seq: number; speaker: "human" | "ai"; text: string }[]; asOfSeq: number; aiHypothesis?: AiHypothesis | null }): { state: string };
  judge(request: { purpose: "grounding_jev"; state: string }): Promise<{
    model: string;
    criteriaVersion?: string | null;
    identification: { level: string; scores?: Record<string, number> };
    nameAgreement: { level: string; scores?: Record<string, number> };
    usage: { inputTokens?: number | null; outputTokens?: number | null; costUsd?: number | null } | null;
    latencyMs: number;
  }>;
};

/** Adapts the grounding judge to the runner's client shape (self → ai, partner → human). */
export function groundingAxesClient(deps: GroundingDeps): JevAxesClient {
  return Object.freeze({
    kind: "live" as const,
    async judgeAxes(input: JevAxesInput): Promise<JevAxesVerdict> {
      const events = input.history.map((t, i) => ({ seq: i + 1, speaker: t.speaker === "self" ? "ai" as const : "human" as const, text: t.text }));
      const v = await deps.judge({ purpose: "grounding_jev", state: deps.buildState({ events, asOfSeq: events.length, aiHypothesis: input.aiHypothesis ?? null }).state });
      return {
        target: v.identification.level as TargetLevel, name: v.nameAgreement.level as NameLevel,
        scores: { target: v.identification.scores, name: v.nameAgreement.scores },
        model: v.model, criteriaVersion: v.criteriaVersion ?? null, latencyMs: v.latencyMs,
        usage: v.usage && { inputTokens: v.usage.inputTokens ?? undefined, outputTokens: v.usage.outputTokens ?? undefined, costUsd: v.usage.costUsd ?? undefined },
      };
    },
  });
}

export class BudgetExceededError extends Error {
  constructor() { super("live call budget exhausted"); this.name = "BudgetExceededError"; }
}

export type CallLog = { ok: boolean; code: string | null; latencyMs: number | null; model: string | null; criteriaVersion: string | null;
  inputTokens: number; outputTokens: number; costUsd: number | null };

/** Wraps a client so it refuses calls beyond the budget and records each call. */
export function budgeted(client: JevAxesClient, maxCalls: number) {
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 0) throw new TypeError("maxCalls must be a non-negative integer");
  const log: CallLog[] = [];
  return {
    kind: client.kind, log,
    async judgeAxes(input: JevAxesInput): Promise<JevAxesVerdict> {
      if (client.kind !== "mock" && log.length >= maxCalls) throw new BudgetExceededError();
      const started = performance.now();
      try {
        const verdict = await client.judgeAxes(input);
        if (!TARGET_LEVELS.includes(verdict?.target) || !NAME_LEVELS.includes(verdict?.name)) throw Object.assign(new Error("invalid verdict"), { code: "invalid_response" });
        const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
        log.push({ ok: true, code: null, latencyMs: num(verdict.latencyMs), model: typeof verdict.model === "string" ? verdict.model.slice(0, 80) : null,
          criteriaVersion: typeof verdict.criteriaVersion === "string" ? verdict.criteriaVersion.slice(0, 60) : null,
          inputTokens: num(verdict.usage?.inputTokens) ?? 0, outputTokens: num(verdict.usage?.outputTokens) ?? 0, costUsd: num(verdict.usage?.costUsd) });
        return verdict;
      } catch (error) {
        log.push({ ok: false, code: errorCode(error), latencyMs: Math.round(performance.now() - started), model: null, criteriaVersion: null, inputTokens: 0, outputTokens: 0, costUsd: null });
        throw error;
      }
    },
  };
}

const quantile = (values: number[], q: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
};

export function summarizeCalls(log: readonly CallLog[]) {
  const ok = log.filter((c) => c.ok), lat = ok.map((c) => c.latencyMs ?? 0);
  const failureCodes: Record<string, number> = {};
  for (const c of log) if (!c.ok) failureCodes[c.code ?? "error"] = (failureCodes[c.code ?? "error"] ?? 0) + 1;
  const costs = ok.map((c) => c.costUsd);
  return {
    total: log.length, ok: ok.length, failed: log.length - ok.length, failureCodes,
    latencyMs: { p50: quantile(lat, 0.5), p95: quantile(lat, 0.95), max: lat.length ? Math.max(...lat) : null },
    inputTokens: ok.reduce((a, c) => a + c.inputTokens, 0), outputTokens: ok.reduce((a, c) => a + c.outputTokens, 0),
    /** null when any successful call did not report its cost. */
    costUsd: costs.length && costs.every((c) => c !== null) ? Math.round(costs.reduce((a, c) => a + c!, 0) * 1e6) / 1e6 : costs.length ? null : 0,
  };
}

export const errorCode = (error: unknown) => error instanceof BudgetExceededError ? "budget_exhausted" :
  typeof (error as { code?: unknown })?.code === "string" ? String((error as { code: string }).code).slice(0, 40) : "error";

export type RunOptions = {
  /** AI-session replay; mock only (the researcher limited real calls to synthetic cases). */
  record?: SessionRecordLike | null;
  cases?: EvalCaseLike[];
  knownFailures?: KnownFailure[];
  client: JevAxesClient;
  maxCalls?: number;
};

/** Real calls only for synthetic cases explicitly marked sendable. */
/** Failures that will not recover within a run, or must not be retried. */
export const STOP_CODES: ReadonlySet<string> = new Set(["not_found", "budget_exhausted", "payment_required", "unauthorized",
  "key_unavailable", "key_leak", "cost_cap", "cost_unreported"]);

export const liveAllowed = (c: EvalCaseLike) => c.source === "synthetic" && isSendable(c);
// Note: a probe reply never reaches the judge; only history up to the focal turn does.

export async function runShadow({ record = null, cases = [], knownFailures = [], client, maxCalls = 0 }: RunOptions) {
  const judge = budgeted(client, maxCalls);
  const live = client.kind !== "mock";
  if (live && record) throw new Error("the AI-session replay is mock only; pass cases for a live run");
  const items = record ? replayItems(record) : [];
  const recordAudit = record ? auditRecord(record, items) : null;
  if (recordAudit && (recordAudit.futureTurnLeaks.length || recordAudit.answerKeyLeaks.length)) {
    throw new Error("replay input leakage detected; refusing to judge");
  }
  let stopped: string | null = null;
  const turns: TurnResult[] = [];
  for (const item of items) {
    const matched = agreedSlotOutcome(record!, item.hypothesis?.targetSlot ?? null);
    if (stopped) { turns.push(turnResult(item, { error: "skipped_" + stopped }, matched)); continue; }
    try {
      turns.push(turnResult(item, { verdict: await judge.judgeAxes(toJudgeInput(item)) }, matched));
    } catch (error) {
      const code = errorCode(error);
      turns.push(turnResult(item, { error: code }, matched));
      // A missing route or exhausted budget will not recover within the run.
      if (STOP_CODES.has(code)) stopped = code;
    }
  }
  const caseResults: CaseResult[] = [];
  for (const c of cases) {
    const q = (v: unknown) => typeof v === "string" ? v : c.labelQuality ?? "unspecified";
    const base = { caseId: c.caseId, split: c.split, source: c.source, labelQuality: c.labelQuality ?? "unspecified", expected: c.expected,
      goldVersion: typeof c.goldVersion === "string" ? c.goldVersion.slice(0, 40) : null,
      axisQuality: { target: q(c.axisQuality?.target), name: q(c.axisQuality?.name) } };
    if (live && !liveAllowed(c)) { caseResults.push({ ...base, verdict: null, error: "not_sendable", probe: caseProbe(c, null) }); continue; }
    if (stopped) { caseResults.push({ ...base, verdict: null, error: "skipped_" + stopped, probe: caseProbe(c, null) }); continue; }
    try {
      // jev-evalset's view of a case: public history only, no gold, tags, probe or old action.
      const v = await judge.judgeAxes({ history: caseJudgeInput(c as unknown as GroundingEvalCase).history.slice(0, c.judgedTurnIndex + 1) });
      const verdict = { target: v.target, name: v.name };
      caseResults.push({ ...base, verdict, error: null, probe: caseProbe(c, verdict) });
    } catch (error) {
      const code = errorCode(error);
      caseResults.push({ ...base, verdict: null, error: code, probe: caseProbe(c, null) });
      if (STOP_CODES.has(code)) stopped = code;
    }
  }
  const calls = summarizeCalls(judge.log);
  return {
    meta: {
      recordId: typeof record?.recordId === "string" ? record.recordId.slice(0, 8) : null,
      strategy: record?.strategy ?? null,
      client: client.label ?? client.kind,
      models: [...new Set(judge.log.filter((c) => c.model).map((c) => c.model!))],
      criteriaVersions: [...new Set(judge.log.filter((c) => c.ok).map((c) => c.criteriaVersion ?? "unversioned"))],
      maxCalls: live ? maxCalls : null,
      calls,
      stopped,
      taskOutcome: record?.scoring?.result ? { success: record.scoring.result.success ?? null, matchedCount: record.scoring.result.matchedCount ?? null, total: record.scoring.result.total ?? null } : null,
    },
    recordAudit,
    caseAudit: auditCases(cases),
    turns: summarizeTurns(turns, knownFailures),
    turnResults: turns,
    cases: summarizeCases(caseResults, cases),
    /** Per-case verdicts (ids, gold, verdict, flags; no text), kept so results can be re-scored offline. */
    caseResults,
  };
}

export type ShadowRun = Awaited<ReturnType<typeof runShadow>>;

function parseJsonl(path: string): unknown[] {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

export function parseCase(value: unknown): EvalCaseLike | null {
  const c = value as EvalCaseLike;
  const okTurn = (t: unknown) => !!t && typeof (t as { text?: unknown }).text === "string" &&
    ((t as { speaker?: unknown }).speaker === "self" || (t as { speaker?: unknown }).speaker === "partner");
  const okGold = <L extends string>(v: unknown, levels: readonly L[]) => v === null || levels.includes(v as L);
  const p = (c as { probeReply?: unknown }).probeReply as { text?: unknown; action?: unknown } | undefined;
  if (p !== undefined && (!p || typeof p.text !== "string" || !(p.action === null || typeof p.action === "string"))) return null;
  if (!c || typeof c.caseId !== "string" || !["historical", "ai_session", "synthetic"].includes(c.source) ||
      typeof c.groupId !== "string" || !["train", "dev", "holdout"].includes(c.split) ||
      !Array.isArray(c.history) || !c.history.every(okTurn) || !Number.isSafeInteger(c.judgedTurnIndex) ||
      !c.expected || !okGold(c.expected.target, TARGET_LEVELS) || !okGold(c.expected.name, NAME_LEVELS)) return null;
  return c;
}

const PUBLIC_TAGS: readonly string[] = FAILURE_TAGS.filter((t) => t !== "wrong_target_agreement");

/** Accepts `aiSeq` or jev-evalset's `aiTurnSeq`, and `basis` as a string or a list. */
export function parseKnownFailure(value: unknown): KnownFailure | null {
  const f = value as { aiSeq?: unknown; aiTurnSeq?: unknown; tags?: unknown; basis?: unknown };
  const seq = f?.aiSeq ?? f?.aiTurnSeq;
  if (!f || !Number.isSafeInteger(seq) || !Array.isArray(f.tags) || !f.tags.every((t) => typeof t === "string" && t.length <= 40)) return null;
  const tags = f.tags as string[];
  const e = (f as { expected?: { target?: unknown; name?: unknown } }).expected;
  const expected = e && typeof e === "object" ? {
    target: TARGET_LEVELS.includes(e.target as TargetLevel) ? e.target as TargetLevel : null,
    name: NAME_LEVELS.includes(e.name as NameLevel) ? e.name as NameLevel : null } : null;
  const basis = Array.isArray(f.basis) ? f.basis.filter((b) => typeof b === "string").join(",") : typeof f.basis === "string" ? f.basis : "unspecified";
  return { aiSeq: seq as number, tags: tags.filter((t) => PUBLIC_TAGS.includes(t)) as FailureTag[],
    otherTags: tags.filter((t) => !PUBLIC_TAGS.includes(t)), basis: basis.slice(0, 120), expected };
}

function args(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined) throw new Error("usage: --record <file> --out <dir> [--cases f] [--failures f] [--client mock|live --max-calls N]");
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

export type MainDeps = { readKey?: () => Promise<string>; fetchImpl?: (url: string, init: RequestInit) => Promise<Response> };

function liveClient(): JevAxesClient {
  const judge = createGroundingJudgeClient(loadConfig(process.env));
  return groundingAxesClient({ buildState: buildGroundingEvidence, judge: (request) => judge.judge(request) });
}

export async function main(argv = process.argv.slice(2), log = console.log, deps: MainDeps = {}) {
  const a = args(argv);
  if (!a.out) throw new Error("--out is required");
  // Results are private: refuse any directory inside a Git worktree.
  const out: string = await outsideRepositoryDirectory(resolve(a.out));
  const clientKind = a.client ?? "mock";
  if (!["mock", "live", "local-openrouter"].includes(clientKind)) throw new Error("--client must be mock, live or local-openrouter");
  const local = clientKind === "local-openrouter";
  const live = clientKind === "live" || local;
  const maxCalls = live ? Number(a["max-calls"]) : 0;
  if (local) {
    // Temporary direct diagnostic (researcher-approved): synthetic cases only, <= 51 calls, <= $0.05.
    if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 51) throw new Error("--client local-openrouter needs --max-calls between 1 and 51");
    if (a.record || a.failures) throw new Error("--client local-openrouter takes synthetic --cases only");
    if (!a.cases) throw new Error("--client local-openrouter needs --cases");
  } else if (live) {
    // Real calls are opt-in per run, need an approved budget (team total <= 50)
    // and only go to synthetic cases; the AI-session replay stays mock.
    if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 50) throw new Error("--client live needs --max-calls between 1 and 50");
    if (a.record) throw new Error("--record is mock only; a live run takes --cases (synthetic) only");
    if (!a.cases) throw new Error("--client live needs --cases");
  } else if (!a.record && !a.cases) throw new Error("pass --record and/or --cases");
  const record = a.record ? JSON.parse(readFileSync(resolve(a.record), "utf8")) as SessionRecordLike : null;
  const rawCases = a.cases ? parseJsonl(resolve(a.cases)) : [];
  const cases = rawCases.map(parseCase).filter((c): c is EvalCaseLike => c !== null);
  const rawFailures = a.failures ? parseJsonl(resolve(a.failures)) : [];
  const knownFailures = rawFailures.map(parseKnownFailure).filter((f): f is KnownFailure => f !== null);
  if (local && (rawCases.length !== cases.length || !cases.length || !cases.every(liveAllowed))) {
    throw new Error("--client local-openrouter refuses the file: every line must be a valid synthetic case marked externalModelAllowed");
  }
  const localJudge = local ? createLocalOpenRouterJudge({ readKey: deps.readKey ?? keychainKeyReader(), fetchImpl: deps.fetchImpl }) : null;
  const client: JevAxesClient = localJudge
    ? { ...groundingAxesClient({ buildState: buildGroundingEvidence, judge: (request) => localJudge.judge(request) }), label: "local-openrouter" }
    : live ? liveClient() : createMockJevAxesClient();
  const result = await runShadow({ record, cases, knownFailures, client, maxCalls });
  const input = { casesRead: rawCases.length, casesInvalid: rawCases.length - cases.length, failuresRead: rawFailures.length, failuresInvalid: rawFailures.length - knownFailures.length };
  const files: [string, string][] = [["shadow-run.json", JSON.stringify({ input, ...result }, null, 2) + "\n"],
    ["shadow-report.private.md", privateMarkdown(result, input)], ["shadow-summary.sanitized.md", sanitizedMarkdown(result, input)]];
  // Last barrier: nothing that contains the key is ever written.
  if (localJudge && files.some(([, body]) => localJudge.leaks(body))) throw new Error("key leak detected; nothing was written");
  mkdirSync(out, { recursive: true, mode: 0o700 });
  chmodSync(out, 0o700);
  for (const [name, body] of files) { const p = resolve(out, name); writeFileSync(p, body, { mode: 0o600 }); chmodSync(p, 0o600); }
  log(JSON.stringify({ out, client: result.meta.client, aiTurns: result.turns.aiTurns, cases: result.cases.cases, calls: result.meta.calls.total, failed: result.meta.calls.failed, ...input }));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error("jev-shadow-eval: " + (error instanceof Error ? error.message : "failed")); process.exitCode = 1; });
}
