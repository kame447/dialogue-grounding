import { AsyncLocalStorage } from 'node:async_hooks';
import { NamingTaskError } from '../naming-error.mjs';
import { data } from '../v2/base-assignment-data.ts';
import { PARTICIPANT_PRODUCTION_PROFILE } from './participant-usage-policy.ts';
import { participantChatProvider, type ParticipantModelPin } from '../v2/participant-model-pin.ts';

type Provider = 'jev' | 'luna' | 'terra';
export type ParticipantDispatchResult = { status: number; data: unknown; verifiedUsage?: unknown };
type Dispatch = (payload: unknown, expected: string) => Promise<ParticipantDispatchResult>;
const phases = {
  jev: ['action_target', 'detail', 'human_referent', 'local', 'ai_function', 'ai_support', 'choice'],
  luna: ['generation', 'final_submission', 'ai_extraction', 'dialogue'],
  terra: ['initial_observation', 'reobservation'],
};
const splitPhases = { ...phases, luna: ['ai_extraction', 'dialogue'],
  terra: [...phases.terra, 'generation', 'final_submission'] };
const allTerraPhases = { ...splitPhases, luna: [], terra: [...splitPhases.terra, ...splitPhases.luna] };
const phaseNames = (pin: ParticipantModelPin, provider: Provider): string[] => {
  switch (pin.schemaVersion) {
    case 'participant_model_pin_v1': return phases[provider];
    case 'participant_model_pin_v2': return splitPhases[provider];
    case 'participant_model_pin_v3': return allTerraPhases[provider];
  }
};
const providers: Provider[] = ['jev', 'luna', 'terra'];
const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const amount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const fail = (): never => { throw new NamingTaskError('ai_unavailable'); };

type Meter = {
  calls: number; posts: number; unknownPosts: number; cancelledBeforeSend: number; cacheHits: number;
  knownUsd: number; missingCostPosts: number; inputTokens: number; missingInputTokenPosts: number;
  outputTokens: number; missingOutputTokenPosts: number;
};
const empty = (): Meter => ({ calls: 0, posts: 0, unknownPosts: 0, cancelledBeforeSend: 0, cacheHits: 0,
  knownUsd: 0, missingCostPosts: 0, inputTokens: 0, missingInputTokenPosts: 0, outputTokens: 0, missingOutputTokenPosts: 0 });
type Usage = { costUsd: number | null; inputTokens: number | null; outputTokens: number | null };
type Receipt = Usage & {
  post: number; phase: string; status: 'reserved' | 'cancelled' | 'failed' | 'ok' | 'model_mismatch';
  model: string | null;
};
export type ParticipantUsageSnapshot = {
  schemaVersion: typeof PARTICIPANT_PRODUCTION_PROFILE; assignmentId: string; pin: ParticipantModelPin;
  revision: number; lastHumanSeq: number; halted: boolean;
  modelMismatchPosts?: number;
  phases: Record<Provider, Record<string, Meter>>;
  latest: Record<Provider, Receipt | null>;
  /** Exact returned IDs from identity-checked successful POSTs, by phase. */
  returnedModels?: Record<Provider, Record<string, { model: string; ok: number }>>;
};
export type ParticipantUsageStore = {
  read(): Promise<unknown>;
  update(write: (current: unknown) => ParticipantUsageSnapshot, kind?: 'settle'): Promise<ParticipantUsageSnapshot>;
};
const modelFor = (pin: ParticipantModelPin, provider: Provider) =>
  provider === 'jev' ? pin.jevModelId : provider === 'terra' ? pin.terraModelId
    : pin.schemaVersion === 'participant_model_pin_v3' ? null : pin.lunaModelId;
