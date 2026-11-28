import { allRecordedTrialsDeleted } from '../reception-visibility.ts';
import { PARTICIPANT_PRODUCTION_PROFILE } from '../../../../dialogue-model/runtime/web/participant-usage-policy.ts';
import { ReceptionError, validateReception, effectiveRotationMode, effectiveBetweenTrials, effectiveFigureSelection } from '../../../../dialogue-model/runtime/v2/reception.ts';
import { usesThreeFigures, validateReceptionSettings } from './reception-settings.ts';
import type { Reception, ReceptionSummary } from '../../../../dialogue-model/runtime/v2/reception.ts';
import type { DisplayedProtocol, ProtocolFormInput, ReceptionAdminPort, ReceptionAdminRow, ReceptionAdminResult, ReceptionFailedStartUsage, ReceptionSettingsPort } from './reception-port.ts';
import type { FigurePresetPort } from './figure-presets.ts';
import { OBJECT_ID, RECORD_ID } from './summary.ts';
import { participantRoleView } from './participant-role.ts';
import type { ParticipantRole, ParticipantRoleResult } from './participant-role.ts';

type ReceptionListState = { reception: Reception; deletedRecordIds: string[]; recoverableUnrecordedAdmission: boolean };
type Owner = {
  adminReception(): Promise<Reception | null>;
  adminReceptionListState?(): Promise<ReceptionListState | null>;
  adminFailedStartUsage?(receptionId: string): Promise<ReceptionFailedStartUsage | null>;
  adminApproveReception(input: { expectedRevision: number; order: number; protocol: DisplayedProtocol }): Promise<Reception>;
  adminCancelReception(input: { expectedRevision: number }): Promise<Reception>;
  adminForceEndReception?(id: string, expectedRevision: number): Promise<void>;
  adminDeletedRecordIds?(recordIds: string[]): Promise<string[]>;
  adminHasRecoverableUnrecordedAdmission?(receptionId: string): Promise<boolean>;
  adminSetReceptionParticipantRole?(id: string, role: ParticipantRole, expectedRecordIds: string[] | null): Promise<ParticipantRoleResult>;
};
type Index = {
  listReceptions(): Promise<ReceptionSummary[]>;
  getReception(id: string): Promise<ReceptionSummary | null>;
  recordRoles?(recordIds: string[], includeDeleted?: boolean): Promise<Record<string, ParticipantRole | 'deleted'>>;
  participantRoleRevision?(): Promise<string | null>;
};
type Options = { index: Index; owner(objectId: string): Owner | null; readSettings(): Promise<unknown> };
const PAGE_SIZE = 100;
const OWNER_READ_CONCURRENCY = 4;

/** Bound concurrent cross-object reads and preserve index order, without waiting
 * for the slowest member of a batch before starting another independent read. */
async function mapOwnerReads<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(OWNER_READ_CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await read(items[index]);
    }
  }));
  return results;
}

/** Detach plain RPC data and promptly release the response capability. */
function snapshotRpc<T>(value: T): T {
  try { return structuredClone(value); }
  finally {
    if (value !== null && typeof value === 'object') {
      const dispose = (value as { [Symbol.dispose]?: () => void })[Symbol.dispose];
      if (typeof dispose === 'function') dispose.call(value);
    }
  }
}

