// Reception / earlier-session UI: a new tab starts at the entry screen, a reload keeps the tab's session,
// earlier sessions are listed by server state only, and a finished session is viewed, never resumed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const web = new URL('../dialogue-model/runtime/web/', import.meta.url);
const [script, html] = await Promise.all(['app.js', 'index.html'].map(name => readFile(new URL(name, web), 'utf8')));
class Element {
  tagName: string; children: Element[] = []; handlers: Record<string, Function[]> = {}; attributes: Record<string, string> = {};
  value = ''; _text = ''; disabled = false; hidden = false; open = false; scrollTop = 0; clientHeight = 400; className = '';
  constructor(tag: string) { this.tagName = tag; }
  set textContent(value: string) { this._text = String(value); this.children = []; }
  get textContent(): string { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this._text = ''; this.children = [...children]; }
  setAttribute(name: string, value: string) { this.attributes[name] = String(value); if (name === 'hidden' || name === 'disabled') this[name] = true; }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  get scrollHeight() { return this.children.length * 200; }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(child => [...(selector.split(',').some(part => part.trim() === child.tagName) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  addEventListener(type: string, handler: Function) { (this.handlers[type] ??= []).push(handler); }
  fire(type: string) { for (const handler of this.handlers[type] ?? []) handler({ target: this, preventDefault() {} }); }
  focus() {} showModal() { this.open = true; } close() { this.open = false; } scrollTo({ top }: { top: number }) { this.scrollTop = top; }
  getBBox() { return { x: 100, y: 150, width: 130, height: 180 }; }
}
function makeDOM() {
  const root = new Element('document'), stack = [root], ids: Record<string, Element> = {};
  for (const token of html.matchAll(/<!--[\s\S]*?-->|<\/?([\w-]+)\b([^>]*?)>|([^<]+)/gu)) {
    const [, tag, rest, text] = token;
    if (text) { stack.at(-1)!._text += text; continue; } if (!tag) continue;
    if (token[0].startsWith('</')) { if (stack.at(-1)?.tagName === tag) stack.pop(); continue; }
    const node = new Element(tag);
    for (const [, name, quoted, unquoted] of rest.matchAll(/([\w-]+)(?:="([^"]*)"|=([^\s]+))?/gu)) node.setAttribute(name, quoted ?? unquoted ?? '');
    node.value = node.getAttribute('value') ?? '';
    if (node.getAttribute('id')) ids[node.getAttribute('id')] = node;
    stack.at(-1)!.append(node); if (!['input', 'meta', 'link', 'br', 'script'].includes(tag)) stack.push(node);
  }
  return { root, e: ids };
}
const tick = async () => { for (let i = 0; i < 120; i++) await Promise.resolve(); };
const SECRET = 'SECRET-CONVERSATION-TEXT';
const SHAPES = { width: 1200, height: 800, shapes: [{ id: 's1', path: 'M0 0 L10 0 L10 10 Z' }] };
const recordOf = (recordId: string, questionnaire = 'submitted', status = 'completed') => ({ recordId, status, startedAt: '2026-11-23T01:00:00Z', updatedAt: '2026-11-23T01:30:00Z', active: false, questionnaire });
const summary = (sessionId: string, status: string, extra: any = {}) => ({ sessionId, createdAt: '2026-11-23T01:00:00Z', updatedAt: '2026-11-23T01:30:00Z', status, resumable: !['finished', 'cancelled', 'unavailable'].includes(status),
  hasUnansweredQuestionnaire: false, reception: { number: '0' + sessionId.length, status: 'waiting', revision: 1 }, activeRecordId: null, records: [], conversation: SECRET, ...extra });
const completedTrial = (id = 'r1') => ({ version: 2, sessionId: id, status: 'completed', submitted: true, aiSubmitted: true, aiStatus: 'idle', scene: SHAPES,
  events: [{ id: 0, speaker: 'human', text: 'hello' }], humanSubmission: { s1: 'a' }, result: { provisional: true, success: true, matchedCount: 1, total: 1, figures: [{ human: { slot: 's1', rawName: 'a' }, ai: { rawName: 'a' }, matched: true }] } });
const FORM = { version: 'v', notice: '', items: [{ id: 'q1', text: 'Q1', min: 1, max: 7, minLabel: 'a', maxLabel: 'b' }] };

type Server = { historyGate?: Promise<void>; historyStatus?: number; mode?: string; sessions?: any[]; states?: Record<string, any>; reviews?: Record<string, any>; questionnaire?: any; saveStatus?: number; legacySessions404?: boolean; receptionStatus?: number; stateStatus?: Record<string, number>; local?: Map<string, string> };
async function ui(resolved: any, server: Server = {}, hash = '') {
  const { root, e } = makeDOM();
  const calls: { path: string; method: string; body: any; session: string | null }[] = [], timers = new Map<number, { callback: Function; delay: number }>();
  const tabCalls: string[] = []; let timerId = 0, counter = 0;
  const srv = { mode: 'on', sessions: [], states: {}, reviews: {}, ...server };
  const store = srv.local ?? new Map<string, string>();
  const localStorage = {
    get length() { return store.size; },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
  };
  const document = { visibilityState: 'visible', getElementById: (id: string) => e[id], createElement: (tag: string) => new Element(tag),
    createElementNS: (_: unknown, tag: string) => new Element(tag), addEventListener() {} };
  const reply = (status: number, value: any) => ({ ok: status < 400, status, json: async () => structuredClone(value) });
  runInNewContext(script, { document, localStorage, location: { hash, pathname: '/', search: '' },
    TangramTabSession: resolved === null ? undefined : { resolve: async () => resolved, bind: (id: string) => tabCalls.push('bind:' + id), clear: () => tabCalls.push('clear'), current: () => null, dispose() {} },
    setTimeout: (callback: Function, delay: number) => { timers.set(++timerId, { callback, delay }); return timerId; }, clearTimeout: (id: number) => timers.delete(id),
    fetch: async (path: string, opts: any) => {
      const body = opts?.body ? JSON.parse(opts.body) : undefined, session = opts?.headers?.['X-Tab-Session'] ?? null, method = opts?.method ?? 'GET';
      calls.push({ path, method, body, session });
      if (path === '/api/sessions' && method === 'GET') {
        const snapshot = { receptionMode: srv.mode, sessions: srv.sessions };
        if (srv.historyGate) await srv.historyGate;
        if (srv.historyStatus) return reply(srv.historyStatus, { error: 'trial_unavailable' });
        return srv.legacySessions404 ? reply(404, { error: 'not_found' }) : reply(200, snapshot);
      }
      if (path === '/api/sessions') { const sessionId = '00000000-0000-4000-8000-00000000000' + ++counter; srv.states[sessionId] = { trial: null, ...(srv.mode === 'on' ? { reception: { number: null, status: 'waiting', revision: 0 } } : {}) }; return reply(200, { sessionId, state: srv.states[sessionId] }); }
      if (path === '/api/reception') {
        if (srv.receptionStatus) return reply(srv.receptionStatus, { error: 'reception_unavailable' });
        const state = srv.states[session!] ?? { trial: null }; state.reception = { number: '042', status: 'waiting', revision: 1 }; return reply(200, state);
      }
      if (path === '/api/state') {
        const key = session ?? 'cookie';
        if (srv.stateStatus?.[key]) return reply(srv.stateStatus[key], { error: srv.stateStatus[key] === 401 ? 'session_required' : 'not_found' });
        return srv.states[key] ? reply(200, srv.states[key]) : reply(404, { error: 'not_found' });
      }
      if (path === '/api/names') return reply(200, srv.states[session ?? 'cookie'] ?? { trial: null });
      if (path === '/api/records') return reply(200, { records: [] });
      const m = path.match(/^\/api\/records\/([^/]+)\/(review|questionnaire)$/u);
      if (m?.[2] === 'review') return srv.reviews[m[1]] ? reply(200, srv.reviews[m[1]]) : reply(404, { error: 'not_found' });
      if (m?.[2] === 'questionnaire') {
        if (!srv.questionnaire) return reply(404, { error: 'not_found' });
        if (body && srv.saveStatus) return reply(srv.saveStatus, { error: 'trial_changed' });
        return reply(200, { recordId: m[1], form: FORM, questionnaire: srv.questionnaire });
      }
      return reply(404, { error: 'not_found' });
    } });
  await tick();
  const text = (node: Element = root): string => node._text + node.children.map(text).join('');
  const rows = () => e['session-list'].children.map(li => ({ li, text: text(li), buttons: li.querySelectorAll('button') }));
  return { root, e, calls, timers, tabCalls, srv, store, text, rows, session: (n: number) => '00000000-0000-4000-8000-00000000000' + n };
}
const fresh = { kind: 'fresh', reason: 'new_tab', sessionId: null, tabToken: 't' };
const ALL = ['waiting', 'ready', 'in_progress', 'submitting', 'questionnaire_waiting', 'ready_next', 'finished', 'cancelled', 'unavailable'];
const history = () => [...ALL.map((status, i) => summary('sess-' + status, status, { reception: { number: String(i + 1).padStart(3, '0'), status: 'waiting', revision: 1 }, records: status === 'finished' ? [recordOf('r-' + status)] : [] })),
  summary('sess-finished-open', 'finished', { hasUnansweredQuestionnaire: true, records: [recordOf('r-open', 'draft')] })];
const labelOf = (row: { text: string }) => row.text;

test('a new tab with earlier sessions shows the entry screen, not a conversation, and sends no reception', async () => {
  const x = await ui(fresh, { sessions: history() });
  assert.equal(x.calls[0].path, '/api/sessions');
  assert.deepEqual(x.calls.map(c => c.path + ' ' + c.method), ['/api/sessions GET'], 'no state, record, reception or session creation');
  assert.equal(x.e['entry-stage'].hidden, false); assert.equal(x.e['start-stage'].hidden, true); assert.equal(x.e.trial.hidden, true);
  assert.equal(x.e['new-session'].textContent, '新しく始める'); assert.equal(x.e['new-session'].disabled, false);
  assert.equal(x.e['session-history'].hidden, false); assert.equal(x.e['session-history'].open, false, 'the list is closed at first');
  assert.equal(x.e['session-summary'].textContent, 'このブラウザの以前の試行・受付');
  assert.equal(x.text(x.e['entry-stage']).includes(SECRET), false, 'no conversation text from the session summaries');
  assert.equal(x.text().includes('sess-'), false, 'no internal ids on the page');
  assert.equal(x.tabCalls.length, 0);
});

test('entry is usable while history is pending; late empty history cannot create a second reception', async () => {
  let release!: () => void;
  const historyGate = new Promise<void>(resolve => { release = resolve; });
  const x = await ui(fresh, { historyGate, sessions: [] });
  assert.equal(x.e['entry-stage'].hidden, false);
  assert.equal(x.e['new-session'].disabled, false);
  assert.equal(x.e['session-list'].textContent, '読み込み中…');
  x.e['new-session'].fire('click'); await tick();
  assert.match(x.text(x.e['start-stage']), /受付番号 042/u);
  release(); await tick();
  assert.equal(x.e['entry-stage'].hidden, true);
  assert.equal(x.e['start-stage'].hidden, false);
  assert.equal(x.calls.filter(c => c.path === '/api/sessions' && c.method === 'POST').length, 1);
  assert.equal(x.calls.filter(c => c.path === '/api/reception').length, 1);
});

test('failure of optional history does not block a new reception', async () => {
  const x = await ui(fresh, { historyStatus: 503 });
  assert.equal(x.e['entry-stage'].hidden, false);
  assert.equal(x.e['new-session'].disabled, false);
  assert.equal(x.e['notice'].textContent, '');
  x.e['new-session'].fire('click'); await tick();
  assert.match(x.text(x.e['start-stage']), /受付番号 042/u);
});

test('each server state has its own badge and actions; a finished session only offers viewing', async () => {
  const x = await ui(fresh, { sessions: history() });
  const byId = Object.fromEntries(x.rows().map(r => [r.li.getAttribute('data-status') + (r.text.includes('アンケート未回答') ? '+open' : ''), r]));
  const expected: Record<string, [string, string[]]> = {
    waiting: ['受付待ち', ['開く']], ready: ['開始可能', ['開く']], in_progress: ['実施中', ['再開']], submitting: ['提出中', ['再開']],
    questionnaire_waiting: ['アンケート待ち', ['アンケートへ']], ready_next: ['次の課題待ち', ['再開']], finished: ['終了', ['閲覧']],
    'finished+open': ['終了・アンケート未回答', ['閲覧', 'アンケート']], cancelled: ['取消済み', []], unavailable: ['確認不可', []] };
  for (const [key, [badge, actions]] of Object.entries(expected)) {
    assert.ok(byId[key], key); assert.ok(labelOf(byId[key]).includes(badge), `${key}: ${labelOf(byId[key])}`);
    assert.deepEqual(byId[key].buttons.map(b => b.textContent), actions, key);
  }
  assert.doesNotMatch(labelOf(byId.finished), /アンケート未回答/u, 'a plain finished session is not marked unanswered');
  for (const key of ['finished', 'finished+open', 'cancelled', 'unavailable']) assert.ok(!byId[key].buttons.some(b => b.textContent === '再開'), key);
  assert.match(labelOf(byId.waiting), /受付番号 001/u);
});

test('新しく始める creates a session, binds it and POSTs one reception with that session', async () => {
  const x = await ui(fresh, { sessions: history() });
  x.e['new-session'].fire('click'); await tick();
  const id = x.session(1);
  assert.deepEqual(x.calls.slice(1).filter(c => c.path !== '/api/records').map(c => `${c.method} ${c.path} ${c.session}`), [`POST /api/sessions null`, `POST /api/reception ${id}`]);
  assert.deepEqual(x.tabCalls, ['bind:' + id]);
  assert.equal(x.e['entry-stage'].hidden, true); assert.equal(x.e['start-stage'].hidden, false);
  assert.match(x.text(x.e['start-stage']), /受付番号 042/u);
  assert.equal(x.calls.some(c => c.path === '/api/state' && c.session === null), false);
});

test('the first visit of a clean browser starts a session and a reception without a click; with receptions off it shows the start screen', async () => {
  const on = await ui(fresh, { sessions: [] });
  assert.deepEqual(on.calls.filter(c => c.path !== '/api/records').map(c => `${c.method} ${c.path}`), ['GET /api/sessions', 'POST /api/sessions', 'POST /api/reception']);
  assert.match(on.text(on.e['start-stage']), /受付番号 042/u); assert.equal(on.e['entry-stage'].hidden, true);
  const off = await ui(fresh, { sessions: [], mode: 'off' });
  assert.deepEqual(off.calls.filter(c => c.path !== '/api/records').map(c => `${c.method} ${c.path}`), ['GET /api/sessions', 'POST /api/sessions']);
  assert.equal(off.e['start-stage'].hidden, false); assert.equal(off.e['start-trial'].textContent, 'スタート');
});

test('a reload of the same tab restores that session; an expired one is forgotten and the entry screen shows', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const restored = { kind: 'restored', reason: 'same_tab', sessionId: id, tabToken: 't' };
  const x = await ui(restored, { sessions: history(), states: { [id]: { trial: completedTrial(), reception: { number: '007', status: 'in_progress', revision: 2 } } } });
  assert.deepEqual(x.calls.map(c => `${c.method} ${c.path} ${c.session}`).slice(0, 1), [`GET /api/state ${id}`]);
  assert.equal(x.calls.some(c => c.path === '/api/sessions'), false); assert.equal(x.calls.some(c => c.method === 'POST' && c.path === '/api/reception'), false);
  assert.equal(x.e.trial.hidden, false); assert.equal(x.e['entry-stage'].hidden, true);
  const gone = await ui(restored, { sessions: history(), states: {} });
  assert.ok(gone.tabCalls.includes('clear')); assert.equal(gone.e['entry-stage'].hidden, false); assert.equal(gone.e.trial.hidden, true);
  assert.equal(gone.calls.some(c => c.method === 'POST'), false, 'an expired tab never creates a reception by itself');
});

test('再開 binds the chosen session and reads its state with its header', async () => {
  const x = await ui(fresh, { sessions: history() });
  const row = x.rows().find(r => r.li.getAttribute('data-status') === 'in_progress')!;
  x.srv.states['sess-in_progress'] = { trial: { ...completedTrial('r-live'), status: 'dialogue', submitted: false, aiSubmitted: false, result: null }, reception: { number: '003', status: 'in_progress', revision: 2 } };
  row.buttons[0].fire('click'); await tick();
  assert.deepEqual(x.calls.slice(1).map(c => `${c.method} ${c.path} ${c.session}`).slice(0, 1), ['GET /api/state sess-in_progress']);
  assert.deepEqual(x.tabCalls, ['bind:sess-in_progress']);
  assert.equal(x.e.trial.hidden, false); assert.equal(x.e['entry-stage'].hidden, true);
});

test('閲覧 opens a finished session read-only without binding or reading its state, and 受付に戻る returns to the entry screen', async () => {
  const x = await ui(fresh, { sessions: history(), reviews: { 'r-finished': { recordId: 'r-finished', scene: SHAPES, events: [{ id: 0, speaker: 'human', text: 'hi' }], humanSubmission: { s1: 'a' }, result: null, resultLocked: false } } });
  const row = x.rows().find(r => r.li.getAttribute('data-status') === 'finished' && !r.text.includes('未回答'))!;
  row.buttons[0].fire('click'); await tick();
  const review = x.calls.find(c => c.path === '/api/records/r-finished/review')!;
  assert.equal(review.session, 'sess-finished'); assert.equal(x.tabCalls.length, 0, 'viewing does not bind the tab');
  assert.equal(x.calls.some(c => c.path === '/api/state'), false);
  assert.equal(x.e.trial.hidden, false); assert.equal(x.e['entry-stage'].hidden, true);
  assert.equal(x.e['chat'].hidden, true, 'no composer for a finished trial'); assert.equal(x.e['start-trial'].disabled, true);
  assert.equal(x.e['exit-review'].textContent, '受付に戻る');
  const before = x.calls.length;
  x.e['exit-review'].fire('click'); await tick();
  assert.equal(x.e['entry-stage'].hidden, false); assert.equal(x.e.trial.hidden, true);
  assert.equal(x.calls.slice(before).some(c => c.path === '/api/state'), false, 'leaving never reads the cookie session');
});

test('a finished session with an unanswered questionnaire opens the questionnaire of its own session', async () => {
  const x = await ui(fresh, { sessions: history(), questionnaire: { status: 'draft', answers: {}, comment: '', updatedAt: 'T1' },
    reviews: { 'r-open': { recordId: 'r-open', scene: SHAPES, events: [], humanSubmission: {}, result: null, resultLocked: true } } });
  x.rows().find(r => r.text.includes('終了・アンケート未回答'))!.buttons.find(b => b.textContent === 'アンケート')!.fire('click'); await tick();
  assert.equal(x.e['questionnaire-stage'].hidden, false);
  assert.ok(x.calls.filter(c => c.path === '/api/records/r-open/questionnaire').every(c => c.session === 'sess-finished-open'));
  assert.equal(x.tabCalls.length, 0);
});

test('a finished trial offers 新しく始める, which forgets the session and starts a new reception', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const x = await ui({ kind: 'restored', reason: 'same_tab', sessionId: id, tabToken: 't' },
    { states: { [id]: { trial: completedTrial(), reception: { number: '007', status: 'finished', revision: 4 } } }, questionnaire: { status: 'submitted', answers: { q1: 3 }, comment: '', updatedAt: 'T9' } });
  assert.equal(x.e['leave-session'].hidden, false); assert.equal(x.e['leave-session'].textContent, '新しく始める');
  x.e['leave-session'].fire('click'); await tick();
  assert.deepEqual(x.tabCalls.slice(0, 2), ['clear', 'bind:' + x.session(1)]);
  assert.match(x.text(x.e['start-stage']), /受付番号 042/u);
  assert.equal(x.e['leave-session'].textContent, '受付に戻る');
});

test('the waiting screen offers 受付に戻る, which lists the waiting reception as an earlier one', async () => {
  const x = await ui(fresh, { sessions: [] });
  assert.equal(x.e['leave-session'].hidden, false); assert.equal(x.e['leave-session'].textContent, '受付に戻る');
  x.srv.sessions = [summary(x.session(1), 'waiting', { reception: { number: '042', status: 'waiting', revision: 1 } })];
  const before = x.calls.length;
  x.e['leave-session'].fire('click'); await tick();
  assert.equal(x.e['entry-stage'].hidden, false); assert.equal(x.e['start-stage'].hidden, true);
  assert.deepEqual(x.calls.slice(before).map(c => `${c.method} ${c.path}`), ['GET /api/sessions'], 'no new reception until 新しく始める');
  assert.match(x.rows()[0].text, /受付番号 042/u);
});

test('without tab-session.js, or on a server without /api/sessions, the single cookie session flow is unchanged', async () => {
  const noScript = await ui(null, { states: { cookie: { trial: null, reception: { number: '007', status: 'waiting', revision: 0 } } } });
  assert.equal(noScript.calls[0].path, '/api/state'); assert.equal(noScript.e['entry-stage'].hidden, true);
  const old = await ui(fresh, { legacySessions404: true, states: { cookie: { trial: null, reception: { number: '007', status: 'waiting', revision: 0 } } } });
  assert.deepEqual(old.calls.slice(0, 2).map(c => c.path), ['/api/sessions', '/api/state']);
  assert.equal(old.e['start-stage'].hidden, false); assert.equal(old.e['leave-session'].hidden, true);
});

test('a questionnaire save carries the version it was based on; a 409 shows the server copy instead of overwriting it', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const x = await ui({ kind: 'restored', reason: 'same_tab', sessionId: id, tabToken: 't' },
    { states: { [id]: { trial: completedTrial(), reception: { number: '007', status: 'in_progress', revision: 2 } } }, questionnaire: { status: 'draft', answers: {}, comment: '', updatedAt: 'T1' }, saveStatus: 409 });
  const radio = x.e['questionnaire-items'].children[0].querySelectorAll('input')[2]; radio.fire('change');
  for (const [timerKey, timer] of [...x.timers]) if (timer.delay === 2000) { x.timers.delete(timerKey); timer.callback(); } await tick();
  const save = x.calls.find(c => c.method === 'POST' && c.path === '/api/records/r1/questionnaire')!;
  assert.equal(save.body.expectedUpdatedAt, 'T1'); assert.equal(save.session, id);
  const reads = x.calls.filter(c => c.method === 'GET' && c.path === '/api/records/r1/questionnaire');
  assert.ok(reads.length >= 2, 'the conflict re-reads the questionnaire');
  assert.match(x.e['questionnaire-status'].textContent, /最新の回答/u);
});

test('tab-scoped /api/records never prunes another tab session unsynced survey draft from localStorage', async () => {
  const local = new Map([['joint-naming-survey:other-tab-rec', JSON.stringify({ answers: { q1: 5 }, comment: 'tab-b', synced: false, baseUpdatedAt: null })]]);
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const x = await ui({ kind: 'restored', reason: 'reload', sessionId: id, tabToken: 't' }, {
    local, states: { [id]: { trial: null, reception: { number: '007', status: 'waiting', revision: 1 } } },
  });
  assert.ok(x.calls.some(c => c.path === '/api/records'), 'tab A loaded its own empty record list');
  assert.ok(local.has('joint-naming-survey:other-tab-rec'), 'tab B unsynced draft survives tab A scoped record fetch');
});

test('offline local survey draft sends its own baseUpdatedAt rather than borrowing a newer server updatedAt', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const local = new Map([['joint-naming-survey:r1', JSON.stringify({ answers: { q1: 2 }, comment: 'stale', synced: false, baseUpdatedAt: 'T0' })]]);
  const x = await ui({ kind: 'restored', reason: 'reload', sessionId: id, tabToken: 't' }, {
    local, states: { [id]: { trial: completedTrial('r1'), reception: { number: '007', status: 'in_progress', revision: 2 } } },
    questionnaire: { status: 'draft', answers: { q1: 6 }, comment: 'newer-tab-b', updatedAt: 'T1' },
    saveStatus: 409,
  });
  for (const [timerKey, timer] of [...x.timers]) if (timer.delay === 0) { x.timers.delete(timerKey); timer.callback(); } await tick();
  const save = x.calls.find(c => c.method === 'POST' && c.path === '/api/records/r1/questionnaire')!;
  assert.equal(save.body.expectedUpdatedAt, 'T0', 'must send baseUpdatedAt from local edit, never T1');
});