function initial(assignmentId: string, pin: ParticipantModelPin): ParticipantUsageSnapshot {
  return { schemaVersion: PARTICIPANT_PRODUCTION_PROFILE, assignmentId, pin: structuredClone(pin),
    revision: 0, lastHumanSeq: 0, halted: false,
    phases: {
      jev: Object.fromEntries(phases.jev.map(phase => [phase, empty()])),
      luna: Object.fromEntries(phaseNames(pin, 'luna').map(phase => [phase, empty()])),
      terra: Object.fromEntries(phaseNames(pin, 'terra').map(phase => [phase, empty()])),
    }, latest: { jev: null, luna: null, terra: null },
    returnedModels: { jev: {}, luna: {}, terra: {} } };
}
function read(value: unknown, assignmentId: string, pin: ParticipantModelPin): ParticipantUsageSnapshot {
  const template = initial(assignmentId, pin);
  const hasReturnedModels = value !== null && typeof value === 'object' && Object.hasOwn(value, 'returnedModels');
  const keys = Object.keys(template).filter(key => hasReturnedModels || key !== 'returnedModels');
  const hasMismatchCount = value !== null && typeof value === 'object' && Object.hasOwn(value, 'modelMismatchPosts');
  const saved = data(value, hasMismatchCount ? [...keys, 'modelMismatchPosts'] : keys);
  const savedPin = data(saved.pin, Object.keys(pin));
  if (saved.schemaVersion !== template.schemaVersion || saved.assignmentId !== assignmentId ||
      Object.entries(pin).some(([key, model]) => savedPin[key] !== model) ||
      !count(saved.revision) || !count(saved.lastHumanSeq) || typeof saved.halted !== 'boolean') return fail();
  const savedPhases = data(saved.phases, providers), latest = data(saved.latest, providers);
  const returnedModels = hasReturnedModels ? data(saved.returnedModels, providers) : null;
  let maximumMismatches = 0;
  for (const provider of providers) {
    const names = phaseNames(pin, provider);
    const group = data(savedPhases[provider], names);
    const returned = returnedModels ? data(returnedModels[provider]) : null;
    if (returned && Object.keys(returned).some(phase => !names.includes(phase))) return fail();
    let posts = 0;
    for (const phase of names) {
      const meter = data(group[phase], Object.keys(empty()));
      if (Object.entries(meter).some(([key, n]) => key === 'knownUsd' ? !amount(n) : !count(n))) return fail();
      const m = meter as Meter;
      maximumMismatches += m.unknownPosts;
      if (m.cancelledBeforeSend + m.unknownPosts > m.posts || m.missingCostPosts > m.posts - m.cancelledBeforeSend ||
          m.missingInputTokenPosts > m.posts - m.cancelledBeforeSend || m.missingOutputTokenPosts > m.posts - m.cancelledBeforeSend) return fail();
      if (returned && Object.hasOwn(returned, phase)) {
        const { model, ok } = data(returned[phase], ['model', 'ok']);
        if (model !== modelFor(pin, provider) || !count(ok) || ok === 0 ||
            ok > m.posts - m.cancelledBeforeSend - m.unknownPosts) return fail();
      }
      posts += m.posts;
    }
    if (!posts && latest[provider] === null) continue;
    const r = data(latest[provider], ['post', 'phase', 'status', 'model', 'costUsd', 'inputTokens', 'outputTokens']);
    if (r.post !== posts || !names.includes(r.phase as string) ||
        !['reserved', 'cancelled', 'failed', 'ok', 'model_mismatch'].includes(r.status as string) ||
        (returned && r.status === 'ok' && !Object.hasOwn(returned, r.phase as string)) ||
        (r.status === 'ok' ? r.model !== modelFor(pin, provider) :
          r.model !== null && (r.status !== 'failed' || r.model !== modelFor(pin, provider))) ||
        (r.model === null && [r.costUsd, r.inputTokens, r.outputTokens].some(n => n !== null)) ||
        !(r.costUsd === null || amount(r.costUsd)) || !(r.inputTokens === null || count(r.inputTokens)) ||
        !(r.outputTokens === null || count(r.outputTokens))) return fail();
  }
  if (hasMismatchCount && (!count(saved.modelMismatchPosts) || saved.modelMismatchPosts === 0 || saved.modelMismatchPosts > maximumMismatches)) return fail();
  return structuredClone(saved) as ParticipantUsageSnapshot;
}
const sequence = (id: string | undefined) => Number(id?.match(/^event-(\d+)$/u)?.[1] ?? 0);
type Context = { humanSeq: number; phase?: string; signal?: AbortSignal };

