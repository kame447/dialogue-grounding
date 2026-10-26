// Explicit technical R policy. The original remains Jev's decision; no semantic oracle.
import {JEV_ACTIONS} from './contract.ts';
import type {JevAction,JevDecision,JevDecisionInput,JevTarget,JevExecutedDecision,JevDetailResult,JevDecisionStageEvidence} from './contract.ts';
import {buildJevDecisionPayload,buildJevDecisionDetailPayload,validateJevDecision,parseJevExecutedDetail,JevDecisionError} from './jev-decision.ts';

export const BYPASS_ACCEPTANCE_V1_CANONICAL_JSON = '{"policies":{"bypass-enabled":{"policy":"bypass_acceptance_v1:accept","vetoActions":[]},"repair-first":{"policy":"bypass_acceptance_v1:veto","vetoActions":["defer","move_on"]}},"version":"bypass_acceptance_v1"}';
export const BYPASS_ACCEPTANCE_V1_TABLE_SHA256 = '376d569120ca36a3eceaf5ab95410f7eb83f25fbb681e7566a684b97c35165c8';
function freeze<T>(v:T):T {if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
export const BYPASS_ACCEPTANCE_V1 = freeze(JSON.parse(BYPASS_ACCEPTANCE_V1_CANONICAL_JSON) as {
 version:'bypass_acceptance_v1'; policies:Record<'repair-first'|'bypass-enabled',{
 policy:'bypass_acceptance_v1:accept'|'bypass_acceptance_v1:veto';vetoActions:JevAction[]}>;
});
export type ExecutedDecision=JevExecutedDecision;
export type InterventionConfig={policy:'bypass_acceptance_v1:accept'|'bypass_acceptance_v1:veto';vetoActions:readonly JevAction[];tableSha256:string};
export type Rerank={policyId:'saved_action_scores_v1';ranking:readonly {action:ExecutedDecision['action'];score:number}[];selected:{action:ExecutedDecision['action'];target:JevTarget}|null};
export type AcceptancePlan={original:ExecutedDecision;policy:InterventionConfig['policy'];disposition:'adopted'|'rejected';reasonCode:'no_intervention'|'not_in_veto_set'|'vetoed_bypass_action';rerank:Rerank|null};
const DETAIL_CODES=['invalid_options','invalid_input','invalid_response','invalid_decision','inconsistent_decision','model_mismatch','key_unavailable','key_leak','unauthorized','payment_required','not_found','rate_limited','upstream_error','network_error','timeout','aborted','cost_cap','cost_unreported','busy'] as const;
export type InterventionInner={stage:'rerank'|'detail'|'executed';code:'invalid_scores'|'no_valid_alternative'|'detail_unavailable'|'invalid_executed'|typeof DETAIL_CODES[number]};
export type InterventionTrace={schemaVersion:'jev_intervention_v1';policy:InterventionConfig['policy'];disposition:'adopted'|'rejected';reasonCode:AcceptancePlan['reasonCode']|'alternative_failed';original:ExecutedDecision;rerank:Rerank|null;alternative:ExecutedDecision|null;detailEvidence:JevDecisionStageEvidence|null;failure:{reasonCode:'alternative_failed';inner:InterventionInner}|null};
export type AcceptanceResult={executed:ExecutedDecision;intervention:InterventionTrace};
export type DetailResult=JevDetailResult;
export type CompleteDetail=(input:JevDecisionInput,selected:{action:ExecutedDecision['action'];target:JevTarget})=>Promise<DetailResult>;
type ErrorCode='invalid_intervention'|'invalid_input'|'invalid_original'|'invalid_detail_callback'|'alternative_failed';
export class BypassAcceptanceError extends Error {
 readonly code:ErrorCode;readonly intervention:InterventionTrace|null;
 constructor(code:ErrorCode,intervention:InterventionTrace|null=null){super(code);this.name='BypassAcceptanceError';this.code=code;this.intervention=intervention===null?null:freeze(structuredClone(intervention));}
}
function fail(code:ErrorCode):never {throw new BypassAcceptanceError(code);}
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
// Inspect descriptors, never invoke a getter or stringify an untrusted value.
function jsonData(v:unknown,seen=new Set<object>()):void {
 if(v===null||typeof v==='string'||typeof v==='boolean')return;
 if(typeof v==='number'&&Number.isFinite(v))return;
 if(!v||typeof v!=='object'||seen.has(v))throw Error();
 const array=Array.isArray(v);
 if(Object.getPrototypeOf(v)!==(array?Array.prototype:Object.prototype))throw Error();
 const keys=Reflect.ownKeys(v);if(array&&(keys.length!==(v as unknown[]).length+1||!keys.includes('length')))throw Error();
 seen.add(v);
 for(const key of keys){if(array&&key==='length')continue;const d=Object.getOwnPropertyDescriptor(v,key)!;
  if(typeof key!=='string'||!d.enumerable||!Object.hasOwn(d,'value')||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=(v as unknown[]).length))throw Error();jsonData(d.value,seen);}
 seen.delete(v);
}
function boundary<T>(v:unknown,code:ErrorCode,check:(v:unknown)=>T):T {try{jsonData(v);return check(v);}catch{throw new BypassAcceptanceError(code);}}
function equal(a:unknown,b:unknown):boolean {
 if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
 const ak=Object.keys(a).sort(),bk=Object.keys(b).sort();return ak.length===bk.length&&ak.every((k,i)=>k===bk[i]&&equal((a as Record<string,unknown>)[k],(b as Record<string,unknown>)[k]));
}
export function interventionForStrategy(strategy:unknown):InterventionConfig {
 if(strategy!=='repair-first'&&strategy!=='bypass-enabled')fail('invalid_intervention');
 return freeze({...structuredClone(BYPASS_ACCEPTANCE_V1.policies[strategy]),tableSha256:BYPASS_ACCEPTANCE_V1_TABLE_SHA256});
}
function config(v:unknown):InterventionConfig {return boundary(v,'invalid_intervention',value=>{
 if(!exact(value,['policy','vetoActions','tableSha256']))fail('invalid_intervention');
 const expected=value.policy==='bypass_acceptance_v1:accept'?interventionForStrategy('bypass-enabled'):value.policy==='bypass_acceptance_v1:veto'?interventionForStrategy('repair-first'):null;
 if(!expected||!equal(value,expected))fail('invalid_intervention');return expected;
});}
function project(d:JevDecision):ExecutedDecision {return {action:d.action as ExecutedDecision['action'],target:structuredClone(d.target),name:d.name,feature:d.feature,observe:null,...(Object.hasOwn(d,'detailFigureIds')?{detailFigureIds:[...d.detailFigureIds!]}:{})};}
function prepare(input:unknown,original:unknown,intervention:unknown){
 const policy=config(intervention);
 const i=boundary(input,'invalid_input',value=>{const optional=['reobservationAllowed','humanReferent'].filter(k=>!!value&&typeof value==='object'&&Object.hasOwn(value,k));
  if(!exact(value,['turn','publicTurns','ownSlots','observations','issueSummary','priorClaims','repairHistory','previousAction','publicNames',...optional]))fail('invalid_input');
  buildJevDecisionPayload(value as JevDecisionInput);return structuredClone(value) as JevDecisionInput;});
 const d=boundary(original,'invalid_original',value=>{const valid=validateJevDecision(value,i);if(valid.action==='request_observation')fail('invalid_original');return valid;});
 return {input:i,decision:d,config:policy,original:project(d)};
}
type Context=ReturnType<typeof prepare>;
function trace(p:AcceptancePlan,alternative:ExecutedDecision|null=null,detailEvidence:JevDecisionStageEvidence|null=null):InterventionTrace{return {schemaVersion:'jev_intervention_v1',policy:p.policy,disposition:p.disposition,reasonCode:p.reasonCode,original:p.original,rerank:p.rerank,alternative,detailEvidence,failure:null};}
function alternativeFailed(p:AcceptancePlan,inner:InterventionInner):never {throw new BypassAcceptanceError('alternative_failed',{...trace(p),disposition:'rejected',reasonCode:'alternative_failed',failure:{reasonCode:'alternative_failed',inner}});}
function plan(ctx:Context):AcceptancePlan {
 const {input,decision,config,original}=ctx;
 const p:AcceptancePlan={original,policy:config.policy,disposition:'adopted',reasonCode:config.policy==='bypass_acceptance_v1:accept'?'no_intervention':'not_in_veto_set',rerank:null};
 if(!config.vetoActions.includes(original.action))return freeze(p);
 p.disposition='rejected';p.reasonCode='vetoed_bypass_action';
 const scores=decision.evidence.stages?.[0]?.scores.action;
 if(decision.decisionKind!=='jev_local_test'||!scores)alternativeFailed(p,{stage:'rerank',code:'invalid_scores'});
 const ranking:Rerank['ranking'][number][]=[];
 for(const action of JEV_ACTIONS){
  if(action==='request_observation'||config.vetoActions.includes(action))continue;
  if(action==='revisit'&&original.target.kind==='none')continue;
  try{buildJevDecisionDetailPayload(input,{action,target:original.target});}
  catch(e){if(e instanceof JevDecisionError&&['invalid_decision','inconsistent_decision'].includes(e.code))continue;fail('invalid_input');}
  ranking.push({action,score:scores[action]});
 }
 ranking.sort((a,b)=>b.score-a.score||JEV_ACTIONS.indexOf(a.action)-JEV_ACTIONS.indexOf(b.action));
 p.rerank={policyId:'saved_action_scores_v1',ranking,selected:ranking.length?{action:ranking[0].action,target:structuredClone(original.target)}:null};
 if(!p.rerank.selected)alternativeFailed(p,{stage:'rerank',code:'no_valid_alternative'});
 return freeze(p);
}
export function planBypassAcceptance(input:unknown,original:unknown,intervention:unknown):AcceptancePlan{return plan(prepare(input,original,intervention));}
function detailCode(e:unknown):InterventionInner {
 try {
  const d=e&&typeof e==='object'?Object.getOwnPropertyDescriptor(e,'code'):undefined;
  if(e instanceof JevDecisionError&&d&&Object.hasOwn(d,'value')&&DETAIL_CODES.some(code=>code===d.value))return {stage:'detail',code:d.value};
 } catch { /* Hostile proxies/errors cannot escape the closed failure record. */ }
 return {stage:'detail',code:'invalid_response'};
}
export async function applyBypassAcceptance(input:unknown,original:unknown,intervention:unknown,completeDetail?:CompleteDetail):Promise<AcceptanceResult>{
 const ctx=prepare(input,original,intervention);
 if(completeDetail!==undefined&&typeof completeDetail!=='function')fail('invalid_detail_callback');
 const p=plan(ctx);
 if(p.disposition==='adopted')return freeze({executed:p.original,intervention:trace(p)});
 const selected=p.rerank!.selected!;
 if(!['propose_name','agree','confirm','repair'].includes(selected.action)){
  const executed:ExecutedDecision={...selected,name:null,feature:null,observe:null,detailFigureIds:[]};
  return freeze({executed,intervention:trace(p,executed)});
 }
 if(!completeDetail)alternativeFailed(p,{stage:'detail',code:'detail_unavailable'});
 let raw:unknown;
 try{raw=await completeDetail(freeze(structuredClone(ctx.input)),freeze(structuredClone(selected)));}catch(e){alternativeFailed(p,detailCode(e));}
 let checked:DetailResult;
 try{jsonData(raw);if(!exact(raw,['executed','evidence']))throw Error();checked=structuredClone(raw) as DetailResult;}
 catch{alternativeFailed(p,{stage:'detail',code:'invalid_response'});}
 let expected:ExecutedDecision;
 try{expected=parseJevExecutedDetail(ctx.input,selected,checked.evidence);}catch(e){alternativeFailed(p,detailCode(e));}
 if(!equal(checked.executed,expected))alternativeFailed(p,{stage:'executed',code:'invalid_executed'});
 return freeze({executed:expected,intervention:trace(p,expected,checked.evidence)});
}
