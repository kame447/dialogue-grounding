import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

registerHooks({ resolve(s, c, next) {
  if (s === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}', shortCircuit: true };
  if (s.startsWith('.') && c.parentURL?.startsWith('file:')) {
    const u = new URL(s, c.parentURL);
    if (!existsSync(fileURLToPath(u)) && existsSync(fileURLToPath(u) + '.ts')) return next(u.href + '.ts', c);
  }
  return next(s, c);
} });
const { default: edge, TangramSession, AdminIndex }: any = await import(new URL('../workers/tangram-experiment/src/index.ts',import.meta.url).href);
// Match Cloudflare's Request stream-forwarding constructor in the real edge.
const NativeRequest = globalThis.Request;
globalThis.Request = class extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) { super(input, init?.body ? { ...init, duplex:'half' } as RequestInit : init); }
};
const token = 'synthetic-adapter-admin-01234567890123456789';
const origin = 'https://i139-adapter.invalid';
const protocol = { schemaVersion:'reception_protocol_v1', protocolId:'22222222-2222-4222-8222-222222222222', revision:7,
  allowedOrders:[['bypass-enabled','repair-first'],['repair-first']], seedPolicy:'shared', referenceMemory:false,
  betweenTrials:'none', receptionNumberFormat:'daily_seq3' };
const clone = <T>(value: T): T => structuredClone(value);
function memory() {
  let values = new Map<string, any>(), queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>) => { const r = queue.then(fn); queue = r.catch(() => {}); return r; };
  const view = (map: Map<string, any>) => ({
    async get(key: string) { return clone(map.get(key)); },
    async put(updates: Record<string, unknown>) { for (const [key, value] of Object.entries(updates)) map.set(key,clone(value)); },
    async delete(keys: string | string[]) { let n = 0; for (const key of Array.isArray(keys) ? keys : [keys]) n += Number(map.delete(key)); return n; },
    async list({ prefix }: { prefix:string }) { return new Map([...map].filter(([key]) => key.startsWith(prefix)).sort(([a],[b]) => a.localeCompare(b))); },
  });
  return { snapshot:() => clone(Object.fromEntries(values)), get:(key:string) => view(values).get(key),
    put:(updates:Record<string,unknown>) => enqueue(() => view(values).put(updates)),
    delete:(keys:string|string[]) => enqueue(() => view(values).delete(keys)), list:(options:{prefix:string}) => view(values).list(options),
    transaction(fn:(tx:any) => Promise<any>) { return enqueue(async () => { const staged = clone(values), result = await fn(view(staged)); values = staged; return result; }); },
    async deleteAlarm() {}, async setAlarm() {},
  };
}
function harness(patch: Record<string, unknown> = {}) {
  const stores = new Map<string, ReturnType<typeof memory>>(), objects = new Map<string, any>(), pending: Promise<unknown>[] = [];
  const indexStorage = memory(), index = new AdminIndex({ storage:indexStorage },{}); let modelCalls = 0, receptionReads = 0;
  const env: any = { RECEPTION_REQUIRED:'on', RECEPTION_PROTOCOL_JSON:JSON.stringify(protocol), ADMIN_TOKEN:token,
    ADMIN_INDEX:{ idFromName:(id:string) => id, get:() => index },
    ADMIN_RATE_LIMIT:{ async limit() { return { success:true }; } }, START_RATE_LIMIT:{ async limit() { return { success:true }; } },
    AI_PROXY:{ async chat() { modelCalls++; throw Error('synthetic test must not call a model'); } },
    ASSETS:{ async fetch() { return new Response('<html></html>'); } }, ...patch };
  const get = (id: string) => {
    if (!stores.has(id)) stores.set(id,memory());
    if (!objects.has(id)) {
      const o = new TangramSession({ storage:stores.get(id), id:{ toString:() => id }, waitUntil(p:Promise<unknown>) { pending.push(p); } },env);
      const read = o.adminReception.bind(o);
      o.adminReception = async () => { receptionReads++; return read(); };
      objects.set(id,o);
    }
    return objects.get(id);
  };
  env.NAMING_SESSIONS = { idFromName:(id:string) => id, idFromString:(id:string) => id, get };
  const fetch = (request: Request) => edge.fetch(request,env) as Promise<Response>;
  return { env,index,indexStorage,fetch, get receptionReads() { return receptionReads; },
    object:(cookie:string) => get(cookie.split('=')[1]), snapshot:(cookie:string) => stores.get(cookie.split('=')[1])!.snapshot(),
    async browser() {
      const page = await fetch(new Request(origin+'/')); assert.equal(page.status,200);
      const cookie = page.headers.get('set-cookie')!.split(';')[0];
      const r = await fetch(new Request(origin+'/api/reception',{ method:'POST',headers:{Cookie:cookie} })); assert.equal(r.status,200);
      return cookie;
    },
    async done() { await Promise.all(pending); assert.equal(modelCalls,0); },
  };
}
const adminGet = (path = '/admin/receptions') => new Request(origin+path,{ headers:{Authorization:'Bearer '+token} });
function adminPost(id: string, action: 'approve'|'cancel', revision: number, confirm: string, order = 0) {
  return new Request(`${origin}/admin/reception/${id}/${action}`,{ method:'POST',headers:{ Authorization:'Bearer '+token,
    Origin:origin, 'Sec-Fetch-Site':'same-origin', 'Content-Type':'application/x-www-form-urlencoded', Accept:'application/json' },
    body:new URLSearchParams({ expectedRevision:String(revision),confirm,...(action === 'approve' ? {order:String(order)} : {}) }) });
}
const rec = (h: ReturnType<typeof harness>, cookie: string) => h.snapshot(cookie)['reception:v1'];
const confirm = (r:any) => r.number ?? r.receptionId.slice(0,8);
async function expectError(r:Response,status:number,error:string) { assert.equal(r.status,status); assert.deepEqual(await r.json(),{error}); }

