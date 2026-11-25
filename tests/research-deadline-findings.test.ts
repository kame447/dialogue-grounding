// S1F-1/2/3: independently constructed synthetic controls; old oracles unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createResearchDeadlineScope,validateResearchDeadlines} from '../dialogue-model/runtime/diagnostics/parity-live/research-deadlines.ts';
import {researchDeadlineChecks} from '../dialogue-model/runtime/diagnostics/parity-verify/research-records.ts';
const cfg=()=>({observationMs:120,localMs:210,decisionMs:310,lunaAttemptMs:75,generationMs:120,trialMs:1200});
function saved(callId=11,sendId=31,trial=false):any{
 const deadlines={configured:cfg(),applied:{observationOuterMs:null,completeCalls:[{callId,callOptionTimeoutMs:120,startedAtMs:0,phaseRemainingMs:120,trialRemainingMs:trial?1200:null,outerAppliedMs:120}],sends:[{callId,attemptIndex:0,sendId,startedAtMs:0,phaseRemainingMs:120,trialRemainingMs:trial?1200:null,configuredAttemptMs:75,appliedMs:75,deadlineAtMs:75,limitedBy:'attempt'}]},measured:{clock:'monotonic_ms',origin:trial?'trial_start':'warmup_start',wallStartedAt:'2026-02-03T00:00:00.000Z',elapsedMs:20,sends:[{callId,attemptIndex:0,sendId,sentAtMs:0,terminal:{outcome:'returned',cause:null,terminalAtMs:20,elapsedMs:20},lateObservation:null}],calls:[{callId,adopted:true,endCause:null}]}};
 return {calls:[{id:callId,provider:'luna',status:'ok',sendIds:[sendId]}],http:[{method:'POST',kind:'completion_post',callId,sendId}],deadlines};
}
function input(trialIds?:[number,number]):any{
 const warmup=saved(),owners=trialIds?[warmup,{...saved(...trialIds,true),order:0}]:[warmup];
 return {run:{profile:{id:'research_trial_profile_v2',timeouts:cfg()}},warmup,trials:owners.slice(1),deadlineRevisions:owners.map((o,i)=>({schemaVersion:'parity_live_deadline_revision_v2',revision:i+1,trialOrder:i===0?null:0,deadlines:structuredClone(o.deadlines),closedCallIds:o.calls.map((c:any)=>c.id),scopeClosed:true}))};
}
const checks=(v:any)=>researchDeadlineChecks(v);
for(const ids of [undefined,[23,47] as [number,number]])test('S1F normal timing/journal positive '+String(ids),()=>assert.ok(checks(input(ids)).every(c=>c.status==='pass')));
for(const value of [Infinity,-Infinity,NaN])test('S1F-2 non JSON configured value returns fixed mismatch '+String(value),()=>{
 const v=input();v.run.profile.timeouts.observationMs=value;
 const result=checks(v);assert.ok(result.some(c=>c.id==='research.deadlines.configured'&&c.status==='mismatch'&&c.reason==='invalid_deadline_records'));
});
for(const ids of [[11,47],[23,31],[11,31]] as Array<[number,number]>)test('S1F-3 cross scope ID reuse '+ids.join('/'),()=>{
 const result=checks(input(ids));assert.ok(result.some(c=>c.id==='research.deadlines.journal.1'&&c.status==='mismatch'&&c.reason==='deadline_revision_conflict'),JSON.stringify(result));
});
for(const aborted of [false,true])test('S1F-1 pre-aborted IO signal refuses before reserve '+aborted,async()=>{
 const scope=createResearchDeadlineScope({timeouts:cfg(),origin:'warmup_start',clock:()=>0,wallNow:()=>new Date('2026-02-03T00:00:00Z')});
 const ctrl=new AbortController();if(aborted)ctrl.abort();let reserved=0,posted=0;
 const operation=scope.withCall(11,{phase:'generation',callOptionTimeoutMs:120},()=>scope.fetch(11,0,{signal:ctrl.signal,reserve:()=>{reserved++;return 31;},fetchImpl:async()=>{posted++;return Response.json({usage:{prompt_tokens:1,completion_tokens:1}});}}));
 if(aborted)await assert.rejects(operation,(e:any)=>e.abortCause==='caller_abort');else await operation;
 const d=scope.snapshot();assert.equal(reserved,aborted?0:1);assert.equal(posted,aborted?0:1);assert.equal(d.measured.calls[0].adopted,!aborted);
 if(aborted){assert.equal(d.applied.sends[0].sendId,null);assert.deepEqual(d.measured.sends[0].terminal,{outcome:'refused_before_send',cause:'caller_abort',terminalAtMs:null,elapsedMs:null});}
 validateResearchDeadlines(d);scope.close();
});
