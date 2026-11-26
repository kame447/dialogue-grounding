import { CLAIM_PRUNE_V2 } from '../memory/reference-graph.mjs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, lstat, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createNamingTaskV2 } from '../v2/naming-task-v2.mjs';
import { NamingTaskError } from '../naming-error.mjs';
import { validateBaseStart, BaseAssignmentError } from '../v2/base-assignment.ts';
import { createBaseAssignmentSession, BaseSessionError } from '../v2/base-assignment-session.ts';
import { openBaseFileStore, privateDirectory, registerBaseOwner, readPrivateAssignment, listBaseOwners } from './base-assignment-store.ts';
import type { LocalStore } from './base-assignment-store.ts';
import type { BaseSession, BaseTask } from '../v2/base-assignment.ts';
import { lockResult, participantReview, recordListEntry, sortRecordList, QUESTIONNAIRE_FORM } from '../v2/participant-records.ts';
import type { Questionnaire } from '../v2/participant-records.ts';
import { handleAdmin, isAdminPath, ADMIN_HEADERS } from '../../../workers/tangram-experiment/src/admin/routes.ts';
import { summarizeRecord } from '../../../workers/tangram-experiment/src/admin/summary.ts';
import { summarizeLatency } from '../v2/latency.ts';
import { participantContactHTML } from '../v2/participant-contact.ts';
import { PARTICIPANT_STOP_HTML } from '../v2/participant-stop-page.ts';
import { EMPTY_TAB_SESSION_MAX_AGE_MS, MAX_EMPTY_TAB_SESSIONS, TAB_SESSION_ID, questionnaireUpdate,
  sortBrowserSessions, summarizeBrowserSession, tabSessionRoute, validateCreateTabSession,
  validateEventCount } from '../../../workers/tangram-experiment/src/tab-sessions.ts';
