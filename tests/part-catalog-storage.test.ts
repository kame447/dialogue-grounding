import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { serialize } from 'node:v8';
import { createLayoutsV2 } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { createPartGeometry } from '../dialogue-model/runtime/stimuli/part-geometry.ts';
import {
  createPartCatalogStorage, decodePartCatalogValue, encodePartCatalogValue, PART_CATALOG_STORAGE_VERSION,
} from '../workers/tangram-experiment/src/part-catalog-storage.ts';

const clone = <T>(value: T): T => structuredClone(value);
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const figureIds = ['F28', 'F5', 'F29', 'F16', 'F11', 'F10'];
const { ai } = createLayoutsV2({ seed: 909, figureSelection: { mode: 'custom', figureIds } });
const geometry = ai.map((figure: any) => ({ id: figure.id, region: figure.bbox, parts: createPartGeometry(figure.polygons) }));
const memo = () => ({ observedAt: '2026-11-28T00:00:00.000Z', figures: geometry.map(figure => ({
  ...clone(figure), holistic: [], analytic: { shapes: ['三角'], composition: '二つの部分が接する', relations: [] },
  unknowns: [] as string[], reobservations: [],
})) });
const record = () => {
  const observations = memo();
  return {
    options: { partObservationVersion: 'tangram_parts_v1' }, initialObservation: { memoSha256: sha(observations) },
    attempts: Array.from({ length: 30 }, (_, index) => ({ initialObservation: index ? null : clone(observations), observationMemo: clone(observations) })),
    jevTraces: Array.from({ length: 30 }, (_, index) => ({ initialObservation: index ? null : clone(observations), observationMemo: clone(observations) })),
    queueState: { privateState: { observationMemo: clone(observations) } },
  };
};

test('six figures and two thirty-turn records fit after lossless catalog normalization', context => {
  const original = { admissions: { a: { record: record() }, b: { record: record() } } };
  const before = serialize(original).byteLength;
  const packed = encodePartCatalogValue(original) as any;
  const after = serialize(packed).byteLength;
  context.diagnostic(JSON.stringify({ beforeV8Bytes: before, afterV8Bytes: after, beforeJsonBytes: Buffer.byteLength(JSON.stringify(original)), afterJsonBytes: Buffer.byteLength(JSON.stringify(packed)) }));
  assert.equal(packed.schemaVersion, PART_CATALOG_STORAGE_VERSION);
  assert.equal(Object.keys(packed.catalog).length, 6, 'all 126 repeated memos must reference the same six complete geometries');
  assert.ok(after < 1024 * 1024, `normalized owner must remain below 1 MiB, actual ${after}`);
  assert.ok(after < before / 10, `expected substantial deduplication: ${before} -> ${after}`);
  const restored = decodePartCatalogValue(packed) as typeof original;
  assert.equal(JSON.stringify(restored), JSON.stringify(original));
  assert.equal(sha(restored.admissions.a.record.queueState.privateState.observationMemo), original.admissions.a.record.initialObservation.memoSha256);
  const first = restored.admissions.a.record.attempts[0].observationMemo.figures[0].parts;
  first.parts[0].members[0] = 99;
  assert.notEqual(restored.admissions.a.record.attempts[1].observationMemo.figures[0].parts.parts[0].members[0], 99);
  assert.notEqual(restored.admissions.b.record.attempts[0].observationMemo.figures[0].parts.parts[0].members[0], 99);
  assert.notEqual(original.admissions.a.record.attempts[0].observationMemo.figures[0].parts.parts[0].members[0], 99);
});

test('catalog normalization preserves original JSON key order and escaped ordinary objects', () => {
  const part = geometry[0].parts;
  const reordered = Object.fromEntries(Object.entries(part).reverse());
  const original = { first: { parts: reordered }, second: { parts: clone(reordered) },
    ordinary: { __part_geometry_reference_v1__: 'an ordinary user value' },
    nested: { __part_geometry_literal_v1__: { __part_geometry_reference_v1__: 'nested ordinary value' } } };
  const packed = encodePartCatalogValue(original) as any;
  assert.equal(Object.keys(packed.catalog).length, 1);
  assert.equal(JSON.stringify(decodePartCatalogValue(packed)), JSON.stringify(original));
  assert.equal(JSON.stringify(original.first.parts), JSON.stringify(reordered));
});

