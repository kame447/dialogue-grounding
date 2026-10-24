import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {root,config,raw,load,clone} from './support.ts';
export const serverModule=await import(pathToFileURL(join(root,'dialogue-model/runtime/web/server.mjs')).href);
export const ADMIN='synthetic-admin-only-token-01234567890123456789';
export async function web(t:any,extra:any={}){
 const dir=await mkdtemp('/private/tmp/SandyNoether-s5-http-');const file=join(dir,'config.json'),storeRoot=join(dir,'owners');await mkdir(storeRoot,{mode:0o700});await writeFile(file,JSON.stringify(config()),{mode:0o600});
 const tasks:any[]=[],inputs:any[]=[],limiterKeys:string[]=[];let server:any,counter=0;
 const options:any={port:0,client:{},runDir:null,now:()=>946684800000,hideStrategy:true,baseAssignmentFile:file,baseStoreRoot:storeRoot,adminToken:ADMIN,adminLimiter:{async limit({key}:any){limiterKeys.push(key);return{success:true}}},
  createTaskV2:async(o:any)=>{inputs.push(o);const r=clone(o.restore??raw());if(!o.restore){counter++;r.recordId=counter===1?'33333333-3333-4333-8333-333333333333':'44444444-4444-4444-8444-444444444444';r.seed=o.seed;r.strategy=o.strategy;r.options.referenceMemory=o.referenceMemory}
   const s=load('BASE-PARTICIPANT-STATE.json');const task:any={version:2,getState:()=>({...clone(s),sessionId:r.recordId,status:r.status,busy:false}),persistNow:async()=>o.onPersist?.(clone(r)),whenIdle:async()=>{},message:()=>({eventId:'synthetic-event',duplicate:false}),retry:async()=>{},submitHuman:async()=>({submitted:true}),submitAI:async()=>({submitted:true}),complete:async()=>{r.status='completed';r.closed=true;r.humanSubmission={};r.aiSubmission={};r.scoring={key:{},result:{provisional:true,success:false,matchedCount:0,total:6,figures:[]}};await o.onPersist?.(clone(r))}};
   tasks.push(task);await o.onPersist?.(clone(r));return task},...extra};
 const start=async()=>{server=await serverModule.startNamingServer(options)};await start();
 const stop=async()=>{if(server){const s=server;server=null;await new Promise<void>((r,j)=>s.close((e:any)=>e?j(e):r()))}};
 t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true})});
 let cookie='';const base=()=>`http://127.0.0.1:${server.address().port}`;
 const request=(path:string,body?:unknown,headers:any={},useCookie=true)=>fetch(base()+path,{headers:{...(useCookie&&cookie?{Cookie:cookie}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},...(body!==undefined?{method:'POST',body:JSON.stringify(body)}:{})});
 const page=async()=>{const r=await request('/');const c=r.headers.get('set-cookie');if(c)cookie=c.split(';')[0];return r};
 return{dir,file,storeRoot,inputs,tasks,limiterKeys,options,base,request,page,stop,restart:async()=>{await stop();await start()},get cookie(){return cookie},set cookie(v:string){cookie=v}};
}
