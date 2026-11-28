// Real-browser check of the two structured layers (independent part construal and whole construal) on the orientation
// review page (headless Chromium, isolated profile).
// Starts the real server.ts on a free port with a private state directory (a copy of REVIEW_STATE_COPY when given),
// puts F1@0 in the state "confirmed before the layers existed", applies PART_CONSTRUAL and the whole-construal consensus
// with ../part-construal-20261128/apply-*-to-review.ts, and drives the page. It never touches the running page.
//
//   PLAYWRIGHT_CORE_PATH=<playwright-core dir> CHROMIUM_PATH=<chromium executable> PART_CONSTRUAL=<part-construal-468.json> \
//     [WHOLE_CONSENSUS=<consensus-120.json>] [REVIEW_STATE_COPY=<copy of review-state.json>] [EVIDENCE_DIR=<new dir>] \
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
const consensus = process.env.WHOLE_CONSENSUS || new URL('../construal-consensus-20261128/consensus-120.json', import.meta.url).pathname;
const evidence = process.env.EVIDENCE_DIR || mkdtempSync(join(tmpdir(), 'independent-parts-browser-'));
if (process.env.EVIDENCE_DIR) { if (existsSync(evidence)) throw Error('EVIDENCE_DIR already exists'); mkdirSync(evidence, { recursive: true, mode: 0o700 }); }
const scripts = new URL('../part-construal-20261128/', import.meta.url).pathname;

