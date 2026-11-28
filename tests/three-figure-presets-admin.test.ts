import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ProtocolEntry, ReceptionSettings, SaveResult, SettingsStorage } from '../workers/tangram-experiment/src/admin/reception-settings.ts';
import type { FigurePreset } from '../workers/tangram-experiment/src/admin/figure-presets.ts';
import { renderReceptions } from '../workers/tangram-experiment/src/admin/render.ts';
import { submittedFrom } from './support/settings-form.ts';

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') {
    return { url: 'data:text/javascript,export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}', shortCircuit: true };
  }
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(specifier, context.parentURL);
    if (!existsSync(fileURLToPath(url)) && existsSync(fileURLToPath(url) + '.ts')) return next(url.href + '.ts', context);
  }
  return next(specifier, context);
} });
type TestIndex = {
  listFigurePresets(): Promise<FigurePreset[]>;
  readReceptionSettings(): Promise<ReceptionSettings>;
  receptionProtocolHistory(): Promise<ProtocolEntry[]>;
  saveReceptionProtocol(input: { expectedRevision: number; fields: unknown }): Promise<SaveResult>;
};
const { default: worker, AdminIndex } = await import(new URL('../workers/tangram-experiment/src/index.ts', import.meta.url).href) as {
  default: { fetch(request: Request, env: object): Promise<Response> };
  AdminIndex: new (context: { storage: object }, env: object) => TestIndex;
};
const ORIGIN = 'https://example.test';
const TOKEN = 'synthetic-admin-token-01234567890123456789';
const PRESETS = '/admin/figure-presets';
const SETTINGS = '/admin/reception-settings';
const TRIO = 'trio-01-v1';

function harness() {
  let rows = new Map<string, unknown>();
  let queue: Promise<unknown> = Promise.resolve();
  const view = (values: Map<string, unknown>): SettingsStorage => ({
    async get<T>(key: string) { return structuredClone(values.get(key)) as T | undefined; },
    async put(entries) { for (const [key, value] of Object.entries(entries)) values.set(key, structuredClone(value)); },
    async list<T>({ prefix }: { prefix: string }) {
      return new Map([...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value) as T]));
    },
  });
  const storage = {
    async list<T>(options: { prefix: string }) { return view(rows).list<T>(options); },
    async get<T>(key: string) { return view(rows).get<T>(key); },
    async transaction<T>(fn: (transaction: SettingsStorage) => Promise<T>) {
      const result = queue.then(async () => {
        const staged = structuredClone(rows), result = await fn(view(staged));
        rows = staged;
        return result;
      });
      queue = result.catch(() => {});
      return result;
    },
    async setAlarm() {},
  };
  const open = () => new AdminIndex({ storage }, {});
  let index = open();
  const env = { ADMIN_INDEX: { idFromName: (name: string) => name, get: () => index },
    ADMIN_TOKEN: TOKEN, ADMIN_RATE_LIMIT: { async limit() { return { success: true }; } } };
  return {
    get index() { return index; },
    reopen() { index = open(); },
    snapshot() { return JSON.stringify([...rows]); },
    async request(path: string, form?: URLSearchParams, headers: Record<string, string> = {}) {
      return worker.fetch(new Request(ORIGIN + path, {
        method: form === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + TOKEN, Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', ...headers },
        body: form,
      }), env);
    },
  };
}
const editorForm = (expectedRevision: number, name: string, figureIds: string[]) =>
  new URLSearchParams([['expectedRevision', String(expectedRevision)], ['name', name], ...figureIds.map(id => ['figureIds', id])]);
const protocolFields = {
  allowedOrders: [['repair-first', 'bypass-enabled']], seedPolicy: 'shared', referenceMemory: true, betweenTrials: 'none',
  receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_pm90', figureSetPolicy: 'shared',
};
const protocolForm = (expectedRevision: number, mode: string, choices: string[][]) =>
  new URLSearchParams([['expectedRevision', String(expectedRevision)], ['orders', 'rf-be'], ['seedPolicy', 'shared'],
    ['referenceMemory', 'on'], ['betweenTrials', 'none'], ['rotationMode', 'relative_pm90'], ['receptionNumberFormat', 'daily_seq3'],
    ['figureSetPolicy', 'shared'], ['figureMode', mode], ...choices]);
const selectPreset = (expectedRevision: number, presetRevision: number) =>
  protocolForm(expectedRevision, 'preset', [['figureSetId', `${TRIO}:${presetRevision}`]]);

