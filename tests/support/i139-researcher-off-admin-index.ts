// An ADMIN_INDEX binding backed by a real AdminIndex whose researcher has explicitly saved reception "off"
// (reception is otherwise the default), so the legacy flow applies. Each call is independent.
// The entry has the exact shape saveMode writes (current + rev:0000000001, no protocol).
// Its transaction neither serializes nor rolls back, so never use it for settings CAS or atomicity tests.
export const RESEARCHER_OFF_MODE = Object.freeze({ revision: 1, value: 'off', savedAt: '2026-10-28T00:00:00.000Z', protocolRevision: null });
export function researcherOffAdminIndex(AdminIndex: any) {
  const values = new Map<string, unknown>([['reception-mode:current', { ...RESEARCHER_OFF_MODE }], ['reception-mode:rev:0000000001', { ...RESEARCHER_OFF_MODE }]]);
  const storage = {
    async get(key: string) { return structuredClone(values.get(key)); },
    async put(entries: Record<string, unknown>) { for (const [k, v] of Object.entries(entries)) values.set(k, structuredClone(v)); },
    async delete(keys: string | string[]) { let n = 0; for (const k of [keys].flat()) n += Number(values.delete(k)); return n; },
    async list({ prefix }: { prefix: string }) { return new Map([...values].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))); },
    async transaction(fn: (tx: unknown) => Promise<unknown>) { return fn(storage); },
  };
  const index = new AdminIndex({ storage }, {});
  return { idFromName: (name: string) => name, get: () => index };
}