test('a finished multi-trial reception exposes every completed trial individually in chronological order', async () => {
  const multi = summary('sess-multi', 'finished', {
    hasUnansweredQuestionnaire: true,
    // Server sortRecordList delivers newest first; UI must still reach both trials.
    records: [
      { recordId: 'r-second', status: 'completed', startedAt: '2026-11-23T02:00:00Z', updatedAt: '2026-11-23T02:10:00Z', active: true, questionnaire: 'submitted' },
      { recordId: 'r-first', status: 'completed', startedAt: '2026-11-23T01:00:00Z', updatedAt: '2026-11-23T01:10:00Z', active: false, questionnaire: 'none' },
    ],
  });
  const x = await ui(fresh, {
    sessions: [multi],
    reviews: {
      'r-first': { recordId: 'r-first', scene: SHAPES, events: [], humanSubmission: { s1: 'first' }, result: null, resultLocked: true },
      'r-second': { recordId: 'r-second', scene: SHAPES, events: [], humanSubmission: { s1: 'second' }, result: null, resultLocked: false },
    },
  });
  const buttons = x.rows()[0].buttons;
  assert.deepEqual(buttons.map(b => b.textContent), ['1回目を見る', '1回目アンケート', '2回目を見る']);
  buttons[2].fire('click'); await tick();
  assert.ok(x.calls.some(c => c.path === '/api/records/r-second/review' && c.session === 'sess-multi'), 'newest completed trial is reachable');
});