test('edge adapter lists real pending revision zero and approves it through authenticated management into a plan-driven participant start', async () => {
  const h = harness(), cookie = await h.browser(), r = rec(h,cookie);
  assert.equal(r.revision,0);
  const list = await h.fetch(adminGet()); assert.equal(list.status,200); const html = await list.text();
  assert.ok(html.includes(r.number)); assert.ok(html.includes(`/admin/reception/${r.receptionId}/approve`));
  assert.ok(html.includes('value="0"')); assert.ok(html.includes(protocol.protocolId));
  const approved = await h.fetch(adminPost(r.receptionId,'approve',0,confirm(r)));
  assert.equal(approved.status,200); assert.deepEqual(await approved.json(),{ok:true});
  const saved = rec(h,cookie); assert.equal(saved.status,'approved'); assert.deepEqual(saved.plan.order,protocol.allowedOrders[0]);
  assert.equal(h.snapshot(cookie)['base:owner:v1'].activeKey,null,'approval never starts a trial');
  const state = await (await h.fetch(new Request(origin+'/api/state',{headers:{Cookie:cookie}}))).json();
  assert.equal(state.reception.status,'ready');
  const start = await h.fetch(new Request(origin+'/api/start',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},
    body:JSON.stringify({version:2,expectedReceptionRevision:state.reception.revision})}));
  assert.equal(start.status,200); const id = (await start.json()).trial.sessionId;
  const record = h.snapshot(cookie)['record:'+id]; assert.equal(record.strategy,'bypass-enabled'); assert.equal(record.seed,saved.plan.trials[0].seed);
  assert.equal(record.assignment.source.protocolId,protocol.protocolId); await h.done();
});

