// Real-browser check of the independent part layer on the orientation review page (headless Chromium, isolated profile).
// Starts the real server.ts on a free port with a private state directory (a copy of REVIEW_STATE_COPY when given),
// puts F1@0 in the state "confirmed before the layer existed", applies PART_CONSTRUAL with
// ../part-construal-20261128/apply-part-construal-to-review.ts, and drives the page. It never touches the running page.
//
//   PLAYWRIGHT_CORE_PATH=<playwright-core dir> CHROMIUM_PATH=<chromium executable> PART_CONSTRUAL=<part-construal-468.json> \
//     [REVIEW_STATE_COPY=<copy of review-state.json>] [EVIDENCE_DIR=<new dir for screenshots and the export>] \
//     node docs/review/orientation-app/browser-independent-parts.ts
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { reviewServer } from './review-server-harness.ts';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');
const proposal = process.env.PART_CONSTRUAL;
if (!proposal) throw Error('PART_CONSTRUAL=<part-construal-468.json> is required');
const evidence = process.env.EVIDENCE_DIR || mkdtempSync(join(tmpdir(), 'independent-parts-browser-'));
if (process.env.EVIDENCE_DIR) { if (existsSync(evidence)) throw Error('EVIDENCE_DIR already exists'); mkdirSync(evidence, { recursive: true, mode: 0o700 }); }
const applyScript = new URL('../part-construal-20261128/apply-part-construal-to-review.ts', import.meta.url).pathname;

const title = (id: string) => { const [f, r] = id.split('@'); return f + '　' + r + '°（時計回り）'; };
const saved = (page: any) => page.waitForFunction(() => document.querySelector('#save-status')?.textContent?.includes('保存済み'));
const layerRow = (s: any, id: string) => s.independentParts.rows.find((x: any) => x.id === id);
const entry = (s: any, id: string, partId: string) => layerRow(s, id).parts.find((p: any) => p.id === partId);
const pending = (s: any, id: string) => layerRow(s, id).parts.some((p: any) => p.reviewStatus === 'ai_unreviewed' && p.ai !== null);
const doneCount = (s: any) => s.results.filter((r: any) => r.status === '確認済み' && !pending(s, r.id)).length;
const log = (m: string) => console.log('ok  ' + m);

