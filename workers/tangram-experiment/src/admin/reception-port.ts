/** Researcher-only projections. These types are not the persisted reception or protocol schema. */
export type ReceptionStrategy = 'repair-first' | 'bypass-enabled';
export type ReceptionStatus = 'pending' | 'approved' | 'in_progress' | 'finished' | 'cancelled';
export type ReceptionAdminRow = {
  receptionId: string;
  number: string | null;
  createdAt: string;
  status: ReceptionStatus;
  revision: number;
  plan: { order: ReceptionStrategy[] } | null;
  trials: { index: number; recordId: string | null }[];
};
export type ReceptionProtocolStatus = { configured: false } | {
  configured: true;
  protocolId: string;
  revision: number;
  allowedOrders: ReceptionStrategy[][];
};
export type ReceptionAdminError = 'not_found' | 'conflict' | 'invalid_order' | 'protocol_unconfigured' | 'reception_unavailable';
export type ReceptionAdminResult = { ok: true } | { ok: false; error: ReceptionAdminError };
export type ReceptionAdminPort = {
  /** No default research values: absent or invalid configuration is configured:false. */
  protocol(): Promise<ReceptionProtocolStatus>;
  /** The index supplies pending-first pagination; rendering also groups pending rows within a page. */
  listPage(after: string | null): Promise<{ items: ReceptionAdminRow[]; next: string | null }>;
  /** Read authoritative participant state, rather than trusting an index snapshot for a mutation. */
  get(receptionId: string): Promise<ReceptionAdminRow | null>;
  /** The owning DO must CAS revision and pending status, validate the current protocol/order and freeze the plan. */
  approve(receptionId: string, input: { order: number; expectedRevision: number }): Promise<ReceptionAdminResult>;
  /** The owning DO must CAS revision and reject cancellation after any trial exists. Never delete trial records. */
  cancel(receptionId: string, input: { expectedRevision: number }): Promise<ReceptionAdminResult>;
};
