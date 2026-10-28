import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

registerHooks({ resolve(s, c, next) {
  if (s === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}', shortCircuit: true };
  if (s.startsWith('.') && c.parentURL?.startsWith('file:')) {
    const u = new URL(s, c.parentURL);
    if (!existsSync(fileURLToPath(u)) && existsSync(fileURLToPath(u) + '.ts')) return next(u.href + '.ts', c);
  }
  return next(s, c);
} });
const root = fileURLToPath(new URL('../', import.meta.url));
const { AdminIndex }: any = await import(pathToFileURL(root + '/workers/tangram-experiment/src/admin/index-do.ts').href);
const settings: any = await import(pathToFileURL(root + '/workers/tangram-experiment/src/admin/reception-settings.ts').href);

// Synthetic selections exercise storage only; they are not research choices.
const clone = <T>(v: T): T => structuredClone(v);
function memory() {
  let values = new Map<string, any>(), queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>) => { const r = queue.then(fn); queue = r.catch(() => {}); return r; };
  const view = (map: Map<string, any>) => ({
    async get(key: string) { return clone(map.get(key)); },
    async put(updates: Record<string, unknown>) { for (const [k, v] of Object.entries(updates)) map.set(k, clone(v)); },
    async delete(keys: string | string[]) { let n = 0; for (const k of Array.isArray(keys) ? keys : [keys]) n += Number(map.delete(k)); return n; },
    async list({ prefix, reverse, limit }: { prefix: string; reverse?: boolean; limit?: number }) {
      let rows = [...map].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
      if (reverse) rows.reverse(); if (limit) rows = rows.slice(0, limit); return new Map(rows);
    },
  });
  return { get raw() { return values; }, snapshot: () => clone(Object.fromEntries(values)), set: (k: string, v: unknown) => values.set(k, clone(v)), remove: (k: string) => values.delete(k),
    get: (k: string) => view(values).get(k), put: (u: Record<string, unknown>) => enqueue(() => view(values).put(u)),
    delete: (k: string | string[]) => enqueue(() => view(values).delete(k)), list: (o: any) => view(values).list(o),
    transaction(fn: (tx: any) => Promise<any>) { return enqueue(async () => { const staged = clone(values), r = await fn(view(staged)); values = staged; return r; }); },
  };
}
const fields = (patch: Record<string, unknown> = {}) => ({ allowedOrders: [['repair-first', 'bypass-enabled'], ['bypass-enabled']], seedPolicy: 'shared',
  referenceMemory: true, betweenTrials: 'none', receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_0', ...patch });
const fresh = () => { const storage = memory(); return { storage, index: new AdminIndex({ storage }, {}) }; };
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const broken = (error: any) => { assert.equal(error.code, 'reception_unavailable'); return true; };

test('unsaved settings are a normal state: no protocol, mode unset', async () => {
  const { index } = fresh();
  const s = settings.validateReceptionSettings(clone(await index.readReceptionSettings()));
  assert.deepEqual(s, { protocol: null, mode: { value: 'unset', revision: 0 } });
  assert.deepEqual(await index.receptionProtocolHistory(), []);
});

test('protocol saves are compare-and-swap, keep one protocol id, and append a complete canonical protocol per revision', async () => {
  const { index, storage } = fresh();
  const first = await index.saveReceptionProtocol({ expectedRevision: 0, fields: fields() });
  assert.deepEqual(first, { ok: true, revision: 1 });
  const s1 = settings.validateReceptionSettings(clone(await index.readReceptionSettings()));
  assert.equal(s1.protocol.revision, 1); assert.equal(s1.protocol.protocol.revision, 1);
  assert.equal(s1.protocol.protocol.schemaVersion, 'reception_protocol_v2'); assert.equal(s1.protocol.protocol.rotationMode, 'relative_0');
  assert.match(s1.protocol.protocol.protocolId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
  assert.equal(s1.protocol.sha256, sha(JSON.stringify(s1.protocol.protocol)));
  const before = storage.snapshot();
  assert.deepEqual(await index.saveReceptionProtocol({ expectedRevision: 0, fields: fields({ rotationMode: 'relative_pm90' }) }), { ok: false, error: 'conflict' });
  assert.deepEqual(storage.snapshot(), before, 'a stale save writes nothing');
  assert.deepEqual(await index.saveReceptionProtocol({ expectedRevision: 1, fields: fields({ rotationMode: 'relative_pm90', betweenTrials: 'questionnaire_required' }) }), { ok: true, revision: 2 });
  const s2 = settings.validateReceptionSettings(clone(await index.readReceptionSettings()));
  assert.equal(s2.protocol.protocol.protocolId, s1.protocol.protocol.protocolId); assert.equal(s2.protocol.protocol.rotationMode, 'relative_pm90');
  const history = await index.receptionProtocolHistory();
  assert.deepEqual(history.map((h: any) => h.revision), [2, 1]);
  assert.deepEqual(history[1].protocol, s1.protocol.protocol, 'earlier versions remain complete');
  const raced = await Promise.all([3, 3].map(() => index.saveReceptionProtocol({ expectedRevision: 2, fields: fields() })));
  assert.equal(raced.filter((r: any) => r.ok).length, 1); assert.equal((await index.receptionProtocolHistory()).length, 3);
});

test('protocol fields are explicit: missing, defaulted, unknown or extra values save nothing', async () => {
  for (const bad of [{}, fields({ rotationMode: undefined }), fields({ rotationMode: null }), fields({ rotationMode: 'relative_90' }),
    fields({ betweenTrials: 'rest' }), fields({ allowedOrders: [] }), fields({ seedPolicy: '' }), fields({ referenceMemory: 'on' }),
    { ...fields(), protocolId: '22222222-2222-4222-8222-222222222222' }, { ...fields(), extra: 1 }, null]) {
    const { index, storage } = fresh();
    assert.deepEqual(await index.saveReceptionProtocol({ expectedRevision: 0, fields: bad }), { ok: false, error: 'invalid' });
    assert.deepEqual(storage.snapshot(), {});
  }
});

test('mode on and off save without a protocol (reception is the default); mode saves are compare-and-swap with their own history', async () => {
  const { index, storage } = fresh();
  assert.deepEqual(await index.saveReceptionMode({ expectedRevision: 0, value: 'off' }), { ok: true, revision: 1 });
  assert.deepEqual(await index.saveReceptionMode({ expectedRevision: 0, value: 'on' }), { ok: false, error: 'conflict' });
  const before = storage.snapshot();
  for (const bad of ['', 'ON', 'unset', null, true]) assert.deepEqual(await index.saveReceptionMode({ expectedRevision: 1, value: bad }), { ok: false, error: 'invalid' });
  assert.deepEqual(storage.snapshot(), before, 'rejected saves change nothing');
  assert.deepEqual(await index.saveReceptionMode({ expectedRevision: 1, value: 'on' }), { ok: true, revision: 2 });
  const noProtocol = settings.validateReceptionSettings(clone(await index.readReceptionSettings()));
  assert.deepEqual({ protocol: noProtocol.protocol, value: noProtocol.mode.value, revision: noProtocol.mode.revision }, { protocol: null, value: 'on', revision: 2 });
  assert.equal(settings.receptionOpen(noProtocol.mode), true);
  await index.saveReceptionProtocol({ expectedRevision: 0, fields: fields() });
  assert.deepEqual(await index.saveReceptionMode({ expectedRevision: 2, value: 'off' }), { ok: true, revision: 3 });
  const s = settings.validateReceptionSettings(clone(await index.readReceptionSettings()));
  assert.deepEqual({ value: s.mode.value, revision: s.mode.revision }, { value: 'off', revision: 3 });
  assert.equal(settings.receptionOpen(s.mode), false);
  assert.deepEqual((await index.receptionModeHistory()).map((h: any) => [h.revision, h.value, h.protocolRevision]), [[3, 'off', 1], [2, 'on', null], [1, 'off', null]]);
});

test('the effective mode: unset and on are open, only an explicit off is closed; the stored value is never rewritten', async () => {
  const { index, storage } = fresh();
  const unset = settings.validateReceptionSettings(clone(await index.readReceptionSettings()));
  assert.deepEqual(unset.mode, { value: 'unset', revision: 0 }); assert.equal(settings.receptionOpen(unset.mode), true);
  assert.deepEqual(storage.snapshot(), {}, 'reading never writes a mode');
});

test('a protocol lost after a mode was saved against it is damage, never "unsaved": reads and saves fail closed', async () => {
  const { index, storage } = fresh();
  await index.saveReceptionProtocol({ expectedRevision: 0, fields: fields() });
  assert.deepEqual(await index.saveReceptionMode({ expectedRevision: 0, value: 'on' }), { ok: true, revision: 1 });
  assert.equal((await index.receptionModeHistory())[0].protocolRevision, 1);
  for (const k of [...storage.raw.keys()]) if (k.startsWith('reception-protocol:')) storage.remove(k);
  await assert.rejects(async () => settings.validateReceptionSettings(clone(await index.readReceptionSettings())), broken);
  const before = storage.snapshot();
  for (const write of [() => index.saveReceptionMode({ expectedRevision: 1, value: 'on' }), () => index.saveReceptionMode({ expectedRevision: 1, value: 'off' }),
    () => index.saveReceptionProtocol({ expectedRevision: 0, fields: fields() })]) {
    assert.equal((await write()).ok, false, 'no repair-by-overwrite');
  }
  assert.deepEqual(storage.snapshot(), before);
  // The same check for a protocol rolled back below the revision the mode was saved against.
  const second = fresh();
  await second.index.saveReceptionProtocol({ expectedRevision: 0, fields: fields() });
  await second.index.saveReceptionProtocol({ expectedRevision: 1, fields: fields({ seedPolicy: 'shared' }) });
  await second.index.saveReceptionMode({ expectedRevision: 0, value: 'on' });
  const rev1 = second.storage.raw.get('reception-protocol:rev:0000000001');
  second.storage.set('reception-protocol:current', { revision: 1, protocolId: rev1.protocol.protocolId, sha256: rev1.sha256, savedAt: rev1.savedAt });
  second.storage.remove('reception-protocol:rev:0000000002');
  await assert.rejects(async () => settings.validateReceptionSettings(clone(await second.index.readReceptionSettings())), broken);
});

test('corruption is never read as unsaved or off: history without current, mismatched versions and damaged values fail closed', async () => {
  const cases: [string, (s: ReturnType<typeof memory>) => void][] = [
    ['protocol current missing with history', s => s.remove('reception-protocol:current')],
    ['protocol history missing', s => { for (const k of [...s.raw.keys()]) if (k.startsWith('reception-protocol:rev:')) s.remove(k); }],
    ['protocol sha mismatch', s => { const c = s.raw.get('reception-protocol:current'); s.set('reception-protocol:current', { ...c, sha256: 'f'.repeat(64) }); }],
    ['protocol revision mismatch', s => { const c = s.raw.get('reception-protocol:current'); s.set('reception-protocol:current', { ...c, revision: 9 }); }],
    ['protocol content damaged', s => { const k = [...s.raw.keys()].find(k => k.startsWith('reception-protocol:rev:'))!; const v = s.raw.get(k); s.set(k, { ...v, protocol: { ...v.protocol, rotationMode: 'x' } }); }],
    ['mode current missing with history', s => s.remove('reception-mode:current')],
    ['mode value damaged', s => { const c = s.raw.get('reception-mode:current'); s.set('reception-mode:current', { ...c, value: 'maybe' }); }],
    ['mode extra field', s => { const c = s.raw.get('reception-mode:current'); s.set('reception-mode:current', { ...c, extra: 1 }); }],
  ];
  for (const [name, damage] of cases) {
    const { index, storage } = fresh();
    await index.saveReceptionProtocol({ expectedRevision: 0, fields: fields() });
    await index.saveReceptionMode({ expectedRevision: 0, value: 'on' });
    damage(storage);
    await assert.rejects(async () => settings.validateReceptionSettings(clone(await index.readReceptionSettings())), broken, name);
    const before = storage.snapshot();
    const write = name.startsWith('mode') ? await index.saveReceptionMode({ expectedRevision: 1, value: 'off' })
      : await index.saveReceptionProtocol({ expectedRevision: 1, fields: fields() });
    assert.equal(write.ok, false, name + ': no repair-by-overwrite'); assert.deepEqual(storage.snapshot(), before);
  }
});

test('RPC snapshots are validated after transport normalization; unknown string keys are still rejected', async () => {
  const { index } = fresh();
  await index.saveReceptionProtocol({ expectedRevision: 0, fields: fields() });
  const value = await index.readReceptionSettings();
  Object.defineProperty(value, Symbol.dispose, { value() {}, enumerable: false });
  assert.equal(settings.validateReceptionSettings(structuredClone(value)).protocol.revision, 1);
  assert.throws(() => settings.validateReceptionSettings({ ...structuredClone(value), extra: true }), broken);
  assert.throws(() => settings.validateReceptionSettings({ ...structuredClone(value), protocol: { ...structuredClone(value).protocol, sha256: '0'.repeat(64) } }), broken);
});

test('settings keys never mix with reception rows, number counters or record summaries', async () => {
  const { index } = fresh();
  await index.saveReceptionProtocol({ expectedRevision: 0, fields: fields() });
  await index.saveReceptionMode({ expectedRevision: 0, value: 'on' });
  assert.deepEqual(await index.listReceptions(), []);
  assert.deepEqual(await index.page(null), { items: [], next: null });
  assert.equal(await index.allocateReceptionNumber('daily_seq3', Date.UTC(2000, 0, 1)), '001');
  assert.equal(settings.validateReceptionSettings(clone(await index.readReceptionSettings())).protocol.revision, 1);
});