test('confirm-names dialog closes and preserves snapshot eventCount if conversation advances before submit', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const live = { version: 2, sessionId: 'r-live', status: 'dialogue', submitted: false, aiSubmitted: false, aiStatus: 'idle', scene: SHAPES,
    events: [{ id: 1, speaker: 'ai', text: 'first' }] };
  const x = await ui({ kind: 'restored', reason: 'reload', sessionId: id, tabToken: 't' }, {
    states: { [id]: { trial: live, reception: { number: '007', status: 'in_progress', revision: 2 } } },
  });
  // Enter name for the single figure and open confirmation dialog at 1 event.
  x.e.board.querySelectorAll('path')[0].fire('click');
  x.e['figure-name'].value = '三角';
  x.e['name-form'].fire('submit');
  x.e.submission.fire('submit');
  assert.equal(x.e['confirm-dialog'].open, true);
  // Another tab adds a second event and poll delivers it while dialog is open.
  x.srv.states[id] = { trial: { ...live, events: [...live.events, { id: 2, speaker: 'human', text: 'new msg' }] }, reception: { number: '007', status: 'in_progress', revision: 2 } };
  for (const [k, t] of [...x.timers]) if (t.delay === 2000) { x.timers.delete(k); t.callback(); } await tick();
  assert.equal(x.e['confirm-dialog'].open, false, 'dialog closes on conversation change');
  assert.match(x.e.notice.textContent, /更新したため/u);
});

