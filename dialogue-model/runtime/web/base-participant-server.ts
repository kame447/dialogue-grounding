import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createNamingTaskV2 } from '../v2/naming-task-v2.mjs';
import { NamingTaskError } from '../naming-error.mjs';
import { validateBaseStart, BaseAssignmentError } from '../v2/base-assignment.ts';
import { createBaseAssignmentSession, BaseSessionError } from '../v2/base-assignment-session.ts';
import { openBaseFileStore, privateDirectory, registerBaseOwner, readPrivateAssignment, listBaseOwners } from './base-assignment-store.ts';
import type { LocalStore } from './base-assignment-store.ts';
import type { BaseSession, BaseTask } from '../v2/base-assignment.ts';
import { lockResult, participantReview, recordListEntry, sortRecordList, QUESTIONNAIRE_FORM, applyQuestionnaire } from '../v2/participant-records.ts';
import { handleAdmin, isAdminPath, ADMIN_HEADERS } from '../../../workers/tangram-experiment/src/admin/routes.ts';
import { summarizeRecord } from '../../../workers/tangram-experiment/src/admin/summary.ts';
import { summarizeLatency } from '../v2/latency.ts';
import { participantContactHTML } from '../v2/participant-contact.ts';
const PUBLIC = fileURLToPath(new URL('./', import.meta.url));
const STATIC: Record<string, [string,string]> = {'/':['index.html','text/html'], '/index.html':['index.html','text/html'], '/app.js':['app.js','text/javascript'], '/style.css':['style.css','text/css']};
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const failure = () => new BaseSessionError('trial_unavailable');
type Entry = {store: LocalStore; coordinator: BaseSession};
type DrainableServer = ReturnType<typeof createServer> & { drainAndClose(): Promise<void> };
export function createBaseParticipantServer(options: Record<string, any> = {}) {
  if (Object.hasOwn(options,'baseAssignment')) throw failure();
  const {client,baseAssignmentFile,baseStoreRoot,now=Date.now,createTaskV2=createNamingTaskV2,utteranceStyle='default',activeDecision=null,groundingShadow=null,participantJev=null,adminToken,adminLimiter}=options;
  if (!['default','concise'].includes(utteranceStyle)) throw new Error('Invalid utterance style');
  if (activeDecision !== null && (!['decision_jev','decision_luna'].includes(activeDecision?.purpose) || typeof activeDecision.client?.chooseAction !== 'function')) throw new Error('Invalid active decision client');
  const entries = new Map<string,Promise<Entry>>();
  const loadedStores = new Set<LocalStore>();
  const handlers = new Set<Promise<void>>(), persists = new Set<Promise<void>>();
  let draining = false, persistSealed = false, drainFailed = false;
  let drainPromise: Promise<void> | undefined;
  async function entry(ownerId: string) {
    let p = entries.get(ownerId);
    if (!p) {
      p = (async()=>{
        const store=await openBaseFileStore({root:baseStoreRoot,ownerId,now});
        loadedStores.add(store);
        const coordinator=createBaseAssignmentSession({ownerId,store,now,newId:randomUUID,adapter:'local_private_file',
          readConfig:async()=>baseAssignmentFile ? readPrivateAssignment(baseAssignmentFile) : null,
          makeTask:async value=>createTaskV2({client,...value,activeDecision,utteranceStyle,...(groundingShadow?{groundingShadow}:{}),
            ...(participantJev?await participantJev.taskOptions(value):{}),
            onPersist:async (record:Parameters<typeof value.onPersist>[0])=>{
              if(persistSealed)throw new NamingTaskError('record_write_failed');
              const work=Promise.resolve().then(()=>value.onPersist(record));persists.add(work);
              work.then(()=>persists.delete(work),()=>{if(draining)drainFailed=true;persists.delete(work);});
              await work;
            }})});
        return {store,coordinator};
      })(); entries.set(ownerId,p); p.catch(()=>entries.delete(ownerId));
    }
    return p;
  }
  async function known(ownerId: string): Promise<Entry|null> {
    await privateDirectory(baseStoreRoot);
    try { await lstat(join(baseStoreRoot,ownerId+'.owner.json')); }
    catch(e) { if ((e as NodeJS.ErrnoException).code==='ENOENT') return null; throw failure(); }
    const e=await entry(ownerId);const saved=await e.store.read();return saved.kind==='expired'?null:e;
  }
  async function lookupRecord(id:string) {
    for (const owner of await listBaseOwners(baseStoreRoot)) {
      const e=await entry(owner);const r=await e.store.readRecord(id);if(r)return {owner,e,r};
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
    async function body(max=65536) {
      if(req.headers['content-type']?.split(';')[0].trim()!=='application/json')throw new BaseSessionError('invalid_request');
      const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>max)throw new BaseSessionError('invalid_request');chunks.push(c);}
      try{const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(!value||typeof value!=='object'||Array.isArray(value))throw new BaseSessionError('invalid_request');
        return value;
      }catch{throw new BaseSessionError('invalid_request');}
    }
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
        let response: Response;
        try { response=await handleAdmin(request,{token:adminToken,limiter:adminLimiter,retentionDays:0,
          listPage:async()=>{const items=[];for(const owner of await listBaseOwners(baseStoreRoot)){const e=await entry(owner),c=await e.store.inspect();for(const id of Object.keys(c.archives)){const r=await e.store.readRecord(id);if(r)items.push(summarizeRecord({...r,questionnaire:c.questionnaires[id]??null},owner,summarizeLatency(r)));}}return {items,next:null};},
          getSummary:async id=>{
            const found=await lookupRecord(id);
            if(!found&&preparingNext)for(const owner of await listBaseOwners(baseStoreRoot)){
              const saved=await (await entry(owner)).store.inspect();
              if(saved.tombstones.includes(id))throw new BaseSessionError('not_found');
            }
            return found?summarizeRecord(found.r,found.owner,summarizeLatency(found.r)):null;
          },
          getRecord:async summary=>{const e=await entry(summary.objectId),r=await e.store.readRecord(summary.recordId),c=await e.store.inspect();return r?{...r,questionnaire:c.questionnaires[summary.recordId]??null}:null;},
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
          try{
            e=cookie?await known(cookie):null;
            if(!e){
              await privateDirectory(baseStoreRoot);
              if((await listBaseOwners(baseStoreRoot)).length>=64)return json(503,{error:'session_limit'});
              const id=randomBytes(32).toString('hex');await registerBaseOwner(baseStoreRoot,id,now());e=await entry(id);
              res.setHeader('Set-Cookie','naming_session='+id+'; HttpOnly; SameSite=Strict; Path=/');
            }
            await e.store.touch();
          }catch{return json(503,{error:'trial_unavailable'});}
        }
        const [file,type]=STATIC[path];res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});
        const bytes=await readFile(join(PUBLIC,file));res.end(type==='text/html'?participantContactHTML(bytes.toString('utf8'),options.participantContactText):bytes);return;
      }
      const recordPath=path.match(/^\/api\/records\/([^/]+)\/(review|questionnaire)$/u);
      const action=req.method==='POST'&&['/api/start','/api/message','/api/names','/api/retry','/api/ai-submit'].includes(path);
      if(!action&&!(req.method==='GET'&&['/api/state','/api/records'].includes(path))&&!(recordPath&&['GET','POST'].includes(req.method!)))return json(404,{error:'not_found'});
      if(!cookie)return json(401,{error:'session_required'});
      let input:any;
      if(action||req.method==='POST'){input=await body();if(path==='/api/start')validateBaseStart(input);}
      const e=await known(cookie);if(!e)return json(401,{error:'session_required'});
      await e.store.touch();
      if(recordPath||path==='/api/records'){
        const c=await e.store.inspect();
        if(path==='/api/records')return json(200,{records:sortRecordList(Object.keys(c.archives).filter(id=>!c.tombstones.includes(id)).map(id=>recordListEntry(c.archives[id],c.owner.admissions[c.owner.activeKey!]?.record?.recordId===id,c.questionnaires[id]??null)))});
        const [,id,view]=recordPath!;const r=ID.test(id)?await e.store.readRecord(id):null;if(!r)return json(404,{error:'not_found'});
        if(view==='review')return req.method==='GET'?json(200,lockResult(participantReview(r),c.questionnaires[id]??null)):json(404,{error:'not_found'});
        if(req.method==='GET')return json(200,{recordId:id,form:QUESTIONNAIRE_FORM,questionnaire:c.questionnaires[id]??null});
        if(r.status!=='completed')throw new NamingTaskError('trial_not_completed');
        const next=applyQuestionnaire((c.questionnaires[id]??null) as any,input,new Date(now()).toISOString());
        if(next.changed)await e.store.saveQuestionnaire(id,next.questionnaire);
        return json(200,{recordId:id,form:QUESTIONNAIRE_FORM,questionnaire:next.questionnaire});
      }
      let task: BaseTask|null;
      if(path==='/api/start')task=(await e.coordinator.start(input)).task;
      else task=(await e.coordinator.restore()).task;
      const state=async()=>{const v=task?{...task.getState()}:null;if(v){delete v.strategy;delete v.seed;delete v.visualAid;delete v.referenceMemory;}
        const c=await e.store.inspect();return {trial:v?lockResult(v,c.questionnaires[v.sessionId as string]??null):null,hideStrategy:true,busy:Boolean(v?.busy)};};
      if(path==='/api/state'||path==='/api/start')return json(200,await state());
      if(!task)throw new NamingTaskError('trial_required');
      if(path==='/api/message'){
        const receipt=task.message(input.text,typeof input.clientId==='string'?input.clientId.slice(0,80):undefined);
        try { await task.persistNow(); } catch { throw new NamingTaskError('record_write_failed'); }
        return json(202,{eventId:receipt.eventId,...await state()});
      }
      if(path==='/api/retry')await task.retry();
      if(path==='/api/names'){if(input.confirm!==true)throw new NamingTaskError('invalid_submission');await task.submitHuman({names:input.names});if(!task.getState().aiSubmitted)await task.submitAI();}
      if(path==='/api/ai-submit')await task.submitAI();
      return json(200,await state());
    } catch(error){
      if(res.headersSent){res.end();return;}
      if(error instanceof BaseSessionError){const c=error.code==='owner_expired'?'session_required':error.code;return json(c==='session_required'?401:c==='not_found'?404:c==='invalid_request'?400:409,{error:c});}
      if(error instanceof BaseAssignmentError)return json(error.code==='invalid_request'?400:409,{error:error.code==='invalid_request'?'invalid_request':'trial_unavailable'});
      const allowed=['invalid_submission','invalid_message','invalid_request','busy','dialogue_closed','already_submitted','trial_required','invalid_ai_submission','ai_unavailable','scoring_error','record_write_failed','ai_busy','ai_retry_required','submission_error','invalid_questionnaire','questionnaire_submitted','trial_not_completed'];
      const code=error instanceof NamingTaskError&&allowed.includes(error.code)?error.code:'trial_unavailable';
      return json(['scoring_error','record_write_failed'].includes(code)?500:['ai_unavailable','invalid_ai_submission'].includes(code)?502:['busy','ai_busy','ai_retry_required','questionnaire_submitted','trial_not_completed','trial_unavailable'].includes(code)?409:400,{error:code});
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
      while(persists.size)await Promise.all([...persists]);
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
