import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

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
const { default: worker }: any = await import(new URL('../workers/tangram-experiment/src/index.ts', import.meta.url).href);

// The Worker accepts a forwarded request-body stream without Node's duplex flag.
const NativeRequest = globalThis.Request;
globalThis.Request = class extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init?.body ? { ...init, duplex: 'half' } as RequestInit : init);
  }
};

const COOKIE = 'tangram_session=' + 'a'.repeat(64);
const TAB = '4f1c2b3a-9d8e-4a7b-8c6d-5e4f3a2b1c0d';

/** The edge Worker in front of a recording participant object: what the object is handed of the request. */
function edge() {
  const seen: { method: string; path: string; body: string | null }[] = [];
  const permit = { limit: async () => ({ success: true }) };
  const object = {
    resolveTabSession: async (id: string) => 'tab-object-' + id,
    async fetch(request: Request) {
      seen.push({ method: request.method, path: new URL(request.url).pathname, body: request.body === null ? null : await request.text() });
      return Response.json({ ok: true });
    },
  };
  const env = {
    NAMING_SESSIONS: { idFromName: (name: string) => name, get: () => object },
    START_RATE_LIMIT: permit, SESSION_ACTION_RATE_LIMIT: permit, IP_ACTION_RATE_LIMIT: permit, GLOBAL_ACTION_RATE_LIMIT: permit, QUESTIONNAIRE_RATE_LIMIT: permit,
  };
  const post = (path: string, body: string) => worker.fetch(new Request('https://forwarding.invalid' + path, { method: 'POST',
    headers: { Cookie: COOKIE, 'X-Tab-Session': TAB, 'Content-Type': 'application/json' }, body }), env) as Promise<Response>;
  return { seen, post };
}

// The object never reads the body of a reception call. A body stream handed over and left unread is read after the response has been sent,
// which the workerd pinned by wrangler 4.151.1 (1.20261012.1) reports as "Can't read from request stream after response has been sent".
test('POST /api/reception answers from the object without handing it the request body', async () => {
  const { seen, post } = edge();
  const response = await post('/api/reception', '{}');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(seen, [{ method: 'POST', path: '/api/reception', body: null }]);
});