test('newSession 503 reception failure recovers to entry and reuses child slot; 401 deleted child returns to entry', async () => {
  const x = await ui(fresh, { sessions: history(), receptionStatus: 503 });
  x.e['new-session'].fire('click'); await tick();
  assert.equal(x.e['entry-stage'].hidden, false, 'user is never stranded on a blank screen');
  assert.equal(x.e['new-session'].disabled, false);
  assert.match(x.e.notice.textContent, /受付を確認できませんでした/u);
  const createdCount = x.calls.filter(c => c.method === 'POST' && c.path === '/api/sessions').length;
  assert.equal(createdCount, 1);
  // Retry succeeds and reuses the same empty child without creating a second one.
  x.srv.receptionStatus = undefined;
  x.e['new-session'].fire('click'); await tick();
  assert.equal(x.calls.filter(c => c.method === 'POST' && c.path === '/api/sessions').length, 1);
  assert.equal(x.e['start-stage'].hidden, false);

  const deletedId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const y = await ui({ kind: 'restored', reason: 'reload', sessionId: deletedId, tabToken: 't' }, {
    sessions: history(), stateStatus: { [deletedId]: 401 },
  });
  assert.ok(y.tabCalls.includes('clear'), '401 clears dead child binding');
  assert.equal(y.e['entry-stage'].hidden, false, 'returns to entry screen instead of looping');
  assert.equal([...y.timers.values()].some(t => t.delay === 5000), false, 'no infinite 5s retry loop');
});

