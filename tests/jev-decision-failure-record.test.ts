// audit/02 §2-§5 at the participant boundary: plan O private failure records (B), the uncommitted failure and its
// refusal (A7-A9), two_stage_v2 layout recording and restore (C2-4) and the explicit research Jev budget.
// Synthetic cache, transports and keys only; never a live model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrialV2, modelView, participantView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { createObservationCache } from '../dialogue-model/runtime/observation/cache.ts';
import { researchHash } from '../dialogue-model/runtime/v2/research-profile.ts';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { prepareParticipantJev, validateParticipantJevConfig } from '../dialogue-model/runtime/web/participant-jev-wiring.ts';
import { participantReview, QUESTIONNAIRE_FORM } from '../dialogue-model/runtime/v2/participant-records.ts';
import { startNamingServer } from '../dialogue-model/runtime/web/server.mjs';
import { summarizeRecord } from '../workers/tangram-experiment/src/admin/summary.ts';
import { summarizeLatency } from '../dialogue-model/runtime/v2/latency.ts';

const seed=919, modelId='synthetic-luna-20261020';
const trial=createTrialV2({seed}),model=modelView(trial);
const own={ownImage:{mimeType:model.mimeType,base64:model.png.toString('base64')},ownAnchors:model.anchors};
const timeouts={observationMs:20000,localMs:20000,decisionMs:20000,lunaAttemptMs:80000,generationMs:40000,trialMs:600000};
const limits={lunaCalls:100,lunaTokens:100000,lunaPosts:100,jevPosts:100,jevUsd:0.05};
// No holistic construal and no public names: propose_name has no name candidate (name_required).
const rawMemo={figures:model.anchors.map((a:any)=>({id:a.id,holistic:[],analytic:{shapes:['三角'],composition:'二つの部分が接する',relations:[]},unknowns:[]}))};
const assignment={schemaVersion:'base_assignment_config_v1',configId:'11111111-1111-4111-8111-111111111111',revision:1,strategy:'repair-first',seed,referenceMemory:true};
const clientConfig={provider:'cloudflare',purpose:'dialogue_turn',baseUrl:'https://synthetic.invalid/v1',apiKey:'synthetic-private-proxy-key'};
const syntheticKey='sk-or-synthetic-only-private-key-0123456789';
type Plan={stage1:Record<string,string>;set?:string;cost?:number;brokenReferent?:boolean};
/** Synthetic upstream. Jev stage one, candidate set and detail follow the plan; Luna never proposes segments. */
function tape(plan:Plan){
  const posts:any[]=[];let gets=0;
  const fetchImpl:typeof fetch=async(_url,init:any={})=>{
    if(init.method==='GET'){gets++;return Response.json({ready:true,purpose:'dialogue_turn',provider:'openai',model:modelId});}
    const body=JSON.parse(init.body);posts.push(body);
    if(body.questions){
      const q=body.questions;
      if(plan.brokenReferent&&q.human_referent)return Response.json({model:'typesafe/jev-1.14-20261014',id:'gen-synthetic',usage:{cost:plan.cost??0.001},answers:{}});
      const answers=Object.fromEntries(Object.entries(q).map(([name,question]:[string,any])=>{
        const choices=Object.keys(question.criteria);
        const chosen=q.action?plan.stage1[name]??(name.startsWith('candidate_')?'exclude':choices[0]):name==='candidate_set'?plan.set??choices[0]:
          name==='human_referent'?'none':name.endsWith('_antecedent')?'none':name.endsWith('_act')?'assert':choices[0];
        return [name,{type:'choice',choice:chosen,probabilities:Object.fromEntries(choices.map(v=>[v,v===chosen?0.8:0.2/(choices.length-1)])),confidence:1}];
      }));
      return Response.json({model:'typesafe/jev-1.14-20261014',id:'gen-synthetic',usage:{cost:plan.cost??0.001},answers});
    }
    const state=body.messages[1]?.content;let parsed:any;try{parsed=JSON.parse(state);}catch{}
    const final=String(body.messages.at(-1)?.content).includes('JSON')&&!parsed?.candidateText&&!parsed?.publicTurns;
    const text=parsed?.candidateText||parsed?.publicTurns?'[]':final?JSON.stringify(Object.fromEntries(model.anchors.map((a:any)=>[a.id,null]))):'なるほど。';
    return Response.json({model:modelId,choices:[{message:{content:text}}],usage:{prompt_tokens:3,completion_tokens:2}});
  };
  return{fetchImpl,posts,plan,gets:()=>gets,readKey:async()=>syntheticKey};
}
async function fixture(t:any,changes:any={},plan:Plan={stage1:{action:'accept',target:'none'}}){
  const dir=await mkdtemp(join(await realpath(tmpdir()),'jev-failure-record-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const cacheDirectory=join(dir,'cache');await mkdir(cacheDirectory,{mode:0o700});
  const warm=await createObservationCache({directory:cacheDirectory,modelId,onMiss:'observe',client:{async complete(){return{text:JSON.stringify(rawMemo),model:modelId};}}});
  const hit=await warm.get(own);
  const config={schemaVersion:'participant_jev_config_v1',lunaRequest:{timeoutMs:null,maxCompletionTokens:1000},timeouts,
    cacheDirectory,modelId,memoSha256:researchHash(hit.memo),seed,limits,...changes};
  const configFile=join(dir,'jev.json'),baseAssignmentFile=join(dir,'base.json');
  await writeFile(configFile,JSON.stringify(config),{mode:0o600});await writeFile(baseAssignmentFile,JSON.stringify(assignment),{mode:0o600});
  const upstream=tape(plan);
  return{dir,config,upstream,options:{configFile,baseAssignmentFile,clientConfig,fetchImpl:upstream.fetchImpl,readKey:upstream.readKey}};
}
async function makeTask(prepared:any,extra:any={}){
  let saved:any;
  const value={strategy:'repair-first',seed,referenceMemory:true,...extra};
  const task=await createNamingTaskV2({...value,...await prepared.taskOptions(value),runDir:null,createTrial:()=>trial,onPersist:async(r:any)=>{saved=structuredClone(r);}});
  return{task,record:()=>saved};
}
async function failedTurn(t:any,changes:any,stage1:Record<string,string>,strategy='repair-first'){
  const h=await fixture(t,changes,{stage1});const prepared=await prepareParticipantJev(h.options);
  const made=await makeTask(prepared,{strategy});
  made.task.message('どれのことか分からないです','turn-1');await made.task.whenIdle();
  return{h,prepared,made,record:made.record(),trace:made.record().jevTraces[0]};
}
const MULTIPLE_ONE={action:'confirm',target:'multiple',candidate_2:'include'};

test('A7/A8/B1/B4/B5 (v1): multiple_requires_candidates commits nothing, is refused once, and its closed evidence stays private',async t=>{
  const {made,record,trace,h}=await failedTurn(t,{},MULTIPLE_ONE);
  const state=made.task.getState();
  assert.equal(state.aiStatus,'error');
  assert.equal(trace.status,'error');assert.equal(trace.errorCode,'decision_failed');
  assert.deepEqual(trace.decisions,[]);assert.equal(trace.intervention,null);assert.equal(trace.executed,null);assert.equal(trace.finalAction,null);
  const evidence=trace.decisionFailure.evidence;
  assert.equal(evidence.schemaVersion,'jev_decision_failure_v1');assert.equal(evidence.questionLayout,'two_stage_v1');
  assert.equal(evidence.error,'inconsistent_decision');assert.equal(evidence.rejectionCode,'multiple_requires_candidates');
  assert.deepEqual(evidence.stages.map((s:any)=>[s.stage,s.status,s.rejectionCode]),[['action_target','error','multiple_requires_candidates']]);
  assert.equal(evidence.stages[0].choices.target,'multiple');assert.equal(evidence.stages[0].choices.candidate_2,'include');
  assert.equal(evidence.model,'typesafe/jev-1.14-20261014');assert.equal(evidence.costUsd,0.001);
  assert.deepEqual(record.jevLedger.refusals.map((r:any)=>[r.kind,r.reason]),[['jev_decision','inconsistent_decision']]);
  assert.equal(record.jevLedger.halted,false);assert.equal(record.queueState.errorCode,'ai_unavailable');
  assert.equal(record.queueState.privateState.judgments.length,0);assert.equal(record.queueState.privateState.graph.records.length,0);
  // B5: the same sends and accounting as before: one stage-one POST, no detail or generation.
  const sends=record.jevLedger.sends;
  assert.deepEqual(sends.filter((s:any)=>s.phase==='decision').map((s:any)=>s.status),['observed_response']);
  assert.equal(sends.filter((s:any)=>s.phase==='generation').length,0);
  assert.equal(h.upstream.posts.filter((b:any)=>b.questions?.name||b.questions?.feature).length,0);
  // B4: nothing of the record reaches public surfaces; after a retry that commits, the trial still completes.
  h.upstream.plan.stage1={action:'accept',target:'none'};await made.task.retry();await made.task.whenIdle();
  assert.equal(made.task.getState().aiStatus,'idle');
  assert.deepEqual(made.record().jevTraces.map((r:any)=>[r.status,Object.hasOwn(r,'decisionFailure')]),[['error',true],['committed',false]]);
  await made.task.submitHuman({names:Object.fromEntries(state.scene.shapes.map((s:any)=>[s.id,null]))});await made.task.submitAI();
  assert.equal(made.task.getState().status,'completed');
  const done=made.record();assert.deepEqual(done.jevTraces[0].decisionFailure,trace.decisionFailure);
  assert.doesNotThrow(()=>summarizeRecord(done,'a'.repeat(64),summarizeLatency(done)));
  const publicJson=JSON.stringify({state,final:made.task.getState(),events:done.events,review:participantReview(done)});
  for(const word of ['decisionFailure','rejectionCode','multiple_requires_candidates','inconsistent_decision','candidate_','jev_decision_failure','figure_'])assert.ok(!publicJson.includes(word),word);
});

for(const layout of ['two_stage_v1','two_stage_v2']) test(`B1 (${layout}): name_required also reaches the private failure trace`,async t=>{
  const {trace,record}=await failedTurn(t,layout==='two_stage_v1'?{}:{questionLayout:layout},{action:'propose_name',target:'figure_0'});
  assert.equal(trace.errorCode,'decision_failed');
  assert.equal(trace.decisionFailure.evidence.rejectionCode,'name_required');assert.equal(trace.decisionFailure.evidence.questionLayout,layout);
  assert.deepEqual(Object.keys(trace.decisionFailure.evidence.stages[0].choices).slice(0,2),['action','target']);
  assert.equal(record.jevLedger.sends.filter((s:any)=>s.phase==='decision').length,1);
});

test('A6 (v2): agree/propose_name with a multiple target is invalid_decision before any candidate-set POST, and is recorded',async t=>{
  const {trace,h}=await failedTurn(t,{questionLayout:'two_stage_v2'},{action:'propose_name',target:'multiple'});
  assert.equal(trace.errorCode,'invalid_decision');
  assert.equal(trace.decisionFailure.evidence.rejectionCode,'name_requires_single_target');
  assert.equal(h.upstream.posts.filter((b:any)=>b.questions?.candidate_set).length,0);
});

test('B2/C2-4: committed turns carry no failure record; a v2 multiple decision commits, records its layout and restores only under v2',async t=>{
  const v1=await fixture(t),v1Prepared=await prepareParticipantJev(v1.options),v1Made=await makeTask(v1Prepared,{strategy:'bypass-enabled'});
  v1Made.task.message('この形について話しましょう','ok-1');await v1Made.task.whenIdle();
  assert.equal(v1Made.record().jevTraces[0].status,'committed');assert.equal(Object.hasOwn(v1Made.record().jevTraces[0],'decisionFailure'),false);
  assert.equal(Object.hasOwn(v1Made.record().options,'questionLayout'),false);
  const v2=await fixture(t,{questionLayout:'two_stage_v2'},{stage1:{action:'defer',target:'multiple'},set:'figures_1_3'});
  const v2Prepared=await prepareParticipantJev(v2.options),v2Made=await makeTask(v2Prepared,{strategy:'bypass-enabled'});
  v2Made.task.message('二つのどちらかです','ok-2');await v2Made.task.whenIdle();
  const saved=v2Made.record(),committed=saved.jevTraces[0];
  assert.equal(committed.status,'committed',JSON.stringify(committed.errorCode));assert.equal(Object.hasOwn(committed,'decisionFailure'),false);
  assert.deepEqual(committed.decisions[0].target,{kind:'multiple',figureIds:[model.anchors[1].id,model.anchors[3].id]});
  assert.deepEqual(committed.decisions[0].evidence.stages.map((s:any)=>s.stage),['action_target','multiple_candidates']);
  assert.equal(saved.options.questionLayout,'two_stage_v2');assert.notEqual(saved.options.profileSha256,v1Made.record().options.profileSha256);
  const restored=await makeTask(v2Prepared,{strategy:'bypass-enabled',restore:saved});
  await restored.task.submitHuman({names:Object.fromEntries(restored.task.getState().scene.shapes.map((s:any)=>[s.id,null]))});await restored.task.submitAI();
  assert.equal(restored.task.getState().status,'completed');
  const completed=restored.record();
  assert.deepEqual(completed.queueState.privateState.judgments,saved.queueState.privateState.judgments);
  assert.equal(completed.options.questionLayout,'two_stage_v2');
  assert.doesNotThrow(()=>summarizeRecord(completed,'a'.repeat(64),summarizeLatency(completed)));
  const reviewJson=JSON.stringify({state:restored.task.getState(),review:participantReview(completed)});
  for(const word of ['questionLayout','two_stage','candidate_set','figures_1_3'])assert.ok(!reviewJson.includes(word),word);
  await assert.rejects(makeTask(v1Prepared,{strategy:'bypass-enabled',restore:saved}),{code:'invalid_options'});
  await assert.rejects(makeTask(v2Prepared,{strategy:'bypass-enabled',restore:v1Made.record()}),{code:'invalid_options'});
  const relabelled=structuredClone(saved);relabelled.queueState.privateState.judgments[0].jevTurn.decision.evidence.stages[1].choices.candidate_set='figures_1_4';
  await assert.rejects(makeTask(v2Prepared,{strategy:'bypass-enabled',restore:relabelled}),{code:'invalid_options'});
  const unnamed=structuredClone(saved);delete unnamed.options.questionLayout;
  await assert.rejects(makeTask(v2Prepared,{strategy:'bypass-enabled',restore:unnamed}),{code:'invalid_options'});
  // Explicit two_stage_v1 is the default profile; unknown layouts refuse startup.
  assert.equal(researchHash(validateParticipantJevConfig({...v1.config,questionLayout:'two_stage_v1'}).profile),researchHash(validateParticipantJevConfig(v1.config).profile));
  assert.throws(()=>validateParticipantJevConfig({...v1.config,questionLayout:'two_stage_v9'}),{code:'invalid_config'});
});

test('B3/F3: a failure record restores unchanged; misplaced, foreign-layout, contradictory or tampered records fail closed; older records still restore',async t=>{
  const {prepared,record}=await failedTurn(t,{},MULTIPLE_ONE);
  const restored=await makeTask(prepared,{restore:record});
  assert.deepEqual(restored.record().jevTraces[0].decisionFailure,record.jevTraces[0].decisionFailure);
  const variants:Array<[string,(r:any)=>void]>=[
    ['extra evidence key',r=>{r.jevTraces[0].decisionFailure.evidence.prompt='x';}],
    ['extra wrapper key',r=>{r.jevTraces[0].decisionFailure.raw='x';}],
    ['unknown label',r=>{r.jevTraces[0].decisionFailure.evidence.stages[0].choices.target='figure_9';}],
    ['score out of range',r=>{r.jevTraces[0].decisionFailure.evidence.stages[0].scores.action.accept=2;}],
    ['v1 record carrying a v2 stage',r=>{r.jevTraces[0].decisionFailure.evidence.stages[0].stage='multiple_candidates';}],
    ['foreign layout',r=>{r.jevTraces[0].decisionFailure.evidence.questionLayout='two_stage_v2';}],
    ['not a decision failure',r=>{r.jevTraces[0].errorCode='generation_failed';}],
    // F3: contradictions inside the record are detectable without the original response.
    ['total cost not the sum of the stages',r=>{r.jevTraces[0].decisionFailure.evidence.costUsd=0.12;}],
    ['always-offered action scores removed',r=>{r.jevTraces[0].decisionFailure.evidence.stages[0].scores.action={confirm:1};}],
    ['multiple_requires_candidates with target none',r=>{r.jevTraces[0].decisionFailure.evidence.stages[0].choices.target='none';}],
    ['rule raised with another outward code',r=>{const e=r.jevTraces[0].decisionFailure.evidence;e.error='invalid_decision';e.stages[0].error='invalid_decision';}],
    ['response id of no stage',r=>{r.jevTraces[0].decisionFailure.evidence.responseId='gen-not-a-stage';}],
    ['call budget not the stage-one budget',r=>{r.jevTraces[0].decisionFailure.evidence.inputBudget.stateChars+=1;}],
  ];
  for(const [name,mutate] of variants){
    const r=structuredClone(record);mutate(r);
    await assert.rejects(makeTask(prepared,{restore:r}),{code:'invalid_options'},name);
  }
  const older=structuredClone(record);delete older.jevTraces[0].decisionFailure;
  await makeTask(prepared,{restore:older});
  const unknown=structuredClone(record);unknown.jevTraces[0].decisionFailure={evidence:null};
  await makeTask(prepared,{restore:unknown});
});

test('B6: an unusable referent estimate is not a decision failure; the decision still commits',async t=>{
  const h=await fixture(t,{},{stage1:{action:'accept',target:'none'},brokenReferent:true});
  const made=await makeTask(await prepareParticipantJev(h.options),{strategy:'bypass-enabled'});
  made.task.message('この形について話しましょう','referent');await made.task.whenIdle();
  const trace=made.record().jevTraces[0];
  assert.equal(trace.humanReferent.status,'unknown');assert.equal(trace.status,'committed');
  assert.equal(Object.hasOwn(trace,'decisionFailure'),false);
});

test('A9/D3: both strategies fail identically before acceptance and send identical requests',async t=>{
  const h=await fixture(t,{},{stage1:MULTIPLE_ONE}),prepared=await prepareParticipantJev(h.options);
  const runs=[];
  for(const strategy of ['repair-first','bypass-enabled']){
    const made=await makeTask(prepared,{strategy});
    made.task.message('どれのことか分からないです','paired');await made.task.whenIdle();
    runs.push(made.record());
  }
  const same=(r:any)=>{const e=r.jevTraces[0].decisionFailure.evidence;
    return{sends:r.jevLedger.sends.map((s:any)=>[s.provider,s.phase,s.boundary,s.requestSha256]).sort(),
      evidence:{...e,latencyMs:0,stages:e.stages.map((s:any)=>({...s,latencyMs:0}))}};};
  assert.deepEqual(same(runs[0]),same(runs[1]));
  for(const r of runs){assert.equal(r.jevTraces[0].intervention,null);assert.equal(r.jevTraces[0].errorCode,'decision_failed');}
  for(const body of h.upstream.posts)for(const label of ['repair-first','bypass-enabled'])assert.ok(!JSON.stringify(body).includes(label));
});

test('budget: an explicit research cap (up to 1.00 USD) reaches RunBudget and every Jev adapter; another cap cannot restore the record',async t=>{
  const base=(await fixture(t)).config;
  for(const jevUsd of [1.000001,0,-0.01,null,Number.NaN,Infinity,'0.1'])assert.throws(()=>validateParticipantJevConfig({...base,limits:{...limits,jevUsd}}),{code:'invalid_config'},String(jevUsd));
  // Unspecified: the research config has no implicit Jev budget; a missing jevUsd refuses startup.
  const {jevUsd:_unspecified,...withoutJevUsd}=limits;
  assert.throws(()=>validateParticipantJevConfig({...base,limits:withoutJevUsd}),{code:'invalid_config'});
  assert.equal(validateParticipantJevConfig({...base,limits:{...limits,jevUsd:0.15}}).config.limits.jevUsd,0.15);
  assert.equal(validateParticipantJevConfig({...base,limits:{...limits,jevUsd:1}}).config.limits.jevUsd,1);
  // Two 0.04 USD Jev calls in one turn exceed 0.05 but fit 0.15, in the decision client and in the ledger alike.
  const low=await fixture(t,{},{stage1:{action:'accept',target:'none'},cost:0.04});
  const lowMade=await makeTask(await prepareParticipantJev(low.options),{strategy:'bypass-enabled'});
  lowMade.task.message('この形について話しましょう','low');await lowMade.task.whenIdle();
  assert.equal(lowMade.task.getState().aiStatus,'error');
  const high=await fixture(t,{limits:{...limits,jevUsd:0.15}},{stage1:{action:'accept',target:'none'},cost:0.04});
  const highPrepared=await prepareParticipantJev(high.options),highMade=await makeTask(highPrepared,{strategy:'bypass-enabled'});
  highMade.task.message('この形について話しましょう','high');await highMade.task.whenIdle();
  const record=highMade.record();
  assert.equal(highMade.task.getState().aiStatus,'idle',JSON.stringify(record.jevLedger.refusals));
  assert.equal(record.jevLedger.limits.jevUsd,0.15);assert.equal(record.jevLedger.halted,false);
  assert.ok(record.jevLedger.observedJevUsd>0.05&&record.jevLedger.observedJevUsd<0.15);
  await assert.rejects(makeTask(await prepareParticipantJev(low.options),{strategy:'bypass-enabled',restore:record}),{code:'invalid_options'});
});

// Internal labels and response values that only the private failure record holds.
const PRIVATE_MARKERS=['decisionFailure','jev_decision_failure','rejectionCode','multiple_requires_candidates','inconsistent_decision',
  'action_target','candidate_','questionLayout','two_stage','gen-synthetic','typesafe/jev'];

test('B4: loopback state, outward errors, retry, final, questionnaire, review, record list and logs never carry the failure record',async t=>{
  const logged:string[]=[];
  for(const method of ['log','info','warn','error','debug'] as const)t.mock.method(console,method,(...args:unknown[])=>{logged.push(args.map(a=>a instanceof Error?a.stack+String((a as any).code):typeof a==='string'?a:JSON.stringify(a)).join(' '));});
  const h=await fixture(t,{},{stage1:MULTIPLE_ONE}),prepared=await prepareParticipantJev(h.options),root=join(h.dir,'owners');await mkdir(root,{mode:0o700});
  let current:any,lastRecord:any;
  const server=await startNamingServer({port:0,client:{},baseAssignmentFile:h.options.baseAssignmentFile,baseStoreRoot:root,
    createTaskV2:async(value:any)=>{
      const onPersist=value.onPersist;
      current=await createNamingTaskV2({...value,...await prepared.taskOptions(value),onPersist:async(r:any)=>{lastRecord=structuredClone(r);await onPersist(r);}});
      return current;
    }} as any);
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const cookie=(await fetch(url)).headers.get('set-cookie')!.split(';')[0];
  const seen:string[]=[];
  const request=async(path:string,body?:unknown)=>{const r=await fetch(url+path,{headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},
    ...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});const text=await r.text();seen.push(text);return{status:r.status,json:JSON.parse(text)};};
  const start=await request('/api/start',{version:2});assert.equal(start.status,200);
  const id=start.json.trial.sessionId;
  await request('/api/message',{text:'どれのことか分からないです',clientId:'b4-failure',expectedRecordId:id});await current.whenIdle();
  assert.equal(lastRecord.jevTraces[0].decisionFailure.evidence.rejectionCode,'multiple_requires_candidates','the private record holds the evidence');
  const failed=await request('/api/state');assert.equal(failed.json.trial.aiStatus,'error');
  const blocked=await request('/api/names',{confirm:true,expectedRecordId:id,names:Object.fromEntries(failed.json.trial.scene.shapes.map((s:any)=>[s.id,null]))});
  assert.deepEqual([blocked.status,blocked.json],[409,{error:'ai_retry_required'}]);
  h.upstream.plan.stage1={action:'accept',target:'none'};
  await request('/api/retry',{expectedRecordId:id});await current.whenIdle();
  const retried=await request('/api/state');assert.equal(retried.json.trial.aiStatus,'idle');
  const submitted=await request('/api/names',{confirm:true,expectedRecordId:id,names:Object.fromEntries(retried.json.trial.scene.shapes.map((s:any)=>[s.id,null]))});
  assert.equal(submitted.json.trial.status,'completed');
  assert.equal((await request('/api/records/'+id+'/questionnaire')).status,200);
  assert.equal((await request('/api/records/'+id+'/questionnaire',{submit:true,answers:Object.fromEntries(QUESTIONNAIRE_FORM.items.map(item=>[item.id,4])),comment:''})).status,200);
  assert.equal((await request('/api/records/'+id+'/review')).status,200);
  assert.equal((await request('/api/records')).status,200);
  assert.ok(Object.hasOwn(lastRecord.jevTraces[0],'decisionFailure'));
  const surfaces=seen.join('\n')+'\n'+logged.join('\n');
  for(const marker of PRIVATE_MARKERS)assert.ok(!surfaces.includes(marker),marker);
});

test('D (v2): paired strategies share stage one and the candidate set; a veto keeps the set, ranks by stage-one scores and restores',async t=>{
  const h=await fixture(t,{questionLayout:'two_stage_v2'},{stage1:{action:'defer',target:'multiple'},set:'figures_1_3'});
  const prepared=await prepareParticipantJev(h.options),runs:any[]=[];
  for(const strategy of ['repair-first','bypass-enabled']){
    const made=await makeTask(prepared,{strategy});
    made.task.message('二つのどちらかです','paired-v2');await made.task.whenIdle();
    assert.equal(made.task.getState().aiStatus,'idle',JSON.stringify(made.record().jevLedger.refusals));
    const restored=await makeTask(prepared,{strategy,restore:made.record()});
    assert.deepEqual(restored.record().queueState.privateState.judgments,made.record().queueState.privateState.judgments);
    runs.push(made.record());
  }
  const common=(r:any)=>r.jevLedger.sends.filter((s:any)=>s.boundary==='common').map((s:any)=>[s.provider,s.phase,s.requestSha256]);
  assert.deepEqual(common(runs[0]),common(runs[1]));
  const [veto,adopt]=runs.map((r:any)=>r.queueState.privateState.judgments[0].jevTurn);
  // Wall-clock latency differs between two runs; every other value of the original decision is the same.
  const timeless=(d:any)=>({...d,evidence:{...d.evidence,latencyMs:0,stages:d.evidence.stages.map((e:any)=>({...e,latencyMs:0}))}});
  assert.deepEqual(timeless(veto.decision),timeless(adopt.decision),'the same original decision before intervention');
  assert.deepEqual(veto.decision.evidence.stages.map((s:any)=>s.choices),[{action:'defer',target:'multiple'},{candidate_set:'figures_1_3'}]);
  const set=[model.anchors[1].id,model.anchors[3].id];
  assert.equal(veto.intervention.disposition,'rejected');assert.equal(adopt.intervention.disposition,'adopted');
  assert.deepEqual(veto.executed.target,{kind:'multiple',figureIds:set});assert.deepEqual(adopt.executed.target,{kind:'multiple',figureIds:set});
  for(const r of veto.intervention.rerank.ranking)assert.equal(r.score,veto.decision.evidence.stages[0].scores.action[r.action]);
  // The added stage asks only the set and carries no condition or partner material.
  const setBodies=h.upstream.posts.filter((b:any)=>b.questions?.candidate_set);
  assert.equal(setBodies.length,2);assert.deepEqual(Object.keys(setBodies[0].questions),['candidate_set']);
  const partner=participantView(trial).shapes.map((s:any)=>s.id).filter((id:string)=>!model.anchors.some((a:any)=>a.id===id));
  assert.ok(partner.length>0,'the partner view uses its own figure IDs');
  for(const body of setBodies){const text=JSON.stringify(body);
    for(const word of ['repair-first','bypass-enabled','veto','strategy','seed',...partner])assert.ok(!text.includes(word),word);}
  // F4: a committed v2 set stage restores only as the single candidate_set question over exactly the 57 subsets.
  const tampered:Array<[string,(stage:any)=>void]>=[
    ['scores cut to the chosen subset',stage=>{stage.scores.candidate_set={figures_1_3:1};}],
    ['an extra question beside candidate_set',stage=>{stage.choices.extra='include';stage.scores.extra={include:1,exclude:0};}],
    ['a label outside the 57 subsets',stage=>{stage.scores.candidate_set.figures_9=0;}],
  ];
  for(const [name,mutate] of tampered){
    const r=structuredClone(runs[0]);mutate(r.queueState.privateState.judgments[0].jevTurn.decision.evidence.stages[1]);
    await assert.rejects(makeTask(prepared,{strategy:'repair-first',restore:r}),{code:'invalid_options'},name);
  }
});

test('§5 (v2): the set-stage POST is reserved and charged like v1 follow-up stages; at the post limit it is never sent',async t=>{
  const h=await fixture(t,{questionLayout:'two_stage_v2'},{stage1:{action:'defer',target:'multiple'},set:'figures_1_3'});
  const made=await makeTask(await prepareParticipantJev(h.options),{strategy:'bypass-enabled'});
  made.task.message('二つのどちらかです','ledger');await made.task.whenIdle();
  const ledger=made.record().jevLedger,jev=ledger.sends.filter((s:any)=>s.provider==='jev');
  assert.deepEqual(jev.slice(0,3).map((s:any)=>[s.phase,s.status]),[['human_referent','observed_response'],['decision','observed_response'],['jev','observed_response']]);
  assert.equal(ledger.jevPosts,jev.length);
  assert.ok(Math.abs(ledger.observedJevUsd-jev.length*0.001)<1e-12,String(ledger.observedJevUsd));
  // jevPosts=2: the referent estimate and stage one fit; the set stage is refused before any upstream POST.
  const capped=await fixture(t,{questionLayout:'two_stage_v2',limits:{...limits,jevPosts:2}},{stage1:{action:'defer',target:'multiple'},set:'figures_1_3'});
  const prepared=await prepareParticipantJev(capped.options),stopped=await makeTask(prepared,{strategy:'bypass-enabled'});
  stopped.task.message('二つのどちらかです','capped');await stopped.task.whenIdle();
  const record=stopped.record(),trace=record.jevTraces[0];
  assert.equal(capped.upstream.posts.filter((b:any)=>b.questions?.candidate_set).length,0);
  assert.equal(record.jevLedger.halted,true);assert.equal(record.jevLedger.haltReason,'jev_http_budget');
  assert.equal(trace.errorCode,'decision_failed');
  const stages=trace.decisionFailure.evidence.stages;
  assert.deepEqual(stages.map((s:any)=>[s.stage,s.status]),[['action_target','ok'],['multiple_candidates','error']]);
  // A stage without a response stays unknown; it is never filled with zero or success.
  assert.deepEqual([stages[1].model,stages[1].responseId,stages[1].costUsd,stages[1].choices,stages[1].scores],[null,null,null,{},{}]);
  const restored=await makeTask(prepared,{strategy:'bypass-enabled',restore:record});
  assert.deepEqual(restored.record().jevTraces[0].decisionFailure,trace.decisionFailure);
  const posts=capped.upstream.posts.length;
  await restored.task.retry().catch(()=>{});await restored.task.whenIdle();
  assert.equal(capped.upstream.posts.length,posts,'an exhausted budget sends nothing after restore');
});
