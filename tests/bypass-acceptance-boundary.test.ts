// Separate C boundary series; original 88-test RED/GREEN file is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as core from '../dialogue-model/runtime/decision/bypass-acceptance.ts';
import * as adapter from '../dialogue-model/runtime/decision/jev-decision.ts';
import type {JevDecisionInput,JevAction,JevDetailResult} from '../dialogue-model/runtime/decision/contract.ts';
import type {JevDecisionPayload} from '../dialogue-model/runtime/decision/jev-decision.ts';
const fixture=(name:string)=>JSON.parse(readFileSync(new URL(`./fixtures/bypass-acceptance/${name}`,import.meta.url),'utf8'));
const input=()=>fixture('MINIMAL-INPUT.json') as JevDecisionInput;
const native=()=>fixture('MINIMAL-ORIGINAL-NATIVE.json');
const cfg=()=>core.interventionForStrategy('repair-first');
const selected={action:'confirm' as const,target:{kind:'single' as const,figureId:'own-0'}};
function answer(p:JevDecisionPayload,action:JevAction='defer'){
 return {model:adapter.JEV_DECISION_MODEL,id:'gen-C-boundary',usage:{cost:0},answers:Object.fromEntries(Object.entries(p.questions).map(([k,q])=>{
 const choice=k==='action'?action:k==='target'?'figure_0':k.startsWith('candidate_')?'exclude':Object.keys(q.criteria)[0];
 return [k,{type:'choice',choice,probabilities:Object.fromEntries(Object.keys(q.criteria).map(l=>[l,k==='action'?(l===action?1:l==='confirm'?0.9:0):l===choice?1:0]))}];}))};
}
function fake(){const wire:JevDecisionPayload[]=[];let reads=0;
 const client=adapter.createJevDecisionClient({enabled:true,readKey:async()=>{reads++;return 'sk-or-SYNTHETIC-C-boundary-only';},fetchImpl:async(_url,init)=>{const p=JSON.parse(init.body as string);wire.push(p);return new Response(JSON.stringify(answer(p)));}})!;
 return {client,wire,reads:()=>reads};
}
test('C boundary native selected-detail output and parser result are deeply frozen',async()=>{
 const {client}=fake(),i=input(),r=await client.completeDetail(i,selected);
 assert.ok(Object.isFrozen(r));assert.ok(Object.isFrozen(r.executed.target));assert.ok(Object.isFrozen(r.evidence.scores.feature));
 const parsed=adapter.parseJevExecutedDetail(i,selected,r.evidence);assert.ok(Object.isFrozen(parsed));assert.ok(Object.isFrozen(parsed.detailFigureIds));
});
test('C boundary native closed input top-level extra rejects before key/send',async()=>{
 const f=fake();await assert.rejects(f.client.completeDetail({...input(),condition:'repair-first'} as JevDecisionInput,selected),(e:unknown)=>e instanceof adapter.JevDecisionError&&e.code==='invalid_input');assert.equal(f.reads(),0);assert.equal(f.wire.length,0);
});
test('C boundary hostile actual JevDecisionError getter is not invoked or leaked',async()=>{
 let reads=0;const error=new adapter.JevDecisionError('timeout');Object.defineProperty(error,'code',{get(){reads++;throw Error('PRIVATE_ERROR_CANARY');}});
 await assert.rejects(core.applyBypassAcceptance(input(),native(),cfg(),async()=>{throw error;}),(e:unknown)=>{
 assert.ok(e instanceof core.BypassAcceptanceError);assert.equal(e.code,'alternative_failed');assert.equal(e.intervention!.failure!.inner.code,'invalid_response');assert.doesNotMatch(JSON.stringify(e),/PRIVATE_ERROR_CANARY/);return true;});assert.equal(reads,0);
});
test('C boundary nested private extras are removed by the actual native payload builder',async()=>{
 const f=fake(),i=input() as JevDecisionInput&{observations:any};i.observations.privateMarker='PRIVATE_CANARY';i.observations.figures[0].gold='GOLD_CANARY';
 i.publicTurns=[{turn:1,speaker:'human',text:'The public words are repair-first, defer and veto.'}];
 await f.client.completeDetail(i,selected);assert.equal(f.wire.length,1);assert.doesNotMatch(JSON.stringify(f.wire),/PRIVATE_CANARY|GOLD_CANARY/);assert.match(f.wire[0].state,/repair-first, defer and veto/);assert.deepEqual(f.wire[0],adapter.buildJevDecisionDetailPayload(i,selected));
});
test('C boundary full reobservation + final original + R detail stays at four HTTP sends',async()=>{
 const wire:JevDecisionPayload[]=[];const client=adapter.createJevDecisionClient({enabled:true,readKey:async()=> 'sk-or-SYNTHETIC-C-boundary-only',fetchImpl:async(_url,init)=>{
 const p=JSON.parse(init.body as string);wire.push(p);return new Response(JSON.stringify(answer(p,wire.length===1?'request_observation':'defer')));}})!;
 const i=input();i.reobservationAllowed=true;const observation=await client.decide(i);assert.equal(observation.action,'request_observation');assert.equal(wire.length,2);
 i.reobservationAllowed=false;const original=await client.decide(i);assert.equal(original.action,'defer');assert.equal(wire.length,3);
 const r=await core.applyBypassAcceptance(i,original,cfg(),(ci,s)=>client.completeDetail(ci,s));assert.equal(r.executed.action,'confirm');assert.equal(wire.length,4);assert.deepEqual(wire[3],adapter.buildJevDecisionDetailPayload(i,selected));
});
test('C boundary thrown revoked proxy normalizes to fixed detail failure',async()=>{
 const {proxy,revoke}=Proxy.revocable({},{});revoke();await assert.rejects(core.applyBypassAcceptance(input(),native(),cfg(),async()=>{throw proxy;}),(e:unknown)=>e instanceof core.BypassAcceptanceError&&e.intervention!.failure!.inner.code==='invalid_response');
});
test('C boundary unavailable no-target revisit is excluded even at the highest score',async()=>{
 const i=input();const client=adapter.createJevDecisionClient({enabled:true,readKey:async()=> 'sk-or-SYNTHETIC-C-boundary-only',fetchImpl:async(_url,init)=>{
 const p=JSON.parse(init.body as string),a=answer(p,'move_on');a.answers.target.choice='none';a.answers.action.probabilities.revisit=1;a.answers.action.probabilities.confirm=0;
 return new Response(JSON.stringify(a));}})!;
 const d=await client.decide(i);const p=core.planBypassAcceptance(i,d,cfg());assert.equal(p.rerank!.ranking.some(r=>r.action==='revisit'),false);assert.equal(p.rerank!.selected!.action,'accept');
});
