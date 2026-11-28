import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { handleAdmin, ADMIN_HEADERS, LIVE_CSP } from '../workers/tangram-experiment/src/admin/routes.ts';
import type { AdminDeps } from '../workers/tangram-experiment/src/admin/routes.ts';
import { LOG_LIVE_JS, LOG_DETAIL_POLL_MS, LOG_LIST_POLL_MS, LOG_HIDDEN_POLL_MS, LOG_REQUEST_TIMEOUT_MS } from '../workers/tangram-experiment/src/admin/log-live.ts';
import { summarizeRecord } from '../workers/tangram-experiment/src/admin/summary.ts';
import { summarizeLatency } from '../workers/tangram-experiment/src/admin/latency.ts';
import { FakeDocument, FakeElement, FakeText } from './support/i159-fake-dom.ts';

const TOKEN = 'synthetic-admin-log-01234567890123456789';
const RECORD = '11111111-1111-4111-8111-111111111111';
const OBJECT = 'a'.repeat(64), ORIGIN = 'https://admin-log.invalid';
const DETAIL = '/admin/record/' + RECORD;
const get = (path: string, auth = true) => new Request(ORIGIN + path, { headers: auth ? { Authorization: 'Bearer ' + TOKEN } : {} });
function fixture() {
  let record: any = { recordId: RECORD, startedAt: '2026-11-27T00:00:00.000Z', updatedAt: '2026-11-27T00:00:00.000Z',
    status: 'dialogue', strategy: 'repair-first', options: { referenceMemory: true },
    events: [{ id: 'a1', seq: 1, speaker: 'ai', text: '初回', at: '2026-11-27T00:00:00.000Z', origin: 'scripted_opening' }],
    judgments: [], attempts: [], requests: [], queueState: { pendingHumanEventIds: [] } };
  let reads = 0;
  const summary = () => record ? summarizeRecord(record, OBJECT, summarizeLatency(record)) : null;
  const deps: AdminDeps = { token: TOKEN, limiter: { async limit() { return { success: true }; } },
    async listPage() { const s = summary(); return { items: s ? [s] : [], next: null }; },
    async getSummary(id) { return id === RECORD ? summary() : null; },
    async getRecord() { reads++; return record; }, async deleteRecord() { assert.fail('polling is read only'); }, async audit() { return []; }, summarizeLatency };
  return { deps, get reads() { return reads; }, advance() {
    record.events.push({ id: 'h2', seq: 2, speaker: 'human', text: '追加発話', at: '2026-11-27T00:01:00.000Z' });
    record.updatedAt = '2026-11-27T00:01:00.000Z';
  }, delete() { record = null; } };
}

test('log pages alone load the authenticated same-origin polling script, while exports retain strict headers', async () => {
  const f = fixture();
  for (const path of ['/admin', DETAIL]) {
    const response = await handleAdmin(get(path), f.deps);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Security-Policy'), LIVE_CSP);
    const html = await response.text();
    assert.match(html, /id="admin-log-live" data-view="(list|detail)"/);
    assert.deepEqual(html.match(/<script[^>]*>[\s\S]*?<\/script>/g), ['<script src="/admin/log-live.js" defer></script>']);
  }
  assert.equal((await handleAdmin(get('/admin/log-live.js', false), f.deps)).status, 401);
  const script = await handleAdmin(get('/admin/log-live.js'), f.deps);
  assert.equal(script.status, 200); assert.equal(await script.text(), LOG_LIVE_JS);
  assert.equal(script.headers.get('Content-Security-Policy'), ADMIN_HEADERS['Content-Security-Policy']);
  const exported = await handleAdmin(get(DETAIL + '.json'), f.deps);
  assert.equal(exported.headers.get('Content-Security-Policy'), ADMIN_HEADERS['Content-Security-Policy']);
  assert.doesNotMatch(LOG_LIVE_JS, /localStorage|sessionStorage|\/api\/|eval\(/);
});

// Extend only the VM fixture, not the shared reception DOM or production code.
const originalAll = FakeElement.prototype.querySelectorAll;
const originalClosest = FakeElement.prototype.closest;
const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
function serialize(node: any): string {
  if (node instanceof FakeText) return esc(node.data);
  return '<' + node.tagName + [...node.attributes].map(([k,v]: [string,string]) => ' ' + k + '="' + esc(v) + '"').join('') + '>' +
    node.childNodes.map(serialize).join('') + '</' + node.tagName + '>';
}
Object.defineProperties(FakeElement.prototype, {
  innerHTML: { get(this: FakeElement) { return this.childNodes.map(serialize).join(''); } },
  open: { get(this: FakeElement) { return this.attributes.has('open'); }, set(this: FakeElement, value: boolean) {
    if (value) this.setAttribute('open', ''); else this.attributes.delete('open');
  } },
  defaultSelected: { get(this: FakeElement) { return this.attributes.has('selected'); } },
  options: { get(this: FakeElement) { return originalAll.call(this, 'option'); } },
  selectedIndex: { get(this: FakeElement) { return Math.max(0, originalAll.call(this, 'option').findIndex(o => o.attributes.has('selected'))); } },
});
(FakeElement.prototype as any).matches = function(selector: string) { return selector.split(',').map(s => s.trim()).includes(this.tagName); };
FakeElement.prototype.querySelectorAll = function(selector: string) {
  if (selector === '.turn-sheet') return this.descendants().filter(e => e.classList.contains('turn-sheet'));
  if (selector === 'a[href^="/admin/record/"]') return this.descendants().filter(e => e.tagName === 'a' && e.getAttribute('href')?.startsWith('/admin/record/'));
  return originalAll.call(this, selector);
};
FakeElement.prototype.closest = function(selector: string) { return originalClosest.call(this, selector); };

async function client(f: ReturnType<typeof fixture>, path = DETAIL) {
  const document = new FakeDocument(await (await handleAdmin(get(path), f.deps)).text());
  const root = document.getElementById('admin-log-live')!;
  const timers: { fn: () => void; ms: number }[] = [], requests: { path: string; init: any }[] = [];
  const listeners = new Map<string, () => void>();
  let override: Response | null = null, scroll: number[] = [];
  const context = vm.createContext({
    document, location: { pathname: new URL(ORIGIN + path).pathname, search: new URL(ORIGIN + path).search },
    window: { scrollX: 2, scrollY: 40, scrollTo: (...values: number[]) => { scroll = values; },
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn), getSelection: () => null },
    DOMParser: class { parseFromString(html: string) { return new FakeDocument(html); } },
    setTimeout: (fn: () => void, ms: number) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimeout: (timer: any) => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); },
    fetch: async (path: string, init: any) => { requests.push({path,init}); const r = override; override = null; return r ?? handleAdmin(get(path), f.deps); },
    AbortController, Date, Math, Number, Boolean, Error, Array, Promise, Set,
  });
  const initializeSheet = () => {
    const sheet: any = root.querySelector('.turn-sheet');
    if (sheet) Object.assign(sheet, { scrollTop: 80, scrollLeft: 30, scrollHeight: 1000, clientHeight: 300 });
    return sheet;
  };
  initializeSheet(); vm.runInContext(LOG_LIVE_JS, context);
  return { document, root, timers, requests, listeners, get scroll() { return scroll; }, reply(r: Response) { override = r; },
    async tick() {
      const timer = timers.shift(); assert.ok(timer); timer.fn();
      for (let i = 0; i < 300 && (timers.some(t => t.ms === LOG_REQUEST_TIMEOUT_MS) || !timers.length && !document.getElementById('admin-log-sync')!.textContent.includes('記録がありません') && !document.getElementById('admin-log-sync')!.textContent.includes('認証')); i++)
        await new Promise(r => setTimeout(r, 1));
    } };
}

