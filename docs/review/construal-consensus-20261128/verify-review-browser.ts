// Real-browser check of the orientation review page (headless Chromium, isolated profile).
//  1. Live page, read only: shows the saved position with its saved text and exports JSON equal
//     to /api/export. No navigation or edit is made; the live revision must not change.
//  2. Mirror page: a copy of the live state file served by the same server.ts on a free port.
//     Checks sampled rows, an edit that saves and survives a reload, 確認して次へ, and the export.
//
//   PLAYWRIGHT_CORE_PATH=<playwright-core dir> node docs/review/construal-consensus-20261128/verify-review-browser.ts \
//     --state-file <live review-state.json> --out <new evidence dir> [--live http://127.0.0.1:5498] [--ids F2@90,F7@180]
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';

type Row = { id: string; status: string; whole: string; wholeBasis: string[]; note: string; parts: { id: string; description: string; candidates: string[] }[] };
type State = { revision: number; updatedAt: string; currentId: string; results: Row[] };
type Template = { id: string; figureId: string; rotation: number; parts: { id: string }[] };

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');
const { values } = parseArgs({ options: { 'state-file': { type: 'string' }, out: { type: 'string' }, live: { type: 'string', default: 'http://127.0.0.1:5498' }, ids: { type: 'string', default: '' } } });
if (!values['state-file'] || !values.out) throw Error('--state-file and --out are required');
if (existsSync(values.out)) throw Error('evidence directory already exists');
mkdirSync(values.out, { recursive: true, mode: 0o700 });
const out = values.out, live = values.live!;
const json = async (url: string) => { const r = await fetch(url, { cache: 'no-store' }); assert.ok(r.ok, url); return r.json(); };
const evidence: Record<string, unknown> = {};

async function freePort() {
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const address = probe.address(); assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) => probe.close(e => e ? reject(e) : resolve()));
  return address.port;
}
async function expectRow(page: any, t: Template, row: Row) {
  assert.equal(await page.locator('#figure-title').textContent(), t.figureId + '　' + t.rotation + '°（時計回り）');
  assert.equal(await page.locator('#figure-status').textContent(), row.status);
  assert.equal(await page.locator('#whole').inputValue(), row.whole);
  assert.equal(await page.locator('#whole-basis').inputValue(), row.wholeBasis.join('\n'));
  assert.equal(await page.locator('#note').inputValue(), row.note);
  for (const p of row.parts) {
    assert.equal(await page.getByRole('textbox', { name: p.id + ' 見立て', exact: true }).inputValue(), p.candidates.join('\n'), row.id + ' ' + p.id);
    assert.equal(await page.getByRole('textbox', { name: p.id + ' 形・位置の説明', exact: true }).inputValue(), p.description, row.id + ' ' + p.id);
  }
}
async function goTo(page: any, t: Template, status: string) {
  await page.locator('#figure-nav button', { hasText: new RegExp('^' + t.figureId + ' ') }).click();
  await page.getByRole('button', { name: t.rotation + '度 ' + status, exact: true }).click();
  await page.waitForFunction((title: string) => document.querySelector('#figure-title')?.textContent === title, t.figureId + '　' + t.rotation + '°（時計回り）');
}
const saved = (page: any) => page.waitForFunction(() => document.querySelector('#save-status')?.textContent?.includes('保存済み'));
const progress = (state: State) => '観察メモ ' + state.results.filter(r => r.status === '確認済み').length + ' / 120方向';