test('management list resolves authoritative status, revision and order rather than trusting stale index extras', async () => {
  const h = harness(), cookie = await h.browser(), r = rec(h,cookie);
  await h.object(cookie).adminApproveReception({expectedRevision:0,order:0});
  const authoritative = rec(h,cookie);
  const key = 'reception:'+r.receptionId, row = await h.indexStorage.get(key);
  await h.indexStorage.put({[key]:{...row,status:'pending',revision:0,plan:{order:['repair-first']}}});
  const response = await h.fetch(adminGet()); assert.equal(response.status,200); const html = await response.text();
  const targetRow = html.match(new RegExp('<tr[^>]*>(?:(?!</tr>)[\\s\\S])*'+r.receptionId+'(?:(?!</tr>)[\\s\\S])*</tr>'))?.[0];
  assert.ok(targetRow,'the actual reception is rendered');
  assert.doesNotMatch(targetRow,/\/approve"/);
  assert.ok(targetRow.indexOf('bypass-enabled') >= 0); assert.ok(targetRow.indexOf('repair-first') > targetRow.indexOf('bypass-enabled'));
  const cancelForms = [...targetRow.matchAll(/<form\b[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/gu)]
    .filter(([,action]) => action === `/admin/reception/${r.receptionId}/cancel`);
  assert.equal(cancelForms.length,1,'the target row has exactly its own cancellation form');
  const revisionInput = cancelForms[0][2].match(/<input\b[^>]*name="expectedRevision"[^>]*value="([^"]*)"[^>]*>/u);
  assert.ok(revisionInput,'the target cancellation form includes the expected revision');
  assert.notEqual(authoritative.revision,0,'fixture really distinguishes stored and stale index revisions');
  assert.equal(revisionInput[1],String(authoritative.revision));
  assert.ok(h.receptionReads > 0,'the management port actually reads the owning DO'); await h.done();
});

for (const bad of [undefined,'{broken',JSON.stringify({...protocol,rotation:true})]) test('adapter reports unconfigured protocol without defaults and rejects approval: '+bad, async () => {
  const h = harness({RECEPTION_PROTOCOL_JSON:bad}), cookie = await h.browser(), r = rec(h,cookie), before = h.snapshot(cookie);
  const response = await h.fetch(adminGet()); assert.equal(response.status,200);
  assert.match(await response.text(),/プロトコルが未設定のため、許可できません/u);
  await expectError(await h.fetch(adminPost(r.receptionId,'approve',0,confirm(r))),409,'protocol_unconfigured');
  assert.deepEqual(h.snapshot(cookie),before); await h.done();
});

test('adapter cancellation persists without trial creation; unknown and misdirected index identities remain not_found', async () => {
  const h = harness(), cookie = await h.browser(), r = rec(h,cookie);
  const response = await h.fetch(adminPost(r.receptionId,'cancel',0,confirm(r))); assert.equal(response.status,200);
  assert.equal(rec(h,cookie).status,'cancelled'); assert.equal(h.snapshot(cookie)['base:owner:v1'].activeKey,null);
  const unknown = '99999999-9999-4999-8999-999999999999';
  await expectError(await h.fetch(adminPost(unknown,'cancel',0,unknown.slice(0,8))),404,'not_found');
  // Corrupt index points to a real DO belonging to another reception. Never
  // project or mutate that other reception under the requested UUID.
  const other = await h.browser(), otherRow = rec(h,other), before = h.snapshot(other);
  await h.indexStorage.put({['reception:'+unknown]:{...otherRow,receptionId:unknown}});
  await expectError(await h.fetch(adminPost(unknown,'cancel',0,confirm(otherRow))),404,'not_found');
  const listing = await h.fetch(adminGet()); assert.equal(listing.status,200); const html = await listing.text();
  assert.ok(!html.includes(unknown),'a misdirected index UUID is absent from both rows and operation targets');
  assert.equal(html.split(`/admin/reception/${otherRow.receptionId}/approve`).length-1,1,'the legitimate other reception appears once, without an alias row');
  assert.deepEqual(h.snapshot(other),before); await h.done();
});

test('adapter remains behind admin authentication, CSRF, configured token and limiter', async () => {
  const h = harness(), cookie = await h.browser(), r = rec(h,cookie), before = h.snapshot(cookie);
  const unauth = adminGet(); unauth.headers.delete('Authorization'); unauth.headers.set('Cookie',cookie);
  assert.equal((await h.fetch(unauth)).status,401); assert.equal(h.receptionReads,0);
  const forbidden = adminPost(r.receptionId,'approve',0,confirm(r)); forbidden.headers.set('Origin','https://other.invalid');
  assert.equal((await h.fetch(forbidden)).status,403); assert.equal(h.receptionReads,0);
  for (const key of ['ADMIN_TOKEN','ADMIN_RATE_LIMIT']) {
    const saved = h.env[key]; h.env[key] = undefined; assert.equal((await h.fetch(adminGet())).status,404); h.env[key] = saved;
  }
  assert.deepEqual(h.snapshot(cookie),before); await h.done();
});

for (const [code,status,error] of [
  ['reception_conflict',409,'conflict'],['invalid_order',400,'invalid_order'],['protocol_unconfigured',409,'protocol_unconfigured'],
  ['reception_unavailable',503,'reception_unavailable'],['PRIVATE prompt/token',503,'reception_unavailable'],
] as const) test('adapter normalizes RPC errors to closed management result: '+error+'/'+code, async () => {
  const h = harness(), cookie = await h.browser(), r = rec(h,cookie), before = h.snapshot(cookie);
  // Errors crossing the RPC boundary may retain only name/message, not .code.
  h.object(cookie).adminApproveReception = async () => { throw new Error(code); };
  await expectError(await h.fetch(adminPost(r.receptionId,'approve',0,confirm(r))),status,error);
  assert.deepEqual(h.snapshot(cookie),before); await h.done();
});
