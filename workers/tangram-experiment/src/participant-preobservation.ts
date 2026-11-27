import { ObservationError } from '../../../dialogue-model/runtime/observation/observe.ts';
import type { ObservationInput } from '../../../dialogue-model/runtime/observation/contract.ts';
import type { InitialObservationGeneration } from '../../../dialogue-model/runtime/observation/initial-observation-generation.ts';
import type { WorkerTerraCache } from '../../../dialogue-model/runtime/observation/worker-terra-observer.ts';
import type { ParticipantModelPin } from '../../../dialogue-model/runtime/v2/participant-model-pin.ts';
import { ParticipantUsageLedger } from '../../../dialogue-model/runtime/web/participant-usage.ts';
import type { ParticipantUsageSnapshot, ParticipantUsageStore } from '../../../dialogue-model/runtime/web/participant-usage.ts';
import { createParticipantTerraObserver } from './participant-runtime.ts';
import type { ParticipantService } from './participant-runtime.ts';

const PREFIX = 'terra-preobservation:v1:';
type Board = { key: string; own: ObservationInput; trialIndices: number[] };
type Policy = { pin: ParticipantModelPin; proxy: ParticipantService; initialObservationGeneration?: InitialObservationGeneration };
type StoreReader = { get<T>(key: string): Promise<T | undefined> };
type StoreTransaction = StoreReader & {
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  put(entries: Record<string, unknown>): Promise<void>;
};
type Store = StoreReader & { transaction<T>(update: (tx: StoreTransaction) => Promise<T>): Promise<T> };
type Receipt = {
  trialIndices: number[];
  startedAt: string;
  finishedAt: string | null;
  status: 'preparing' | 'ready' | 'failed';
  errorCode: ObservationError['code'] | null;
  usage?: ParticipantUsageSnapshot;
};
export type PreobservationUsage = Omit<Receipt, 'status' | 'usage'> & {
  status: Receipt['status'] | 'unconfirmed';
  usage: Omit<ParticipantUsageSnapshot, 'assignmentId'> | null;
};

// A start joins only work owned by this live DO. After a reset it reads the durable cache directly.
export class ParticipantPreobservations {
  private readonly storage: Store;
  private readonly flights = new Map<string, Promise<void>>();
  private readonly cache: WorkerTerraCache;

  constructor(storage: Store) {
    this.storage = storage;
    this.cache = {
      read: key => storage.get(key),
      putIfAbsent: (key, entry) => storage.transaction(async tx => {
        const found = await tx.get(key);
        if (found !== undefined) return found;
        await tx.put({ [key]: entry });
        return entry;
      }),
    };
  }

  async readUsage(tx: StoreTransaction, pin: ParticipantModelPin): Promise<PreobservationUsage[]> {
    const receipts = await tx.list<Receipt>({ prefix: PREFIX });
    return Array.from(receipts, ([key, { trialIndices, startedAt, finishedAt, status, errorCode, usage }]) => {
      const reportedStatus: PreobservationUsage['status'] =
        status === 'preparing' && !this.flights.has(key.slice(PREFIX.length)) ? 'unconfirmed' : status;
      const summary = { trialIndices, startedAt, finishedAt, status: reportedStatus, errorCode };
      if (!usage) return { ...summary, usage: null };
      const { assignmentId: _jobKey, ...metering } = ParticipantUsageLedger.readSnapshot(usage, key, pin);
      return { ...summary, usage: metering };
    });
  }

  readonly startCache: WorkerTerraCache = {
    read: async (key, signal) => {
      const flight = this.flights.get(key);
      const hit = await this.cache.read(key);
      if (hit != null || !flight) return hit;
      if (signal) {
        if (signal.aborted) throw new ObservationError('aborted');
        let abort = () => {};
        const cancelled = new Promise<never>((_resolve, reject) => {
          abort = () => reject(new ObservationError('aborted'));
          signal.addEventListener('abort', abort, { once: true });
        });
        try { await Promise.race([flight, cancelled]); }
        finally { signal.removeEventListener('abort', abort); }
      } else {
        await flight;
      }
      return this.cache.read(key);
    },
    putIfAbsent: (key, entry) => this.cache.putIfAbsent(key, entry),
  };

  schedule(board: Board, policy: Policy): Promise<void> {
    const active = this.flights.get(board.key);
    if (active) return active;
    const flight = this.observe(board, policy)
      .catch(() => { /* A storage failure also leaves start free to use its regular cache path. */ })
      .finally(() => { this.flights.delete(board.key); });
    this.flights.set(board.key, flight);
    return flight;
  }

  private async observe(board: Board, policy: Policy): Promise<void> {
    const receiptKey = PREFIX + board.key;
    const registered = await this.storage.transaction(async tx => {
      if (await tx.get(receiptKey) !== undefined) return false;
      const receipt: Receipt = { trialIndices: board.trialIndices, startedAt: new Date().toISOString(),
        finishedAt: null, status: 'preparing', errorCode: null };
      await tx.put({ [receiptKey]: receipt });
      return true;
    });
    if (!registered) return;
    const store: ParticipantUsageStore = {
      read: async () => (await this.storage.get<Receipt>(receiptKey))?.usage,
      update: write => this.storage.transaction(async tx => {
        const receipt = await tx.get<Receipt>(receiptKey);
        if (!receipt) throw new ObservationError('unavailable');
        const usage = write(receipt.usage);
        await tx.put({ [receiptKey]: { ...receipt, usage } });
        return usage;
      }),
    };
    let errorCode: Receipt['errorCode'] = null;
    try {
      const usage = await ParticipantUsageLedger.open(store, receiptKey, policy.pin);
      const observer = createParticipantTerraObserver({ ...policy, own: board.own, cache: this.cache, usage });
      await observer.observeAll(board.own);
    } catch (error) {
      errorCode = error instanceof ObservationError ? error.code : 'unavailable';
    }
    await this.storage.transaction(async tx => {
      const receipt = await tx.get<Receipt>(receiptKey);
      if (receipt) await tx.put({ [receiptKey]: { ...receipt, finishedAt: new Date().toISOString(),
        status: errorCode === null ? 'ready' : 'failed', errorCode } });
    });
  }
}