/** Management values always come from the owning DO, never from index extras. */
function project(r: Reception): ReceptionAdminRow {
  return { receptionId:r.receptionId, number:r.number, createdAt:r.createdAt, status:r.status, revision:r.revision,
    ...(r.termination ? { termination: r.termination } : {}),
    plan:r.plan ? { order:[...r.plan.order], rotationMode:effectiveRotationMode(r.plan, 0), betweenTrials:effectiveBetweenTrials(r.plan),
      figureSets:r.plan.trials.map((_, index) => effectiveFigureSelection(r.plan!, index).setId ?? '') } : null,
    trials:r.trials.map(t => ({...t})),
    ...(r.plan && r.plan.schemaVersion !== 'reception_plan_v1' && r.plan.participantRuntimeProfile === PARTICIPANT_PRODUCTION_PROFILE &&
      r.trials.some(t => t.recordId === null) ? { hasUnrecordedProductionAdmission: true } : {}) };
}
function failure(error: unknown): ReceptionAdminResult {
  // RPC Error objects need not preserve custom .code properties. Accept only
  // the closed error messages emitted by the owner, never reflect raw text.
  const code = error instanceof ReceptionError ? error.code : error instanceof Error ? error.message : null;
  switch (code) {
    case 'not_found': return { ok:false, error:'not_found' };
    case 'reception_conflict': return { ok:false, error:'conflict' };
    case 'invalid_order': return { ok:false, error:'invalid_order' };
    case 'protocol_unconfigured': return { ok:false, error:'protocol_unconfigured' };
    case 'protocol_changed': return { ok:false, error:'protocol_changed' };
    case 'reception_closed': return { ok:false, error:'reception_closed' };
    case 'prepared_observations_unavailable': return { ok:false, error:'prepared_observations_unavailable' };
    default: return { ok:false, error:'reception_unavailable' };
  }
}
export function createReceptionAdminPort(options: Options): ReceptionAdminPort {
  async function resolve(summary: ReceptionSummary | null, requestedId: string, forList = false) {
    if (!summary || !RECORD_ID.test(requestedId) || summary.receptionId !== requestedId || !OBJECT_ID.test(summary.objectId)) return null;
    const owner = options.owner(summary.objectId);
    if (!owner) return null;
    const listState = forList && owner.adminReceptionListState
      ? snapshotRpc(await owner.adminReceptionListState()) : undefined;
    if (listState === null) return null;
    const raw = listState === undefined ? await owner.adminReception() : listState.reception;
    if (raw === null) return null;
    // workerd adds a non-enumerable Symbol.dispose to RPC results; keep only the structured data, then validate it as before.
    const reception = validateReception(listState === undefined ? snapshotRpc(raw) : raw);
    if (reception.receptionId !== requestedId || reception.objectId !== summary.objectId) return null;
    if (listState && (!Array.isArray(listState.deletedRecordIds) ||
        listState.deletedRecordIds.some(id => !reception.trials.some(trial => trial.recordId === id)) ||
        typeof listState.recoverableUnrecordedAdmission !== 'boolean')) throw new ReceptionError('reception_unavailable');
    return { owner, reception, listState };
  }
  async function lookup(id: string) {
    return RECORD_ID.test(id) ? resolve(await options.index.getReception(id),id) : null;
  }
  async function mutate(id: string, action: (owner: Owner) => Promise<unknown>): Promise<ReceptionAdminResult> {
    try {
      const resolved = await lookup(id);
      if (!resolved) return { ok:false, error:'not_found' };
      await action(resolved.owner);
      return { ok:true };
    } catch (error) { return failure(error); }
  }
  return {
    async protocol() {
      // Transport attributes (workerd's Symbol.dispose) are dropped before strict validation; damage throws.
      const s = validateReceptionSettings(snapshotRpc(await options.readSettings()));
      if (!s.protocol) return { configured:false, mode:s.mode.value };
      const p = s.protocol.protocol;
      return { configured:true, mode:s.mode.value, protocolId:p.protocolId, revision:s.protocol.revision, sha256:s.protocol.sha256,
        allowedOrders:p.allowedOrders, rotationMode:p.rotationMode, betweenTrials:p.betweenTrials,
        ...(p.schemaVersion === 'reception_protocol_v3' ? { figureSelection:p.figureSelection, figureSetPolicy:p.figureSetPolicy } : {}),
        ...(usesThreeFigures(p) ? {} : { legacyFigures:true as const }) };
    },
    async listPage(after) {
      const summaries = snapshotRpc(await options.index.listReceptions());
      const position = after ? summaries.findIndex(r => r.receptionId === after) : -1;
      const start = position + 1, page = summaries.slice(start,start+PAGE_SIZE), items: ReceptionAdminRow[] = [];
      const seen = new Set<string>(), liveRecords: string[] = [];
      const sources = new Map<string, { owner: Owner; listState?: ReceptionListState }>();
      async function readRow(summary: ReceptionSummary, fast: boolean) {
        const resolved = await resolve(summary, summary.receptionId, fast);
        if (!resolved) return null;
        const item = project(resolved.reception);
        if (options.index.recordRoles) {
          const ids = item.trials.flatMap(trial => trial.recordId === null ? [] : [trial.recordId]);
          const deleted = new Set(resolved.listState?.deletedRecordIds ??
            (ids.length ? snapshotRpc(await resolved.owner.adminDeletedRecordIds?.(ids)) : []));
          for (const trial of item.trials) {
            if (trial.recordId !== null && deleted.has(trial.recordId)) trial.recordDeleted = true;
          }
        }
        return { item, resolved };
      }
      let unavailableCount = 0;
      const resolvedRows = await mapOwnerReads(page, async summary => {
        try { return await readRow(summary, true); }
        catch {
          // A failed RPC stub is not reusable. resolve() obtains a fresh stub
          // and the original narrow read path, with the same identity checks.
          try { return await readRow(summary, false); }
          catch { unavailableCount++; return null; }
        }
      });
      for (const result of resolvedRows) {
        if (!result || seen.has(result.item.receptionId)) continue;
        const { item, resolved } = result;
        seen.add(item.receptionId);
        sources.set(item.receptionId, resolved);
        if (options.index.recordRoles) for (const trial of item.trials) {
          if (trial.recordId !== null && !trial.recordDeleted) liveRecords.push(trial.recordId);
        }
        items.push(item);
      }
      if (liveRecords.length && options.index.recordRoles) {
        const roles = snapshotRpc(await options.index.recordRoles(liveRecords, true));
        for (const item of items) for (const trial of item.trials) {
          if (trial.recordId === null || trial.recordDeleted) continue;
          const role = roles[trial.recordId];
          if (role === 'deleted') trial.recordDeleted = true;
          else trial.participantRole = participantRoleView(role);
        }
      }
      // Keep the durable reception, audit and admission identities. A terminal
      // null slot does not keep an otherwise deleted reception in the list.
      const visible: ReceptionAdminRow[] = [];
      for (const item of items) {
        const deleted = new Set(item.trials.filter(t => t.recordDeleted).map(t => t.recordId));
        if (!allRecordedTrialsDeleted(item.trials, id => deleted.has(id))) {
          visible.push(item);
          continue;
        }
        if (item.status === 'in_progress' && item.trials.some(t => t.recordId === null)) {
          const source = sources.get(item.receptionId);
          // If a recovery is still possible or the owner cannot be consulted,
          // keep the row rather than hiding an active participant.
          const recoverable = source?.listState?.recoverableUnrecordedAdmission ??
            await source?.owner.adminHasRecoverableUnrecordedAdmission?.(item.receptionId).catch(() => true);
          if (recoverable !== false) visible.push(item);
        }
      }
      return { items: visible, next:start+PAGE_SIZE < summaries.length ? page.at(-1)!.receptionId : null,
        ...(unavailableCount ? { unavailableCount } : {}) };
    },
    async version(since) {
      // Change detection only: index rows and settings are hashed, never shown; management values still come from the owner.
      const [rows, settings, participantRoleRevision] = await Promise.all([
        options.index.listReceptions(), options.readSettings(), options.index.participantRoleRevision?.(),
      ]);
      const s = validateReceptionSettings(snapshotRpc(settings)), list = snapshotRpc(rows);
      if (!Array.isArray(list)) throw new Error('reception_unavailable');
      const material = JSON.stringify({ receptions: list.map(r => [r?.receptionId, r?.number, r?.status, r?.revision,
        Array.isArray(r?.trials) ? r.trials.map(t => t?.recordId ?? null) : null]),
        protocol: s.protocol ? [s.protocol.revision, s.protocol.sha256] : null, mode: [s.mode.value, s.mode.revision],
        participantRoleRevision });
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material)));
      // Only the few index rows that could be new are confirmed with their owner, so a lost index update
      // (e.g. a cancellation) does not keep counting them.
      let newPending: number | null = null;
      if (since !== null) {
        const candidates = list.filter(row => row?.status === 'pending' && typeof row?.createdAt === 'string' && row.createdAt >= since);
        const confirmed = await mapOwnerReads(candidates, async row => (await resolve(row, row.receptionId))?.reception.status === 'pending');
        newPending = confirmed.filter(Boolean).length;
      }
      return { version: [...digest].map(b => b.toString(16).padStart(2, '0')).join(''), newPending };
    },
    async get(id) { const result = await lookup(id); return result ? project(result.reception) : null; },
    async setParticipantRole(id, role, expectedRecordIds) {
      const resolved = await lookup(id);
      if (!resolved?.owner.adminSetReceptionParticipantRole) return { ok: false, error: 'not_found' };
      return await resolved.owner.adminSetReceptionParticipantRole(id, role, expectedRecordIds);
    },
    async failedStartUsage(id) {
      const resolved = await lookup(id);
      if (!resolved?.owner.adminFailedStartUsage) return null;
      const snapshot = structuredClone(await resolved.owner.adminFailedStartUsage(id));
      return snapshot?.receptionId === id ? snapshot : null;
    },
    approve:(id,input) => mutate(id,owner => owner.adminApproveReception(input)),
    cancel:(id,input) => mutate(id,owner => owner.adminCancelReception(input)),
    forceEnd:(id,input) => mutate(id,owner => {
      if (!owner.adminForceEndReception) throw new ReceptionError('reception_unavailable');
      return owner.adminForceEndReception(id, input.expectedRevision);
    }),
  };
}

