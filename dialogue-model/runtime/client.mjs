export class AIConnectionError extends Error {
  constructor(code, status) {
    const suffix = status ? " (HTTP " + status + ")" : "";
    super("AI connection failed: " + code + suffix);
    this.name = "AIConnectionError";
    this.code = code;
    this.status = status ?? null;
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

export function createChatClient(config, fetchImpl = globalThis.fetch) {
  if (!config?.apiKey || !(config?.model || config?.purpose) || !config?.baseUrl) {
    throw new Error("A configured API key, model, and base URL are required");
  }
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");

  const endpoint = new URL(config.baseUrl.replace(/\/+$/, "") + "/chat/completions");
  const timeoutMs = config.timeoutMs ?? 45000;

  return {
    async getModelPolicy() {
      if (config.provider !== "cloudflare") throw new Error("Model policy is only available through Cloudflare");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(new URL(config.baseUrl + "/model-policy"), {
          headers: { Authorization: "Bearer " + config.apiKey },
          signal: controller.signal,
        });
        if (!response.ok) throw new AIConnectionError("policy_http_error", response.status);
        const data = await response.json();
        if (data?.purpose !== config.purpose ||
            typeof data.model !== "string" ||
            !["openai", "gemini"].includes(data.provider) ||
            typeof data.ready !== "boolean") {
          throw new AIConnectionError("invalid_policy_response");
        }
        return data;
      } catch (error) {
        if (error instanceof AIConnectionError) throw error;
        if (controller.signal.aborted) throw new AIConnectionError("timeout");
        throw new AIConnectionError("network_error");
      } finally {
        clearTimeout(timeout);
      }
    },
    async complete(messages) {
      if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error("At least one chat message is required");
      }
      const payload = {
        ...(config.purpose ? { purpose: config.purpose } : { model: config.model }),
        messages,
      };
      if (config.maxCompletionTokens !== undefined) {
        payload.max_completion_tokens = config.maxCompletionTokens;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + config.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!response.ok) throw new AIConnectionError("provider_http_error", response.status);

        let data;
        try {
          data = await response.json();
        } catch {
          throw new AIConnectionError("invalid_json");
        }
        const text = responseText(data?.choices?.[0]?.message?.content);
        if (!text.trim()) throw new AIConnectionError("empty_response");
        return {
          text,
          model: typeof data.model === "string" ? data.model : config.model,
          finishReason: data?.choices?.[0]?.finish_reason ?? null,
          usage: {
            inputTokens: data?.usage?.prompt_tokens ?? null,
            outputTokens: data?.usage?.completion_tokens ?? null,
          },
        };
      } catch (error) {
        if (error instanceof AIConnectionError) throw error;
        if (controller.signal.aborted) throw new AIConnectionError("timeout");
        throw new AIConnectionError("network_error");
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
