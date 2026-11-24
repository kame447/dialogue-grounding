import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';

const script = readFileSync(new URL('../dialogue-model/runtime/web/tab-session.js', import.meta.url), 'utf8');
const id = 'd771b010-99df-4da1-ad3e-b256c400b8a5';
const ownerName = (token: string) => 'tangram-tab-owner:' + token;

function lockRegistry() {
  const held = new Set<string>();
  return {
    held,
    async request(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => unknown) {
      assert.equal(options.ifAvailable, true);
      if (held.has(name)) return callback(null);
      held.add(name);
      try { return await callback({ name }); }
      finally { held.delete(name); }
    },
  };
}

function broadcastRegistry() {
  type Event = { data: unknown };
  const channels = new Map<string, Set<Channel>>();
  class Channel {
    name: string;
    onmessage: ((event: Event) => void) | null = null;
    constructor(name: string) {
      this.name = name;
      if (!channels.has(name)) channels.set(name, new Set());
      channels.get(name)!.add(this);
    }
    postMessage(data: unknown) {
      for (const peer of channels.get(this.name)!) {
        if (peer !== this) queueMicrotask(() => {
          if (channels.get(this.name)!.has(peer)) peer.onmessage?.({ data: structuredClone(data) });
        });
      }
    }
    close() { channels.get(this.name)!.delete(this); }
  }
  return { Channel, channels };
}