const browser = await chromium.launch({ headless: true });
let child: ChildProcess | null = null;
const mirrorDir = mkdtempSync(join(tmpdir(), 'review-mirror-'));
try {
  // 1. Live page, read only.
  const data = await json(live + '/api/data') as { templates: Template[] };
  const before = await json(live + '/api/state') as State;
  const byId = new Map(data.templates.map(t => [t.id, t]));
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage(); const errors: string[] = []; page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(live); await page.locator('#editor').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#save-status')?.textContent?.includes('読み込みました'));
    await expectRow(page, byId.get(before.currentId)!, before.results.find(r => r.id === before.currentId)!);
    assert.match(await page.locator('#progress').textContent(), new RegExp(progress(before)));
    await page.screenshot({ path: join(out, 'live-current.png'), fullPage: true });
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'JSONを書き出す', exact: true }).click();
    const file = join(out, 'live-export.json'); await (await download).saveAs(file);
    const exported = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(exported, await json(live + '/api/export'));
    assert.equal(exported.results.length, 120); assert.equal(exported.partitionStatus, 'all_30_user_confirmed');
    const after = await json(live + '/api/state') as State;
    assert.equal(after.revision, before.revision, 'live revision changed during the read-only check');
    assert.deepEqual(errors, []);
    evidence.live = { revision: before.revision, currentId: before.currentId, confirmed: before.results.filter(r => r.status === '確認済み').map(r => r.id), exportBytes: readFileSync(file).length };
    await context.close();
  }

  // 2. Mirror page on a copy of the same state file.
  copyFileSync(values['state-file'], join(mirrorDir, 'review-state.json'));
  const port = await freePort(), mirror = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, [new URL('../orientation-app/server.ts', import.meta.url).pathname], { env: { ...process.env, REVIEW_PORT: String(port), REVIEW_STATE_DIR: mirrorDir }, stdio: 'pipe' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(mirror + '/api/state')).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  const start = await json(mirror + '/api/state') as State;
  assert.deepEqual(start.results, before.results, 'mirror copy differs from the live state');
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage(); const errors: string[] = []; page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.goto(mirror); await page.locator('#editor').waitFor({ state: 'visible' });
  await expectRow(page, byId.get(start.currentId)!, start.results.find(r => r.id === start.currentId)!);
  const chosen = values.ids ? values.ids.split(',') : [];
  const sample = [...chosen, ...start.results.filter(r => r.status === '確認済み').map(r => r.id)];
  const checked: string[] = [];
  for (const id of sample) {
    const row = start.results.find(r => r.id === id)!; await goTo(page, byId.get(id)!, row.status); await expectRow(page, byId.get(id)!, row); checked.push(id);
  }
  await page.screenshot({ path: join(out, 'mirror-row.png'), fullPage: true });
  // Edit, save and reload, then confirm, on a row that is still 未確認.
  const target = start.results.find(r => r.status === '未確認' && r.id !== start.currentId)!;
  await goTo(page, byId.get(target.id)!, '未確認'); await saved(page);
  await page.locator('#note').fill('ブラウザ検証用メモ'); await saved(page);
  await page.reload(); await page.locator('#editor').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#figure-title').textContent(), byId.get(target.id)!.figureId + '　' + byId.get(target.id)!.rotation + '°（時計回り）');
  assert.equal(await page.locator('#note').inputValue(), 'ブラウザ検証用メモ');
  await page.getByRole('button', { name: '確認して次へ', exact: true }).click(); await saved(page);
  const end = await json(mirror + '/api/state') as State;
  const edited = end.results.find(r => r.id === target.id)!;
  assert.equal(edited.status, '確認済み'); assert.equal(edited.note, 'ブラウザ検証用メモ');
  assert.deepEqual({ ...edited, status: target.status, note: target.note }, target);
  assert.match(await page.locator('#progress').textContent(), new RegExp(progress(end)));
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'JSONを書き出す', exact: true }).click();
  const file = join(out, 'mirror-export.json'); await (await download).saveAs(file);
  const exported = JSON.parse(readFileSync(file, 'utf8'));
  const exportedRow = exported.results.find((r: { id: string }) => r.id === target.id);
  assert.equal(exportedRow.status, '確認済み');
  assert.deepEqual(exportedRow.parts.map((p: { construal: { candidates: string[] } }) => p.construal.candidates), target.parts.map(p => p.candidates));
  assert.ok(exportedRow.parts.every((p: { outlines: unknown[] }) => Array.isArray(p.outlines) && p.outlines.length));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(out, 'mirror-phone.png'), fullPage: true });
  assert.deepEqual(errors, []);
  evidence.mirror = { checkedRows: checked, editedAndConfirmed: target.id, revisions: [start.revision, end.revision], exportBytes: readFileSync(file).length };
  writeFileSync(join(out, 'verify-result.json'), JSON.stringify({ ok: true, at: new Date().toISOString(), ...evidence }, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, ...evidence }, null, 2));
} finally {
  await browser.close();
  if (child && child.exitCode === null) { const end = once(child, 'exit'); child.kill(); await end; }
  rmSync(mirrorDir, { recursive: true, force: true });
}
