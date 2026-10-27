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
// Temporary local copy of SHARED-TYPES-r1; contract.ts is owned by B1.
export type RepairProspectMaterial=
 | {status:'ok';issue:{choice:'issue';turn:number;issueId:string|null}|{choice:'none'}|{choice:'unknown'};
    prospect:'progressing'|'stalled'|'uncertain'|'no_open_issue';
    basis:'new_information'|'candidate_narrowed'|'candidate_widened'|'repetition'|'partner_uncertain'|'other_figure_benefit'|'none';
    scores:{repair_issue:Record<string,number>;prospect:Record<string,number>;basis:Record<string,number>}}
 | {status:'unknown';issue:null;prospect:null;basis:null;scores:null};
export type BypassAcceptanceInput=JevDecisionInput&{repairProspect?:RepairProspectMaterial};
export type BypassAcceptanceOptions={rerank?:'saved_action_scores_v1'|'open_issue_v1'};
type Ranking=readonly {action:ExecutedDecision['action'];score:number}[];
type Selection={action:ExecutedDecision['action'];target:JevTarget}|null;
export type OpenIssueRerank={policyId:'saved_action_scores_open_issue_v1';ranking:Ranking;selected:Selection;source:{issueTurn:number;issueId:string|null;choice:'issue';candidates:string[]}};
export type Rerank={policyId:'saved_action_scores_v1';ranking:Ranking;selected:Selection}|OpenIssueRerank;
export type AcceptancePlan={original:ExecutedDecision;policy:InterventionConfig['policy'];disposition:'adopted'|'rejected';reasonCode:'no_intervention'|'not_in_veto_set'|'vetoed_bypass_action';rerank:Rerank|null};
const DETAIL_CODES=['invalid_options','invalid_input','invalid_response','invalid_decision','inconsistent_decision','model_mismatch','key_unavailable','key_leak','unauthorized','payment_required','not_found','rate_limited','upstream_error','network_error','timeout','aborted','cost_cap','cost_unreported','busy'] as const;
export type InterventionInner={stage:'rerank'|'detail'|'executed';code:'invalid_scores'|'no_valid_alternative'|'detail_unavailable'|'invalid_executed'|typeof DETAIL_CODES[number]};
export type InterventionTrace={schemaVersion:'jev_intervention_v1';policy:InterventionConfig['policy'];disposition:'adopted'|'rejected';reasonCode:AcceptancePlan['reasonCode']|'alternative_failed';original:ExecutedDecision;rerank:Rerank|null;alternative:ExecutedDecision|null;detailEvidence:JevDecisionStageEvidence|null;failure:{reasonCode:'alternative_failed';inner:InterventionInner}|null};
export type AcceptanceResult={executed:ExecutedDecision;intervention:InterventionTrace};
export type DetailResult=JevDetailResult;
export type CompleteDetail=(input:JevDecisionInput,selected:{action:ExecutedDecision['action'];target:JevTarget})=>Promise<DetailResult>;
type ErrorCode='invalid_intervention'|'invalid_input'|'invalid_original'|'invalid_detail_callback'|'invalid_options'|'alternative_failed';
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
function checkRepairProspect(value:unknown):void {
 if(!exact(value,['status','issue','prospect','basis','scores']))fail('invalid_input');
 if(value.status==='unknown'){
  if([value.issue,value.prospect,value.basis,value.scores].some(v=>v!==null))fail('invalid_input');return;
 }
 if(value.status!=='ok'||!['progressing','stalled','uncertain','no_open_issue'].includes(value.prospect as string)||
  !['new_information','candidate_narrowed','candidate_widened','repetition','partner_uncertain','other_figure_benefit','none'].includes(value.basis as string))fail('invalid_input');
 const issue=value.issue;
 if(exact(issue,['choice','turn','issueId'])){
  if(issue.choice!=='issue'||!Number.isSafeInteger(issue.turn)||(issue.turn as number)<1||!(issue.issueId===null||typeof issue.issueId==='string'&&issue.issueId.length>0&&issue.issueId.length<=128))fail('invalid_input');
 }else if(!exact(issue,['choice'])||!['none','unknown'].includes(issue.choice as string))fail('invalid_input');
 if(!exact(value.scores,['repair_issue','prospect','basis']))fail('invalid_input');
 for(const scores of Object.values(value.scores)){
  if(!scores||Object.getPrototypeOf(scores)!==Object.prototype||Array.isArray(scores)||Object.values(scores).some(n=>typeof n!=='number'||!Number.isFinite(n)||n<0||n>1))fail('invalid_input');
 }
}
function prepare(input:unknown,original:unknown,intervention:unknown){
 const policy=config(intervention);
 const i=boundary(input,'invalid_input',value=>{const optional=['reobservationAllowed','humanReferent','repairProspect'].filter(k=>!!value&&typeof value==='object'&&Object.hasOwn(value,k));
  if(!exact(value,['turn','publicTurns','ownSlots','observations','issueSummary','priorClaims','repairHistory','previousAction','publicNames',...optional]))fail('invalid_input');
  if(Object.hasOwn(value,'repairProspect'))checkRepairProspect(value.repairProspect);
  buildJevDecisionPayload(value as JevDecisionInput);return structuredClone(value) as BypassAcceptanceInput;});
 const d=boundary(original,'invalid_original',value=>{const valid=validateJevDecision(value,i);if(valid.action==='request_observation')fail('invalid_original');return valid;});
 return {input:i,decision:d,config:policy,original:project(d)};
}
type Context=ReturnType<typeof prepare>;
function trace(p:AcceptancePlan,alternative:ExecutedDecision|null=null,detailEvidence:JevDecisionStageEvidence|null=null):InterventionTrace{return {schemaVersion:'jev_intervention_v1',policy:p.policy,disposition:p.disposition,reasonCode:p.reasonCode,original:p.original,rerank:p.rerank,alternative,detailEvidence,failure:null};}
function alternativeFailed(p:AcceptancePlan,inner:InterventionInner):never {throw new BypassAcceptanceError('alternative_failed',{...trace(p),disposition:'rejected',reasonCode:'alternative_failed',failure:{reasonCode:'alternative_failed',inner}});}
function rerankOption(options:BypassAcceptanceOptions|undefined):BypassAcceptanceOptions['rerank'] {
 if(options===undefined)return 'saved_action_scores_v1';
 return boundary(options,'invalid_options',v=>{
  if(!exact(v,Object.hasOwn(v as object,'rerank')?['rerank']:[])||Object.hasOwn(v,'rerank')&&!['saved_action_scores_v1','open_issue_v1'].includes(v.rerank as string))fail('invalid_options');
  return v.rerank as BypassAcceptanceOptions['rerank']??'saved_action_scores_v1';
 });
}
function sameTarget(a:JevTarget,b:JevTarget):boolean {
 if(a.kind!==b.kind)return false;
 if(a.kind==='multiple'&&b.kind==='multiple')return equal([...a.figureIds].sort(),[...b.figureIds].sort());
 return equal(a,b);
}
function openIssueRerank(input:BypassAcceptanceInput,scores:Record<string,number>):OpenIssueRerank|null {
 const material=input.repairProspect;
 if(material?.status!=='ok'||material.issue.choice!=='issue')return null;
 const issue=material.issue;
 const entry=input.repairHistory.find(r=>r.turn<input.turn&&r.turn===issue.turn&&r.issueId===issue.issueId);
 if(!entry?.candidatesAfter.length)return null;
 const target:JevTarget=entry.candidatesAfter.length===1?{kind:'single',figureId:entry.candidatesAfter[0]}:{kind:'multiple',figureIds:[...entry.candidatesAfter]};
 const revisit=input.previousAction?.action==='defer'&&sameTarget(input.previousAction.target,target);
 const ranking:Ranking[number][]=[];
 for(const action of JEV_ACTIONS){
  if(action!=='repair'&&action!=='confirm'&&!(action==='revisit'&&revisit))continue;
  try{buildJevDecisionDetailPayload(input,{action,target});}
  catch(e){if(e instanceof JevDecisionError&&['invalid_decision','inconsistent_decision'].includes(e.code))continue;fail('invalid_input');}
  ranking.push({action,score:scores[action]});
 }
 ranking.sort((a,b)=>b.score-a.score||JEV_ACTIONS.indexOf(a.action)-JEV_ACTIONS.indexOf(b.action));
 return ranking.length?{policyId:'saved_action_scores_open_issue_v1',ranking,selected:{action:ranking[0].action,target},source:{issueTurn:entry.turn,issueId:entry.issueId,choice:'issue',candidates:[...entry.candidatesAfter]}}:null;
}
/** Checks only the new rerank proof. Restore still validates native evidence,
 * executions and detail evidence in the surrounding private-state validator.
 * The request catalog is not retained, so omitted unexecutable candidates cannot
 * be reconstructed here. Revisit requires the preceding committed execution.
 */