/** Reserves each potentially billable POST durably and accounts it independently of turn completion. */
export class ParticipantUsageLedger {
  private readonly store: ParticipantUsageStore;
  private readonly scope = new AsyncLocalStorage<Context>();
  private current: ParticipantUsageSnapshot;

  private constructor(store: ParticipantUsageStore, persisted: ParticipantUsageSnapshot) {
    this.store = store;
    this.current = persisted;
  }

  static readSnapshot(value: unknown, assignmentId: string, pin: ParticipantModelPin) {
    return read(value, assignmentId, pin);
  }

  static async open(store: ParticipantUsageStore, assignmentId: string, pin: ParticipantModelPin, restored?: unknown,
    resumeAdmission = false) {
    const saved = await store.read();
    if (saved === undefined) {
      if (restored !== undefined) return fail();
      const created = await store.update(current => current === undefined ? initial(assignmentId, pin) : fail());
      return new ParticipantUsageLedger(store, created);
    }
    if (restored === undefined) {
      if (!resumeAdmission) return fail();
      return new ParticipantUsageLedger(store, read(saved, assignmentId, pin));
    }
    const durable = read(saved, assignmentId, pin), archived = read(restored, assignmentId, pin);
    if (Boolean(durable.returnedModels) !== Boolean(archived.returnedModels) ||
        durable.revision < archived.revision || (durable.revision === archived.revision &&
        JSON.stringify(durable) !== JSON.stringify(archived))) return fail();
    return new ParticipantUsageLedger(store, durable);
  }

  get halted() { return this.current.halted; }
  snapshot() { return structuredClone(this.current); }
  async resumeAfterModelMismatch() {
    // A late response can settle through an older ledger after this one opened.
    // Read the durable halt inside the same update that clears it.
    await this.change(state => {
      if (!state.halted) return;
      // Older snapshots had only the halt flag and the latest provider receipts.
      state.modelMismatchPosts ??= Math.max(1, Object.values(state.latest).filter(receipt => receipt?.status === 'model_mismatch').length);
      state.halted = false;
    });
  }
  runTurn<T>(eventId: string, signal: AbortSignal, operation: () => Promise<T>) {
    return this.scope.run({ humanSeq: sequence(eventId), signal }, operation);
  }

  runPhase<T>(phase: string, operation: () => Promise<T>) {
    return this.scope.run({ humanSeq: 0, ...this.scope.getStore(), phase }, operation);
  }

  private async change(write: (state: ParticipantUsageSnapshot) => void, kind?: 'settle') {
    const { pin, assignmentId } = this.current;
    const state = await this.store.update(raw => {
      const current = read(raw, assignmentId, pin);
      write(current);
      current.revision++;
      return current;
    }, kind);
    if (state.revision >= this.current.revision) this.current = state;
  }

  chatProvider(phase: string) {
    return participantChatProvider(this.current.pin, phase);
  }

  async logical<T>(provider: 'luna' | 'terra', phase: string, operation: () => Promise<T>) {
    if (!phaseNames(this.current.pin, provider).includes(phase)) return fail();
    await this.change(state => {
      if (state.halted) return fail();
      state.phases[provider][phase].calls++;
    });
    return this.runPhase(phase, operation);
  }

  async cacheHit() {
    await this.change(state => { state.phases.terra.initial_observation.cacheHits++; });
  }