test('the preset editor creates, renames, replaces and hides three-figure choices across cold reads', async () => {
  const h = harness();
  const initial = await h.index.listFigurePresets();
  assert.equal(initial.length, 10);
  assert.deepEqual(initial.flatMap(entry => entry.figureIds), Array.from({ length: 30 }, (_, i) => 'F' + (i + 1)));
  const create = await h.request(PRESETS + '/new');
  const html = await create.text();
  assert.equal(create.status, 200);
  assert.equal((html.match(/<svg /gu) ?? []).length, 30);
  assert.equal((html.match(/type="checkbox" name="figureIds"/gu) ?? []).length, 30);
  assert.match(html, /name="expectedRevision" value="0"/u);
  for (const form of [editorForm(0, ' ', ['F1', 'F2', 'F3']), editorForm(0, '名前', ['F1', 'F1', 'F3']),
    editorForm(0, '名前', ['F1', 'F2', 'F31']), editorForm(0, '名前', ['F1', 'F2', 'F3', 'F4'])]) {
    assert.equal((await h.request(PRESETS + '/new', form)).status, 400);
  }
  const form = editorForm(0, '確認用', ['F30', 'F2', 'F11']);
  assert.equal((await h.request(PRESETS + '/new', form, { Authorization: '' })).status, 401);
  assert.equal((await h.request(PRESETS + '/new', form, { Origin: 'https://other.test' })).status, 403);
  assert.equal((await h.index.listFigurePresets()).length, 10);
  const result = await h.request(PRESETS + '/new', form);
  assert.equal(result.status, 303);
  assert.equal(result.headers.get('Location'), PRESETS);
  h.reopen();
  const rows = await h.index.listFigurePresets();
  assert.equal(rows.length, 11);
  const created = rows.find(row => row.name === '確認用')!;
  assert.deepEqual(created.figureIds, ['F2', 'F11', 'F30']);
  const path = PRESETS + '/' + created.id;
  assert.equal((await h.request(path, editorForm(1, '改名 <確認>', created.figureIds))).status, 303);
  assert.equal((await h.request(path, editorForm(2, '改名 <確認>', ['F1', 'F3', 'F29']))).status, 303);
  const edited = await (await h.request(path)).text();
  assert.match(edited, /value="改名 &lt;確認&gt;"/u);
  assert.doesNotMatch(edited, /<確認>/u);
  assert.deepEqual([...edited.matchAll(/name="figureIds" value="(F\d+)" checked/gu)].map(match => match[1]), ['F1', 'F3', 'F29']);
  assert.equal((await h.request(path + '/hide', new URLSearchParams({ expectedRevision: '2' }))).status, 409);
  assert.equal((await h.request(path + '/hide', new URLSearchParams({ expectedRevision: '3' }))).status, 303);
  assert.equal((await h.request(PRESETS + '/' + TRIO + '/hide', new URLSearchParams({ expectedRevision: '1' }))).status, 303);
  h.reopen();
  assert.equal((await h.request(path)).status, 404);
  assert.equal((await h.request(PRESETS + '/' + TRIO)).status, 404);
  const list = await (await h.request(PRESETS)).text();
  assert.equal((await h.index.listFigurePresets()).length, 9);
  assert.match(list, /trio-10-v1/u);
  assert.doesNotMatch(list, /trio-01-v1|改名/u);
});