type BrowserState = {
  storage?: Map<string, string>;
  history?: Record<string, unknown> | null;
  navigation?: string;
  opener?: object;
  locks?: ReturnType<typeof lockRegistry>;
  broadcast?: ReturnType<typeof broadcastRegistry>;
};
function tab(options: BrowserState = {}) {
  const values = new Map(options.storage);
  const history = { state: structuredClone(options.history ?? null), replaceState(next: typeof options.history) { this.state = next ?? null; } };
  const listeners = new Map<string, (event: { persisted?: boolean }) => void>();
  const context = {
    crypto, setTimeout,
    navigator: { locks: options.locks },
    BroadcastChannel: options.broadcast?.Channel,
    opener: options.opener,
    history,
    performance: { getEntriesByType: () => [{ type: options.navigation ?? 'navigate' }] },
    sessionStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
    addEventListener: (type: string, fn: (event: { persisted?: boolean }) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
    TangramTabSession: undefined,
  };
  runInNewContext(script, context);
  return {
    api: context.TangramTabSession as unknown as {
      resolve(): Promise<{ kind: string; reason: string; sessionId: string | null; tabToken: string }>;
      bind(id: string): void; clear(): void; current(): string | null; dispose(): void;
    },
    snapshot: () => ({ storage: values, history: history.state }),
    event: (type: string, persisted?: boolean) => listeners.get(type)?.({ persisted }),
  };
}

test('a new tab owns a token, and bind/clear preserves it and other history state', async () => {
  const locks = lockRegistry(), page = tab({ locks, history: { router: { offset: 2 } } });
  const fresh = await page.api.resolve();
  assert.equal(fresh.kind, 'fresh');
  assert.equal(fresh.reason, 'new_tab');
  assert.equal(fresh.sessionId, null);
  assert.ok(locks.held.has(ownerName(fresh.tabToken)));
  page.api.bind(id);
  assert.equal(page.api.current(), id);
  assert.deepEqual(structuredClone(page.snapshot().history), {
    router: { offset: 2 }, tangramTab: { tabToken: fresh.tabToken, sessionId: id },
  });
  assert.deepEqual(JSON.parse(page.snapshot().storage.get('tangramTab')!), { tabToken: fresh.tabToken, sessionId: id });
  page.api.clear();
  assert.equal(page.api.current(), null);
  assert.equal(JSON.parse(page.snapshot().storage.get('tangramTab')!).sessionId, null);
  assert.equal((page.snapshot().history!.tangramTab as { sessionId: unknown }).sessionId, null);
  assert.ok(locks.held.has(ownerName(fresh.tabToken)));
  assert.throws(() => page.api.bind('garbage'), /invalid_tab_session_id/);
  page.api.dispose();
  await setImmediate();
  assert.equal(locks.held.size, 0);
});

test('cloned sessionStorage and history are rejected while the original Web Lock is held', async () => {
  const locks = lockRegistry(), original = tab({ locks });
  const fresh = await original.api.resolve();
  original.api.bind(id);
  const duplicate = tab({ ...original.snapshot(), locks });
  const copied = await duplicate.api.resolve();
  assert.equal(copied.kind, 'fresh');
  assert.equal(copied.reason, 'duplicated_tab');
  assert.equal(copied.sessionId, null);
  assert.notEqual(copied.tabToken, fresh.tabToken);
  assert.equal(original.api.current(), id);
  duplicate.api.dispose();
  original.api.dispose();
});

test('window.open and mismatched history with copied storage start fresh in their own tabs', async () => {
  const locks = lockRegistry(), original = tab({ locks });
  await original.api.resolve();
  original.api.bind('legacy');
  const options = { storage: original.snapshot().storage, history: null, locks };
  const opened = tab({ ...options, opener: {} }), unmatched = tab(options);
  assert.equal((await opened.api.resolve()).reason, 'window_open');
  assert.equal((await unmatched.api.resolve()).reason, 'duplicated_tab');
  assert.equal(opened.api.current(), null);
  assert.equal(unmatched.api.current(), null);
  assert.equal(original.api.current(), 'legacy');
  for (const page of [original, opened, unmatched]) page.api.dispose();
});

test('reload retries while the old page releases its lock and restores a matching binding', async () => {
  const locks = lockRegistry(), original = tab({ locks });
  const fresh = await original.api.resolve();
  original.api.bind(id);
  const reloaded = tab({ ...original.snapshot(), navigation: 'reload', locks });
  const resolving = reloaded.api.resolve();
  setTimeout(() => original.event('beforeunload'), 5);
  assert.deepEqual(structuredClone(await resolving), { kind: 'restored', reason: 'reload', sessionId: id, tabToken: fresh.tabToken });
  const empty = tab({ navigation: 'reload', locks });
  assert.equal((await empty.api.resolve()).reason, 'storage_empty');
  const stillLocked = tab({ ...reloaded.snapshot(), navigation: 'reload', locks });
  assert.equal((await stillLocked.api.resolve()).reason, 'duplicated_tab');
  for (const page of [original, reloaded, empty, stillLocked]) page.api.dispose();
});

test('pagehide releases ownership and pageshow reacquires it after a back-forward cache restore', async () => {
  const locks = lockRegistry(), page = tab({ locks });
  const initial = await page.api.resolve();
  page.api.bind(id);
  page.event('pagehide', true);
  await setImmediate();
  assert.ok(!locks.held.has(ownerName(initial.tabToken)));
  page.event('pageshow', true);
  assert.equal((await page.api.resolve()).sessionId, id);
  assert.ok(locks.held.has(ownerName(initial.tabToken)));
  page.api.dispose();
});

test('BroadcastChannel detects a live copied binding and permits reload after pagehide', async () => {
  const broadcast = broadcastRegistry(), original = tab({ broadcast });
  const initial = await original.api.resolve();
  original.api.bind(id);
  const duplicate = tab({ ...original.snapshot(), broadcast });
  assert.equal((await duplicate.api.resolve()).reason, 'duplicated_tab');
  assert.equal(duplicate.api.current(), null);
  original.event('pagehide');
  assert.equal(broadcast.channels.get(ownerName(initial.tabToken))!.size, 0);
  const reload = tab({ ...original.snapshot(), broadcast, navigation: 'reload' });
  assert.equal((await reload.api.resolve()).sessionId, id);
  for (const page of [original, duplicate, reload]) page.api.dispose();
  assert.ok([...broadcast.channels.values()].every(channels => channels.size === 0));
});
