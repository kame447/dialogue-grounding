import { DurableObject } from "cloudflare:workers";
import { createChatClient } from "../../../dialogue-model/runtime/client.mjs";
import { createNamingTaskV2 } from "../../../dialogue-model/runtime/v2/naming-task-v2.mjs";
import { createGroundingJudgeClient } from "../../../dialogue-model/runtime/grounding/client.ts";
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

import { createBaseAssignmentSession, BaseSessionError } from "../../../dialogue-model/runtime/v2/base-assignment-session.ts";
import { validateBaseStart, validateBaseAssignmentConfig, BaseAssignmentError } from "../../../dialogue-model/runtime/v2/base-assignment.ts";
import { readOwner, validateBoundBaseRecord } from "../../../dialogue-model/runtime/v2/base-assignment-data.ts";
import type { BaseOwnerState, BaseRecord, BaseSession, MakeBaseTask, OwnerRead } from "../../../dialogue-model/runtime/v2/base-assignment.ts";
import { participantContactHTML } from "../../../dialogue-model/runtime/v2/participant-contact.ts";
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
  BASE_ASSIGNMENT_JSON?: string;
  PARTICIPANT_CONTACT_TEXT?: string;
  // Deployment-wide AI utterance style for new trials; identical for both strategies.
  V2_UTTERANCE_STYLE?: string;
  NAMING_SESSIONS: DurableObjectNamespace<TangramSession>;
  ASSETS: Fetcher;
  AI_PROXY: {
    chat(payload: unknown): Promise<{ status: number; data: unknown }>;
    // Absent on proxy deployments without the grounding route; the shadow then records not_found.
    grounding?(payload: unknown): Promise<{ status: number; data: unknown }>;
  };
  // Researcher-only shadow of two-axis grounding evidence for new trials: "on" enables it; unset or anything else is off.
  // It writes private research records only and never changes the dialogue, for either strategy.
  GROUNDING_SHADOW?: string;
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
  if (error instanceof BaseSessionError) { const code = error.code === 'owner_expired' ? 'session_required' : error.code;
    return json(code === 'session_required' ? 401 : code === 'not_found' ? 404 : code === 'invalid_request' ? 400 : 409, {error:code}); }
  if (error instanceof BaseAssignmentError) return json(error.code === 'invalid_request' ? 400 : 409, {error:error.code === 'invalid_request' ? 'invalid_request' : 'trial_unavailable'});
  const code = error instanceof NamingTaskError && errors.has(error.code) ? error.code : "operation_failed";
  const status = code === "scoring_error" || code === "record_write_failed" ? 500
    : code === "ai_unavailable" ? 502 : code === "not_found" ? 404
    : ["ai_busy", "ai_retry_required", "busy", "questionnaire_submitted", "trial_not_completed"].includes(code) ? 409 : 400;
  return json(status, { error: code });
}

export class TangramSession extends DurableObject<Env> {
  private trial: NamingTask | null = null;
  private initialized: Promise<void> | null = null;
  private base: BaseSession | null = null;
  private lastIndexed = new Map<string, string>();
  // Trials replaced by /api/start in this browser: their late writes go only to their own archive key.
  private retired = new Set<string>();

  /** Researcher-only read of one archived trial for /admin. It neither restores nor resumes a trial. */
  async adminRecord(recordId: string): Promise<StoredTrial | null> {
    return await this.withQuestionnaire(await this.readOwnedArchive(recordId));
  }

  /** A new assigned archive is authoritative only through its saved owner admission. */
  private async validateArchiveBinding(record: StoredTrial): Promise<void> {
    const raw = await this.ctx.storage.get<BaseOwnerState>('base:owner:v1');
    if (!raw) {
      // Legacy archive-only records remain readable without fabricating an assignment.
      if (Object.hasOwn(record, 'assignment')) throw new BaseAssignmentError('assignment_record_invalid');
      return;
    }
    const owner = readOwner(raw, this.ctx.id.toString());
    const admission = Object.values(owner.admissions).find(entry => entry?.record?.recordId === record.recordId);
    validateBoundBaseRecord(record, admission?.assignment);
  }

