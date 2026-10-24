// Intrinsic producer-side schema. The record verifier derives its own bindings.
import { validateResearchTimeouts } from '../../v2/research-timeouts.ts';
import type { ResearchTimeoutsV2 } from '../../v2/research-timeouts.ts';
export type Cause = 'phase_deadline'|'trial_deadline'|'attempt_timeout'|'caller_abort'|'network'|'unknown';
export type Origin = 'warmup_start'|'trial_start';
export type AppliedCall = {callId:number;callOptionTimeoutMs:number|null;startedAtMs:number;phaseRemainingMs:number|null;trialRemainingMs:number|null;outerAppliedMs:number|null};
export type AppliedSend = {callId:number;attemptIndex:number;sendId:number|null;startedAtMs:number;phaseRemainingMs:number|null;trialRemainingMs:number|null;configuredAttemptMs:number;appliedMs:number|null;deadlineAtMs:number|null;limitedBy:'attempt'|'phase'|'trial'|null};
export type Terminal = {outcome:'returned'|'timeout'|'network'|'aborted'|'unknown'|'refused_before_send';cause:Cause|null;terminalAtMs:number|null;elapsedMs:number|null};
export type MeasuredSend = {callId:number;attemptIndex:number;sendId:number|null;sentAtMs:number|null;terminal:Terminal;lateObservation:null|{headersAtMs:number|null;bodyCompletedAtMs:number|null;usageRecorded:boolean}};
export type MeasuredCall = {callId:number;adopted:boolean;endCause:Cause|null};
export type ResearchDeadlines = {configured:ResearchTimeoutsV2;applied:{observationOuterMs:number|null;completeCalls:AppliedCall[];sends:AppliedSend[]};measured:{clock:'monotonic_ms';origin:Origin;wallStartedAt:string;elapsedMs:number;sends:MeasuredSend[];calls:MeasuredCall[]}};
export function invalid():never {throw Object.assign(Error('invalid_deadline_records'),{code:'invalid_deadline_records'});}
export const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
export const positive=(v:unknown):v is number=>integer(v)&&v>0;
export const cause=(v:unknown):v is Cause=>typeof v==='string'&&['phase_deadline','trial_deadline','attempt_timeout','caller_abort','network','unknown'].includes(v);
export const exact=(v:any,keys:string[]):boolean=>!!v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)!,'value'));
const array=(v:any):v is any[]=>Array.isArray(v)&&Object.keys(v).length===v.length;
const nullable=(v:any,p:(x:any)=>boolean)=>v===null||p(v);
export function frozenCopy<T>(v:T):T {const copy=structuredClone(v);const freeze=(x:any):any=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};return freeze(copy);}
export function parseDeadlines(value:unknown):ResearchDeadlines {
  const d=value as ResearchDeadlines;
  if(!exact(d,['configured','applied','measured']))invalid();
  try{validateResearchTimeouts(d.configured);}catch{invalid();}
  if(!exact(d.applied,['observationOuterMs','completeCalls','sends'])||!exact(d.measured,['clock','origin','wallStartedAt','elapsedMs','sends','calls'])||
    !nullable(d.applied.observationOuterMs,positive)||d.applied.observationOuterMs!==null&&d.applied.observationOuterMs!==d.configured.observationMs||
    !array(d.applied.completeCalls)||!array(d.applied.sends)||!array(d.measured.calls)||!array(d.measured.sends)||
    d.measured.clock!=='monotonic_ms'||!['warmup_start','trial_start'].includes(d.measured.origin)||typeof d.measured.origin!=='string'||
    typeof d.measured.wallStartedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(d.measured.wallStartedAt)||!Number.isFinite(Date.parse(d.measured.wallStartedAt))||!integer(d.measured.elapsedMs))invalid();
  const trial=(v:any)=>d.measured.origin==='warmup_start'?v===null:integer(v);
  const calls=new Map<number,AppliedCall>();
  for(const c of d.applied.completeCalls){
    if(!exact(c,['callId','callOptionTimeoutMs','startedAtMs','phaseRemainingMs','trialRemainingMs','outerAppliedMs'])||!positive(c.callId)||calls.has(c.callId)||
      !nullable(c.callOptionTimeoutMs,x=>positive(x)&&x<=600000)||!integer(c.startedAtMs)||!nullable(c.phaseRemainingMs,integer)||!trial(c.trialRemainingMs)||!nullable(c.outerAppliedMs,positive)||c.startedAtMs>d.measured.elapsedMs)invalid();
    const remain=[c.phaseRemainingMs,c.trialRemainingMs].filter((x):x is number=>x!==null);
    if(remain.length&&c.outerAppliedMs!==(Math.min(...remain)<1?null:Math.min(...remain)))invalid();
    calls.set(c.callId,c);
  }
  const measuredCalls=new Set<number>();
  for(const c of d.measured.calls){if(!exact(c,['callId','adopted','endCause'])||!calls.has(c.callId)||measuredCalls.has(c.callId)||typeof c.adopted!=='boolean'||!nullable(c.endCause,cause)||c.adopted&&c.endCause!==null)invalid();measuredCalls.add(c.callId);}
  if(measuredCalls.size!==calls.size)invalid();
  const measured=new Map<string,MeasuredSend>();
  for(const s of d.measured.sends){if(!exact(s,['callId','attemptIndex','sendId','sentAtMs','terminal','lateObservation'])||!positive(s.callId)||!integer(s.attemptIndex)||s.attemptIndex>2)invalid();const key=s.callId+':'+s.attemptIndex;if(measured.has(key))invalid();measured.set(key,s);}
  const sends=new Set<number>(),indices=new Map<number,number>();
  for(const s of d.applied.sends){
    if(!exact(s,['callId','attemptIndex','sendId','startedAtMs','phaseRemainingMs','trialRemainingMs','configuredAttemptMs','appliedMs','deadlineAtMs','limitedBy'])||
      !calls.has(s.callId)||!integer(s.attemptIndex)||s.attemptIndex>2||s.attemptIndex!==(indices.get(s.callId)??0)||!integer(s.startedAtMs)||
      !nullable(s.phaseRemainingMs,integer)||!trial(s.trialRemainingMs)||s.configuredAttemptMs!==d.configured.lunaAttemptMs||s.startedAtMs<calls.get(s.callId)!.startedAtMs)invalid();
    indices.set(s.callId,s.attemptIndex+1);const key=s.callId+':'+s.attemptIndex,m=measured.get(key);if(!m||m.sendId!==s.sendId)invalid();measured.delete(key);
    const t=m.terminal;
    if(!exact(t,['outcome','cause','terminalAtMs','elapsedMs']))invalid();
    if(s.sendId===null){
      if(s.appliedMs!==null||s.deadlineAtMs!==null||s.limitedBy!==null||m.sentAtMs!==null||t.outcome!=='refused_before_send'||
        !['phase_deadline','trial_deadline','caller_abort'].includes(t.cause as string)||typeof t.cause!=='string'||t.terminalAtMs!==null||t.elapsedMs!==null||m.lateObservation!==null)invalid();
    }else{
      if(!positive(s.sendId)||sends.has(s.sendId)||!positive(s.appliedMs)||!integer(s.deadlineAtMs)||s.deadlineAtMs!==s.startedAtMs+s.appliedMs||
        !integer(m.sentAtMs)||m.sentAtMs<s.startedAtMs||m.sentAtMs>=s.deadlineAtMs||!integer(t.terminalAtMs)||t.terminalAtMs<m.sentAtMs||
        !integer(t.elapsedMs)||t.elapsedMs!==t.terminalAtMs-s.startedAtMs||t.terminalAtMs>d.measured.elapsedMs)invalid();
      sends.add(s.sendId);const candidates=[{kind:'attempt',ms:s.configuredAttemptMs},{kind:'phase',ms:s.phaseRemainingMs},{kind:'trial',ms:s.trialRemainingMs}].filter(x=>x.ms!==null);
      const min=Math.min(...candidates.map(x=>x.ms!)),limiter=[...candidates].reverse().find(x=>x.ms===min)!.kind;
      if(s.appliedMs!==min||s.limitedBy!==limiter)invalid();
      const pairs:Record<string,Array<Cause|null>>={returned:[null],timeout:['attempt_timeout'],network:['network'],aborted:['phase_deadline','trial_deadline','caller_abort'],unknown:['unknown']};
      if(typeof t.outcome!=='string'||!Object.hasOwn(pairs,t.outcome)||!pairs[t.outcome].includes(t.cause))invalid();
      if(t.outcome==='returned'&&t.terminalAtMs>=s.deadlineAtMs)invalid();
      if(!(t.terminalAtMs===s.deadlineAtMs&&s.limitedBy==='attempt'&&t.cause==='caller_abort')&&t.terminalAtMs>=s.deadlineAtMs&&t.cause!==({attempt:'attempt_timeout',phase:'phase_deadline',trial:'trial_deadline'} as const)[s.limitedBy as 'attempt'|'phase'|'trial'])invalid();
      if(m.lateObservation!==null){const l=m.lateObservation;if(!exact(l,['headersAtMs','bodyCompletedAtMs','usageRecorded'])||!nullable(l.headersAtMs,integer)||!nullable(l.bodyCompletedAtMs,integer)||typeof l.usageRecorded!=='boolean'||
        l.headersAtMs===null&&l.bodyCompletedAtMs===null||l.bodyCompletedAtMs!==null&&(l.headersAtMs===null||l.bodyCompletedAtMs<l.headersAtMs)||l.usageRecorded&&l.bodyCompletedAtMs===null||
        Math.max(l.headersAtMs??0,l.bodyCompletedAtMs??0)<t.terminalAtMs||Math.max(l.headersAtMs??0,l.bodyCompletedAtMs??0)>d.measured.elapsedMs)invalid();}
    }
  }
  if(measured.size)invalid();return frozenCopy(d);
}
