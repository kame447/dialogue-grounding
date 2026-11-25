import type { AdminLimiter } from '../../../workers/tangram-experiment/src/admin/routes.ts';

/** Fixed configuration error: never attach supplied values or an underlying cause. */
export class LocalOperatorConfigError extends Error {
  readonly code = 'invalid_operator_config';
  constructor() { super('invalid_operator_config'); this.name = 'LocalOperatorConfigError'; }
}
export type LocalOperatorOptions = {
  adminToken: string | undefined;
  adminLimiter: AdminLimiter | undefined;
  participantContactText: string | undefined;
};

/** Infrastructure policy matches the existing Worker 30/60 setting; state is process-local. */
export function createLocalAdminLimiter(now: () => number = () => performance.now()): AdminLimiter {
  const entries = new Map<string, number[]>();
  let latest = 0;
  return {
    async limit(input) {
      const denied = { success: false };
      try {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return denied;
        const descriptor = Object.getOwnPropertyDescriptor(input, 'key');
        if (!descriptor || !Object.hasOwn(descriptor, 'value') ||
            typeof descriptor.value !== 'string' || !descriptor.value) return denied;
        const key: string = descriptor.value, tick = now();
        if (!Number.isFinite(tick) || tick < latest || tick < 0) return denied;
        latest = tick;
        for (const [id, values] of entries) {
          const live = values.filter(value => tick - value < 60000);
          if (live.length) entries.set(id, live); else entries.delete(id);
        }
        let values = entries.get(key);
        if (!values) {
          if (entries.size >= 64) return denied;
          values = []; entries.set(key, values);
        }
        if (values.length >= 30) return denied;
        values.push(tick); return { success: true };
      } catch { return denied; }
    },
  };
}

/** Launcher configuration only. HTTP credentials still travel only in Authorization. */
export function readLocalOperatorOptions(env: Readonly<Record<string, unknown>>): LocalOperatorOptions {
  try {
    if (!env || typeof env !== 'object' || Array.isArray(env)) throw new LocalOperatorConfigError();
    const own = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(env, key);
      if (!descriptor) return undefined;
      if (!Object.hasOwn(descriptor, 'value')) throw new LocalOperatorConfigError();
      return descriptor.value;
    };
    const token = own('ADMIN_TOKEN'), contact = own('PARTICIPANT_CONTACT_TEXT');
    if (token !== undefined && (typeof token !== 'string' || !/^[\x21-\x7e]{32,512}$/u.test(token))) throw new LocalOperatorConfigError();
    if (contact !== undefined && (typeof contact !== 'string' || !contact.length || contact.length > 500 ||
        /[\u0000-\u001f\u007f<>]/u.test(contact))) throw new LocalOperatorConfigError();
    return { adminToken: token as string | undefined, adminLimiter: token === undefined ? undefined : createLocalAdminLimiter(),
      participantContactText: contact as string | undefined };
  } catch { throw new LocalOperatorConfigError(); }
}
