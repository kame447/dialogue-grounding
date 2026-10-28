import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const web = new URL('../dialogue-model/runtime/web/', import.meta.url);
const [script, html] = await Promise.all(['app.js', 'index.html'].map(name => readFile(new URL(name, web), 'utf8')));
class Element {
  tagName: string; children: Element[] = []; handlers: Record<string, Function[]> = {}; attributes: Record<string, string> = {};
  value = ''; _text = ''; disabled = false; hidden = false; open = false; scrollTop = 0; clientHeight = 400;
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
    stack.at(-1)!.append(node); if (!['input', 'meta', 'link', 'br'].includes(tag)) stack.push(node);
  }
  return { root, e: ids };
}
const tick = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
async function ui(initial: any = { trial: null, reception: { number: '007', status: 'waiting', revision: 0 } }, options: any = {}) {
  const { root, e } = makeDOM(); let state = initial, timerId = 0, receptionCalls = 0;
  const calls: any[] = [], timers = new Map<number, { callback: Function; delay: number }>(), listeners: Record<string, Function[]> = {};
  const document = { visibilityState: 'visible', getElementById: (id: string) => e[id],
    createElement: (tag: string) => new Element(tag), createElementNS: (_: unknown, tag: string) => new Element(tag),
    addEventListener(type: string, fn: Function) { (listeners[type] ??= []).push(fn); } };
  runInNewContext(script, { document,
    setTimeout: (callback: Function, delay: number) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
    fetch: async (path: string, opts: any) => {
      const body = opts?.body ? JSON.parse(opts.body) : undefined;
      calls.push({ path, method: opts?.method ?? 'GET', body });
      if (path === '/api/reception') receptionCalls++;
      const status = path === '/api/reception' && options.legacy ? 404 : 200;
      const value = path === '/api/records' ? { records: [] } : status === 404 ? { error: 'not_found' } : state;
      return { ok: status < 400, status, json: async () => clone(value) };
    },
  });
  function clone(value: any) { return structuredClone(value); }
  await tick();
  return { root, e, calls, timers, get receptionCalls() { return receptionCalls; }, setState(value: any) { state = value; },
    async poll() { const callbacks = [...timers.values()]; timers.clear(); for (const { callback } of callbacks) callback(); await tick(); },
    async hide(hidden: boolean) { document.visibilityState = hidden ? 'hidden' : 'visible'; for (const fn of listeners.visibilitychange ?? []) fn(); await tick(); },
  };
}
const visible = (node: Element): string => node.hidden || (['dialog', 'head'].includes(node.tagName) && !node.open) ? '' : node._text + node.children.map(visible).join('');

test('page explicitly POSTs one reception, shows neutral waiting and assigned number, disables start and never starts during polling', async () => {
  const x = await ui();
  assert.equal(x.calls[0].path, '/api/state', 'restore state before admission');
  assert.equal(x.receptionCalls, 1); assert.equal(x.calls.find(c => c.path === '/api/reception').method, 'POST');
  assert.equal(x.e['start-trial'].disabled, true); assert.equal(x.e['start-stage'].hidden, false);
  assert.match(visible(x.root), /007/u); assert.match(visible(x.root), /お待ちください/u);
  assert.ok([...x.timers.values()].some(t => t.delay >= 5000), 'waiting polls at a modest interval');
  x.e['start-trial'].fire('click'); await x.poll(); await x.poll();
  assert.equal(x.calls.filter(c => c.path === '/api/start').length, 0); assert.equal(x.receptionCalls, 1);
});

test('unassigned reception never renders placeholders or private settings; approved poll enables explicit start with revision', async () => {
  const x = await ui({ trial: null, reception: { number: null, status: 'waiting', revision: 0,
    receptionId: '11111111-1111-4111-8111-111111111111', protocolId: 'private-protocol', strategy: 'repair-first', seed: 4009, order: ['bypass-enabled'] } });
  assert.equal(x.e['start-trial'].disabled, true);
  assert.doesNotMatch(visible(x.root), /未割当|null|11111111|private-|repair-first|bypass-enabled|4009|seed|protocol/u);
  // Same state envelope as the real-edge ready contract (values are synthetic).
  x.setState({ trial: null, hideStrategy: true, busy: false, reception: { number: '007', status: 'ready', revision: 4 } });
  await x.poll(); assert.equal(x.e['start-trial'].disabled, false);
  x.e['start-trial'].fire('click'); await tick();
  assert.deepEqual(x.calls.filter(c => c.path === '/api/start'), [{ path: '/api/start', method: 'POST', body: { version: 2, expectedReceptionRevision: 4 } }]);
});

