import { DurableObject } from "cloudflare:workers";
import { createChatClient } from "../../../dialogue-model/runtime/client.mjs";
import { createNamingTaskV2 } from "../../../dialogue-model/runtime/v2/naming-task-v2.mjs";
import { NamingTaskError } from "../../../dialogue-model/runtime/naming-error.mjs";
import { sessionCookie, sessionId } from "./session-cookie.ts";
import { isExcessiveTraffic, type SoftLimitBindings } from "./soft-limits";
import { AdminIndex } from "./admin/index-do";
import { handleAdmin, isAdminPath, type AdminLimiter } from "./admin/routes.ts";
import { summarizeRecord, type AdminSummary } from "./admin/summary.ts";
import type { AuditEntry } from "./admin/index-store.ts";
import { summarizeLatency } from "./admin/latency.ts";
import { ACTIVE_KEY, archiveSnapshot, backfillActive, deleteArchived, expireRecords, ledgerIds, nextExpiry, readArchived,
  readQuestionnaire, retentionDays, writeQuestionnaire } from "./admin/archive.ts";
import { RECORD_ID } from "./admin/summary.ts";
import { applyQuestionnaire, lockResult, participantReview, QUESTIONNAIRE_FORM, recordListEntry, sortRecordList,
  type Questionnaire } from "../../../dialogue-model/runtime/v2/participant-records.ts";

export { AdminIndex };

type Strategy = "repair-first" | "bypass-enabled";
type ApiBody = Record<string, unknown>;
type UtteranceStyle = "default" | "concise";
type StoredTrial = {
  recordId: string;
  seed: number;
  strategy: Strategy;
  options: { referenceMemory: boolean; utteranceStyle?: UtteranceStyle };
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

export interface Env extends SoftLimitBindings {
  // Deployment-wide AI utterance style for new trials; identical for both strategies.
  V2_UTTERANCE_STYLE?: string;
  NAMING_SESSIONS: DurableObjectNamespace<TangramSession>;
  ASSETS: Fetcher;
  AI_PROXY: { chat(payload: unknown): Promise<{ status: number; data: unknown }> };
  // Researcher-only admin log. Without the secret (or the limiter) /admin is 404.
  ADMIN_TOKEN?: string;
  ADMIN_INDEX?: DurableObjectNamespace<AdminIndex>;
  ADMIN_RATE_LIMIT?: AdminLimiter;
  // Days after a record's last update before automatic deletion (integer 1-365; invalid -> 30).
  RECORD_RETENTION_DAYS?: string;
}

const ADMIN_INDEX_NAME = "global";

const MAX_BODY_BYTES = 64 * 1024;
const errors = new Set([
  "invalid_strategy", "invalid_seed", "invalid_submission", "invalid_request", "busy", "trial_required",
  "ai_unavailable", "scoring_error", "invalid_message", "invalid_options", "ai_busy", "ai_retry_required",
  "submission_error", "already_submitted", "dialogue_closed", "record_write_failed",
  "not_found", "invalid_questionnaire", "questionnaire_submitted", "trial_not_completed",
]);

const json = (status: number, body: unknown): Response => Response.json(body, { status });

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
    : code === "ai_unavailable" ? 502 : code === "not_found" ? 404
    : ["ai_busy", "ai_retry_required", "busy", "questionnaire_submitted", "trial_not_completed"].includes(code) ? 409 : 400;
  return json(status, { error: code });
}

export class TangramSession extends DurableObject<Env> {
  private trial: NamingTask | null = null;
  private initialized: Promise<void> | null = null;
  private lastIndexed = new Map<string, string>();
  // Trials replaced by /api/start in this browser: their late writes go only to their own archive key.
  private retired = new Set<string>();

  /** Researcher-only read of one archived trial for /admin. It neither restores nor resumes a trial. */
  async adminRecord(recordId: string): Promise<StoredTrial | null> {
    return await this.withQuestionnaire(await readArchived(this.ctx.storage, recordId) as StoredTrial | null);
  }

  /** The record with its stored questionnaire (kept under its own key, see archive.ts). */
  private async withQuestionnaire(record: StoredTrial | null): Promise<StoredTrial | null> {
    if (!record) return null;
    const questionnaire = await readQuestionnaire(this.ctx.storage, record.recordId);
    return questionnaire ? { ...record, questionnaire } : record;
  }

