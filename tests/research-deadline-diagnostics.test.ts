// New author diagnostics series: c44d6138 + ADDENDUM05, old tests unchanged.
import test from 'node:test';import assert from 'node:assert/strict';
import {researchDeadlineChecks,validateResearchFailureV2} from '../dialogue-model/runtime/diagnostics/parity-verify/research-records.ts';
const cfg=()=>({observationMs:100,localMs:200,decisionMs:300,lunaAttemptMs:80,generationMs:100,trialMs:1000});
const deadlines=():any=>({configured:cfg(),applied:{observationOuterMs:100,completeCalls:[{callId:1,callOptionTimeoutMs:100,startedAtMs:0,phaseRemainingMs:100,trialRemainingMs:null,outerAppliedMs:100}],sends:[{callId:1,attemptIndex:0,sendId:7,startedAtMs:0,phaseRemainingMs:100,trialRemainingMs:null,configuredAttemptMs:80,appliedMs:80,deadlineAtMs:80,limitedBy:'attempt'}]},measured:{clock:'monotonic_ms',origin:'warmup_start',wallStartedAt:'2026-01-01T00:00:00.000Z',elapsedMs:80,sends:[{callId:1,attemptIndex:0,sendId:7,sentAtMs:0,terminal:{outcome:'timeout',cause:'attempt_timeout',terminalAtMs:80,elapsedMs:80},lateObservation:null}],calls:[{callId:1,adopted:false,endCause:'attempt_timeout'}]}});
const normal=():any=>{const d=deadlines(),h='0'.repeat(64);return {run:{profile:{id:'research_trial_profile_v2',timeouts:cfg()}},trials:[],failure:{schemaVersion:'parity_live_failure_v2',scope:'warmup',code:'luna_error',stage:'cache_get',calls:[{id:1,sendIds:[7],phase:'observation_initial',turn:null,provider:'luna',requestSha256:h,instructionSha256:h,requestedModel:'synthetic-model',model:null,status:'error',error:'luna_error',costUsd:null,inputTokens:null,outputTokens:null,imageCount:1,latencyMs:80}],cache:null,observationCallStarted:true,policy:{status:'obtained',value:{purpose:'dialogue_turn',ready:true,model:'synthetic-model',provider:'openai'}},http:{measured:true,records:[{method:'POST',kind:'completion_post',phase:'observation_initial',callId:1,sendId:7,hashScheme:'canonical_json_sha256',requestSha256:h,status:null,outcome:'unknown'}]},deadlines:d},deadlineRevisions:[{schemaVersion:'parity_live_deadline_revision_v2',revision:1,trialOrder:null,deadlines:structuredClone(d),closedCallIds:[1],scopeClosed:true}]};};

