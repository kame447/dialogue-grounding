import { responseText } from '../client.mjs';
import {
  createLunaObserver, ObservationError, OBSERVATION_INITIAL_INSTRUCTIONS,
  OBSERVATION_MEMO_VERSION, snapshotObservationInput, validateObservationMemo,
} from './observe.ts';
import type { ObservationMessage } from './observe.ts';
import type { ObservationInput, ObservationMemo, ObservationObserver, ObservationOptions } from './contract.ts';
import { INITIAL_OBSERVATION_STRUCTURED_V2, INITIAL_OBSERVATION_V2_INSTRUCTIONS,
  type InitialObservationGeneration } from './initial-observation-generation.ts';
import { requireExactParticipantModel, validateParticipantModelPin } from '../v2/participant-model-pin.ts';
import type { ParticipantModelPin } from '../v2/participant-model-pin.ts';
import type { ResearchLimits } from '../v2/research-timeouts.ts';

type VisualRequest = { purpose: 'visual_observation'; messages: ObservationMessage[];
  initial_observation_generation?: InitialObservationGeneration };
// This port accepts the private service's response before any client-side model fallback.
type VisualPort = (request: VisualRequest, signal: AbortSignal) => Promise<{ status: number; data: unknown }>;
type CacheEntry = {
  schemaVersion: 'terra_initial_observation_v1';
  key: string;
  modelId: string;
  memo: ObservationMemo;
  memoSha256: string;
};
export type WorkerTerraCache = {
  read(key: string, signal?: AbortSignal): Promise<unknown>;
  /** Atomically insert on absence and return the stored winner. Never overwrite. */
  putIfAbsent(key: string, entry: CacheEntry): Promise<unknown>;
};

const SCHEMA = 'terra_initial_observation_v1';
const encoder = new TextEncoder();
async function sha256(text: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}

function ownProjection(input: ObservationInput) {
  const own = snapshotObservationInput(input);
  return {
    ownImage: own.ownImage,
    ownAnchors: [...own.ownAnchors].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      .map(({ id, bbox: { x, y, w, h }, centroid }) => ({ id, bbox: { x, y, w, h }, centroid })),
  };
}

function initialKey(terraModelId: string, boundJson: string, generation?: InitialObservationGeneration) {
  const instructions = generation === INITIAL_OBSERVATION_STRUCTURED_V2
    ? INITIAL_OBSERVATION_V2_INSTRUCTIONS : OBSERVATION_INITIAL_INSTRUCTIONS;
  const fields = [SCHEMA, terraModelId, OBSERVATION_MEMO_VERSION, instructions, boundJson];
  if (generation) fields.push(generation);
  return sha256(JSON.stringify(fields)).then(digest => SCHEMA + ':' + digest);
}

export function workerTerraInitialKey(pin: ParticipantModelPin, own: ObservationInput, generation?: InitialObservationGeneration) {
  return initialKey(validateParticipantModelPin(pin).terraModelId, JSON.stringify(ownProjection(own)), generation);
}

function checkAbort(options?: ObservationOptions): void {
  if (options?.signal?.aborted) throw new ObservationError('aborted');
}

function object(value: unknown): Record<string, unknown> | null {
  return value && Object.getPrototypeOf(value) === Object.prototype ? value as Record<string, unknown> : null;
}

function providerText(raw: unknown, modelId: string, generation?: InitialObservationGeneration): string {
  const data = object(raw);
  try { requireExactParticipantModel(modelId, data?.model); }
  catch { throw new ObservationError('invalid_response'); }
  const first = Array.isArray(data?.choices) ? object(data.choices[0]) : null;
  if (generation && (data?.initial_observation_generation !== generation || first?.finish_reason !== 'stop')) {
    throw new ObservationError('invalid_response');
  }
  const text = responseText(object(first?.message)?.content);
  if (!text.trim()) throw new ObservationError('invalid_response');
  return text;
}

/** Bind both observation phases to one AI-side projection and one exact Terra
 * ID. The runtime supplies the validated issue and current memo for reobservation.
 * Only initial observations are shared through the private cache.
 */
