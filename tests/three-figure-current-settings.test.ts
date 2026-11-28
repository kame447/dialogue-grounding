// #268: new receptions come only from a three-figure setting. A saved four- or six-figure (or v2) setting stays readable
// as history and for restores, but cannot be saved again, approved from, or prepared for; the pages say how to migrate.
// Synthetic values only; none of them is a research choice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { handleAdmin } from '../workers/tangram-experiment/src/admin/routes.ts';
import type { AdminDeps } from '../workers/tangram-experiment/src/admin/routes.ts';
import { renderReceptions } from '../workers/tangram-experiment/src/admin/render.ts';
import { createReceptionAdminPort } from '../workers/tangram-experiment/src/admin/reception-adapter.ts';
import { saveProtocolFromForm, usesThreeFigures } from '../workers/tangram-experiment/src/admin/reception-settings.ts';
import type { SettingsStorage } from '../workers/tangram-experiment/src/admin/reception-settings.ts';
import type { ReceptionAdminRow, ReceptionProtocolStatus, ProtocolFormInput } from '../workers/tangram-experiment/src/admin/reception-port.ts';
import { summarizeLatency } from '../workers/tangram-experiment/src/admin/latency.ts';
import { receptionProtocolSha256, validateReceptionProtocolV2, validateReceptionProtocolV3 } from '../dialogue-model/runtime/v2/reception.ts';

registerHooks({ resolve(s, c, next) {
  if (s === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}', shortCircuit: true };
  return next(s, c);
} });

