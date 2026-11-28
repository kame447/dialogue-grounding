// Issue #180 slice 3: researcher settings for the figure bank, the figure catalogue page and recorded figure sets. Synthetic values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { handleAdmin } from '../workers/tangram-experiment/src/admin/routes.ts';
import type { AdminDeps } from '../workers/tangram-experiment/src/admin/routes.ts';
import { summarizeLatency } from '../workers/tangram-experiment/src/admin/latency.ts';
import { renderSettings, renderReceptions, renderDetail, renderExperimentPreview, renderFigures } from '../workers/tangram-experiment/src/admin/render.ts';
import { readSettings, saveProtocol, protocolHistory } from '../workers/tangram-experiment/src/admin/reception-settings.ts';
import type { SettingsStorage } from '../workers/tangram-experiment/src/admin/reception-settings.ts';
import { validateReceptionProtocolV2, receptionProtocolSha256 } from '../dialogue-model/runtime/v2/reception.ts';
import { createTrialV2, participantView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { FIGURE_BANK, FIGURE_SETS, resolveFigureSelection } from '../dialogue-model/runtime/stimuli/figure-bank.ts';

const TOKEN = 'synthetic-admin-token-01234567890123456789';
const ORIGIN = 'https://example.test';
const ID = '0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f';

function fixture() {
  const calls: { op: string; args: unknown[] }[] = [];
  const port = {
    async read() { return { protocol: null, mode: { value: 'unset', revision: 0 }, protocolHistory: [], modeHistory: [] }; },
    async saveProtocol(input: unknown) { calls.push({ op: 'saveProtocol', args: [input] }); return { ok: true }; },
    async saveMode(input: unknown) { calls.push({ op: 'saveMode', args: [input] }); return { ok: true }; },
  };
  const deps = { token: TOKEN, limiter: { async limit() { return { success: true }; } },
    async listPage() { return { items: [], next: null }; }, async getSummary() { return null; }, async getRecord() { return null; },
    async deleteRecord() {}, async audit() { return []; }, summarizeLatency, receptionSettings: port } as AdminDeps;
  return { deps, calls };
}
const auth = { Authorization: 'Bearer ' + TOKEN };
const base = [['expectedRevision', '0'], ['orders', 'rf-be'], ['seedPolicy', 'shared'], ['referenceMemory', 'on'], ['betweenTrials', 'none'],
  ['rotationMode', 'relative_pm90'], ['receptionNumberFormat', 'daily_seq3']];
const post = (extra: string[][]) => new Request(`${ORIGIN}/admin/reception-settings/protocol`, { method: 'POST',
  headers: { ...auth, Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams([...base, ...extra]).toString() });
async function saved(extra: string[][]) {
  const f = fixture(), response = await handleAdmin(post(extra), f.deps);
  return { status: response.status, fields: (f.calls[0]?.args[0] as any)?.fields, writes: f.calls.length };
}

test('figure catalogue page: authenticated, strict CSP, 30 figures and six candidate sets drawn as inline SVG with no inline style', async () => {
  const f = fixture();
  assert.equal((await handleAdmin(new Request(ORIGIN + '/admin/figures'), f.deps)).status, 401);
  const response = await handleAdmin(new Request(ORIGIN + '/admin/figures', { headers: auth }), f.deps);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Security-Policy') ?? '', /style-src 'self'/u);
  const html = await response.text();
  assert.equal(FIGURE_BANK.length, 30);
  assert.equal((html.match(/<svg /gu) ?? []).length, 30 + 30 + 4, 'all figures once, five legacy sets of six and the four-figure pilot set');
  for (const id of Object.keys(FIGURE_SETS)) assert.ok(html.includes(`<h3>${id}</h3>`), id);
  assert.doesNotMatch(html, /<style|\sstyle=/u);
  assert.match(html, /予備検討用/u);
  assert.match(html, /<a href="\/admin\/figures" aria-current="page">図形一覧<\/a>/u);
});

test('protocol form: each figure mode and policy is explicit, and the saved fields follow it', async () => {
  const preset = await saved([['figureMode', 'preset'], ['figureSetId', 'bank-set-b'], ['figureSetPolicy', 'shared']]);
  assert.equal(preset.status, 303);
  assert.deepEqual(preset.fields.figureSelection, { mode: 'preset', setId: 'bank-set-b' }); assert.equal(preset.fields.figureSetPolicy, 'shared');
  const auto = await saved([['figureMode', 'seeded_random'], ['selectionSeed', ''], ['figureSetPolicy', 'per_trial']]);
  assert.equal(auto.status, 303); assert.deepEqual(auto.fields.figureSelection, { mode: 'seeded_random', selectionSeed: null, figureCount: 3 }); assert.equal(auto.fields.figureSetPolicy, 'per_trial');
  const fixed = await saved([['figureMode', 'seeded_random'], ['selectionSeed', ' -17 '], ['figureSetPolicy', 'shared']]);
  assert.deepEqual(fixed.fields.figureSelection, { mode: 'seeded_random', selectionSeed: -17, figureCount: 3 });
  const ids = ['F30', 'F2', 'F11', 'F7', 'F19', 'F25'];
  const custom = await saved([['figureMode', 'custom'], ...ids.map(id => ['figureIds', id]), ['figureSetPolicy', 'shared']]);
  assert.equal(custom.status, 303);
  assert.deepEqual(custom.fields.figureSelection, { mode: 'custom', figureIds: ['F2', 'F7', 'F11', 'F19', 'F25', 'F30'] }, 'bank order, whatever the click order');
  // Inputs that belong to another mode are ignored.
  const ignored = await saved([['figureMode', 'preset'], ['figureSetId', 'legacy-v1'], ['selectionSeed', 'abc'], ['figureIds', 'F1'], ['figureSetPolicy', 'shared']]);
  assert.equal(ignored.status, 303); assert.deepEqual(ignored.fields.figureSelection, { mode: 'preset', setId: 'legacy-v1' });
});

test('protocol form fails closed without writing for missing, unknown or contradictory figure fields', async () => {
  const six = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'].map(id => ['figureIds', id]);
  const bad: string[][][] = [
    [['figureSetPolicy', 'shared']], [['figureMode', 'preset'], ['figureSetId', 'bank-set-a']], [['figureMode', 'mystery'], ['figureSetPolicy', 'shared']],
    [['figureMode', 'preset'], ['figureSetPolicy', 'shared']], [['figureMode', 'preset'], ['figureSetId', 'nope'], ['figureSetPolicy', 'shared']],
    [['figureMode', 'preset'], ['figureSetId', 'bank-set-a'], ['figureSetPolicy', 'per_trial']],
    [['figureMode', 'custom'], ...six, ['figureSetPolicy', 'per_trial']],
    [['figureMode', 'custom'], ...six.slice(0, 5), ['figureSetPolicy', 'shared']], [['figureMode', 'custom'], ...six, ['figureIds', 'F7'], ['figureSetPolicy', 'shared']],
    [['figureMode', 'custom'], ...six.slice(0, 5), ['figureIds', 'F1'], ['figureSetPolicy', 'shared']], [['figureMode', 'custom'], ...six.slice(0, 5), ['figureIds', 'F31'], ['figureSetPolicy', 'shared']],
    [['figureMode', 'seeded_random'], ['selectionSeed', '1.5'], ['figureSetPolicy', 'shared']], [['figureMode', 'seeded_random'], ['selectionSeed', '99999999999999999999'], ['figureSetPolicy', 'shared']],
    [['figureMode', 'seeded_random'], ['figureSetPolicy', 'shared'], ['figureSetPolicy', 'per_trial']], [['figureMode', 'seeded_random'], ['figureMode', 'preset'], ['figureSetPolicy', 'shared']],
    [['figureMode', 'seeded_random'], ['figureSetPolicy', 'shared'], ['surprise', '1']],
  ];
  for (const extra of bad) { const r = await saved(extra); assert.equal(r.status, 400, JSON.stringify(extra)); assert.equal(r.writes, 0, JSON.stringify(extra)); }
});

const PROTOCOL_V2 = { schemaVersion: 'reception_protocol_v2', protocolId: ID, revision: 2, allowedOrders: [['repair-first', 'bypass-enabled']], seedPolicy: 'shared',
  referenceMemory: true, betweenTrials: 'none', receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_pm90' };
const settingsView = (protocol: any) => ({ protocol: { revision: protocol.revision, savedAt: '2026-11-24T00:00:00.000Z', sha256: 'c'.repeat(64), protocol },
  mode: { value: 'unset' as const, revision: 0 as const }, protocolHistory: [], modeHistory: [] });

test('settings form: a saved v2 protocol keeps its fields preselected but leaves the figure fields for an explicit choice; a v3 protocol preselects its own', () => {
  const v2 = renderSettings(settingsView(PROTOCOL_V2) as any);
  assert.match(v2, /name="rotationMode" value="relative_pm90" required checked/u);
  assert.equal((v2.match(/name="figureMode"[^>]*checked/gu) ?? []).length, 0); assert.equal((v2.match(/name="figureSetPolicy"[^>]*checked/gu) ?? []).length, 0);
  assert.equal((v2.match(/type="checkbox" name="figureIds"/gu) ?? []).length, 30);
  assert.match(v2, /保存しても、許可済みの受付の計画は変わりません。/u);
  const custom = renderSettings(settingsView({ ...PROTOCOL_V2, schemaVersion: 'reception_protocol_v3', figureSetPolicy: 'shared',
    figureSelection: { mode: 'custom', figureIds: ['F3', 'F9', 'F12', 'F20', 'F21', 'F29'] } }) as any);
  assert.match(custom, /name="figureMode" value="custom" required checked/u); assert.match(custom, /name="figureSetPolicy" value="shared" required checked/u);
  assert.equal((custom.match(/name="figureIds" value="F\d+" checked/gu) ?? []).length, 6);
  const seeded = renderSettings(settingsView({ ...PROTOCOL_V2, schemaVersion: 'reception_protocol_v3', figureSetPolicy: 'per_trial',
    figureSelection: { mode: 'seeded_random', selectionSeed: 41 } }) as any);
  assert.match(seeded, /name="selectionSeed"[^>]*value="41"/u); assert.match(seeded, /name="figureSetPolicy" value="per_trial" required checked/u);
  const unsaved = renderSettings({ protocol: null, mode: { value: 'unset', revision: 0 }, protocolHistory: [], modeHistory: [] });
  assert.equal((unsaved.match(/ checked/gu) ?? []).length, 0, 'nothing is preselected before the first save');
  assert.doesNotMatch(unsaved, /name="figureSetId"/u);
  assert.match(unsaved, /<select name="figureCount"><option value="3">3<\/option><option value="4">4<\/option><option value="6">6<\/option>/u);
  assert.match(unsaved, /図形を選ぶ（3個・4個・6個）/u);
  for (const [id, label] of [['pilot-four-v1', '4図形（F1–F4）'], ['bank-set-d', 'bank-set-d（F25–F30）']]) {
    const preset = renderSettings(settingsView({ ...PROTOCOL_V2, schemaVersion: 'reception_protocol_v3', figureSetPolicy: 'shared',
      figureSelection: { mode: 'preset', setId: id } }) as any);
    assert.deepEqual([...preset.matchAll(/name="figureSetId" value="([^"]+)" checked> ([^<]+)/gu)].map(match => match.slice(1)), [[id, label]]);
    assert.equal((preset.match(/name="figureSetId"/gu) ?? []).length, 1);
  }
});

function memory(): SettingsStorage & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return { values, async get(key) { return values.get(key) as never; }, async put(entries) { for (const [k, v] of Object.entries(entries)) values.set(k, structuredClone(v)); },
    async list({ prefix }) { return new Map([...values].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)) as never); } };
}

test('stored v2 protocols stay readable; the next save is v3, keeps the protocol id and needs both figure fields', async () => {
  const storage = memory();
  const v2 = validateReceptionProtocolV2(PROTOCOL_V2), sha256 = receptionProtocolSha256(JSON.stringify(v2)), savedAt = '2026-11-24T00:00:00.000Z';
  await storage.put({ 'reception-protocol:current': { revision: 2, protocolId: ID, sha256, savedAt }, 'reception-protocol:rev:0000000002': { revision: 2, sha256, savedAt, protocol: v2 } });
  const before = await readSettings(storage);
  assert.equal(before.protocol?.protocol.schemaVersion, 'reception_protocol_v2');
  const fields = { allowedOrders: v2.allowedOrders, seedPolicy: 'shared', referenceMemory: true, betweenTrials: 'none', receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_pm90' };
  assert.deepEqual(await saveProtocol(storage, { expectedRevision: 2, fields }, Date.parse(savedAt), randomUUID), { ok: false, error: 'invalid' });
  assert.deepEqual(await saveProtocol(storage, { expectedRevision: 2, fields: { ...fields, figureSelection: { mode: 'preset', setId: 'bank-set-c' } } }, Date.parse(savedAt), randomUUID), { ok: false, error: 'invalid' });
  const result = await saveProtocol(storage, { expectedRevision: 2, fields: { ...fields, figureSelection: { mode: 'preset', setId: 'bank-set-c' }, figureSetPolicy: 'shared' } }, Date.parse(savedAt) + 1000, randomUUID);
  assert.deepEqual(result, { ok: true, revision: 3 });
  const after = await readSettings(storage);
  assert.equal(after.protocol?.protocol.schemaVersion, 'reception_protocol_v3'); assert.equal(after.protocol?.protocol.protocolId, ID);
  assert.deepEqual((await protocolHistory(storage)).map(h => h.protocol.schemaVersion), ['reception_protocol_v3', 'reception_protocol_v2']);
  assert.deepEqual(await saveProtocol(storage, { expectedRevision: 3, fields: { ...fields, figureSelection: { mode: 'preset', setId: 'bank-set-a' }, figureSetPolicy: 'per_trial' } }, Date.parse(savedAt) + 2000, randomUUID), { ok: false, error: 'invalid' });
});

test('reception list shows the frozen figure set per plan, and `A → B` when the trials differ', () => {
  const row = (figureSets: string[] | undefined) => ({ receptionId: ID, number: '001', createdAt: '2026-11-24T00:00:00.000Z', status: 'approved' as const, revision: 1,
    plan: { order: ['repair-first', 'bypass-enabled'] as ('repair-first' | 'bypass-enabled')[], rotationMode: 'relative_pm90' as const, betweenTrials: 'none' as const, ...(figureSets ? { figureSets } : {}) }, trials: [] });
  const html = renderReceptions([row(['bank-set-a', 'bank-set-a']), { ...row(['seeded-11111111', 'seeded-22222222']), receptionId: randomUUID() }, { ...row(undefined), receptionId: randomUUID() }], null, { configured: false, mode: 'on' });
  assert.match(html, /<td data-label="図形セット">bank-set-a<\/td>/u);
  assert.match(html, /<td data-label="図形セット">seeded-11111111 → seeded-22222222<\/td>/u);
  assert.match(html, /<td data-label="図形セット"><\/td>/u);
});

const summary = { recordId: ID, objectId: 'a'.repeat(64), status: 'completed', aiStatus: 'idle', questionnaire: 'none', startedAt: '2026-11-24T00:00:00.000Z', updatedAt: '2026-11-24T00:01:00.000Z',
  strategy: 'repair-first', referenceMemory: true, utteranceStyle: 'default', counts: { humanMessages: 0, aiMessages: 0, committedTurns: 0, attempts: 0 }, errorCodes: [] } as any;

test('record detail shows the recorded figure set, or the legacy six figures for an older record', () => {
  const selection = resolveFigureSelection({ mode: 'seeded_random', selectionSeed: 12 });
  const trial = createTrialV2({ seed: 5, rotationMode: 'relative_pm90', figureSelection: selection });
  const stimulus = { version: 'x', rotationMode: 'relative_pm90', angles: { human: {}, ai: {} }, bankVersion: selection.bankVersion, figureSetId: selection.setId,
    figureIds: [...selection.figureIds], selectionSeed: 12, selectionMode: 'seeded_random' };
  assert.ok(trial);
  const html = renderDetail({ recordId: ID, stimulus, options: { figureSelection: selection }, events: [] }, summary, summarizeLatency({}), 30);
  for (const text of [selection.setId as string, selection.bankVersion, ...selection.figureIds, 'seeded_random', '12']) assert.ok(html.includes(text), text);
  assert.match(renderDetail({ recordId: ID, events: [] }, summary, summarizeLatency({}), 30), /未記録（従来の6図形 F1–F6）/u);
});

test('experiment preview draws the recorded figures; an invalid selection never breaks the conversation view', () => {
  const selection = resolveFigureSelection({ mode: 'preset', setId: 'bank-set-d' });
  const record = (figureSelection?: unknown) => ({ recordId: ID, seed: 8, status: 'dialogue', events: [{ id: 'e1', speaker: 'ai', text: '合成の発話', at: '2026-11-24T00:00:00.000Z' }],
    options: { rotationMode: 'relative_pm90', ...(figureSelection === undefined ? {} : { figureSelection }) } });
  const paths = (html: string) => [...html.matchAll(/<path d="([^"]+)"/gu)].map(m => m[1]);
  const expected = (figureSelection?: unknown) => participantView(createTrialV2({ seed: 8, rotationMode: 'relative_pm90', ...(figureSelection ? { figureSelection } : {}) })).shapes.map((s: { path: string }) => s.path);
  assert.deepEqual(paths(renderExperimentPreview(record(selection), summary)), expected(selection));
  assert.deepEqual(paths(renderExperimentPreview(record(), summary)), expected());
  assert.notDeepEqual(expected(selection), expected());
  const broken = renderExperimentPreview(record({ ...selection, figureIds: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'] }), summary);
  assert.match(broken, /図形を表示できません/u); assert.match(broken, /合成の発話/u);
});


test('three-figure protocol form accepts explicit random and arbitrary custom choices', async () => {
  const random = await saved([['figureMode', 'seeded_random'], ['figureCount', '3'], ['selectionSeed', '41'], ['figureSetPolicy', 'shared']]);
  assert.equal(random.status, 303);
  assert.deepEqual(random.fields.figureSelection, { mode: 'seeded_random', selectionSeed: 41, figureCount: 3 });
  const ids = ['F30', 'F2', 'F11'];
  const custom = (ids: string[]) => saved([['figureMode', 'custom'], ...ids.map(id => ['figureIds', id]), ['figureSetPolicy', 'shared']]);
  const selected = await custom(ids);
  assert.equal(selected.status, 303);
  assert.deepEqual(selected.fields.figureSelection, { mode: 'custom', figureIds: ['F2', 'F11', 'F30'] });
  for (const invalid of [['F2', 'F30'], ['F2', 'F2', 'F30'], ['F2', 'F11', 'F31']]) {
    assert.deepEqual(await custom(invalid), { status: 400, writes: 0, fields: undefined });
  }
});

test('four-figure protocol form saves preset, random and custom choices without changing the six-figure form', async () => {
  const preset = await saved([['figureMode', 'preset'], ['figureSetId', 'pilot-four-v1'], ['figureSetPolicy', 'shared']]);
  assert.equal(preset.status, 303);
  assert.deepEqual(preset.fields.figureSelection, { mode: 'preset', setId: 'pilot-four-v1' });
  const random = await saved([['figureMode', 'seeded_random'], ['figureCount', '4'], ['selectionSeed', '41'], ['figureSetPolicy', 'per_trial']]);
  assert.equal(random.status, 303);
  assert.deepEqual(random.fields.figureSelection, { mode: 'seeded_random', selectionSeed: 41, figureCount: 4 });
  assert.equal(random.fields.figureSetPolicy, 'per_trial');
  const custom = await saved([['figureMode', 'custom'], ...['F4', 'F1', 'F3', 'F2'].map(id => ['figureIds', id]), ['figureSetPolicy', 'shared']]);
  assert.equal(custom.status, 303);
  assert.deepEqual(custom.fields.figureSelection, { mode: 'custom', figureIds: ['F1', 'F2', 'F3', 'F4'] });
  for (const count of ['2', '5', '7', '3.0', '03', '']) {
    const invalid = await saved([['figureMode', 'seeded_random'], ['figureCount', count], ['figureSetPolicy', 'shared']]);
    assert.equal(invalid.status, 400, count); assert.equal(invalid.writes, 0, count);
  }
  const repeated = await saved([['figureMode', 'seeded_random'], ['figureCount', '4'], ['figureCount', '6'], ['figureSetPolicy', 'shared']]);
  assert.equal(repeated.status, 400); assert.equal(repeated.writes, 0);
  for (const count of [4, 6]) {
    const html = renderSettings(settingsView({ ...PROTOCOL_V2, schemaVersion: 'reception_protocol_v3', figureSetPolicy: 'per_trial',
      figureSelection: { mode: 'seeded_random', selectionSeed: 41, ...(count === 4 ? { figureCount: 4 } : {}) } }) as any);
    assert.ok(html.includes(`<option value="${count}" selected>${count}</option>`));
  }
});

test('saving a four-figure revision preserves the previous six-figure protocol and all other settings', async () => {
  const storage = memory();
  const fields = { allowedOrders: [['repair-first', 'bypass-enabled']], seedPolicy: 'per_trial', referenceMemory: true,
    betweenTrials: 'questionnaire_required', receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_0',
    figureSelection: { mode: 'seeded_random', selectionSeed: 41 }, figureSetPolicy: 'per_trial' };
  const time = Date.parse('2026-11-27T00:00:00.000Z');
  assert.deepEqual(await saveProtocol(storage, { expectedRevision: 0, fields }, time, randomUUID), { ok: true, revision: 1 });
  const before = await readSettings(storage);
  assert.deepEqual(await saveProtocol(storage, { expectedRevision: 1,
    fields: { ...fields, figureSelection: { ...fields.figureSelection, figureCount: 4 } } }, time + 1000, randomUUID), { ok: true, revision: 2 });
  const after = await readSettings(storage), history = await protocolHistory(storage);
  assert.equal(after.protocol?.protocol.protocolId, before.protocol?.protocol.protocolId);
  assert.deepEqual(history[1], before.protocol);
  assert.deepEqual(after.protocol?.protocol, { ...before.protocol!.protocol, revision: 2,
    figureSelection: { ...fields.figureSelection, figureCount: 4 } });
});
