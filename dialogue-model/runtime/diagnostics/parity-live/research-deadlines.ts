// Node research-only logical/attempt deadlines; no I/O or activity at import.
import { validateResearchTimeouts } from '../../v2/research-timeouts.ts';
import { exact, integer, positive, cause as isCause, invalid, frozenCopy, parseDeadlines } from './research-deadline-schema.ts';
import type { ResearchTimeoutsV2 } from '../../v2/research-timeouts.ts';
import type { ResearchDeadlines, AppliedCall, AppliedSend, MeasuredCall, MeasuredSend, Terminal, Cause, Origin } from './research-deadline-schema.ts';
export type { ResearchDeadlines, Cause, Origin } from './research-deadline-schema.ts';
type LunaPhase='observation_initial'|'observation_targeted'|'local_extraction'|'ai_extraction'|'generation'|'final_submission';
type Usage={inputTokens:number|null;outputTokens:number|null;model:string|null};
type CallOptions={phase:LunaPhase;callOptionTimeoutMs:number|null;signal?:AbortSignal};
type ScopeOptions={timeouts:ResearchTimeoutsV2;origin:Origin;clock?:()=>number;wallNow?:()=>Date;originAtMs?:number;onChange?:(v:ResearchDeadlines)=>void};
type FetchIO={reserve:()=>number;fetchImpl:(signal:AbortSignal)=>Promise<Response>;signal?:AbortSignal;onUsage?:(sendId:number,usage:Usage)=>void;onUnknown?:(sendId:number)=>void};
type CallState={applied:AppliedCall;measured:MeasuredCall;phaseAt:number;signal:AbortSignal;controller:AbortController;closed:boolean;nextAttempt:number;callerAt:number|null;cancel:(cause:Cause)=>void;close:(cause:Cause|null)=>void};
type SendState={applied:AppliedSend;measured:MeasuredSend;terminal:Terminal|null;controller:AbortController;finish:(cause:Cause|'returned',interrupt?:boolean)=>void};
const deadlineError=(abortCause:Cause)=>Object.assign(Error(abortCause),{code:abortCause==='attempt_timeout'?'timeout':'aborted',abortCause});
const outcome=(c:Cause|'returned'):Terminal['outcome']=>c==='returned'?'returned':c==='attempt_timeout'?'timeout':c==='network'?'network':c==='unknown'?'unknown':'aborted';
export const validateResearchDeadlines=(v:unknown):ResearchDeadlines=>parseDeadlines(v);
export function createResearchDeadlineScope(options:ScopeOptions){
  if(!options||Object.getPrototypeOf(options)!==Object.prototype||Reflect.ownKeys(options).some(k=>typeof k!=='string'||!['timeouts','origin','clock','wallNow','originAtMs','onChange'].includes(k))||
    !Object.hasOwn(options,'timeouts')||!['warmup_start','trial_start'].includes(options.origin)||typeof options.origin!=='string'||
    ['clock','wallNow','onChange'].some(k=>Object.hasOwn(options,k)&&typeof (options as any)[k]!=='function'))invalid();
  let configured:ResearchTimeoutsV2;try{configured=validateResearchTimeouts(options.timeouts);}catch{invalid();}
  const clock=options.clock??(()=>performance.now()),wall=options.wallNow??(()=>new Date());
  const sample=()=>{const n=clock();if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>Number.MAX_SAFE_INTEGER)invalid();return Math.floor(n);};
  const initial=sample(),origin=options.originAtMs??initial;
  if(!integer(origin)||origin>initial)invalid();
  let prior=0;const now=()=>{const n=sample()-origin;if(!integer(n)||n<prior)invalid();prior=n;return n;};
  const date=wall();if(!(date instanceof Date)||!Number.isFinite(date.getTime()))invalid();const wallStartedAt=date.toISOString();
  const trialAt=options.origin==='trial_start'?configured.trialMs:null;
  const calls=new Map<number,CallState>(),sends:SendState[]=[],closedCallIds:number[]=[];
  let closed=false,closedCause:Cause='caller_abort',observationOuterMs:number|null=null;
  const closure=()=>frozenCopy({closedCallIds:[...closedCallIds],scopeClosed:closed});
  const snapshot=():ResearchDeadlines=>frozenCopy({configured,applied:{observationOuterMs,completeCalls:[...calls.values()].map(c=>c.applied),sends:sends.filter(s=>s.terminal).map(s=>s.applied)},
    measured:{clock:'monotonic_ms' as const,origin:options.origin,wallStartedAt,elapsedMs:now(),sends:sends.filter(s=>s.terminal).map(s=>s.measured),calls:[...calls.values()].map(c=>c.measured)}});
  const changed=()=>options.onChange?.(snapshot());
  const reached=(call:CallState,send?:SendState,n=now()):Cause|null=>{
    const attempt=send??sends.find(s=>s.applied.callId===call.applied.callId&&!s.terminal);
    const events:Array<{at:number;cause:Cause;rank:number}>=[];
    if(trialAt!==null&&n>=trialAt)events.push({at:trialAt,cause:'trial_deadline',rank:0});
    if(n>=call.phaseAt)events.push({at:call.phaseAt,cause:'phase_deadline',rank:1});
    if(call.callerAt!==null)events.push({at:call.callerAt,cause:'caller_abort',rank:2});
    if(attempt?.applied.deadlineAtMs!==null&&attempt?.applied.deadlineAtMs!==undefined&&n>=attempt.applied.deadlineAtMs)events.push({at:attempt.applied.deadlineAtMs,cause:'attempt_timeout',rank:3});
    events.sort((a,b)=>a.at-b.at||a.rank-b.rank);
    return events[0]?.cause??(closed?closedCause:null);
  };
  const remaining=(at:number|null,n:number)=>at===null?null:Math.max(0,at-n);
  const refusal=(call:CallState,attemptIndex:number,c:Cause)=>{
    const n=now(),a:AppliedSend={callId:call.applied.callId,attemptIndex,sendId:null,startedAtMs:n,phaseRemainingMs:remaining(call.phaseAt,n),trialRemainingMs:remaining(trialAt,n),configuredAttemptMs:configured.lunaAttemptMs,appliedMs:null,deadlineAtMs:null,limitedBy:null};
    const terminal:Terminal={outcome:'refused_before_send',cause:c,terminalAtMs:null,elapsedMs:null};
    const m:MeasuredSend={callId:a.callId,attemptIndex,sendId:null,sentAtMs:null,terminal,lateObservation:null};
    sends.push({applied:a,measured:m,terminal,controller:new AbortController(),finish:()=>{}});changed();
  };
  const budgetFor=(p:LunaPhase)=>p.startsWith('observation_')?configured.observationMs:p==='local_extraction'||p==='ai_extraction'?configured.localMs:configured.generationMs;
  async function withCall<T>(callId:number,opts:CallOptions,operation:(signal:AbortSignal)=>Promise<T>):Promise<T>{
    if(!positive(callId)||calls.has(callId)||!opts||Object.getPrototypeOf(opts)!==Object.prototype||Reflect.ownKeys(opts).some(k=>typeof k!=='string'||!['phase','callOptionTimeoutMs','signal'].includes(k))||
      !['observation_initial','observation_targeted','local_extraction','ai_extraction','generation','final_submission'].includes(opts.phase)||typeof opts.phase!=='string'||
      !Object.hasOwn(opts,'callOptionTimeoutMs')||opts.callOptionTimeoutMs!==null&&(!positive(opts.callOptionTimeoutMs)||opts.callOptionTimeoutMs>600000)||typeof operation!=='function'||
      opts.signal!==undefined&&!(opts.signal instanceof AbortSignal))invalid();
    if(closed)throw deadlineError(closedCause);
    const n=now(),phaseMs=Math.min(budgetFor(opts.phase),opts.callOptionTimeoutMs??Infinity),trialRemainingMs=remaining(trialAt,n);
    const outer=Math.min(phaseMs,trialRemainingMs??Infinity),controller=new AbortController();
    const signal=opts.signal?AbortSignal.any([opts.signal,controller.signal]):controller.signal;
    let reject!: (error:Error)=>void,timer:ReturnType<typeof setTimeout>|undefined;
    const canceled=new Promise<never>((_r,j)=>{reject=j;});canceled.catch(()=>{});
    const call:CallState={applied:{callId,callOptionTimeoutMs:opts.callOptionTimeoutMs,startedAtMs:n,phaseRemainingMs:phaseMs,trialRemainingMs,outerAppliedMs:outer>=1?outer:null},
      measured:{callId,adopted:false,endCause:null},phaseAt:n+phaseMs,signal,controller,closed:false,nextAttempt:0,callerAt:opts.signal?.aborted?n:null,
      cancel(c){if(call.closed)return;const chosen=reached(call)??c;reject(deadlineError(chosen));controller.abort(deadlineError(chosen));},
      close(c){if(call.closed)return;for(const s of sends.filter(s=>s.applied.callId===callId&&!s.terminal))s.finish(reached(call,s)??c??'unknown');call.closed=true;
        if(c!==null)call.measured.endCause=c;closedCallIds.push(callId);controller.abort(c===null?undefined:deadlineError(c));changed();}};
    calls.set(callId,call);changed();
    const caller=()=>{if(!call.closed){call.callerAt??=now();call.cancel(reached(call)??'caller_abort');}};
    opts.signal?.addEventListener('abort',caller,{once:true});
    try{
      if(outer<1||signal.aborted){const c=reached(call)??'caller_abort';refusal(call,call.nextAttempt++,c);throw deadlineError(c);}
      timer=setTimeout(()=>call.cancel(reached(call)??'phase_deadline'),outer);
      const result=await Promise.race([Promise.resolve().then(()=>operation(signal)),canceled]);
      const c=reached(call);if(c)throw deadlineError(c);
      if(sends.some(s=>s.applied.callId===callId&&!s.terminal))throw deadlineError('unknown');
      const last=[...sends].reverse().find(s=>s.applied.callId===callId);
      if(last?.terminal&&last.terminal.outcome!=='returned')throw deadlineError(last.terminal.cause??'unknown');
      call.measured.adopted=true;call.close(null);return result;
    }catch(error){
      const coded=(error as {abortCause?:unknown})?.abortCause;
      const finalSend=[...sends].reverse().find(s=>s.applied.callId===callId&&s.terminal&&s.terminal.cause!==null);
      // A caller's content/model error is a primary code, not a timeout success.
      const transport=error instanceof TypeError||(error as {code?:unknown})?.code==='network_error';
      const c=isCause(coded)?coded:reached(call)??(transport?'network':error instanceof SyntaxError?'unknown':null);
      call.measured.adopted=false;call.close(c??(finalSend?.terminal?.cause==='attempt_timeout'?'attempt_timeout':null));throw error;
    }finally{clearTimeout(timer);opts.signal?.removeEventListener('abort',caller);}
  }
  async function fetch(callId:number,attemptIndex:number,io:FetchIO):Promise<Response>{
    const call=calls.get(callId);
    if(!call||!integer(attemptIndex)||attemptIndex>2||attemptIndex!==call.nextAttempt||!io||Object.getPrototypeOf(io)!==Object.prototype||
      Reflect.ownKeys(io).some(k=>typeof k!=='string'||!['reserve','fetchImpl','signal','onUsage','onUnknown'].includes(k))||typeof io.reserve!=='function'||typeof io.fetchImpl!=='function'||
      io.signal!==undefined&&!(io.signal instanceof AbortSignal)||['onUsage','onUnknown'].some(k=>Object.hasOwn(io,k)&&typeof (io as any)[k]!=='function'))invalid();
    if(call.closed||closed)throw deadlineError(reached(call)??closedCause);
    call.nextAttempt++;const n=now(),priorCause=reached(call,undefined,n)??(io.signal?.aborted?'caller_abort':null);
    if(priorCause){refusal(call,attemptIndex,priorCause);throw deadlineError(priorCause);}
    const phaseRemainingMs=remaining(call.phaseAt,n)!,trialRemainingMs=remaining(trialAt,n);
    const appliedMs=Math.min(configured.lunaAttemptMs,phaseRemainingMs,trialRemainingMs??Infinity);
    const limitedBy=trialRemainingMs===appliedMs?'trial':phaseRemainingMs===appliedMs?'phase':'attempt';
    const sendId=io.reserve();if(!positive(sendId)||sends.some(s=>s.applied.sendId===sendId))invalid();
    const controller=new AbortController(),signal=AbortSignal.any([call.signal,controller.signal,...(io.signal?[io.signal]:[])]);
    const a:AppliedSend={callId,attemptIndex,sendId,startedAtMs:n,phaseRemainingMs,trialRemainingMs,configuredAttemptMs:configured.lunaAttemptMs,appliedMs,deadlineAtMs:n+appliedMs,limitedBy};
    const m:MeasuredSend={callId,attemptIndex,sendId,sentAtMs:n,terminal:null as unknown as Terminal,lateObservation:null};
    let reject!: (e:Error)=>void,timer:ReturnType<typeof setTimeout>|undefined;
    const canceled=new Promise<never>((_r,j)=>{reject=j;});canceled.catch(()=>{});
    const clean=()=>{clearTimeout(timer);call.signal.removeEventListener('abort',onCaller);io.signal?.removeEventListener('abort',onNative);};
    const state:SendState={applied:a,measured:m,terminal:null,controller,finish(c,interrupt=true){if(state.terminal)return;
      const tick=now(),chosen=reached(call,state,tick)??c;
      const terminal:Terminal={outcome:outcome(chosen),cause:chosen==='returned'?null:chosen,terminalAtMs:tick,elapsedMs:tick-n};
      state.terminal=terminal;m.terminal=terminal;clean();
      if(chosen!=='returned'){io.onUnknown?.(sendId);if(interrupt){const error=deadlineError(chosen);reject(error);controller.abort(error);}}changed();}};
    sends.push(state);
    const onCaller=()=>state.finish(reached(call,state)??'caller_abort');
    const onNative=()=>state.finish(reached(call,state)??'attempt_timeout');
    call.signal.addEventListener('abort',onCaller,{once:true});io.signal?.addEventListener('abort',onNative,{once:true});
    timer=setTimeout(()=>state.finish(reached(call,state)??'attempt_timeout'),appliedMs);
    let headersAtMs:number|null=null;
    const late=(bodyCompletedAtMs:number|null,usageRecorded:boolean)=>{
      if(!state.terminal||state.terminal.outcome==='returned')return;
      m.lateObservation={headersAtMs,bodyCompletedAtMs,usageRecorded};changed();
    };
    const work=(async()=>{
      let response:Response;
      try{response=await io.fetchImpl(signal);}catch(error){if(!state.terminal)state.finish(reached(call,state)??'network',false);throw error;}
      headersAtMs=now();if(!state.terminal){const c=reached(call,state);if(c)state.finish(c);}else late(null,false);
      if(!response.ok){if(!state.terminal)state.finish('returned');else late(null,false);io.onUsage?.(sendId,{inputTokens:null,outputTokens:null,model:null});return response;}
      let data:any;
      try{data=await response.clone().json();}catch{if(!state.terminal)state.finish(reached(call,state)??'unknown',false);return response;}
      const bodyAt=now();if(!state.terminal){const c=reached(call,state);state.finish(c??'returned');}
      const tok=(v:any)=>integer(v)?v:null;
      const usage:Usage={inputTokens:tok(data?.usage?.prompt_tokens),outputTokens:tok(data?.usage?.completion_tokens),model:typeof data?.model==='string'&&/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(data.model)?data.model:null};
      io.onUsage?.(sendId,usage);late(bodyAt,usage.inputTokens!==null||usage.outputTokens!==null);
      return response;
    })();
    // Keep late accounting observed even if the logical race already rejected.
    work.catch(()=>{});
    try{return await Promise.race([work,canceled]);}finally{if(state.terminal)clean();}
  }
  return {snapshot,closure,withCall,fetch,observationStarted(){if(closed)throw deadlineError(closedCause);observationOuterMs=configured.observationMs;changed();},close(c:Cause='caller_abort'){
    if(!isCause(c))invalid();if(closed)return;closedCause=c;
    // close each active operation before marking the scope closed atomically.
    for(const call of calls.values())if(!call.closed){call.cancel(reached(call)??c);call.close(reached(call)??c);}
    closed=true;changed();
  }};
}
export type ResearchDeadlineScope=ReturnType<typeof createResearchDeadlineScope>;
