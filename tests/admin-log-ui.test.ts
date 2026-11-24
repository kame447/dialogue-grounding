// Researcher log pages: a readable hierarchy that loses no research field, with script-free folds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRecord } from '../workers/tangram-experiment/src/admin/summary.ts';
import { summarizeLatency } from '../workers/tangram-experiment/src/admin/latency.ts';
import { ADMIN_CSS, applyFilter, parseFilter, renderDetail, renderList } from '../workers/tangram-experiment/src/admin/render.ts';
import { ADMIN_HEADERS } from '../workers/tangram-experiment/src/admin/routes.ts';

const RECORD = '0f8fad5b-d9cb-469f-a165-70867728950e', OBJECT = 'a'.repeat(64), XSS = '<script>alert(1)</script>"\'&';
function record(overrides: Record<string, unknown> = {}) {
  return { recordId: RECORD, version: 2, trialId: 'trial-PRIVATE', seed: 137, strategy: 'bypass-enabled', startedAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:01:00.000Z',
    options: { referenceMemory: true, utteranceStyle: 'concise', userAgent: 'PRIVATE-UA' }, status: 'completed', cookie: 'tangram_session=' + 'f'.repeat(64), ip: '203.0.113.9',
    events: [{ id: 'e1', seq: 1, speaker: 'ai', text: 'まず、どの図形から話しますか？', at: '2026-10-19T00:00:00.000Z', origin: 'scripted_opening' },
      { id: 'e2', seq: 2, speaker: 'human', text: 'HUMAN-LINE ' + XSS, at: '2026-10-19T00:00:10.000Z' }],
    judgments: [{ turnIndex: 2, status: 'committed', judgment: { action: 'propose_name', targetSlot: 's-ab12', candidateName: 'JUDGED-NAME', discriminatingFeature: 'FEATURE' } }],
    attempts: [{ turnIndex: 2, status: 'committed' }, { turnIndex: 4, status: 'generation_error', errorCode: 'timeout', errorPhase: 'generation', errorStatus: 504, errorElapsedMs: 61000, generationRetried: true }],
    groundingShadow: [{ turnIndex: 2, targetSlot: 's-ab12', status: 'ok', identification: { level: 'probable' }, nameAgreement: { level: 'agreed' }, criteriaVersion: 'v2' }],
    requests: [{ kind: 'judgment', status: 'ok', model: 'model-x', latencyMs: 2500 }, { kind: 'generation', status: 'error', httpStatus: 502, errorCode: 'http_502', latencyMs: 8000 }],
    queueState: { pendingHumanEventIds: [], errorCode: null, closed: false },
    humanSubmission: { 's-ab12': 'HUMAN-NAME' }, aiSubmission: { 's-ab12': 'AI-NAME' }, diagnostics: { DIAG: 1 },
    scoring: { result: { matchedCount: 0, total: 1, figures: [{ human: { slot: 's-ab12', rawName: 'HUMAN-NAME' }, ai: { rawName: 'AI-NAME' }, matched: false }] }, key: 'SCORING-RAW' },
    questionnaire: { version: 'provisional-v0', status: 'submitted', answers: { q1: 5 }, comment: 'COMMENT', createdAt: '2026-10-19T00:02:00.000Z', updatedAt: '2026-10-19T00:03:00.000Z', submittedAt: '2026-10-19T00:03:00.000Z' },
    closed: true, finalError: null, ...overrides };
}
const summaryOf = (r = record()) => summarizeRecord(r, OBJECT, summarizeLatency(r));
const filter = { status: 'any', error: 'any', memory: 'any' } as const;
const detail = (r = record()) => renderDetail(r, summaryOf(r), summarizeLatency(r), 30);

