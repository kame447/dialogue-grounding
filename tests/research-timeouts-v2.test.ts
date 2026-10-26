// Partial S1 freeze: configuration/raw/native wiring/generation, not recording §3B.
import test from 'node:test';import assert from 'node:assert/strict';
import * as profiles from '../dialogue-model/runtime/v2/research-profile.ts';
import * as manifests from '../dialogue-model/runtime/diagnostics/parity-live/manifest.ts';
import {createProfileDialogue} from '../dialogue-model/runtime/diagnostics/parity-live/replay.ts';
import {createJevDecisionClient} from '../dialogue-model/runtime/decision/jev-decision.ts';
import {createMockJevDecisionClient} from '../dialogue-model/runtime/decision/mocks.ts';
import {createJevChoiceTransport,createJevLocalTestClassifier} from '../dialogue-model/runtime/local-grounding/jev-local-test.ts';
import {createJevAiFunctionClassifier,createJevAiSupportChecker} from '../dialogue-model/runtime/local-grounding/jev-ai-public.ts';
import {createLunaObserver} from '../dialogue-model/runtime/observation/observe.ts';
import {createLunaLocalExtractor,createMemoLocalExtractor} from '../dialogue-model/runtime/local-grounding/extract.ts';
import {createLocalFunctionClassifier,createLunaLocalClassifier} from '../dialogue-model/runtime/local-grounding/classify.ts';
import {harness,flush,until} from './support/research-timeout-synthetic.ts';
const settings=await import('../dialogue-model/runtime/v2/research-timeouts.ts').catch(()=>null);
const timeouts=()=>({observationMs:300000,localMs:300000,decisionMs:60000,lunaAttemptMs:80000,generationMs:80000,trialMs:3600000});
const manifest=():any=>({...structuredClone(manifests.APPROVED_RUN_MANIFEST),schemaVersion:2,timeouts:timeouts()});
const code=(c:string)=>(e:any)=>(e.code??e.message)===c;
function exported(module:any,name:string):any{assert.equal(typeof module?.[name],'function','public export '+name);return module[name];}
const validate=(x:any)=>exported(settings,'validateResearchTimeouts')(x);
const v2=(x:any)=>exported(manifests,'validateRunManifestV2')(x);
const profile=()=>exported(profiles,'researchTrialProfileV2')({timeoutMs:null,maxCompletionTokens:null},timeouts());
test('V2 pure timeout selection is detached frozen, finite upper endpoints accepted',()=>{const x=timeouts(),got=validate(x);assert.deepEqual(got,x);assert.ok(Object.isFrozen(got));assert.notEqual(got,x);for(const key of Object.keys(x).filter(k=>!['trialMs','lunaAttemptMs'].includes(k))){const p={...x,[key]:600000};assert.equal(validate(p)[key],600000);}assert.equal(validate({...x,lunaAttemptMs:85000}).lunaAttemptMs,85000);});
for(const key of Object.keys(timeouts()))for(const value of [undefined,null,'300000',true,[],{},0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER])test('V2 numeric raw rejection '+key+' '+String(value),()=>{assert.throws(()=>validate({...timeouts(),[key]:value}),code('invalid_timeouts'));});
for(const value of [null,[],true,{}, {...timeouts(),extra:1},Object.assign(Object.create({}),timeouts())])test('V2 closed timeout object '+JSON.stringify(value),()=>assert.throws(()=>validate(value),code('invalid_timeouts')));
for(const [n,expected] of [[85001,'luna_attempt_exceeds_worker_upstream'],[600000,'luna_attempt_exceeds_worker_upstream'],[600001,'invalid_timeouts']] as const)test('V2 Luna rejection precedence '+n,()=>assert.throws(()=>validate({...timeouts(),lunaAttemptMs:n}),code(expected)));
test('V2 trial must strictly contain all logical budgets',()=>{for(const n of [300000,299999])assert.throws(()=>validate({...timeouts(),trialMs:n}),code('timeouts_relation_invalid'));});
test('V2 manifest dispatcher preserves legacy and selects explicit new schema',()=>{const x=manifest();assert.deepEqual(v2(x),x);const dispatch=exported(manifests,'validateAnyRunManifest');assert.deepEqual(dispatch(x),x);assert.deepEqual(dispatch(manifests.APPROVED_RUN_MANIFEST),manifests.validateRunManifest(manifests.APPROVED_RUN_MANIFEST));assert.throws(()=>manifests.validateRunManifest(x as any),{message:'invalid_manifest'});});
for(const value of [undefined,null,'2',1,3,true,[]])test('V2 rejects explicit wrong version '+String(value),()=>assert.throws(()=>v2({...manifest(),schemaVersion:value}),code('invalid_manifest_version')));
test('V2 missing timeouts / legacy phase coexistence rejected',()=>{const x:any=manifest();delete x.timeouts;assert.throws(()=>v2(x),code('invalid_timeouts'));assert.throws(()=>v2({...manifest(),phaseTimeouts:{localMs:1,observationMs:1}}),code('invalid_timeouts'));});
test('V2 duplicate precedes trial relation, Luna general bounds precede duplicate',()=>{const x=manifest();x.lunaRequest.timeoutMs=80000 as any;x.timeouts.trialMs=300000;assert.throws(()=>v2(x),code('duplicate_luna_timeout'));x.timeouts.lunaAttemptMs=85001;assert.throws(()=>v2(x),code('luna_attempt_exceeds_worker_upstream'));x.timeouts.lunaAttemptMs=600001;assert.throws(()=>v2(x),code('invalid_timeouts'));});
test('V2 profile ID and original null request; legacy timeouts/hash stay stable',()=>{const p=profile();assert.deepEqual(p,{...profiles.researchTrialProfile({timeoutMs:null,maxCompletionTokens:null}),id:'research_trial_profile_v2',timeouts:timeouts(),modelContract:{version:'model-contract-v2',tableSha256:'8863dac6f67424d1bbf76a3e6c1dafc4d8eb48ca36628dd7584454e2876af9b0'}});assert.ok(Object.isFrozen(p.modelContract));assert.equal(p.id,'research_trial_profile_v2');assert.deepEqual(p.timeouts,timeouts());assert.equal(p.lunaRequest.timeoutMs,null);assert.ok(Object.isFrozen(p.timeouts));assert.deepEqual(profiles.RESEARCH_TRIAL_PROFILE_V1.timeouts,{observationMs:20000,localMs:20000,decisionMs:15000,generationMs:40000});assert.equal(profiles.RESEARCH_TRIAL_PROFILE_SHA256,profiles.researchHash(profiles.RESEARCH_TRIAL_PROFILE_V1));});
const noKey=async()=>'sk-or-SYNTHETIC-settings-transport-0000',noFetch=async()=>{throw Error('unexpected fake send');};
const simpleClient={async complete(){return {text:'[]'};}};
const makers:Record<string,(limits:any,ms?:number)=>any>={
 observer:(researchLimits,timeoutMs=300000)=>createLunaObserver(simpleClient,{researchLimits,timeoutMs} as any),
 extractor:(researchLimits,timeoutMs=300000)=>createLunaLocalExtractor(simpleClient,{researchLimits,timeoutMs} as any),
 memoExtractor:(researchLimits,timeoutMs=300000)=>createMemoLocalExtractor(simpleClient,{getMemo:()=>({}) as any,researchLimits,timeoutMs} as any),
 classifier:(researchLimits,timeoutMs=300000)=>createLocalFunctionClassifier({call:async()=>[],classifierKind:'unverified_injected',researchLimits,timeoutMs} as any),
 lunaClassifier:(researchLimits,timeoutMs=300000)=>createLunaLocalClassifier(simpleClient,{researchLimits,timeoutMs} as any),
 decision:(researchLimits,timeoutMs=300000)=>createJevDecisionClient({enabled:true,readKey:noKey,fetchImpl:noFetch,researchLimits,timeoutMs} as any),
 mock:(researchLimits,timeoutMs=300000)=>createMockJevDecisionClient(()=>({action:'accept',target:{kind:'none'},name:null,feature:null,observe:null}),{researchLimits,timeoutMs} as any),
 choice:(researchLimits,timeoutMs=300000)=>createJevChoiceTransport({readKey:noKey,fetchImpl:noFetch,researchLimits,timeoutMs} as any),
 localJev:(researchLimits,timeoutMs=300000)=>createJevLocalTestClassifier({enabled:true,readKey:noKey,fetchImpl:noFetch,researchLimits,timeoutMs} as any),
 aiFunction:(researchLimits,timeoutMs=300000)=>createJevAiFunctionClassifier({readKey:noKey,fetchImpl:noFetch,researchLimits,timeoutMs} as any),
 aiSupport:(researchLimits,timeoutMs=300000)=>createJevAiSupportChecker({readKey:noKey,fetchImpl:noFetch,researchLimits,timeoutMs} as any),
};
for(const [name,make] of Object.entries(makers)){
 test('research ability explicitly permits finite deadline '+name,()=>assert.ok(make({maxDeadlineMs:600000})));
 for(const ability of [null,{},[],true,'600000',{maxDeadlineMs:'600000'},{maxDeadlineMs:Infinity},{maxDeadlineMs:600001},{maxDeadlineMs:600000,extra:true}])test('invalid research ability '+name+' '+JSON.stringify(ability),()=>assert.throws(()=>make(ability,1000),code('invalid_research_limits')));
 if(name!=='lunaClassifier')test('legacy ability omission still rejects long deadline '+name,()=>assert.throws(()=>make(undefined)));
}
for(const raw of [null,'300000',Infinity,NaN,[],true,0,-1,1.5,600001])test('native decision/choice validate raw before min '+String(raw),async()=>{const opts:any={enabled:true,readKey:noKey,fetchImpl:noFetch,timeoutMs:60000,researchLimits:{maxDeadlineMs:600000}};const d=createJevDecisionClient(opts)!;await assert.rejects(d.decide({} as any,{timeoutMs:raw as any}),code('invalid_options'));const c=createJevChoiceTransport(opts);await assert.rejects(c.request({} as any,{timeoutMs:raw as any}),code('invalid_options'));});
test('explicit V2 generation selection is visible at the native chat client boundary',async()=>{const p=profile();p.timeouts.generationMs;const h=harness({},300000,o=>createProfileDialogue(p as any,{...o,image:o.ownImage,anchors:o.ownAnchors,strategy:'repair-first',referenceMemory:true,decisionMode:'jev'}));await h.run();assert.equal(h.sent.find(x=>x.phase==='generation')!.timeoutMs,80000);});
test('V2 generation outer race ends a signal-ignoring client at D',async t=>{let now=0;t.mock.method(performance,'now',()=>now);t.mock.timers.enable({apis:['setTimeout']});const p=profile(),h=harness({generation:1000000},300000,o=>createProfileDialogue(p as any,{...o,image:o.ownImage,anchors:o.ownAnchors,strategy:'repair-first',referenceMemory:true,decisionMode:'jev'}));let caught:any;const work=h.run().catch((e:any)=>{caught=e;});await until(()=>h.sent.some(x=>x.phase==='generation'));now=79999;t.mock.timers.tick(79999);await flush();assert.equal(caught,undefined);now=80000;t.mock.timers.tick(1);await work;assert.equal((caught as any)?.code,'generation_failed');assert.equal((caught as any)?.generationErrorCode,'timeout');assert.equal(h.sent.filter(x=>x.phase==='generation').length,1);assert.equal(h.sent.find(x=>x.phase==='generation')!.signal?.aborted,true);});
