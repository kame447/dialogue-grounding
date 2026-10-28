/** Participant assignment API. Researcher values only; never an allocation method. */
import type { ReceptionPlan, ReceptionPlanV1, ReceptionPlanV2, RotationMode } from './reception.ts';
export { BaseAssignmentError, validateBaseAssignmentConfig, validateBaseStart,
  canonicalBaseAssignmentConfig, validateBoundBaseRecord, assignmentRotationMode } from './base-assignment-data.ts';
export type Strategy = 'repair-first' | 'bypass-enabled';
export type SourceAdapter = 'local_private_file' | 'worker_binding';
export type BaseAssignmentConfig = Readonly<{ schemaVersion: 'base_assignment_config_v1'; configId: string;
  revision: number; strategy: Strategy; seed: number; referenceMemory: boolean }>;
export type BaseAssignment = Readonly<{ schemaVersion: 'base_assignment_v1'; assignmentId: string;
  strategy: Strategy; seed: number; referenceMemory: boolean;
  source: Readonly<{ kind: 'server_config_v1'; adapter: SourceAdapter; configId: string; revision: number; configSha256: string }> |
    Readonly<{ kind: 'reception_plan_v1'; adapter: SourceAdapter; receptionId: string; protocolId: string; protocolRevision: number;
      protocolSha256: string; trialIndex: number; plan: ReceptionPlanV1 }> |
    Readonly<{ kind: 'reception_plan_v2'; adapter: SourceAdapter; receptionId: string; protocolId: string; protocolRevision: number;
      protocolSha256: string; trialIndex: number; plan: ReceptionPlanV2 }>;
  createdAt: string }>;
/** Minimum coordinator projection; the existing task owns its complete snapshot. */
export type RawBaseRecord = { recordId: string; version: 2; seed: number; strategy: Strategy;
  options: { referenceMemory: boolean; [key: string]: unknown }; status: 'dialogue' | 'submitting' | 'completed';
  queueState: { pendingHumanEventIds: string[]; errorCode: string | null; [key: string]: unknown }; [key: string]: unknown };
export type BaseRecord = RawBaseRecord & { assignment: BaseAssignment };
export type FailureCode = 'start_interrupted' | 'initialization_failed' | 'record_write_failed' | 'assignment_record_invalid' | 'record_deleted';
export type BaseAssignedEnvelope = { schemaVersion: 'base_assigned_session_v1'; assignment: BaseAssignment;
  status: 'preparing' | 'active' | 'failed'; record: BaseRecord | null; errorCode: FailureCode | null };
export type AdmissionKey = 'initial' | `after:${string}`;
export type BaseOwnerState = { schemaVersion: 'base_owner_v1'; ownerId: string; revision: number;
  activeKey: AdmissionKey | null; admissions: Partial<Record<AdmissionKey, BaseAssignedEnvelope>> };
export type OwnerRead = { kind: 'state'; state: BaseOwnerState } | { kind: 'legacy_active' } | { kind: 'expired' };
export type BaseArchiveWrite = { assignmentId: string; record: BaseRecord };
export type BaseStore = { read(): Promise<OwnerRead>;
  compareAndSwap(expectedRevision: number, next: BaseOwnerState, archives: readonly BaseArchiveWrite[]): Promise<boolean>;
  readRecord(recordId: string): Promise<BaseRecord | null> };
export type BaseTask = { getState(): Record<string, unknown>; persistNow(): Promise<void>; whenIdle(): Promise<void>;
  message(text: string, clientId?: string): { eventId: string; duplicate: boolean }; retry(): Promise<void>;
  submitHuman(options: { names: unknown }): Promise<unknown>; submitAI(): Promise<unknown> };
/** rotationMode is present for new tasks only; a restored task takes its mode from the record. */
export type MakeBaseTask = (options: { strategy: Strategy; seed: number; referenceMemory: boolean; runDir: null;
  restore: BaseRecord | null; now: () => number; onPersist: (record: RawBaseRecord) => Promise<void>; rotationMode?: RotationMode }) => Promise<BaseTask>;
export type BaseSessionOptions = { ownerId: string; store: BaseStore; readConfig: () => Promise<BaseAssignmentConfig | null>;
  /** null explicitly declines a plan, so the configured (non-reception) assignment is used. */
  readPlan?: () => Promise<{ receptionId: string; plan: ReceptionPlan; trialIndex: number } | null>;
  makeTask: MakeBaseTask; newId: () => string; now: () => number; adapter: SourceAdapter };
export type StartResult = { kind: 'started' | 'completed'; task: BaseTask };
export type RestoreResult = { kind: 'empty'; task: null } | { kind: 'restored'; task: BaseTask };
export type NextResult = { kind: 'created' | 'existing'; recordId: string; participantPath: '/' };
export type BaseSession = { start(body: unknown): Promise<StartResult>; restore(): Promise<RestoreResult>;
  prepareNext(completedRecordId: string): Promise<NextResult> };
export type BaseSessionErrorCode = 'invalid_request' | 'busy' | 'not_found' | 'trial_unavailable' | 'owner_expired';
export type BaseLocalContainer = { schemaVersion: 'base_local_owner_v1'; owner: BaseOwnerState;
  archives: Record<string, BaseRecord>; questionnaires: Record<string, unknown>; ledger: Record<string, number>;
  tombstones: string[]; lastAccessMs: number };
export type BaseFileStore = BaseStore & { close(): Promise<void> };
