export type AdminTermination = { at: string; by: 'admin' };
export type IncompleteTrialStatus = 'dialogue' | 'submitting';

export function isIncompleteTrialStatus(value: unknown): value is IncompleteTrialStatus {
  return value === 'dialogue' || value === 'submitting';
}

export function isAdminTermination(value: unknown): value is AdminTermination {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const { at, by } = value as Partial<AdminTermination>;
  return Reflect.ownKeys(value).length === 2 && Object.hasOwn(value, 'at') && Object.hasOwn(value, 'by') && by === 'admin' &&
    typeof at === 'string' && Number.isFinite(Date.parse(at)) && new Date(at).toISOString() === at;
}
