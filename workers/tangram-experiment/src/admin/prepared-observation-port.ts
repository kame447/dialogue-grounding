/** Researcher-only preparation counts; never includes memo contents or cache keys. */
export type PreparedObservationPoolStatus = {
  supported: boolean;
  protocolRevision: number | null;
  targetPerOrder: number;
  orders: Array<{
    orderIndex: number;
    order: string[];
    ready: number;
    queued: number;
    preparing: number;
    failed: number;
  }>;
  errorCode: string | null;
};
