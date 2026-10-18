import { DurableObject } from "cloudflare:workers";
import { createChatClient } from "../../../dialogue-model/runtime/client.mjs";
import { createNamingTaskV2 } from "../../../dialogue-model/runtime/v2/naming-task-v2.mjs";
import { NamingTaskError } from "../../../dialogue-model/runtime/naming-error.mjs";

type Strategy = "repair-first" | "bypass-enabled";
type ApiBody = Record<string, unknown>;
type StoredTrial = {
  recordId: string;
  seed: number;
  strategy: Strategy;
  options: { referenceMemory: boolean };
  queueState: { pendingHumanEventIds: string[]; errorCode: string | null };
  closed?: boolean;
  [field: string]: unknown;
};

type NamingTask = {
  getState(): Record<string, unknown>;
  message(text: string, clientId?: string): { eventId: string; duplicate: boolean };
  persistNow(): Promise<void>;
  whenIdle(): Promise<void>;
  retry(): Promise<void>;
  submitHuman(options: { names: unknown }): Promise<unknown>;
  submitAI(): Promise<unknown>;
};

export interface Env {
  NAMING_SESSIONS: DurableObjectNamespace<TangramSession>;
  ASSETS: Fetcher;
  EXPERIMENT_ACCESS_CODE: string;
  AI_PROXY: { chat(payload: unknown): Promise<{ status: number; data: unknown }> };
}

const SESSION_COOKIE = "tangram_session";
const MAX_BODY_BYTES = 64 * 1024;
const errors = new Set([
  "invalid_strategy", "invalid_seed", "invalid_submission", "invalid_request", "busy", "trial_required",
  "ai_unavailable", "scoring_error", "invalid_message", "invalid_options", "ai_busy", "ai_retry_required",
  "submission_error", "already_submitted", "dialogue_closed", "record_write_failed",
]);

const json = (status: number, body: unknown): Response => Response.json(body, { status });
const authChallenge = () => new Response("Access code required", {
  status: 401, headers: { "WWW-Authenticate": 'Basic realm="Tangram Research Demo", charset="UTF-8"', "Cache-Control": "no-store" },
});

function sameString(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
}

function isAuthorized(request: Request, env: Env): boolean {
  if (!env.EXPERIMENT_ACCESS_CODE) return false;
  const authorization = request.headers.get("Authorization") ?? "";
  return sameString(authorization, `Basic ${btoa(`research:${env.EXPERIMENT_ACCESS_CODE}`)}`);
}

function sessionId(cookie: string | null): string | null {
  return cookie?.match(/(?:^|;\s*)tangram_session=([a-f0-9]{64})(?:;|$)/)?.[1] ?? null;
}

function newSessionId(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function readBody(request: Request): Promise<ApiBody> {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") throw new NamingTaskError("invalid_request");
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) throw new NamingTaskError("invalid_request");
  const value = await request.text();
  if (new TextEncoder().encode(value).byteLength > MAX_BODY_BYTES) throw new NamingTaskError("invalid_request");
  try {
    const data: unknown = JSON.parse(value);
    if (data && typeof data === "object" && !Array.isArray(data)) return data as ApiBody;
  } catch { /* Invalid JSON is reported without echoing its content. */ }
  throw new NamingTaskError("invalid_request");
}

function sanitizedError(error: unknown): Response {
  const code = error instanceof NamingTaskError && errors.has(error.code) ? error.code : "operation_failed";
  const status = code === "scoring_error" || code === "record_write_failed" ? 500
    : code === "ai_unavailable" ? 502 : ["ai_busy", "ai_retry_required", "busy"].includes(code) ? 409 : 400;
  return json(status, { error: code });
}

export class TangramSession extends DurableObject<Env> {
  private trial: NamingTask | null = null;
  private initialized: Promise<void> | null = null;

  private async initialize(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = (async () => {
      const record = await this.ctx.storage.get<StoredTrial>("active");
      if (!record) return;
      this.trial = await this.createTrial(record.seed, record.strategy, record.options.referenceMemory, record);
      if (!record.closed && record.queueState.pendingHumanEventIds.length && !record.queueState.errorCode) {
        this.ctx.waitUntil(this.trial.whenIdle().catch(() => {}));
      }
    })();
    return this.initialized;
  }

