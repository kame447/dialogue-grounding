// Record-only research V2 validator; no producer/runtime/transport execution.
import { canonical, equal, assertion, row } from './core.ts';
import type { Check, Records } from './core.ts';
import { failureKind } from './failure-records.ts';
const exact=(v:any,ks:string[])=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===ks.length&&ks.every(k=>Object.hasOwn(v,k));
const num=(v:any)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const pos=(v:any)=>num(v)&&v>0;
const nullable=(v:any,p:(v:any)=>boolean)=>v===null||p(v);
const list=(v:any)=>Array.isArray(v)&&Object.keys(v).length===v.length;
const cause=(v:any)=>typeof v==='string'&&['phase_deadline','trial_deadline','attempt_timeout','caller_abort','network','unknown'].includes(v);
function invalid():never{throw Object.assign(Error('invalid_deadline_records'),{code:'invalid_deadline_records'});}
const freeze=(v:any):any=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const configKeys=['observationMs','localMs','decisionMs','lunaAttemptMs','generationMs','trialMs'];
function config(v:any):boolean{return exact(v,configKeys)&&configKeys.every(k=>pos(v[k])&&v[k]<=(k==='trialMs'?3600000:600000))&&v.lunaAttemptMs<=85000&&configKeys.filter(k=>k!=='trialMs').every(k=>v.trialMs>v[k]);}
function deadlines(d:any):boolean{
  try{canonical(d);}catch{return false;}
  if(!exact(d,['configured','applied','measured'])||!config(d.configured)||!exact(d.applied,['observationOuterMs','completeCalls','sends'])||
    !exact(d.measured,['clock','origin','wallStartedAt','elapsedMs','sends','calls'])||d.measured.clock!=='monotonic_ms'||typeof d.measured.origin!=='string'||!['warmup_start','trial_start'].includes(d.measured.origin)||
    typeof d.measured.wallStartedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(d.measured.wallStartedAt)||!Number.isFinite(Date.parse(d.measured.wallStartedAt))||!num(d.measured.elapsedMs)||
    !nullable(d.applied.observationOuterMs,pos)||d.applied.observationOuterMs!==null&&d.applied.observationOuterMs!==d.configured.observationMs||
    ![d.applied.completeCalls,d.applied.sends,d.measured.calls,d.measured.sends].every(list))return false;
  const trial=(v:any)=>d.measured.origin==='warmup_start'?v===null:num(v),calls=new Map<any,any>();
  for(const c of d.applied.completeCalls){if(!exact(c,['callId','callOptionTimeoutMs','startedAtMs','phaseRemainingMs','trialRemainingMs','outerAppliedMs'])||!pos(c.callId)||calls.has(c.callId)||
    !nullable(c.callOptionTimeoutMs,x=>pos(x)&&x<=600000)||!num(c.startedAtMs)||c.startedAtMs>d.measured.elapsedMs||!nullable(c.phaseRemainingMs,num)||!trial(c.trialRemainingMs)||!nullable(c.outerAppliedMs,pos))return false;
    const terms=[c.phaseRemainingMs,c.trialRemainingMs].filter(x=>x!==null);if(terms.length&&c.outerAppliedMs!==(Math.min(...terms)<1?null:Math.min(...terms)))return false;calls.set(c.callId,c);}
  const mc=new Set<any>();for(const c of d.measured.calls){if(!exact(c,['callId','adopted','endCause'])||!calls.has(c.callId)||mc.has(c.callId)||typeof c.adopted!=='boolean'||!nullable(c.endCause,cause)||c.adopted&&c.endCause!==null)return false;mc.add(c.callId);}if(mc.size!==calls.size)return false;
  const measured=new Map<any,any>();for(const m of d.measured.sends){if(!exact(m,['callId','attemptIndex','sendId','sentAtMs','terminal','lateObservation'])||!pos(m.callId)||!num(m.attemptIndex)||m.attemptIndex>2)return false;const k=m.callId+':'+m.attemptIndex;if(measured.has(k))return false;measured.set(k,m);}
  const ids=new Set(),next=new Map();
  for(const a of d.applied.sends){if(!exact(a,['callId','attemptIndex','sendId','startedAtMs','phaseRemainingMs','trialRemainingMs','configuredAttemptMs','appliedMs','deadlineAtMs','limitedBy'])||
    !calls.has(a.callId)||!num(a.attemptIndex)||a.attemptIndex>2||a.attemptIndex!==(next.get(a.callId)??0)||!num(a.startedAtMs)||a.startedAtMs<calls.get(a.callId).startedAtMs||
    !nullable(a.phaseRemainingMs,num)||!trial(a.trialRemainingMs)||a.configuredAttemptMs!==d.configured.lunaAttemptMs)return false;next.set(a.callId,a.attemptIndex+1);
    const k=a.callId+':'+a.attemptIndex,m=measured.get(k);if(!m||m.sendId!==a.sendId||!exact(m.terminal,['outcome','cause','terminalAtMs','elapsedMs']))return false;measured.delete(k);const t=m.terminal;
    if(a.sendId===null){if(a.appliedMs!==null||a.deadlineAtMs!==null||a.limitedBy!==null||m.sentAtMs!==null||t.outcome!=='refused_before_send'||typeof t.cause!=='string'||!['phase_deadline','trial_deadline','caller_abort'].includes(t.cause)||t.terminalAtMs!==null||t.elapsedMs!==null||m.lateObservation!==null)return false;continue;}
    if(!pos(a.sendId)||ids.has(a.sendId)||!pos(a.appliedMs)||!num(a.deadlineAtMs)||a.deadlineAtMs!==a.startedAtMs+a.appliedMs||!num(m.sentAtMs)||m.sentAtMs<a.startedAtMs||m.sentAtMs>=a.deadlineAtMs||!num(t.terminalAtMs)||t.terminalAtMs<m.sentAtMs||!num(t.elapsedMs)||t.elapsedMs!==t.terminalAtMs-a.startedAtMs||t.terminalAtMs>d.measured.elapsedMs)return false;ids.add(a.sendId);
    const minimum=Math.min(a.configuredAttemptMs,a.phaseRemainingMs??Infinity,a.trialRemainingMs??Infinity),limiter=a.trialRemainingMs===minimum?'trial':a.phaseRemainingMs===minimum?'phase':'attempt';if(a.appliedMs!==minimum||a.limitedBy!==limiter)return false;
    const pairs:any={returned:[null],timeout:['attempt_timeout'],network:['network'],aborted:['phase_deadline','trial_deadline','caller_abort'],unknown:['unknown']};if(typeof t.outcome!=='string'||!Object.hasOwn(pairs,t.outcome)||!pairs[t.outcome].includes(t.cause))return false;
    if(t.outcome==='returned'&&t.terminalAtMs>=a.deadlineAtMs||!(t.terminalAtMs===a.deadlineAtMs&&limiter==='attempt'&&t.cause==='caller_abort')&&t.terminalAtMs>=a.deadlineAtMs&&t.cause!==({attempt:'attempt_timeout',phase:'phase_deadline',trial:'trial_deadline'} as any)[limiter])return false;
    const l=m.lateObservation;if(l!==null&&(!exact(l,['headersAtMs','bodyCompletedAtMs','usageRecorded'])||!nullable(l.headersAtMs,num)||!nullable(l.bodyCompletedAtMs,num)||typeof l.usageRecorded!=='boolean'||l.headersAtMs===null&&l.bodyCompletedAtMs===null||l.bodyCompletedAtMs!==null&&(l.headersAtMs===null||l.bodyCompletedAtMs<l.headersAtMs)||l.usageRecorded&&l.bodyCompletedAtMs===null||Math.max(l.headersAtMs??0,l.bodyCompletedAtMs??0)<t.terminalAtMs||Math.max(l.headersAtMs??0,l.bodyCompletedAtMs??0)>d.measured.elapsedMs))return false;
  }
  return measured.size===0;
}
export function validateResearchFailureV2(value:unknown):object{
  try{canonical(value);}catch{invalid();}const f=value as any;
  if(!f||f.schemaVersion!=='parity_live_failure_v2')invalid();
  if(f.scope==='after_warmup'){
    if(!exact(f,['schemaVersion','scope','code','stage','trialOrder','deadlines'])||typeof f.code!=='string'||!(/^[a-zA-Z0-9_:.\-]{1,160}$/u).test(f.code)||!['trial_loop','unknown'].includes(f.stage)||typeof f.stage!=='string'||
      (f.trialOrder===null?f.deadlines!==null:!num(f.trialOrder)||!deadlines(f.deadlines)||f.deadlines.measured.origin!=='trial_start'))invalid();
  }else{
    if(!exact(f,['schemaVersion','scope','code','stage','calls','cache','observationCallStarted','policy','http','deadlines'])||f.scope!=='warmup'||!deadlines(f.deadlines)||f.deadlines.measured.origin!=='warmup_start')invalid();
    const proxy={...f,schemaVersion:'parity_live_failure_v1',deadlines:{configured:{observationMs:f.deadlines.configured.observationMs,lunaClientTimeoutMs:null},applied:{observationOuterMs:f.deadlines.applied.observationOuterMs,completeCalls:f.deadlines.applied.completeCalls.map((c:any)=>({callId:c.callId,callOptionTimeoutMs:c.callOptionTimeoutMs}))}}};
    if(failureKind(proxy)!=='warmup')invalid();
  }
  return freeze(structuredClone(f));
}
const idset=(xs:any[])=>new Set(xs);
const sameIds=(a:any[],b:any[])=>a.length===b.length&&idset(a).size===a.length&&idset(b).size===b.length&&a.every(v=>b.includes(v));
const sendkey=(v:any)=>v.callId+':'+v.attemptIndex;
// ADDENDUM04: an explicitly supplied envelope activates BOTH existing joins.
function accountingInput(r:any):{active:boolean;reason:string|null}{
  const own=(v:any,k:string)=>v!==null&&v!==undefined&&Object.hasOwn(v,k);
  const plain=(v:any)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
  const json=(v:any)=>{try{canonical(v);return true;}catch{return false;}};
  const budgetPresent=own(r.summary,'budget'),evidencePresent=own(r,'evidence');
  if(!budgetPresent&&!evidencePresent)return {active:false,reason:null};
  const budget=r.summary?.budget,evidence=r.evidence;
  if(budgetPresent&&(!plain(budget)||!json(budget))||evidencePresent&&(!plain(evidence)||!json(evidence)))return {active:true,reason:'invalid_deadline_records'};
  for(const [envelope,key] of [[budget,'sends'],[evidence,'events']] as const){
    if(own(envelope,key)&&(!list(envelope[key])||!envelope[key].every((v:any)=>plain(v)&&json(v))))return {active:true,reason:'invalid_deadline_records'};
  }
  return {active:true,reason:!budgetPresent||!evidencePresent||!own(budget,'sends')||!own(evidence,'events')?'deadline_required_records_missing':null};
}
function transition(prior:any,next:any):boolean{
  if(!equal(prior.deadlines.configured,next.deadlines.configured)||!equal(prior.deadlines.measured.clock,next.deadlines.measured.clock)||!equal(prior.deadlines.measured.origin,next.deadlines.measured.origin)||
    !equal(prior.deadlines.measured.wallStartedAt,next.deadlines.measured.wallStartedAt)||next.deadlines.measured.elapsedMs<prior.deadlines.measured.elapsedMs||prior.scopeClosed&&!next.scopeClosed||
    prior.closedCallIds.some((v:any,i:number)=>next.closedCallIds[i]!==v))return false;
  const a=prior.deadlines,b=next.deadlines;
  if(a.applied.observationOuterMs!==b.applied.observationOuterMs&&!(a.applied.observationOuterMs===null&&b.applied.observationOuterMs===b.configured.observationMs&&!prior.scopeClosed))return false;
  for(const [part,key] of [['completeCalls','callId'],['sends','send']] as const){const old=a.applied[part],cur=b.applied[part];if(prior.scopeClosed&&old.length!==cur.length)return false;for(const x of old){const y=cur.find((v:any)=>key==='send'?sendkey(v)===sendkey(x):v.callId===x.callId);if(!y||!equal(x,y))return false;}}
  for(const x of a.measured.calls){const y=b.measured.calls.find((v:any)=>v.callId===x.callId);if(!y||prior.closedCallIds.includes(x.callId)&&!equal(x,y))return false;}
  for(const x of a.measured.sends){const y=b.measured.sends.find((v:any)=>sendkey(v)===sendkey(x));if(!y||x.sendId!==y.sendId||x.sentAtMs!==y.sentAtMs||!equal(x.terminal,y.terminal))return false;
    const l=x.lateObservation,n=y.lateObservation;if(l!==null&&(n===null||l.headersAtMs!==null&&l.headersAtMs!==n.headersAtMs||l.bodyCompletedAtMs!==null&&l.bodyCompletedAtMs!==n.bodyCompletedAtMs||l.usageRecorded&&!n.usageRecorded))return false;}
  return true;
}
export function researchDeadlineChecks(records:Records):Check[]{
  if(records===null||typeof records!=='object'||Array.isArray(records))return [assertion('research.deadlines.failure',false,'invalid_deadline_records')];
  const r=records as any;if(!['research_trial_profile_v2','research_trial_profile_v3'].includes(r.run?.profile?.id)&&r.failure?.schemaVersion!=='parity_live_failure_v2'&&![2,3].includes(r.run?.manifest?.schemaVersion))return [];
  const out:Check[]=[],add=(id:string,ok:boolean,reason='invalid_deadline_records')=>out.push(assertion(id,ok,ok?'deadline_records_consistent':reason));
  if(!Array.isArray(r.trials)||r.trials.some((t:any)=>t===null||typeof t!=='object'||Array.isArray(t)||!num(t.order))||new Set(r.trials.map((t:any)=>t.order)).size!==r.trials.length){add('research.deadlines.failure',false);return out;}
  const cfg=r.run?.profile?.timeouts;add('research.deadlines.configured',config(cfg),cfg===undefined?'deadline_required_records_missing':'invalid_deadline_records');
  if(!config(cfg))return out;
  const accounting=accountingInput(r);
  const owners=new Map<any,any>();if(r.warmup)owners.set(null,r.warmup);else if(r.failure?.scope==='warmup')owners.set(null,{...r.failure,http:r.failure.http?.records});
  if(Array.isArray(r.trials))for(const t of r.trials)owners.set(t.order,t);
  const orphanEvent=accounting.active&&!accounting.reason&&r.evidence.events.some((e:any)=>e.type==='send'&&e.provider==='luna'&&
    ![...owners.values()].some((o:any)=>Array.isArray(o.calls)&&o.calls.some((c:any)=>c?.provider==='luna'&&c.id===e.callId)));
  function binding(d:any,owner:any,final:boolean):boolean{
    if(orphanEvent||!owner||!Array.isArray(owner.calls)||!Array.isArray(owner.http)||!equal(d.configured,cfg))return false;
    if(!owner.calls.every((c:any)=>c!==null&&typeof c==='object'&&!Array.isArray(c))||!owner.http.every((h:any)=>h!==null&&typeof h==='object'&&!Array.isArray(h)))return false;
    const calls=owner.calls.filter((c:any)=>c.provider==='luna'),http=owner.http.filter((h:any)=>h.method==='POST'&&h.kind==='completion_post');
    const allCallIds=calls.map((c:any)=>c.id),actualIds=http.map((h:any)=>h.sendId),a=d.applied,m=d.measured;
    // Owner snapshots and journal snapshots are separate views of ONE scope.
    const source=owner.deadlines;
    if(source){
      if(!deadlines(source)||!equal(source.configured,d.configured)||source.measured.origin!==m.origin||source.measured.wallStartedAt!==m.wallStartedAt)return false;
      for(const part of ['completeCalls','sends']){
        const key=(v:any)=>part==='completeCalls'?v.callId:sendkey(v);
        if(final&&!sameIds(a[part].map(key),source.applied[part].map(key)))return false;
        for(const v of a[part]){const original=source.applied[part].find((x:any)=>key(v)===key(x));if(!original||!equal(v,original))return false;}
      }
      if(final&&m.calls.some((v:any)=>!equal(v,source.measured.calls.find((x:any)=>x.callId===v.callId))))return false;
      for(const v of m.sends){const original=source.measured.sends.find((x:any)=>sendkey(v)===sendkey(x));
        if(!original||v.sendId!==original.sendId||v.sentAtMs!==original.sentAtMs||!equal(v.terminal,original.terminal))return false;
        const old=original.lateObservation,next=v.lateObservation;
        if(old!==null){if(final&&next===null)return false;if(next!==null&&(old.headersAtMs!==null&&next.headersAtMs!==null&&old.headersAtMs!==next.headersAtMs||old.bodyCompletedAtMs!==null&&next.bodyCompletedAtMs!==null&&old.bodyCompletedAtMs!==next.bodyCompletedAtMs||final&&(old.headersAtMs!==null&&next.headersAtMs===null||old.bodyCompletedAtMs!==null&&next.bodyCompletedAtMs===null||old.usageRecorded&&!next.usageRecorded)))return false;}
      }
    }

    if(final?!sameIds(a.completeCalls.map((c:any)=>c.callId),allCallIds):a.completeCalls.some((c:any)=>!allCallIds.includes(c.callId)))return false;
    if(final?!sameIds(a.sends.filter((s:any)=>s.sendId!==null).map((s:any)=>s.sendId),actualIds):a.sends.some((s:any)=>s.sendId!==null&&!actualIds.includes(s.sendId)))return false;
    for(const h of http){const c=calls.find((c:any)=>c.id===h.callId);if(!c||!Array.isArray(c.sendIds)||!c.sendIds.includes(h.sendId))return false;
      if(accounting.active){const b=r.summary.budget.sends.find((b:any)=>b.id===h.sendId);if(!b||b.provider!=='luna'||b.logicalCallId!==h.callId)return false;}
      if(accounting.active&&!r.evidence.events.some((e:any)=>e.type==='send'&&e.provider==='luna'&&e.callId===h.callId&&e.sendId===h.sendId))return false;}
    if(accounting.active){const actual=r.evidence.events.filter((e:any)=>e.type==='send'&&e.provider==='luna'&&allCallIds.includes(e.callId));if(!sameIds(actual.map((e:any)=>e.sendId),actualIds))return false;}
    for(const s of a.sends.filter((s:any)=>s.sendId!==null)){if(!http.some((h:any)=>h.callId===s.callId&&h.sendId===s.sendId))return false;}
    for(const c of m.calls){const source=calls.find((s:any)=>s.id===c.callId);if(!source||source.status==='error'&&c.adopted)return false;}
    return true;
  }
  for(const [order,owner] of owners){const id=order===null?'research.deadlines.warmup':'research.deadlines.trial.'+order,d=owner.deadlines;
    if(!d||!Array.isArray(owner.calls)||!Array.isArray(owner.http)){add(id,false,'deadline_required_records_missing');continue;}
    if(!deadlines(d)){add(id,false);continue;}if(accounting.reason){add(id,false,accounting.reason);continue;}add(id,binding(d,owner,true)&&d.measured.origin===(order===null?'warmup_start':'trial_start'),'deadline_binding_mismatch');}
  if(r.failure?.schemaVersion==='parity_live_failure_v2'){
    const fallback=r.failure.scope==='warmup'&&!r.warmup?out.find(c=>c.id==='research.deadlines.warmup'):undefined;
    // The fallback owner IS this failure: preserve its detailed join diagnosis.
    // Standalone validateResearchFailureV2 still rejects its closed schema.
    if(fallback?.status==='mismatch')add('research.deadlines.failure',false,fallback.reason);
    else try{validateResearchFailureV2(r.failure);const f=r.failure;if(f.scope==='after_warmup'&&f.trialOrder!==null){const own=owners.get(f.trialOrder);add('research.deadlines.failure',!!own&&!accounting.reason&&binding(f.deadlines,own,true),own?accounting.reason??'deadline_binding_mismatch':'deadline_required_records_missing');}
      else add('research.deadlines.failure',true);
    }catch{add('research.deadlines.failure',false);}
  }
  const journal=r.deadlineRevisions;if(!Array.isArray(journal)||!journal.length){add('research.deadlines.journal',false,'deadline_required_records_missing');return out;}
  const latest=new Map<any,any>(),history=new Map<any,any>(),callOwners=new Map<number,number|null>(),sendOwners=new Map<number,number|null>();
  for(let i=0;i<journal.length;i++){const j=journal[i],id='research.deadlines.journal.'+i;
    if(!exact(j,['schemaVersion','revision','trialOrder','deadlines','closedCallIds','scopeClosed'])||j.schemaVersion!=='parity_live_deadline_revision_v2'||!pos(j.revision)||!nullable(j.trialOrder,num)||!deadlines(j.deadlines)||
      !Array.isArray(j.closedCallIds)||!sameIds(j.closedCallIds,[...new Set(j.closedCallIds)])||!j.closedCallIds.every(pos)||typeof j.scopeClosed!=='boolean'||j.deadlines.measured.origin!==(j.trialOrder===null?'warmup_start':'trial_start')){add(id,false);continue;}
    const owner=owners.get(j.trialOrder);if(!owner){add(id,false,'deadline_required_records_missing');continue;}
    if(j.closedCallIds.some((v:any)=>!j.deadlines.measured.calls.some((c:any)=>c.callId===v))||j.scopeClosed&&!sameIds(j.closedCallIds,j.deadlines.measured.calls.map((c:any)=>c.callId))){add(id,false,'deadline_binding_mismatch');continue;}
    if(j.revision!==i+1){add(id,false,'deadline_revision_conflict');continue;}
    const callIds=j.deadlines.applied.completeCalls.map((c:any)=>c.callId),sendIds=j.deadlines.applied.sends.filter((s:any)=>s.sendId!==null).map((s:any)=>s.sendId);
    if(callIds.some((v:number)=>callOwners.has(v)&&callOwners.get(v)!==j.trialOrder)||sendIds.some((v:number)=>sendOwners.has(v)&&sendOwners.get(v)!==j.trialOrder)){add(id,false,'deadline_revision_conflict');continue;}
    for(const v of callIds)callOwners.set(v,j.trialOrder);
    for(const v of sendIds)sendOwners.set(v,j.trialOrder);
    const before=history.get(j.trialOrder);if(before&&!transition(before,j)){add(id,false,'deadline_revision_conflict');continue;}
    // Comparable history survives an external owner mismatch, but is not a
    // validated latest snapshot and cannot satisfy the final completeness gate.
    history.set(j.trialOrder,j);
    if(owner.deadlines&&!deadlines(owner.deadlines)){add(id,false);continue;}
    if(owner.deadlines&&j.closedCallIds.some((id:any)=>!equal(j.deadlines.measured.calls.find((c:any)=>c.callId===id),owner.deadlines.measured.calls.find((c:any)=>c.callId===id)))){add(id,false,'deadline_binding_mismatch');continue;}
    if(accounting.reason){add(id,false,accounting.reason);continue;}
    if(!binding(j.deadlines,owner,j.scopeClosed)){add(id,false,'deadline_binding_mismatch');continue;}
    latest.set(j.trialOrder,j);add(id,true);
  }
  add('research.deadlines.journal',[...owners.keys()].every(k=>latest.get(k)?.scopeClosed===true),'deadline_required_records_missing');
  return out;
}
