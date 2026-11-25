// P1 frozen 309d49f3 + 773704e0. Synthetic clients only; no live API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import { createTrialV2, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { createMockJevDecisionClient } from '../dialogue-model/runtime/decision/mocks.ts';
import { createDialogueV2 } from '../dialogue-model/runtime/v2/dialogue-v2.mjs';
import { RunBudget } from '../dialogue-model/runtime/diagnostics/parity-live/audit.ts';

const seed = 909;
const trial = createTrialV2({seed}), own = modelView(trial);
const memo = {observedAt:'2026-10-20T00:00:00.000Z',figures:own.anchors.map((a:any)=>({id:a.id,region:a.bbox,
  holistic:[],analytic:{shapes:['三角'],composition:'二つの部分が接する',relations:[]},unknowns:[],reobservations:[]}))};
const timeouts = {observationMs:20000,localMs:20000,decisionMs:20000,lunaAttemptMs:80000,generationMs:40000,trialMs:600000};
const profile = researchTrialProfileV3({timeoutMs:null,maxCompletionTokens:1000},timeouts);
const limits = {lunaCalls:100,lunaPosts:100,lunaTokens:100000,jevPosts:100,jevUsd:10};
function setup(extra:any={}) {
  let observations=0, calls=0, saved:any;
  const client={async complete(_m:any,o:any={}){calls++;return{text:o.phase==='local_extraction'||o.phase==='ai_extraction'?'[]':o.phase==='final_submission'?JSON.stringify(Object.fromEntries(own.anchors.map((a:any)=>[a.id,null]))):'なるほど。',model:'synthetic-luna'};}};
  const jevResearch={profile,observer:{async observeAll(){observations++;return structuredClone(memo);},async reobserve(){throw Error('unused');}},
    jevDecision:createMockJevDecisionClient(()=>({action:'accept',target:{kind:'none'},name:null,feature:null,observe:null})),
    localGrounding:{classifier:{async classify(){return[];}},timeoutMs:profile.timeouts.localMs,aiPublicClaims:true},ledger:new RunBudget(limits)};
  const options={client,strategy:'repair-first',seed,referenceMemory:true,runDir:null,createTrial:()=>trial,
    judge:{async judge(){return{action:'accept',targetSlot:null,candidateName:null,discriminatingFeature:null,note:null};}},
    jevResearch,onPersist:async(r:any)=>{saved=structuredClone(r);},...extra};
  return {options,jevResearch,counts:()=>({observations,calls}),record:()=>saved};
}

test('J-D1/D2: Jev initializes its memo before queue creation, without a completion',async()=>{
  const h=setup(),task=await createNamingTaskV2(h.options);
  assert.equal(task.researcherView().privateState.schemaVersion,'jev_private_state_v2');
  assert.deepEqual(task.researcherView().privateState.observationMemo,memo);
  assert.deepEqual(h.counts(),{observations:1,calls:0});
  assert.equal(h.record().options.jevResearch,true);
});

test('J-R1/R3: restored Jev needs its explicit matching config; old records stay old',async()=>{
  const h=setup(),first=await createNamingTaskV2(h.options),saved=h.record();
  assert.ok(saved.options.jevResearch);
  await assert.rejects(createNamingTaskV2({...h.options,jevResearch:null,restore:saved}),{code:'invalid_options'});
  const restored=await createNamingTaskV2({...h.options,restore:saved});
  assert.deepEqual(restored.researcherView().privateState,first.researcherView().privateState);
  assert.equal(h.counts().observations,1);
});

test('J-V1: Jev rejects disabled memory and legacy decision paths before calls',async()=>{
  for(const extra of [{referenceMemory:false},{activeDecision:{purpose:'decision_jev',client:{chooseAction(){}}}},
    {localGrounding:{}},{groundingShadow:{}},{decisionShadowClient:{chooseAction(){}}}]){
    const h=setup(extra);await assert.rejects(createNamingTaskV2(h.options),{code:'invalid_options'});
    assert.deepEqual(h.counts(),{observations:0,calls:0});
  }
});

test('J-V1/R1/R3: malformed profile, unknown restore marker and changed profile fail before observation',async()=>{
  for(const profileChange of [{...profile,id:'research_trial_profile_v2'},
    {...profile,interventionPolicy:{...profile.interventionPolicy,version:'unknown'}},
    {...profile,maxReobservations:3}]){
    const h=setup();h.options.jevResearch={...h.jevResearch,profile:profileChange} as any;
    await assert.rejects(createNamingTaskV2(h.options),{code:'invalid_options'});
    assert.deepEqual(h.counts(),{observations:0,calls:0});
  }
  const h=setup();await createNamingTaskV2(h.options);const saved=h.record();
  for(const restored of [{...saved,options:{...saved.options,jevResearch:'unknown'}},
    {...saved,options:{...saved.options,profileSha256:'0'.repeat(64)}},
    {...saved,queueState:{...saved.queueState,privateState:{...saved.queueState.privateState,schemaVersion:'unknown'}}}])
    await assert.rejects(createNamingTaskV2({...h.options,restore:restored}),{code:'invalid_options'});
  assert.deepEqual(h.counts(),{observations:1,calls:0});
});