test('a preset revision is checked in the protocol transaction and only the three IDs are frozen', async () => {
  const h = harness();
  const beforeEdit = await (await h.request(SETTINGS)).text();
  assert.equal((beforeEdit.match(/name="figureSetId"/gu) ?? []).length, 10);
  assert.match(beforeEdit, /value="trio-01-v1:1"/u);
  assert.doesNotMatch(beforeEdit, /name="figureSetId" value="(?:legacy-v1|pilot-four-v1|bank-set-)|<option value="[46]">/u);
  const path = PRESETS + '/' + TRIO;
  assert.equal((await h.request(path, editorForm(1, '新しい名前', ['F1', 'F2', 'F3']))).status, 303);
  const state = h.snapshot();
  assert.equal((await h.request(SETTINGS + '/protocol', selectPreset(0, 1))).status, 409);
  assert.equal(h.snapshot(), state);
  assert.equal((await h.request(SETTINGS + '/protocol', selectPreset(0, 2))).status, 303);
  const first = (await h.index.readReceptionSettings()).protocol!;
  assert.deepEqual(first.protocol.schemaVersion === 'reception_protocol_v3' && first.protocol.figureSelection,
    { mode: 'custom', figureIds: ['F1', 'F2', 'F3'] });
  assert.doesNotMatch(JSON.stringify(first), /新しい名前|trio-|managed_preset/u);
  assert.equal((await h.request(path, editorForm(2, '新しい名前', ['F30', 'F2', 'F11']))).status, 303);
  assert.deepEqual((await h.index.readReceptionSettings()).protocol, first);
  const updated = await (await h.request(SETTINGS)).text();
  assert.match(updated, /value="trio-01-v1:3"[^>]*> 新しい名前 ・ F2、F11、F30/u);
  assert.deepEqual([...updated.matchAll(/name="figureIds" value="(F\d+)" checked/gu)].map(match => match[1]), ['F1', 'F2', 'F3']);
  assert.equal((await h.request(SETTINGS + '/protocol', selectPreset(1, 3))).status, 303);
  const second = (await h.index.readReceptionSettings()).protocol!;
  assert.deepEqual(second.protocol.schemaVersion === 'reception_protocol_v3' && second.protocol.figureSelection,
    { mode: 'custom', figureIds: ['F2', 'F11', 'F30'] });
  assert.equal((await h.request(path + '/hide', new URLSearchParams({ expectedRevision: '3' }))).status, 303);
  h.reopen();
  const afterHide = h.snapshot();
  assert.equal((await h.request(SETTINGS + '/protocol', selectPreset(2, 3))).status, 409);
  assert.equal(h.snapshot(), afterHide);
  assert.deepEqual(await h.index.receptionProtocolHistory(), [second, first]);
  assert.doesNotMatch(await (await h.request(SETTINGS)).text(), /trio-01-v1/u);
});

test('four- and six-figure settings are refused, never preselected or offered again, and choosing three figures migrates them with every other field kept', async () => {
  const cases = [
    { selection: { mode: 'preset', setId: 'pilot-four-v1' }, choices: [['figureSetId', 'pilot-four-v1']], count: '4図形' },
    { selection: { mode: 'seeded_random', selectionSeed: 17 }, choices: [['figureCount', '6'], ['selectionSeed', '17']], count: '6図形' },
    { selection: { mode: 'seeded_random', selectionSeed: 17, figureCount: 4 }, choices: [['figureCount', '4'], ['selectionSeed', '17']], count: '4図形' },
    { selection: { mode: 'custom', figureIds: ['F4', 'F1', 'F3', 'F2'] }, choices: ['F1', 'F2', 'F3', 'F4'].map(id => ['figureIds', id]), count: '4図形' },
    { selection: { mode: 'custom', figureIds: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'] }, choices: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'].map(id => ['figureIds', id]), count: '6図形' },
  ];
  for (const { selection, choices, count } of cases) {
    const h = harness();
    // The form never saves a four- or six-figure setting, whether or not it matches a saved one.
    const refused = await h.request(SETTINGS + '/protocol', protocolForm(0, selection.mode, choices));
    assert.equal(refused.status, 400); assert.match(await refused.text(), /図形セットは3図形にしてください/u);
    assert.equal((await h.index.readReceptionSettings()).protocol, null);
    // An earlier release saved it.
    assert.equal((await h.index.saveReceptionProtocol({ expectedRevision: 0, fields: { ...protocolFields, figureSelection: selection } })).ok, true);
    const previous = (await h.index.readReceptionSettings()).protocol!;
    const page = await (await h.request(SETTINGS)).text();
    assert.ok(page.includes(`<p class="bad">現在の設定は${count}のため、新しい受付を許可できません。図形セットで3図形を選んで保存してください。</p>`), count);
    assert.equal((page.match(/name="figureMode" value="\w+" required checked/gu) ?? []).length, 0, 'no figure source is preselected');
    assert.equal((page.match(/name="figureIds" value="F\d+" checked/gu) ?? []).length, 0);
    assert.doesNotMatch(page, /name="selectionSeed"[^>]*value=|<option value="[46]"|name="figureSetId" value="(?:legacy-v1|pilot-four-v1|bank-set-)/u);
    assert.equal((page.match(/name="figureSetId"/gu) ?? []).length, 10, 'only the three-figure presets are offered');
    const stored = h.snapshot();
    assert.equal((await h.request(SETTINGS + '/protocol', protocolForm(1, selection.mode, choices))).status, 400);
    assert.equal(h.snapshot(), stored, 'saving the same setting again writes nothing');

    // The researcher picks three figures; every other field is what the page showed from the saved setting.
    const migration = submittedFrom(page);
    migration.set('figureMode', 'preset'); migration.set('figureSetId', 'trio-01-v1:1');
    assert.equal((await h.request(SETTINGS + '/protocol', migration)).status, 303);
    const migrated = (await h.index.readReceptionSettings()).protocol!;
    assert.equal(migrated.revision, 2); assert.equal(migrated.protocol.protocolId, previous.protocol.protocolId);
    assert.deepEqual(migrated.protocol.schemaVersion === 'reception_protocol_v3' && migrated.protocol.figureSelection, { mode: 'custom', figureIds: ['F1', 'F2', 'F3'] });
    const { figureSelection: now, revision: nowRevision, ...kept } = migrated.protocol as any, { figureSelection: was, revision: wasRevision, ...before } = previous.protocol as any;
    assert.deepEqual(kept, before, 'orders, policies, rotation and the rest are unchanged');
    assert.notDeepEqual(now, was); assert.deepEqual([nowRevision, wasRevision], [2, 1]);
    const history = await h.index.receptionProtocolHistory();
    assert.equal(JSON.stringify(history[1]), JSON.stringify(previous), 'the earlier revision stays as it was');
    const after = await (await h.request(SETTINGS)).text();
    assert.doesNotMatch(after, /新しい受付を許可できません/u);
    assert.deepEqual([...after.matchAll(/name="figureIds" value="(F\d+)" checked/gu)].map(match => match[1]), ['F1', 'F2', 'F3']);
  }
});

test('individual approval carries the displayed protocol fields and has no figure selector', () => {
  const id = '6f8a064e-9bdb-4538-b553-a02eacd94425';
  const html = renderReceptions([{ receptionId: id, number: '001', createdAt: '2026-11-28T00:00:00.000Z',
    status: 'pending', revision: 0, plan: null, trials: [] }], null,
  { configured: true, mode: 'on', protocolId: id, revision: 2, sha256: 'a'.repeat(64), allowedOrders: [['repair-first']],
    rotationMode: 'relative_pm90', betweenTrials: 'none', figureSelection: { mode: 'custom', figureIds: ['F1', 'F2', 'F3'] } });
  const approval = html.match(/action="[^"]+\/approve">([\s\S]*?)<\/form>/u)?.[1] ?? '';
  assert.match(approval, /name="order"/u);
  assert.match(approval, /name="protocolRevision" value="2"/u);
  assert.match(approval, /name="protocolSha256"/u);
  assert.doesNotMatch(approval, /name="figure/u);
});

// #280: the catalogue lists what new receptions offer, and keeps the older four- and six-figure sets apart.
test('the figure catalogue lists the presets the settings form offers, through create, rename and hide, and keeps the older sets in a closed block of their own', async () => {
  const h = harness();
  const offered = async () => [...(await (await h.request(SETTINGS)).text()).matchAll(/name="figureSetId" value="[^"]*"> ([^<]*?) ・ ([^<]*)<\/label>/gu)]
    .map(match => [match[1], match[2].split('、')]);
  const catalogue = async () => {
    const html = await (await h.request('/admin/figures')).text();
    const current = html.split(/(?=<h2>)/u).find(part => part.startsWith('<h2>新しい受付のプリセット（3図形）</h2>'));
    assert.ok(current, 'the new-reception presets have a heading of their own');
    return { html, presets: current.split('<h3>').slice(1).map(chunk => [chunk.slice(0, chunk.indexOf('</h3>')), [...chunk.matchAll(/aria-label="(F\d+)"/gu)].map(match => match[1])]) };
  };
  const initial = await catalogue();
  assert.equal(initial.presets.length, 10);
  assert.deepEqual(initial.presets, await offered());
  assert.ok(initial.presets.every(([, ids]) => ids.length === 3));

  assert.equal((await h.request(PRESETS + '/new', editorForm(0, '確認用', ['F30', 'F2', 'F11']))).status, 303);
  const created = (await h.index.listFigurePresets()).find(row => row.name === '確認用')!;
  assert.equal((await h.request(PRESETS + '/' + TRIO + '/hide', new URLSearchParams({ expectedRevision: '1' }))).status, 303);
  assert.equal((await h.request(PRESETS + '/' + created.id, editorForm(1, '改名', ['F1', 'F3', 'F29']))).status, 303);
  const after = await catalogue();
  assert.deepEqual(after.presets, await offered());
  assert.equal(after.presets.length, 10);
  assert.ok(!after.presets.some(([name]) => name === '3図形（F1–F3）'), 'a hidden preset is no longer listed');
  assert.deepEqual(after.presets.at(-1), ['改名', ['F1', 'F3', 'F29']]);

  const olderHeading = '<h2>旧い受付の図形セット（4・6図形）</h2>';
  assert.doesNotMatch(after.html.slice(0, after.html.indexOf(olderHeading)), /legacy-v1|pilot-four-v1|bank-set-/u);
  assert.match(after.html, new RegExp(`${olderHeading}\\s*<details class="diag"><summary>図形セット（6件）</summary>`, 'u'));
  assert.doesNotMatch(after.html, /<details[^>]*\sopen/u);
});