test('the list has five readable columns, each labelled for the narrow card layout, instead of fourteen', () => {
  const html = renderList([summaryOf()], { ...filter }, null, []);
  const headings = [...(html.match(/<thead>([\s\S]*?)<\/thead>/)?.[1] ?? '').matchAll(/<th>([^<]*)<\/th>/g)].map(m => m[1]);
  const labels = [...(html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? '').matchAll(/<td data-label="([^"]*)"/g)].map(m => m[1]);
  assert.deepEqual(headings, ['記録', '状態', '条件', '発話・確定', '応答・エラー']); assert.deepEqual(labels, headings);
  assert.match(html, /class="wrap cards log"/); assert.match(ADMIN_CSS, /@media \(max-width:699px\)[\s\S]*\.cards td/);
  assert.match(html, new RegExp(`href="/admin/record/${RECORD}">0f8fad5b</a>`));
  assert.match(html, /bypass-enabled/); assert.match(html, /メモリ ON/); assert.match(html, /concise/); assert.match(html, /人\/AI 1\/1/); assert.match(html, /確定\/試行 1\/2/);
  assert.match(html, /要求エラー 1/); assert.match(html, /http_502|turn_timeout/);
});

test('states use the vocabulary of the reception list; questionnaire and AI errors are visible badges', () => {
  const states: [string, string][] = [['dialogue', '実施中'], ['submitting', '提出中'], ['completed', '終了']];
  for (const [status, label] of states) assert.match(renderList([summaryOf(record({ status }))], { ...filter }, null, []), new RegExp(`<span class="badge[^"]*">${label}</span>`));
  const html = renderList([summaryOf(record({ queueState: { pendingHumanEventIds: [], errorCode: 'ai_unavailable', closed: false }, questionnaire: { status: 'draft', answers: {} } }))], { ...filter }, null, []);
  assert.match(html, /badge bad">AI error/); assert.match(html, /アンケート下書き/);
  assert.match(renderList([summaryOf(record({ questionnaire: undefined }))], { ...filter }, null, []), /アンケートなし/);
});

test('times are shown in JST with the stored ISO value kept in the element', () => {
  const html = renderList([summaryOf()], { ...filter }, null, []);
  assert.match(html, /<time datetime="2026-10-19T00:01:00.000Z" title="2026-10-19T00:01:00.000Z">2026-10-19 09:01:00<\/time>/);
  assert.match(detail(), /<time datetime="2026-10-19T00:00:10.000Z"[^>]*>2026-10-19 09:00:10<\/time>/);
});

test('the status filter has Japanese labels, keeps its values and finds in-progress records together', () => {
  const html = renderList([], { ...filter, status: 'completed' }, null, []);
  const select = html.match(/<select name="status">([\s\S]*?)<\/select>/)![1];
  assert.deepEqual([...select.matchAll(/<option value="([^"]+)"[^>]*>([^<]*)</g)].map(m => [m[1], m[2]]),
    [['any', 'すべて'], ['active', '進行中（実施中・提出中）'], ['dialogue', '実施中'], ['submitting', '提出中'], ['completed', '終了']]);
  assert.match(select, /<option value="completed" selected>/);
  const all = ['dialogue', 'submitting', 'completed'].map(status => summaryOf(record({ status })));
  assert.deepEqual(applyFilter(all, parseFilter(new URLSearchParams('status=active'))).map(s => s.status), ['dialogue', 'submitting']);
  for (const status of ['any', 'dialogue', 'submitting', 'completed']) assert.equal(parseFilter(new URLSearchParams('status=' + status)).status, status);
  assert.equal(parseFilter(new URLSearchParams('status=bogus')).status, 'any');
});

test('the record page shows identity, conversation and outcome first and folds every diagnostic', () => {
  const html = detail();
  const first = (needle: string) => html.indexOf(needle);
  assert.ok(first('class="summary"') < first('<h2>会話（公開発話）</h2>') && first('<h2>会話（公開発話）</h2>') < first('<h2>提出と結果</h2>') && first('<h2>提出と結果</h2>') < first('<h2>診断</h2>'));
  assert.match(html, /<ol class="chat"><li class="ai"><div class="meta"><span class="badge">AI<\/span><span>seq 1<\/span>[\s\S]*scripted_opening/);
  assert.match(html, /<li class="human">[\s\S]*HUMAN-LINE &lt;script&gt;/);
  assert.match(html, /<a href="\/admin\/record\/0f8fad5b-d9cb-469f-a165-70867728950e\.json">JSONで保存/);
  // Outcome: names and the match, readable without opening anything.
  const outcome = html.slice(first('<h2>提出と結果</h2>'), first('<h2>診断</h2>'));
  assert.match(outcome, /<td>HUMAN-NAME<\/td><td>AI-NAME<\/td><td>不一致<\/td>/); assert.match(outcome, /一致 0 \/ 1/);
  assert.doesNotMatch(outcome, /DIAG|SCORING-RAW/, 'raw diagnostics and scoring live in the fold');
  assert.match(html, /<h2>仮アンケート/); assert.match(html, /COMMENT/);
  // Every diagnostic sits in a closed <details>; none is open by default.
  const folds = [...html.matchAll(/<details class="diag([^"]*)"( open)?><summary>([^<]*)<\/summary>/g)];
  const titles = folds.map(m => m[3]);
  assert.equal(titles.length, 7);
  for (const [i, prefix] of ['確定した判断（ターンごと）（1件）', '実行の記録（中断・失敗を含む）（2件・エラー 1件）', '遅延・ターン別の遅延（p50 ', '根拠の影判定（Jev 2軸・研究用・未校正）（1件）',
    '外部要求（2回・エラー 1件）', '詳細メタデータ・キュー・提出と採点の生データ', '削除'].entries()) assert.ok(titles[i].startsWith(prefix), titles[i]);
  assert.ok(folds.every(m => !m[2]), 'folds start closed');
});

test('nothing the old page showed is lost: judgments, attempts, latency, shadow, requests, raw data and the delete form', () => {
  const html = detail();
  const must = ['JUDGED-NAME', 'FEATURE', '<td>timeout / generation / HTTP 504 / 61000 ms</td><td>あり</td>', 'エラー（コード / 段階 / HTTP / 経過）', 'v2', 'probable', 'agreed', 'model-x', 'http_502',
    'Durable Object', OBJECT, 'DIAG', 'SCORING-RAW', 'AI-NAME', 'ターン別の遅延', 'p95', '自動では削除されません',
    `method="post" action="/admin/record/${RECORD}/delete"`, 'name="confirm"', '外部要求', '仮アンケート'];
  for (const text of must) assert.ok(html.includes(text), text);
  for (const secret of ['trial-PRIVATE', 'PRIVATE-UA', 'tangram_session', '203.0.113.9']) assert.ok(!html.includes(secret), secret);
  assert.doesNotMatch(html, /日後に自動削除/);
  // The shadow section appears only when there is data.
  assert.doesNotMatch(detail(record({ groundingShadow: [] })), /根拠の影判定/);
});

test('hostile values are escaped everywhere and the pages carry no script, handler or relaxed CSP', () => {
  const r = record({ finalError: XSS, strategy: XSS, scoring: { result: { figures: [{ human: { slot: XSS, rawName: XSS }, ai: { rawName: XSS }, matched: true }] } },
    events: [{ seq: XSS, speaker: XSS, at: XSS, origin: XSS, text: XSS }], humanSubmission: { [XSS]: XSS } });
  for (const html of [detail(r), renderList([{ ...summaryOf(), updatedAt: XSS, utteranceStyle: XSS }], { ...filter, status: XSS } as any, 'u:' + XSS, [{ recordHash: XSS, deletedAt: XSS, reason: 'admin' }])]) {
    assert.doesNotMatch(html, /<script/i); assert.doesNotMatch(html, /\son[a-z]+=/i); assert.doesNotMatch(html, /javascript:/i);
  }
  assert.match(detail(r), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(ADMIN_HEADERS['Content-Security-Policy'], "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  assert.doesNotMatch(ADMIN_CSS, /@import|url\(|https?:/);
});

test('narrow layout: the conversation and summary reflow without horizontal page scroll', () => {
  assert.match(ADMIN_CSS, /@media \(max-width:699px\)\{ol\.chat li,ol\.chat li\.human\{max-width:none;margin-left:0\}/);
  assert.match(ADMIN_CSS, /ol\.chat p\{[^}]*overflow-wrap:anywhere/); assert.match(ADMIN_CSS, /details\.diag>\.body\{[^}]*overflow-x:auto/);
});