const TOKEN = 'synthetic-admin-token-01234567890123456789', ORIGIN = 'https://example.test';
const PROTOCOL_ID = '44444444-4444-4444-8444-444444444444', RECEPTION = '6f8a064e-9bdb-4538-b553-a02eacd94425', SHA = 'a'.repeat(64);
const THREE = [{ mode: 'custom', figureIds: ['F1', 'F2', 'F3'] }, { mode: 'seeded_random', selectionSeed: 5, figureCount: 3 }, { mode: 'seeded_random', selectionSeed: null, figureCount: 3 }] as const;
const LEGACY = [{ mode: 'custom', figureIds: ['F1', 'F2', 'F3', 'F4'] }, { mode: 'custom', figureIds: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'] },
  { mode: 'seeded_random', selectionSeed: 5, figureCount: 4 }, { mode: 'seeded_random', selectionSeed: 5, figureCount: 6 }, { mode: 'seeded_random', selectionSeed: 5 },
  { mode: 'preset', setId: 'pilot-four-v1' }, { mode: 'preset', setId: 'legacy-v1' }, { mode: 'preset', setId: 'bank-set-c' }] as const;
const v3 = (figureSelection: unknown) => validateReceptionProtocolV3({ schemaVersion: 'reception_protocol_v3', protocolId: PROTOCOL_ID, revision: 2,
  allowedOrders: [['repair-first', 'bypass-enabled']], seedPolicy: 'shared', referenceMemory: true, betweenTrials: 'none', receptionNumberFormat: 'daily_seq3',
  rotationMode: 'relative_pm90', figureSelection, figureSetPolicy: 'shared' });
const v2 = () => validateReceptionProtocolV2({ schemaVersion: 'reception_protocol_v2', protocolId: PROTOCOL_ID, revision: 2, allowedOrders: [['repair-first']],
  seedPolicy: 'shared', referenceMemory: true, betweenTrials: 'none', receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_pm90' });

test('only a custom or seeded selection of exactly three figures is three figures', () => {
  for (const selection of THREE) assert.equal(usesThreeFigures(v3(selection)), true, JSON.stringify(selection));
  for (const selection of LEGACY) assert.equal(usesThreeFigures(v3(selection)), false, JSON.stringify(selection));
  assert.equal(usesThreeFigures(v2()), false, 'a v2 protocol has no figure fields: the legacy six');
});

// ── 保存（サーバ側）────────────────────────────────────────────────────────────

function memory(): SettingsStorage & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return { values, async get(key) { return structuredClone(values.get(key)) as never; }, async put(entries) { for (const [k, v] of Object.entries(entries)) values.set(k, structuredClone(v)); },
    async list({ prefix }) { return new Map([...values].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, structuredClone(v)]) as never); } };
}
const form = (figureSelection: unknown, patch: Record<string, unknown> = {}): ProtocolFormInput => ({ expectedRevision: 0, fields: { allowedOrders: [['repair-first']], seedPolicy: 'shared',
  referenceMemory: true, betweenTrials: 'none', receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_0', figureSelection, figureSetPolicy: 'shared', ...patch } as never });

test('the server saves a three-figure selection and refuses every other one, writing nothing', async () => {
  for (const selection of LEGACY) {
    const storage = memory();
    assert.deepEqual(await saveProtocolFromForm(storage, form(selection), 0, () => PROTOCOL_ID), { ok: false, error: 'three_figures_required' }, JSON.stringify(selection));
    assert.equal(storage.values.size, 0);
  }
  for (const selection of THREE) {
    const storage = memory();
    assert.deepEqual(await saveProtocolFromForm(storage, form(selection), 0, () => PROTOCOL_ID), { ok: true, revision: 1 }, JSON.stringify(selection));
  }
  // A stale revision is still a conflict for a three-figure selection.
  assert.deepEqual(await saveProtocolFromForm(memory(), { ...form(THREE[0]), expectedRevision: 3 }, 0, () => PROTOCOL_ID), { ok: false, error: 'conflict' });
});

function settingsDeps(save: () => Promise<unknown>): AdminDeps {
  return { token: TOKEN, limiter: { async limit() { return { success: true }; } }, async listPage() { return { items: [], next: null }; }, async getSummary() { return null; },
    async getRecord() { return null; }, async deleteRecord() {}, async audit() { return []; }, summarizeLatency,
    receptionSettings: { async read() { throw new Error('unused'); }, saveProtocol: save, async saveMode() { throw new Error('unused'); }, async savePostGenerationCheck() { throw new Error('unused'); } } } as unknown as AdminDeps;
}
test('the form route says why a four- or six-figure save is refused, and the page that sent it must be reopened', async () => {
  const body = new URLSearchParams([['expectedRevision', '0'], ['orders', 'rf'], ['seedPolicy', 'shared'], ['referenceMemory', 'on'], ['betweenTrials', 'none'],
    ['rotationMode', 'relative_0'], ['receptionNumberFormat', 'daily_seq3'], ['figureMode', 'seeded_random'], ['figureCount', '4'], ['selectionSeed', ''], ['figureSetPolicy', 'shared']]);
  const response = await handleAdmin(new Request(ORIGIN + '/admin/reception-settings/protocol', { method: 'POST', body: String(body),
    headers: { Authorization: 'Bearer ' + TOKEN, Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded' } }),
  settingsDeps(async () => ({ ok: false, error: 'three_figures_required' })));
  assert.equal(response.status, 400);
  const html = await response.text();
  assert.match(html, /保存していません/u); assert.match(html, /図形セットは3図形にしてください。設定画面を開き直して、3図形を選んでから保存してください。/u);
});

// ── 受付の許可（サーバ側）──────────────────────────────────────────────────────

const row: ReceptionAdminRow = { receptionId: RECEPTION, number: '001', createdAt: '2026-11-28T00:00:00.000Z', status: 'pending', revision: 0, plan: null, trials: [] };
const status = (extra: Partial<Extract<ReceptionProtocolStatus, { configured: true }>> = {}): ReceptionProtocolStatus => ({ configured: true, mode: 'on', protocolId: PROTOCOL_ID,
  revision: 2, sha256: SHA, allowedOrders: [['repair-first']], rotationMode: 'relative_pm90', betweenTrials: 'none', ...extra });

test('the reception list offers approval only for a three-figure setting and tells the researcher where to migrate otherwise', () => {
  const approvable = renderReceptions([row], null, status());
  assert.match(approvable, /action="\/admin\/reception\/[^"]+\/approve"/u); assert.doesNotMatch(approvable, /3図形ではない/u);
  const legacy = renderReceptions([row], null, status({ legacyFigures: true }));
  assert.doesNotMatch(legacy, /\/approve"/u, 'no approval form');
  assert.match(legacy, /<p class="bad">現在の設定は3図形ではないため、許可できません（<a href="\/admin\/reception-settings">受付の設定<\/a>）<\/p>/u);
  assert.match(legacy, /プロトコル設定済み: /u);
  // Receptions that are already approved keep their rows and their actions.
  const approved: ReceptionAdminRow = { ...row, status: 'approved', revision: 1, plan: { order: ['repair-first'], rotationMode: 'relative_pm90', betweenTrials: 'none', figureSets: ['seeded-1'] }, trials: [{ index: 0, recordId: null }] };
  const kept = renderReceptions([approved], null, status({ legacyFigures: true }));
  assert.match(kept, /seeded-1/u); assert.match(kept, /action="\/admin\/reception\/[^"]+\/cancel"/u);
});

function approvalRequest(patch: Record<string, string> = {}, accept = 'application/json') {
  return new Request(`${ORIGIN}/admin/reception/${RECEPTION}/approve`, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin',
    'Content-Type': 'application/x-www-form-urlencoded', Accept: accept },
  body: new URLSearchParams({ expectedRevision: '0', confirm: '001', order: '0', protocolId: PROTOCOL_ID, protocolRevision: '2', protocolSha256: SHA, ...patch }).toString() });
}
function approvalDeps(protocol: ReceptionProtocolStatus) {
  const approvals: unknown[] = [];
  const deps = { token: TOKEN, limiter: { async limit() { return { success: true }; } }, async listPage() { return { items: [], next: null }; }, async getSummary() { return null; },
    async getRecord() { return null; }, async deleteRecord() {}, async audit() { return []; }, summarizeLatency,
    receptions: { async protocol() { return protocol; }, async listPage() { return { items: [row], next: null }; }, async get() { return row; },
      async approve(_id: string, input: unknown) { approvals.push(input); return { ok: true }; }, async cancel() { return { ok: true }; } } } as unknown as AdminDeps;
  return { deps, approvals };
}
test('the approval route refuses a four- or six-figure setting before the owner is called, and answers a changed setting first', async () => {
  const legacy = approvalDeps(status({ legacyFigures: true }));
  const refused = await handleAdmin(approvalRequest(), legacy.deps);
  assert.equal(refused.status, 409); assert.deepEqual(await refused.json(), { error: 'protocol_legacy_figures' });
  assert.deepEqual(legacy.approvals, []);
  const page = await handleAdmin(approvalRequest({}, 'text/html'), legacy.deps);
  assert.equal(page.status, 409);
  const html = await page.text();
  assert.match(html, /現在の設定は3図形ではないため、許可できません。受付の設定で3図形を選んで保存してください。/u); assert.match(html, /href="\/admin\/reception-settings"/u);
  // A form shown for another revision is a changed setting, whatever the current one is.
  const changed = await handleAdmin(approvalRequest({ protocolRevision: '1' }), legacy.deps);
  assert.equal(changed.status, 409); assert.deepEqual(await changed.json(), { error: 'protocol_changed' });
  const open = approvalDeps(status());
  assert.equal((await handleAdmin(approvalRequest(), open.deps)).status, 200);
  assert.equal(open.approvals.length, 1);
});
// ── 管理ポートが画面に渡す印 ───────────────────────────────────────────────────

test('the management port marks a protocol that cannot make new receptions, from the stored setting itself', async () => {
  const stored = (protocol: { revision: number }) => ({ protocol: { revision: protocol.revision, savedAt: '2026-11-28T00:00:00.000Z', sha256: receptionProtocolSha256(JSON.stringify(protocol)), protocol },
    mode: { value: 'on', revision: 1, savedAt: '2026-11-28T00:00:00.000Z' } });
  const portFor = (protocol: { revision: number }) => createReceptionAdminPort({ index: { async listReceptions() { return []; }, async getReception() { return null; } },
    owner: () => null, readSettings: async () => stored(protocol) });
  for (const selection of THREE) assert.equal(Object.hasOwn(await portFor(v3(selection)).protocol(), 'legacyFigures'), false, JSON.stringify(selection));
  for (const selection of LEGACY) assert.equal((await portFor(v3(selection)).protocol() as { legacyFigures?: true }).legacyFigures, true, JSON.stringify(selection));
  assert.equal((await portFor(v2()).protocol() as { legacyFigures?: true }).legacyFigures, true);
  assert.deepEqual(await createReceptionAdminPort({ index: { async listReceptions() { return []; }, async getReception() { return null; } }, owner: () => null,
    readSettings: async () => ({ protocol: null, mode: { value: 'unset', revision: 0 } }) }).protocol(), { configured: false, mode: 'unset' });
});
