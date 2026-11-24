import { DurableObject } from "cloudflare:workers";
import { createChatClient } from "../../../dialogue-model/runtime/client.mjs";
import { createNamingTaskV2 } from "../../../dialogue-model/runtime/v2/naming-task-v2.mjs";
import { createGroundingJudgeClient } from "../../../dialogue-model/runtime/grounding/client.ts";
import { NamingTaskError } from "../../../dialogue-model/runtime/naming-error.mjs";
import { sessionCookie, sessionId } from "./session-cookie.ts";
import { isExcessiveTraffic, type SoftLimitBindings } from "./soft-limits";
import { AdminIndex } from "./admin/index-do";
import { createReceptionAdminPort, createReceptionSettingsPort } from './admin/reception-adapter.ts';
import { handleAdmin, isAdminPath, type AdminLimiter } from "./admin/routes.ts";
import { summarizeRecord, type AdminSummary } from "./admin/summary.ts";
import type { AuditEntry } from "./admin/index-store.ts";
import { summarizeLatency } from "./admin/latency.ts";
import { ACTIVE_KEY, backfillActive, deleteArchived, ledgerIds, readArchived,
  readQuestionnaire, retentionDays, writeQuestionnaire } from "./admin/archive.ts";
import { RECORD_ID } from "./admin/summary.ts";
import { lockResult, participantReview, QUESTIONNAIRE_FORM, recordListEntry, sortRecordList,
  type Questionnaire } from "../../../dialogue-model/runtime/v2/participant-records.ts";

import { createBaseAssignmentSession, BaseSessionError } from "../../../dialogue-model/runtime/v2/base-assignment-session.ts";
import { validateBaseStart, validateBaseAssignmentConfig, BaseAssignmentError } from "../../../dialogue-model/runtime/v2/base-assignment.ts";
import { readOwner, validateBoundBaseRecord } from "../../../dialogue-model/runtime/v2/base-assignment-data.ts";
import type { BaseOwnerState, BaseRecord, BaseSession, MakeBaseTask, OwnerRead } from "../../../dialogue-model/runtime/v2/base-assignment.ts";
import { participantContactHTML } from "../../../dialogue-model/runtime/v2/participant-contact.ts";
import { PARTICIPANT_STOP_HTML } from "../../../dialogue-model/runtime/v2/participant-stop-page.ts";
import { ReceptionError, validateReception, createReception, approveReception, cancelReception,
  participantReception, receptionSummary, effectiveBetweenTrials } from '../../../dialogue-model/runtime/v2/reception.ts';
import { isSubmittedQuestionnaire } from '../../../dialogue-model/runtime/v2/questionnaire-gate.ts';
import { receptionOpen, validateReceptionSettings } from './admin/reception-settings.ts';
import type { ProtocolEntry, ReceptionSettings } from './admin/reception-settings.ts';
import type { RotationMode } from '../../../dialogue-model/runtime/v2/reception.ts';
import type { Reception } from '../../../dialogue-model/runtime/v2/reception.ts';
import { BROWSER_SESSIONS_KEY, EMPTY_TAB_SESSION_MAX_AGE_MS, MAX_EMPTY_TAB_SESSIONS, TAB_SESSION_HEADER, TAB_SESSION_ID,
  questionnaireUpdate, sortBrowserSessions, summarizeBrowserSession, tabSessionRoute,
  validateCreateTabSession, validateEventCount } from './tab-sessions.ts';
import type { BrowserSession, BrowserSessionSummary, ReceptionMode } from './tab-sessions.ts';
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
  // Reception mode and protocol are researcher settings saved in ADMIN_INDEX (/admin/reception-settings);
  // RECEPTION_REQUIRED and RECEPTION_PROTOCOL_JSON are no longer read.
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
  // Participant Cookie Max-Age in days only (integer 1-365; invalid -> 30). Records never expire automatically.
  RECORD_RETENTION_DAYS?: string;
}

const ADMIN_INDEX_NAME = "global";
const TAB_OWNER_KEY = "browser:tab-owner:v1";

const MAX_BODY_BYTES = 64 * 1024;
const errors = new Set([
  "invalid_strategy", "invalid_seed", "invalid_submission", "invalid_request", "busy", "trial_required",
  "ai_unavailable", "scoring_error", "invalid_message", "invalid_options", "ai_busy", "ai_retry_required",
  "submission_error", "already_submitted", "dialogue_closed", "record_write_failed",
  "not_found", "invalid_questionnaire", "questionnaire_submitted", "trial_not_completed", "trial_changed",
]);

const json = (status: number, body: unknown): Response => Response.json(body, { status });
/** How this browser's stored state decides its flow; the global mode matters only for new starts. */
type OwnerKind = 'reception' | 'legacy_active' | 'absent' | 'unused' | 'legacy';

function newSessionId(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function readBodyText(request: Request): Promise<string> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) throw new NamingTaskError("invalid_request");
  const value = await request.text();
  if (new TextEncoder().encode(value).byteLength > MAX_BODY_BYTES) throw new NamingTaskError("invalid_request");
  return value;
}

