import type { FailureCode, FailureCause } from '../../../../dialogue-model/runtime/v2/base-assignment.ts';
import type { ParticipantUsageSnapshot } from '../../../../dialogue-model/runtime/web/participant-usage.ts';
import type { ParticipantRole, ParticipantRoleResult, ParticipantRoleView } from './participant-role.ts';

/** Researcher-only projections. These types are not the persisted reception or protocol schema. */
export type ReceptionStrategy = 'repair-first' | 'bypass-enabled';
export type ReceptionStatus = 'pending' | 'approved' | 'in_progress' | 'finished' | 'cancelled';
export type ReceptionAdminRow = {
  receptionId: string;
  number: string | null;
  createdAt: string;
  status: ReceptionStatus;
  revision: number;
  /** Frozen plan values; a v1 plan reads as relative_pm90 / none. */
  plan: { order: ReceptionStrategy[]; rotationMode: 'relative_pm90' | 'relative_0'; betweenTrials: 'none' | 'questionnaire_required';
    /** Frozen figure set id per trial; plans before the figure bank read as the legacy set. */ figureSets?: string[] } | null;
  trials: { index: number; recordId: string | null; participantRole?: ParticipantRoleView; recordDeleted?: true }[];
  hasUnrecordedProductionAdmission?: true;
};

export type ReceptionFailedStartUsage = {
  receptionId: string;
  failedStarts: { assignmentId: string; trialIndex: number; errorCode: Exclude<FailureCode, 'record_deleted'>; failureCause?: FailureCause;
    usage: ParticipantUsageSnapshot | null }[];
};
export type ReceptionMode = 'on' | 'off' | 'unset';
export type FigureSetPolicy = 'shared' | 'per_trial';
export type ProtocolFigureSelection =
  | { mode: 'preset'; setId: string }
  | { mode: 'seeded_random'; selectionSeed: number | null }
  | { mode: 'custom'; figureIds: readonly string[] };
export type ReceptionProtocolStatus = { configured: false; mode: ReceptionMode } | {
  configured: true;
  mode: ReceptionMode;
  protocolId: string;
  revision: number;
  sha256: string;
  allowedOrders: ReceptionStrategy[][];
  rotationMode: 'relative_pm90' | 'relative_0';
  betweenTrials: 'none' | 'questionnaire_required';
  /** Absent for a protocol saved before the figure bank (v2). */
  figureSelection?: ProtocolFigureSelection;
  figureSetPolicy?: FigureSetPolicy;
};
export type ReceptionAdminError = 'not_found' | 'conflict' | 'invalid_order' | 'protocol_unconfigured' | 'protocol_changed' | 'reception_closed' | 'reception_unavailable';
/** The protocol version shown in the approval form. */
export type DisplayedProtocol = { protocolId: string; revision: number; sha256: string };
export type ReceptionAdminResult = { ok: true } | { ok: false; error: ReceptionAdminError };
export type ReceptionAdminPort = {
  /** No default research values: unsaved is configured:false; unreadable or damaged settings throw. */
  protocol(): Promise<ReceptionProtocolStatus>;
  /** The index supplies pending-first pagination; rendering also groups pending rows within a page. */
  listPage(after: string | null): Promise<{ items: ReceptionAdminRow[]; next: string | null }>;
  /** Read authoritative participant state, rather than trusting an index snapshot for a mutation. */
  get(receptionId: string): Promise<ReceptionAdminRow | null>;
  setParticipantRole?(receptionId: string, role: ParticipantRole, expectedRecordIds: string[] | null): Promise<ParticipantRoleResult>;
  /** Reads metering for failed starts with no archived record, without restoring a participant task. */
  failedStartUsage?(receptionId: string): Promise<ReceptionFailedStartUsage | null>;
  /** The owning DO must CAS revision and pending status, validate the current protocol/order and freeze the plan. */
  approve(receptionId: string, input: { order: number; expectedRevision: number; protocol: DisplayedProtocol }): Promise<ReceptionAdminResult>;
  /** The owning DO must CAS revision and reject cancellation after any trial exists. Never delete trial records. */
  cancel(receptionId: string, input: { expectedRevision: number }): Promise<ReceptionAdminResult>;
  /**
   * Change hint for the live reception list (#159): an opaque version that changes whenever the index rows or
   * the settings change, read from the best-effort index and settings only. With `since` (later pages), it also
   * counts receptions created at or after it that are pending: each pending index candidate is confirmed with its
   * owner (one RPC per candidate). Without this port the list does not update itself.
   */
  version?(since: string | null): Promise<{ version: string; newPending: number | null }>;
};

export type ProtocolFields = { allowedOrders: ReceptionStrategy[][]; seedPolicy: 'shared' | 'per_trial'; referenceMemory: boolean;
  betweenTrials: 'none' | 'questionnaire_required'; receptionNumberFormat: 'daily_seq3'; rotationMode: 'relative_pm90' | 'relative_0';
  figureSelection: ProtocolFigureSelection; figureSetPolicy: FigureSetPolicy };
/** A saved v2 protocol has no figure fields; they are shown as unselected, never filled in. */
export type SavedProtocol = { revision: number; savedAt: string; sha256: string;
  protocol: Omit<ProtocolFields, 'figureSelection' | 'figureSetPolicy'> & Partial<Pick<ProtocolFields, 'figureSelection' | 'figureSetPolicy'>> & { protocolId: string } };
export type SettingsView = {
  protocol: SavedProtocol | null;
  mode: { value: 'unset'; revision: 0 } | { value: 'on' | 'off'; revision: number; savedAt: string };
  protocolHistory: SavedProtocol[];
  modeHistory: { revision: number; value: 'on' | 'off'; savedAt: string; protocolRevision: number | null }[];
};
export type SettingsSaveResult = { ok: true } | { ok: false; error: string };
/** Researcher settings; every save is compare-and-swap on its own revision. */
export type ReceptionSettingsPort = {
  read(): Promise<SettingsView>;
  saveProtocol(input: { expectedRevision: number; fields: ProtocolFields }): Promise<SettingsSaveResult>;
  saveMode(input: { expectedRevision: number; value: 'on' | 'off' }): Promise<SettingsSaveResult>;
};
