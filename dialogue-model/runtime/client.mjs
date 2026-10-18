const GET_RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const GET_RETRYABLE_CODE = new Set(["network_error", "timeout"]);
const POST_RETRYABLE_STATUS = new Set([429, 503]);
const PRECONNECT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
const MAX_RETRIES = 2;

function isPreconnectFailure(error) {
  // Fetch's generic TypeError does not prove that a POST was never delivered.
  // Keep native transport causes local; expose only the sanitized error below.
  const cause = error?.cause ?? error;
  const failures = Array.isArray(cause?.errors) ? cause.errors : [cause];
  return failures.length > 0 && failures.every((failure) => PRECONNECT_CODES.has(failure?.code));
}

export class AIConnectionError extends Error {
  constructor(code, status) {
    const suffix = status ? " (HTTP " + status + ")" : "";
    super("AI connection failed: " + code + suffix);
    this.name = "AIConnectionError";
    this.code = code;
    this.status = status ?? null;
    this.retryCount = 0;
  }
}

function responseText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text).join("");
  }
  return "";
}

export function createChatClient(config, fetchImpl = globalThis.fetch, {
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!config?.apiKey || !(config?.model || config?.purpose) || !config?.baseUrl) {
    throw new Error("A configured API key, model, and base URL are required");
  }
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
  const endpoint = new URL(config.baseUrl.replace(/\/+$/, "") + "/chat/completions");

  async function request(url, options, timeoutMs, readResponse, httpCode) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      // Enforce the deadline even when fetchImpl ignores the signal (e.g. a
      // Durable Object service-binding RPC adapter).
      const aborted = new Promise((_resolve, reject) => controller.signal.addEventListener("abort",
        () => reject(new AIConnectionError("timeout")), { once: true }));
      aborted.catch(() => {});
      let failure;
      let responseReceived = false;
      let retryAllowed = false;
      try {
        const response = await Promise.race([fetchImpl(url, { ...options, signal: controller.signal }), aborted]);
        responseReceived = true;
        if (!response.ok) {
          // Dispose of the body without inspecting or exposing an upstream echo.
          await response.body?.cancel().catch(() => {});
          throw new AIConnectionError(httpCode, response.status);
        }
        let data;
        try { data = await Promise.race([response.json(), aborted]); }
        catch (error) {
          if (controller.signal.aborted) throw new AIConnectionError("timeout");
          throw new AIConnectionError(error instanceof SyntaxError ? "invalid_json" : "network_error");
        }
        return { ...readResponse(data), retryCount: attempt, timeoutMs };
      } catch (error) {
        failure = controller.signal.aborted ? new AIConnectionError("timeout") :
          error instanceof AIConnectionError ? error : new AIConnectionError("network_error");
        failure.retryCount = attempt;
        failure.timeoutMs = timeoutMs;
        // A gateway error, abort, reset or unreadable response can follow a
        // completed, billable generation. Never replay that POST automatically.
        retryAllowed = options.method === "POST"
          ? POST_RETRYABLE_STATUS.has(failure.status) ||
            (!responseReceived && !controller.signal.aborted && isPreconnectFailure(error))
          : GET_RETRYABLE_STATUS.has(failure.status) || GET_RETRYABLE_CODE.has(failure.code);
      } finally {
        clearTimeout(timeout);
      }
      if (attempt === MAX_RETRIES || !retryAllowed) throw failure;
      await sleep(500 * 2 ** attempt);
    }
  }

  return {
    async getModelPolicy() {
      if (config.provider !== "cloudflare") throw new Error("Model policy is only available through Cloudflare");
      return request(new URL(config.baseUrl + "/model-policy"), {
        headers: { Authorization: "Bearer " + config.apiKey },
      }, config.timeoutMs ?? 45000, (data) => {
        if (data?.purpose !== config.purpose || typeof data.model !== "string" ||
            !["openai", "gemini"].includes(data.provider) || typeof data.ready !== "boolean") {
          throw new AIConnectionError("invalid_policy_response");
        }
        return data;
      }, "policy_http_error");
    },
    /** @param {object[]} messages @param {{timeoutMs?: number}} [options] A shorter per-call deadline; never longer than the configured one. */
    async complete(messages, { timeoutMs: callTimeoutMs } = {}) {
      if (!Array.isArray(messages) || messages.length === 0) throw new Error("At least one chat message is required");
      if (callTimeoutMs !== undefined && (!Number.isSafeInteger(callTimeoutMs) || callTimeoutMs < 1)) throw new Error("Invalid call timeout");
      const payload = {
        ...(config.purpose ? { purpose: config.purpose } : { model: config.model }), messages,
        ...(config.maxCompletionTokens !== undefined ? { max_completion_tokens: config.maxCompletionTokens } : {}),
      };
      const hasImage = messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part?.type === "image_url"));
      const configuredMs = config.timeoutMs ?? (hasImage ? 90000 : 45000);
      const timeoutMs = callTimeoutMs === undefined ? configuredMs : Math.min(configuredMs, callTimeoutMs);
      return request(endpoint, { method: "POST", headers: {
        Authorization: "Bearer " + config.apiKey, "Content-Type": "application/json",
      }, body: JSON.stringify(payload) }, timeoutMs, (data) => {
        const text = responseText(data?.choices?.[0]?.message?.content);
        if (!text.trim()) throw new AIConnectionError("empty_response");
        return { text, model: typeof data.model === "string" ? data.model : config.model,
          finishReason: data?.choices?.[0]?.finish_reason ?? null,
          usage: { inputTokens: data?.usage?.prompt_tokens ?? null, outputTokens: data?.usage?.completion_tokens ?? null } };
      }, "provider_http_error");
    },
  };
}
