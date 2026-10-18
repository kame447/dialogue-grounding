// Optional research diagnostics client. Does not replace the dialogue's Luna judge.
import { DECISION_ACTIONS, DECISION_MODELS } from "../../workers/research-ai-proxy/src/decisions.mjs";

export class DecisionConnectionError extends Error {
  constructor(code) {
    super("Decision API connection failed: " + code);
    this.name = "DecisionConnectionError";
    this.code = code;
  }
}

/** Uses the existing research Worker bearer token, never an OpenRouter API key. */
export function createDecisionComparisonClient(config, fetchImpl = globalThis.fetch) {
  if (config?.provider !== "cloudflare" || typeof config.baseUrl !== "string" ||
      !config.baseUrl.endsWith("/v1") || typeof config.apiKey !== "string" ||
      typeof fetchImpl !== "function") {
    throw new DecisionConnectionError("invalid_config");
  }

  const url = config.baseUrl + "/decisions";
  return Object.freeze({
    async chooseAction({ purpose, state }) {
      if (!Object.hasOwn(DECISION_MODELS, purpose) || typeof state !== "string" ||
          !state.trim() || state.length > 20_000) {
        throw new DecisionConnectionError("invalid_request");
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20_000);
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + config.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ purpose, state }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new DecisionConnectionError(response.status === 429 ? "rate_limited" : "upstream_error");
        }
        const data = await response.json();
        if (data?.purpose !== purpose || !DECISION_ACTIONS.includes(data.action) ||
            typeof data.model !== "string" ||
            !data.model.startsWith(DECISION_MODELS[purpose]) ||
            !data.probabilities || !DECISION_ACTIONS.every((action) =>
              Number.isFinite(data.probabilities[action]) &&
              data.probabilities[action] >= 0 && data.probabilities[action] <= 1)) {
          throw new DecisionConnectionError("invalid_response");
        }
        return {
          purpose, model: data.model, action: data.action,
          probabilities: data.probabilities, confidence: data.confidence ?? null,
          usage: data.usage ?? null,
        };
      } catch (error) {
        if (error instanceof DecisionConnectionError) throw error;
        throw new DecisionConnectionError(controller.signal.aborted ? "timeout" : "network_error");
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}
