const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRYABLE_CODE = new Set(["network_error", "timeout"]);
const MAX_RETRIES = 2;

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
      let failure;
      try {
        const response = await fetchImpl(url, { ...options, signal: controller.signal });
        if (!response.ok) {
          // Dispose of the body without inspecting or exposing an upstream echo.
          await response.body?.cancel().catch(() => {});
          throw new AIConnectionError(httpCode, response.status);
        }
        let data;
        try { data = await response.json(); }
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
      } finally {
        clearTimeout(timeout);
      }
      if (attempt === MAX_RETRIES || !(RETRYABLE_STATUS.has(failure.status) || RETRYABLE_CODE.has(failure.code))) throw failure;
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
    async complete(messages) {
      if (!Array.isArray(messages) || messages.length === 0) throw new Error("At least one chat message is required");
      const payload = {
        ...(config.purpose ? { purpose: config.purpose } : { model: config.model }), messages,
        ...(config.maxCompletionTokens !== undefined ? { max_completion_tokens: config.maxCompletionTokens } : {}),
      };
      const hasImage = messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part?.type === "image_url"));
      const timeoutMs = config.timeoutMs ?? (hasImage ? 90000 : 45000);
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