const full=():any=>{const v=normal();v.summary={budget:{sends:[{id:7,provider:'luna',logicalCallId:1}]}};v.evidence={events:[{type:'send',provider:'luna',callId:1,sendId:7}]};return v;};
const expect=(v:any,id:string,reason:string)=>{const out=researchDeadlineChecks(v);assert.ok(out.some(c=>c.id===id&&c.status==='mismatch'&&c.reason===reason),JSON.stringify(out));};
test('diagnostic normal Check list is unchanged',()=>{const checks=researchDeadlineChecks(full());assert.deepEqual(checks.map(c=>c.id),['research.deadlines.configured','research.deadlines.warmup','research.deadlines.failure','research.deadlines.journal.0','research.deadlines.journal']);assert.ok(checks.every(c=>c.status==='pass'&&c.reason==='deadline_records_consistent'));});
for(const field of ['calls','http','deadlines'])test('ruling missing failure '+field,()=>{const v=full();delete v.failure[field];assert.throws(()=>validateResearchFailureV2(v.failure),{message:'invalid_deadline_records'});expect(v,'research.deadlines.failure','deadline_required_records_missing');});
for(const [name,change] of Object.entries({
 bothSendRows:(v:any):any=>{v.failure.deadlines.applied.sends=[];v.failure.deadlines.measured.sends=[];},
 ownerSendId:(v:any):any=>v.failure.calls[0].sendIds=[23],
 httpSendId:(v:any):any=>v.failure.http.records[0].sendId=23,
 httpCallId:(v:any):any=>v.failure.http.records[0].callId=23,
 actualPostRemoved:(v:any):any=>v.failure.http.records=[],
 uncoveredCall:(v:any):any=>v.failure.calls.push({...structuredClone(v.failure.calls[0]),id:2,sendIds:[]}),
 budgetOwner:(v:any):any=>v.summary.budget.sends[0].logicalCallId=23,
 budgetSend:(v:any):any=>v.summary.budget.sends[0].id=23,
 eventOwner:(v:any):any=>v.evidence.events[0].callId=23,
 eventSend:(v:any):any=>v.evidence.events[0].sendId=23,
 missingBudgetEntry:(v:any):any=>v.summary.budget.sends=[],
 missingEventEntry:(v:any):any=>v.evidence.events=[],
}))test('ruling failure binding '+name,()=>{const v=full();change(v);expect(v,'research.deadlines.failure','deadline_binding_mismatch');});
for(const kind of ['terminal','closedNull','closedFailed'])test('ruling history outranks external owner '+kind,()=>{
 const v=full();if(kind==='closedNull'){v.failure.deadlines.measured.calls[0].endCause=null;v.deadlineRevisions[0].deadlines.measured.calls[0].endCause=null;}
 const later=structuredClone(v.deadlineRevisions[0]);later.revision=2;
 if(kind==='terminal'){later.deadlines.measured.sends[0].terminal={outcome:'network',cause:'network',terminalAtMs:70,elapsedMs:70};later.deadlines.measured.calls[0].endCause='network';}
 else later.deadlines.measured.calls[0]={callId:1,adopted:true,endCause:null};
 v.deadlineRevisions.push(later);expect(v,'research.deadlines.journal.1','deadline_revision_conflict');
});
for(const revision of [1,3,4])test('ruling positive but nonconsecutive revision '+revision,()=>{const v=full(),later=structuredClone(v.deadlineRevisions[0]);later.revision=revision;v.deadlineRevisions.push(later);expect(v,'research.deadlines.journal.1','deadline_revision_conflict');});
test('ruling closed history survives first external binding failure',()=>{
 const v=full(),d=v.failure.deadlines;v.failure.calls.push({...structuredClone(v.failure.calls[0]),id:2,sendIds:[]});
 d.applied.completeCalls.push({...structuredClone(d.applied.completeCalls[0]),callId:2});d.measured.calls.push({callId:2,adopted:false,endCause:null});
 const later=structuredClone(v.deadlineRevisions[0]);later.revision=2;later.deadlines=structuredClone(d);later.closedCallIds=[1,2];v.deadlineRevisions.push(later);
 expect(v,'research.deadlines.journal.0','deadline_binding_mismatch');expect(v,'research.deadlines.journal.1','deadline_revision_conflict');
});
test('ruling well typed unregistered closure ID is binding',()=>{const v=full();v.deadlineRevisions[0].closedCallIds=[23];expect(v,'research.deadlines.journal.0','deadline_binding_mismatch');});
test('intrinsic invalid late remains invalid before history',()=>{const v=full(),later=structuredClone(v.deadlineRevisions[0]);later.revision=2;later.deadlines.measured.sends[0].lateObservation={headersAtMs:null,bodyCompletedAtMs:null,usageRecorded:false};v.deadlineRevisions.push(later);expect(v,'research.deadlines.journal.1','invalid_deadline_records');});
for(const malformed of [{},{measured:{calls:null}}])test('malformed saved owner cannot escape via journal comparison '+JSON.stringify(malformed),()=>{const v=full();v.failure.deadlines=malformed;const got=researchDeadlineChecks(v);assert.ok(got.some(c=>c.id==='research.deadlines.failure'&&c.status==='mismatch'&&c.reason==='invalid_deadline_records'));});