export function createWorkerTerraObserver({ modelPin, own, visual, cache, timeoutMs, now, researchLimits, onCacheHit,
  initialObservationGeneration }: {
  modelPin: ParticipantModelPin;
  own: ObservationInput;
  visual: VisualPort;
  cache?: WorkerTerraCache;
  timeoutMs?: number;
  now?: () => Date;
  researchLimits?: ResearchLimits;
  onCacheHit?: () => Promise<void>;
  initialObservationGeneration?: InitialObservationGeneration;
}): ObservationObserver {
  const { terraModelId } = validateParticipantModelPin(modelPin);
  const bound = ownProjection(own);
  const boundJson = JSON.stringify(bound);
  const checkOwn = (input: ObservationInput) => {
    if (JSON.stringify(ownProjection(input)) !== boundJson) throw new ObservationError('invalid_input');
  };
  const observer = createLunaObserver({
    async complete(messages, { signal, phase }) {
      const generation = phase === 'observation_initial' ? initialObservationGeneration : undefined;
      const requestMessages: ObservationMessage[] = generation === INITIAL_OBSERVATION_STRUCTURED_V2
        ? [{ role: 'system', content: INITIAL_OBSERVATION_V2_INSTRUCTIONS }, ...messages.slice(1)] : messages;
      const response = await visual({ purpose: 'visual_observation', messages: requestMessages,
        ...(generation ? { initial_observation_generation: generation } : {}) }, signal);
      if (response?.status !== 200) {
        const error = object(response?.data)?.error;
        if (generation && (response?.status === 422 && error === 'upstream_output_limit' ||
            response?.status === 502 && error === 'invalid_upstream_response')) {
          throw new ObservationError('invalid_response');
        }
        throw new ObservationError(response?.status === 504 ? 'timeout' : 'unavailable');
      }
      return { text: providerText(response.data, terraModelId, generation) };
    },
  }, { timeoutMs, now, researchLimits });

  let keyPromise: Promise<string> | undefined;

  async function validateEntry(value: unknown, key: string): Promise<ObservationMemo> {
    const entry = object(value);
    if (!entry || Reflect.ownKeys(entry).length !== 5 || entry.schemaVersion !== SCHEMA ||
        entry.key !== key || entry.modelId !== terraModelId || typeof entry.memoSha256 !== 'string') {
      throw new ObservationError('invalid_response');
    }
    const memo = validateObservationMemo(entry.memo, { ownAnchors: bound.ownAnchors });
    const text = JSON.stringify(memo);
    if (memo.figures.some(figure => figure.reobservations.length !== 0) || text.includes(bound.ownImage.base64) ||
        await sha256(text) !== entry.memoSha256) throw new ObservationError('invalid_response');
    return memo;
  }

  return {
    async observeAll(input, options) {
      checkAbort(options);
      checkOwn(input);
      if (!cache) return observer.observeAll(bound, options);
      try {
        const key = await (keyPromise ??= initialKey(terraModelId, boundJson, initialObservationGeneration));
        const hit = await cache.read(key, options?.signal);
        checkAbort(options);
        if (hit !== null && hit !== undefined) {
          const memo = await validateEntry(hit, key);
          await onCacheHit?.();
          checkAbort(options);
          return memo;
        }
        const memo = await observer.observeAll(bound, options);
        const memoSha256 = await sha256(JSON.stringify(memo));
        checkAbort(options);
        const winner = await cache.putIfAbsent(key, { schemaVersion: SCHEMA, key, modelId: terraModelId, memo, memoSha256 });
        checkAbort(options);
        return await validateEntry(winner, key);
      } catch (error) {
        if (error instanceof ObservationError) throw error;
        throw new ObservationError('unavailable');
      }
    },
    async reobserve(input, options) {
      checkAbort(options);
      checkOwn(input);
      return observer.reobserve({ ...bound, memo: input.memo, figureIds: input.figureIds, issue: input.issue }, options);
    },
  };
}
