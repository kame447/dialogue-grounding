// An ADMIN_INDEX binding backed by a real AdminIndex with its own empty storage:
// reception settings are unsaved, so the legacy flow applies. Each call is independent.
// Its transaction neither serializes nor rolls back, so never use it for settings CAS or atomicity tests.
export function emptyAdminIndex(AdminIndex: any) {
  const values = new Map<string, unknown>();
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
