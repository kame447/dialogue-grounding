// ADDENDUM04 a3ae7239 new activation oracle; prior TR-1 ambiguity is explicit.
import test from 'node:test';import assert from 'node:assert/strict';
const root=process.env.SOL1_ACTIVATION_SUBJECT;
const {researchDeadlineChecks}=await import(root?root+'/dialogue-model/runtime/diagnostics/parity-verify/research-records.ts':'../dialogue-model/runtime/diagnostics/parity-verify/research-records.ts');
const cfg=()=>({observationMs:120,localMs:210,decisionMs:310,lunaAttemptMs:75,generationMs:120,trialMs:1200});
function saved(callId=11,sendId=31,trial=false):any{
 const deadlines={configured:cfg(),applied:{observationOuterMs:null,completeCalls:[{callId,callOptionTimeoutMs:120,startedAtMs:0,phaseRemainingMs:120,trialRemainingMs:trial?1200:null,outerAppliedMs:120}],sends:[{callId,attemptIndex:0,sendId,startedAtMs:0,phaseRemainingMs:120,trialRemainingMs:trial?1200:null,configuredAttemptMs:75,appliedMs:75,deadlineAtMs:75,limitedBy:'attempt'}]},measured:{clock:'monotonic_ms',origin:trial?'trial_start':'warmup_start',wallStartedAt:'2026-02-03T00:00:00.000Z',elapsedMs:20,sends:[{callId,attemptIndex:0,sendId,sentAtMs:0,terminal:{outcome:'returned',cause:null,terminalAtMs:20,elapsedMs:20},lateObservation:null}],calls:[{callId,adopted:true,endCause:null}]}};
 return {calls:[{id:callId,provider:'luna',status:'ok',sendIds:[sendId]}],http:[{method:'POST',kind:'completion_post',callId,sendId}],deadlines};
}
function input(trialIds?:[number,number]):any{
 const warmup=saved(),owners=trialIds?[warmup,{...saved(...trialIds,true),order:0}]:[warmup];
 return {run:{profile:{id:'research_trial_profile_v2',timeouts:cfg()}},warmup,trials:owners.slice(1),deadlineRevisions:owners.map((o,i)=>({schemaVersion:'parity_live_deadline_revision_v2',revision:i+1,trialOrder:i===0?null:0,deadlines:structuredClone(o.deadlines),closedCallIds:o.calls.map((c:any)=>c.id),scopeClosed:true}))};
}

const full=():any=>{const v=input();v.summary={budget:{sends:[{id:31,provider:'luna',logicalCallId:11}]}};v.evidence={events:[{type:'send',provider:'luna',callId:11,sendId:31}]};return v;};
const pass=(v:any)=>assert.ok(researchDeadlineChecks(v).every((c:any)=>c.status==='pass'));
const fail=(v:any,reason:string)=>{const got=researchDeadlineChecks(v);for(const id of ['research.deadlines.warmup','research.deadlines.journal.0'])assert.ok(got.some((c:any)=>c.id===id&&c.status==='mismatch'&&c.reason===reason),JSON.stringify(got));};
test('activation timing-only normal',()=>pass(input()));
test('activation summary without budget stays timing-only',()=>{const v=input();v.summary={status:'synthetic'};pass(v);});
test('activation full matching POST control',()=>pass(full()));
test('activation reserved unsent budget does not invent POST',()=>{const v=full();v.summary.budget.sends.push({id:99,provider:'luna',logicalCallId:11});pass(v);});
test('activation GET and Jev outside new send universe',()=>{const v=full();v.warmup.http.push({method:'GET',kind:'policy_get',callId:null,sendId:null});v.warmup.calls.push({id:99,provider:'jev',status:'ok',sendIds:[100]});v.summary.budget.sends.push({id:100,provider:'jev',logicalCallId:99});v.evidence.events.push({type:'send',provider:'jev',callId:99,sendId:100});pass(v);});
for(const active of [false,true])test('activation zero POST explicit empty arrays '+active,()=>{const v=input();v.warmup.calls=[];v.warmup.http=[];const d=v.warmup.deadlines;d.applied.completeCalls=[];d.applied.sends=[];d.measured.calls=[];d.measured.sends=[];v.deadlineRevisions[0].deadlines=structuredClone(d);v.deadlineRevisions[0].closedCallIds=[];if(active){v.summary={budget:{sends:[]}};v.evidence={events:[]};}pass(v);});
for(const [name,change] of Object.entries({
 evidenceEnvelope:(v:any)=>delete v.evidence,
 budgetEnvelope:(v:any)=>delete v.summary.budget,
 evidenceEvents:(v:any)=>delete v.evidence.events,
 budgetSends:(v:any)=>delete v.summary.budget.sends,
 emptyEvidence:(v:any)=>v.evidence={},
 emptyBudget:(v:any)=>v.summary.budget={},
 zeroPOSTMissingEvidence:(v:any)=>{v.warmup.calls=[];v.warmup.http=[];const d=v.warmup.deadlines;d.applied.completeCalls=[];d.applied.sends=[];d.measured.calls=[];d.measured.sends=[];v.deadlineRevisions[0].deadlines=structuredClone(d);v.deadlineRevisions[0].closedCallIds=[];delete v.evidence;},
}))test('activation missing '+name,()=>{const v=full();change(v);fail(v,'deadline_required_records_missing');});
for(const key of ['budget','evidence'])for(const bad of [null,[],false,'synthetic',undefined])test('activation malformed envelope '+key+'/'+String(bad),()=>{const v=full();if(key==='budget')v.summary.budget=bad;else v.evidence=bad;fail(v,'invalid_deadline_records');});
for(const key of ['sends','events'])for(const bad of [null,{},false,'synthetic',undefined,[null],[Infinity]])test('activation malformed collection '+key+'/'+String(bad),()=>{const v=full();if(key==='sends')v.summary.budget.sends=bad;else v.evidence.events=bad;fail(v,'invalid_deadline_records');});
test('activation malformed precedes missing companion',()=>{const v=full();v.summary.budget=null;delete v.evidence;fail(v,'invalid_deadline_records');});
for(const key of ['sends','events'])test('activation present empty collection missing actual POST '+key,()=>{const v=full();if(key==='sends')v.summary.budget.sends=[];else v.evidence.events=[];fail(v,'deadline_binding_mismatch');});
test('activation orphan Luna event is binding mismatch',()=>{const v=full();v.evidence.events.push({type:'send',provider:'luna',callId:11,sendId:99});fail(v,'deadline_binding_mismatch');});
test('activation Luna send event with no run owner is a binding mismatch',()=>{const v=full();v.evidence.events.push({type:'send',provider:'luna',callId:72,sendId:88});fail(v,'deadline_binding_mismatch');});
