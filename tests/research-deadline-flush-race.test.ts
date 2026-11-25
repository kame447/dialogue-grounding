// S1F-4 / ADDENDUM02 TR-3: deterministic fake clock + held journal writer.
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';import {tmpdir} from 'node:os';import {join} from 'node:path';
const subject=process.env.SOL1_FLUSH_SUBJECT;
const {runParityLive}=await import(subject?subject+'/dialogue-model/runtime/diagnostics/parity-live/live.ts':'../dialogue-model/runtime/diagnostics/parity-live/live.ts');
const {createChatClient}=await import(subject?subject+'/dialogue-model/runtime/client.mjs':'../dialogue-model/runtime/client.mjs');
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
const drain=async()=>{for(let i=0;i<64;i++)await Promise.resolve();await new Promise<void>(r=>setImmediate(r));};
const manifest=()=>({schemaVersion:2,id:'synthetic_flush_barrier',seed:1701,figureSets:1,approval:'pending',lunaRequest:{timeoutMs:null,maxCompletionTokens:null},timeouts:{observationMs:120,localMs:210,decisionMs:310,lunaAttemptMs:75,generationMs:120,trialMs:1200},caps:{lunaCalls:131,lunaTokens:1500000,lunaPosts:393,jevPosts:208,jevUsd:2},trials:[{stage:'smoke',scriptId:'S0',label:'repair-first'}]});
for(const mode of ['headers','usage','write_failure'])test('flush stable cutoff with held late writer '+mode,async t=>{
 const root=await fs.mkdtemp(join(tmpdir(),'sol1-flush-barrier-')),postSeen=deferred<void>(),headers=deferred<Response>(),body=deferred<any>(),writerEntered=deferred<void>(),writerRelease=deferred<void>();
 let now=0,armed=false,triggered=false,held=false,settled=false,result:any,flushing:Promise<any>|undefined;
 const originalStat=fs.lstat,originalAppend=fs.appendFile;
 t.mock.method(performance,'now',()=>now);t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.UTC(2026,1,3)});
 try{
  const run=runParityLive({outputDir:join(root,'out'),cacheDir:join(root,'cache'),manifest:manifest(),scripts:[{id:'S0',humanTurns:['Synthetic public statement.']}]},{execution:'mock',createLunaClient(_label:any,{request,instrumentFetch}:any){return createChatClient({provider:'cloudflare',purpose:'dialogue_turn',apiKey:'synthetic-local-only',baseUrl:'http://synthetic.invalid/v1',timeoutMs:request.timeoutMs},instrumentFetch(async(_url:any,init:any)=>{if((init?.method??'GET')==='GET')return Response.json({purpose:'dialogue_turn',ready:true,model:'synthetic-model',provider:'openai'});postSeen.resolve();return headers.promise;}),{sleep:async()=>{}});},createJevTransport(){throw Error('unexpected synthetic Jev');}});
  await postSeen.promise;now=75;t.mock.timers.tick(75);result=await run;
  const before=await result.flushBilling();assert.equal(before.deadlineRevisions.savedRevision,before.deadlineRevisions.cutoffRevision);assert.equal(before.deadlineRevisions.writeFailed,false);
  const terminal=structuredClone(before.deadlineRevisions.latest[0].deadlines.measured.sends[0].terminal);
  armed=true;
  // Only the already-created synthetic run files receive fake stat replies.
  // No OS scheduling or elapsed wall time decides when the held write completes.
  fs.lstat=(async(...args:any[])=>{
   const path=String(args[0]);
   if(armed&&!triggered&&path===join(result.directory,'verifier-evidence.private.json')){
    triggered=true;now=130;headers.resolve({ok:true,status:200,clone:()=>({json:()=>body.promise})} as any);
    if(mode==='usage')body.resolve({model:'synthetic-model',usage:{prompt_tokens:2,completion_tokens:4}});
    await writerEntered.promise;
   }
   if(armed&&path.startsWith(result.directory+'/')&&/\.(json|jsonl)$/u.test(path))return {isFile:()=>true,isSymbolicLink:()=>false,mode:0o600};
   return (originalStat as any)(...args);
  }) as any;
  fs.appendFile=(async(...args:any[])=>{
   if(armed&&!held&&String(args[0])===join(result.directory,'deadlines.private.jsonl')){held=true;writerEntered.resolve();await writerRelease.promise;if(mode==='write_failure')throw Error('synthetic_journal_write_failed');}
   return (originalAppend as any)(...args);
  }) as any;
  syncBuiltinESMExports();
  flushing=result.flushBilling().then((v:any)=>{settled=true;return v;});
  await writerEntered.promise;await drain();const returnedWhileWriterHeld=settled;
  writerRelease.resolve();const after=await flushing;
  // A headers-only flush must finish while the remote body remains unresolved.
  assert.equal(triggered,true);assert.equal(held,true);assert.equal(returnedWhileWriterHeld,false,'flush returned before its captured journal write completed');
  const cut=after.deadlineRevisions;assert.ok(cut.cutoffRevision>before.deadlineRevisions.cutoffRevision);
  if(mode==='write_failure'){assert.equal(cut.writeFailed,true);assert.ok(cut.savedRevision<cut.cutoffRevision);assert.equal(after.auditability.status,'save_failed');assert.equal(after.auditability.firstSaveFailure,'deadlines.private.jsonl');}
  else{assert.equal(cut.writeFailed,false);assert.equal(cut.savedRevision,cut.cutoffRevision);assert.equal(after.auditability.status,'auditable');}
  assert.deepEqual(cut.latest[0].deadlines.measured.sends[0].terminal,terminal);assert.equal(cut.latest[0].deadlines.measured.calls[0].adopted,false);
  const frozenFirst=structuredClone(cut);body.resolve({model:'synthetic-model',usage:{prompt_tokens:2,completion_tokens:4}});await drain();
  const later=await result.flushBilling(),late=later.deadlineRevisions;assert.equal(later.observedLunaTokens,6);assert.equal(late.latest[0].deadlines.measured.sends[0].lateObservation.usageRecorded,true);
  assert.deepEqual(late.latest[0].deadlines.measured.sends[0].terminal,terminal);assert.equal(late.latest[0].deadlines.measured.calls[0].adopted,false);assert.deepEqual(cut,frozenFirst);
  if(mode==='headers'){assert.ok(late.cutoffRevision>cut.cutoffRevision);assert.equal(late.savedRevision,late.cutoffRevision);assert.equal(late.writeFailed,false);}
 }finally{
  writerRelease.resolve();if(flushing)await flushing.catch(()=>{});
  fs.lstat=originalStat;fs.appendFile=originalAppend;syncBuiltinESMExports();
  body.resolve({model:'synthetic-model',usage:{prompt_tokens:2,completion_tokens:4}});await drain();
  if(result)await result.flushBilling();t.mock.timers.reset();t.mock.restoreAll();await fs.rm(root,{recursive:true,force:true});
 }
});