test('catalog normalization retains signed zero independently from ordinary zero', () => {
  const positive = clone(geometry[0].parts), negative = clone(positive);
  // Choose the canonical local x minimum rather than changing any actual geometry.
  const zero = positive.parts.findIndex(part => part.bbox[0] === 0);
  assert.ok(zero >= 0);
  positive.parts[zero].bbox[0] = 0; negative.parts[zero].bbox[0] = -0;
  const packed = encodePartCatalogValue({ positive, negative }) as any;
  assert.equal(Object.keys(packed.catalog).length, 2);
  const restored = decodePartCatalogValue(packed) as { positive: typeof positive; negative: typeof negative };
  assert.equal(Object.is(restored.positive.parts[zero].bbox[0], 0), true);
  assert.equal(Object.is(restored.negative.parts[zero].bbox[0], -0), true);
});

test('legacy records and other storage values are not migrated or reinterpreted', () => {
  const original = { schemaVersion: 'base_owner_v1', admissions: {}, value: { __part_geometry_reference_v1__: 'legacy ordinary value' } };
  assert.equal(encodePartCatalogValue(original), original);
  assert.equal(decodePartCatalogValue(original), original);
  for (const value of [undefined, null, false, 4, 'private text', new Map([['a', 1]]), new Uint8Array([1, 2, 3])]) {
    assert.equal(encodePartCatalogValue(value), value);
    assert.equal(decodePartCatalogValue(value), value);
  }
});

test('catalog corruption, unknown versions, missing references and extra fields fail closed', () => {
  const source = encodePartCatalogValue({ memo: memo() }) as any;
  const mutations: Array<(value: any) => void> = [
    value => { value.schemaVersion = 'part_geometry_storage_v999'; },
    value => { value.extra = 'PRIVATE_CANARY'; },
    value => { delete value.catalog[Object.keys(value.catalog)[0]]; },
    value => { value.catalog[Object.keys(value.catalog)[0]].parts.pop(); },
    value => { value.value.memo.figures[0].parts.__part_geometry_reference_v1__ = '0'.repeat(64); },
    value => { value.value.memo.figures[0].parts.extra = 'PRIVATE_CANARY'; },
    value => { value.catalog = {}; },
    value => {
      const hash = Object.keys(value.catalog)[0], broken = value.catalog[hash];
      broken.parts.pop(); delete value.catalog[hash];
      const changedHash = sha(broken); value.catalog[changedHash] = broken;
      value.value.memo.figures[0].parts.__part_geometry_reference_v1__ = changedHash;
    },
  ];
  for (const mutate of mutations) {
    const value = clone(source); mutate(value);
    assert.throws(() => decodePartCatalogValue(value), { name: 'PartCatalogStorageError', code: 'invalid_part_catalog', message: 'invalid_part_catalog' });
  }
  const forged = { ...clone(geometry[0].parts), partnerImage: 'PRIVATE_CANARY' };
  assert.throws(() => encodePartCatalogValue({ parts: forged }), { code: 'invalid_part_catalog', message: 'invalid_part_catalog' });
});