const server = await reviewServer();
if (process.env.REVIEW_STATE_COPY) copyFileSync(process.env.REVIEW_STATE_COPY, server.statePath);
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
try {
  await server.start();
  let state = await server.get('/api/state');
  if (state.results[0].status !== '確認済み') {
    const rows = structuredClone(state.results); rows[0].status = '確認済み';
    state = await server.post('/api/state', { revision: state.revision, sourceSha256: state.sourceSha256, currentId: state.currentId, results: rows });
  }
  const start = structuredClone(state);
  execFileSync(process.execPath, [applyScript, '--part-construal', proposal, '--backup-dir', join(evidence, 'apply-backup'), '--url', server.url], { stdio: 'pipe' });
  state = await server.get('/api/state');
  assert.equal(state.currentId, start.currentId); assert.deepEqual(state.results, start.results);
  log('applied the proposal to a copy; position and rows unchanged (revision ' + start.revision + ' -> ' + state.revision + ')');

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage(); const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push('pageerror: ' + e.message));
  // The browser asks for /favicon.ico by itself and the server answers 404 JSON; that is not an error of the page.
  page.on('console', (m: any) => { const url: string = m.location()?.url ?? ''; if (m.type() === 'error' && !url.endsWith('/favicon.ico')) errors.push('console: ' + m.text() + ' @' + url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')); });
  await page.goto(server.url); await page.locator('#editor').waitFor({ state: 'visible' });
  const regions = page.locator('section.part');

  // 1. The saved position opens, every region shows its AI proposal as unreviewed.
  assert.equal(await page.locator('#figure-title').textContent(), title(state.currentId));
  const here = layerRow(state, state.currentId);
  assert.equal(await regions.count(), here.parts.length);
  for (const [i, p] of here.parts.entries()) {
    assert.equal(await regions.nth(i).locator('.indep .badge').textContent(), 'AI案・未確認', p.id);
    if (p.candidates.length) assert.equal(await regions.nth(i).getByRole('textbox', { name: p.id + ' 独立部分 候補1 名詞', exact: true }).inputValue(), p.candidates[0].noun, p.id);
    else assert.equal(await regions.nth(i).locator('.indep .none').textContent(), '見立てなし', p.id);
  }
  assert.match(await page.locator('#progress').textContent(), new RegExp('観察メモ ' + doneCount(state) + ' / 120方向'));
  await page.screenshot({ path: join(evidence, '1-saved-position.png'), fullPage: true });
  log('saved position ' + state.currentId + ' opens with AI proposals shown as unreviewed');

  // 2. F1@0 was confirmed before the layer existed: it is shown as needing the new fields, and is not counted as done.
  await page.locator('#figure-nav button', { hasText: /^F1 / }).click();
  await page.waitForFunction((t: string) => document.querySelector('#figure-title')?.textContent === t, title('F1@0'));
  assert.equal(await page.locator('#figure-status').textContent(), '部分の見立て未確認');
  await page.getByRole('button', { name: '0度 部分の見立て未確認', exact: true }).waitFor();
  assert.match(await page.locator('#progress').textContent(), new RegExp('観察メモ ' + doneCount(await server.get('/api/state')) + ' / 120方向'));
  await page.screenshot({ path: join(evidence, '2-f1-0-confirmed-before-layer.png'), fullPage: true });
  log('F1@0 (confirmed before the layer) is shown as 部分の見立て未確認 and not counted as done');

  // 3. Editing a candidate marks the entry 編集済み, resets the row to 未確認 (existing rule), saves, and survives a reload.
  const f1 = layerRow(await server.get('/api/state'), 'F1@0');
  const k0 = f1.parts.findIndex((p: any) => p.candidates.length), id0 = f1.parts[k0].id;
  assert.ok(k0 >= 0);
  await regions.nth(k0).getByRole('textbox', { name: id0 + ' 独立部分 候補1 名詞', exact: true }).fill('研究者の名詞'); await saved(page);
  assert.equal(await regions.nth(k0).locator('.indep .badge').textContent(), '編集済み');
  assert.equal(await page.locator('#figure-status').textContent(), '未確認');
  let s = await server.get('/api/state');
  assert.equal(entry(s, 'F1@0', id0).reviewStatus, 'researcher_edited'); assert.equal(entry(s, 'F1@0', id0).candidates[0].noun, '研究者の名詞');
  assert.equal(s.results[0].status, '未確認');
  for (const p of layerRow(s, 'F1@0').parts) if (p.id !== id0) assert.equal(p.reviewStatus, 'ai_unreviewed', p.id);
  await page.reload(); await page.locator('#editor').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#figure-title').textContent(), title('F1@0'));
  assert.equal(await regions.nth(k0).locator('.indep .badge').textContent(), '編集済み');
  assert.equal(await regions.nth(k0).getByRole('textbox', { name: id0 + ' 独立部分 候補1 名詞', exact: true }).inputValue(), '研究者の名詞');
  log('an edit is saved per region, marks only that region 編集済み, and survives a reload');

  // 4. Add, remove down to 見立てなし with a reason, and add again.
  const k1 = f1.parts.findIndex((p: any, i: number) => i !== k0 && p.candidates.length < 3), id1 = f1.parts[k1].id, c1 = f1.parts[k1].candidates.length;
  assert.ok(k1 >= 0);
  const block = regions.nth(k1);
  await block.getByRole('button', { name: /^候補を(追加|入力)$/ }).click();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), id1 + ' 独立部分 候補' + (c1 + 1) + ' 名詞', 'the new candidate gets the focus');
  await page.keyboard.type('追加した名詞'); await saved(page);
  s = await server.get('/api/state');
  assert.equal(entry(s, 'F1@0', id1).candidates.length, c1 + 1); assert.equal(entry(s, 'F1@0', id1).candidates[c1].noun, '追加した名詞'); assert.equal(entry(s, 'F1@0', id1).noCandidate, false);
  for (let n = c1 + 1; n >= 1; n--) await block.getByRole('button', { name: id1 + ' 独立部分 候補' + n + ' を削除', exact: true }).click();
  await block.getByRole('textbox', { name: id1 + ' 独立部分 見立てなしの理由', exact: true }).fill('ブラウザ確認の理由'); await saved(page);
  assert.equal(await block.locator('.none').textContent(), '見立てなし');
  s = await server.get('/api/state');
  assert.deepEqual([entry(s, 'F1@0', id1).candidates.length, entry(s, 'F1@0', id1).noCandidate, entry(s, 'F1@0', id1).noCandidateReason], [0, true, 'ブラウザ確認の理由']);
  await block.getByRole('button', { name: '候補を入力', exact: true }).click(); await page.keyboard.type('再び追加'); await saved(page);
  s = await server.get('/api/state');
  assert.deepEqual([entry(s, 'F1@0', id1).candidates.map((c: any) => c.noun), entry(s, 'F1@0', id1).noCandidate, entry(s, 'F1@0', id1).noCandidateReason, entry(s, 'F1@0', id1).reviewStatus], [['再び追加'], false, '', 'researcher_edited']);
  await page.screenshot({ path: join(evidence, '3-after-edits.png'), fullPage: true });
  log('add / remove / 見立てなし with a reason / add again behave as designed');

  // 5. 確認して次へ confirms the unreviewed AI proposals of the direction and keeps the edited ones.
  await page.getByRole('button', { name: '確認して次へ', exact: true }).click(); await saved(page);
  s = await server.get('/api/state');
  assert.equal(s.results[0].status, '確認済み');
  for (const p of layerRow(s, 'F1@0').parts) assert.equal(p.reviewStatus, [id0, id1].includes(p.id) ? 'researcher_edited' : 'researcher_confirmed', p.id);
  assert.notEqual(s.currentId, 'F1@0');
  assert.equal(await page.locator('#figure-title').textContent(), title(s.currentId));
  assert.match(await page.locator('#progress').textContent(), new RegExp('観察メモ ' + doneCount(s) + ' / 120方向'));
  await page.getByRole('button', { name: '0度 確認済み', exact: true }).click();
  assert.equal(await page.locator('#figure-status').textContent(), '確認済み');
  const badges = await regions.locator('.indep .badge').allTextContents();
  assert.deepEqual(badges, layerRow(s, 'F1@0').parts.map((p: any) => p.reviewStatus === 'researcher_edited' ? '編集済み' : '確認済み'));
  await page.screenshot({ path: join(evidence, '4-f1-0-confirmed.png'), fullPage: true }); await saved(page);
  log('確認して次へ: AI proposals confirmed, edited ones kept, position moved, progress counted');

  // 6. 要修正として次へ leaves the independent parts as they are.
  await page.locator('#figure-nav button', { hasText: /^F1 / }).click(); await saved(page); // opens the first direction of F1 that is not done
  const target = (await server.get('/api/state')).currentId;
  assert.notEqual(target, 'F1@0');
  assert.equal(await page.locator('#figure-title').textContent(), title(target));
  await page.getByRole('button', { name: '要修正として次へ', exact: true }).click(); await saved(page);
  s = await server.get('/api/state');
  assert.equal(s.results.find((r: any) => r.id === target).status, '要修正');
  assert.ok(layerRow(s, target).parts.every((p: any) => p.reviewStatus === 'ai_unreviewed'));
  log('要修正として次へ changes the row status only');

  // 7. The export from the page carries the independent parts and equals /api/export.
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'JSONを書き出す', exact: true }).click();
  const file = join(evidence, 'export.json'); await (await downloaded).saveAs(file);
  const exported = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(exported, await server.get('/api/export'));
  const part = exported.results[0].parts[k0].independentPart;
  assert.equal(part.reviewStatus, 'researcher_edited'); assert.equal(part.candidates[0].noun, '研究者の名詞'); assert.equal(part.candidates[0].rank, 1);
  assert.deepEqual(exported.results[0].parts[k1].independentPart.candidates.map((c: any) => c.noun), ['再び追加']);
  log('the page export equals /api/export and carries independentPart');

  // 8. Phone width: no horizontal overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#figure-nav button', { hasText: /^F1 / }).click();
  await page.getByRole('button', { name: '0度 確認済み', exact: true }).click();
  await page.screenshot({ path: join(evidence, '5-phone.png'), fullPage: true });
  // Only the independent part blocks are checked. The page itself overflows by 3px at 390px because of the figure
  // navigation buttons; that is the same as before this change (4e09b62), so it is reported but not asserted.
  const inside = await page.evaluate(() => [...document.querySelectorAll('.indep, .indep *')]
    .filter(e => e.getBoundingClientRect().right > window.innerWidth + 0.5 || (e.scrollWidth > e.clientWidth + 1 && !(e instanceof HTMLInputElement) && !(e instanceof HTMLTextAreaElement)))
    .slice(0, 8).map(e => e.tagName.toLowerCase() + '.' + (typeof e.className === 'string' ? e.className : '')));
  assert.deepEqual(inside, [], 'the independent part blocks overflow at 390px');
  log('no overflow inside the independent part blocks at 390px (page overflow ' + await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) + 'px comes from the figure navigation)');

  assert.deepEqual(errors, [], 'errors in the page: ' + JSON.stringify(errors));
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ ok: true, at: new Date().toISOString(), startRevision: start.revision, finalRevision: (await server.get('/api/state')).revision, evidence }, null, 2) + '\n');
  console.log('Browser check passed. Evidence: ' + evidence);
} finally { await browser.close(); await server.close(); }