test('J-R3/D0: an old record restored on a Jev server keeps legacy options and no Jev initialization',async()=>{
  const h=setup();await createNamingTaskV2({...h.options,jevResearch:null});const saved=h.record();
  await createNamingTaskV2({...h.options,restore:saved});
  assert.deepEqual(h.record().options,saved.options);assert.deepEqual(h.counts(),{observations:0,calls:0});
  await assert.rejects(createNamingTaskV2({...h.options,restore:{...saved,options:{...saved.options,profileSha256:'0'.repeat(64)}}}),{code:'invalid_options'});
});

test('J-T1: overtaken generation is not committed or installed in durable Jev state',async()=>{
  let started!:()=>void,finish!:()=>void,generations=0;
  const ready=new Promise<void>(resolve=>{started=resolve;});
  const h=setup({client:{async complete(_messages:any,options:any){
    if(['local_extraction','ai_extraction'].includes(options.phase))return{text:'[]'};
    if(++generations===1){started();return new Promise(resolve=>{finish=()=>resolve({text:'古い応答'});});}
    return{text:'新しい応答'};
  }}});
  const task=await createNamingTaskV2(h.options);task.message('最初の説明','first');await ready;
  task.message('説明を補います','second');finish();await task.whenIdle();
  assert.equal(task.getState().aiStatus,'idle');
  assert.ok(!task.getState().events.some((e:any)=>e.text==='古い応答'));
  assert.equal(h.record().jevTraces.filter((r:any)=>r.status==='committed').length,1);
  assert.ok(h.record().jevTraces.some((r:any)=>r.status!=='committed'));
  assert.equal(h.record().queueState.privateState.judgments.length,1);
});

test('J-T2: settlement is attempted once after close; its failure does not block scoring',async t=>{
  const h=setup(),task=await createNamingTaskV2(h.options);task.message('形を確認します','one');await task.whenIdle();
  assert.equal(task.getState().aiStatus,'idle');
  const failing=t.mock.method(crypto.subtle,'digest',async()=>{throw Error('synthetic-settlement-failure');});
  await task.submitHuman({names:Object.fromEntries(task.getState().scene.shapes.map((s:any)=>[s.id,null]))});
  assert.deepEqual(h.record().aiPublicSettlement,{status:'error',code:'settlement_failed'});
  assert.equal(failing.mock.callCount(),1);failing.mock.restore();
  await task.persistNow();await task.submitAI();
  assert.equal(task.getState().status,'completed');
});

test('J-R2: frozen synthetic private state is reusable across labels without changing BASE bindings',async()=>{
  const h=setup(),task=await createNamingTaskV2(h.options),frozen=task.researcherView().privateState;
  const original=structuredClone(frozen);
  for(const strategy of ['repair-first','bypass-enabled']){
    const dialogue=createDialogueV2({client:h.options.client,strategy,referenceMemory:true,decisionMode:'jev',
      image:{mimeType:own.mimeType,base64:own.png.toString('base64')},anchors:own.anchors,
      observer:h.jevResearch.observer,jevDecision:h.jevResearch.jevDecision,localGrounding:h.jevResearch.localGrounding,
      interventionPolicy:profile.interventionPolicy,decisionTimeoutMs:profile.timeouts.decisionMs});
    const result=await dialogue.runAiTurn({events:[{id:'public-1',seq:1,speaker:'human',text:'この形を話題にします'}],privateState:frozen,lastEventId:'public-1'});
    assert.equal(result.privateState.schemaVersion,'jev_private_state_v2');
    assert.deepEqual(frozen,original);
  }
  assert.equal(h.counts().observations,1);
});

test('J-F1: a generation failure requires retry; explicit retry can then complete normally',async()=>{
  let generation=0;
  const h=setup({client:{async complete(_messages:any,options:any){
    if(['local_extraction','ai_extraction'].includes(options.phase))return{text:'[]'};
    if(options.phase==='generation'&&++generation===1)throw Error('synthetic-failure-with-private-body');
    return{text:'理解しました。'};
  }}});
  const task=await createNamingTaskV2(h.options);task.message('この形を確認します','retry');await task.whenIdle();
  assert.equal(task.getState().aiStatus,'error');
  assert.ok(!JSON.stringify(task.getState()).includes('synthetic-failure-with-private-body'));
  await task.retry();assert.equal(task.getState().aiStatus,'idle');
  assert.deepEqual(h.record().jevTraces.map((r:any)=>r.status),['error','committed']);
});