test('waiting reception polling stops while hidden and resumes on visibility', async () => {
  const x = await ui(); await x.hide(true);
  const before = x.calls.length; await x.poll(); await x.poll(); assert.equal(x.calls.length, before);
  await x.hide(false); await x.poll(); assert.ok(x.calls.length > before);
});

test('legacy state without reception mode preserves explicit start with no admission request', async () => {
  const x = await ui({ trial: null }, { legacy: true });
  assert.equal(x.receptionCalls, 0); assert.equal(x.e['start-trial'].disabled, false);
  x.e['start-trial'].fire('click'); await tick();
  assert.deepEqual(x.calls.filter(c => c.path === '/api/start'), [{ path: '/api/start', method: 'POST', body: { version: 2 } }]);
});

test('reception mode with an optional admission 404 preserves the known state and explicit start', async () => {
  const x = await ui({ trial: null, reception: { number: '007', status: 'ready', revision: 4 } }, { legacy: true });
  assert.equal(x.receptionCalls, 1); assert.equal(x.e['start-trial'].disabled, false);
  x.e['start-trial'].fire('click'); await tick();
  assert.deepEqual(x.calls.filter(c => c.path === '/api/start'), [{ path: '/api/start', method: 'POST', body: { version: 2, expectedReceptionRevision: 4 } }]);
});

test('unavailable reception never enables start', async () => {
  const x = await ui({ trial: null, reception: { number: '007', status: 'unavailable', revision: 2 } });
  assert.equal(x.e['start-trial'].disabled, true); x.e['start-trial'].fire('click'); await tick();
  assert.equal(x.calls.filter(c => c.path === '/api/start').length, 0);
});

test('completed trial offers the participant next start with both expected revision and predecessor', async () => {
  const current = { version: 2, sessionId: '33333333-3333-4333-8333-333333333333', status: 'completed',
    submitted: true, aiSubmitted: true, resultLocked: true, events: [], scene: { width: 1200, height: 800, shapes: [] } };
  const x = await ui({ trial: current, reception: { number: '007', status: 'in_progress', revision: 5 } });
  assert.equal(x.e['start-trial'].hidden, false); assert.equal(x.e['start-stage'].hidden, false);
  assert.equal(x.e['start-trial'].disabled, false); assert.equal(x.e['start-trial'].textContent.trim(), '次の課題を開始');
  x.e['start-trial'].fire('click'); await tick();
  assert.deepEqual(x.calls.filter(c => c.path === '/api/start'), [{ path: '/api/start', method: 'POST',
    body: { version: 2, expectedReceptionRevision: 5, expectedRecordId: current.sessionId } }]);
});

test('a reception waiting for the predecessor questionnaire never offers the next start until the server state changes', async () => {
  const current = { version: 2, sessionId: '33333333-3333-4333-8333-333333333333', status: 'completed',
    submitted: true, aiSubmitted: true, resultLocked: true, events: [], scene: { width: 1200, height: 800, shapes: [] } };
  const x = await ui({ trial: current, reception: { number: '007', status: 'questionnaire', revision: 5 } });
  assert.equal(x.e['start-trial'].disabled, true);
  assert.match(x.e['start-message'].textContent, /アンケートを提出すると、次の課題を開始できます。/u);
  x.e['start-trial'].fire('click'); await tick();
  assert.equal(x.calls.filter(c => c.path === '/api/start').length, 0);
  x.setState({ trial: current, reception: { number: '007', status: 'in_progress', revision: 5 } });
  await x.poll(); assert.equal(x.e['start-trial'].disabled, false);
  // The server-side refusal maps to the same participant sentence; reception_required reuses the existing contact sentence.
  assert.match(script, /questionnaire_required: "アンケートを提出すると、次の課題を開始できます。"/u);
  assert.match(script, /reception_required: "受付を確認できませんでした。" \+ contact/u);
});