  private async readOwnedArchive(recordId: string): Promise<StoredTrial | null> {
    const record = await readArchived(this.ctx.storage, recordId) as StoredTrial | null;
    if (record === null) return null;
    if (typeof record !== 'object' || Array.isArray(record) || record.recordId !== recordId) throw new BaseAssignmentError('assignment_record_invalid');
    await this.validateArchiveBinding(record);
    return record;
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
      const record = await this.readOwnedArchive(id);
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
      const active = await this.ctx.storage.get<StoredTrial>(ACTIVE_KEY);
      if (active) await this.validateArchiveBinding(active);
      // Order matters: backfill, then expiry, then the alarm, then restore. A legacy
      // active-only session older than the retention period is archived with its own
      // last update and immediately expired, so it is never resumed.
      await this.serialized(() => backfillActive(this.ctx.storage, Date.now()));
      await this.runExpiry();
      await this.scheduleExpiry();
      // Legacy active records may be archived/indexed but never restored into a task.
      const record = await this.ctx.storage.get<StoredTrial>(ACTIVE_KEY);
      if (record) { await this.validateArchiveBinding(record); this.ctx.waitUntil(this.registerSummary(record)); }
    })();
    return this.initialized;
  }

  /** Narrow metadata RPCs; neither constructs tasks nor selects conditions. */
  async baseOwnerStatus(): Promise<'absent'|'registered'|'expired'> {
    const owner = await this.ctx.storage.get<BaseOwnerState>('base:owner:v1');
    if (!owner) {
      const active = await this.ctx.storage.get<StoredTrial>(ACTIVE_KEY);
      if (active) await this.validateArchiveBinding(active);
      return active ? 'registered' : 'absent';
    }
    readOwner(owner, this.ctx.id.toString());
    const r = owner.activeKey && owner.admissions[owner.activeKey]?.record;
    return r && !await this.baseReadRecord(r.recordId) ? 'expired' : 'registered';
  }
  async registerBaseOwner(): Promise<boolean> {
    return this.serialized(() => this.ctx.storage.transaction(async tx => {
      if (await tx.get('base:owner:v1') || await tx.get(ACTIVE_KEY)) return false;
      const owner: BaseOwnerState = {schemaVersion:'base_owner_v1',ownerId:this.ctx.id.toString(),revision:0,activeKey:null,admissions:{}};
      await tx.put({'base:owner:v1':owner}); return true;
    }));
  }
  private async baseReadRecord(id: string): Promise<BaseRecord|null> {
    if (!RECORD_ID.test(id)) return null;
    const tombstones = await this.ctx.storage.get<string[]>('tombstones') ?? [];
    const ledger = await this.ctx.storage.get<Record<string,number>>('ledger') ?? {};
    if (tombstones.includes(id) || !Object.hasOwn(ledger,id) || ledger[id] + this.retention()*86400000 <= Date.now()) return null;
    return await this.readOwnedArchive(id) as BaseRecord | null;
  }
  private assignmentSession(): BaseSession {
    if (this.base) return this.base;
    this.base = createBaseAssignmentSession({ownerId:this.ctx.id.toString(),adapter:'worker_binding',now:Date.now,newId:()=>crypto.randomUUID(),
      readConfig:async()=>this.env.BASE_ASSIGNMENT_JSON === undefined ? null : validateBaseAssignmentConfig(JSON.parse(this.env.BASE_ASSIGNMENT_JSON)),
      makeTask:async binding=>this.createTrial(binding),
      store:{
        read:async():Promise<OwnerRead>=>{
          const raw = await this.ctx.storage.get<BaseOwnerState>('base:owner:v1');
          if (!raw) return await this.ctx.storage.get(ACTIVE_KEY) ? {kind:'legacy_active'} : {kind:'expired'};
          const owner = readOwner(raw,this.ctx.id.toString());
          const r = owner.activeKey && owner.admissions[owner.activeKey]?.record;
          if (r && !await this.baseReadRecord(r.recordId)) return {kind:'expired'};
          return {kind:'state',state:owner};
        },
        readRecord:id=>this.baseReadRecord(id),
        compareAndSwap:(revision,next,writes)=>this.serialized(()=>this.ctx.storage.transaction(async tx=>{
          const raw = await tx.get<BaseOwnerState>('base:owner:v1');
          if (!raw) throw new BaseSessionError('trial_unavailable');
          const old = readOwner(raw,this.ctx.id.toString()); if (old.revision !== revision) return false;
          const owner = readOwner(next,this.ctx.id.toString()); if (owner.revision !== revision+1) throw new BaseSessionError('trial_unavailable');
          const tombstones = await tx.get<string[]>('tombstones') ?? [];
          const ledger = await tx.get<Record<string,number>>('ledger') ?? {};
          const updates: Record<string,unknown> = {'base:owner:v1':owner};
          for (const w of writes) {
            validateBoundBaseRecord(w.record,w.record.assignment);
            if (w.assignmentId !== w.record.assignment.assignmentId || tombstones.includes(w.record.recordId) ||
                !Object.values(owner.admissions).some(e=>e?.assignment.assignmentId===w.assignmentId&&e.record?.recordId===w.record.recordId)) throw new BaseSessionError('trial_unavailable');
            // A retired expired/deleted archive cannot be recreated by a delayed callback.
            const existed = Object.values(old.admissions).some(e=>e?.record?.recordId===w.record.recordId);
            if (existed && (!Object.hasOwn(ledger,w.record.recordId) || ledger[w.record.recordId]+this.retention()*86400000<=Date.now())) throw new BaseSessionError('trial_unavailable');
            updates['record:'+w.record.recordId] = w.record;
            const stamp = typeof w.record.updatedAt === 'string' ? Date.parse(w.record.updatedAt) : Date.now();
            ledger[w.record.recordId] = Number.isFinite(stamp) ? stamp : Date.now();
          }
          updates.ledger = ledger;
          const active = owner.activeKey && owner.admissions[owner.activeKey]?.record;
          if (active) updates[ACTIVE_KEY] = active;
          await tx.put(updates); if (!active) await tx.delete(ACTIVE_KEY);
          return true;
        }))
      }});
    return this.base;
  }
  async adminPrepareNext(id: string) {
    const next = await this.assignmentSession().prepareNext(id);
    this.trial = null; // Next participant request obtains the coordinator's bound current handle.
    return next;
  }

  private async createTrial(binding: Parameters<MakeBaseTask>[0]): Promise<NamingTask> {
    const {seed,strategy,referenceMemory,restore} = binding;
    // New trials follow the deployment setting; a restored trial keeps its recorded style.
    const savedStyle = restore?.options.utteranceStyle ?? 'default';
    if (savedStyle !== 'default' && savedStyle !== 'concise') throw new NamingTaskError('invalid_options');
    const utteranceStyle: UtteranceStyle = restore ? savedStyle
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
    const groundingShadow = this.env.GROUNDING_SHADOW === "on" ? {
      judge: createGroundingJudgeClient({ provider: "cloudflare", baseUrl: "https://internal.proxy/v1", apiKey: "service-binding-only" },
        async (_url, options) => {
          // An RPC stub to an older proxy has no such method; the call then rejects and is recorded as an error.
          const proxy = this.env.AI_PROXY;
          if (typeof proxy.grounding !== "function") return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
          const response = await proxy.grounding(JSON.parse(String(options?.body ?? "")));
          return new Response(JSON.stringify(response.data), { status: response.status, headers: { "Content-Type": "application/json" } });
        }),
    } : null;
    return await createNamingTaskV2(({ client, seed, strategy, referenceMemory, utteranceStyle, runDir: null, groundingShadow,
      ...(restore ? { restore } : {}),
      // Every write also keeps record:<recordId>, so a later trial never erases this one.
      onPersist: async (snapshot: StoredTrial) => {
        await binding.onPersist(snapshot as unknown as BaseRecord);
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
      const record = await this.readOwnedArchive(id);
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
    const record = RECORD_ID.test(recordId) ? await this.readOwnedArchive(recordId) : null;
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
      const pathname = new URL(request.url).pathname;
      const body = request.method === 'POST' && ['/api/start','/api/message','/api/retry','/api/names','/api/ai-submit'].includes(pathname) ? await readBody(request) : null;
      if (pathname === '/api/start' && request.method === 'POST') validateBaseStart(body);
      const ownerStatus = await this.baseOwnerStatus();
      if (ownerStatus !== 'registered') return json(401,{error:'session_required'});
      await this.initialize();
      if (request.method === "GET" && pathname === "/api/records") return json(200, { records: await this.ownRecords() });
      const recordPath = pathname.match(/^\/api\/records\/([^/]+)\/(review|questionnaire)$/);
      if (recordPath) return await this.recordRoute(request, recordPath[1], recordPath[2]);
      if (pathname !== '/api/start') this.trial = (await this.assignmentSession().restore()).task;
      if (request.method === 'GET' && pathname === '/api/state') return json(200,await this.state());
      if (request.method !== "POST") return json(404, { error: "not_found" });
      if (!["/api/start", "/api/message", "/api/retry", "/api/names", "/api/ai-submit"].includes(pathname)) return json(404, { error: "not_found" });
      if (pathname === '/api/start') {
        this.trial = (await this.assignmentSession().start(body)).task;
        return json(200,await this.state());
      }
      if (!this.trial) throw new NamingTaskError("trial_required");
      if (pathname === "/api/message") {
        if (typeof body!.text !== "string" || !body!.text.trim() || body!.text.length > 2000) throw new NamingTaskError("invalid_message");
        const clientId = typeof body!.clientId === "string" ? body!.clientId.slice(0, 80) : undefined;
        const receipt = this.trial.message(body!.text, clientId);
        await this.trial.persistNow();
        this.ctx.waitUntil(this.trial.whenIdle().catch(() => {}));
        return json(202, { eventId: receipt.eventId, ...await this.state() as object });
      }
      if (pathname === "/api/retry") await this.trial.retry();
      if (pathname === "/api/names") {
        if (body!.confirm !== true) throw new NamingTaskError("invalid_submission");
        await this.trial.submitHuman({ names: body!.names });
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
        prepareNext: async summary => {
          const session = owner(summary); if (!session) throw new BaseSessionError('not_found');
          return await session.adminPrepareNext(summary.recordId);
        },
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
    let decoded: string;
    try { decoded = decodeURIComponent(url.pathname); } catch { return withHeaders(json(404,{error:'not_found'})); }
    if (decoded === '/v1' || decoded.startsWith('/v1/') || ['/api/turn','/api/submit'].includes(decoded)) return withHeaders(json(404,{error:'not_found'}));
    try {
      if (url.pathname.startsWith("/api/")) {
        const allowed = request.method === 'GET' && ['/api/state','/api/records'].includes(url.pathname) ||
          request.method === 'POST' && ['/api/start','/api/message','/api/retry','/api/names','/api/ai-submit'].includes(url.pathname) ||
          ['GET','POST'].includes(request.method) && /^\/api\/records\/[^/]+\/(review|questionnaire)$/u.test(url.pathname);
        if (!allowed) return withHeaders(json(404,{error:'not_found'}));
        const cookie = sessionId(request.headers.get('Cookie'));
        if (!cookie) return withHeaders(json(401,{error:'session_required'}));
        if (request.method === 'POST' && await isExcessiveTraffic(request,env,cookie)) {
          const limited = json(429,{error:'rate_limited'});limited.headers.set('Retry-After','60');return withHeaders(limited);
        }
        const object = env.NAMING_SESSIONS.get(env.NAMING_SESSIONS.idFromName(cookie));
        const forwardHeaders = new Headers(request.headers);forwardHeaders.delete('Authorization');forwardHeaders.delete('Cookie');
        result = await object.fetch(new Request(`https://session.internal${url.pathname}${url.search}`,{method:request.method,headers:forwardHeaders,body:['GET','HEAD'].includes(request.method)?null:request.body}));
      } else {
        if (!['/','/index.html','/app.js','/style.css'].includes(url.pathname) || request.method !== 'GET') return withHeaders(json(404,{error:'not_found'}));
        if (url.pathname === '/' || url.pathname === '/index.html') {
          let cookie = sessionId(request.headers.get('Cookie'));
          let status = cookie ? await env.NAMING_SESSIONS.get(env.NAMING_SESSIONS.idFromName(cookie)).baseOwnerStatus() : 'absent';
          if (status !== 'registered') {
            cookie = newSessionId();
            const registered = await env.NAMING_SESSIONS.get(env.NAMING_SESSIONS.idFromName(cookie)).registerBaseOwner();
            if (!registered) throw new BaseSessionError('trial_unavailable');
          }
          setCookie = sessionCookie(cookie!,retentionDays(env.RECORD_RETENTION_DAYS));
        }
        result = await env.ASSETS.fetch(request);
        if (['/','/index.html'].includes(url.pathname) && result.ok) {
          const h = new Headers(result.headers); h.delete('Content-Length'); h.delete('ETag');
          result = new Response(participantContactHTML(await result.text(), env.PARTICIPANT_CONTACT_TEXT), {status:result.status,headers:h});
        }
      }
    } catch { return withHeaders(json(url.pathname.startsWith('/api/') ? 409 : 503,{error:'trial_unavailable'})); }
    return withHeaders(result, setCookie);
  },
} satisfies ExportedHandler<Env>;