class MemoryStorage {
  values = new Map<string, unknown>();
  calls: Array<{ method: string; options: unknown }> = [];
  sql = { marker: 'opaque original capability' };
  async get(key: string | string[], options?: unknown): Promise<any> {
    this.calls.push({ method: 'get', options });
    return Array.isArray(key) ? new Map(key.filter(name => this.values.has(name)).map(name => [name, clone(this.values.get(name))])) : clone(this.values.get(key));
  }
  async put(key: string | Record<string, unknown>, value?: unknown, options?: unknown) {
    this.calls.push({ method: 'put', options: typeof key === 'string' ? options : value });
    for (const [name, entry] of Object.entries(typeof key === 'string' ? { [key]: value } : key)) this.values.set(name, clone(entry));
  }
  async list(options: { prefix: string }) {
    this.calls.push({ method: 'list', options });
    return new Map([...this.values].filter(([key]) => key.startsWith(options.prefix)).map(([key, value]) => [key, clone(value)]));
  }
  async transaction<T>(callback: (storage: MemoryStorage) => Promise<T>) {
    const tx = new MemoryStorage(); tx.values = clone(this.values);
    const result = await callback(tx);
    this.values = tx.values; this.calls.push(...tx.calls); return result;
  }
  async delete(key: string) { return this.values.delete(key); }
  async setAlarm(value: number) { this.calls.push({ method: 'setAlarm', options: value }); }
  async deleteAlarm() { this.calls.push({ method: 'deleteAlarm', options: null }); }
}

test('storage and transaction wrappers cover both put/get forms, list and preserve other methods/options', async () => {
  const raw = new MemoryStorage(), store = createPartCatalogStorage(raw), original = { memo: memo() };
  assert.equal(createPartCatalogStorage(raw), store);
  assert.equal(createPartCatalogStorage(store), store);
  assert.equal(store.sql, raw.sql);
  await store.put('record:a', original, { allowUnconfirmed: false });
  assert.equal((raw.values.get('record:a') as any).schemaVersion, PART_CATALOG_STORAGE_VERSION);
  assert.deepEqual(await store.get('record:a', { noCache: true }), original);
  await store.put({ 'record:b': original, legacy: { observations: [] }, opaque: new Map([['plain', 2]]) }, { allowUnconfirmed: false });
  assert.deepEqual(await store.get(['record:a', 'legacy']), new Map<string, unknown>([['record:a', original], ['legacy', { observations: [] }]]));
  assert.deepEqual(await store.get('opaque'), new Map([['plain', 2]]));
  assert.deepEqual(await store.list({ prefix: 'record:' }), new Map([['record:a', original], ['record:b', original]]));
  await store.transaction(async tx => {
    const restored = await tx.get('record:a');
    assert.deepEqual(restored, original);
    restored.memo.figures[0].unknowns.push('a new observation');
    await tx.put({ 'record:a': restored, 'base:owner:v1': { admissions: { a: restored, b: original } } });
  });
  assert.equal((raw.values.get('base:owner:v1') as any).schemaVersion, PART_CATALOG_STORAGE_VERSION);
  assert.deepEqual((await store.get('record:a')).memo.figures[0].unknowns, ['a new observation']);
  assert.deepEqual((await store.get('record:b')).memo.figures[0].unknowns, []);
  await store.setAlarm(123); await store.deleteAlarm();
  assert.ok(raw.calls.some(call => call.method === 'get' && (call.options as any)?.noCache));
  assert.ok(raw.calls.some(call => call.method === 'put' && (call.options as any)?.allowUnconfirmed === false));
  assert.deepEqual(raw.calls.slice(-2), [{ method: 'setAlarm', options: 123 }, { method: 'deleteAlarm', options: null }]);
  assert.equal(await store.delete('record:b'), true);
  assert.equal(await store.get('record:b'), undefined);
});

test('failed transactions commit neither catalogs nor references and a corrupt read is never partially restored', async () => {
  const raw = new MemoryStorage(), store = createPartCatalogStorage(raw), original = { memo: memo() };
  await store.put('record:a', original);
  const previous = clone(raw.values);
  await assert.rejects(store.transaction(async tx => {
    await tx.put({ 'record:a': { memo: memo(), changed: true } });
    throw new Error('synthetic transaction failure');
  }), /synthetic transaction failure/);
  assert.deepEqual(raw.values, previous);
  const broken = clone(raw.values.get('record:a')) as any;
  delete broken.catalog[Object.keys(broken.catalog)[0]];
  raw.values.set('record:a', broken);
  await assert.rejects(store.get('record:a'), { code: 'invalid_part_catalog' });
  await assert.rejects(store.list({ prefix: 'record:' }), { code: 'invalid_part_catalog' });
});
