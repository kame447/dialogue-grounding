import { resolvePurposeModel } from "./modelPolicy.mjs";
import { OPENROUTER_DECISIONS_URL, DECISION_MODELS, decisionConfig, buildDecisionPayload, sanitizeDecision } from "./decisions.mjs";

const UPSTREAM_URLS = Object.freeze({
  openai: "https://api.openai.com/v1/chat/completions",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
});
const MAX_REQUEST_BYTES = 18 * 1024 * 1024;
const MAX_MESSAGES = 256;
const MAX_COMPLETION_TOKENS = 8192;
const MAX_TEXT_CHARS = 20000;
const MAX_IMAGE_CHARS = 14 * 1024 * 1024;
const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function tokenMatches(header, expected) {
  if (typeof expected !== "string" || expected.length < 32 ||
      typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const received = header.slice(7);
  if (!received || received.length > 512) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(received)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const l = new Uint8Array(left);
  const r = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < l.length; index++) difference |= l[index] ^ r[index];
  return difference === 0;
}

async function readBoundedText(request) {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_REQUEST_BYTES) {
    throw new Error("request_too_large");
  }
  if (!request.body) throw new Error("empty_request");
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new Error("request_too_large");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(combined);
}

function textContent(text) {
  return typeof text === "string" && text.length <= MAX_TEXT_CHARS;
}

function validateMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message) ||
      !["system", "user", "assistant"].includes(message.role)) return null;
  if (textContent(message.content)) {
    return { role: message.role, content: message.content };
  }
  if (message.role !== "user" || !Array.isArray(message.content) ||
      message.content.length === 0 || message.content.length > 4) return null;

  const parts = [];
  for (const part of message.content) {
    if (!part || typeof part !== "object") return null;
    if (part.type === "text" && textContent(part.text)) {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image_url" && typeof part.image_url?.url === "string") {
      const url = part.image_url.url;
      const prefix = /^data:image\/(?:png|jpeg|webp);base64,/;
      if (url.length > MAX_IMAGE_CHARS || !prefix.test(url) ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(url.slice(url.indexOf(",") + 1))) return null;
      parts.push({ type: "image_url", image_url: { url } });
      continue;
    }
    return null;
  }
  return { role: message.role, content: parts };
}

function validatedPayload(body, selectedModel, env) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      !Array.isArray(body.messages) || body.messages.length === 0 ||
      body.messages.length > MAX_MESSAGES) return null;

  const messages = [];
  for (const entry of body.messages) {
    const parsed = validateMessage(entry);
    if (!parsed) return null;
    messages.push(parsed);
  }

  const limit = Number(env.MAX_COMPLETION_TOKENS || 1024);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_COMPLETION_TOKENS) return null;
  const requested = body.max_completion_tokens === undefined ?
    limit : body.max_completion_tokens;
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > limit) return null;

  return { model: selectedModel, messages, max_completion_tokens: requested };
}

function sanitizeResult(data, model) {
  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  if (!(typeof content === "string" && content.trim()) &&
      !(Array.isArray(content) && content.some((part) =>
        part?.type === "text" && typeof part.text === "string" && part.text.trim()))) {
    return null;
  }
  return {
    model: typeof data.model === "string" ? data.model : model,
    choices: [{
      message: { role: "assistant", content },
      finish_reason: choice.finish_reason ?? null,
    }],
    usage: {
      prompt_tokens: Number.isFinite(data?.usage?.prompt_tokens) ?
        data.usage.prompt_tokens : null,
      completion_tokens: Number.isFinite(data?.usage?.completion_tokens) ?
        data.usage.completion_tokens : null,
    },
  };
}

