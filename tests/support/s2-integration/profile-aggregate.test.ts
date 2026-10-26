// Author preparation only. Profile/aggregate frozen by PREAUDIT-MODEL-INTEGRATION-01.
// No producer, transport, key reader, real run or external network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const root=process.env.S2_SOURCE_ROOT??'/Users/Shogo/.agentstack/worktrees/SandyNoether';
async function optional(path:string){try{return await import(pathToFileURL(join(root,path)).href);}catch(e){if((e as NodeJS.ErrnoException).code==='ERR_MODULE_NOT_FOUND')return null;throw e;}}
const policy=await optional('dialogue-model/runtime/model-policy.ts');
const aggregate=await optional('dialogue-model/runtime/model-observations.ts');
const alias='typesafe/jev-1.14',date='20261014',pin='8863dac6f67424d1bbf76a3e6c1dafc4d8eb48ca36628dd7584454e2876af9b0';
const canonical='{"acceptedReturned":["typesafe/jev-1.14","typesafe/jev-1.14-20261014"],"requested":"typesafe/jev-1.14","version":"model-contract-v2"}';
const ref=()=>({version:'model-contract-v2',tableSha256:pin});
const profile=():any=>({id:'research_trial_profile_v2',referenceMemory:true,decisionMode:'jev',humanReferent:true,localGrounding:{enabled:true,aiPublicClaims:true},initialObservation:'cache_required',questionLayout:'two_stage_v1',utteranceStyle:'default',maxReobservations:1,modelPolicy:{purpose:'dialogue_turn',resolver:'research_worker',jevModel:alias},timeouts:{observationMs:20000,localMs:20000,decisionMs:15000,lunaAttemptMs:45000,generationMs:40000,trialMs:900000},lunaRequest:{timeoutMs:null,maxCompletionTokens:null},outputLimit:'worker_dependent_effective_value_unverified',modelContract:ref()});
function api(){assert.ok(policy,'R-a: model-policy.ts entry absent');return policy;}
function agg(){assert.ok(aggregate,'R-a: model-observations.ts entry absent');return aggregate.aggregateClassifiedModelObservations;}
const err=(code:string)=>(e:unknown)=>e instanceof api().ModelIntegrationError&&(e as any).code===code&&(e as Error).message===code;
function frozen<T>(v:T):T{if(v&&typeof v==='object'){Object.values(v).forEach(frozen);Object.freeze(v);}return v;}
const source=()=>[{file:'verifier-evidence.private.json',pointer:'/events/2'}];
const obs=(id=1,version:string|null=null):any=>({callId:id,sendId:id,responseSeq:id*3,returnedId:version===null?alias:`${alias}-${version}`,version,sources:source()});
const issue=(reason='response_missing',extra:Record<string,unknown>={}):any=>({callId:2,sendId:2,responseSeq:null,reason,rejectionCode:null,sources:source(),...extra});
const set=():any=>({schemaVersion:'model_observation_set_v1',observations:[],lateObservations:[],missing:[],inconsistent:[],rejected:[],notSent:[]});
function run(value:any){return agg()(value);}
function invalid(value:any){assert.throws(()=>run(value),(e:unknown)=>e instanceof Error&&e.message==='model_observations_invalid');}