import type { BrowserSession, BrowserSessionSummary } from '../../../workers/tangram-experiment/src/tab-sessions.ts';
const PUBLIC = fileURLToPath(new URL('./', import.meta.url));
const STATIC: Record<string, [string,string]> = {'/':['index.html','text/html'], '/index.html':['index.html','text/html'],
  '/app.js':['app.js','text/javascript'], '/style.css':['style.css','text/css'], '/tab-session.js':['tab-session.js','text/javascript']};
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const failure = () => new BaseSessionError('trial_unavailable');
type Entry = {store: LocalStore; coordinator: BaseSession; serial<T>(fn: () => Promise<T>): Promise<T>};
type DrainableServer = ReturnType<typeof createServer> & { drainAndClose(): Promise<void> };
export function createBaseParticipantServer(options: Record<string, any> = {}) {
  if (Object.hasOwn(options,'baseAssignment')) throw failure();
  const {client,baseAssignmentFile,baseStoreRoot,now=Date.now,createTaskV2=createNamingTaskV2,memoryPruneVersion,utteranceStyle='default',activeDecision=null,groundingShadow=null,participantJev=null,adminToken,adminLimiter}=options;
  if (memoryPruneVersion !== undefined && memoryPruneVersion !== CLAIM_PRUNE_V2) throw new Error('Invalid memory pruning version');
  if (!['default','concise'].includes(utteranceStyle)) throw new Error('Invalid utterance style');
  if (activeDecision !== null && (!['decision_jev','decision_luna'].includes(activeDecision?.purpose) || typeof activeDecision.client?.chooseAction !== 'function')) throw new Error('Invalid active decision client');
  const entries = new Map<string,Promise<Entry>>();
  const tabsInUse = new Map<string,number>();
  const loadedStores = new Set<LocalStore>();
  const handlers = new Set<Promise<void>>(), persists = new Set<Promise<void>>();
  let draining = false, persistSealed = false, drainFailed = false;
  // Owners whose newest write failed and has not been followed by a successful one: the latest state is not on disk, so a shutdown must not report success.
  const unsaved = new Set<string>();
  let drainPromise: Promise<void> | undefined;
  async function entry(ownerId: string) {
    let p = entries.get(ownerId);
    if (!p) {
      p = (async()=>{
        const store=await openBaseFileStore({root:baseStoreRoot,ownerId,now});
        loadedStores.add(store);
        const coordinator=createBaseAssignmentSession({ownerId,store,now,newId:randomUUID,adapter:'local_private_file',
          ...(memoryPruneVersion ? { memoryPruneVersion } : {}),
          readConfig:async()=>baseAssignmentFile ? readPrivateAssignment(baseAssignmentFile) : null,
          makeTask:async value=>createTaskV2({client,...value,onPersistSlow:(slow:{waitedMs:number;tookMs:number;joined:number})=>{try{process.stderr.write('persist_slow waited_ms='+slow.waitedMs+' took_ms='+slow.tookMs+' joined='+slow.joined+'\n');}catch{/* never affects the write */}},onPersistFailure:(failure:{code:string;at:string;reason?:string})=>{try{process.stderr.write('persist_failed code='+failure.code+(failure.reason?' reason='+failure.reason:'')+' at='+failure.at+'\n');}catch{/* never affects the write */}},activeDecision,utteranceStyle,...(groundingShadow?{groundingShadow}:{}),
            ...(participantJev?await participantJev.taskOptions(value):{}),
            onPersist:async (record:Parameters<typeof value.onPersist>[0])=>{
              if(persistSealed)throw new NamingTaskError('record_write_failed');
              const work=Promise.resolve().then(()=>value.onPersist(record));persists.add(work);
              work.then(()=>{persists.delete(work);unsaved.delete(ownerId);},()=>{if(draining)drainFailed=true;persists.delete(work);unsaved.add(ownerId);});
              await work;
            }})});
        let pending: Promise<unknown> = Promise.resolve();
        function serial<T>(fn: () => Promise<T>): Promise<T> {
          const next = pending.then(fn); pending = next.catch(() => {}); return next;
        }
        return {store,coordinator,serial};
      })(); entries.set(ownerId,p); p.catch(()=>entries.delete(ownerId));
    }
    return p;
  }
  async function known(ownerId: string): Promise<Entry|null> {
    await privateDirectory(baseStoreRoot);
    try { await lstat(join(baseStoreRoot,ownerId+'.owner.json')); }
    catch(e) { if ((e as NodeJS.ErrnoException).code==='ENOENT') return null; throw failure(); }
    const e=await entry(ownerId);return await e.store.alive()?e:null;
  }
  const tabFile = (ownerId: string) => join(baseStoreRoot, ownerId + '.browser-sessions.json');
  async function readTabs(ownerId: string): Promise<BrowserSession[]> {
    await privateDirectory(baseStoreRoot);
    let file;
    try { file = await open(tabFile(ownerId), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw failure(); }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) throw failure();
      const tabs = JSON.parse(await file.readFile('utf8'));
      if (!Array.isArray(tabs) || !tabs.every(tab => tab &&
        typeof tab.sessionId === 'string' && TAB_SESSION_ID.test(tab.sessionId) &&
        typeof tab.doName === 'string' && /^[a-f0-9]{64}$/u.test(tab.doName) && tab.doName !== ownerId &&
        typeof tab.createdAt === 'string' && Number.isFinite(Date.parse(tab.createdAt)))) throw failure();
      return tabs;
    } finally { await file.close(); }
  }
  async function writeTabs(ownerId: string, tabs: BrowserSession[]): Promise<void> {
    const temp = join(baseStoreRoot, '.' + randomUUID() + '.browser-sessions.tmp');
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(tabs));
      await file.close();
      await rename(temp, tabFile(ownerId));
    } catch (error) {
      await file.close().catch(() => {});
      await unlink(temp).catch(() => {});
      throw error;
    }
  }
  async function createTab(ownerId: string, root: Entry): Promise<BrowserSession | null> {
    return root.serial(async () => {
      const tabs = await readTabs(ownerId), retained: BrowserSession[] = [], reclaimed: BrowserSession[] = [];
      let empty = 0;
      for (const tab of tabs) {
        if (!tabsInUse.has(tab.doName)) {
          const saved = await (await entry(tab.doName)).store.inspect();
          if (saved.owner.activeKey === null && !Object.keys(saved.ledger).length && !Object.keys(saved.archives).length) {
            if (now() - Date.parse(tab.createdAt) >= EMPTY_TAB_SESSION_MAX_AGE_MS) { reclaimed.push(tab); continue; }
            empty++;
          }
        } else {
          // Count a slot conservatively until its current request has settled.
          empty++;
        }
        retained.push(tab);
      }
      if (empty >= MAX_EMPTY_TAB_SESSIONS) return null;
      const tab = { sessionId: randomUUID(), doName: randomBytes(32).toString('hex'), createdAt: new Date(now()).toISOString() };
      await registerBaseOwner(baseStoreRoot, tab.doName, now());
      try { await writeTabs(ownerId, [...retained, tab]); }
      catch (error) { await unlink(join(baseStoreRoot, tab.doName + '.owner.json')).catch(() => {}); throw error; }
      for (const old of reclaimed) {
        const stored = await entries.get(old.doName);
        await stored?.store.close();
        if (stored) loadedStores.delete(stored.store);
        entries.delete(old.doName);
        await unlink(join(baseStoreRoot, old.doName + '.owner.json'));
      }
      return tab;
    });
  }
  async function tabSummary(e: Entry, sessionId: string, createdAt: string | null) {
    const c = await e.store.inspect();
    const activeRecordId = c.owner.activeKey ? c.owner.admissions[c.owner.activeKey]?.record?.recordId ?? null : null;
    const records = Object.keys(c.archives).filter(id => !c.tombstones.includes(id)).map(id => {
      const questionnaire = c.questionnaires[id] as Questionnaire | undefined;
      return { entry: recordListEntry(c.archives[id], activeRecordId === id, questionnaire), questionnaireUpdatedAt: questionnaire?.updatedAt };
    });
    return summarizeBrowserSession({ sessionId, createdAt, reception: null, activeRecordId, records });
  }
  async function browserHistory(ownerId: string, root: Entry) {
    return root.serial(async () => {
      const summaries: BrowserSessionSummary[] = [];
      const legacy = await tabSummary(root, 'legacy', null);
      if (legacy) summaries.push(legacy);
      for (const { sessionId, doName, createdAt } of await readTabs(ownerId)) {
        const summary = await tabSummary(await entry(doName), sessionId, createdAt);
        if (summary) summaries.push(summary);
      }
      return { receptionMode: 'off', sessions: sortBrowserSessions(summaries) };
    });
  }
  async function lookupRecord(id:string, includeParticipantRole = false, deletingRecord = false) {
    for (const owner of await listBaseOwners(baseStoreRoot)) {
      const store = (await entry(owner)).store;
      if (includeParticipantRole) {
        const saved = await store.adminRecord(id);
        if (saved) return { owner, ...saved };
      } else {
        const record = await store.readRecord(id);
        if (record) return { owner, record, questionnaire: null, participantRole: undefined };
        // A confirmed retry may finish removing a role file after the trial was already deleted.
        if (deletingRecord) await store.adminRecord(id, false);
      }
    }
    return null;
  }
  const server=createServer((req,res)=>{
    const accepted=!draining,work=handle(req,res);
    if(accepted)handlers.add(work);
    work.then(()=>handlers.delete(work),()=>{
      if(draining)drainFailed=true;handlers.delete(work);
      try{if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json'});res.end('{"error":"trial_unavailable"}');}catch{/* disconnected socket */}
    });
  }) as DrainableServer;
  async function handle(req:IncomingMessage,res:ServerResponse):Promise<void>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    if(draining)return json(503,{error:'trial_unavailable'});
    async function bodyText(max=65536) {
      const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>max)throw new BaseSessionError('invalid_request');chunks.push(c);}
      return Buffer.concat(chunks).toString('utf8');
    }
    async function body() {
      if(req.headers['content-type']?.split(';')[0].trim()!=='application/json')throw new BaseSessionError('invalid_request');
      const text = await bodyText();
      try{const value:unknown=JSON.parse(text);
        if(!value||typeof value!=='object'||Array.isArray(value))throw new BaseSessionError('invalid_request');
        return value;
      }catch{throw new BaseSessionError('invalid_request');}
    }
    let activeTab: string | undefined;
    try {
      const host='127.0.0.1:'+res.socket!.localPort,origin='http://'+host;
      if(req.headers.host!==host)return json(403,{error:'request_forbidden'});
      const url=new URL(req.url!,origin);let path;
      try{path=decodeURIComponent(url.pathname);}catch{return json(404,{error:'not_found'});}
      if(isAdminPath(path)){
        const headers=new Headers();for(const [key,value] of Object.entries(req.headers))if(value!==undefined&&key!=='cf-connecting-ip')headers.set(key,Array.isArray(value)?value.join(', '):value);
        headers.set('CF-Connecting-IP',req.socket.remoteAddress??'ip-unavailable');
        const init:any={method:req.method,headers}; if(req.method!=='GET'&&req.method!=='HEAD'){init.body=req;init.duplex='half';}
        const request=new Request(url,init);
        const preparingNext=req.method==='POST'&&/^\/admin\/record\/[^/]+\/prepare-next$/u.test(url.pathname);
        const deletingRecord = req.method === 'POST' && /^\/admin\/record\/[^/]+\/delete$/u.test(url.pathname);
        let response: Response;
        try { response=await handleAdmin(request,{token:adminToken,limiter:adminLimiter,retentionDays:0,
          listPage: async () => {
            const items = [];
            for (const owner of await listBaseOwners(baseStoreRoot)) {
              for (const { record, questionnaire, participantRole } of await (await entry(owner)).store.adminRecords()) {
                items.push({ ...summarizeRecord({ ...record, questionnaire }, owner, summarizeLatency(record)), participantRole });
              }
            }
            return { items, next: null };
          },
          getSummary:async (id, includeParticipantRole)=>{
            const found=await lookupRecord(id, includeParticipantRole, deletingRecord);
            if(!found&&preparingNext)for(const owner of await listBaseOwners(baseStoreRoot)){
              const saved=await (await entry(owner)).store.inspect();
              if(saved.tombstones.includes(id))throw new BaseSessionError('not_found');
            }
            if (!found) return null;
            const summary = summarizeRecord(includeParticipantRole ? { ...found.record, questionnaire: found.questionnaire } : found.record,
              found.owner, summarizeLatency(found.record));
            return found.participantRole ? { ...summary, participantRole: found.participantRole } : summary;
          },
          getRecord: async summary => {
            const saved = await (await entry(summary.objectId)).store.adminRecord(summary.recordId, false);
            return saved ? { ...saved.record, questionnaire: saved.questionnaire } : null;
          },
          setParticipantRole: async (summary, role) =>
            await (await entry(summary.objectId)).store.setParticipantRole(summary.recordId, role)
              ? { ok: true } : { ok: false, error: 'not_found' },
          deleteRecord:async summary=>{
            try { if (!await (await entry(summary.objectId)).store.deleteRecord(summary.recordId)) throw new BaseSessionError('not_found'); }
            catch(error) {
              if(error instanceof BaseSessionError && (error.code==='owner_expired'||error.code==='not_found')) throw error;
              throw failure();
            }
          },audit:async()=>[],summarizeLatency,
          prepareNext:async summary=>(await entry(summary.objectId)).coordinator.prepareNext(summary.recordId)});
        } catch(error) {
          if (!(error instanceof BaseSessionError) || (error.code!=='owner_expired'&&error.code!=='not_found')) throw error;
          response=preparingNext
            ? new Response(JSON.stringify({error:'not_found'}),{status:404,headers:{...ADMIN_HEADERS,'Content-Type':'application/json; charset=utf-8'}})
            : new Response('Not found',{status:404,headers:{...ADMIN_HEADERS,'Content-Type':'text/plain; charset=utf-8'}});
        }
        res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
      }
      if(req.headers.origin&&req.headers.origin!==origin)return json(403,{error:'request_forbidden'});
      if(path==='/v1'||path.startsWith('/v1/')||['/api/turn','/api/submit'].includes(path))return json(404,{error:'not_found'});
      const cookie=req.headers.cookie?.match(/(?:^|;\s*)naming_session=([a-f0-9]{64})(?:;|$)/u)?.[1];
      if(req.method==='GET'&&Object.hasOwn(STATIC,path)){
        if(path==='/'||path==='/index.html'){
          let e;
          // A page request has no app to translate a code: it gets the neutral stop page.
          const stopPage=()=>{res.writeHead(503,{'Content-Type':'text/html; charset=utf-8'});res.end(PARTICIPANT_STOP_HTML);};
          try{
            e=cookie?await known(cookie):null;
            if(!e){
              await privateDirectory(baseStoreRoot);
              if((await listBaseOwners(baseStoreRoot)).length>=64)return stopPage();
              const id=randomBytes(32).toString('hex');await registerBaseOwner(baseStoreRoot,id,now());e=await entry(id);
              res.setHeader('Set-Cookie','naming_session='+id+'; HttpOnly; SameSite=Strict; Path=/');
            }
            await e.store.touch();
          }catch{return stopPage();}
        }
        const [file,type]=STATIC[path];res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});
        const bytes=await readFile(join(PUBLIC,file));res.end(type==='text/html'?participantContactHTML(bytes.toString('utf8'),options.participantContactText):bytes);return;
      }
      const recordPath=path.match(/^\/api\/records\/([^/]+)\/(review|questionnaire)$/u);
      const action=req.method==='POST'&&['/api/start','/api/message','/api/names','/api/retry','/api/interrupt','/api/ai-submit'].includes(path);
      const sessions=path==='/api/sessions'&&['GET','POST'].includes(req.method!);
      if(!sessions&&!action&&!(req.method==='GET'&&['/api/state','/api/records'].includes(path))&&!(recordPath&&['GET','POST'].includes(req.method!)))return json(404,{error:'not_found'});
      if(!cookie)return json(401,{error:'session_required'});
      if(sessions){
        const root=await known(cookie);if(!root)return json(401,{error:'session_required'});
        await root.store.touch();
        if(req.method==='GET')return json(200,await browserHistory(cookie,root));
        validateCreateTabSession(await bodyText(),req.headers['content-type']);
        const tab=await createTab(cookie,root);
        return tab ? json(201,{sessionId:tab.sessionId,state:{trial:null,hideStrategy:true,busy:false}})
          : json(429,{error:'rate_limited'});
      }
      const tab=tabSessionRoute(req.headers['x-tab-session']);
      if(tab===null)return json(404,{error:'not_found'});
      let e: Entry | null = null;
      if(tab!=='legacy'){
        const root=await known(cookie);if(!root)return json(404,{error:'not_found'});
        const ownerId=await root.serial(async()=>{
          const doName=(await readTabs(cookie)).find(saved=>saved.sessionId===tab)?.doName;
          if(doName)tabsInUse.set(doName,(tabsInUse.get(doName)??0)+1);
          return doName;
        });
        if(!ownerId)return json(404,{error:'not_found'});
        activeTab=ownerId;
        e=await known(ownerId);if(!e)return json(401,{error:'session_required'});
        await root.store.touch();
      }
      let input:any;
      if(action||req.method==='POST'){input=await body();if(path==='/api/start')validateBaseStart(input);}
      e??=await known(cookie);if(!e)return json(401,{error:'session_required'});
      await e.store.touch();
      if(recordPath||path==='/api/records'){
        const c=await e.store.inspect();
        if(path==='/api/records')return json(200,{records:sortRecordList(Object.keys(c.archives).filter(id=>!c.tombstones.includes(id)).map(id=>recordListEntry(c.archives[id],c.owner.admissions[c.owner.activeKey!]?.record?.recordId===id,c.questionnaires[id]??null)))});
        const [,id,view]=recordPath!;const r=ID.test(id)?await e.store.readRecord(id):null;if(!r)return json(404,{error:'not_found'});
        if(view==='review')return req.method==='GET'?json(200,lockResult(participantReview(r),c.questionnaires[id]??null)):json(404,{error:'not_found'});
        if(req.method==='GET')return json(200,{recordId:id,form:QUESTIONNAIRE_FORM,questionnaire:c.questionnaires[id]??null});
        if(r.status!=='completed')throw new NamingTaskError('trial_not_completed');
        const update=questionnaireUpdate(input), store=e.store;
        const questionnaire=await e.serial(async()=>{
          const saved=await store.inspect();
          const next=update((saved.questionnaires[id]??null) as Questionnaire|null,now());
          if(next.changed)await store.saveQuestionnaire(id,next.questionnaire);
          return next.questionnaire;
        });
        return json(200,{recordId:id,form:QUESTIONNAIRE_FORM,questionnaire});
      }
      let task: BaseTask|null;
      if(path==='/api/start'){
        const result=await e.coordinator.start(input);
        if(tab!=='legacy'&&result.kind==='completed')throw new NamingTaskError('trial_changed');
        task=result.task;
      }
      else task=(await e.coordinator.restore()).task;
      const store=e.store;
      const state=async()=>{const v=task?{...task.getState()}:null;if(v){delete v.strategy;delete v.seed;delete v.visualAid;delete v.referenceMemory;}
        const q=v?await store.questionnaire(v.sessionId as string):null;return {trial:v?lockResult(v,q):null,hideStrategy:true,busy:Boolean(v?.busy)};};
      if(path==='/api/state'||path==='/api/start')return json(200,await state());
      if(!task)throw new NamingTaskError('trial_required');
      const live=task.getState();
      if(typeof input.expectedRecordId!=='string'||input.expectedRecordId!==live.sessionId)return json(409,{error:'trial_changed'});
      if(path==='/api/message'){
        const receipt=task.message(input.text,typeof input.clientId==='string'?input.clientId.slice(0,80):undefined);
        try { await task.persistNow(); } catch { throw new NamingTaskError('record_write_failed'); }
        return json(202,{eventId:receipt.eventId,...await state()});
      }
      if(path==='/api/retry')await task.retry();
      if(path==='/api/interrupt'){
        if(typeof task.interruptDialogue!=='function'||live.dialogueRecovery!=='retry'&&live.dialogueRecovery!=='paused')return json(409,{error:'ai_busy'});
        await task.interruptDialogue();
      }
      if(path==='/api/names'){
        if(input.confirm!==true)throw new NamingTaskError('invalid_submission');
        validateEventCount(input,live.events);
        if(live.status==='completed')throw new NamingTaskError('already_submitted');
        await task.submitHuman({names:input.names});if(!task.getState().aiSubmitted)await task.submitAI();
      }
      if(path==='/api/ai-submit'){
        if(tab!=='legacy'&&live.status==='completed')throw new NamingTaskError('trial_changed');
        await task.submitAI();
      }
      return json(200,await state());
    } catch(error){
      if(res.headersSent){res.end();return;}
      if(error instanceof BaseSessionError){const c=error.code==='owner_expired'?'session_required':error.code;return json(c==='session_required'?401:c==='not_found'?404:c==='invalid_request'?400:409,{error:c});}
      if(error instanceof BaseAssignmentError)return json(error.code==='invalid_request'?400:409,{error:error.code==='invalid_request'?'invalid_request':'trial_unavailable'});
      const allowed=['invalid_submission','invalid_message','invalid_request','busy','dialogue_closed','already_submitted','trial_required','invalid_ai_submission','ai_unavailable','scoring_error','record_write_failed','ai_busy','ai_retry_required','submission_error','invalid_questionnaire','questionnaire_submitted','trial_not_completed','trial_changed'];
      const code=error instanceof NamingTaskError&&allowed.includes(error.code)?error.code:'trial_unavailable';
      return json(['scoring_error','record_write_failed'].includes(code)?500:['ai_unavailable','invalid_ai_submission'].includes(code)?502:['busy','ai_busy','ai_retry_required','questionnaire_submitted','trial_not_completed','trial_unavailable','trial_changed'].includes(code)?409:400,{error:code});
    } finally {
      if(activeTab){
        const count=tabsInUse.get(activeTab)!-1;
        if(count)tabsInUse.set(activeTab,count);else tabsInUse.delete(activeTab);
      }
    }
  }
  const close=server.close.bind(server);
  server.drainAndClose=()=>{
    if(drainPromise)return drainPromise;
    draining=true;
    const sockets=new Promise<void>((resolve,reject)=>close(error=>error?reject(error):resolve()));
    drainPromise=(async()=>{
      while(handlers.size)await Promise.all([...handlers]);
      // A request can become idle after close()'s initial idle-connection sweep.
      // Let end()/pipelined response finish events run before testing for idleness.
      await new Promise<void>(resolve=>setImmediate(resolve));
      server.closeIdleConnections();
      await sockets;
      // A failed write may be retried by the calls that were waiting on it; give that retry the chance to start before deciding that nothing is left to write.
      for(;;){
        while(persists.size)await Promise.allSettled([...persists]);
        await new Promise<void>(resolve=>setImmediate(resolve));
        if(!persists.size)break;
      }
      if(unsaved.size)drainFailed=true;
      // No await between observing no started writers and sealing the callback entry.
      persistSealed=true;
      if(drainFailed)throw new Error('shutdown_incomplete');
      await Promise.all([...loadedStores].map(store=>store.close()));
    })();
    return drainPromise;
  };
  server.close=((callback?: (e?:Error)=>void)=>close((error?:Error)=>{Promise.allSettled([...entries.values()].map(async p=>(await p).store.close())).then(()=>callback?.(error));})) as typeof server.close;
  return server;
}