test('a delayed dialogue poll arriving after names submission never regresses a completed trial back to active chat', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const live = { version: 2, sessionId: 'r-live', status: 'dialogue', submitted: false, aiSubmitted: false, aiStatus: 'idle', scene: SHAPES,
    events: [{ id: 1, speaker: 'ai', text: 'hello' }] };
  const done = { ...live, status: 'completed', submitted: true, aiSubmitted: true, resultLocked: true, humanSubmission: { s1: '三角' } };
  let releaseStalePoll!: () => void;
  let holdNextState = false;
  const { root, e } = makeDOM();
  const timers = new Map<number, { callback: Function; delay: number }>(); let timerId = 0;
  let stateToServe: any = { trial: live, reception: { number: '007', status: 'in_progress', revision: 2 } };
  const reply = (status: number, value: any) => ({ ok: status < 400, status, json: async () => structuredClone(value) });
  const document = { visibilityState: 'visible', getElementById: (k: string) => e[k], createElement: (tag: string) => new Element(tag),
    createElementNS: (_: unknown, tag: string) => new Element(tag), addEventListener() {} };
  runInNewContext(script, { document,
    TangramTabSession: { resolve: async () => ({ kind: 'restored', reason: 'reload', sessionId: id, tabToken: 't' }), bind() {}, clear() {}, current: () => id, dispose() {} },
    setTimeout: (callback: Function, delay: number) => { timers.set(++timerId, { callback, delay }); return timerId; }, clearTimeout: (k: number) => timers.delete(k),
    fetch: async (path: string, opts: any) => {
      if (path === '/api/state') {
        const snapshot = structuredClone(stateToServe);
        if (holdNextState) {
          holdNextState = false;
          await new Promise<void>((r) => { releaseStalePoll = r; });
        }
        return reply(200, snapshot);
      }
      if (path === '/api/names') {
        stateToServe = { trial: done, reception: { number: '007', status: 'finished', revision: 3 } };
        return reply(200, stateToServe);
      }
      if (path === '/api/records') return reply(200, { records: [] });
      if (path.endsWith('/questionnaire')) return reply(200, { recordId: 'r-live', form: FORM, questionnaire: null });
      return reply(404, { error: 'not_found' });
    } });
  await tick();
  e.board.querySelectorAll('path')[0].fire('click');
  e['figure-name'].value = '三角';
  e['name-form'].fire('submit');
  e.submission.fire('submit');
  // Start a poll while still dialogue, hold its response until after /api/names completes.
  holdNextState = true;
  for (const [k, t] of [...timers]) if (t.delay === 2000) { timers.delete(k); t.callback(); }
  await Promise.resolve();
  e['confirm-submit'].fire('click');
  await tick();
  assert.equal(e.chat.hidden, true, 'completed trial hides composer');
  // Now release the older dialogue poll response.
  releaseStalePoll();
  await tick();
  assert.equal(e.chat.hidden, true, 'delayed dialogue poll must not re-open composer');
  assert.equal(e.utterance.disabled, true, 'composer remains disabled');
  assert.ok(root);
});

