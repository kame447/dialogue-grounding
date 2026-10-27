// Node loopback only. Explicit private configuration; never an assignment method.
import { AsyncLocalStorage } from 'node:async_hooks';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createChatClient } from '../client.mjs';
import { NamingTaskError } from '../naming-error.mjs';
import { createTrialV2, modelView } from '../stimuli/scatter-v2.mjs';
import { STRATEGIES } from '../judgment/instructions.mjs';
import { data } from '../v2/base-assignment-data.ts';
import { privateDirectory, readPrivateAssignment } from './base-assignment-store.ts';
import { researchHash, researchTrialProfileV3 } from '../v2/research-profile.ts';
import type { ResearchTrialProfileV3 } from '../v2/research-profile.ts';
import { resolveInterventionPolicy } from '../intervention-policy.ts';
import { RESEARCH_MAX_DEADLINE_MS } from '../v2/research-timeouts.ts';
import { researchGenerationClient } from '../v2/research-generation-client.ts';
import { createObservationCache } from '../observation/cache.ts';
import type { ObservationCacheAudit } from '../observation/cache.ts';
import { createLunaObserver } from '../observation/observe.ts';
import type { ObservationInput, ObservationObserver } from '../observation/contract.ts';
import { createJevDecisionClient, JevDecisionError, validateRepairProspectMaterial } from '../decision/jev-decision.ts';
import type { JevDecisionClient, AdaptiveRepairTrial } from '../decision/contract.ts';
import { createJevLocalTestClassifier, JevLocalTestError } from '../local-grounding/jev-local-test.ts';
import type { JevTurnLocalOptions } from '../v2/jev-turn.ts';
import { RunBudget } from '../diagnostics/parity-live/audit.ts';
import type { BudgetLimits, SendReceipt } from '../diagnostics/parity-live/audit.ts';
import { checkModelIdentity, MODEL_CONTRACT_V2 } from '../model-identity-contract.ts';
import { DEFAULT_COST_CAP_USD } from '../diagnostics/jev-shadow-eval/local-openrouter.ts';
import { inferenceHistory } from '../v2/agreement-gate.ts';

export type JevResearchLedger = RunBudget;
export type JevResearchOptions = Readonly<{ profile: ResearchTrialProfileV3; observer: ObservationObserver;
  jevDecision: JevDecisionClient; localGrounding: JevTurnLocalOptions; ledger: JevResearchLedger; technicalTrial?: AdaptiveRepairTrial }>;
