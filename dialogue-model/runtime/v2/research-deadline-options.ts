// Internal option validator. A number alone never enables research limits.
import { RESEARCH_MAX_DEADLINE_MS } from './research-timeouts.ts';
export function deadlineLimit(value: unknown): number {
  if (value === undefined) return 60000;
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== 1 || !Object.hasOwn(value, 'maxDeadlineMs')) throw capabilityError();
  const limit = (value as { maxDeadlineMs: unknown }).maxDeadlineMs;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > RESEARCH_MAX_DEADLINE_MS) throw capabilityError();
  return limit;
}
function capabilityError() { return Object.assign(new Error('invalid_research_limits'), { code: 'invalid_research_limits' }); }
export const deadlineValue = (v: unknown, limit: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= limit;
