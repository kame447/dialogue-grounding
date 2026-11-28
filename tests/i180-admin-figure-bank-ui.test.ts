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
import type { FigurePreset, FigurePresetPort } from '../workers/tangram-experiment/src/admin/figure-presets.ts';
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
    async savePostGenerationCheck() { throw new Error('unexpected save'); },
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

// #280: new receptions offer three-figure presets only. The older four- and six-figure sets stay as a lookup for the set ids that
// the reception list prints for receptions approved before, so they sit in their own closed block, never among the new presets.
test('figure catalogue page: the three-figure presets for new receptions are listed apart from the older four- and six-figure sets in a closed block', async () => {
  const presets: FigurePreset[] = [{ id: 'trio-01-v1', revision: 1, name: '3図形（F1–F3）', figureIds: ['F1', 'F2', 'F3'] },
    { id: ID, revision: 2, name: '確認用 <b>', figureIds: ['F2', 'F11', 'F30'] }];
  const presetPort = (list: () => Promise<FigurePreset[]>): FigurePresetPort => ({ list, async read() { return null; }, async save() { return { ok: true }; } });
  const catalogue = (figurePresets?: FigurePresetPort) => {
    const f = fixture();
    if (figurePresets) f.deps.receptionSettings = { ...f.deps.receptionSettings!, figurePresets };
    return handleAdmin(new Request(ORIGIN + '/admin/figures', { headers: auth }), f.deps);
  };
  const sections = (html: string) => new Map(html.split(/(?=<h2>)/u).slice(1).map(part => [part.match(/^<h2>([^<]*)<\/h2>/u)![1], part]));
  const labels = (html: string) => [...html.matchAll(/aria-label="(F\d+)"/gu)].map(match => match[1]);
  const titled = (section: string) => section.split('<h3>').slice(1).map(chunk => [chunk.slice(0, chunk.indexOf('</h3>')), labels(chunk)]);
  const CURRENT = '新しい受付のプリセット（3図形）', OLD = '旧い受付の図形セット（4・6図形）';

  const html = await (await catalogue(presetPort(async () => presets))).text(), parts = sections(html);
  assert.deepEqual([...parts.keys()], ['全30図形', CURRENT, OLD], 'bank, then the presets new receptions offer, then the older sets');
  const current = parts.get(CURRENT)!;
  assert.deepEqual(titled(current), [['3図形（F1–F3）', ['F1', 'F2', 'F3']], ['確認用 &lt;b&gt;', ['F2', 'F11', 'F30']]]);
  assert.match(current, /<a href="\/admin\/figure-presets">図形プリセットを管理<\/a>/u);
  assert.doesNotMatch(current, /<details|legacy-v1|pilot-four-v1|bank-set-|<b>/u, 'no older set among the new presets');
  const old = parts.get(OLD)!;
  assert.match(old, /^<h2>[^<]*<\/h2>\s*<details class="diag"><summary>図形セット（6件）<\/summary>/u);
  assert.equal((old.match(/<details/gu) ?? []).length, 1);
  assert.doesNotMatch(old, /<details[^>]*\sopen/u, 'closed by default');
  assert.deepEqual(titled(old), Object.entries(FIGURE_SETS).map(([id, ids]) => [id, [...ids]]), 'every older set is still listed, in full');
  assert.ok(Object.values(FIGURE_SETS).every(ids => ids.length === 4 || ids.length === 6), 'the heading names the sizes of these sets');
  assert.doesNotMatch(html.slice(0, html.indexOf(`<h2>${OLD}`)), /legacy-v1|pilot-four-v1|bank-set-/u, 'older set ids appear only under their own heading');

  const empty = sections(await (await catalogue(presetPort(async () => []))).text()).get(CURRENT)!;
  assert.match(empty, /表示中のプリセットはありません。/u); assert.deepEqual(labels(empty), []);
  const unmanaged = await (await catalogue()).text();
  assert.deepEqual([...sections(unmanaged).keys()], ['全30図形', OLD], 'without a preset port the page lists no new-reception section');
  assert.doesNotMatch(unmanaged, /figure-presets/u);
  const failed = await catalogue(presetPort(async () => { throw new Error('storage'); }));
  assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /<svg|storage/u);
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

test('settings form: only three figures are offered; a saved v2, four- or six-figure setting is a notice and never preselected, and a three-figure one preselects its own', () => {
  const choices = (html: string) => [...html.matchAll(/name="figureMode" value="(\w+)" required( checked)?/gu)].map(match => [match[1], Boolean(match[2])]);
  const notice = (html: string) => html.match(/<p class="bad">現在の設定は([^<]*)のため、新しい受付を許可できません。図形セットで3図形を選んで保存してください。<\/p>/u)?.[1];
  const v3 = (figureSetPolicy: string, figureSelection: unknown) => renderSettings(settingsView({ ...PROTOCOL_V2, schemaVersion: 'reception_protocol_v3', figureSetPolicy, figureSelection }) as any);
  const v2 = renderSettings(settingsView(PROTOCOL_V2) as any);
  assert.match(v2, /name="rotationMode" value="relative_pm90" required checked/u);
  assert.equal(notice(v2), '6図形');
  assert.equal((v2.match(/name="figureMode"[^>]*checked/gu) ?? []).length, 0); assert.equal((v2.match(/name="figureSetPolicy"[^>]*checked/gu) ?? []).length, 0);
  assert.equal((v2.match(/type="checkbox" name="figureIds"/gu) ?? []).length, 30);
  assert.match(v2, /保存しても、許可済みの受付の計画は変わりません。/u);
  // A saved four- or six-figure setting keeps its policy and other fields, but its figures are neither preselected nor offered again.
  for (const [html, count] of [[v3('shared', { mode: 'custom', figureIds: ['F3', 'F9', 'F12', 'F20', 'F21', 'F29'] }), '6図形'],
    [v3('shared', { mode: 'custom', figureIds: ['F1', 'F2', 'F3', 'F4'] }), '4図形'], [v3('per_trial', { mode: 'seeded_random', selectionSeed: 41 }), '6図形'],
    [v3('per_trial', { mode: 'seeded_random', selectionSeed: 41, figureCount: 4 }), '4図形'], [v3('shared', { mode: 'preset', setId: 'pilot-four-v1' }), '4図形'],
    [v3('shared', { mode: 'preset', setId: 'bank-set-d' }), '6図形'], [v3('shared', { mode: 'preset', setId: 'legacy-v1' }), '6図形']] as const) {
    assert.equal(notice(html), count);
    assert.ok(choices(html).every(([, checked]) => checked === false), 'no figure source is preselected: ' + count);
    assert.equal((html.match(/name="figureIds" value="F\d+" checked/gu) ?? []).length, 0);
    assert.doesNotMatch(html, /name="selectionSeed"[^>]*value=|name="figureSetId"|<option value="[46]"|3個・4個・6個|現在は\d+個で保存/u);
    assert.match(html, /<select name="figureCount"><option value="3">3<\/option><\/select>/u); assert.match(html, /図形を選ぶ（3個）/u);
  }
  assert.match(v3('per_trial', { mode: 'seeded_random', selectionSeed: 41 }), /name="figureSetPolicy" value="per_trial" required checked/u);
  // A three-figure setting preselects its own source and shows no notice.
  const custom = v3('shared', { mode: 'custom', figureIds: ['F3', 'F9', 'F12'] });
  assert.equal(notice(custom), undefined); assert.doesNotMatch(custom, /新しい受付を許可できません/u);
  assert.deepEqual(choices(custom), [['seeded_random', false], ['custom', true]]);
  assert.deepEqual([...custom.matchAll(/name="figureIds" value="(F\d+)" checked/gu)].map(match => match[1]), ['F3', 'F9', 'F12']);
  assert.match(custom, /name="figureSetPolicy" value="shared" required checked/u);
  const seeded = v3('per_trial', { mode: 'seeded_random', selectionSeed: 41, figureCount: 3 });
  assert.equal(notice(seeded), undefined); assert.deepEqual(choices(seeded), [['seeded_random', true], ['custom', false]]);
  assert.match(seeded, /name="selectionSeed"[^>]*value="41"/u); assert.match(seeded, /name="figureSetPolicy" value="per_trial" required checked/u);
  const unsaved = renderSettings({ protocol: null, mode: { value: 'unset', revision: 0 }, protocolHistory: [], modeHistory: [] });
  assert.deepEqual([...unsaved.matchAll(/name="(\w+)" value="([^"]*)" required checked/gu)].map(match => match.slice(1)), [['rotationMode', 'relative_90_180_270']],
    'before the first save only the default rotation is preselected');
  assert.equal((unsaved.match(/ checked/gu) ?? []).length, 1); assert.equal(notice(unsaved), undefined);
  assert.doesNotMatch(unsaved, /name="figureSetId"/u);
  assert.match(unsaved, /<select name="figureCount"><option value="3">3<\/option><\/select>/u);
  assert.match(unsaved, /図形を選ぶ（3個）/u);
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

// The form parser still reads four- and six-figure shapes (an old page can send them); refusing them is the saving side's job (#268).
test('protocol form parsing reads four-figure preset, random and custom shapes and rejects counts that are not figure counts', async () => {
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