export class ParticipantJevError extends Error {
  readonly code: string;
  constructor(code: 'invalid_config' | 'wrong_own_material' | 'initialization_failed' | 'model_mismatch') {
    super(code); this.name = 'ParticipantJevError'; this.code = code;
  }
}
const invalid = (): never => { throw new NamingTaskError('invalid_options'); };
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const nonnegative = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
// Profile/config data must not run accessors while being compared with code-owned values.
function jsonData(value: unknown): unknown {
  if (value === null || ['string','boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonData);
  return Object.fromEntries(Object.entries(data(value)).map(([k,v]) => [k,jsonData(v)]));
}
function checkedTechnicalTrial(value: unknown): AdaptiveRepairTrial {
  const trial = data(value, ['version']);
  if (trial.version !== 'adaptive_repair_v1' && trial.version !== 'adaptive_repair_v2') throw Error();
  return { version: trial.version };
}
function checkedProfile(value: unknown): ResearchTrialProfileV3 {
  const profile = jsonData(value) as ResearchTrialProfileV3;
  if (resolveInterventionPolicy(profile).mode !== 'explicit') return invalid();
  const expected = researchTrialProfileV3(profile.lunaRequest, profile.timeouts);
  if (researchHash(profile) !== researchHash(expected)) return invalid();
  return expected;
}

/** R2: classify restore before any queue, initial observer, or model work. */
export function selectParticipantJev(restore: any, provided: unknown, context: {
  referenceMemory: boolean; strategy: string; style: string; legacy: unknown[];
}): JevResearchOptions | null {
  try {
    const marker = restore?.options?.jevResearch;
    if (restore) {
      if (marker !== undefined && marker !== true && marker !== false) return invalid();
      if (marker !== true) {
        const state = restore.queueState?.privateState;
        if (['profileSha256','interventionPolicy','technicalTrial'].some(k => Object.hasOwn(restore.options ?? {},k)) ||
            ['jevTraces','aiPublicSettlement','initialObservation','jevLedger'].some(k => Object.hasOwn(restore,k)) ||
            state && (['schemaVersion','interventionPolicy','observationMemo','repairHistory','aiPublic'].some(k=>Object.hasOwn(state,k)) ||
              state.judgments?.some((j: any) => j.jevTurn))) return invalid();
        return null;
      }
    }
    if (provided === null || provided === undefined) return marker === true ? invalid() : null;
    const raw = data(provided);
    const v = data(raw,['profile','observer','jevDecision','localGrounding','ledger',...(Object.hasOwn(raw,'technicalTrial')?['technicalTrial']:[])]);
    const technicalTrial = Object.hasOwn(v,'technicalTrial') ? checkedTechnicalTrial(v.technicalTrial) : undefined;
    // The frozen order is outer shape, explicit profile, memory, strategy.
    const profile = checkedProfile(v.profile);
    if (context.referenceMemory !== true) return invalid();
    if (!STRATEGIES.includes(context.strategy)) return invalid();
    if (context.legacy.some(v => v !== null && v !== undefined) || context.style !== profile.utteranceStyle) return invalid();
    const observer = v.observer as ObservationObserver, jevDecision = v.jevDecision as JevDecisionClient;
    const local = v.localGrounding as JevTurnLocalOptions;
    if (typeof observer?.observeAll !== 'function' || typeof observer.reobserve !== 'function' || typeof jevDecision?.decide !== 'function' ||
        typeof local?.classifier?.classify !== 'function' || local.timeoutMs !== profile.timeouts.localMs ||
        local.aiPublicClaims !== profile.localGrounding.aiPublicClaims || !(v.ledger instanceof RunBudget)) return invalid();
    if (restore) {
      const savedTrial = Object.hasOwn(restore.options,'technicalTrial') ? checkedTechnicalTrial(restore.options.technicalTrial) : undefined;
      if (JSON.stringify(savedTrial) !== JSON.stringify(technicalTrial)) return invalid();
      if (restore.options.profileSha256 !== researchHash(profile) ||
          researchHash(jsonData(restore.options.interventionPolicy)) !== researchHash(profile.interventionPolicy) ||
          restore.queueState?.privateState?.schemaVersion !== 'jev_private_state_v2' ||
          !restore.queueState?.privateState?.observationMemo || !Array.isArray(restore.jevTraces) ||
          !digest(restore.initialObservation?.memoSha256) || !Object.hasOwn(restore,'aiPublicSettlement') || !restore.jevLedger ||
          restore.jevTraces.some((trace:any)=>trace?.schemaVersion!=='jev_turn_trace_v2'||
            trace.intervention!==null&&!['bypass_acceptance_v1:accept','bypass_acceptance_v1:veto'].includes(trace.intervention?.policy)||
            !technicalTrial&&trace.intervention?.rerank?.policyId==='saved_action_scores_open_issue_v1')) return invalid();
      // Only adaptive_repair_v2 traces carry the agreement gate; their prospect was asked over the open entries.
      const v2 = technicalTrial?.version === 'adaptive_repair_v2';
      if (restore.jevTraces.some((trace:any)=>Object.hasOwn(trace,'repairGate') ? !v2 : v2 && Object.hasOwn(trace,'repairProspect'))) return invalid();
      for (const trace of restore.jevTraces) if (Object.hasOwn(trace,'repairProspect')) {
        if (!technicalTrial) return invalid();
        validateRepairProspectMaterial(trace.repairProspect,Object.hasOwn(trace,'repairGate')?inferenceHistory(trace.repairHistory,trace.repairGate):trace.repairHistory,trace.turnIndex);
      }
    }
    return {profile,observer,jevDecision,localGrounding:local,ledger:v.ledger,...(technicalTrial?{technicalTrial}:{})};
  } catch { return invalid(); }
}

const initialAudits = new WeakMap<ObservationObserver,{audit:ObservationCacheAudit;memoSha256:string}>();
export const participantInitialObservation = (observer: ObservationObserver) => structuredClone(initialAudits.get(observer) ?? null);
const researchLimits = Object.freeze({maxDeadlineMs:RESEARCH_MAX_DEADLINE_MS});

/** Only cache HIT can initialize a participant; reobserve is a separate capability. */
export async function createParticipantCacheObserver(options: {directory:string;modelId:string;memoSha256:string;
  own:ObservationInput;profile:ResearchTrialProfileV3;reobserver:ObservationObserver}): Promise<ObservationObserver> {
  const ownHash = researchHash(options.own);
  const cache = await createObservationCache({directory:options.directory,modelId:options.modelId,onMiss:'error',
    timeoutMs:options.profile.timeouts.observationMs,researchLimits});
  const check = (input: ObservationInput) => {
    if (researchHash(input) !== ownHash) throw new ParticipantJevError('wrong_own_material');
  };
  const observer: ObservationObserver = {
    async observeAll(input,callOptions) {
      check(input);
      try {
        const hit = await cache.get(input,callOptions), memoSha256 = researchHash(hit.memo);
        if (hit.audit.status !== 'HIT' || memoSha256 !== options.memoSha256) throw Error();
        initialAudits.set(observer,{audit:hit.audit,memoSha256});
        return hit.memo;
      } catch { throw new ParticipantJevError('initialization_failed'); }
    },
    async reobserve(input,callOptions) {
      check({ownImage:input.ownImage,ownAnchors:input.ownAnchors});
      return options.reobserver.reobserve(input,{...callOptions,timeoutMs:options.profile.timeouts.observationMs});
    },
  };
  return observer;
}

type Scope = {turn:number|null;phase:string|null;boundary:'common'|'tail'};
const contexts = new WeakMap<RunBudget,AsyncLocalStorage<Scope>>();
function scope(ledger:RunBudget) { let value=contexts.get(ledger);if(!value){value=new AsyncLocalStorage();contexts.set(ledger,value);}return value; }
export function withParticipantJevTurn<T>(ledger:RunBudget,turn:number,operation:()=>Promise<T>):Promise<T> {
  return scope(ledger).run({turn,phase:null,boundary:'common'},operation);
}
type ChatClient = {complete(messages:any[],options?:any):Promise<any>};
export function participantLunaClient(client:ChatClient,ledger:RunBudget,profile:ResearchTrialProfileV3):ChatClient {
  const timed=researchGenerationClient(client,profile.timeouts.generationMs);
  return {async complete(messages,options={}) {
    if (options.signal?.aborted) throw Object.assign(Error('aborted'),{name:'AbortError'});
    ledger.beforeSend();ledger.lunaCalls++;
    const parent=scope(ledger).getStore(),phase=options.phase ?? null;
    return scope(ledger).run({turn:parent?.turn??null,phase,boundary:['generation','final_submission','ai_extraction'].includes(phase)?'tail':parent?.boundary??'common'},
      ()=>timed.complete(messages,options));
  }};
}
async function jevOperation<T>(ledger:RunBudget,kind:string,operation:()=>Promise<T>):Promise<T> {
  ledger.beforeSend();
  try{return await operation();}catch(error){
    if(error instanceof JevDecisionError||error instanceof JevLocalTestError){
      ledger.refuse(kind,error.code);
      if(['cost_cap','cost_unreported','model_mismatch'].includes(error.code))ledger.stop(error.code);
    }
    throw error;
  }
}
type WireReceipt = SendReceipt & {requestSha256:string;requestedId:string;returnedId:string|null;version:string|null;boundary:'common'|'tail'};
const safeModel = (v:unknown):string|null => typeof v==='string' && v.length<=128 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(v)?v:null;
/** Reservations happen at the real POST boundary, including native client retries. */
export function participantLedgerFetch(ledger:RunBudget,provider:'luna'|'jev',expectedLunaModel:string,fetchImpl:typeof fetch):typeof fetch {
  return async (url,init={}) => {
    if ((init.method??'GET').toUpperCase()!=='POST') throw new ParticipantJevError('invalid_config');
    if (init.signal?.aborted) throw Object.assign(Error('aborted'),{name:'AbortError'});
    const context=scope(ledger).getStore();
    const body=JSON.parse(String(init.body));
    const entry=ledger.reserve(provider,context?.phase??(body.questions?.action?'decision':body.questions?.human_referent?'human_referent':'jev'),context?.turn??null) as WireReceipt;
    Object.assign(entry,{requestSha256:researchHash(body),requestedId:provider==='jev'?MODEL_CONTRACT_V2.requested:expectedLunaModel,
      returnedId:null,version:null,boundary:context?.boundary??'common'});
    ledger.sent(entry);
    try {
      const response=await fetchImpl(url,init);
      let payload:any=null;
      if(response.ok)try{payload=await response.clone().json();}catch{/* Account as unknown; never copy raw errors. */}
      const returnedId=safeModel(payload?.model);
      const identity=provider==='jev'?checkModelIdentity(MODEL_CONTRACT_V2.requested,payload?.model):null;
      const matches=provider==='jev'?identity?.status==='accepted':returnedId===expectedLunaModel;
      Object.assign(entry,{returnedId,version:identity?.version??null});
      const tokens=(value:unknown)=>nonnegative(value)?value:null;
      ledger.observe(entry,{model:returnedId,modelMatches:matches,
        costUsd:typeof payload?.usage?.cost==='number'&&Number.isFinite(payload.usage.cost)&&payload.usage.cost>=0?payload.usage.cost:null,
        inputTokens:tokens(payload?.usage?.prompt_tokens),outputTokens:tokens(payload?.usage?.completion_tokens)});
      if(response.ok&&!matches){ledger.stop('model_mismatch');throw new ParticipantJevError('model_mismatch');}
      return response;
    } catch(error) {ledger.unknown(entry);throw error;}
  };
}

/** R2: carry all reservations and observed thresholds across a process restart. */
export function restoreParticipantJevLedger(ledger:RunBudget,saved:any):void {
  try {
    if(researchHash(jsonData(saved.limits))!==researchHash(ledger.limits)||!nonnegative(saved.lunaCalls)||
      !Array.isArray(saved.sends)||!Array.isArray(saved.refusals)||!Array.isArray(saved.stops)||
      typeof saved.halted!=='boolean'||typeof saved.jevUnknown!=='boolean'||
      saved.haltReason!==null&&(typeof saved.haltReason!=='string'||!/^[a-z_]+$/u.test(saved.haltReason))) return invalid();
    const sends:SendReceipt[]=saved.sends.map((entry:any,i:number)=>{
      const s=jsonData(entry) as SendReceipt;
      if(s.id!==i+1||!['luna','jev'].includes(s.provider)||!['in_flight','sent_result_unknown','observed_response'].includes(s.status)||
        [s.costUsd,s.inputTokens,s.outputTokens].some(v=>v!==null&&(typeof v!=='number'||!Number.isFinite(v)||v<0)))return invalid();
      return s;
    });
    ledger.lunaCalls=saved.lunaCalls;ledger.halted=saved.halted;ledger.haltReason=saved.haltReason;ledger.jevUnknown=saved.jevUnknown;
    ledger.sends.splice(0,ledger.sends.length,...sends);
    ledger.refusals.splice(0,ledger.refusals.length,...structuredClone(saved.refusals));
    ledger.stops.splice(0,ledger.stops.length,...structuredClone(saved.stops));
    for(const send of ledger.sends)if(send.status==='in_flight')ledger.unknown(send);
    ledger.checkObservedLimits();
  }catch{return invalid();}
}

export type ParticipantJevConfig = {schemaVersion:'participant_jev_config_v1';lunaRequest:ResearchTrialProfileV3['lunaRequest'];
  timeouts:ResearchTrialProfileV3['timeouts'];cacheDirectory:string;modelId:string;memoSha256:string;seed:number;limits:BudgetLimits;technicalTrial?:AdaptiveRepairTrial};
export function validateParticipantJevConfig(value:unknown):{config:ParticipantJevConfig;profile:ResearchTrialProfileV3} {
  try {
    const raw=data(value);
    const c=jsonData(data(raw,['schemaVersion','lunaRequest','timeouts','cacheDirectory','modelId','memoSha256','seed','limits',...(Object.hasOwn(raw,'technicalTrial')?['technicalTrial']:[])])) as ParticipantJevConfig;
    if(Object.hasOwn(c,'technicalTrial'))c.technicalTrial=checkedTechnicalTrial(c.technicalTrial);
    if(c.schemaVersion!=='participant_jev_config_v1'||typeof c.cacheDirectory!=='string'||!safeModel(c.modelId)||!digest(c.memoSha256)||!Number.isSafeInteger(c.seed))throw Error();
    const limits=data(c.limits,['lunaCalls','lunaTokens','lunaPosts','jevPosts','jevUsd']);
    if(!['lunaCalls','lunaTokens','lunaPosts','jevPosts'].every(k=>positive(limits[k]))||typeof limits.jevUsd!=='number'||!Number.isFinite(limits.jevUsd)||limits.jevUsd<=0||limits.jevUsd>DEFAULT_COST_CAP_USD)throw Error();
    data(c.lunaRequest,['timeoutMs','maxCompletionTokens']);
    return {config:c,profile:researchTrialProfileV3(c.lunaRequest,c.timeouts)};
  }catch{throw new ParticipantJevError('invalid_config');}
}

/** Called before listen(). Returns a per-task factory, so trials never share a budget. */
export async function prepareParticipantJev(options:{configFile:string;baseAssignmentFile:string;clientConfig:any;
  utteranceStyle?:string;activeDecision?:unknown;groundingShadow?:unknown;fetchImpl?:typeof fetch;
  readKey?:()=>Promise<string>;createClient?:typeof createChatClient}) {
  try {
    await privateDirectory(dirname(options.configFile));
    const handle=await open(options.configFile,constants.O_RDONLY|constants.O_NOFOLLOW);
    let raw:unknown;
    try{const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o777)!==0o600||stat.size>32768)throw Error();raw=JSON.parse(await handle.readFile('utf8'));}finally{await handle.close();}
    const {config,profile}=validateParticipantJevConfig(raw);
    if((options.utteranceStyle??'default')!==profile.utteranceStyle||options.activeDecision||options.groundingShadow)throw Error();
    const assignment=await readPrivateAssignment(options.baseAssignmentFile);
    if(!assignment.referenceMemory||assignment.seed!==config.seed||!STRATEGIES.includes(assignment.strategy))throw Error();
    const model=modelView(createTrialV2({seed:config.seed}));
    const own:ObservationInput={ownImage:{mimeType:model.mimeType,base64:model.png.toString('base64')},ownAnchors:model.anchors};
    const absent:ObservationObserver={async observeAll(){throw Error();},async reobserve(){throw Error();}};
    const startup=await createParticipantCacheObserver({directory:config.cacheDirectory,modelId:config.modelId,memoSha256:config.memoSha256,own,profile,reobserver:absent});
    await startup.observeAll(own);
    const fetchImpl=options.fetchImpl??globalThis.fetch;
    if(options.clientConfig?.provider!=='cloudflare'||options.clientConfig?.purpose!=='dialogue_turn')throw Error();
    // A single free GET; config cannot select a URL or a model for completions.
    const response=await fetchImpl(new URL(options.clientConfig.baseUrl.replace(/\/+$/u,'')+'/model-policy'),{
      method:'GET',redirect:'error',headers:{Authorization:'Bearer '+options.clientConfig.apiKey},signal:AbortSignal.timeout(profile.timeouts.lunaAttemptMs)});
    if(!response.ok)throw Error();
    const policy=data(await response.json());
    if(policy.ready!==true||policy.purpose!=='dialogue_turn'||typeof policy.provider!=='string'||!['openai','gemini'].includes(policy.provider)||policy.model!==config.modelId)throw Error();
    return {config,profile,async taskOptions(value:{seed:number;referenceMemory:boolean;strategy:string;restore?:any}) {
      // An old assigned record stays on the original caller's client and options.
      if(value.restore&&value.restore.options?.jevResearch!==true)return {};
      if(value.seed!==config.seed||value.referenceMemory!==true||!STRATEGIES.includes(value.strategy))throw new ParticipantJevError('invalid_config');
      const ledger=new RunBudget(config.limits);
      const {maxCompletionTokens:_oldOutputLimit,...baseClientConfig}=options.clientConfig;
      const native=(options.createClient??createChatClient)({...baseClientConfig,timeoutMs:profile.timeouts.lunaAttemptMs,
        ...(profile.lunaRequest.maxCompletionTokens===null?{}:{maxCompletionTokens:profile.lunaRequest.maxCompletionTokens})},
        participantLedgerFetch(ledger,'luna',config.modelId,fetchImpl));
      const jevFetch=participantLedgerFetch(ledger,'jev',config.modelId,fetchImpl);
      const transport={...(options.readKey?{readKey:options.readKey}:{}),fetchImpl:jevFetch,costCapUsd:config.limits.jevUsd,
        timeoutMs:profile.timeouts.decisionMs,researchLimits};
      const aiPublicTransport={...transport,fetchImpl:(url:string,init:RequestInit)=>{
        const parent=scope(ledger).getStore(),questions=JSON.parse(String(init.body)).questions;
        const phase=Object.keys(questions).some(key=>key.endsWith('_support'))?'ai_support':'ai_function';
        return scope(ledger).run({turn:parent?.turn??null,phase,boundary:'tail'},()=>jevFetch(url,init));
      }};
      const nativeDecision=createJevDecisionClient({enabled:true,...transport,questionLayout:profile.questionLayout})!;
      const {estimateRepairProspect:_prospect,...nativeWithoutProspect}=nativeDecision;
      const jevDecision={...nativeWithoutProspect,
        get lastEvidence(){return nativeDecision.lastEvidence;},get lastReferentEvidence(){return nativeDecision.lastReferentEvidence;},
        get spentUsd(){return nativeDecision.spentUsd;},get callCount(){return nativeDecision.callCount;},
        get referentCallCount(){return nativeDecision.referentCallCount;},
        decide:(...args:Parameters<typeof nativeDecision.decide>)=>jevOperation(ledger,'jev_decision',()=>nativeDecision.decide(...args)),
        estimateReferent:(...args:Parameters<typeof nativeDecision.estimateReferent>)=>jevOperation(ledger,'jev_referent',()=>nativeDecision.estimateReferent(...args)),
        ...(config.technicalTrial ? {estimateRepairProspect:(...args:Parameters<typeof nativeDecision.estimateRepairProspect>)=>{
          const parent=scope(ledger).getStore();
          return scope(ledger).run({turn:parent?.turn??null,phase:'jev_prospect',boundary:'common'},
            ()=>jevOperation(ledger,'jev_prospect',()=>nativeDecision.estimateRepairProspect(...args)));
        }} : {}),
        completeDetail:(...args:Parameters<typeof nativeDecision.completeDetail>)=>{
        const parent=scope(ledger).getStore();
        return scope(ledger).run({turn:parent?.turn??null,phase:'alternative_detail',boundary:'tail'},()=>jevOperation(ledger,'jev_detail',()=>nativeDecision.completeDetail(...args)));
      }};
      // Logical phase timers remain outside; the native transport gets the common attempt limit.
      const client:ChatClient={complete:(messages,callOptions={})=>native.complete(messages,{...callOptions,timeoutMs:profile.timeouts.lunaAttemptMs})};
      const observer=await createParticipantCacheObserver({directory:config.cacheDirectory,modelId:config.modelId,memoSha256:config.memoSha256,own,profile,
        reobserver:createLunaObserver(participantLunaClient(client,ledger,profile),{timeoutMs:profile.timeouts.observationMs,researchLimits})});
      const classifier=createJevLocalTestClassifier({enabled:true,...transport})!;
      const jevResearch:JevResearchOptions={profile,observer,jevDecision,
        localGrounding:{classifier:{...classifier,get lastEvidence(){return classifier.lastEvidence;},get spentUsd(){return classifier.spentUsd;},
          get callCount(){return classifier.callCount;},classify:(...args:Parameters<typeof classifier.classify>)=>jevOperation(ledger,'jev_local',()=>classifier.classify(...args))},timeoutMs:profile.timeouts.localMs,
          researchLimits,aiPublicClaims:profile.localGrounding.aiPublicClaims,aiPublicTransport},ledger,...(config.technicalTrial?{technicalTrial:config.technicalTrial}:{})};
      return {client,jevResearch};
    }};
  }catch{throw new ParticipantJevError('invalid_config');}
}
