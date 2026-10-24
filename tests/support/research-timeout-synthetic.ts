import {createJevTurnRuntime} from '../../dialogue-model/runtime/v2/jev-turn.ts';
import {createMockJevDecisionClient} from '../../dialogue-model/runtime/decision/mocks.ts';
export const root='/Users/Shogo/.agentstack/worktrees/NobleHooke-live';
export const text='A square part is present.';
export function harness(delays:Record<string,number>,localMs=20000,create?: (options:any)=>any){
 const anchors=Array.from({length:6},(_,i)=>({id:`s-000${i+1}`,bbox:{x:i,y:0,w:1,h:1},centroid:{x:i,y:0}}));
 const image={mimeType:'image/png',base64:'U1lOVEhFVElDLVRJTUVPVVQtU09MMQ=='};
 const memo={observedAt:'2026-10-25T00:00:00.000Z',figures:anchors.map(a=>({id:a.id,region:{...a.bbox},holistic:[],analytic:{shapes:['square'],composition:'connected parts',relations:['connected']},unknowns:[],reobservations:[]}))};
 const sent:{phase:string;at:number;timeoutMs:number;signal?:AbortSignal}[]=[],traces:any[]=[];
 const delay=async(phase:string)=>{if(delays[phase])await new Promise<void>(r=>setTimeout(r,delays[phase]));};
 const client={async complete(_messages:any,options:any){sent.push({phase:options.phase,at:performance.now(),timeoutMs:options.timeoutMs,signal:options.signal});await delay(options.phase);
  return{text:options.phase==='local_extraction'?'[]':options.phase==='ai_extraction'?JSON.stringify([{segmentId:'clause1',quote:text,targets:[anchors[0].id],aspect:'part',proposition:'A square part is present',name:null,linkedIssueId:null,respondsToTurn:null}]):text};}};
 const fetchImpl=async(_url:string,init:RequestInit)=>{const payload=JSON.parse(init.body as string),phase=Object.keys(payload.questions).some(k=>k.endsWith('_support'))?'ai_support':'ai_function';
  sent.push({phase,at:performance.now(),timeoutMs:-1,signal:init.signal??undefined});await delay(phase);
  return Response.json({model:'typesafe/jev-1.14',id:'SYNTHETIC-timeout-transport',usage:{cost:0.0001},answers:Object.fromEntries(Object.entries(payload.questions).map(([name,q]:[string,any])=>{const labels=Object.keys(q.criteria),choice=name.endsWith('_act')?'assert':name.endsWith('_antecedent')?'none':'expressed';return[name,{type:'choice',choice,probabilities:Object.fromEntries(labels.map(k=>[k,k===choice?1:0])),confidence:1}];}))});};
 const options={client,ownImage:image,ownAnchors:anchors,observer:{async observeAll(){return structuredClone(memo);},async reobserve(){throw Error('unexpected reobserve');}},jevDecision:createMockJevDecisionClient(()=>({action:'accept',target:{kind:'none'},name:null,feature:null,observe:null})),localGrounding:{classifier:{async classify(){return[];}},timeoutMs:localMs,aiPublicClaims:true,aiPublicTransport:{readKey:async()=>'sk-or-SYNTHETIC-TIMEOUT-TRANSPORT-000000',fetchImpl}},generation:{task:'synthetic',instructions:'synthetic',actionScope:{accept:'acknowledge'},final:'synthetic final',timeoutMs:40000},onJevTurnTrace:(r:any)=>traces.push(r)};
 const runtime=create?create(options):createJevTurnRuntime(options as any);
 const run=()=>runtime.runAiTurn({events:[{id:'human1',seq:1,speaker:'human',text:'Describe a part.'}],privateState:runtime.initialPrivateState(),lastEventId:'human1'});
 return{sent,traces,run,options,image,anchors};
}
export async function flush(){for(let i=0;i<5;i++)await new Promise<void>(r=>setImmediate(r));}
export async function until(predicate:()=>boolean){for(let i=0;i<100;i++){if(predicate())return;await flush();}throw Error('synthetic progress unavailable');}
