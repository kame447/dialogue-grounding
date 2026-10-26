// Explicit research selections; no production defaults or implicit opt-in.
export const RESEARCH_MAX_DEADLINE_MS = 600000;
export const RESEARCH_MAX_TRIAL_MS = 3600000;
export const RESEARCH_MAX_LUNA_ATTEMPT_MS = 85000;
export type ResearchLimits = { maxDeadlineMs: number };
export type ResearchTimeoutsV2 = { observationMs: number; localMs: number; decisionMs: number; lunaAttemptMs: number; generationMs: number; trialMs: number };
const names = ['observationMs', 'localMs', 'decisionMs', 'lunaAttemptMs', 'generationMs', 'trialMs'] as const;
// The manifest must insert its duplicate-Luna check before the relationship.
export function validateResearchTimeouts(value: unknown): ResearchTimeoutsV2 {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== names.length || !names.every(k => Object.hasOwn(value, k))) throw Error('invalid_timeouts');
  const v = value as ResearchTimeoutsV2;
  if (names.some(k => typeof v[k] !== 'number' || !Number.isSafeInteger(v[k]) || v[k] < 1 || v[k] > (k === 'trialMs' ? RESEARCH_MAX_TRIAL_MS : RESEARCH_MAX_DEADLINE_MS))) throw Error('invalid_timeouts');
  if (v.lunaAttemptMs > RESEARCH_MAX_LUNA_ATTEMPT_MS) throw Error('luna_attempt_exceeds_worker_upstream');
  if (names.some(k => k !== 'trialMs' && v.trialMs <= v[k])) throw Error('timeouts_relation_invalid');
  return Object.freeze({ ...v });
}