async function readBody(request: Request): Promise<ApiBody> {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") throw new NamingTaskError("invalid_request");
  const value = await readBodyText(request);
  try {
    const data: unknown = JSON.parse(value);
    if (data && typeof data === "object" && !Array.isArray(data)) return data as ApiBody;
  } catch { /* Invalid JSON is reported without echoing its content. */ }
  throw new NamingTaskError("invalid_request");
}

function sanitizedError(error: unknown): Response {
  if (error instanceof ReceptionError) return json(409, { error:error.code === 'protocol_unconfigured' ? 'reception_not_approved' : error.code });
  if (error instanceof BaseSessionError) { const code = error.code === 'owner_expired' ? 'session_required' : error.code;
    return json(code === 'session_required' ? 401 : code === 'not_found' ? 404 : code === 'invalid_request' ? 400 : 409, {error:code}); }
  if (error instanceof BaseAssignmentError) return json(error.code === 'invalid_request' ? 400 : 409, {error:error.code === 'invalid_request' ? 'invalid_request' : 'trial_unavailable'});
  const code = error instanceof NamingTaskError && errors.has(error.code) ? error.code : "operation_failed";
  const status = code === "scoring_error" || code === "record_write_failed" ? 500
    : code === "ai_unavailable" ? 502 : code === "not_found" ? 404
    : ["ai_busy", "ai_retry_required", "busy", "questionnaire_submitted", "trial_not_completed", "trial_changed"].includes(code) ? 409 : 400;
  return json(status, { error: code });
}

export class TangramSession extends DurableObject<Env> {
  private trial: NamingTask | null = null;
  private initialized: Promise<void> | null = null;
  private base: BaseSession | null = null;
  private lastIndexed = new Map<string, string>();
  // Trials replaced by /api/start in this browser: their late writes go only to their own archive key.
  private retired = new Set<string>();
  private receptionQueue: Promise<unknown> = Promise.resolve();
  private browserQueue: Promise<unknown> = Promise.resolve();
  // The explicit intent of the admission in progress: a reception plan trial, or the configured legacy assignment.
  private admission: { kind: 'reception'; receptionId: string; expectedRevision: number; index: number } | { kind: 'legacy' } | null = null;

