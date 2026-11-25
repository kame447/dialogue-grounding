// Research-only client for the two-axis grounding-evidence judge (Jev) through the
// research Worker. Uses the existing research bearer token, never an OpenRouter key.
// Scores are relative, uncalibrated model scores; never call them P(correct target).
import {
  GROUNDING_CRITERIA_VERSION, GROUNDING_LEVELS, GROUNDING_MAX_STATE_CHARS, GROUNDING_MODELS, isGroundingModel, validateAxis,
  type AxisVerdict, type GroundingPurpose, type IdentificationEvidence, type NameAgreementEvidence,
} from "../../../workers/research-ai-proxy/src/grounding.ts";

export type GroundingRequest = { purpose: GroundingPurpose; state: string };
export type GroundingCallOptions = { timeoutMs?: number; signal?: AbortSignal };
export type GroundingVerdict = {
  purpose: GroundingPurpose;
  model: string;
  provider: string | null;
  id: string | null;
  identification: AxisVerdict<IdentificationEvidence>;
  nameAgreement: AxisVerdict<NameAgreementEvidence>;
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null } | null;
  latencyMs: number;
  /** Version of the server-owned levels and criteria that produced this verdict. */
  criteriaVersion: typeof GROUNDING_CRITERIA_VERSION;
};
export type GroundingJudge = { judge(request: GroundingRequest, options?: GroundingCallOptions): Promise<GroundingVerdict> };
export type GroundingErrorCode = "not_found" | "disabled" | "invalid_config" | "invalid_request" | "rate_limited" | "payment_required" |
  "upstream_error" | "invalid_response" | "timeout" | "network_error" | "aborted";

export { GROUNDING_CRITERIA_VERSION };
export const GROUNDING_DEFAULT_TIMEOUT_MS = 20_000;
export const GROUNDING_MAX_TIMEOUT_MS = 60_000;

export class GroundingConnectionError extends Error {
  code: GroundingErrorCode;
  constructor(code: GroundingErrorCode) {
    super("Grounding judge connection failed: " + code);
    this.name = "GroundingConnectionError";
    this.code = code;
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type ClientConfig = { provider?: unknown; baseUrl?: unknown; apiKey?: unknown };

const nonnegative = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const statusCode = (status: number): GroundingErrorCode => status === 404 ? "not_found" : status === 503 ? "disabled" :
  status === 402 ? "payment_required" : status === 429 ? "rate_limited" : status === 400 ? "invalid_request" : "upstream_error";

/** Validates a Worker response body; anything outside the closed sets is rejected. */
export function parseGroundingVerdict(data: unknown, purpose: GroundingPurpose, latencyMs: number): GroundingVerdict {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new GroundingConnectionError("invalid_response");
  const value = data as Record<string, unknown>;
  const identification = validateAxis(value.identification, GROUNDING_LEVELS.identification, false);
  const nameAgreement = validateAxis(value.nameAgreement, GROUNDING_LEVELS.name_agreement, false);
  // A different criteria version (e.g. a v1 proxy with 4 name levels) is never mixed into v2 results.
  if (value.purpose !== purpose || !isGroundingModel(value.model, GROUNDING_MODELS[purpose]) || !identification || !nameAgreement ||
      value.criteriaVersion !== GROUNDING_CRITERIA_VERSION) {
    throw new GroundingConnectionError("invalid_response");
  }
  const usage = value.usage && typeof value.usage === "object" ? value.usage as Record<string, unknown> : null;
  return {
    purpose, model: value.model, identification, nameAgreement,
    provider: typeof value.provider === "string" && value.provider.length <= 64 ? value.provider : null,
    id: typeof value.id === "string" && value.id.length <= 128 ? value.id : null,
    usage: usage && { inputTokens: nonnegative(usage.inputTokens), outputTokens: nonnegative(usage.outputTokens), costUsd: nonnegative(usage.costUsd) },
    latencyMs,
    criteriaVersion: GROUNDING_CRITERIA_VERSION,
  };
}

/** HTTP client for POST <baseUrl>/grounding-evidence. A service binding can supply fetchImpl. */
export function createGroundingJudgeClient(config: ClientConfig, fetchImpl: FetchLike = globalThis.fetch): GroundingJudge {
  if (config?.provider !== "cloudflare" || typeof config.baseUrl !== "string" || !config.baseUrl.endsWith("/v1") ||
      typeof config.apiKey !== "string" || typeof fetchImpl !== "function") {
    throw new GroundingConnectionError("invalid_config");
  }
  const url = config.baseUrl + "/grounding-evidence";
  const apiKey = config.apiKey;
  return Object.freeze({
    async judge(request: GroundingRequest, options: GroundingCallOptions = {}): Promise<GroundingVerdict> {
      const purpose = request?.purpose;
      const timeoutMs = options.timeoutMs ?? GROUNDING_DEFAULT_TIMEOUT_MS;
      if (!Object.hasOwn(GROUNDING_MODELS, purpose) || typeof request.state !== "string" || !request.state.trim() ||
          request.state.length > GROUNDING_MAX_STATE_CHARS || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
          timeoutMs > GROUNDING_MAX_TIMEOUT_MS) {
        throw new GroundingConnectionError("invalid_request");
      }
      if (options.signal?.aborted) throw new GroundingConnectionError("aborted");
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      const forward = () => controller.abort();
      options.signal?.addEventListener("abort", forward, { once: true });
      const started = performance.now();
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ purpose, state: request.state }),
          signal: controller.signal,
        });
        if (!response.ok) throw new GroundingConnectionError(statusCode(response.status));
        const data = await response.json();
        return parseGroundingVerdict(data, purpose, Math.round(performance.now() - started));
      } catch (error) {
        if (error instanceof GroundingConnectionError) throw error;
        throw new GroundingConnectionError(timedOut ? "timeout" : controller.signal.aborted ? "aborted" : "network_error");
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", forward);
      }
    },
  });
}

/** Deterministic in-process judge for tests and mock dry runs; no network. */
export function createMockGroundingJudge(decide: (state: string) => {
  identification: IdentificationEvidence; nameAgreement: NameAgreementEvidence;
}): GroundingJudge {
  const scores = <Level extends string>(levels: readonly Level[], chosen: Level) =>
    Object.fromEntries(levels.map((level) => [level, level === chosen ? 1 : 0])) as Record<Level, number>;
  return Object.freeze({
    async judge(request: GroundingRequest): Promise<GroundingVerdict> {
      const started = performance.now();
      const { identification, nameAgreement } = decide(request.state);
      return parseGroundingVerdict({
        purpose: request.purpose, model: GROUNDING_MODELS[request.purpose], provider: "mock", id: null,
        identification: { level: identification, scores: scores(GROUNDING_LEVELS.identification, identification), confidence: null },
        nameAgreement: { level: nameAgreement, scores: scores(GROUNDING_LEVELS.name_agreement, nameAgreement), confidence: null },
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        criteriaVersion: GROUNDING_CRITERIA_VERSION,
      }, request.purpose, Math.round(performance.now() - started));
    },
  });
}