  private async createTrial(seed: number, strategy: Strategy, referenceMemory: boolean, restore?: StoredTrial): Promise<NamingTask> {
    // The AI proxy keeps both authentication and upstream secrets in its own Worker.
    const client = createChatClient({ provider: "cloudflare", baseUrl: "https://internal.proxy/v1",
      purpose: "dialogue_turn", apiKey: "service-binding-only" }, async (_url, options) => {
      const payload = JSON.parse(String(options?.body ?? ""));
      const response = await this.env.AI_PROXY.chat(payload);
      return new Response(JSON.stringify(response.data), {
        status: response.status, headers: { "Content-Type": "application/json" },
      });
    });
    return await createNamingTaskV2(({ client, seed, strategy, referenceMemory, runDir: null,
      ...(restore ? { restore } : {}),
      onPersist: (snapshot: StoredTrial) => this.ctx.storage.put("active", snapshot),
    }) as unknown as Parameters<typeof createNamingTaskV2>[0]) as NamingTask;
  }

  private state(): unknown {
    const trial = this.trial?.getState() ?? null;
    return { trial, hideStrategy: true, busy: Boolean(trial?.busy) };
  }

  async fetch(request: Request): Promise<Response> {
    try {
      await this.initialize();
      const pathname = new URL(request.url).pathname;
      if (request.method === "GET" && pathname === "/api/state") return json(200, this.state());
      if (request.method !== "POST") return json(404, { error: "not_found" });
      if (!["/api/start", "/api/message", "/api/retry", "/api/names", "/api/ai-submit"].includes(pathname)) return json(404, { error: "not_found" });
      const body = await readBody(request);
      if (pathname === "/api/start") {
        const strategy = body.strategy;
        const seed = body.seed;
        if (body.version !== 2 || !["repair-first", "bypass-enabled"].includes(String(strategy))) throw new NamingTaskError("invalid_strategy");
        if (typeof seed !== "number" || !Number.isSafeInteger(seed)) throw new NamingTaskError("invalid_seed");
        if (body.referenceMemory !== undefined && typeof body.referenceMemory !== "boolean") throw new NamingTaskError("invalid_options");
        if (body.visualAid === true) throw new NamingTaskError("invalid_options");
        if (this.trial && this.trial.getState().status !== "completed") throw new NamingTaskError("busy");
        this.trial = await this.createTrial(seed, strategy as Strategy, body.referenceMemory === true);
        return json(200, this.state());
      }
      if (!this.trial) throw new NamingTaskError("trial_required");
      if (pathname === "/api/message") {
        if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 2000) throw new NamingTaskError("invalid_message");
        const clientId = typeof body.clientId === "string" ? body.clientId.slice(0, 80) : undefined;
        const receipt = this.trial.message(body.text, clientId);
        await this.trial.persistNow();
        this.ctx.waitUntil(this.trial.whenIdle().catch(() => {}));
        return json(202, { eventId: receipt.eventId, ...this.state() as object });
      }
      if (pathname === "/api/retry") await this.trial.retry();
      if (pathname === "/api/names") {
        if (body.confirm !== true) throw new NamingTaskError("invalid_submission");
        await this.trial.submitHuman({ names: body.names });
        if (!this.trial.getState().aiSubmitted) await this.trial.submitAI();
      }
      if (pathname === "/api/ai-submit") await this.trial.submitAI();
      return json(200, this.state());
    } catch (error) {
      return sanitizedError(error);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!isAuthorized(request, env)) return authChallenge();
    const url = new URL(request.url);
    if (request.method === "POST" && request.headers.get("Origin") && request.headers.get("Origin") !== url.origin) {
      return json(403, { error: "request_forbidden" });
    }
    const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
    let result: Response;
    let setCookie: string | undefined;
    if (url.pathname.startsWith("/api/")) {
      let cookie = sessionId(request.headers.get("Cookie"));
      if (!cookie && request.method !== "GET") return json(401, { error: "session_required" });
      if (!cookie) {
        cookie = newSessionId();
        setCookie = `${SESSION_COOKIE}=${cookie}; Path=/; Secure; HttpOnly; SameSite=Strict`;
      }
      const object = env.NAMING_SESSIONS.get(env.NAMING_SESSIONS.idFromName(cookie));
      const forwardHeaders = new Headers(request.headers);
      forwardHeaders.delete("Authorization");
      forwardHeaders.delete("Cookie");
      result = await object.fetch(new Request(`https://session.internal${url.pathname}${url.search}`, {
        method: request.method, headers: forwardHeaders, body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
      }));
    } else {
      result = await env.ASSETS.fetch(request);
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html") &&
          !sessionId(request.headers.get("Cookie"))) {
        setCookie = `${SESSION_COOKIE}=${newSessionId()}; Path=/; Secure; HttpOnly; SameSite=Strict`;
      }
    }
    const response = new Response(result.body, result);
    for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
    if (setCookie) response.headers.set("Set-Cookie", setCookie);
    return response;
  },
} satisfies ExportedHandler<Env>;