const LINK_RECORD = '11111111-1111-4111-8111-111111111111';
const LINK_SESSION = '22222222-2222-4222-8222-222222222222';
const linkedTrial = { ...completedTrial(LINK_RECORD), status: 'dialogue', submitted: false, aiSubmitted: false, result: null };
const linkedSession = summary(LINK_SESSION, 'in_progress', { activeRecordId: LINK_RECORD });

test('explicit active-record link opens exactly the selected session without a new reception', async () => {
  const x = await ui(fresh, { sessions: [linkedSession, summary('unrelated', 'in_progress', { activeRecordId: 'other' })],
    states: { [LINK_SESSION]: { trial: linkedTrial } } }, '#resume=' + LINK_RECORD);
  assert.deepEqual(x.calls.filter(c => ['/api/sessions', '/api/state'].includes(c.path)).map(c => [c.method, c.path, c.session]),
    [['GET', '/api/sessions', null], ['GET', '/api/state', LINK_SESSION]]);
  assert.deepEqual(x.tabCalls, ['clear', 'bind:' + LINK_SESSION]);
  assert.equal(x.e.trial.hidden, false);
  assert.equal(x.calls.some(c => c.method === 'POST'), false);
});

test('foreign, finished, malformed or changed record links never open another trial or create a session', async () => {
  for (const [sessions, states, hash] of [
    [[], {}, '#resume=' + LINK_RECORD],
    [[summary(LINK_SESSION, 'finished', { activeRecordId: LINK_RECORD })], {}, '#resume=' + LINK_RECORD],
    [[linkedSession], { [LINK_SESSION]: { trial: completedTrial('changed') } }, '#resume=' + LINK_RECORD],
    [[linkedSession], {}, '#resume=invalid'],
  ] as const) {
    const x = await ui(fresh, { sessions: [...sessions], states }, hash);
    assert.equal(x.e.trial.hidden, true);
    assert.match(x.e.notice.textContent, /この試行を開けませんでした/u);
    assert.equal(x.tabCalls.some(c => c.startsWith('bind:')), false);
    assert.equal(x.calls.some(c => c.method === 'POST'), false);
  }
});
