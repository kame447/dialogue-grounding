// P1 frozen contract: real cache/HTTP boundaries with synthetic local transports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrialV2, modelView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { createObservationCache, createObservationCacheKey, observationCacheFileName } from '../dialogue-model/runtime/observation/cache.ts';
import { researchHash, researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { prepareParticipantJev, createParticipantCacheObserver, validateParticipantJevConfig, participantLedgerFetch,
  participantLunaClient, restoreParticipantJevLedger } from '../dialogue-model/runtime/web/participant-jev-wiring.ts';
import { RunBudget } from '../dialogue-model/runtime/diagnostics/parity-live/audit.ts';
import { participantReview, QUESTIONNAIRE_FORM } from '../dialogue-model/runtime/v2/participant-records.ts';
import { summarizeRecord } from '../workers/tangram-experiment/src/admin/summary.ts';
import { summarizeLatency } from '../dialogue-model/runtime/v2/latency.ts';
import { startNamingServer } from '../dialogue-model/runtime/web/server.mjs';

const seed=919, modelId='synthetic-luna-20261020';
const trial=createTrialV2({seed}),model=modelView(trial);
const own={ownImage:{mimeType:model.mimeType,base64:model.png.toString('base64')},ownAnchors:model.anchors};
const timeouts={observationMs:20000,localMs:20000,decisionMs:20000,lunaAttemptMs:80000,generationMs:40000,trialMs:600000};
const limits={lunaCalls:100,lunaTokens:100000,lunaPosts:100,jevPosts:100,jevUsd:0.05};
const rawMemo={figures:model.anchors.map((a:any)=>({id:a.id,holistic:[],analytic:{shapes:['三角'],composition:'二つの部分が接する',relations:[]},unknowns:[]}))};
const assignment={schemaVersion:'base_assignment_config_v1',configId:'11111111-1111-4111-8111-111111111111',revision:1,strategy:'repair-first',seed,referenceMemory:true};
const clientConfig={provider:'cloudflare',purpose:'dialogue_turn',baseUrl:'https://synthetic.invalid/v1',apiKey:'synthetic-private-proxy-key'};
const syntheticKey='sk-or-synthetic-only-private-key-0123456789';
function tape(action='accept',localSegment=false) {
  const posts:any[]=[];let gets=0, keyReads=0;
  const fetchImpl:typeof fetch=async(_url,init:any={})=>{
    if(init.method==='GET'){gets++;return Response.json({ready:true,purpose:'dialogue_turn',provider:'openai',model:modelId});}
    const body=JSON.parse(init.body);posts.push(body);
    if(body.questions){
      const answers=Object.fromEntries(Object.entries(body.questions).map(([name,q]:[string,any])=>{
        const choices=Object.keys(q.criteria),chosen=name==='action'?action:name==='target'||name==='human_referent'||name.endsWith('_antecedent')?'none':name.startsWith('candidate_')?'exclude':name.endsWith('_act')?'assert':choices[0];
        return [name,{type:'choice',choice:chosen,probabilities:Object.fromEntries(choices.map(v=>[v,v===chosen?1:name==='action'&&v==='accept'?0.9:0])),confidence:1}];
      }));
      return Response.json({model:'typesafe/jev-1.14-20261014',id:'gen-synthetic',usage:{cost:0.001},answers});
    }
    const state=body.messages[1]?.content;
    let parsed:any;try{parsed=JSON.parse(state);}catch{}
    const final=String(body.messages.at(-1)?.content).includes('JSON')&&!parsed?.candidateText&&!parsed?.publicTurns;
    const segment=parsed?.publicTurns&&!parsed?.candidateText&&localSegment?JSON.stringify([{segmentId:'s1',quote:parsed.publicTurns.at(-1).text,
      targets:[model.anchors[0].id],aspect:'part',proposition:'細い部分がある',name:null,linkedIssueId:null,respondsToTurn:null}]):'[]';
    const text=parsed?.candidateText||parsed?.publicTurns?segment:final?JSON.stringify(Object.fromEntries(model.anchors.map((a:any)=>[a.id,null]))):'なるほど。';
    return Response.json({model:modelId,choices:[{message:{content:text}}],usage:{prompt_tokens:3,completion_tokens:2}});
  };
  return{fetchImpl,posts,counts:()=>({gets,keyReads,posts:posts.length}),readKey:async()=>{keyReads++;return syntheticKey;}};
}
async function fixture(t:any,changes:any={}){
  const dir=await mkdtemp(join(await realpath(tmpdir()),'HazelKepler-p1-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const cacheDirectory=join(dir,'cache');await mkdir(cacheDirectory,{mode:0o700});
  const warm=await createObservationCache({directory:cacheDirectory,modelId,onMiss:'observe',client:{async complete(){return{text:JSON.stringify(rawMemo),model:modelId};}}});
  const hit=await warm.get(own);
  const config={schemaVersion:'participant_jev_config_v1',lunaRequest:{timeoutMs:null,maxCompletionTokens:1000},timeouts,
    cacheDirectory,modelId,memoSha256:researchHash(hit.memo),seed,limits,...changes};
  const configFile=join(dir,'jev.json'),baseAssignmentFile=join(dir,'base.json');
  await writeFile(configFile,JSON.stringify(config),{mode:0o600});await writeFile(baseAssignmentFile,JSON.stringify(assignment),{mode:0o600});
  const upstream=tape();
  const options={configFile,baseAssignmentFile,clientConfig,fetchImpl:upstream.fetchImpl,readKey:upstream.readKey};
  return{dir,config,hit,options,upstream,cacheFile:join(cacheDirectory,observationCacheFileName(createObservationCacheKey(own,{modelId})))};
}
async function makeTask(prepared:any,extra:any={}){
  let saved:any;
  const value={strategy:'repair-first',seed,referenceMemory:true,...extra};
  const wiring=await prepared.taskOptions(value);
  const task=await createNamingTaskV2({...value,...wiring,runDir:null,createTrial:()=>trial,onPersist:async(r:any)=>{saved=structuredClone(r);}});
  return{task,record:()=>saved,wiring};
}

test('P1 audit R1: AI function/support after generation belong to the tail',async t=>{
 const h=await fixture(t);const fetchImpl:typeof fetch=async(url,init:any={})=>{
   if(init.method==='POST'){
     const body=JSON.parse(init.body);if(body.messages){
       let state:any;try{state=JSON.parse(body.messages[1]?.content);}catch{}
       if(state?.candidateText){
         const segment={segmentId:'s1',quote:state.candidateText,targets:[model.anchors[0].id],aspect:'part',proposition:'細い部分が見える',name:null,linkedIssueId:null,respondsToTurn:null};
         return Response.json({model:modelId,choices:[{message:{content:JSON.stringify([segment])}}],usage:{prompt_tokens:3,completion_tokens:2}});
       }
       if(!state?.publicTurns)return Response.json({model:modelId,choices:[{message:{content:'細い部分が見えます。'}}],usage:{prompt_tokens:3,completion_tokens:2}});
     }
   }
   return h.upstream.fetchImpl(url,init);
 };
 const made=await makeTask(await prepareParticipantJev({...h.options,fetchImpl}));
 made.task.message('この形を話題にします','one');await made.task.whenIdle();
 assert.equal(made.task.getState().aiStatus,'idle');
 const record=made.record(),stages=record.jevTraces[0].aiPublic.stages;
 assert.equal(stages.ai_function.status,'ok');assert.equal(stages.ai_support.status,'ok');
 const sends=record.jevLedger.sends;console.log('receipt boundaries',sends.map((s:any)=>({provider:s.provider,phase:s.phase,boundary:s.boundary})));
 const after=sends.slice(sends.findIndex((s:any)=>s.phase==='generation')+1);
 assert.ok(after.filter((s:any)=>s.provider==='jev').length===2);
 assert.ok(after.every((s:any)=>s.boundary==='tail'),'post-generation AI function/support must not enter common comparison');
});
