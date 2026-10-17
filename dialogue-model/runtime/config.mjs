const PROVIDER_URLS = Object.freeze({
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
});

function integerOption(value, name, defaultValue, max) {
  if (value === undefined || value === "") return defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(name + " must be an integer between 1 and " + max);
  }
  return parsed;
}

export function loadConfig(env = process.env) {
  const provider = (env.RESEARCH_AI_PROVIDER || "openai").trim().toLowerCase();
  if (!["openai", "gemini", "custom"].includes(provider)) {
    throw new Error("RESEARCH_AI_PROVIDER must be openai, gemini, or custom");
  }

  const model = env.RESEARCH_AI_MODEL?.trim();
  const apiKey = env.RESEARCH_AI_API_KEY?.trim();
  if (!model) throw new Error("Set RESEARCH_AI_MODEL");
  if (!apiKey) throw new Error("Set RESEARCH_AI_API_KEY");

  const configuredUrl = env.RESEARCH_AI_BASE_URL?.trim() || PROVIDER_URLS[provider];
  if (!configuredUrl) throw new Error("Custom provider requires RESEARCH_AI_BASE_URL");

  let url;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new Error("RESEARCH_AI_BASE_URL is not a valid URL");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error("RESEARCH_AI_BASE_URL must use HTTPS (HTTP only for local tests), without credentials or query");
  }

  return Object.freeze({
    provider,
    model,
    apiKey,
    baseUrl: url.toString().replace(/\/$/, ""),
    timeoutMs: integerOption(env.RESEARCH_AI_TIMEOUT_MS, "RESEARCH_AI_TIMEOUT_MS", 45000, 120000),
    maxCompletionTokens: integerOption(
      env.RESEARCH_AI_MAX_COMPLETION_TOKENS, "RESEARCH_AI_MAX_COMPLETION_TOKENS", undefined, 32768
    ),
  });
}