  /** Researcher deletion (authenticated /admin only): removes the record now and tombstones its id. */
  async adminDelete(recordId: string): Promise<boolean> {
    const existed = await this.serialized(() => deleteArchived(this.ctx.storage, recordId));
    this.forget([recordId]);
    await this.scheduleExpiry();
    return existed;
  }

  /** Retention: the alarm deletes records RECORD_RETENTION_DAYS after their last update, never earlier. */
  async alarm(): Promise<void> {
    await this.runExpiry();
    await this.scheduleExpiry();
    // Re-register the remaining records, so a missed best-effort index write is repaired.
    for (const id of await ledgerIds(this.ctx.storage)) {
      const record = await readArchived(this.ctx.storage, id);
      if (record) await this.registerSummary(record as StoredTrial);
    }
  }

  // Archive mutations (persist, delete, expiry, backfill) run one at a time in this
  // object, so ledger read-modify-writes never interleave. A Durable Object is single
  // threaded, so this chain covers every writer of this session's storage.
  private archiveQueue: Promise<unknown> = Promise.resolve();
  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.archiveQueue.then(task, task);
    this.archiveQueue = run.catch(() => {});
    return run;
  }

  private retention(): number { return retentionDays(this.env.RECORD_RETENTION_DAYS); }

  private index() {
    return this.env.ADMIN_INDEX ? this.env.ADMIN_INDEX.get(this.env.ADMIN_INDEX.idFromName(ADMIN_INDEX_NAME)) : null;
  }

  /** Index entries go first: if that fails, nothing is deleted and the alarm retries. */
  private async runExpiry(): Promise<void> {
    const removed = await this.serialized(() => expireRecords(this.ctx.storage, Date.now(), this.retention(), async (ids) => {
      await this.index()?.remove(ids, "retention");
    }));
    this.forget(removed);
  }

  private forget(recordIds: string[]): void {
    for (const id of recordIds) this.lastIndexed.delete(id);
    const current = this.trial?.getState().sessionId;
    if (typeof current === "string" && recordIds.includes(current)) this.trial = null;
  }

  /** One alarm per session at its earliest expiry; refreshed on every write. */
  private async scheduleExpiry(): Promise<void> {
    const next = await nextExpiry(this.ctx.storage, this.retention());
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  /** Best effort: an index failure never affects the participant's trial or its record. */
  private async registerSummary(record: StoredTrial): Promise<void> {
    try {
      if (!this.env.ADMIN_INDEX) return;
      const summary = summarizeRecord(await this.withQuestionnaire(record), this.ctx.id.toString(), summarizeLatency(record));
      // Skip writes when nothing but the timestamp changed.
      const key = JSON.stringify({ ...summary, updatedAt: null });
      if (this.lastIndexed.get(summary.recordId) === key) return;
      this.lastIndexed.set(summary.recordId, key);
      await this.index()?.upsert(summary);
    } catch {
      this.lastIndexed.clear();
    }
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = (async () => {
      // Order matters: backfill, then expiry, then the alarm, then restore. A legacy
      // active-only session older than the retention period is archived with its own
      // last update and immediately expired, so it is never resumed.
      await this.serialized(() => backfillActive(this.ctx.storage, Date.now()));
      await this.runExpiry();
      await this.scheduleExpiry();
      const record = await this.ctx.storage.get<StoredTrial>(ACTIVE_KEY);
      if (!record) return;
      // (Re-)index the restored trial, which also covers backfilled sessions and missed index writes.
      this.ctx.waitUntil(this.registerSummary(record));
      this.trial = await this.createTrial(record.seed, record.strategy, record.options.referenceMemory, record);
      if (!record.closed && record.queueState.pendingHumanEventIds.length && !record.queueState.errorCode) {
        this.ctx.waitUntil(this.trial.whenIdle().catch(() => {}));
      }
    })();
    return this.initialized;
  }

  private async createTrial(seed: number, strategy: Strategy, referenceMemory: boolean, restore?: StoredTrial): Promise<NamingTask> {
    // New trials follow the deployment setting; a restored trial keeps its recorded style.
    const utteranceStyle: UtteranceStyle = restore ? restore.options.utteranceStyle ?? "default"
      : this.env.V2_UTTERANCE_STYLE === "concise" ? "concise" : "default";
    // The AI proxy keeps both authentication and upstream secrets in its own Worker.
    const client = createChatClient({ provider: "cloudflare", baseUrl: "https://internal.proxy/v1",
      purpose: "dialogue_turn", apiKey: "service-binding-only" }, async (_url, options) => {
      const payload = JSON.parse(String(options?.body ?? ""));
      const response = await this.env.AI_PROXY.chat(payload);
      return new Response(JSON.stringify(response.data), {
        status: response.status, headers: { "Content-Type": "application/json" },
      });
    });
    return await createNamingTaskV2(({ client, seed, strategy, referenceMemory, utteranceStyle, runDir: null,
      ...(restore ? { restore } : {}),
      // Every write also keeps record:<recordId>, so a later trial never erases this one.
      onPersist: async (snapshot: StoredTrial) => {
        if (!await this.serialized(() => archiveSnapshot(this.ctx.storage, snapshot, this.retired, Date.now()))) return;
        await this.scheduleExpiry();
        this.ctx.waitUntil(this.registerSummary(snapshot));
      },
    }) as unknown as Parameters<typeof createNamingTaskV2>[0]) as NamingTask;
  }

  /** This browser's trials: exactly the records in this session object's own storage. */
  private async ownRecords() {
    const active = this.trial?.getState().sessionId;
    const entries = [];
    for (const id of await ledgerIds(this.ctx.storage)) {
      const record = await readArchived(this.ctx.storage, id);
      if (record) entries.push(recordListEntry(record, id === active, await readQuestionnaire(this.ctx.storage, id)));
    }
    return sortRecordList(entries);
  }

  /**
   * Read-only review and the provisional questionnaire of one of this browser's
   * trials. Any other id (unknown, malformed, another browser's, expired or
   * deleted) gets the same not_found. Never touches names, the key or scoring.
   */
  private async recordRoute(request: Request, recordId: string, view: string): Promise<Response> {
    const record = RECORD_ID.test(recordId) ? await readArchived(this.ctx.storage, recordId) as StoredTrial | null : null;
    if (!record) throw new NamingTaskError("not_found");
    if (view === "review") {
      if (request.method !== "GET") throw new NamingTaskError("not_found");
      return json(200, lockResult(participantReview(record), await readQuestionnaire(this.ctx.storage, recordId)));
    }
    if (request.method === "GET") {
      return json(200, { recordId, form: QUESTIONNAIRE_FORM, questionnaire: await readQuestionnaire(this.ctx.storage, recordId) });
    }
    if (request.method !== "POST") throw new NamingTaskError("not_found");
    const body = await readBody(request);
    if (record.status !== "completed") throw new NamingTaskError("trial_not_completed");
    // Read-modify-write inside the archive queue, so concurrent saves never interleave.
    const questionnaire = await this.serialized(async () => {
      const previous = await readQuestionnaire<Questionnaire>(this.ctx.storage, recordId);
      const next = applyQuestionnaire(previous, body, new Date().toISOString());
      if (next.changed && !await writeQuestionnaire(this.ctx.storage, recordId, next.questionnaire, Date.now(),
        next.questionnaire.status === "submitted")) throw new NamingTaskError("not_found");
      return next.questionnaire;
    });
    await this.scheduleExpiry();
    this.ctx.waitUntil(this.registerSummary(record));
    return json(200, { recordId, form: QUESTIONNAIRE_FORM, questionnaire });
  }

  /** Participant state; a completed trial's result stays withheld until its questionnaire is submitted. */
  private async state(): Promise<unknown> {
    const live = this.trial?.getState() ?? null;
    const trial = live && typeof live.sessionId === "string"
      ? lockResult(live, await readQuestionnaire(this.ctx.storage, live.sessionId)) : live;
    return { trial, hideStrategy: true, busy: Boolean(live?.busy) };
  }

  async fetch(request: Request): Promise<Response> {
    try {
      await this.initialize();
      const pathname = new URL(request.url).pathname;
      if (request.method === "GET" && pathname === "/api/state") return json(200, await this.state());
      if (request.method === "GET" && pathname === "/api/records") return json(200, { records: await this.ownRecords() });
      const recordPath = pathname.match(/^\/api\/records\/([^/]+)\/(review|questionnaire)$/);
      if (recordPath) return await this.recordRoute(request, recordPath[1], recordPath[2]);
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
        // The replaced trial stays archived under its recordId; only "active" moves on.
        const previous = this.trial?.getState().sessionId;
        if (typeof previous === "string") this.retired.add(previous);
        this.trial = await this.createTrial(seed, strategy as Strategy, body.referenceMemory === true);
        return json(200, await this.state());
      }
      if (!this.trial) throw new NamingTaskError("trial_required");
      if (pathname === "/api/message") {
        if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 2000) throw new NamingTaskError("invalid_message");
        const clientId = typeof body.clientId === "string" ? body.clientId.slice(0, 80) : undefined;
        const receipt = this.trial.message(body.text, clientId);
        await this.trial.persistNow();
        this.ctx.waitUntil(this.trial.whenIdle().catch(() => {}));
        return json(202, { eventId: receipt.eventId, ...await this.state() as object });
      }
      if (pathname === "/api/retry") await this.trial.retry();
      if (pathname === "/api/names") {
        if (body.confirm !== true) throw new NamingTaskError("invalid_submission");
        await this.trial.submitHuman({ names: body.names });
        if (!this.trial.getState().aiSubmitted) await this.trial.submitAI();
      }
      if (pathname === "/api/ai-submit") await this.trial.submitAI();
      return json(200, await this.state());
    } catch (error) {
      return sanitizedError(error);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Researcher-only, read-only, with its own headers; never reaches assets or the participant API.
    if (isAdminPath(url.pathname)) {
      const index = env.ADMIN_INDEX ? env.ADMIN_INDEX.get(env.ADMIN_INDEX.idFromName(ADMIN_INDEX_NAME)) : null;
      // Internal RPC to the owning object named by the index; the participant API is never used.
      const owner = (summary: AdminSummary) => {
        try { return env.NAMING_SESSIONS.get(env.NAMING_SESSIONS.idFromString(summary.objectId)); } catch { return null; }
      };
      return handleAdmin(request, {
        token: index ? env.ADMIN_TOKEN : undefined,
        limiter: env.ADMIN_RATE_LIMIT,
        retentionDays: retentionDays(env.RECORD_RETENTION_DAYS),
        listPage: async (after) => (await index!.page(after)) as { items: AdminSummary[]; next: string | null },
        getSummary: async (recordId) => (await index!.get(recordId)) as AdminSummary | null,
        getRecord: async (summary) => (await owner(summary)?.adminRecord(summary.recordId)) ?? null,
        // Record first, then its index entry (with a content-free audit entry); both steps are idempotent.
        deleteRecord: async (summary) => {
          const session = owner(summary);
          if (!session) throw new Error("invalid_object");
          await session.adminDelete(summary.recordId);
          await index!.remove([summary.recordId], "admin");
        },
        audit: async () => (await index!.audit()) as AuditEntry[],
        summarizeLatency,
      });
    }
    if (request.method === "POST" && request.headers.get("Origin") && request.headers.get("Origin") !== url.origin) {
      return json(403, { error: "request_forbidden" });
    }
    const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
    const withHeaders = (result: Response, setCookie?: string): Response => {
      const response = new Response(result.body, result);
      for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      if (setCookie) response.headers.set("Set-Cookie", setCookie);
      return response;
    };
    if (url.pathname === "/robots.txt") {
      return withHeaders(new Response("User-agent: *\nDisallow: /\n", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }));
    }
    let result: Response;
    let setCookie: string | undefined;
    if (url.pathname.startsWith("/api/")) {
      let cookie = sessionId(request.headers.get("Cookie"));
      if (!cookie && request.method !== "GET") return withHeaders(json(401, { error: "session_required" }));
      if (!cookie) {
        cookie = newSessionId();
        setCookie = sessionCookie(cookie, retentionDays(env.RECORD_RETENTION_DAYS));
      }
      if (request.method === "POST" && await isExcessiveTraffic(request, env, cookie)) {
        const limited = json(429, { error: "rate_limited" });
        limited.headers.set("Retry-After", "60");
        return withHeaders(limited);
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
      // Page loads keep the same session id and renew its Max-Age (see session-cookie.ts).
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        setCookie = sessionCookie(sessionId(request.headers.get("Cookie")) ?? newSessionId(), retentionDays(env.RECORD_RETENTION_DAYS));
      }
    }
    return withHeaders(result, setCookie);
  },
} satisfies ExportedHandler<Env>;