  /** One consistent settings snapshot from the global index. Unreadable or damaged settings fail closed. */
  private async settings(): Promise<ReceptionSettings> {
    const index = this.index();
    if (!index) throw new ReceptionError('reception_unavailable');
    let raw: unknown;
    try { raw = await index.readReceptionSettings(); } catch { throw new ReceptionError('reception_unavailable'); }
    // workerd adds a non-enumerable Symbol.dispose to RPC results; keep only the structured data, then validate it.
    return validateReceptionSettings(structuredClone(raw));
  }
  private async currentProtocol(): Promise<ProtocolEntry> {
    const s = await this.settings();
    if (!s.protocol) throw new ReceptionError('protocol_unconfigured');
    return s.protocol;
  }
  /** Classified from stored state only: a reception owner stays one even when the global mode is off. */
  private async ownerKind(): Promise<OwnerKind> {
    if (await this.readReception()) return 'reception';
    const raw = await this.ctx.storage.get<BaseOwnerState>('base:owner:v1');
    if (!raw) return await this.ctx.storage.get(ACTIVE_KEY) ? 'legacy_active' : 'absent';
    return readOwner(raw, this.ctx.id.toString()).activeKey === null ? 'unused' : 'legacy';
  }
  private receptionSerial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.receptionQueue.then(fn,fn); this.receptionQueue = result.catch(() => {}); return result;
  }
  private async readReception(): Promise<Reception | null> {
    const raw = await this.ctx.storage.get('reception:v1');
    if (raw === undefined) return null;
    const r = validateReception(raw);
    if (r.objectId !== this.ctx.id.toString()) throw new ReceptionError('reception_unavailable');
    return r;
  }
  private async indexReception(reception: Reception): Promise<void> {
    try { await this.index()?.upsertReception(receptionSummary(reception)); } catch { /* Best effort; the owner remains authoritative. */ }
  }
  private async receive(): Promise<void> {
    await this.receptionSerial(async () => {
      const previous = await this.readReception();
      if (previous) { await this.indexReception(previous); return; }
      // Only an unused owner may become a reception owner, and only unless the researcher has turned reception off.
      // Waiting needs no protocol; approval and start still do.
      if (await this.ownerKind() !== 'unused') throw new NamingTaskError('not_found');
      const settings = await this.settings();
      if (!receptionOpen(settings.mode)) throw new NamingTaskError('not_found');
      let number: string | null = null;
      // daily_seq3 is the only supported number format, not a research condition.
      try { number = await this.index()?.allocateReceptionNumber(settings.protocol?.protocol.receptionNumberFormat ?? 'daily_seq3',Date.now()) ?? null; }
      catch { /* An unavailable number counter still admits an unnumbered waiting reception. */ }
      const r = createReception({ receptionId:crypto.randomUUID(), objectId:this.ctx.id.toString(), createdAt:new Date().toISOString(), number });
      const saved = await this.serialized(() => this.ctx.storage.transaction(async tx => {
        const old = await tx.get('reception:v1');
        if (old !== undefined) return validateReception(old);
        const owner = await tx.get<BaseOwnerState>('base:owner:v1');
        if (!owner || readOwner(owner, this.ctx.id.toString()).activeKey !== null) throw new ReceptionError('reception_unavailable');
        await tx.put({ 'reception:v1':r }); return r;
      }));
      await this.indexReception(saved);
    });
  }
  /** Researcher-only RPCs. The management adapter supplies authorization. */
  async adminReception(): Promise<Reception | null> { return this.readReception(); }
  async adminApproveReception(input: { expectedRevision: number; order: number; protocol: unknown }): Promise<Reception> {
    return this.receptionSerial(async () => {
      // One settings read is the fixed point: the same snapshot is compared and copied into the plan.
      const settings = await this.settings();
      if (!receptionOpen(settings.mode)) throw new ReceptionError('reception_closed');
      if (!settings.protocol) throw new ReceptionError('protocol_unconfigured');
      const protocol = settings.protocol.protocol, expected = input?.protocol;
      const r = await this.serialized(() => this.ctx.storage.transaction(async tx => {
        const raw = await tx.get('reception:v1'); if (!raw) throw new ReceptionError('reception_unavailable');
        const next = await approveReception(raw, { expectedRevision:input.expectedRevision, order:input.order, protocol, expected, approvedAt:new Date().toISOString(),
          randomSeed:() => crypto.getRandomValues(new Uint32Array(1))[0] });
        await tx.put({ 'reception:v1':next }); return next;
      }));
      await this.indexReception(r); return r;
    });
  }
  async adminCancelReception(input: { expectedRevision: number }): Promise<Reception> {
    return this.receptionSerial(async () => {
      const r = await this.serialized(() => this.ctx.storage.transaction(async tx => {
        const raw = await tx.get('reception:v1'); if (!raw) throw new ReceptionError('reception_unavailable');
        const next = cancelReception(raw,input.expectedRevision); await tx.put({ 'reception:v1':next }); return next;
      }));
      await this.indexReception(r); return r;
    });
  }
  /** Every new trial is admitted here, serialized with reception creation and approval. */
  private async startTrial(body: ApiBody, isolated: boolean): Promise<void> {
    await this.receptionSerial(async () => {
      const kind = await this.ownerKind();
      if (kind === 'reception') return this.receptionStart(body);
      if (kind === 'unused' || kind === 'legacy') {
        // A new start reads the current setting; unreadable settings never count as off.
        const settings = await this.settings();
        if (receptionOpen(settings.mode)) throw new ReceptionError(kind === 'unused' ? 'reception_not_approved' : 'reception_required');
      }
      validateBaseStart(body);
      this.admission = { kind:'legacy' };
      try {
        const result = await this.assignmentSession().start(body);
        if (isolated && result.kind === 'completed') throw new NamingTaskError('trial_changed');
        this.trial = result.task;
      } finally { this.admission = null; }
    });
  }
  /** Caller holds receptionSerial. The approved plan decides the trial; the current protocol must still be valid. */
  private async receptionStart(body: ApiBody): Promise<void> {
    await this.currentProtocol(); // A saved plan never bypasses unreadable or unconfigured settings.
    const r = await this.readReception();
    if (!r || !r.plan || !['approved','in_progress'].includes(r.status)) throw new ReceptionError('reception_not_approved');
    if (!Number.isSafeInteger(body.expectedReceptionRevision) || body.expectedReceptionRevision !== r.revision) throw new ReceptionError('trial_changed');
    const index = r.trials.length;
    if (index >= r.plan.trials.length) throw new ReceptionError('reception_finished');
    let predecessor: string | undefined;
    if (index === 0) {
      if (r.status !== 'approved' || Object.hasOwn(body,'expectedRecordId')) throw new ReceptionError('trial_changed');
    } else {
      const last = r.trials[index-1];
      if (typeof body.expectedRecordId !== 'string' || body.expectedRecordId !== last.recordId) throw new ReceptionError('trial_changed');
      predecessor = body.expectedRecordId;
      const record = await this.baseReadRecord(predecessor);
      if (!record || record.status !== 'completed') throw new ReceptionError('reception_conflict');
      // Frozen at approval: a later protocol change never adds or removes this requirement.
      if (effectiveBetweenTrials(r.plan) === 'questionnaire_required' && !await this.questionnaireSubmitted(predecessor)) {
        throw new ReceptionError('questionnaire_required');
      }
    }
    this.admission = { kind:'reception', receptionId:r.receptionId, expectedRevision:r.revision, index };
    try {
      if (predecessor) {
        await this.assignmentSession().prepareNext(predecessor);
        this.trial = (await this.assignmentSession().restore()).task;
      } else this.trial = (await this.assignmentSession().start({version:2})).task;
    } finally { this.admission = null; }
  }
  private async questionnaireSubmitted(recordId: string): Promise<boolean> {
    try { return isSubmittedQuestionnaire(await readQuestionnaire(this.ctx.storage, recordId)); } catch { return false; }
  }

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
    const existed = await this.serialized(() => this.ctx.storage.transaction(async tx => {
      const raw = await tx.get<BaseOwnerState>('base:owner:v1');
      if (raw) {
        const owner = readOwner(raw, this.ctx.id.toString());
        let changed = false;
        for (const entry of Object.values(owner.admissions)) {
          if (entry?.record?.recordId !== recordId) continue;
          // Keep the admission/after key: retries must never create a replacement
          // for this deleted trial. This marker is part of the strict owner schema.
          entry.record = null;
          entry.status = 'failed';
          entry.errorCode = 'record_deleted';
          changed = true;
        }
        if (changed) {
          owner.revision += 1; // Invalidate any assignment CAS read before deletion.
          await tx.put({ 'base:owner:v1': readOwner(owner, this.ctx.id.toString()) });
        }
      }
      // Owner copies, archive, questionnaire, active, ledger and tombstone commit
      // together; a failed write cannot leave a partial deletion behind.
      return deleteArchived(tx, recordId);
    }));
    this.forget([recordId]);
    await this.scheduleExpiry();
    return existed;
  }

  /** Old deployments may have scheduled an expiry alarm. Clear it without deleting evidence. */
  async alarm(): Promise<void> {
    await this.scheduleExpiry();
    // Re-register the remaining records, so a missed best-effort index write is repaired.
    for (const id of await ledgerIds(this.ctx.storage)) {
      const record = await this.readOwnedArchive(id);
      if (record) await this.registerSummary(record as StoredTrial);
    }
  }

  // Archive mutations (persist, delete, backfill) run one at a time in this
  // object, so ledger read-modify-writes never interleave. A Durable Object is single
  // threaded, so this chain covers every writer of this session's storage.
  private archiveQueue: Promise<unknown> = Promise.resolve();
  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.archiveQueue.then(task, task);
    this.archiveQueue = run.catch(() => {});
    return run;
  }

  private index() {
    return this.env.ADMIN_INDEX ? this.env.ADMIN_INDEX.get(this.env.ADMIN_INDEX.idFromName(ADMIN_INDEX_NAME)) : null;
  }

  private forget(recordIds: string[]): void {
    for (const id of recordIds) this.lastIndexed.delete(id);
    const current = this.trial?.getState().sessionId;
    if (typeof current === "string" && recordIds.includes(current)) this.trial = null;
  }

  /** Cancel legacy expiry alarms; saving or accessing a record never schedules deletion. */
  private async scheduleExpiry(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
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
      // Additive backfill keeps even old active-only evidence, with its original
      // update time. No record is expired during initialization.
      await this.serialized(() => backfillActive(this.ctx.storage, Date.now()));
      await this.scheduleExpiry();
      // Legacy active records may be archived/indexed but never restored into a task.
      const record = await this.ctx.storage.get<StoredTrial>(ACTIVE_KEY);
      if (record) { await this.validateArchiveBinding(record); this.ctx.waitUntil(this.registerSummary(record)); }
    })();
    return this.initialized;
  }

  /** Narrow metadata RPCs; neither constructs tasks nor selects conditions. */
  async baseOwnerStatus(browserProfile = false): Promise<'absent'|'registered'|'expired'> {
    if (browserProfile && await this.ctx.storage.get(TAB_OWNER_KEY)) return 'absent';
    const owner = await this.ctx.storage.get<BaseOwnerState>('base:owner:v1');
    if (!owner) {
      const active = await this.ctx.storage.get<StoredTrial>(ACTIVE_KEY);
      if (active) await this.validateArchiveBinding(active);
      return active || browserProfile && ((await this.ctx.storage.get('reception:v1')) !== undefined ||
        (await ledgerIds(this.ctx.storage)).length > 0) ? 'registered' : 'absent';
    }
    readOwner(owner, this.ctx.id.toString());
    if (browserProfile) return 'registered';
    const current = owner.activeKey && owner.admissions[owner.activeKey];
    if (current && current.errorCode === 'record_deleted') return 'expired';
    const r = current && current.record;
    return r && !await this.baseReadRecord(r.recordId) ? 'expired' : 'registered';
  }
  async registerBaseOwner(tabOwner = false): Promise<boolean> {
    return this.serialized(() => this.ctx.storage.transaction(async tx => {
      if (await tx.get('base:owner:v1') || await tx.get(ACTIVE_KEY)) return false;
      const owner: BaseOwnerState = {schemaVersion:'base_owner_v1',ownerId:this.ctx.id.toString(),revision:0,activeKey:null,admissions:{}};
      await tx.put({'base:owner:v1':owner, ...(tabOwner ? { [TAB_OWNER_KEY]: true } : {})}); return true;
    }));
  }

  private async browserSessions(): Promise<BrowserSession[]> {
    return await this.ctx.storage.get<BrowserSession[]>(BROWSER_SESSIONS_KEY) ?? [];
  }

  async resolveTabSession(sessionId: string): Promise<string | null> {
    if (!TAB_SESSION_ID.test(sessionId)) return null;
    return (await this.browserSessions()).find(session => session.sessionId === sessionId)?.doName ?? null;
  }

  private tabObject(doName: string) {
    return this.env.NAMING_SESSIONS.get(this.env.NAMING_SESSIONS.idFromName(doName));
  }

  /** Reclaim only an unstarted, unused owner, atomically with reception and admission writes. */
  async inspectEmptyTabSession(reclaim: boolean): Promise<boolean> {
    const empty = async (storage: Pick<DurableObjectStorage, 'get'>) => {
      const owner = await storage.get<BaseOwnerState>('base:owner:v1');
      const ledger = await storage.get<Record<string, number>>('ledger');
      return (!owner || readOwner(owner, this.ctx.id.toString()).activeKey === null) &&
        !await storage.get('reception:v1') && !await storage.get(ACTIVE_KEY) && !Object.keys(ledger ?? {}).length;
    };
    if (!reclaim) return empty(this.ctx.storage);
    return this.serialized(() => this.ctx.storage.transaction(async tx => {
      if (!await empty(tx)) return false;
      await tx.delete(['base:owner:v1', TAB_OWNER_KEY]);
      return true;
    }));
  }

  async createTabSession(): Promise<{ sessionId: string; state: unknown } | null> {
    const run = this.browserQueue.then(async () => {
      const now = Date.now(), retained: BrowserSession[] = [];
      let empty = 0;
      for (const saved of await this.browserSessions()) {
        const reclaim = now - Date.parse(saved.createdAt) >= EMPTY_TAB_SESSION_MAX_AGE_MS;
        if (await this.tabObject(saved.doName).inspectEmptyTabSession(reclaim)) {
          if (reclaim) continue;
          empty++;
        }
        retained.push(saved);
      }
      if (empty >= MAX_EMPTY_TAB_SESSIONS) {
        await this.ctx.storage.put({ [BROWSER_SESSIONS_KEY]: retained });
        return null;
      }
      const session = { sessionId: crypto.randomUUID(), doName: newSessionId(), createdAt: new Date(now).toISOString() };
      const child = this.tabObject(session.doName);
      if (!await child.registerBaseOwner(true)) throw new BaseSessionError('trial_unavailable');
      try {
        const initial = await child.fetch(new Request('https://session.internal/api/state', { headers: { [TAB_SESSION_HEADER]: session.sessionId } }));
        if (!initial.ok) throw new BaseSessionError('trial_unavailable');
        const state = await initial.json();
        await this.ctx.storage.put({ [BROWSER_SESSIONS_KEY]: [...retained, session] });
        return { sessionId: session.sessionId, state };
      } catch (error) {
        await child.inspectEmptyTabSession(true);
        throw error;
      }
    });
    this.browserQueue = run.catch(() => {});
    return run;
  }

  /** Read only history metadata, leaving dialogue restoration and model calls to explicit routes. */
  async tabHistorySummary(sessionId: string, createdAt: string | null, protocolAvailable: boolean): Promise<BrowserSessionSummary | null> {
    await this.initialize();
    let reception: Reception | null = null, receptionUnreadable = false;
    try { reception = await this.readReception(); }
    catch (error) {
      if (!(error instanceof ReceptionError)) throw error;
      receptionUnreadable = true;
    }
    const active = await this.ctx.storage.get<StoredTrial>(ACTIVE_KEY);
    const records = [];
    for (const id of await ledgerIds(this.ctx.storage)) {
      const record = await this.readOwnedArchive(id);
      if (!record) continue;
      const questionnaire = await readQuestionnaire<Questionnaire>(this.ctx.storage, id);
      records.push({ entry: recordListEntry(record, id === active?.recordId, questionnaire), questionnaireUpdatedAt: questionnaire?.updatedAt });
    }
    return summarizeBrowserSession({ sessionId, createdAt, reception, receptionUnreadable, protocolAvailable,
      activeRecordId: active?.recordId ?? null, records });
  }

  async browserHistory(): Promise<{ receptionMode: ReceptionMode; sessions: BrowserSessionSummary[] }> {
    const settings = await this.settings().catch(() => null);
    const protocolAvailable = Boolean(settings?.protocol);
    const entries = await this.browserSessions();
    const results = await Promise.all([
      this.tabHistorySummary('legacy', null, protocolAvailable),
      ...entries.map(({ sessionId, doName, createdAt }) =>
        this.tabObject(doName).tabHistorySummary(sessionId, createdAt, protocolAvailable)),
    ]);
    const summaries = results.filter((summary): summary is BrowserSessionSummary => summary !== null);
    return { receptionMode: settings ? receptionOpen(settings.mode) ? 'on' : 'off' : 'unavailable',
      sessions: sortBrowserSessions(summaries) };
  }
  private async baseReadRecord(id: string): Promise<BaseRecord|null> {
    if (!RECORD_ID.test(id)) return null;
    const tombstones = await this.ctx.storage.get<string[]>('tombstones') ?? [];
    const ledger = await this.ctx.storage.get<Record<string,number>>('ledger') ?? {};
    if (tombstones.includes(id) || !Object.hasOwn(ledger,id)) return null;
    return await this.readOwnedArchive(id) as BaseRecord | null;
  }
  private assignmentSession(): BaseSession {
    if (this.base) return this.base;
    this.base = createBaseAssignmentSession({ownerId:this.ctx.id.toString(),adapter:'worker_binding',now:Date.now,newId:()=>crypto.randomUUID(),
      readConfig:async()=>this.env.BASE_ASSIGNMENT_JSON === undefined ? null : validateBaseAssignmentConfig(JSON.parse(this.env.BASE_ASSIGNMENT_JSON)),
      // Every admission names its intent explicitly; without one, nothing is admitted.
      readPlan:async () => {
        const binding = this.admission;
        if (binding?.kind === 'legacy') return null;
        const r = await this.readReception();
        if (!r?.plan || binding?.kind !== 'reception' || r.receptionId !== binding.receptionId || r.revision !== binding.expectedRevision) throw new ReceptionError('trial_changed');
        return { receptionId:r.receptionId, plan:r.plan, trialIndex:binding.index };
      },
      makeTask:async binding=>this.createTrial(binding),
      store:{
        read:async():Promise<OwnerRead>=>{
          const raw = await this.ctx.storage.get<BaseOwnerState>('base:owner:v1');
          if (!raw) return await this.ctx.storage.get(ACTIVE_KEY) ? {kind:'legacy_active'} : {kind:'expired'};
          const owner = readOwner(raw,this.ctx.id.toString());
          const current = owner.activeKey && owner.admissions[owner.activeKey];
          if (current && current.errorCode === 'record_deleted') return {kind:'expired'};
          const r = current && current.record;
          if (r && !await this.baseReadRecord(r.recordId)) return {kind:'expired'};
          return {kind:'state',state:owner};
        },
        readRecord:id=>this.baseReadRecord(id),
        compareAndSwap:(revision,next,writes)=>{
          let indexed: Reception | null = null;
          return this.serialized(()=>this.ctx.storage.transaction(async tx=>{
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
            // A deleted archive cannot be recreated by a delayed callback.
            const existed = Object.values(old.admissions).some(e=>e?.record?.recordId===w.record.recordId);
            if (existed && !Object.hasOwn(ledger,w.record.recordId)) throw new BaseSessionError('trial_unavailable');
            updates['record:'+w.record.recordId] = w.record;
            const stamp = typeof w.record.updatedAt === 'string' ? Date.parse(w.record.updatedAt) : Date.now();
            ledger[w.record.recordId] = Number.isFinite(stamp) ? stamp : Date.now();
          }
          updates.ledger = ledger;
          const active = owner.activeKey && owner.admissions[owner.activeKey]?.record;
          if (active) updates[ACTIVE_KEY] = active;
          let reception: Reception | null = null;
          const current = owner.activeKey && owner.admissions[owner.activeKey];
          if (current && current.assignment.source.kind !== 'server_config_v1') {
            const rawReception = await tx.get('reception:v1');
            reception = validateReception(rawReception);
            const source = current.assignment.source;
            if (source.receptionId !== reception.receptionId || reception.objectId !== owner.ownerId ||
              JSON.stringify(source.plan) !== JSON.stringify(reception.plan)) throw new ReceptionError('reception_unavailable');
            let changed = false;
            if (!old.admissions[owner.activeKey!]) {
              const expected = this.admission?.kind === 'reception' ? this.admission : null;
              if (!expected || expected.expectedRevision !== reception.revision || expected.index !== source.trialIndex ||
                expected.receptionId !== reception.receptionId || reception.trials.length !== source.trialIndex ||
                !['approved','in_progress'].includes(reception.status)) throw new ReceptionError('trial_changed');
              reception.trials.push({ index:source.trialIndex, recordId:null }); reception.status = 'in_progress'; changed = true;
            }
            for (const entry of Object.values(owner.admissions)) {
              if (!entry?.record || entry.assignment.source.kind === 'server_config_v1') continue;
              const slot = reception.trials[entry.assignment.source.trialIndex];
              if (!slot || entry.assignment.source.receptionId !== reception.receptionId || slot.recordId !== null && slot.recordId !== entry.record.recordId) throw new ReceptionError('reception_unavailable');
              if (slot.recordId === null) { slot.recordId = entry.record.recordId; changed = true; }
            }
            if (reception.status !== 'finished' && reception.trials.length === reception.plan!.trials.length && reception.trials.every(t =>
              Object.values(owner.admissions).some(e => e?.record?.recordId === t.recordId && e?.record?.status === 'completed'))) {
              reception.status = 'finished'; changed = true;
            }
            if (changed) { reception.revision++; reception = validateReception(reception); updates['reception:v1'] = reception; }
          }
          await tx.put(updates); if (!active) await tx.delete(ACTIVE_KEY);
          indexed = reception;
          return true;
        })).then(applied => {
          // Publish only committed owner/reception state, including when a
          // transaction callback was retried or its commit failed.
          if (applied && indexed) this.ctx.waitUntil(this.indexReception(indexed));
          return applied;
        });
        }
      }});
    return this.base;
  }
  async adminPrepareNext(id: string) {
    return this.receptionSerial(async () => {
      // The researcher's legacy next-trial action follows the same authorization as a new start.
      const kind = await this.ownerKind();
      if (kind === 'reception') throw new ReceptionError('reception_conflict');
      if (kind === 'legacy' && receptionOpen((await this.settings()).mode)) throw new ReceptionError('reception_required');
      this.admission = { kind:'legacy' };
      try {
        const next = await this.assignmentSession().prepareNext(id);
        this.trial = null; // Next participant request obtains the coordinator's bound current handle.
        return next;
      } finally { this.admission = null; }
    });
  }

  private async createTrial(binding: Parameters<MakeBaseTask>[0]): Promise<NamingTask> {
    const {seed,strategy,referenceMemory,restore} = binding;
    // New trials take the assignment's mode; a restored trial takes its mode from its own record only.
    const rotation: { rotationMode?: RotationMode } = restore ? {} : { rotationMode: binding.rotationMode };
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
    return await createNamingTaskV2(({ client, seed, strategy, referenceMemory, utteranceStyle, runDir: null, groundingShadow, ...rotation,
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
   * trials. Any other id (unknown, malformed, another browser's or
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
    const update = questionnaireUpdate(await readBody(request));
    if (record.status !== "completed") throw new NamingTaskError("trial_not_completed");
    // Read-modify-write inside the archive queue, so concurrent saves never interleave.
    const questionnaire = await this.serialized(async () => {
      const previous = await readQuestionnaire<Questionnaire>(this.ctx.storage, recordId);
      const next = update(previous, Date.now());
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

  private async participantState(): Promise<unknown> {
    const state = await this.state();
    const kind = await this.ownerKind();
    if (kind === 'unused') {
      // Only a browser that has nothing yet depends on the global mode; reasons are never shown.
      let open: boolean;
      try { open = receptionOpen((await this.settings()).mode); } catch { return { ...state as object, reception:{ number:null, status:'unavailable', revision:0 } }; }
      return open ? { ...state as object, reception:{ number:null, status:'waiting', revision:0 } } : state;
    }
    if (kind !== 'reception') return state;
    const r = (await this.readReception())!;
    // Settings are read only when a start is possible; an existing trial never depends on them.
    const last = r.status === 'in_progress' ? r.trials.at(-1) : undefined;
    const next = last?.recordId && r.plan && r.trials.length < r.plan.trials.length && (await this.baseReadRecord(last.recordId))?.status === 'completed';
    const awaitingQuestionnaire = Boolean(next && r.plan && effectiveBetweenTrials(r.plan) === 'questionnaire_required' && !await this.questionnaireSubmitted(last!.recordId!));
    const reception = participantReception(r, { awaitingQuestionnaire });
    if (r.status === 'approved' || next) {
      try { await this.currentProtocol(); } catch { reception.status = 'unavailable'; }
    }
    return { ...state as object, reception };
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const pathname = new URL(request.url).pathname;
      const body = request.method === 'POST' && ['/api/start','/api/message','/api/retry','/api/names','/api/ai-submit'].includes(pathname) ? await readBody(request) : null;
      if (pathname === '/api/start' && request.method === 'POST') {
        // A body with reception expectations is checked by shape here and by the reception owner later;
        // any other body must be exactly the legacy start (a legacy owner never accepts expectations).
        if (Object.hasOwn(body!,'expectedReceptionRevision') || Object.hasOwn(body!,'expectedRecordId')) {
          if (body!.version !== 2 || Object.keys(body!).some(k => !['version','expectedReceptionRevision','expectedRecordId'].includes(k))) throw new NamingTaskError('invalid_request');
        } else validateBaseStart(body);
      }
      const isolated = TAB_SESSION_ID.test(request.headers.get(TAB_SESSION_HEADER) ?? '');
      if (!isolated && await this.ctx.storage.get(TAB_OWNER_KEY)) return json(404,{error:'not_found'});
      const ownerStatus = await this.baseOwnerStatus();
      const recordPath = pathname.match(/^\/api\/records\/([^/]+)\/(review|questionnaire)$/);
      const records = request.method === 'GET' && pathname === '/api/records';
      // A deleted active trial does not revoke access to this session's other archives.
      if (ownerStatus !== 'registered' && (!(records || recordPath) ||
        !(isolated && ownerStatus === 'expired') && !await this.baseOwnerStatus(true))) {
        return json(401,{error:'session_required'});
      }
      await this.initialize();
      if (pathname === '/api/reception' && request.method === 'POST') {
        await this.receive(); this.trial = (await this.assignmentSession().restore()).task;
        return json(200,await this.participantState());
      }
      if (records) return json(200, { records: await this.ownRecords() });
      if (recordPath) return await this.recordRoute(request, recordPath[1], recordPath[2]);
      if (pathname !== '/api/start') this.trial = (await this.assignmentSession().restore()).task;
      if (request.method === 'GET' && pathname === '/api/state') return json(200,await this.participantState());
      if (request.method !== "POST") return json(404, { error: "not_found" });
      if (!["/api/start", "/api/message", "/api/retry", "/api/names", "/api/ai-submit"].includes(pathname)) return json(404, { error: "not_found" });
      if (pathname === '/api/start') {
        await this.startTrial(body!, isolated);
        return json(200,await this.participantState());
      }
      if (!this.trial) throw new NamingTaskError("trial_required");
      const trial = this.trial;
      const live = trial.getState();
      if (typeof body!.expectedRecordId !== "string" || body!.expectedRecordId !== live.sessionId) {
        return json(409, { error: "trial_changed" });
      }
      if (pathname === "/api/message") {
        if (typeof body!.text !== "string" || !body!.text.trim() || body!.text.length > 2000) throw new NamingTaskError("invalid_message");
        const clientId = typeof body!.clientId === "string" ? body!.clientId.slice(0, 80) : undefined;
        const receipt = trial.message(body!.text, clientId);
        await trial.persistNow();
        this.ctx.waitUntil(trial.whenIdle().catch(() => {}));
        return json(202, { eventId: receipt.eventId, ...await this.participantState() as object });
      }
      if (pathname === "/api/retry") await trial.retry();
      if (pathname === "/api/names") {
        if (body!.confirm !== true) throw new NamingTaskError("invalid_submission");
        validateEventCount(body!, live.events);
        if (live.status === 'completed') throw new NamingTaskError('already_submitted');
        await trial.submitHuman({ names: body!.names });
        if (!trial.getState().aiSubmitted) await trial.submitAI();
      }
      if (pathname === "/api/ai-submit") {
        if (isolated && live.status === 'completed') throw new NamingTaskError('trial_changed');
        await trial.submitAI();
      }
      return json(200, await this.participantState());
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
        receptions: index ? createReceptionAdminPort({
          index,
          readSettings:() => index.readReceptionSettings(),
          owner:objectId => {
            try { return env.NAMING_SESSIONS.get(env.NAMING_SESSIONS.idFromString(objectId)); } catch { return null; }
          },
        }) : undefined,
        receptionSettings: index ? createReceptionSettingsPort(index) : undefined,
        canResumeParticipant: async (request, recordId) => {
          // Admin credentials never grant participant ownership or a participant cookie.
          const cookie = sessionId(request.headers.get('Cookie'));
          if (!cookie) return false;
          try {
            const root = env.NAMING_SESSIONS.get(env.NAMING_SESSIONS.idFromName(cookie));
            if (await root.baseOwnerStatus(true) !== 'registered') return false;
            const history = await root.browserHistory();
            return history.sessions.some(session => session.resumable && session.activeRecordId === recordId);
          } catch { return false; }
        },
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
        const browserHistory = url.pathname === '/api/sessions' && ['GET','POST'].includes(request.method);
        const allowed = browserHistory || request.method === 'GET' && ['/api/state','/api/records'].includes(url.pathname) ||
          request.method === 'POST' && ['/api/reception','/api/start','/api/message','/api/retry','/api/names','/api/ai-submit'].includes(url.pathname) ||
          ['GET','POST'].includes(request.method) && /^\/api\/records\/[^/]+\/(review|questionnaire)$/u.test(url.pathname);
        if (!allowed) return withHeaders(json(404,{error:'not_found'}));
        const cookie = sessionId(request.headers.get('Cookie'));
        if (!cookie) return withHeaders(json(401,{error:'session_required'}));
        const rootId = env.NAMING_SESSIONS.idFromName(cookie);
        if (browserHistory) {
          const root = env.NAMING_SESSIONS.get(rootId);
          if (await root.baseOwnerStatus(true) !== 'registered') return withHeaders(json(401,{error:'session_required'}));
          if (request.method === 'GET') return withHeaders(json(200,await root.browserHistory()));
          try { validateCreateTabSession(await readBodyText(request), request.headers.get('Content-Type')); }
          catch (error) { return withHeaders(sanitizedError(error)); }
          const session = await root.createTabSession();
          return withHeaders(session ? json(201,session) : json(429,{error:'rate_limited'}));
        }
        const tab = tabSessionRoute(request.headers.get(TAB_SESSION_HEADER));
        if (tab === null) return withHeaders(json(404,{error:'not_found'}));
        let target = rootId;
        if (tab !== 'legacy') {
          const doName = await env.NAMING_SESSIONS.get(rootId).resolveTabSession(tab);
          if (!doName) return withHeaders(json(404,{error:'not_found'}));
          target = env.NAMING_SESSIONS.idFromName(doName);
        }
        if (request.method === 'POST' && await isExcessiveTraffic(request,env,cookie)) {
          const limited = json(429,{error:'rate_limited'});limited.headers.set('Retry-After','60');return withHeaders(limited);
        }
        const object = env.NAMING_SESSIONS.get(target);
        const forwardHeaders = new Headers(request.headers);forwardHeaders.delete('Authorization');forwardHeaders.delete('Cookie');
        result = await object.fetch(new Request(`https://session.internal${url.pathname}${url.search}`,{method:request.method,headers:forwardHeaders,body:['GET','HEAD'].includes(request.method)?null:request.body}));
      } else {
        if (!['/','/index.html','/app.js','/style.css','/tab-session.js'].includes(url.pathname) || request.method !== 'GET') return withHeaders(json(404,{error:'not_found'}));
        if (url.pathname === '/' || url.pathname === '/index.html') {
          let cookie = sessionId(request.headers.get('Cookie'));
          const status = cookie ? await env.NAMING_SESSIONS.get(env.NAMING_SESSIONS.idFromName(cookie)).baseOwnerStatus(true) : 'absent';
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
    } catch {
      if (url.pathname.startsWith('/api/')) return withHeaders(json(409,{error:'trial_unavailable'}));
      // A page request has no app to translate a code: it gets the neutral stop page.
      return withHeaders(new Response(PARTICIPANT_STOP_HTML,{status:503,headers:{'Content-Type':'text/html; charset=utf-8'}}));
    }
    return withHeaders(result, setCookie);
  },
} satisfies ExportedHandler<Env>;
