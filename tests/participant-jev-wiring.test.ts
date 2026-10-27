// P1 frozen contract: real cache/HTTP boundaries with synthetic local transports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrialV2, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { createObservationCache, createObservationCacheKey, observationCacheFileName } from '../dialogue-model/runtime/observation/cache.ts';
import { researchHash, researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { prepareParticipantJev, createParticipantCacheObserver, validateParticipantJevConfig, participantLedgerFetch,
  participantLunaClient, restoreParticipantJevLedger } from '../dialogue-model/runtime/web/participant-jev-wiring.ts';
import { RunBudget } from '../dialogue-model/runtime/diagnostics/parity-live/audit.ts';
import { participantReview, QUESTIONNAIRE_FORM } from '../dialogue-model/runtime/v2/participant-records.ts';
import { summarizeRecord } from '../workers/tangram-experiment/src/admin/summary.ts';
import { summarizeLatency } from '../dialogue-model/runtime/v2/latency.ts';
import { startNamingServer } from '../dialogue-model/runtime/web/server.mjs';

const seed=919, modelId='synthetic-luna-20261020';
const trial=createTrialV2({seed}),model=modelView(trial);
const own={ownImage:{mimeType:model.mimeType,base64:model.png.toString('base64')},ownAnchors:model.anchors};
const timeouts={observationMs:20000,localMs:20000,decisionMs:20000,lunaAttemptMs:80000,generationMs:40000,trialMs:600000};
const limits={lunaCalls:100,lunaTokens:100000,lunaPosts:100,jevPosts:100,jevUsd:0.05};
const rawMemo={figures:model.anchors.map((a:any)=>({id:a.id,holistic:[],analytic:{shapes:['三角'],composition:'二つの部分が接する',relations:[]},unknowns:[]}))};
const assignment={schemaVersion:'base_assignment_config_v1',configId:'11111111-1111-4111-8111-111111111111',revision:1,strategy:'repair-first',seed,referenceMemory:true};
const clientConfig={provider:'cloudflare',purpose:'dialogue_turn',baseUrl:'https://synthetic.invalid/v1',apiKey:'synthetic-private-proxy-key'};
const syntheticKey='sk-or-synthetic-only-private-key-0123456789';
function tape(action='accept',localSegment=false,aiClaim=false) {
  const posts:any[]=[];let gets=0, keyReads=0;
  const fetchImpl:typeof fetch=async(_url,init:any={})=>{
    if(init.method==='GET'){gets++;return Response.json({ready:true,purpose:'dialogue_turn',provider:'openai',model:modelId});}
    const body=JSON.parse(init.body);posts.push(body);
    if(body.questions){
      const answers=Object.fromEntries(Object.entries(body.questions).map(([name,q]:[string,any])=>{
        const choices=Object.keys(q.criteria),chosen=name==='action'?action:name==='target'||name==='human_referent'||name.endsWith('_antecedent')?'none':name.startsWith('candidate_')?'exclude':name.endsWith('_act')?'assert':choices[0];
        return [name,{type:'choice',choice:chosen,probabilities:Object.fromEntries(choices.map(v=>[v,v===chosen?1:name==='action'&&v==='accept'?0.9:0])),confidence:1}];
      }));
      return Response.json({model:'typesafe/jev-1.14-20261014',id:'gen-synthetic',usage:{cost:0.001},answers});
    }
    const state=body.messages[1]?.content;
    let parsed:any;try{parsed=JSON.parse(state);}catch{}
    const final=String(body.messages.at(-1)?.content).includes('JSON')&&!parsed?.candidateText&&!parsed?.publicTurns;
    const claim=parsed?.candidateText&&aiClaim;
    const segment=claim||parsed?.publicTurns&&!parsed?.candidateText&&localSegment?JSON.stringify([{segmentId:'s1',quote:claim?parsed.candidateText:parsed.publicTurns.at(-1).text,
      targets:[model.anchors[0].id],aspect:'part',proposition:'細い部分がある',name:null,linkedIssueId:null,respondsToTurn:null}]):'[]';
    const text=parsed?.candidateText||parsed?.publicTurns?segment:final?JSON.stringify(Object.fromEntries(model.anchors.map((a:any)=>[a.id,null]))):aiClaim?'細い部分が見えます。':'なるほど。';
    return Response.json({model:modelId,choices:[{message:{content:text}}],usage:{prompt_tokens:3,completion_tokens:2}});
  };
  return{fetchImpl,posts,counts:()=>({gets,keyReads,posts:posts.length}),readKey:async()=>{keyReads++;return syntheticKey;}};
}
async function fixture(t:any,changes:any={}){
  const dir=await mkdtemp(join(await realpath(tmpdir()),'HazelKepler-p1-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const cacheDirectory=join(dir,'cache');await mkdir(cacheDirectory,{mode:0o700});
  const warm=await createObservationCache({directory:cacheDirectory,modelId,onMiss:'observe',client:{async complete(){return{text:JSON.stringify(rawMemo),model:modelId};}}});
  const hit=await warm.get(own);
  const config={schemaVersion:'participant_jev_config_v1',lunaRequest:{timeoutMs:null,maxCompletionTokens:1000},timeouts,
    cacheDirectory,modelId,memoSha256:researchHash(hit.memo),seed,limits,...changes};
  const configFile=join(dir,'jev.json'),baseAssignmentFile=join(dir,'base.json');
  await writeFile(configFile,JSON.stringify(config),{mode:0o600});await writeFile(baseAssignmentFile,JSON.stringify(assignment),{mode:0o600});
  const upstream=tape();
  const options={configFile,baseAssignmentFile,clientConfig,fetchImpl:upstream.fetchImpl,readKey:upstream.readKey};
  return{dir,config,hit,options,upstream,cacheFile:join(cacheDirectory,observationCacheFileName(createObservationCacheKey(own,{modelId})))};
}
async function makeTask(prepared:any,extra:any={}){
  let saved:any;
  const value={strategy:'repair-first',seed,referenceMemory:true,...extra};
  const wiring=await prepared.taskOptions(value);
  const task=await createNamingTaskV2({...value,...wiring,runDir:null,createTrial:()=>trial,onPersist:async(r:any)=>{saved=structuredClone(r);}});
  return{task,record:()=>saved,wiring};
}

test('J-D1/D2/S1-S8: preflight makes one policy GET; task initialization is cache-only',async t=>{
  const h=await fixture(t),prepared=await prepareParticipantJev(h.options);
  assert.deepEqual(h.upstream.counts(),{gets:1,keyReads:0,posts:0});
  const made=await makeTask(prepared);
  assert.deepEqual(h.upstream.counts(),{gets:1,keyReads:0,posts:0});
  assert.equal(made.record().initialObservation.audit.status,'HIT');
  assert.equal(made.record().initialObservation.memoSha256,h.config.memoSha256);
  assert.equal(made.record().queueState.privateState.observationMemo.figures.length,6);
});

test('J-D3/D4: corrupt cache and wrong own image/anchors fail before any POST',async t=>{
  const h=await fixture(t),profile=validateParticipantJevConfig(h.config).profile;
  const observer=await createParticipantCacheObserver({directory:h.config.cacheDirectory,modelId,memoSha256:h.config.memoSha256,
    own,profile,reobserver:{async observeAll(){throw Error();},async reobserve(){throw Error();}}});
  for(const input of [{...own,ownImage:{...own.ownImage,base64:Buffer.from('different-own-image').toString('base64')}},
    {...own,ownAnchors:own.ownAnchors.map((a:any,i:number)=>i===0?{...a,id:'different-own-id'}:a)}])
    await assert.rejects(observer.observeAll(input),{code:'wrong_own_material'});
  await writeFile(h.cacheFile,'{broken');
  await assert.rejects(prepareParticipantJev(h.options),{code:'invalid_config'});
  const wrongModel=await createParticipantCacheObserver({directory:h.config.cacheDirectory,modelId:'different-model',memoSha256:h.config.memoSha256,
    own,profile,reobserver:{async observeAll(){throw Error();},async reobserve(){throw Error();}}});
  await assert.rejects(wrongModel.observeAll(own),{code:'initialization_failed'});
  await rm(h.cacheFile);await assert.rejects(observer.observeAll(own),{code:'initialization_failed'});
  assert.equal(h.upstream.counts().posts,0);
});

test('J-S1/S4/S8: insecure file, assignment mismatch, style and legacy decision conflicts refuse startup',async t=>{
  const h=await fixture(t);
  await chmod(h.options.configFile,0o644);await assert.rejects(prepareParticipantJev(h.options),{code:'invalid_config'});
  await chmod(h.options.configFile,0o600);
  for(const extra of [{utteranceStyle:'concise'},{activeDecision:{}},{groundingShadow:{}}])
    await assert.rejects(prepareParticipantJev({...h.options,...extra}),{code:'invalid_config'});
  for(const change of [{referenceMemory:false},{seed:seed+1}]){
    await writeFile(h.options.baseAssignmentFile,JSON.stringify({...assignment,...change}));
    await assert.rejects(prepareParticipantJev(h.options),{code:'invalid_config'});
  }
  assert.equal(h.upstream.counts().gets,0);
});

test('J-S2/S3/S6/S7: schema, cache digest, timeout relationship and missing limits refuse startup',async t=>{
  const h=await fixture(t);
  for(const changes of [{schemaVersion:'unknown'},{memoSha256:'0'.repeat(64)},{limits:null},{timeouts:{...timeouts,lunaAttemptMs:85001}},
    {timeouts:{...timeouts,generationMs:timeouts.trialMs}},{limits:{...limits,jevUsd:0.051}},{unexpected:'not-allowed'}]){
    await writeFile(h.options.configFile,JSON.stringify({...h.config,...changes}));
    await assert.rejects(prepareParticipantJev(h.options),{code:'invalid_config'});
  }
});

test('J-S5: model policy mismatch stops before admission and completions',async t=>{
  const h=await fixture(t);let gets=0;
  await assert.rejects(prepareParticipantJev({...h.options,fetchImpl:async()=>{gets++;return Response.json({ready:true,purpose:'dialogue_turn',provider:'openai',model:'unknown-snapshot'});}}),{code:'invalid_config'});
  assert.equal(gets,1);assert.equal(h.upstream.counts().posts,0);
});

test('J-S6/R3: a nondefault generation deadline rejects a signal-ignoring response',async()=>{
  const profile=researchTrialProfileV3({timeoutMs:null,maxCompletionTokens:1000},{...timeouts,generationMs:15});
  const budget=new RunBudget(limits);let finish!:()=>void,receivedTimeout:number|undefined;
  const client=participantLunaClient({async complete(_messages,options){receivedTimeout=options.timeoutMs;return new Promise(resolve=>{finish=()=>resolve({text:'late'});});}},budget,profile);
  await assert.rejects(client.complete([{role:'user',content:'synthetic'}],{phase:'generation'}),{code:'timeout'});
  finish();assert.equal(budget.lunaCalls,1);assert.equal(receivedTimeout,15);
});

test('J-B1/R1: POST cap is reserved before send and remains exhausted after restore',async()=>{
  const budget=new RunBudget({...limits,jevPosts:1});let posts=0;
  const fetchImpl=participantLedgerFetch(budget,'jev',modelId,async()=>{posts++;return Response.json({model:'typesafe/jev-1.14',usage:{cost:0.01}});});
  await fetchImpl('https://synthetic.invalid',{method:'POST',body:'{}'});
  const restored=new RunBudget({...limits,jevPosts:1});restoreParticipantJevLedger(restored,budget.snapshot());
  const retry=participantLedgerFetch(restored,'jev',modelId,async()=>{posts++;return Response.json({});});
  await assert.rejects(retry('https://synthetic.invalid',{method:'POST',body:'{}'}),/budget_stop/);
  assert.equal(posts,1);assert.equal(restored.jevPosts,1);
});

test('J-B2: unknown returned model halts all subsequent sends and stores safe model identity',async()=>{
  const budget=new RunBudget(limits);let posts=0;
  const wire=participantLedgerFetch(budget,'jev',modelId,async()=>{posts++;return Response.json({model:'typesafe/jev-1.14-20990101',usage:{cost:0.01}});});
  await assert.rejects(wire('https://synthetic.invalid',{method:'POST',body:'{}'}),{code:'model_mismatch'});
  await assert.rejects(wire('https://synthetic.invalid',{method:'POST',body:'{}'}),/budget_stop/);
  assert.equal(posts,1);assert.equal(budget.snapshot().haltReason,'model_mismatch');
  assert.equal((budget.snapshot().sends[0] as any).version,'20990101');
});

test('J-T1/T2/L1/L2/F1: Jev turn, duplicate message, private settlement, final submission and public review',async t=>{
  const h=await fixture(t),made=await makeTask(await prepareParticipantJev(h.options));
  const first=made.task.message('この形について話しましょう。','same-message');
  assert.equal(made.task.message('この形について話しましょう。','same-message').duplicate,true);
  await made.task.whenIdle();assert.equal(made.task.getState().aiStatus,'idle',JSON.stringify({
    errors:made.record().jevTraces.map((r:any)=>({error:r.errorCode,decision:r.decisions.map((d:any)=>d.action),generation:r.generationErrorCode})),
    halt:made.record().jevLedger.haltReason,refusals:made.record().jevLedger.refusals,phases:made.record().requests.map((r:any)=>({kind:r.kind,status:r.status}))}));
  assert.equal(made.record().jevTraces.length,1);assert.equal(made.record().jevTraces[0].status,'committed');
  await made.task.submitHuman({names:Object.fromEntries(made.task.getState().scene.shapes.map((s:any)=>[s.id,null]))});
  assert.equal(made.record().aiPublicSettlement.status,'ok');
  await made.task.submitAI();
  assert.equal(made.task.getState().status,'completed');assert.equal(first.duplicate,false);
  const record=made.record(),publicJson=JSON.stringify({state:made.task.getState(),review:participantReview(record)});
  for(const key of ['jevTraces','interventionPolicy','jevLedger','profileSha256','aiPublic','seed','strategy'])assert.ok(!publicJson.includes('"'+key+'"'),key);
  for(const secret of [clientConfig.apiKey,syntheticKey,own.ownImage.base64])assert.ok(!publicJson.includes(secret));
  assert.doesNotThrow(()=>summarizeRecord(record,'a'.repeat(64),summarizeLatency(record)));
  assert.ok(h.upstream.posts.every(body=>!JSON.stringify(body).includes('repair-first')&&!JSON.stringify(body).includes('bypass-enabled')));
  assert.ok(h.upstream.posts.filter(body=>body.messages).every(body=>body.max_completion_tokens===1000));
});

test('J-D3/F1: cache corruption during makeTask uses BASE initialization_failed and private error stays hidden',async t=>{
  const h=await fixture(t),prepared=await prepareParticipantJev(h.options);
  await writeFile(h.cacheFile,'broken');
  const root=join(h.dir,'owners');await mkdir(root,{mode:0o700});
  const server=await startNamingServer({port:0,client:{},baseAssignmentFile:h.options.baseAssignmentFile,baseStoreRoot:root,
    createTaskV2:async(value:any)=>createNamingTaskV2({...value,...await prepared.taskOptions(value)})} as any);
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const page=await fetch(url),cookie=page.headers.get('set-cookie')!.split(';')[0];
  const response=await fetch(url+'/api/start',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{"version":2}'});
  assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'trial_unavailable'});
  const stored=JSON.parse(await readFile(join(root,cookie.slice(cookie.indexOf('=')+1)+'.owner.json'),'utf8'));
  assert.equal(stored.owner.admissions.initial.errorCode,'initialization_failed');
  assert.equal(h.upstream.counts().posts,0);
});

test('J-B1: a failed Jev send remains reserved and its raw error is never recorded',async()=>{
  const budget=new RunBudget(limits),wire=participantLedgerFetch(budget,'jev',modelId,async()=>{throw Error('synthetic-private-provider-body');});
  await assert.rejects(wire('https://synthetic.invalid',{method:'POST',body:'{}'}));
  assert.equal(budget.jevPosts,1);assert.equal(budget.snapshot().sends[0].status,'sent_result_unknown');
  assert.equal(budget.snapshot().haltReason,'jev_cost_unknown');
  assert.ok(!JSON.stringify(budget.snapshot()).includes('synthetic-private-provider-body'));
});

test('J-B1: adapter cost_cap becomes a private turn failure, and retry makes zero new sends',async t=>{
  const h=await fixture(t);
  const fetchImpl:typeof fetch=async(url,init)=>{
    const response=await h.upstream.fetchImpl(url,init);
    if(init?.method==='POST'&&JSON.parse(String(init.body)).questions){const body=await response.json();body.usage.cost=0.03;return Response.json(body);}
    return response;
  };
  const made=await makeTask(await prepareParticipantJev({...h.options,fetchImpl}));
  made.task.message('この形を確認したいです','cost-limit');await made.task.whenIdle();
  assert.equal(made.task.getState().aiStatus,'error');
  assert.equal(made.record().jevLedger.haltReason,'cost_cap');
  const sends=h.upstream.counts().posts;await made.task.retry();
  assert.equal(h.upstream.counts().posts,sends);assert.equal(made.task.getState().aiStatus,'error');
  assert.ok(!JSON.stringify(made.task.getState()).includes('cost_cap'));
});

// P4(b): inspect recorded synthetic material only; missing tails are never synthesized.
function pairedEvidence(a:any,b:any):'verified'|'mismatch'|'unverifiable'{
  for(const r of [a,b])if(!r?.options?.profileSha256||!r.initialObservation?.memoSha256||!r.jevTraces?.length||
    !r.jevLedger?.sends?.some((s:any)=>s.boundary==='common')||!r.jevLedger.sends.some((s:any)=>s.phase==='generation'))return'unverifiable';
  const common=(r:any)=>r.jevLedger.sends.filter((s:any)=>s.boundary==='common').map((s:any)=>[s.provider,s.phase,s.requestSha256]);
  return researchHash(common(a))===researchHash(common(b))&&a.options.profileSha256===b.options.profileSha256&&
    a.initialObservation.memoSha256===b.initialObservation.memoSha256?'verified':'mismatch';
}
test('J-C1/C2/C3/P1: paired adoption and veto share common inputs; each tail follows its executed act',async t=>{
  const h=await fixture(t);
  async function pair(action:string,claims=false){
    const upstream=tape(action,claims,claims),prepared=await prepareParticipantJev({...h.options,fetchImpl:upstream.fetchImpl,readKey:upstream.readKey});
    const runs=[];
    for(const strategy of ['repair-first','bypass-enabled']){
      const made=await makeTask(prepared,{strategy});
      made.task.message('形について続けましょう','paired');await made.task.whenIdle();
      assert.equal(made.task.getState().aiStatus,'idle',JSON.stringify(made.record().jevLedger.refusals));runs.push(made.record());
    }
    for(const body of upstream.posts)for(const label of ['repair-first','bypass-enabled'])assert.ok(!JSON.stringify(body).includes(label));
    const evidenceDirectory=process.env.PARTICIPANT_JEV_TEST_EVIDENCE_DIR;
    if(evidenceDirectory){
      await mkdir(evidenceDirectory,{recursive:true,mode:0o700});
      for(let i=0;i<runs.length;i++)await writeFile(join(evidenceDirectory,action+(claims?'-claim':'')+'-'+i+'.private.json'),JSON.stringify(runs[i],null,2)+'\n',{mode:0o600});
    }
    assert.equal(pairedEvidence(runs[0],runs[1]),'verified');return runs;
  }
  const adopted=await pair('accept');
  const allBodies=(r:any)=>r.jevLedger.sends.map((s:any)=>s.requestSha256);
  assert.deepEqual(allBodies(adopted[0]),allBodies(adopted[1]));
  const vetoed=await pair('move_on');
  assert.equal(vetoed[0].jevTraces[0].intervention.disposition,'rejected');
  assert.equal(vetoed[1].jevTraces[0].intervention.disposition,'adopted');
  assert.equal(vetoed[0].jevTraces[0].executed.action,'accept');
  assert.equal(vetoed[1].jevTraces[0].executed.action,'move_on');
  const generation=(r:any)=>r.jevLedger.sends.filter((s:any)=>s.phase==='generation').map((s:any)=>s.requestSha256);
  assert.notDeepEqual(generation(vetoed[0]),generation(vetoed[1]));
  assert.deepEqual(generation(vetoed[0]),generation(adopted[0]),'same executed act has the same entire generation body');
  const missing=structuredClone(vetoed[0]);missing.jevLedger.sends=missing.jevLedger.sends.filter((s:any)=>s.boundary==='common');
  assert.equal(pairedEvidence(missing,vetoed[1]),'unverifiable');
  const withClaims=await pair('move_on',true);
  for(const record of withClaims){
    assert.equal(record.jevTraces[0].local.classifier.status,'ok');
    assert.equal(record.jevTraces[0].aiPublic.stages.ai_function.status,'ok');
    assert.equal(record.jevTraces[0].aiPublic.stages.ai_support.status,'ok');
    const sends=record.jevLedger.sends,generationIndex=sends.findIndex((s:any)=>s.phase==='generation');
    assert.ok(sends.slice(0,generationIndex).some((s:any)=>s.provider==='jev'&&s.phase==='jev'&&s.boundary==='common'),'human local remains common');
    assert.deepEqual(sends.slice(generationIndex+1).filter((s:any)=>s.provider==='jev').map((s:any)=>[s.phase,s.boundary]),[['ai_function','tail'],['ai_support','tail']]);
  }
});

test('J-R1/F1/L1/L2: loopback start/message/reload/final/questionnaire/review keeps the BASE contract',async t=>{
  const h=await fixture(t),prepared=await prepareParticipantJev(h.options),root=join(h.dir,'owners');await mkdir(root,{mode:0o700});
  let current:any,lastRecord:any;
  const options:any={port:0,client:{},baseAssignmentFile:h.options.baseAssignmentFile,baseStoreRoot:root,
    createTaskV2:async(value:any)=>{
      const onPersist=value.onPersist;
      current=await createNamingTaskV2({...value,...await prepared.taskOptions(value),onPersist:async(r:any)=>{lastRecord=structuredClone(r);await onPersist(r);}});
      return current;
    }};
  let server=await startNamingServer(options);
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  let url='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const cookie=(await fetch(url)).headers.get('set-cookie')!.split(';')[0];
  const request=(path:string,body?:unknown)=>fetch(url+path,{headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},
    ...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
  const start=await request('/api/start',{version:2});assert.equal(start.status,200);
  const first=await start.json();assert.equal(first.hideStrategy,true);assert.equal(h.upstream.counts().posts,0);
  const message={text:'形の話を続けます',clientId:'http-duplicate',expectedRecordId:first.trial.sessionId};
  const receipt=await (await request('/api/message',message)).json();await current.whenIdle();
  const repeated=await (await request('/api/message',message)).json();assert.equal(receipt.eventId,repeated.eventId);
  const sends=h.upstream.counts().posts,before=structuredClone(lastRecord);
  await new Promise<void>(resolve=>server.close(()=>resolve()));server=await startNamingServer(options);
  url='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const reload=await request('/api/state');assert.equal(reload.status,200);const restored=await reload.json();
  assert.equal(h.upstream.counts().posts,sends);
  assert.equal(lastRecord.initialObservation.memoSha256,before.initialObservation.memoSha256);
  assert.deepEqual(lastRecord.jevLedger.sends,before.jevLedger.sends);
  assert.deepEqual(lastRecord.jevTraces,before.jevTraces);
  assert.deepEqual(lastRecord.attempts,before.attempts);
  const submitted=await request('/api/names',{confirm:true,expectedRecordId:restored.trial.sessionId,names:Object.fromEntries(restored.trial.scene.shapes.map((s:any)=>[s.id,null]))});
  assert.equal(submitted.status,200);assert.equal((await submitted.json()).trial.status,'completed');
  const id=restored.trial.sessionId;
  const questionnaire=await request('/api/records/'+id+'/questionnaire',{submit:true,answers:Object.fromEntries(QUESTIONNAIRE_FORM.items.map(item=>[item.id,4])),comment:''});
  assert.equal(questionnaire.status,200);
  const review=await request('/api/records/'+id+'/review');assert.equal(review.status,200);
  const text=await review.text();
  for(const hidden of ['jevTraces','jevLedger','interventionPolicy','profileSha256','repair-first','bypass-enabled',syntheticKey,clientConfig.apiKey,own.ownImage.base64])assert.ok(!text.includes(hidden),hidden);
  assert.equal(lastRecord.aiPublicSettlement.status,'ok');
});

test('J-P1: a real local classification keeps its live adapter evidence in the private record',async t=>{
  const h=await fixture(t),upstream=tape('accept',true);
  const made=await makeTask(await prepareParticipantJev({...h.options,fetchImpl:upstream.fetchImpl,readKey:upstream.readKey}));
  made.task.message('細い部分が見えます','local-claim');await made.task.whenIdle();
  assert.equal(made.task.getState().aiStatus,'idle');
  assert.equal(made.record().jevTraces[0].local.classifier.status,'ok');
  assert.equal(made.record().jevTraces[0].local.classifier.model,'typesafe/jev-1.14-20261014');
  assert.ok(made.record().jevTraces[0].local.classifier.callIndex>0);
});

test('adaptive repair technicalTrial accepts only its exact version and stays absent by default',async t=>{
  const h=await fixture(t);
  assert.ok(!Object.hasOwn(validateParticipantJevConfig(h.config).config,'technicalTrial'));
  assert.deepEqual(validateParticipantJevConfig({...h.config,technicalTrial:{version:'adaptive_repair_v1'}}).config.technicalTrial,{version:'adaptive_repair_v1'});
  for(const value of [undefined,null,false,{},'adaptive_repair_v1',{version:'unknown'},{version:'adaptive_repair_v1',extra:true}]){
    assert.throws(()=>validateParticipantJevConfig({...h.config,technicalTrial:value}),{code:'invalid_config'});
  }
});

test('adaptive repair wiring exposes estimator only ON and accounts its POST as jev_prospect',async t=>{
  const off=await fixture(t),offPrepared=await prepareParticipantJev(off.options);
  const offOptions=await offPrepared.taskOptions({seed,referenceMemory:true,strategy:'repair-first'});
  assert.ok(!Object.hasOwn(offOptions.jevResearch!,'technicalTrial'));
  assert.ok(!Object.hasOwn(offOptions.jevResearch!.jevDecision,'estimateRepairProspect'));
  const on=await fixture(t,{technicalTrial:{version:'adaptive_repair_v1'}}),prepared=await prepareParticipantJev(on.options);
  const options=await prepared.taskOptions({seed,referenceMemory:true,strategy:'repair-first'}),research=options.jevResearch!;
  const slots=model.anchors.map((a:any)=>a.id);
  const result=await research.jevDecision.estimateRepairProspect!({turn:3,ownSlots:slots,observations:on.hit.memo,
    publicTurns:[{turn:3,speaker:'human',text:'まだ分かりません'}],issueSummary:'',priorClaims:[],previousAction:null,publicNames:[],
    repairHistory:[{turn:1,issueId:null,action:'repair',question:'細い部分がありますか',partnerClaims:[],candidatesBefore:slots.slice(0,2),
      candidatesAfter:slots.slice(0,2),addedClaimIds:[],removedClaimIds:[],progress:'unchanged'}]});
  assert.equal(result.status,'ok');
  assert.equal(research.ledger.sends.length,1);
  assert.equal(research.ledger.sends[0].phase,'jev_prospect');
  assert.equal(research.ledger.sends[0].provider,'jev');
  assert.equal(research.ledger.sends[0].status,'observed_response');
  assert.equal(research.ledger.sends[0].costUsd,0.001);
  assert.deepEqual(research.technicalTrial,{version:'adaptive_repair_v1'});
});

test('adaptive repair option is private, recorded and requires the same config at restore',async t=>{
  const h=await fixture(t,{technicalTrial:{version:'adaptive_repair_v1'}}),prepared=await prepareParticipantJev(h.options);
  const made=await makeTask(prepared),saved=made.record();
  assert.deepEqual(saved.options.technicalTrial,{version:'adaptive_repair_v1'});
  assert.ok(!JSON.stringify(made.task.getState()).includes('technicalTrial'));
  const restored=await makeTask(prepared,{restore:saved});
  assert.deepEqual(restored.record().options.technicalTrial,saved.options.technicalTrial);
  const options=await prepared.taskOptions({seed,referenceMemory:true,strategy:'repair-first'});
  const {technicalTrial:_trial,...without}=options.jevResearch!;
  await assert.rejects(createNamingTaskV2({seed,referenceMemory:true,strategy:'repair-first',...options,client:options.client!,jevResearch:without,restore:saved,runDir:null,createTrial:()=>trial}),{code:'invalid_options'});
  const offSaved=structuredClone(saved);delete offSaved.options.technicalTrial;
  await assert.rejects(makeTask(prepared,{restore:offSaved}),{code:'invalid_options'});
  const invalidTrace=structuredClone(saved);
  invalidTrace.jevTraces=[{schemaVersion:'jev_turn_trace_v2',intervention:null,turnIndex:1,repairHistory:[],repairProspect:{status:'unknown',issue:null,prospect:null,basis:null,scores:{}}}];
  await assert.rejects(makeTask(prepared,{restore:invalidTrace}),{code:'invalid_options'});
  const invalidSaved=structuredClone(saved);invalidSaved.options.technicalTrial.version='unknown';
  await assert.rejects(makeTask(prepared,{restore:invalidSaved}),{code:'invalid_options'});
});

test('an OFF restore rejects an open-issue rerank trace',async t=>{
  const h=await fixture(t),prepared=await prepareParticipantJev(h.options),saved=(await makeTask(prepared)).record();
  const mixed=structuredClone(saved);
  mixed.jevTraces=[{schemaVersion:'jev_turn_trace_v2',turnIndex:1,intervention:{policy:'bypass_acceptance_v1:veto',rerank:{policyId:'saved_action_scores_open_issue_v1'}}}];
  await assert.rejects(makeTask(prepared,{restore:mixed}),{code:'invalid_options'});
});
