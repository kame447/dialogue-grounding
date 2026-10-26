import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {runParityLive} from '../../../dialogue-model/runtime/diagnostics/parity-live/live.ts';
import {createProfileDialogue} from '../../../dialogue-model/runtime/diagnostics/parity-live/replay.ts';
import {fairness, wireValidation} from '../../../dialogue-model/runtime/diagnostics/parity-verify/fairness.ts';
import {verifyRecords} from '../../../dialogue-model/runtime/diagnostics/parity-verify/index.ts';
import {collectModelObservations} from '../../../dialogue-model/runtime/diagnostics/parity-verify/model-observations.ts';
import {aggregateClassifiedModelObservations} from '../../../dialogue-model/runtime/model-observations.ts';
import type {Dependencies} from '../../../dialogue-model/runtime/diagnostics/parity-live/live.ts';
const base=():any=>JSON.parse(readFileSync(new URL('./RECORDS-ACCEPTED-SETUP.json',import.meta.url),'utf8'));
const alias='typesafe/jev-1.14',snapshot=alias+'-20261014';
const find=(r:any,id:string)=>verifyRecords(r).checks.find(c=>c.id===id);
test('explicit Jev identity uses fixed relation; Luna remains exact',()=>{
 const r=base();assert.equal(fairness(r).find(c=>c.id==='identity.model.0')?.status,'pass');
 r.trials[0].calls[0].provider='luna';assert.equal(fairness(r).find(c=>c.id==='identity.model.0')?.status,'mismatch');
});
test('legacy identity exact branch and output remain unchanged',()=>{const r=base();r.run.profile={id:'research_trial_profile_v1'};assert.equal(fairness(r).find(c=>c.id==='identity.model.0')?.status,'mismatch');assert.equal(find(r,'identity.model_contract'),undefined)});
test('three global identity checks are independent of primary timeout',()=>{const r=base();for(const id of ['identity.model_contract','identity.model_observations','identity.model_technical'])assert.equal(find(r,id)?.status,'pass');assert.equal(r.summary.failure,'trial_timeout');});
test('global identity unknown retains accepted subset gaps',()=>{const r=base();r.summary.runOrder.push({scriptId:'SYNTH1',label:'bypass-enabled'});r.summary.skipped=[];assert.equal(find(r,'identity.model_technical')?.status,'not_reached')});
test('invalid present reference is fixed mismatch, never fallback',()=>{const r=base();r.run.profile.modelContract=null;assert.equal(find(r,'identity.model_contract')?.reason,'model_contract_invalid');assert.equal(find(r,'identity.model_contract')?.status,'mismatch')});
test('createProfileDialogue rejects reference before reading options',()=>{const r=base();delete r.run.profile.modelContract;let reads=0;const options=new Proxy({},{get(){reads++;throw Error('canary')}});assert.throws(()=>createProfileDialogue(r.run.profile,options as any),/model_contract_missing/);assert.equal(reads,0)});
test('raw request alias validated separately; exact raw/call name binding retained',()=>{
 const r=base(),q={type:'choice',criteria:{yes:'test'}},a={type:'choice',choice:'yes',probabilities:{yes:1}};
 const request={provider:'jev',payload:{model:alias,questions:{q}}};
 r.trials[0].calls[0].turn=1;r.trials[0].replay=[{tape:{events:[{seq:1}],jev:[{model:snapshot,answers:{q:a},usage:{cost:0}}]}}];
 r.evidence.pairedReplay=[{trialOrder:0,turn:1,left:{requests:[request]}}];
 assert.equal(wireValidation(r).find(c=>c.id==='validation.jev.0.1.0.0')?.status,'pass');
 request.payload.model='typesafe/other';assert.equal(wireValidation(r).find(c=>c.id==='validation.jev.0.1.0.0')?.status,'mismatch');
 request.payload.model=alias;r.trials[0].calls[0].model=alias;assert.equal(wireValidation(r).find(c=>c.id==='validation.jev.0.1.0.0')?.status,'mismatch');
});
async function run(t:any,model:unknown,extra:any={}){
 const root=await mkdtemp(join(tmpdir(),'s2-online-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const r=base();let sends=0;
 const deps:Dependencies={execution:'mock',createLunaClient(){return {
  async getModelPolicy(){return {purpose:'dialogue_turn',ready:true,model:'synthetic-luna',provider:'openai'}},
  async complete(messages:any[],options:any){let text='A shape is visible.';if(options.phase==='observation_initial'){const input=JSON.parse(messages[1].content);text=JSON.stringify({figures:input.ownAnchors.map((a:any)=>({id:a.id,holistic:[],analytic:{shapes:['shape'],composition:'one part',relations:[]},unknowns:[]}))})}else if(['local_extraction','ai_extraction'].includes(options.phase))text='[]';return {text,model:'synthetic-luna',usage:{inputTokens:1,outputTokens:1}}}
 }},createJevTransport(){return {readKey:async()=>'sk-or-SYNTHETIC-model-integration-key-0000',async fetchImpl(_url,init){sends++;const p=JSON.parse(String(init.body));const answers=Object.fromEntries(Object.entries(p.questions).map(([name,q]:[string,any])=>{const values=Object.keys(q.criteria),choice=name==='human_referent'||name==='target'?'none':name==='action'?'accept':values[0];return [name,{type:'choice',choice,probabilities:Object.fromEntries(values.map(v=>[v,v===choice?1:0])),confidence:1}]}));return Response.json({model,id:'synthetic-response',answers,usage:extra.unknownCost?{}:{cost:0}})}}}};
 const manifest={...r.run.manifest,trials:[r.run.manifest.trials[0]],...extra.manifest};
 const result=await runParityLive({outputDir:join(root,'runs'),cacheDir:join(root,'cache'),manifest,scripts:[{id:'SYNTH0',humanTurns:['Describe the shape.']}]},deps);
 assert.ok(result.trials.length,JSON.stringify(result.summary.failure));
 return {result,sends};
}
test('online fixed unknown version stops with sanitized receipt and usage',async t=>{const {result,sends}=await run(t,alias+'-20990101');const c=result.trials[0].calls.find(c=>c.provider==='jev');assert.ok(sends>0);assert.equal(c?.error,'model_unknown_version');assert.equal(c?.status,'error');assert.equal(c?.model,null);assert.equal(c?.costUsd,0);assert.equal(result.trials[0].failure,'model_unknown_version');});
for(const [model,error] of [[null,'model_invalid'],['another/model','model_not_allowed']] as const)test('online fixed '+error,async t=>{const {result}=await run(t,model);assert.equal(result.trials[0].calls.find(c=>c.provider==='jev')?.error,error)});
test('online allowed snapshot is preserved exactly',async t=>{const {result}=await run(t,snapshot);const calls=result.trials[0].calls.filter(c=>c.provider==='jev');assert.ok(calls.length>0);assert.ok(calls.every(c=>c.model===snapshot&&c.status==='ok'))});
test('unknown cost keeps primary precedence over returned-name rejection',async t=>{const {result}=await run(t,alias+'-20990101',{unknownCost:true});assert.notEqual(result.trials[0].failure,'model_unknown_version');assert.ok(result.trials[0].failure)});
// New scoped series, separate from the old frozen suites. Document item3 is
// replaced by 727be2e2; actual gates and internal projection are distinct surfaces.
let scoped:any=null;try{scoped=await import(pathToFileURL(join(process.env.S2_SOURCE_ROOT!,'dialogue-model/runtime/diagnostics/parity-verify/model-checks.ts')).href)}catch(e:any){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e}
const component=(r:any,n=0)=>{assert.ok(scoped,'internal identity component absent');return scoped.scopedModelCheck(r,collectModelObservations(r),n)};
test('scope accepted target, unrelated main timeout cannot migrate primary',()=>{const r=base();const c=component(r);assert.equal(c.id,'smoke.model_technical.0');assert.equal(c.status,'pass');assert.equal(c.reason,'all_observed_accepted')});
test('scope missing other started owner is excluded only with proven mapping',()=>{const r=base();r.summary.runOrder.push({scriptId:'SYNTH1',label:'bypass-enabled'});r.summary.skipped=[];assert.equal(component(r).status,'pass');assert.equal(find(r,'identity.model_technical')?.status,'not_reached')});
test('scope03-1a actual absent target has no invented report component',()=>{const r=base();r.trials=[];assert.equal(find(r,'smoke.model_technical.0'),undefined);assert.equal(find(r,'identity.model_technical')?.status,'not_reached')});
test('scope03-1b internal missing binding has fixed unresolved reason',()=>{const r=base();r.trials=[];assert.equal(component(r).status,'not_reached');assert.equal(component(r).reason,'model_scope_unresolved')});
test('scope03-1c existing bound target missing response remains evidence_missing',()=>{const r=base();r.evidence.events.splice(2,1);r.evidence.events.forEach((e:any,i:number)=>e.seq=i+1);assert.equal(component(r).status,'not_reached');assert.equal(component(r).reason,'evidence_missing')});
test('scope keeps shared seq gap outside local response',()=>{const r=base();r.evidence.events[4].seq=7;assert.notEqual(component(r).status,'pass')});
test('scope target late-only response cannot upgrade missing',()=>{const r=base();const response=r.evidence.events.splice(2,1)[0];r.evidence.events.push(response);r.evidence.events.forEach((e:any,i:number)=>e.seq=i+1);assert.equal(component(r).status,'not_reached')});
test('scope invalid shared profile takes precedence',()=>{const r=base();r.run.profile.modelContract=null;assert.equal(component(r).reason,'model_contract_invalid');assert.equal(component(r).status,'mismatch')});
test('scope accepted identity cannot repair existing G2 or packet failure',()=>{const r=base();assert.equal(component(r).status,'pass');assert.notEqual(find(r,'gate.G2')?.status,'pass');assert.notEqual(find(r,'gate.G3')?.status,'pass')});
const duplicateTrial=(r:any,id=2,send=2)=>{
 const t=structuredClone(r.trials[0]);t.order=1;t.plannedIndex=1;t.stage='main';t.scriptId='SYNTH1';t.label='bypass-enabled';t.calls[0].id=id;t.calls[0].sendIds=[send];
 r.trials.push(t);r.summary.runOrder.push({scriptId:'SYNTH1',label:'bypass-enabled'});r.summary.skipped=[];
 const es=r.evidence.events.slice(0,3).map((e:any)=>({...e,trialOrder:1,label:t.label,instanceId:'second',callId:id,sendId:send}));
 // Accepted both before the run-wide close; no wall-clock oracle.
 r.evidence.events.splice(3,0,...es);r.evidence.events.forEach((e:any,i:number)=>e.seq=i+1);
 return t;
};
test('scope cross-owner ID conflict retains both sides and global conflict',()=>{const r=base();duplicateTrial(r,1,1);assert.equal(component(r).reason,'input_inconsistent');assert.equal(find(r,'identity.model_technical')?.reason,'input_inconsistent')});
test('scope wholly other-trial name conflict stays global but not target',()=>{const r=base(),t=duplicateTrial(r);t.calls[0].model=alias;assert.equal(find(r,'identity.model_technical')?.reason,'input_inconsistent');assert.equal(component(r).status,'pass')});
test('scope unknown owner issue never becomes other-owned pass',()=>{const r=base();const o:any=collectModelObservations(r);const v=structuredClone(o);v.missing.push({callId:null,sendId:null,responseSeq:null,reason:'source_missing',rejectionCode:null,sources:[]});assert.equal(scoped.scopedModelCheck(r,v,0).reason,'evidence_missing')});
test('scope preserves duplicate updates without main/late overlap',()=>{const r=base();r.evidence.events.push({...r.evidence.events[2],seq:6});assert.equal(component(r).status,'pass');assert.equal(component(r).detail.observedCount,1)});
test('collector missing logical-call stop identity is unresolved, not proven owner conflict',()=>{const r=base();r.evidence.events.splice(2,0,{type:'stop',provider:'jev',instanceId:r.evidence.events[0].instanceId,scope:'instance',scopeDetail:'logical_call',reason:'phase_aborted',inFlight:[]});r.evidence.events.forEach((e:any,i:number)=>e.seq=i+1);const o=collectModelObservations(r);assert.equal(o.inconsistent.length,0);assert.ok(o.missing.some(x=>x.reason==='ordering_missing'))});
test('collector orphan response without actual send cannot disappear',()=>{const r=base();r.evidence.events.push({...r.evidence.events[2],seq:6,callId:91,sendId:91});const o=collectModelObservations(r);assert.ok(o.inconsistent.length||o.missing.length)});
test('classified conflict summary is independent of input array order',()=>{const o:any=structuredClone(collectModelObservations(base()));o.observations.push({...o.observations[0],returnedId:alias,version:null});const a=aggregateClassifiedModelObservations(o);o.observations.reverse();assert.deepEqual(aggregateClassifiedModelObservations(o),a)});
test('exact same-source call copies collapse with every source retained',()=>{const r=base();r.trials[0].calls.push(structuredClone(r.trials[0].calls[0]));const o=collectModelObservations(r);assert.equal(o.inconsistent.length,0);assert.equal(o.observations.length,1);assert.ok(o.observations[0].sources.some(s=>s.pointer==='/calls/1'))});
test('duplicate seq positions stay shared contradictions even across owner slots',()=>{const r=base();duplicateTrial(r);r.evidence.events[4].seq=1;assert.equal(component(r).reason,'input_inconsistent')});
test('missing policy evidence never manufactures legacy or scoped pass',()=>{const r=base();delete r.run.profile;assert.equal(find(r,'smoke.model_technical.0')?.status,'not_reached');assert.equal(find(r,'smoke.model_technical.0')?.reason,'evidence_missing')});
test('skipped slots before started repeated script/label bind by plannedIndex',()=>{const r=base();const p=structuredClone(r.run.manifest.trials[0]);r.run.manifest.trials=[p,p,p];r.summary.runOrder=[{scriptId:p.scriptId,label:p.label},{scriptId:p.scriptId,label:p.label}];r.summary.skipped=[{plannedIndex:0,scriptId:p.scriptId,label:p.label,status:'not_reached'}];r.trials[0].plannedIndex=1;const second=structuredClone(r.trials[0]);second.order=1;second.plannedIndex=2;second.calls=[];r.trials.push(second);assert.equal(component(r).status,'pass');assert.equal(component(r,1).id,'smoke.model_technical.1')});
test('distinct sends on one call are individually checked; adopted model binds final send',()=>{const r=base();r.trials[0].calls[0].sendIds=[1,2];r.evidence.events[2].model=alias;const second=r.evidence.events.slice(0,3).map((e:any)=>({...e,sendId:2,...(e.type==='response'?{model:snapshot}:{})}));r.evidence.events.splice(3,0,...second);r.evidence.events.forEach((e:any,i:number)=>e.seq=i+1);const o=collectModelObservations(r);assert.equal(o.inconsistent.length,0);assert.equal(o.missing.length,0);assert.equal(o.observations.length,2);const s=aggregateClassifiedModelObservations(o);assert.equal(s.technicalState,'technical_accepted');assert.equal(s.versionIdentified,false)});
test('collector rejects array custom prototypes without invoking inherited methods',()=>{const r=base();let reads=0;Object.setPrototypeOf(r.evidence.events,Object.assign(Object.create(Array.prototype),{forEach(){reads++}}));assert.throws(()=>collectModelObservations(r),/model_observations_invalid/);assert.equal(reads,0)});