async function handleDecisions(request, env, fetchImpl) {
  const status = decisionConfig(env);
  if (!status.enabled) return reply(503, { error: "decisions_disabled" });
  if (!status.keyReady) return reply(503, { error: "decisions_unconfigured" });
  if (request.method !== "POST") return reply(405, { error: "method_not_allowed" });
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return reply(415, { error: "unsupported_media_type" });
  }

  let body;
  try {
    body = JSON.parse(await readBoundedText(request));
  } catch (error) {
    const tooLarge = error?.message === "request_too_large";
    return reply(tooLarge ? 413 : 400, { error: tooLarge ? "request_too_large" : "invalid_json" });
  }
  const payload = buildDecisionPayload(body);
  if (!payload) return reply(400, { error: "invalid_request" });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const upstream = await fetchImpl(OPENROUTER_DECISIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + env.OPENROUTER_DECISIONS_API_KEY,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!upstream.ok) {
      return reply(upstream.status === 429 ? 429 : 502, {
        error: upstream.status === 429 ? "upstream_rate_limited" : "upstream_error",
      });
    }
    const response = sanitizeDecision(await upstream.json(), payload.model, body.purpose);
    return response ? reply(200, response) : reply(502, { error: "invalid_upstream_response" });
  } catch {
    return reply(controller.signal.aborted ? 504 : 502, {
      error: controller.signal.aborted ? "upstream_timeout" : "upstream_unavailable",
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function handleRequest(request, env, fetchImpl = globalThis.fetch) {
  const pathname = new URL(request.url).pathname;
  if (!["/health", "/v1/chat/completions", "/v1/model-policy", "/v1/decisions", "/v1/decision-policy"].includes(pathname)) {
    return reply(404, { error: "not_found" });
  }

  if (typeof env.RESEARCH_PROXY_TOKEN !== "string" || env.RESEARCH_PROXY_TOKEN.length < 32) {
    return reply(503, { error: "service_unconfigured" });
  }
  if (!(await tokenMatches(request.headers.get("Authorization"), env.RESEARCH_PROXY_TOKEN))) {
    return reply(401, { error: "unauthorized" });
  }

  if (pathname === "/v1/decision-policy") {
    const config = decisionConfig(env);
    return request.method === "GET" ? reply(200, {
      ready: config.enabled && config.keyReady,
      enabled: config.enabled,
      models: DECISION_MODELS,
      textOnly: true,
    }) : reply(405, { error: "method_not_allowed" });
  }
  if (pathname === "/v1/decisions") return handleDecisions(request, env, fetchImpl);

  const provider = env.UPSTREAM_PROVIDER || "openai";
  const endpoint = UPSTREAM_URLS[provider];
  const policy = resolvePurposeModel({ purpose: "dialogue_turn" }, env);
  const ready = Boolean(endpoint && env.UPSTREAM_API_KEY && "model" in policy);
  if (pathname === "/v1/model-policy") {
    return request.method === "GET" ? reply(200, {
      purpose: "dialogue_turn",
      provider,
      model: "model" in policy ? policy.model : null,
      ready,
    }) : reply(405, { error: "method_not_allowed" });
  }
  if (!ready) {
    return reply(503, { error: "provider_unconfigured" });
  }
  if (pathname === "/health") {
    return request.method === "GET" ? reply(200, { status: "ready" }) :
      reply(405, { error: "method_not_allowed" });
  }

  if (request.method !== "POST") return reply(405, { error: "method_not_allowed" });
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return reply(415, { error: "unsupported_media_type" });
  }

  let body;
  try {
    body = JSON.parse(await readBoundedText(request));
  } catch (error) {
    const status = error?.message === "request_too_large" ? 413 : 400;
    return reply(status, { error: status === 413 ? "request_too_large" : "invalid_json" });
  }

  const selected = resolvePurposeModel(body, env);
  if ("error" in selected) return reply(400, { error: selected.error });
  const payload = validatedPayload(body, selected.model, env);
  if (!payload) return reply(400, { error: "invalid_request" });

  const controller = new AbortController();
  // Reasoning models spend completion tokens before visible text; keep this
  // below the client's 90 s image-turn timeout.
  const timeout = setTimeout(() => controller.abort(), 85000);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + env.UPSTREAM_API_KEY,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      return reply(response.status === 429 ? 429 : 502, {
        error: response.status === 429 ? "upstream_rate_limited" : "upstream_error",
      });
    }
    const data = await response.json();
    const result = sanitizeResult(data, selected.model);
    if (result) return reply(200, result);
    // Empty text after hitting the cap is deterministic for the same request,
    // so it is reported as non-retryable instead of a transient upstream error.
    return data?.choices?.[0]?.finish_reason === "length" ?
      reply(422, { error: "upstream_output_limit" }) :
      reply(502, { error: "invalid_upstream_response" });
  } catch {
    return reply(controller.signal.aborted ? 504 : 502, {
      error: controller.signal.aborted ? "upstream_timeout" : "upstream_unavailable",
    });
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
