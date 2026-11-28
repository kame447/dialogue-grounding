// #269 管理画面: 回転の選択肢・初期選択・現在の設定の一度だけの移行。
// 合成の値で仕組みを確かめるだけで、研究条件を決めるものではない。
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handleAdmin } from '../workers/tangram-experiment/src/admin/routes.ts';
import type { AdminDeps } from '../workers/tangram-experiment/src/admin/routes.ts';
import { renderExperimentPreview, renderReceptions, renderSettings } from '../workers/tangram-experiment/src/admin/render.ts';
import { createTrialV2, participantView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { resolveFigureSelection } from '../dialogue-model/runtime/stimuli/figure-bank.ts';
import { createReceptionSettingsPort } from '../workers/tangram-experiment/src/admin/reception-adapter.ts';
import { summarizeLatency } from '../workers/tangram-experiment/src/admin/latency.ts';
import { receptionProtocolSha256, validateReceptionProtocolV2 } from '../dialogue-model/runtime/v2/reception.ts';
import { checkedValues, submittedFrom } from './support/settings-form.ts';

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

const NEW = 'relative_90_180_270', MARKER = 'reception-migration:rotation-90-180-270:v1';
const ORIGIN = 'https://example.test', TOKEN = 'synthetic-admin-token-01234567890123456789', SETTINGS = '/admin/reception-settings';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const clone = <T>(v: T): T => structuredClone(v);

/** An in-memory AdminIndex storage whose transaction rolls back on a throw; `puts` records the keys of every put. */
function memory() {
  let values = new Map<string, any>(), queue: Promise<unknown> = Promise.resolve();
  const puts: string[][] = [];
  const enqueue = <T>(fn: () => Promise<T>) => { const run = queue.then(fn); queue = run.catch(() => {}); return run; };
  const view = (map: Map<string, any>) => ({
    async get(key: string) { return clone(map.get(key)); },
    async put(updates: Record<string, unknown>) { puts.push(Object.keys(updates)); for (const [k, v] of Object.entries(updates)) map.set(k, clone(v)); },
    async delete(keys: string | string[]) { let n = 0; for (const k of Array.isArray(keys) ? keys : [keys]) n += Number(map.delete(k)); return n; },
    async list({ prefix, reverse, limit }: { prefix: string; reverse?: boolean; limit?: number }) {
      let rows = [...map].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
      if (reverse) rows.reverse(); if (limit) rows = rows.slice(0, limit); return new Map(rows);
    },
  });
  return { puts, snapshot: () => clone(Object.fromEntries(values)), set: (k: string, v: unknown) => values.set(k, clone(v)), remove: (k: string) => values.delete(k),
    get: (k: string) => view(values).get(k), put: (u: Record<string, unknown>) => enqueue(() => view(values).put(u)),
    delete: (k: string | string[]) => enqueue(() => view(values).delete(k)), list: (o: any) => view(values).list(o),
    transaction(fn: (tx: any) => Promise<any>) { return enqueue(async () => { const staged = clone(values), r = await fn(view(staged)); values = staged; return r; }); },
    async setAlarm() {} };
}
type Memory = ReturnType<typeof memory>;

/** The release before this change: no startup step, so it never migrates anything. */
const previousRelease = (storage: Memory) => new AdminIndex({ storage }, {});
/** This release starting on the same storage. The startup step runs inside blockConcurrencyWhile; the observation preparation is only recorded. */
function startRelease(storage: Memory) {
  const startups: Promise<unknown>[] = [], background: Promise<unknown>[] = [], prepared: number[] = [];
  const ctx = { storage, blockConcurrencyWhile: <T>(fn: () => Promise<T>) => { const run = fn(); startups.push(run); return run; },
    waitUntil: (work: Promise<unknown>) => { background.push(work); } };
  const index = new AdminIndex(ctx, {});
  index.observations.prepare = async (input: { expectedProtocolRevision: number }) => { prepared.push(input.expectedProtocolRevision); return { ok: true }; };
  return { index, prepared, async started() { await Promise.all(startups); await Promise.all(background); } };
}
async function started(storage: Memory) { const release = startRelease(storage); await release.started(); return release; }

const protocolFields = (patch: Record<string, unknown> = {}) => ({ allowedOrders: [['repair-first', 'bypass-enabled'], ['bypass-enabled']], seedPolicy: 'shared',
  referenceMemory: true, betweenTrials: 'none', receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_pm90',
  figureSelection: { mode: 'custom', figureIds: ['F1', 'F2', 'F3'] }, figureSetPolicy: 'shared', ...patch });
const changedKeys = (before: Record<string, unknown>, after: Record<string, unknown>) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
const rotationOf = async (index: any) => { const { protocol } = await index.readReceptionSettings(); return protocol && [protocol.revision, protocol.protocol.rotationMode]; };

// ── 現在の設定の一度だけの移行（AdminIndex の起動）──────────────────────────────

test('a saved ±90° protocol is switched once at startup: one new revision differs only in rotationMode and the old revision and sha256 stay', async () => {
  const storage = memory(), old = previousRelease(storage);
  assert.deepEqual(await old.saveReceptionProtocol({ expectedRevision: 0, fields: protocolFields({ rotationMode: 'relative_pm90' }) }), { ok: true, revision: 1 });
  assert.equal((await old.saveReceptionMode({ expectedRevision: 0, value: 'on' })).ok, true);
  assert.equal((await old.saveReceptionPostGenerationCheck({ expectedRevision: 0, value: 'on' })).ok, true);
  const receptionId = '6f8a064e-9bdb-4538-b553-a02eacd94425';
  await old.upsertReception({ receptionId, objectId: 'a'.repeat(64), createdAt: '2026-11-28T00:00:00.000Z', number: '001', status: 'approved', revision: 1, trials: [{ index: 0, recordId: null }] });
  const saved = (await old.readReceptionSettings()).protocol, rows = storage.snapshot();
  storage.puts.length = 0;

  const release = await started(storage);
  const after = (await release.index.readReceptionSettings()).protocol;
  assert.equal(after.revision, 2);
  assert.deepEqual(after.protocol, { ...saved.protocol, revision: 2, rotationMode: NEW });
  assert.equal(after.protocol.protocolId, saved.protocol.protocolId);
  assert.equal(after.sha256, receptionProtocolSha256(JSON.stringify(after.protocol)));
  assert.notEqual(after.sha256, saved.sha256);
  const history = await release.index.receptionProtocolHistory();
  assert.deepEqual(history.map((h: any) => [h.revision, h.protocol.rotationMode, h.sha256]), [[2, NEW, after.sha256], [1, 'relative_pm90', saved.sha256]]);
  assert.deepEqual(history[1], saved, 'the old revision entry is untouched');
  assert.deepEqual(changedKeys(rows, storage.snapshot()), [MARKER, 'reception-protocol:current', 'reception-protocol:rev:0000000002'],
    'the mode, the check, the reception rows and every older revision are untouched');
  assert.equal(storage.puts.length, 1, 'the revision and the marker are one put');
  assert.deepEqual([...storage.puts[0]].sort(), [MARKER, 'reception-protocol:current', 'reception-protocol:rev:0000000002']);
  assert.deepEqual(storage.snapshot()[MARKER], { at: storage.snapshot()[MARKER].at, outcome: 'migrated', fromRevision: 1, toRevision: 2 });
  assert.match(storage.snapshot()[MARKER].at, ISO);
  assert.deepEqual(release.prepared, [2], 'observation preparation is requested for the new revision, as after a save');
  assert.equal((await release.index.preparedObservationStatus()).protocolRevision, 2, 'the observation status follows the new revision');
  assert.equal((await release.index.readReceptionSettings()).mode.value, 'on');
});

test('the second start does nothing, and a researcher\'s explicit ±90° save after the switch is never rewritten', async () => {
  const storage = memory();
  assert.equal((await previousRelease(storage).saveReceptionProtocol({ expectedRevision: 0, fields: protocolFields() })).ok, true);
  const first = await started(storage);
  assert.deepEqual(await rotationOf(first.index), [2, NEW]);
  const settled = storage.snapshot();
  const second = await started(storage);
  assert.deepEqual(storage.snapshot(), settled); assert.deepEqual(second.prepared, []);

  assert.deepEqual(await second.index.saveReceptionProtocol({ expectedRevision: 2, fields: protocolFields({ rotationMode: 'relative_pm90' }) }), { ok: true, revision: 3 });
  const chosen = storage.snapshot();
  for (let restart = 0; restart < 2; restart++) {
    const again = await started(storage);
    assert.deepEqual(storage.snapshot(), chosen); assert.deepEqual(again.prepared, []);
    assert.deepEqual(await rotationOf(again.index), [3, 'relative_pm90']);
  }
});

test('relative_0 and a protocol already on the new mode are only marked; nothing else changes', async () => {
  for (const rotationMode of ['relative_0', NEW]) {
    const storage = memory();
    assert.equal((await previousRelease(storage).saveReceptionProtocol({ expectedRevision: 0, fields: protocolFields({ rotationMode }) })).ok, true);
    const rows = storage.snapshot(), release = await started(storage);
    assert.deepEqual(changedKeys(rows, storage.snapshot()), [MARKER], rotationMode);
    assert.deepEqual(storage.snapshot()[MARKER], { at: storage.snapshot()[MARKER].at, outcome: 'kept', fromRevision: 1, toRevision: null });
    assert.deepEqual(await rotationOf(release.index), [1, rotationMode]); assert.deepEqual(release.prepared, []);
  }
});

test('unsaved settings are only marked, so a first explicit ±90° save survives later starts', async () => {
  const storage = memory(), first = await started(storage);
  assert.deepEqual(Object.keys(storage.snapshot()), [MARKER]);
  assert.deepEqual(storage.snapshot()[MARKER], { at: storage.snapshot()[MARKER].at, outcome: 'unsaved', fromRevision: null, toRevision: null });
  assert.deepEqual(await first.index.saveReceptionProtocol({ expectedRevision: 0, fields: protocolFields({ rotationMode: 'relative_pm90' }) }), { ok: true, revision: 1 });
  const chosen = storage.snapshot(), second = await started(storage);
  assert.deepEqual(storage.snapshot(), chosen); assert.deepEqual(second.prepared, []);
  assert.deepEqual(await rotationOf(second.index), [1, 'relative_pm90']);
});

test('a saved v2 protocol (no figure fields) is only marked and stays as it is', async () => {
  const storage = memory(), protocolId = '44444444-4444-4444-8444-444444444444', savedAt = '2026-11-24T00:00:00.000Z';
  const v2 = validateReceptionProtocolV2({ schemaVersion: 'reception_protocol_v2', protocolId, revision: 2, allowedOrders: [['repair-first', 'bypass-enabled']],
    seedPolicy: 'shared', referenceMemory: true, betweenTrials: 'none', receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_pm90' });
  const sha256 = receptionProtocolSha256(JSON.stringify(v2));
  storage.set('reception-protocol:current', { revision: 2, protocolId, sha256, savedAt });
  storage.set('reception-protocol:rev:0000000002', { revision: 2, sha256, savedAt, protocol: v2 });
  const rows = storage.snapshot(), release = await started(storage);
  assert.deepEqual(changedKeys(rows, storage.snapshot()), [MARKER]);
  assert.deepEqual(storage.snapshot()[MARKER], { at: storage.snapshot()[MARKER].at, outcome: 'kept', fromRevision: 2, toRevision: null });
  const { protocol } = await release.index.readReceptionSettings();
  assert.equal(protocol.protocol.schemaVersion, 'reception_protocol_v2'); assert.deepEqual([protocol.revision, protocol.protocol.rotationMode], [2, 'relative_pm90']);
  assert.deepEqual(release.prepared, []);
});

test('damaged settings are neither migrated nor marked, startup survives, and the protocol still fails closed until repaired', async () => {
  const storage = memory();
  assert.equal((await previousRelease(storage).saveReceptionProtocol({ expectedRevision: 0, fields: protocolFields() })).ok, true);
  const pointer = storage.snapshot()['reception-protocol:current'];
  storage.remove('reception-protocol:current');
  const damaged = storage.snapshot(), release = await started(storage);
  assert.deepEqual(storage.snapshot(), damaged, 'no marker and no new revision');
  assert.deepEqual(release.prepared, []);
  await assert.rejects(release.index.readReceptionSettings(), (error: any) => error.code === 'reception_unavailable');
  storage.set('reception-protocol:current', pointer);
  const repaired = await started(storage);
  assert.deepEqual(await rotationOf(repaired.index), [2, NEW]); assert.deepEqual(repaired.prepared, [2]);
});

// ── 画面と POST ──────────────────────────────────────────────────────────────────

const view = (protocol: unknown) => ({ protocol: protocol ? { revision: 3, savedAt: '2026-11-28T00:00:00.000Z', sha256: 'c'.repeat(64), protocol } : null,
  mode: { value: 'unset' as const, revision: 0 as const }, protocolHistory: [], modeHistory: [] });
const savedV3 = (rotationMode: string) => ({ schemaVersion: 'reception_protocol_v3', protocolId: '44444444-4444-4444-8444-444444444444', revision: 3,
  allowedOrders: [['repair-first']], seedPolicy: 'shared', referenceMemory: true, betweenTrials: 'none', receptionNumberFormat: 'daily_seq3', rotationMode,
  figureSelection: { mode: 'custom', figureIds: ['F1', 'F2', 'F3'] }, figureSetPolicy: 'shared' });
const radios = (html: string, name: string) => [...html.matchAll(new RegExp(`<input type="radio" name="${name}" value="([^"]*)" required( checked)?> ([^<]*)</label>`, 'gu'))]
  .map(m => [m[1], Boolean(m[2]), m[3]]);
const CHOICES = [[NEW, '相対 90°・180°・270°'], ['relative_pm90', '相対 ±90°（従来）'], ['relative_0', '相対 0°（向きを一致）']];

test('the rotation choices are the new mode (first, preselected before the first save), ±90° (legacy) and 0°; a saved value is the one preselected', () => {
  assert.deepEqual(radios(renderSettings(view(null) as any), 'rotationMode'), CHOICES.map(([value, label], i) => [value, i === 0, label]));
  for (const [value] of CHOICES) {
    assert.deepEqual(radios(renderSettings(view(savedV3(value)) as any), 'rotationMode'), CHOICES.map(([v, label]) => [v, v === value, label]), value);
  }
});

test('the reception list shows the rotation of each frozen plan', () => {
  const id = (n: number) => `6f8a064e-9bdb-4538-b553-a02eacd9442${n}`;
  const items = CHOICES.map(([rotationMode], n) => ({ receptionId: id(n), number: '00' + (n + 1), createdAt: '2026-11-28T00:00:00.000Z', status: 'approved' as const, revision: 1,
    plan: { order: ['repair-first' as const], rotationMode: rotationMode as any, betweenTrials: 'none' as const, figureSets: ['x'] }, trials: [{ index: 0, recordId: null }] }));
  const html = renderReceptions(items, null, { configured: true, mode: 'on', protocolId: id(9), revision: 2, sha256: 'a'.repeat(64), allowedOrders: [['repair-first']],
    rotationMode: NEW, betweenTrials: 'none' } as any);
  const shown = items.map((_, n) => html.match(new RegExp(`data-id="${id(n)}"[\\s\\S]*?data-label="回転">([^<]*)</td>`, 'u'))?.[1]);
  assert.deepEqual(shown, ['90°・180°・270°', '±90°', '0°']);
});

test('the experiment preview draws a record made under the new mode', () => {
  const selection = resolveFigureSelection({ mode: 'custom', figureIds: ['F1', 'F2', 'F3'] });
  const recordId = '6f8a064e-9bdb-4538-b553-a02eacd94425';
  const html = renderExperimentPreview({ recordId, seed: 8, status: 'dialogue', events: [], options: { rotationMode: NEW, figureSelection: selection } },
    { recordId, status: 'dialogue', updatedAt: '2026-11-28T00:00:00.000Z' } as any);
  assert.doesNotMatch(html, /図形を表示できません/u);
  assert.deepEqual([...html.matchAll(/<path d="([^"]+)"/gu)].map(m => m[1]),
    participantView(createTrialV2({ seed: 8, rotationMode: NEW, figureSelection: selection })).shapes.map((shape: { path: string }) => shape.path));
});

function adminOver(index: any) {
  const deps = { token: TOKEN, limiter: { async limit() { return { success: true }; } }, async listPage() { return { items: [], next: null }; },
    async getSummary() { return null; }, async getRecord() { return null; }, async deleteRecord() {}, async audit() { return []; }, summarizeLatency,
    receptionSettings: createReceptionSettingsPort(index) } as AdminDeps;
  return (path: string, form?: URLSearchParams) => handleAdmin(new Request(ORIGIN + path, { method: form ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + TOKEN, Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    ...(form ? { body: String(form) } : {}) }), deps);
}
test('the preselected rotation is what a new protocol saves, while a form without any rotation is still refused and never filled in', async () => {
  const storage = memory(), { index } = await started(storage), admin = adminOver(index);
  const page = await (await admin(SETTINGS)).text();
  const preselected = checkedValues(page, 'rotationMode');
  assert.equal(preselected.length, 1);
  const choices = [['orders', 'rf-be'], ['seedPolicy', 'shared'], ['referenceMemory', 'on'], ['betweenTrials', 'none'], ['receptionNumberFormat', 'daily_seq3'],
    ['figureMode', 'seeded_random'], ['figureSetPolicy', 'shared']];
  const form = submittedFrom(page); for (const [name, value] of choices) form.set(name, value);
  const withoutRotation = new URLSearchParams(form); withoutRotation.delete('rotationMode');
  const before = storage.snapshot();
  const refused = await admin(SETTINGS + '/protocol', withoutRotation);
  assert.equal(refused.status, 400); assert.deepEqual(storage.snapshot(), before);
  assert.equal((await admin(SETTINGS + '/protocol', form)).status, 303);
  const { protocol } = await index.readReceptionSettings();
  assert.deepEqual([protocol.revision, protocol.protocol.rotationMode], [1, preselected[0]]);
  assert.equal(protocol.protocol.rotationMode, (await index.receptionProtocolHistory())[0].protocol.rotationMode);
});

test('each rotation choice is accepted by the form, any other value is not', async () => {
  const storage = memory(), { index } = await started(storage), admin = adminOver(index);
  const base = submittedFrom(await (await admin(SETTINGS)).text());
  for (const [name, value] of [['orders', 'rf'], ['seedPolicy', 'shared'], ['referenceMemory', 'on'], ['betweenTrials', 'none'], ['receptionNumberFormat', 'daily_seq3'],
    ['figureMode', 'seeded_random'], ['figureSetPolicy', 'shared']]) base.set(name, value);
  for (const bad of ['relative_180', 'relative_90_180', '']) {
    const form = new URLSearchParams(base); form.set('rotationMode', bad);
    assert.equal((await admin(SETTINGS + '/protocol', form)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await index.readReceptionSettings()).protocol, null);
  let revision = 0;
  for (const [value] of CHOICES) {
    const form = new URLSearchParams(base); form.set('rotationMode', value); form.set('expectedRevision', String(revision));
    assert.equal((await admin(SETTINGS + '/protocol', form)).status, 303, value); revision++;
    assert.deepEqual(await rotationOf(index), [revision, value]);
  }
});

test('a saved 4- or 6-figure ±90° protocol is switched at startup with its figures kept; three figures then keep the new mode, and an explicit ±90° survives saves and starts', async () => {
  for (const figureIds of [['F1', 'F2', 'F3', 'F4'], ['F1', 'F2', 'F3', 'F4', 'F5', 'F6']]) {
    const storage = memory();
    assert.equal((await previousRelease(storage).saveReceptionProtocol({ expectedRevision: 0,
      fields: protocolFields({ rotationMode: 'relative_pm90', figureSelection: { mode: 'custom', figureIds } }) })).ok, true);
    const { index } = await started(storage), admin = adminOver(index);
    const save = async (form: URLSearchParams) => { assert.equal((await admin(SETTINGS + '/protocol', form)).status, 303); return (await index.readReceptionSettings()).protocol; };
    // The startup switch changed only the rotation (revision 2); the saved figures are history now, shown as a notice and not preselected.
    let page = await (await admin(SETTINGS)).text();
    assert.deepEqual((await index.readReceptionSettings()).protocol.protocol.figureSelection, { mode: 'custom', figureIds });
    assert.deepEqual(checkedValues(page, 'rotationMode'), [NEW]); assert.deepEqual(checkedValues(page, 'figureIds'), []);
    assert.ok(page.includes(`現在の設定は${figureIds.length}図形のため`));
    // Choosing three figures saves them with the rotation the page showed.
    const form = submittedFrom(page); form.set('figureMode', 'custom');
    for (const id of ['F1', 'F2', 'F3']) form.append('figureIds', id);
    let saved = await save(form);
    assert.deepEqual([saved.revision, saved.protocol.rotationMode, saved.protocol.figureSelection], [3, NEW, { mode: 'custom', figureIds: ['F1', 'F2', 'F3'] }]);
    // The researcher can then choose the legacy ±90° explicitly, see it again and save it again.
    page = await (await admin(SETTINGS)).text();
    const legacy = submittedFrom(page); legacy.set('rotationMode', 'relative_pm90');
    saved = await save(legacy);
    assert.deepEqual([saved.revision, saved.protocol.rotationMode], [4, 'relative_pm90']);
    page = await (await admin(SETTINGS)).text();
    assert.deepEqual(checkedValues(page, 'rotationMode'), ['relative_pm90']);
    saved = await save(submittedFrom(page));
    assert.deepEqual([saved.revision, saved.protocol.rotationMode, saved.protocol.figureSelection], [5, 'relative_pm90', { mode: 'custom', figureIds: ['F1', 'F2', 'F3'] }]);
    const settled = storage.snapshot(), again = await started(storage);
    assert.deepEqual(storage.snapshot(), settled, 'a later start does not rewrite the explicit ±90°'); assert.deepEqual(again.prepared, []);
  }
});