type SettingsIndex = {
  readReceptionSettings(): Promise<unknown>; receptionProtocolHistory(): Promise<unknown>; receptionModeHistory(): Promise<unknown>;
  saveManagedReceptionProtocol(input: ProtocolFormInput): Promise<unknown>; saveReceptionMode(input: unknown): Promise<unknown>;
  saveReceptionPostGenerationCheck(input: unknown): Promise<unknown>;
  listFigurePresets: FigurePresetPort['list']; readFigurePreset: FigurePresetPort['read']; saveFigurePreset: FigurePresetPort['save'];
};
const SAVE_ERRORS = ['conflict', 'invalid', 'protocol_unconfigured', 'unavailable', 'three_figures_required'];
function saveResult(value: unknown) {
  const v = structuredClone(value) as { ok?: unknown; error?: unknown };
  if (v?.ok === true) return { ok:true as const };
  return { ok:false as const, error:typeof v?.error === 'string' && SAVE_ERRORS.includes(v.error) ? v.error : 'unavailable' };
}
export function createReceptionSettingsPort(index: SettingsIndex): ReceptionSettingsPort {
  return {
    async read() {
      const settings = validateReceptionSettings(structuredClone(await index.readReceptionSettings()));
      return { ...settings, protocolHistory:structuredClone(await index.receptionProtocolHistory()) as never,
        modeHistory:structuredClone(await index.receptionModeHistory()) as never };
    },
    async saveProtocol(input) { return saveResult(await index.saveManagedReceptionProtocol(input)); },
    async saveMode(input) { return saveResult(await index.saveReceptionMode(input)); },
    async savePostGenerationCheck(input) { return saveResult(await index.saveReceptionPostGenerationCheck(input)); },
    figurePresets: {
      async list() { return structuredClone(await index.listFigurePresets()); },
      async read(id) { return structuredClone(await index.readFigurePreset(id)); },
      async save(input) { return structuredClone(await index.saveFigurePreset(input)); },
    },
  };
}