  async dispatch(provider: Provider, invoke: Dispatch, payload: unknown, signal?: AbortSignal | null) {
    const context = this.scope.getStore();
    const phase = context?.phase && phaseNames(this.current.pin, provider).includes(context.phase) ? context.phase
      : provider === 'jev' ? choicePhase(payload) : provider === 'luna' ? 'dialogue' : 'initial_observation';
    const signals = [signal, context?.signal].filter((value): value is AbortSignal => Boolean(value));
    const active = AbortSignal.any(signals);
    const expected = modelFor(this.current.pin, provider);
    if (expected === null) return fail();
    let post = 0;
    active.throwIfAborted();
    await this.change(state => {
      if (state.halted) return fail();
      const stats = state.phases[provider][phase];
      if (provider === 'jev') stats.calls++;
      post = (state.latest[provider]?.post ?? 0) + 1;
      stats.posts++;
      stats.unknownPosts++;
      stats.missingCostPosts++;
      stats.missingInputTokenPosts++;
      stats.missingOutputTokenPosts++;
      if (context) state.lastHumanSeq = Math.max(state.lastHumanSeq, context.humanSeq);
      state.latest[provider] = { post, phase, status: 'reserved', model: null, costUsd: null, inputTokens: null, outputTokens: null };
    });
    const finish = (status: Receipt['status'], measured: Usage | null = null, returnedModel?: string) => this.change(state => {
      const m = state.phases[provider][phase];
      const receipt: Receipt = { post, phase, status, model: measured ? expected : null,
        costUsd: measured?.costUsd ?? null, inputTokens: measured?.inputTokens ?? null, outputTokens: measured?.outputTokens ?? null };
      if (measured || status === 'cancelled') m.unknownPosts--;
      if (status === 'cancelled') m.cancelledBeforeSend++;
      if (receipt.costUsd !== null || status === 'cancelled') { m.missingCostPosts--; m.knownUsd += receipt.costUsd ?? 0; }
      if (receipt.inputTokens !== null || status === 'cancelled') { m.missingInputTokenPosts--; m.inputTokens += receipt.inputTokens ?? 0; }
      if (receipt.outputTokens !== null || status === 'cancelled') { m.missingOutputTokenPosts--; m.outputTokens += receipt.outputTokens ?? 0; }
      if (status === 'model_mismatch') {
        state.modelMismatchPosts = (state.modelMismatchPosts ?? Number(state.halted)) + 1;
        state.halted = true;
      }
      if (returnedModel !== undefined && state.returnedModels) {
        const returned = state.returnedModels[provider];
        returned[phase] = { model: returnedModel, ok: (returned[phase]?.ok ?? 0) + 1 };
      }
      if (state.latest[provider]?.post === post) state.latest[provider] = receipt;
    }, 'settle');
    if (active.aborted) { await finish('cancelled'); active.throwIfAborted(); }
    let response;
    try { response = await invoke(payload, expected); }
    catch (error) { await finish('failed'); throw error; }
    const raw = response.data as { error?: unknown; model?: unknown;
      usage?: { cost?: unknown; prompt_tokens?: unknown; completion_tokens?: unknown } } | null;
    const returnedModel = raw?.model;
    if (response.status === 200 && returnedModel === expected && raw?.error !== 'model_mismatch') {
      await finish('ok', {
        costUsd: amount(raw?.usage?.cost) ? raw.usage.cost : null,
        inputTokens: count(raw?.usage?.prompt_tokens) ? raw.usage.prompt_tokens : null,
        outputTokens: count(raw?.usage?.completion_tokens) ? raw.usage.completion_tokens : null,
      }, returnedModel);
    } else if (raw?.error === 'model_mismatch' || response.status === 200) {
      await finish('model_mismatch');
      return fail();
    } else {
      // No metering body is trusted from an HTTP error. Only the private RPC can
      // report identity-verified usage for a successfully received but rejected answer.
      await finish('failed', response.status === 422 || response.status === 502 ? rejectedUsage(response.verifiedUsage, expected) : null);
    }
    return response;
  }
}

function rejectedUsage(raw: unknown, expected: string): Usage | null {
  if (raw === undefined) return null;
  try {
    const { model, costUsd, inputTokens, outputTokens } = data(structuredClone(raw), ['model', 'costUsd', 'inputTokens', 'outputTokens']);
    if (model !== expected || (costUsd !== null && !amount(costUsd)) ||
        (inputTokens !== null && !count(inputTokens)) || (outputTokens !== null && !count(outputTokens))) return null;
    return { costUsd, inputTokens, outputTokens } as Usage;
  } catch { return null; }
}

function choicePhase(payload: unknown): string {
  const keys = Object.keys((payload as { questions?: object })?.questions ?? {});
  if (keys.includes('human_referent')) return 'human_referent';
  if (keys.includes('action')) return 'action_target';
  if (keys.some(key => key.endsWith('_support'))) return 'ai_support';
  if (keys.some(key => ['name', 'feature', 'observation', 'discriminating_feature', 'aspect', 'shared_construal', 'observe_targets'].includes(key))) return 'detail';
  return 'choice';
}