test('existing canonical table control, not new predicate RED',()=>assert.equal(createHash('sha256').update(canonical).digest('hex'),pin));
test('profile v2 resolves explicit exact reference, detached and frozen',()=>{const p=profile(),r=api().resolveModelPolicy(frozen(p));assert.deepEqual(r,{profileId:'research_trial_profile_v2',mode:'explicit',modelContract:ref()});assert.ok(Object.isFrozen(r));assert.ok(Object.isFrozen(r.modelContract));assert.notEqual(r.modelContract,p.modelContract);});
test('recognized minimal v1 descriptor selects legacy, not full old-profile validation',()=>assert.deepEqual(api().resolveModelPolicy({id:'research_trial_profile_v1'}),{profileId:'research_trial_profile_v1',mode:'legacy',modelContract:null}));
test('missing v2 reference is never a legacy fallback',()=>{const p=profile();delete p.modelContract;assert.throws(()=>api().resolveModelPolicy(p),err('model_contract_missing'));});
for(const value of [null,[],{version:'model-contract-v2'},{...ref(),extra:1},{...ref(),tableSha256:'ABC'}, {version:['model-contract-v2'],tableSha256:pin}])test('malformed model reference shape stays fixed error',()=>{const p=profile();p.modelContract=value;assert.throws(()=>api().resolveModelPolicy(p),err('model_contract_invalid'));});
test('well-formed unknown version has separate code',()=>{const p=profile();p.modelContract.version='model-contract-v99';assert.throws(()=>api().resolveModelPolicy(p),err('model_contract_unknown'));});
test('well-formed different digest cannot install a second table',()=>{const p=profile();p.modelContract.tableSha256='0'.repeat(64);assert.throws(()=>api().resolveModelPolicy(p),err('model_table_mismatch'));});
for(const value of [null,undefined,ref()])test('v1 with own reference, including null, is invalid',()=>assert.throws(()=>api().resolveModelPolicy({id:'research_trial_profile_v1',modelContract:value}),err('model_profile_invalid')));
for(const value of [null,[],{id:'research_trial_profile_v3'}, {...profile(),extra:1},Object.assign(Object.create(null),profile())])test('unknown/invalid profile never falls back',()=>assert.throws(()=>api().resolveModelPolicy(value),err('model_profile_invalid')));
test('reference accessor rejected without evaluating it',()=>{const p=profile();let reads=0;Object.defineProperty(p,'modelContract',{enumerable:true,get(){reads++;throw Error('PRIVATE_CANARY');}});assert.throws(()=>api().resolveModelPolicy(p),err('model_contract_invalid'));assert.equal(reads,0);});
test('profile stage precedence before reference',()=>{const p=profile();p.referenceMemory=false;p.modelContract=null;assert.throws(()=>api().resolveModelPolicy(p),err('model_profile_invalid'));});
test('alias technically accepted but version unresolved, exact summary keys',()=>{const v=set();v.observations=[obs()];const before=structuredClone(v);const r=run(frozen(v));assert.deepEqual(r,{technicalState:'technical_accepted',reason:'all_observed_accepted',acceptedReturnedIds:[alias],observedVersions:[],versionIdentified:false,observedCount:1,missingCount:0,inconsistentCount:0});assert.deepEqual(v,before);assert.ok(Object.isFrozen(r.acceptedReturnedIds));});
test('dated-only accepted gives identified version',()=>{const v=set();v.observations=[obs(1,date)];const r=run(v);assert.equal(r.versionIdentified,true);assert.deepEqual(r.observedVersions,[date]);});
test('alias plus allowed snapshot accepted, alias does not borrow snapshot identity',()=>{const v=set();v.observations=[obs(),obs(2,date)];const r=run(v);assert.equal(r.technicalState,'technical_accepted');assert.equal(r.versionIdentified,false);assert.equal(r.observedCount,2);});
test('counterfactual classified two-date aggregate only, never fixed-registry online acceptance',()=>{const v=set();v.observations=[obs(1,date),obs(2,'20990101')];const r=run(v);assert.equal(r.technicalState,'technical_rejected');assert.equal(r.reason,'model_version_mixed');});
test('accepted surviving subset cannot hide missing send',()=>{const v=set();v.observations=[obs()];v.missing=[issue()];const r=run(v);assert.equal(r.technicalState,'technical_unknown');assert.equal(r.reason,'evidence_missing');assert.equal(r.missingCount,1);});
test('empty main observation is unknown',()=>{const r=run(set());assert.equal(r.technicalState,'technical_unknown');assert.equal(r.reason,'empty_observation_set');assert.equal(r.versionIdentified,false);});
test('late known observation cannot upgrade main missing',()=>{const v=set();v.lateObservations=[obs()];v.missing=[issue('model_missing',{callId:1,sendId:1})];const r=run(v);assert.equal(r.technicalState,'technical_unknown');assert.equal(r.observedCount,0);assert.deepEqual(r.acceptedReturnedIds,[]);});
test('late-only without main observation remains empty, not accepted',()=>{const v=set();v.lateObservations=[obs()];assert.equal(run(v).reason,'empty_observation_set');});
for(const rejectionCode of ['model_invalid','model_not_allowed','model_unknown_version'])test(`recorded ${rejectionCode} outranks missing`,()=>{const v=set();v.rejected=[issue('recorded_model_rejection',{rejectionCode})];v.missing=[issue()];const r=run(v);assert.equal(r.technicalState,'technical_rejected');assert.equal(r.reason,rejectionCode);});
test('exact repeats count once',()=>{const v=set();v.observations=[obs(),obs()];assert.equal(run(v).observedCount,1);});
test('same send with alias/snapshot is contradictory exact binding',()=>{const v=set();v.observations=[obs(),obs(1,date)];const r=run(v);assert.equal(r.reason,'input_inconsistent');assert.equal(r.technicalState,'technical_rejected');});
test('send reused by another call is input_inconsistent',()=>{const v=set();v.observations=[obs(),{...obs(2),sendId:1}];assert.equal(run(v).reason,'input_inconsistent');});
test('already contradictory main/late overlap is rejected by pure aggregate',()=>{const v=set();v.observations=[obs()];v.lateObservations=[obs()];assert.equal(run(v).reason,'input_inconsistent');});
test('inconsistency outranks recorded rejection and missing',()=>{const v=set();v.observations=[obs(),obs(1,date)];v.rejected=[issue('recorded_model_rejection',{rejectionCode:'model_unknown_version'})];v.missing=[issue()];assert.equal(run(v).reason,'input_inconsistent');});
for(const change of [(v:any)=>{v.extra=1;},(v:any)=>{v.schemaVersion='other';},(v:any)=>{v.observations=[{...obs(),callId:'1'}];},(v:any)=>{v.observations=[{...obs(),version:['20261014']}];},(v:any)=>{v.observations=[{...obs(),sources:[]}];},(v:any)=>{v.observations=[{...obs(),version:date}];},(v:any)=>{v.missing=[issue('response_missing',{rejectionCode:'model_invalid'})];},(v:any)=>{v.rejected=[issue('recorded_model_rejection')];}])test('closed aggregate input rejects malformed fields without coercion',()=>{const v=set();change(v);invalid(v);});
