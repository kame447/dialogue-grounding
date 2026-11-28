import { DurableObject } from "cloudflare:workers";
import { PreparedObservationCoordinator } from "../prepared-observation-coordinator.ts";
import type { ParticipantConfigurationEnv } from "../participant-configuration.ts";
import type { PreparedClaimRequest } from "../prepared-observation-pool.ts";
import type { AdminSummary } from "./summary";
import { getSummary, listAudit, listPage, PARTICIPANT_ROLE_REVISION, recordHash, recordRoles, removeSummaries, setParticipantRole, upsertSummary } from "./index-store.ts";
import type { AuditEntry, DeletionReason } from "./index-store.ts";
import { OBJECT_ID, RECORD_ID } from "./summary.ts";
import { formatReceptionNumber, receptionNumberDay } from '../../../../dialogue-model/runtime/v2/reception.ts';
import type { ReceptionSummary } from '../../../../dialogue-model/runtime/v2/reception.ts';
import { modeHistory, protocolHistory, readSettings, saveMode, savePostGenerationCheck, saveProtocol, saveProtocolFromForm } from './reception-settings.ts';
import type { ModeEntry, ProtocolEntry, ReceptionSettings, SaveResult } from './reception-settings.ts';
import { listFigurePresets, readFigurePreset, saveFigurePreset } from './figure-presets.ts';
import type { FigurePresetMutation } from './figure-presets.ts';
import type { ProtocolFormInput } from './reception-port.ts';

/**
 * One global, researcher-only index of trial summaries keyed by recordId
 * (allowlisted, no PII). Entries are removed only together with their record;
 * see index-store.ts for the storage layout and the audit log.
 */
export class AdminIndex extends DurableObject<ParticipantConfigurationEnv> {
  private readonly observations = new PreparedObservationCoordinator({
    storage: this.ctx.storage, env: this.env,
    readSettings: tx => tx ? readSettings(tx) : this.readReceptionSettings(),
    setAlarm: time => this.ctx.storage.setAlarm(time),
  });
  async preparedObservationStatus() { return this.observations.status(); }
  async prepareObservations(input: { expectedProtocolRevision: number }) { return this.observations.prepare(input); }
  async claimPreparedObservations(input: PreparedClaimRequest) { return this.observations.claim(input); }
  async alarm() { await this.observations.alarm(); }
  /** Researcher reception settings: one consistent snapshot of protocol and mode (see reception-settings.ts). */
  async readReceptionSettings(): Promise<ReceptionSettings> { return this.ctx.storage.transaction(tx => readSettings(tx)); }
  async saveReceptionProtocol(input: { expectedRevision: unknown; fields: unknown }): Promise<SaveResult> {
    const result = await this.ctx.storage.transaction(tx => saveProtocol(tx, input, Date.now(), () => crypto.randomUUID()));
    if (result.ok) await this.observations.prepare({ expectedProtocolRevision: result.revision });
    return result;
  }
  async saveManagedReceptionProtocol(input: ProtocolFormInput): Promise<SaveResult> {
    const result = await this.ctx.storage.transaction(tx => saveProtocolFromForm(tx, input, Date.now(), () => crypto.randomUUID()));
    if (result.ok) await this.observations.prepare({ expectedProtocolRevision: result.revision });
    return result;
  }
  async listFigurePresets() { return listFigurePresets(this.ctx.storage); }
  async readFigurePreset(id: string) { return readFigurePreset(this.ctx.storage, id); }
  async saveFigurePreset(input: FigurePresetMutation) {
    return this.ctx.storage.transaction(tx => saveFigurePreset(tx, input, () => crypto.randomUUID()));
  }
  async saveReceptionMode(input: { expectedRevision: unknown; value: unknown }): Promise<SaveResult> {
    const result = await this.ctx.storage.transaction(tx => saveMode(tx, input, Date.now()));
    if (result.ok && input.value === 'on') {
      const settings = await this.readReceptionSettings();
      if (settings.protocol) await this.observations.prepare({ expectedProtocolRevision: settings.protocol.revision });
    }
    return result;
  }
  async saveReceptionPostGenerationCheck(input: { expectedRevision: unknown; value: unknown }): Promise<SaveResult> {
    return this.ctx.storage.transaction(tx => savePostGenerationCheck(tx, input, Date.now()));
  }
  async receptionProtocolHistory(): Promise<ProtocolEntry[]> { return protocolHistory(this.ctx.storage); }
  async receptionModeHistory(): Promise<ModeEntry[]> { return modeHistory(this.ctx.storage); }
  async upsertReception(summary: ReceptionSummary): Promise<boolean> {
    return this.ctx.storage.transaction(async tx => {
      const key = 'reception:' + summary.receptionId, old = await tx.get<ReceptionSummary>(key);
      if (old && old.revision >= summary.revision) return false;
      await tx.put({ [key]: summary }); return true;
    });
  }
  async getReception(id: string): Promise<ReceptionSummary | null> { return await this.ctx.storage.get<ReceptionSummary>('reception:' + id) ?? null; }
  async listReceptions(): Promise<ReceptionSummary[]> {
    const rows = await this.ctx.storage.list<ReceptionSummary>({ prefix:'reception:' });
    return [...rows].filter(([key]) => /^reception:[a-f0-9-]{36}$/u.test(key)).map(([, row]) => row)
      .sort((a,b) => Number(b.status === 'pending') - Number(a.status === 'pending') || b.createdAt.localeCompare(a.createdAt) || a.receptionId.localeCompare(b.receptionId));
  }
  async allocateReceptionNumber(format: string, now: number): Promise<string | null> {
    const day = receptionNumberDay(format, now), key = 'reception:number:' + format + ':' + day;
    return this.ctx.storage.transaction(async tx => {
      const previous = await tx.get<number>(key) ?? 0;
      const next = previous + 1, number = formatReceptionNumber(format,next);
      if (number !== null) await tx.put({ [key]: next });
      return number;
    });
  }
  async upsert(summary: AdminSummary): Promise<boolean> {
    return this.ctx.storage.transaction(tx => upsertSummary(tx, summary));
  }
  async get(recordId: string): Promise<AdminSummary | null> { return getSummary(this.ctx.storage, recordId); }
  async page(after: string | null): Promise<{ items: AdminSummary[]; next: string | null }> { return listPage(this.ctx.storage, after); }
  async recordRoles(recordIds: string[], includeDeleted = false) { return recordRoles(this.ctx.storage, recordIds, includeDeleted); }
  async participantRoleRevision(): Promise<string | null> { return await this.ctx.storage.get<string>(PARTICIPANT_ROLE_REVISION) ?? null; }
  async setParticipantRole(recordIds: string[], objectId: string, role: unknown): Promise<boolean> {
    if (!Array.isArray(recordIds) || !OBJECT_ID.test(objectId) ||
        recordIds.some(id => typeof id !== "string" || !RECORD_ID.test(id))) return false;
    const targets = await Promise.all(recordIds.map(async recordId => ({ recordId, hash: await recordHash(recordId) })));
    const at = new Date().toISOString(), revision = crypto.randomUUID();
    return this.ctx.storage.transaction(tx => setParticipantRole(tx, targets, objectId, role, at, revision));
  }
  async remove(recordIds: string[], reason: DeletionReason): Promise<number> {
    return this.ctx.storage.transaction(tx => removeSummaries(tx, recordIds, reason, Date.now()));
  }
  async audit(): Promise<AuditEntry[]> { return listAudit(this.ctx.storage); }
}
