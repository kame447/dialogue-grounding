// Synthetic public seam, no real key/fetch. Contract e64a0ea7 / freeze55d410d0.
import {createProfileDialogue} from '../../../dialogue-model/runtime/diagnostics/parity-live/replay.ts';
import * as profiles from '../../../dialogue-model/runtime/v2/research-profile.ts';
import {createJevDecisionClient} from '../../../dialogue-model/runtime/decision/jev-decision.ts';
import {createDialogueV2} from '../../../dialogue-model/runtime/v2/dialogue-v2.mjs';
export const ids=Array.from({length:6},(_,i)=>'s-'+String(i).padStart(4,'0'));
export const anchors=ids.map((id,i)=>({id,bbox:{x:i*10,y:0,w:9,h:9},centroid:{x:i*10+4,y:4}}));
export const image={mimeType:'image/png',base64:'U1lOVEhFVElDX09XTl9JTUFHRQ=='};
export const memo=()=>({observedAt:'2026-01-01T00:00:00.000Z',figures:anchors.map(a=>({id:a.id,region:{...a.bbox},holistic:[{construal:'control-name',basis:['control'],status:'hypothesis'}],analytic:{shapes:['control-feature'],composition:'control composition',relations:[]},unknowns:[],reobservations:[]}))});
export const deadlines=()=>({observationMs:1000,localMs:1000,decisionMs:1000,lunaAttemptMs:80000,generationMs:1000,trialMs:300000});
export function profile():any {const f=(profiles as any).researchTrialProfileV3;if(typeof f!=='function')throw Error('missing researchTrialProfileV3');return f({timeoutMs:null,maxCompletionTokens:null},deadlines());}
export const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
export async function until(fn:()=>boolean){for(let i=0;i<300;i++){if(fn())return;await flush();await new Promise<void>(resolve=>setImmediate(resolve));}throw Error('synthetic checkpoint not reached');}
export function gate<T=any>(){let resolve!:(v:T)=>void,reject!:(e:any)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
export function harness({strategy='repair-first',original='defer',alternative='confirm',multiple=false,legacy=false,completeDetail,decide}:any={}){
 const inputLog:any[]=[],native:any[]=[],generated:any[]=[],traces:any[]=[];let detailCalls=0,keyReads=0;
 const fetchImpl=async(_url:any,init:any)=>{
  const body=JSON.parse(init.body);native.push(body);const state=JSON.parse(body.state),answers:any={};
  for(const [key,question] of Object.entries(body.questions) as any){
   let choice=Object.keys(question.criteria)[0];
   if(key==='action')choice=original;
   if(key==='target')choice=multiple?'multiple':'figure_0';
   if(key.startsWith('candidate_'))choice=multiple&&['candidate_0','candidate_1'].includes(key)?'include':'exclude';
   const probabilities=Object.fromEntries(Object.keys(question.criteria).map(k=>[k,key==='action'?(k===original?1:k===alternative?.9:0):(k===choice?1:0)]));
   answers[key]={type:'choice',choice,probabilities};
  }
  return Response.json({model:'typesafe/jev-1.14',id:'gen-synthetic-'+native.length,usage:{cost:0},answers});
 };
 const core=createJevDecisionClient({enabled:true,readKey:async()=>{keyReads++;return 'sk-or-SYNTHETIC-0000000000000000';},fetchImpl,timeoutMs:1000,researchLimits:{maxDeadlineMs:600000}})!;
 const jevDecision:any={async decide(input:any,opts:any){inputLog.push(structuredClone(input));return decide?decide(input,opts,core):core.decide(input,opts);},async completeDetail(input:any,selected:any,opts:any){detailCalls++;return completeDetail?completeDetail(input,selected,opts,core):core.completeDetail(input,selected,opts);}};
 const options:any={strategy,client:{async complete(messages:any[],opts:any){generated.push({messages:structuredClone(messages),options:opts});return{text:['local_extraction','ai_extraction'].includes(opts.phase)?'[]':'Control.'};}},image,anchors,observer:{async observeAll(){return memo();},async reobserve(x:any){return{observedAt:'2026-01-01T00:00:01.000Z',issue:x.issue,figures:x.figureIds.map((figureId:string)=>({figureId,supports:['control-feature'],contradicts:[],unknown:[]}))};}},jevDecision,localGrounding:{classifier:{async classify(){return[];}},aiPublicTransport:{readKey:async()=>{throw Error('unselected AI key');},fetchImpl:async()=>{throw Error('unselected AI fetch');}}},onJevTurnTrace:(t:any)=>traces.push(t),referenceMemory:true,decisionMode:'jev'};
 const runtime=legacy?createDialogueV2(options):createProfileDialogue(profile(),options);
 const events=[{id:'human-1',seq:1,speaker:'human',text:'Control?'}];
 const run=(state=runtime.initialPrivateState(),extra:any={})=>runtime.runAiTurn({events,privateState:state,lastEventId:'human-1',requestSeq:1,...extra});
 return{runtime,run,events,jevDecision,inputLog,native,generated,traces,counts:()=>({detailCalls,keyReads})};
}