export function isOpenIssueRerankRecord(intervention:unknown,decision:unknown,executed:unknown,ownSlots:readonly string[],
 previousAction?:{action:JevAction;target:JevTarget}|null):boolean {
 try{
  jsonData([intervention,decision,executed,ownSlots,previousAction??null]);
  if(!Array.isArray(ownSlots)||!ownSlots.length||ownSlots.some(id=>typeof id!=='string'||!id.length)||new Set(ownSlots).size!==ownSlots.length)return false;
  const ownTarget=(v:unknown,allowNone=false):v is JevTarget=>{
   if(exact(v,['kind']))return allowNone&&v.kind==='none';
   if(exact(v,['kind','figureId']))return v.kind==='single'&&ownSlots.includes(v.figureId as string);
   return exact(v,['kind','figureIds'])&&v.kind==='multiple'&&Array.isArray(v.figureIds)&&v.figureIds.length>=2&&
    new Set(v.figureIds).size===v.figureIds.length&&v.figureIds.every(id=>ownSlots.includes(id));
  };
  const t=intervention as InterventionTrace,d=decision as JevDecision,e=executed as ExecutedDecision;
  if(!exact(t,['schemaVersion','policy','disposition','reasonCode','original','rerank','alternative','detailEvidence','failure'])||
   t.schemaVersion!=='jev_intervention_v1'||t.policy!=='bypass_acceptance_v1:veto'||t.disposition!=='rejected'||
   t.reasonCode!=='vetoed_bypass_action'||t.failure!==null||!d||d.decisionKind!=='jev_local_test'||!['defer','move_on'].includes(d.action)||
   !ownTarget(d.target,true)||!equal(t.original,project(d))||!equal(t.alternative,e))return false;
  const r=t.rerank;
  if(!r||r.policyId!=='saved_action_scores_open_issue_v1'||!exact(r,['policyId','ranking','selected','source'])||
   !exact(r.source,['issueTurn','issueId','choice','candidates'])||r.source.choice!=='issue'||!Number.isSafeInteger(r.source.issueTurn)||r.source.issueTurn<1||
   // The issue's candidates are recorded at decision time; later history updates never redefine the target.
   !Array.isArray(r.source.candidates)||!ownTarget(e?.target)||!equal(e.target,r.source.candidates.length===1?{kind:'single',figureId:r.source.candidates[0]}:{kind:'multiple',figureIds:r.source.candidates})||
   !(r.source.issueId===null||typeof r.source.issueId==='string'&&r.source.issueId.length>0&&r.source.issueId.length<=128)||
   !e||!ownTarget(e.target)||!equal(r.selected,{action:e.action,target:e.target})||!Array.isArray(r.ranking)||!r.ranking.length)return false;
  const scores=d.evidence?.stages?.[0]?.scores?.action;
  if(d.evidence?.stages?.[0]?.stage!=='action_target'||!(exact(scores,[...JEV_ACTIONS])||exact(scores,JEV_ACTIONS.filter(a=>a!=='request_observation')))||
   Object.values(scores).some(n=>typeof n!=='number'||!Number.isFinite(n)||n<0||n>1))return false;
  const revisit=previousAction?.action==='defer'&&ownTarget(previousAction.target)&&sameTarget(previousAction.target,e.target);
  const actions=new Set<string>();let previous:Ranking[number]|null=null;
  for(const raw of r.ranking){
   if(!exact(raw,['action','score']))return false;
   const a=raw as unknown as Ranking[number];
   if(!['repair','confirm',...(revisit?['revisit']:[])].includes(a.action)||actions.has(a.action)||
    typeof a.score!=='number'||a.score!==scores[a.action]||previous&&(a.score>previous.score||a.score===previous.score&&JEV_ACTIONS.indexOf(a.action)<JEV_ACTIONS.indexOf(previous.action)))return false;
   actions.add(a.action);previous=a;
  }
  return r.ranking[0].action===e.action&&actions.has('confirm')===actions.has('repair')&&actions.has('revisit')===revisit;
 }catch{return false;}
}
function plan(ctx:Context,rerank:BypassAcceptanceOptions['rerank']):AcceptancePlan {
 const {input,decision,config,original}=ctx;
 const p:AcceptancePlan={original,policy:config.policy,disposition:'adopted',reasonCode:config.policy==='bypass_acceptance_v1:accept'?'no_intervention':'not_in_veto_set',rerank:null};
 if(!config.vetoActions.includes(original.action))return freeze(p);
 p.disposition='rejected';p.reasonCode='vetoed_bypass_action';
 const scores=decision.evidence.stages?.[0]?.scores.action;
 if(decision.decisionKind!=='jev_local_test'||!scores)alternativeFailed(p,{stage:'rerank',code:'invalid_scores'});
 if(rerank==='open_issue_v1'){
  const open=openIssueRerank(input,scores);if(open){p.rerank=open;return freeze(p);}
 }
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
export function planBypassAcceptance(input:unknown,original:unknown,intervention:unknown,options?:BypassAcceptanceOptions):AcceptancePlan{return plan(prepare(input,original,intervention),rerankOption(options));}
function detailCode(e:unknown):InterventionInner {
 try {
  const d=e&&typeof e==='object'?Object.getOwnPropertyDescriptor(e,'code'):undefined;
  if(e instanceof JevDecisionError&&d&&Object.hasOwn(d,'value')&&DETAIL_CODES.some(code=>code===d.value))return {stage:'detail',code:d.value};
 } catch { /* Hostile proxies/errors cannot escape the closed failure record. */ }
 return {stage:'detail',code:'invalid_response'};
}
export async function applyBypassAcceptance(input:unknown,original:unknown,intervention:unknown,completeDetail?:CompleteDetail,options?:BypassAcceptanceOptions):Promise<AcceptanceResult>{
 const ctx=prepare(input,original,intervention);
 if(completeDetail!==undefined&&typeof completeDetail!=='function')fail('invalid_detail_callback');
 const p=plan(ctx,rerankOption(options));
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
