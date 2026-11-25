// TEMPORARY research diagnostic (researcher-approved 2026-10-19): calls OpenRouter
// Decisions directly from this machine, bypassing the research proxy, while the
// proxy's grounding-criteria/v2 deploy waits for Cloudflare re-authentication.
// It sends exactly what the proxy would send (same builder, questions, criteria,
// model, URL and timeout) and accepts only what the proxy would return (same
// sanitizer, key barrier and client-side parser). Synthetic cases only; the
// runner enforces that. Opt-in per run; nothing enables it by default.
//
// The OpenRouter key is read from the macOS Keychain at call time with execFile
// (no shell), kept in memory only, and never printed, logged, passed in argv or
// env, written to a file or placed in an error message.
import { execFile } from "node:child_process";
import {
  buildGroundingPayload, sanitizeGroundingVerdict, OPENROUTER_DECISIONS_URL,
} from "../../../../workers/research-ai-proxy/src/grounding.ts";
import { parseGroundingVerdict } from "../../grounding/client.ts";
import type { GroundingRequest, GroundingVerdict } from "../../grounding/client.ts";

export const KEYCHAIN_SERVICE = "dialogue-grounding-openrouter-api-key";
export const KEYCHAIN_ACCOUNT = "research";
/** Same upstream timeout as the proxy (index.mjs). */
export const UPSTREAM_TIMEOUT_MS = 15_000;
export const DEFAULT_COST_CAP_USD = 0.05;

export type LocalErrorCode = "key_unavailable" | "key_leak" | "invalid_request" | "unauthorized" | "payment_required" |
  "not_found" | "rate_limited" | "upstream_error" | "invalid_response" | "timeout" | "network_error" | "cost_cap" | "cost_unreported";

export class LocalOpenRouterError extends Error {
  code: LocalErrorCode;
  constructor(code: LocalErrorCode) {
    // Fixed text: never the key, an upstream body or a child-process message.
    super("local OpenRouter diagnostic failed: " + code);
    this.name = "LocalOpenRouterError";
    this.code = code;
  }
}

const KEY_SHAPE = /^sk-or-[A-Za-z0-9_-]{16,256}$/;

type ExecFileLike = (file: string, args: readonly string[], options: { timeout: number; maxBuffer: number },
  callback: (error: Error | null, stdout: string | Buffer) => void) => unknown;

/** Reads the key from the login Keychain without a shell. Fails closed on any problem. */
export function keychainKeyReader(execFileImpl: ExecFileLike = execFile as unknown as ExecFileLike): () => Promise<string> {
  return () => new Promise((resolveKey, reject) => {
    execFileImpl("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { timeout: 5_000, maxBuffer: 4_096 }, (error, stdout) => {
        const key = error ? "" : String(stdout).trim();
        if (!KEY_SHAPE.test(key)) reject(new LocalOpenRouterError("key_unavailable"));
        else resolveKey(key);
      });
  });
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type LocalJudgeOptions = { readKey: () => Promise<string>; fetchImpl?: FetchLike; costCapUsd?: number };

/** A GroundingJudge-compatible judge that talks to OpenRouter directly. */
export function createLocalOpenRouterJudge({ readKey, fetchImpl = globalThis.fetch, costCapUsd = DEFAULT_COST_CAP_USD }: LocalJudgeOptions) {
  if (!(costCapUsd > 0 && costCapUsd <= DEFAULT_COST_CAP_USD)) throw new TypeError("costCapUsd must be in (0, 0.05]");
  let key: string | null = null;
  let spentUsd = 0;
  let maxCallUsd = 0;
  const leaks = (text: string) => key !== null && text.includes(key);

  async function judge(request: GroundingRequest): Promise<GroundingVerdict> {
    // Budget check before spending: assume the next call costs as much as the dearest so far.
    if (spentUsd + maxCallUsd > costCapUsd) throw new LocalOpenRouterError("cost_cap");
    const payload = buildGroundingPayload(request);
    if (!payload) throw new LocalOpenRouterError("invalid_request");
    if (key === null) key = await readKey();
    if (!KEY_SHAPE.test(key)) { key = null; throw new LocalOpenRouterError("key_unavailable"); }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    const started = performance.now();
    let text: string;
    try {
      const upstream = await fetchImpl(OPENROUTER_DECISIONS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!upstream.ok) {
        // As in the proxy, the error body is not read or kept.
        const s = upstream.status;
        throw new LocalOpenRouterError(s === 401 || s === 403 ? "unauthorized" : s === 402 ? "payment_required" :
          s === 404 ? "not_found" : s === 429 ? "rate_limited" : "upstream_error");
      }
      text = await upstream.text();
    } catch (error) {
      if (error instanceof LocalOpenRouterError) throw error;
      throw new LocalOpenRouterError(controller.signal.aborted ? "timeout" : "network_error");
    } finally {
      clearTimeout(timeout);
    }
    const latencyMs = Math.round(performance.now() - started);
    if (leaks(text)) throw new LocalOpenRouterError("key_leak");
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw new LocalOpenRouterError("invalid_response"); }
    const sanitized = sanitizeGroundingVerdict(data, payload.model, "grounding_jev");
    if (!sanitized) throw new LocalOpenRouterError("invalid_response");
    if (leaks(JSON.stringify(sanitized))) throw new LocalOpenRouterError("key_leak");
    let verdict: GroundingVerdict;
    try { verdict = parseGroundingVerdict(sanitized, "grounding_jev", latencyMs); }
    catch { throw new LocalOpenRouterError("invalid_response"); }
    // The cost cap needs a reported cost; without one the run cannot be bounded.
    const cost = verdict.usage?.costUsd;
    if (typeof cost !== "number") throw new LocalOpenRouterError("cost_unreported");
    spentUsd += cost;
    maxCallUsd = Math.max(maxCallUsd, cost);
    if (spentUsd > costCapUsd) throw new LocalOpenRouterError("cost_cap");
    return verdict;
  }

  return {
    judge,
    /** True if the text contains the key; used to scan anything before it is written. */
    leaks,
    get spentUsd() { return spentUsd; },
  };
}
