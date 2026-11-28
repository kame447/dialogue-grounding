export type PreparedObservationReference = {
  schemaVersion: 'prepared_observations_v1';
  bundleId: string;
  preparedAt: string;
  trials: { index: number; cacheKey: string; memoSha256: string }[];
};
export type PreparedTrialObservationReference = {
  schemaVersion: 'prepared_trial_observation_v1';
  bundleId: string;
  preparedAt: string;
  index: number;
  cacheKey: string;
  memoSha256: string;
};

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const CACHE_KEY = /^terra_initial_observation_v1:[a-f0-9]{64}$/u;
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) throw new Error('prepared_observation_invalid');
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !Object.hasOwn(field, 'value') || !field.enumerable) throw new Error('prepared_observation_invalid');
    result[key] = field.value;
  }
  return result;
}
function metadata(value: Record<string, unknown>) {
  if (typeof value.bundleId !== 'string' || !UUID.test(value.bundleId) || typeof value.preparedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.preparedAt) ||
      !Number.isFinite(Date.parse(value.preparedAt)) || new Date(value.preparedAt).toISOString() !== value.preparedAt) throw new Error('prepared_observation_invalid');
  return { bundleId: value.bundleId, preparedAt: value.preparedAt };
}
function trial(value: unknown) {
  const p = object(value, ['index', 'cacheKey', 'memoSha256']);
  if (!Number.isSafeInteger(p.index) || (p.index as number) < 0 || (p.index as number) > 1 ||
      typeof p.cacheKey !== 'string' || !CACHE_KEY.test(p.cacheKey) || typeof p.memoSha256 !== 'string' || !SHA.test(p.memoSha256)) throw new Error('prepared_observation_invalid');
  return { index: p.index as number, cacheKey: p.cacheKey, memoSha256: p.memoSha256 };
}
export function validatePreparedObservations(value: unknown, trialCount: number): PreparedObservationReference {
  const p = object(value, ['schemaVersion', 'bundleId', 'preparedAt', 'trials']);
  if (p.schemaVersion !== 'prepared_observations_v1' || !Array.isArray(p.trials) || p.trials.length !== trialCount || trialCount < 1 || trialCount > 2) throw new Error('prepared_observation_invalid');
  const trials = p.trials.map((raw, index) => {
    const result = trial(raw);
    if (result.index !== index) throw new Error('prepared_observation_invalid');
    return result;
  });
  for (const item of trials) if (trials.some(other => other.cacheKey === item.cacheKey && other.memoSha256 !== item.memoSha256)) throw new Error('prepared_observation_invalid');
  return { schemaVersion: p.schemaVersion, ...metadata(p), trials };
}
export function preparedTrialObservation(reference: PreparedObservationReference, index: number): PreparedTrialObservationReference {
  const validated = validatePreparedObservations(reference, reference.trials.length);
  const selected = validated.trials[index];
  if (!selected) throw new Error('prepared_observation_invalid');
  return { schemaVersion: 'prepared_trial_observation_v1', bundleId: validated.bundleId, preparedAt: validated.preparedAt, ...selected };
}
export function validatePreparedTrialObservation(value: unknown): PreparedTrialObservationReference {
  const p = object(value, ['schemaVersion', 'bundleId', 'preparedAt', 'index', 'cacheKey', 'memoSha256']);
  if (p.schemaVersion !== 'prepared_trial_observation_v1') throw new Error('prepared_observation_invalid');
  return { schemaVersion: p.schemaVersion, ...metadata(p), ...trial({ index: p.index, cacheKey: p.cacheKey, memoSha256: p.memoSha256 }) };
}