const title = (id: string) => { const [f, r] = id.split('@'); return f + '　' + r + '°（時計回り）'; };
const saved = (page: any) => page.waitForFunction(() => document.querySelector('#save-status')?.textContent?.includes('保存済み'));
const layerRow = (s: any, id: string) => s.independentParts.rows.find((x: any) => x.id === id);
const wholeOf = (s: any, id: string) => s.wholeConstruals.rows.find((x: any) => x.id === id);
const entry = (s: any, id: string, partId: string) => layerRow(s, id).parts.find((p: any) => p.id === partId);
const pending = (s: any, id: string) => layerRow(s, id).parts.some((p: any) => p.reviewStatus === 'ai_unreviewed' && p.ai !== null)
  || (wholeOf(s, id).reviewStatus === 'ai_unreviewed' && wholeOf(s, id).ai !== null) || wholeOf(s, id).needsTextCheck;
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
  execFileSync(process.execPath, [scripts + 'apply-part-construal-to-review.ts', '--part-construal', proposal, '--backup-dir', join(evidence, 'apply-parts-backup'), '--url', server.url], { stdio: 'pipe' });
  execFileSync(process.execPath, [scripts + 'apply-whole-construal-to-review.ts', '--consensus', consensus, '--backup-dir', join(evidence, 'apply-whole-backup'), '--url', server.url], { stdio: 'pipe' });
  state = await server.get('/api/state');
  assert.equal(state.currentId, start.currentId); assert.deepEqual(state.results, start.results);
  assert.deepEqual(state.wholeConstruals.rows.filter((w: any) => w.needsTextCheck).map((w: any) => w.id), ['F1@0'], 'only the hand-edited row is marked');
  log('applied both layers to a copy; position and rows unchanged (revision ' + start.revision + ' -> ' + state.revision + ')');

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage(); const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push('pageerror: ' + e.message));
  // The browser asks for /favicon.ico by itself and the server answers 404 JSON; that is not an error of the page.
  page.on('console', (m: any) => { const url: string = m.location()?.url ?? ''; if (m.type() === 'error' && !url.endsWith('/favicon.ico')) errors.push('console: ' + m.text() + ' @' + url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')); });
  await page.goto(server.url); await page.locator('#editor').waitFor({ state: 'visible' });
  const regions = page.locator('section.part');
  const whole = page.locator('#whole-struct .indep');

  // 1. The saved position opens; every region and the whole construal show their AI proposal as unreviewed.
  assert.equal(await page.locator('#figure-title').textContent(), title(state.currentId));
  const here = layerRow(state, state.currentId), hereWhole = wholeOf(state, state.currentId);
  assert.equal(await regions.count(), here.parts.length);
  for (const [i, p] of here.parts.entries()) {
    assert.equal(await regions.nth(i).locator('.indep .badge').textContent(), 'AI案・未確認', p.id);
    if (p.candidates.length) assert.equal(await regions.nth(i).getByRole('textbox', { name: p.id + ' 独立部分 候補1 名詞', exact: true }).inputValue(), p.candidates[0].noun, p.id);
    else assert.equal(await regions.nth(i).locator('.indep .none').textContent(), '見立てなし', p.id);
  }
  assert.equal(await whole.locator('.badge').first().textContent(), 'AI案・未確認');
  if (hereWhole.candidates.length) assert.equal(await whole.getByRole('textbox', { name: '全体の見立て 候補1 名詞', exact: true }).inputValue(), hereWhole.candidates[0].noun);
  else assert.equal(await whole.locator('.none').textContent(), '見立てなし');
  assert.match(await page.locator('#progress').textContent(), new RegExp('観察メモ ' + doneCount(state) + ' / 120方向'));
  await page.screenshot({ path: join(evidence, '1-saved-position.png'), fullPage: true });
  log('saved position ' + state.currentId + ' opens with the whole construal and every region shown as unreviewed AI proposals');

  // 2. F1@0 was confirmed before the layers existed and its free text was edited by hand: it is marked 自由文と要照合 and not counted as done.
  await page.locator('#figure-nav button', { hasText: /^F1 / }).click();
  await page.waitForFunction((t: string) => document.querySelector('#figure-title')?.textContent === t, title('F1@0'));
  assert.equal(await page.locator('#figure-status').textContent(), '自由文と要照合');
  await page.getByRole('button', { name: '0度 自由文と要照合', exact: true }).waitFor();
  assert.equal(await whole.locator('.badge.check').isVisible(), true);
  assert.match(await page.locator('#progress').textContent(), new RegExp('観察メモ ' + doneCount(await server.get('/api/state')) + ' / 120方向'));
  await page.screenshot({ path: join(evidence, '2-f1-0-needs-text-check.png'), fullPage: true });
  log('F1@0 (confirmed, free text edited by hand) shows the 自由文と要照合 mark and is not counted as done');

  // 3. Editing an independent part candidate marks only that region 編集済み, resets the row to 未確認 (existing rule), saves, and survives a reload.
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
  assert.equal(wholeOf(s, 'F1@0').reviewStatus, 'ai_unreviewed', 'a part edit does not touch the whole construal');
  await page.reload(); await page.locator('#editor').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#figure-title').textContent(), title('F1@0'));
  assert.equal(await regions.nth(k0).locator('.indep .badge').textContent(), '編集済み');
  assert.equal(await regions.nth(k0).getByRole('textbox', { name: id0 + ' 独立部分 候補1 名詞', exact: true }).inputValue(), '研究者の名詞');
  log('an edit of an independent part is saved per region and survives a reload');

  // 4. Add, remove down to 見立てなし with a reason, and add again (independent part).
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
  log('independent part: add / remove / 見立てなし with a reason / add again behave as designed');

  // 5. Whole construal: a structured edit marks it 編集済み and clears 自由文と要照合; roles are per region; add and delete a candidate.
  const w0 = wholeOf(s, 'F1@0'), partIds = f1.parts.map((p: any) => p.id);
  assert.equal(w0.needsTextCheck, true);
  await whole.getByRole('textbox', { name: '全体の見立て 候補1 名詞', exact: true }).fill('研究者の全体名詞'); await saved(page);
  assert.equal(await whole.locator('.badge').first().textContent(), '編集済み');
  assert.equal(await whole.locator('.badge.check').isVisible(), false, 'a structured edit clears the mark');
  await whole.getByRole('textbox', { name: '全体の見立て 候補1 ' + partIds[0] + 'の役割', exact: true }).fill('私の役割'); await saved(page);
  s = await server.get('/api/state');
  assert.deepEqual([wholeOf(s, 'F1@0').reviewStatus, wholeOf(s, 'F1@0').needsTextCheck, wholeOf(s, 'F1@0').candidates[0].noun, wholeOf(s, 'F1@0').candidates[0].parts[0]], ['researcher_edited', false, '研究者の全体名詞', { id: partIds[0], role: '私の役割' }]);
  const n0 = wholeOf(s, 'F1@0').candidates.length;
  await whole.getByRole('button', { name: /^候補を(追加|入力)$/ }).click();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '全体の見立て 候補' + (n0 + 1) + ' 名詞');
  await page.keyboard.type('追加した全体名詞'); await saved(page);
  s = await server.get('/api/state');
  assert.equal(wholeOf(s, 'F1@0').candidates.length, n0 + 1); assert.deepEqual(wholeOf(s, 'F1@0').candidates[n0].parts.map((p: any) => p.id), partIds, 'a new candidate has a role slot for every region');
  await whole.getByRole('button', { name: '全体の見立て 候補' + (n0 + 1) + ' を削除', exact: true }).click(); await saved(page);
  assert.equal((await server.get('/api/state') as any).wholeConstruals.rows.find((w: any) => w.id === 'F1@0').candidates.length, n0);
  await page.screenshot({ path: join(evidence, '3-after-edits.png'), fullPage: true });
  log('whole construal: structured edit clears the mark, roles are per region, a candidate can be added and removed');

  // 6. Editing the free text (whole, or the role lines of a region) marks the row again; a structured edit clears it.
  await page.locator('#whole').fill((await page.locator('#whole').inputValue()) + '（追記）'); await saved(page);
  assert.equal(await whole.locator('.badge.check').isVisible(), true);
  assert.equal(wholeOf(await server.get('/api/state'), 'F1@0').needsTextCheck, true);
  await whole.getByRole('textbox', { name: '全体の見立て 候補1 姿勢', exact: true }).fill('立つ'); await saved(page);
  assert.equal(await whole.locator('.badge.check').isVisible(), false);
  await page.getByRole('textbox', { name: partIds[0] + ' 見立て', exact: true }).fill('自由文の役割'); await saved(page);
  assert.equal(await whole.locator('.badge.check').isVisible(), true);
  assert.equal(wholeOf(await server.get('/api/state'), 'F1@0').needsTextCheck, true);
  log('editing the free text of the whole construal or of a region role marks the row 自由文と要照合; a structured edit clears it');

  // 7. 確認して次へ confirms the unreviewed AI proposals of the direction, keeps the edited ones, and clears the mark.
  await page.getByRole('button', { name: '確認して次へ', exact: true }).click(); await saved(page);
  s = await server.get('/api/state');
  assert.equal(s.results[0].status, '確認済み');
  for (const p of layerRow(s, 'F1@0').parts) assert.equal(p.reviewStatus, [id0, id1].includes(p.id) ? 'researcher_edited' : 'researcher_confirmed', p.id);
  assert.deepEqual([wholeOf(s, 'F1@0').reviewStatus, wholeOf(s, 'F1@0').needsTextCheck], ['researcher_edited', false]);
  assert.notEqual(s.currentId, 'F1@0');
  assert.equal(await page.locator('#figure-title').textContent(), title(s.currentId));
  assert.match(await page.locator('#progress').textContent(), new RegExp('観察メモ ' + doneCount(s) + ' / 120方向'));
  assert.equal(doneCount(s) >= 1, true);
  await page.getByRole('button', { name: '0度 確認済み', exact: true }).click();
  assert.equal(await page.locator('#figure-status').textContent(), '確認済み');
  assert.deepEqual(await regions.locator('.indep .badge').allTextContents(), layerRow(s, 'F1@0').parts.map((p: any) => p.reviewStatus === 'researcher_edited' ? '編集済み' : '確認済み'));
  assert.equal(await whole.locator('.badge').first().textContent(), '編集済み');
  await page.screenshot({ path: join(evidence, '4-f1-0-confirmed.png'), fullPage: true }); await saved(page);
  log('確認して次へ: AI proposals confirmed, edited ones kept, the mark cleared, position moved, progress counted');

  // 8. Confirming an untouched AI direction confirms both layers; 要修正として次へ leaves them as they are.
  await page.locator('#figure-nav button', { hasText: /^F1 / }).click(); await saved(page); // opens the first direction of F1 that is not done
  const target = (await server.get('/api/state')).currentId;
  assert.notEqual(target, 'F1@0');
  assert.equal(await page.locator('#figure-title').textContent(), title(target));
  await page.getByRole('button', { name: '確認して次へ', exact: true }).click(); await saved(page);
  s = await server.get('/api/state');
  assert.equal(s.results.find((r: any) => r.id === target).status, '確認済み');
  assert.equal(wholeOf(s, target).reviewStatus, 'researcher_confirmed');
  assert.ok(layerRow(s, target).parts.every((p: any) => p.reviewStatus === 'researcher_confirmed' || p.ai === null));
  const target2 = s.currentId; assert.notEqual(target2, target);
  await page.getByRole('button', { name: '要修正として次へ', exact: true }).click(); await saved(page);
  s = await server.get('/api/state');
  assert.equal(s.results.find((r: any) => r.id === target2).status, '要修正');
  assert.equal(wholeOf(s, target2).reviewStatus, 'ai_unreviewed');
  assert.ok(layerRow(s, target2).parts.every((p: any) => p.reviewStatus === 'ai_unreviewed'));
  log('確認して次へ confirms both layers of an untouched direction; 要修正として次へ changes the row status only');

  // 9. The export from the page carries both layers and equals /api/export.
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'JSONを書き出す', exact: true }).click();
  const file = join(evidence, 'export.json'); await (await downloaded).saveAs(file);
  const exported = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(exported, await server.get('/api/export'));
  const part = exported.results[0].parts[k0].independentPart;
  assert.equal(part.reviewStatus, 'researcher_edited'); assert.equal(part.candidates[0].noun, '研究者の名詞'); assert.equal(part.candidates[0].rank, 1);
  assert.deepEqual(exported.results[0].parts[k1].independentPart.candidates.map((c: any) => c.noun), ['再び追加']);
  const wc = exported.results[0].wholeConstrual;
  assert.deepEqual([wc.reviewStatus, wc.needsTextCheck, wc.candidates[0].rank, wc.candidates[0].noun, wc.candidates[0].posture, wc.candidates[0].parts.length], ['researcher_edited', false, 1, '研究者の全体名詞', '立つ', partIds.length]);
  log('the page export equals /api/export and carries independentPart and wholeConstrual');

  // 10. Phone width: no horizontal overflow inside the structured blocks. The page itself overflows by 3px at 390px because of the
  // figure navigation buttons; that is the same as before these layers (4e09b62), so it is reported but not asserted.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#figure-nav button', { hasText: /^F1 / }).click();
  await page.getByRole('button', { name: '0度 確認済み', exact: true }).click();
  await page.screenshot({ path: join(evidence, '5-phone.png'), fullPage: true });
  const inside = await page.evaluate(() => [...document.querySelectorAll('.indep, .indep *')]
    .filter(e => e.getBoundingClientRect().right > window.innerWidth + 0.5 || (e.scrollWidth > e.clientWidth + 1 && !(e instanceof HTMLInputElement) && !(e instanceof HTMLTextAreaElement)))
    .slice(0, 8).map(e => e.tagName.toLowerCase() + '.' + (typeof e.className === 'string' ? e.className : '')));
  assert.deepEqual(inside, [], 'the structured blocks overflow at 390px');
  log('no overflow inside the structured blocks at 390px (page overflow ' + await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) + 'px comes from the figure navigation)');

  assert.deepEqual(errors, [], 'errors in the page: ' + JSON.stringify(errors));
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ ok: true, at: new Date().toISOString(), startRevision: start.revision, finalRevision: (await server.get('/api/state')).revision, evidence }, null, 2) + '\n');
  console.log('Browser check passed. Evidence: ' + evidence);
} finally { await browser.close(); await server.close(); }
