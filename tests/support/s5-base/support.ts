import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
export const root=process.env.S5_SOURCE_ROOT??fileURLToPath(new URL('../../../',import.meta.url));
export const load=(name:string)=>JSON.parse(readFileSync(new URL('./fixtures/'+name,import.meta.url),'utf8'));
export const clone=<T>(v:T):T=>structuredClone(v);
export const config=()=>load('CONFIG.json');
export const raw=()=>load('BASE-RECORD-UNENRICHED.json');
export const assignment=()=>load('ASSIGNMENT.json');
export const bound=()=>load('ENRICHED-RECORD.json');
export const active=()=>load('OWNER-ACTIVE.json');
export async function optionalImport(path:string){const url=pathToFileURL(resolve(root,path)).href;try{return await import(url)}catch(e:any){if(e.code==='ERR_MODULE_NOT_FOUND'&&e.url===url)return null;throw e}}
export const need=(module:any,name:string)=>{assert.equal(typeof module?.[name],'function','R-a: missing frozen API '+name);return module[name]};
export function sessionError(code:string){return (e:any)=>{assert.equal(e.name,'BaseSessionError');assert.equal(e.code,code);assert.equal(e.message,code);return true}};
export function defer(){let resolve!:(value?:any)=>void,reject!:(e:any)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
export function harness(opts:any={}){
 let value=clone(opts.state??load('OWNER-EMPTY.json'));let nextId=0,recordSeq=0;const archives=new Map<string,any>();
 for(const e of Object.values(value.admissions??{}) as any[])if(e?.record)archives.set(e.record.recordId,clone(e.record));
 const stats={read:0,config:0,factory:0,id:0,clock:0,cas:0};const tasks:any[]=[],commits:any[]=[],entered=defer();
 const controls:any={config:config(),readKind:'state',...opts};
 const store={
  async read(){stats.read++;if(controls.readError)throw controls.readError;if(controls.readKind!=='state')return{kind:controls.readKind};return{kind:'state',state:clone(value)}},
  async readRecord(id:string){if(controls.readRecordError)throw controls.readRecordError;return clone(archives.get(id)??null)},
  async compareAndSwap(rev:number,next:any,writes:any[]){stats.cas++;if(controls.failCas===stats.cas)throw Error('SYNTHETIC_PRIVATE_WRITE');if(controls.conflictCas===stats.cas||rev!==value.revision)return false;
   assert.equal(next.revision,rev+1,'mock store requires one revision increment');const staged=new Map(archives);for(const w of writes)staged.set(w.record.recordId,clone(w.record));value=clone(next);archives.clear();for(const[k,v]of staged)archives.set(k,v);commits.push({state:clone(value),writes:clone(writes)});return true},
 };
 const options={ownerId:value.ownerId,store,adapter:opts.adapter??'local_private_file',
  readConfig:async()=>{stats.config++;if(controls.configError)throw controls.configError;return clone(controls.config)},
  newId:()=>{stats.id++;return ['22222222-2222-4222-8222-222222222222','55555555-5555-4555-8555-555555555555','66666666-6666-4666-8666-666666666666'][nextId++]},
  now:()=>{stats.clock++;return 946684800000},
  makeTask:async(input:any)=>{stats.factory++;entered.resolve();if(controls.factoryGate)await controls.factoryGate.promise;if(controls.factoryErrorBefore)throw controls.factoryErrorBefore;
   const record=clone(input.restore??raw());if(!input.restore){record.recordId=['33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444'][recordSeq++];record.seed=input.seed;record.strategy=input.strategy;record.options.referenceMemory=input.referenceMemory}
   const publicState=load('BASE-PARTICIPANT-STATE.json');
   const task:any={record,input,getState:()=>({...clone(publicState),sessionId:record.recordId,status:record.status}),persistNow:async()=>input.onPersist(clone(record)),whenIdle:async()=>{},message:()=>({eventId:'synthetic-event',duplicate:false}),retry:async()=>{},submitHuman:async()=>({submitted:true}),submitAI:async()=>({submitted:true}),
    emit:async(patch:any={})=>{Object.assign(record,clone(patch));await input.onPersist(clone(record))},complete:async()=>{record.status='completed';record.closed=true;record.humanSubmission={};record.aiSubmission={};record.scoring={key:{},result:{provisional:true,success:false,matchedCount:0,total:6,figures:[]}};await input.onPersist(clone(record))}};
   tasks.push(task);if(!controls.skipInitialPersist)await input.onPersist(clone(record));if(controls.factoryErrorAfter)throw controls.factoryErrorAfter;return task;
  }};
 return {options,stats,controls,tasks,commits,entered,archives,get state(){return clone(value)},setState:(s:any)=>{value=clone(s)}};
}
