// Explicit offline replay. Native serializers consume only supplied synthetic or
// already recorded material; no provider, key store or filesystem is contacted.
import {createChatClient} from '../../client.mjs';
import {createJevDecisionClient} from '../../decision/jev-decision.ts';
import {createJevLocalTestClassifier} from '../../local-grounding/jev-local-test.ts';
import {buildReobservationMessages} from '../../observation/observe.ts';
import {researchHash} from '../../v2/research-profile.ts';
import {resolveInterventionPolicy} from '../../intervention-policy.ts';
import {createProfileDialogue} from './replay.ts';
import {EVIDENCE_NORMALIZED_ENVELOPE_FIELDS,imageProjection,projectReplayValue} from './evidence.ts';
import type {ReplaySide} from './evidence.ts';
import type {ReplayTape} from './replay.ts';
import type {ResearchTrialProfileV3} from '../../v2/research-profile.ts';
import type {ObservationInput} from '../../observation/contract.ts';
import type {JevPrivateStateV2,JevTurnTrace} from '../../v2/jev-turn.ts';
import type {ExecutedDecision,InterventionTrace} from '../../decision/bypass-acceptance.ts';
export type ReplaySegment=Pick<ReplayTape,'luna'|'jev'|'reobservations'>;
export type InterventionReplayTape={schemaVersion:'parity_intervention_replay_v1';state:JevPrivateStateV2;events:ReplayTape['events'];common:ReplaySegment;tails:Record<'repair-first'|'bypass-enabled',ReplaySegment|null>;recorded:{label:'repair-first'|'bypass-enabled';expectedRequests:ReplayTape['expectedRequests']}};
type Role='common'|'alternative_detail'|'generation'|'post_generation';
export type InterventionReplaySide=Omit<ReplaySide,'requests'>&{requests:Array<ReplaySide['requests'][number]&{role:Role}>;executed:ExecutedDecision|null;intervention:InterventionTrace|null};
type ReplayError='replay_material_invalid'|'replay_material_missing'|'replay_unused_material'|'replay_pipeline_failed';
export type InterventionReplayResult={schemaVersion:'parity_intervention_replay_result_v1';status:'same_material_intervention_verified'|'same_material_intervention_mismatch'|'not_reached';error:ReplayError|null;commonEqual:boolean;policyConformant:boolean;recordedPayloadsReproduced:boolean;actualLunaHttpMeasured:boolean;hashScheme:'canonical_json_sha256_not_raw_body_bytes';excludedEnvelopeFields:readonly string[];sides:InterventionReplaySide[]};
function data(x:unknown,seen=new Set<object>()):void{
 if(x===null||typeof x==='string'||typeof x==='boolean'||typeof x==='number'&&Number.isFinite(x))return;
 if(!x||typeof x!=='object'||seen.has(x))throw Error('replay_material_invalid');const a=Array.isArray(x),ks=Reflect.ownKeys(x);
 if(Object.getPrototypeOf(x)!==(a?Array.prototype:Object.prototype)||a&&ks.length!==(x as unknown[]).length+1)throw Error('replay_material_invalid');seen.add(x);
 for(const k of ks){if(a&&k==='length')continue;const d=Object.getOwnPropertyDescriptor(x,k)!;if(typeof k!=='string'||!d.enumerable||!Object.hasOwn(d,'value')||a&&(!/^(0|[1-9][0-9]*)$/.test(k)||Number(k)>=(x as unknown[]).length))throw Error('replay_material_invalid');data(d.value,seen);}seen.delete(x);
}
const exact=(x:any,keys:string[])=>!!x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const eq=(a:unknown,b:unknown)=>researchHash(a)===researchHash(b);
export async function pairedInterventionReplay(tape:InterventionReplayTape,own:ObservationInput,expectedModel:string,profile:ResearchTrialProfileV3):Promise<InterventionReplayResult>{
 const result:InterventionReplayResult={schemaVersion:'parity_intervention_replay_result_v1',status:'not_reached',error:null,commonEqual:false,policyConformant:false,recordedPayloadsReproduced:false,actualLunaHttpMeasured:false,hashScheme:'canonical_json_sha256_not_raw_body_bytes',excludedEnvelopeFields:EVIDENCE_NORMALIZED_ENVELOPE_FIELDS,sides:[]};
 // Native adapters deliberately close arbitrary errors. Retain our own material
 // failure separately so their sanitization cannot erase its classification.
 let materialFailure:ReplayError|null=null;
 const stop=(s:ReplayError):never=>{materialFailure??=s;throw Error(s);};
 try{
  data(tape);if(!exact(tape,['schemaVersion','state','events','common','tails','recorded'])||tape.schemaVersion!=='parity_intervention_replay_v1'||!exact(tape.tails,['repair-first','bypass-enabled'])||!exact(tape.recorded,['label','expectedRequests'])||!['repair-first','bypass-enabled'].includes(tape.recorded.label)||!Array.isArray(tape.recorded.expectedRequests)||!Array.isArray(tape.events)||!tape.events.length)stop('replay_material_invalid');
  if(!tape.common||!tape.tails['repair-first']||!tape.tails['bypass-enabled'])stop('replay_material_missing');
  for(const s of [tape.common,...Object.values(tape.tails)])if(!exact(s,['luna','jev','reobservations'])||!Array.isArray(s!.luna)||!Array.isArray(s!.jev)||!Array.isArray(s!.reobservations))stop('replay_material_invalid');
  data(own);data(profile);if(resolveInterventionPolicy(profile).profileId!=='research_trial_profile_v3'||typeof expectedModel!=='string'||!expectedModel)stop('replay_material_invalid');
  const replay=async(label:'repair-first'|'bypass-enabled')=>{
   const frozen=structuredClone(tape),tail=frozen.tails[label]!,segments={common:frozen.common,tail},indices={common:{luna:0,jev:0,reobservations:0},tail:{luna:0,jev:0,reobservations:0}};
   let finalOriginal=false,inAlternative=false,generated=false;let traces:JevTurnTrace[]=[];
   const material={state:structuredClone(frozen.state),events:structuredClone(frozen.events),common:structuredClone(frozen.common),tail:structuredClone(tail),own:{ownImage:imageProjection(own.ownImage),ownAnchors:structuredClone(own.ownAnchors)},model:expectedModel,profile:structuredClone(profile),boundary:{luna:'canonical_http_json',jev:'canonical_http_json',hashScheme:'canonical_json_sha256_not_raw_body_bytes'}};
   const side:InterventionReplaySide={label,material,materialSha256:researchHash(material),requests:[],executed:null,intervention:null};result.sides.push(side);
   const capture=(provider:'luna'|'jev',phase:string,body:any)=>{
    const payload=projectReplayValue(body,own.ownImage);let role:Role=!finalOriginal?'common':inAlternative?'alternative_detail':provider==='luna'&&phase==='generation'?'generation':'post_generation';
    side.requests.push({provider,phase,payload,payloadDomain:'canonical_http_json',payloadSha256:researchHash(payload),preProjectionPayloadSha256:researchHash(body),...(provider==='luna'?{completeMessagesSha256:researchHash(body.messages)}:{}),role});
   };
   const take=<K extends keyof ReplaySegment>(k:K):ReplaySegment[K][number]=>{const key=finalOriginal?'tail':'common',s=segments[key],i=indices[key][k]++;const n=s[k][i];if(n===undefined)stop('replay_material_missing');return structuredClone(n);};
   let lunaPhase='',lunaResponse:ReplayTape['luna'][number]['response'];
   const http=createChatClient({provider:'cloudflare',apiKey:'synthetic-offline-replay-key',purpose:profile.modelPolicy.purpose,baseUrl:'http://offline.invalid/v1',timeoutMs:profile.timeouts.lunaAttemptMs,maxCompletionTokens:profile.lunaRequest.maxCompletionTokens??undefined},async(_url,init)=>{
    capture('luna',lunaPhase,JSON.parse(String(init?.body)));return Response.json({model:lunaResponse.model,choices:[{message:{content:lunaResponse.text}}],usage:{prompt_tokens:lunaResponse.usage?.inputTokens,completion_tokens:lunaResponse.usage?.outputTokens}});
   });
   const client={async complete(messages:any[],options:any){const n=take('luna') as ReplayTape['luna'][number];if(n.phase!==options.phase)stop('replay_material_invalid');lunaPhase=options.phase;lunaResponse=n.response;if(lunaPhase==='generation')generated=true;return http.complete(messages,options);}};
   const fetchImpl=async(_url:any,init:any)=>{const b=JSON.parse(init.body),keys=Object.keys(b.questions),s=JSON.parse(b.state),phase=keys.includes('human_referent')?'human_referent':keys.some(k=>k.endsWith('_support'))?'ai_support':keys.some(k=>k.endsWith('_act'))?Object.hasOwn(s,'aiSeq')?'ai_function':'local_function':'decision';capture('jev',phase,b);return Response.json(take('jev'));};
   const readKey=async()=> 'sk-or-SYNTHETIC-offline-replay-key-0000';
   const native=createJevDecisionClient({enabled:true,readKey,fetchImpl,timeoutMs:profile.timeouts.decisionMs,researchLimits:{maxDeadlineMs:600000},questionLayout:profile.questionLayout})!;
   // Optional human-referent capability is absent only when no such recorded
   // response was supplied. It remains unknown, never a fabricated estimate.
   const hasReferent=frozen.common.jev.some(r=>Object.hasOwn((r.answers??{}) as object,'human_referent'));
   const jev={async decide(input:any,options:any){const d=await native.decide(input,options);if(d.action!=='request_observation'){
     for(const k of ['luna','jev','reobservations'] as const)if(indices.common[k]!==segments.common[k].length)stop('replay_unused_material');finalOriginal=true;}return d;},
    async completeDetail(input:any,selected:any,options:any){inAlternative=true;try{return await native.completeDetail!(input,selected,options);}finally{inAlternative=false;}},...(hasReferent?{estimateReferent:native.estimateReferent!.bind(native)}:{})};
   const runtime=createProfileDialogue(profile,{client,image:own.ownImage,anchors:[...own.ownAnchors],strategy:label,observer:{async observeAll(){return structuredClone(frozen.state.observationMemo!);},async reobserve(input){const next=take('reobservations') as any;await client.complete(buildReobservationMessages(input),{phase:'observation_targeted'});return next;}},jevDecision:jev,localGrounding:{classifier:createJevLocalTestClassifier({enabled:true,readKey,fetchImpl,timeoutMs:profile.timeouts.localMs,researchLimits:{maxDeadlineMs:600000}})!,aiPublicTransport:{readKey,fetchImpl,timeoutMs:profile.timeouts.decisionMs}},onJevTurnTrace:(t:JevTurnTrace)=>traces.push(t)});
   try{await runtime.runAiTurn({events:frozen.events,privateState:frozen.state,lastEventId:frozen.events.at(-1)!.id,requestSeq:frozen.events.at(-1)!.seq});}
   finally{const t=traces.at(-1);if(t){side.executed=structuredClone(t.executed??null);side.intervention=typeof t.intervention==='object'?structuredClone(t.intervention):null;}}
   if(!finalOriginal||!generated||!side.executed||!side.intervention)stop('replay_material_missing');
   for(const key of ['common','tail'] as const)for(const k of ['luna','jev','reobservations'] as const)if(indices[key][k]!==segments[key][k].length)stop('replay_unused_material');
   return side;
  };
  const a=await replay('repair-first'),b=await replay('bypass-enabled');
  const common=(s:InterventionReplaySide)=>({material:tape.common,requests:s.requests.filter(r=>r.role==='common')});
  const C=eq(common(a),common(b)),P=!!a.executed&&!!b.executed&&!!a.intervention&&!!b.intervention;
  const recorded=result.sides.find(s=>s.label===tape.recorded.label)!;
  const R=eq(recorded.requests.map(r=>({provider:r.provider,phase:r.phase,requestSha256:r.preProjectionPayloadSha256})),tape.recorded.expectedRequests.map(r=>({provider:r.provider,phase:r.phase,requestSha256:r.requestSha256})))&&tape.recorded.expectedRequests.every((r,i)=>!r.messagesSha256||r.messagesSha256===recorded.requests[i]?.completeMessagesSha256);
  const luna=tape.recorded.expectedRequests.filter(r=>r.provider==='luna'),M=R&&luna.length>0&&luna.every(r=>r.actualSendMeasured===true&&Array.isArray(r.sendIds)&&r.sendIds.length>0&&r.sendIds.every(id=>Number.isSafeInteger(id)&&id>0));
  Object.assign(result,{status:C&&P&&R?'same_material_intervention_verified':'same_material_intervention_mismatch',error:null,commonEqual:C,policyConformant:P,recordedPayloadsReproduced:R,actualLunaHttpMeasured:M});
 }catch(e){const m=e instanceof Error?e.message:'';result.error=materialFailure??(['replay_material_invalid','replay_material_missing','replay_unused_material'].includes(m)?m:'replay_pipeline_failed') as ReplayError;}
 return result;
}