test('detail updates an ongoing trial without reloading and preserves the open diagnostic and scroll positions', async () => {
  const f = fixture(), c = await client(f);
  assert.equal(c.timers[0].ms, LOG_DETAIL_POLL_MS);
  const fold: any = c.root.querySelectorAll('details').find(d => d.querySelector('summary')?.textContent.includes('確定した判断'));
  fold.open = true;
  f.advance(); await c.tick();
  assert.equal(c.requests.length, 1);
  assert.equal(c.requests[0].path, DETAIL);
  assert.equal(c.requests[0].init.credentials, 'same-origin'); assert.equal(c.requests[0].init.cache, 'no-store'); assert.equal(c.requests[0].init.redirect, 'error');
  assert.ok(c.root.textContent.includes('追加発話'));
  assert.ok((c.root.querySelectorAll('details').find(d => d.querySelector('summary')?.textContent.includes('確定した判断')) as any).open);
  assert.equal((c.root.querySelector('.turn-sheet') as any).scrollTop, 80);
  assert.equal((c.root.querySelector('.turn-sheet') as any).scrollLeft, 30);
  assert.deepEqual(c.scroll, [2,40]);
  const same = c.root.firstChild; await c.tick(); assert.equal(c.root.firstChild, same, 'unchanged markup is not replaced');
});

test('list keeps its filter URL, does not poll hidden tabs or erase a typed delete confirmation, then catches up', async () => {
  const f = fixture(), path = '/admin?status=active', c = await client(f,path);
  assert.equal(c.timers[0].ms, LOG_LIST_POLL_MS);
  const input = c.root.querySelector('input[name="confirm"]')!;
  input.value = 'typed';
  f.advance(); await c.tick(); assert.equal(c.requests.length, 0); assert.equal(input.value, 'typed');
  input.value = '';
  c.document.visibilityState = 'hidden'; c.document.dispatch('visibilitychange');
  assert.equal(c.timers[0].ms, LOG_HIDDEN_POLL_MS);
  await c.tick(); assert.equal(c.requests.length, 0);
  c.document.visibilityState = 'visible'; c.document.dispatch('visibilitychange');
  await c.tick(); assert.equal(c.requests[0].path, path); assert.ok(c.root.textContent.includes('人/AI 1/1'));
  c.listeners.get('pagehide')!(); assert.equal(c.timers.length, 0);
  c.listeners.get('pageshow')!(); assert.equal(c.timers.length, 1);
});

test('a rate limit backs off, and a deleted detail stops polling and removes stale contents', async () => {
  const f = fixture(), c = await client(f);
  c.reply(new Response('', {status:429,headers:{'Retry-After':'60'}})); await c.tick();
  assert.ok(c.timers[0].ms >= 59000);
  // The client waits until the retry deadline; test deletion on another fresh view.
  const d = await client(f);
  f.delete(); await d.tick();
  assert.equal(d.root.textContent, '');
  assert.equal(d.timers.length, 0);
  assert.match(d.document.getElementById('admin-log-sync')!.textContent, /記録がありません/);
});
