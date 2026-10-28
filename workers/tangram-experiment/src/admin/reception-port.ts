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
  plan: { order: ReceptionStrategy[]; rotationMode: 'relative_pm90' | 'relative_0'; betweenTrials: 'none' | 'questionnaire_required' } | null;
  trials: { index: number; recordId: string | null }[];
};
export type ReceptionMode = 'on' | 'off' | 'unset';
export type ReceptionProtocolStatus = { configured: false; mode: ReceptionMode } | {
  configured: true;
  mode: ReceptionMode;
  protocolId: string;
  revision: number;
  sha256: string;
  allowedOrders: ReceptionStrategy[][];
  rotationMode: 'relative_pm90' | 'relative_0';
  betweenTrials: 'none' | 'questionnaire_required';
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
  /** The owning DO must CAS revision and pending status, validate the current protocol/order and freeze the plan. */
  approve(receptionId: string, input: { order: number; expectedRevision: number; protocol: DisplayedProtocol }): Promise<ReceptionAdminResult>;
  /** The owning DO must CAS revision and reject cancellation after any trial exists. Never delete trial records. */
  cancel(receptionId: string, input: { expectedRevision: number }): Promise<ReceptionAdminResult>;
  /**
   * Change hint for the live reception list (#159): an opaque version that changes whenever the index rows or
   * the settings change, and, with `since`, how many indexed receptions created at or after it are pending.
   * Read from the best-effort index only, without any owner RPC. Without it the list does not update itself.
   */
  version?(since: string | null): Promise<{ version: string; newPending: number | null }>;
};

export type ProtocolFields = { allowedOrders: ReceptionStrategy[][]; seedPolicy: 'shared' | 'per_trial'; referenceMemory: boolean;
  betweenTrials: 'none' | 'questionnaire_required'; receptionNumberFormat: 'daily_seq3'; rotationMode: 'relative_pm90' | 'relative_0' };
export type SavedProtocol = { revision: number; savedAt: string; sha256: string; protocol: ProtocolFields & { protocolId: string } };
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
