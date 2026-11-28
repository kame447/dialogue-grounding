import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIMARY_REGION_TEMPLATES, PRIMARY_REGION_CATALOG_REVISION } from '../../../dialogue-model/runtime/stimuli/primary-regions-data.ts';

const here=dirname(fileURLToPath(import.meta.url));
const port=Number(process.env.REVIEW_PORT||5498);
const directory=process.env.REVIEW_STATE_DIR||join(homedir(),'Library','Application Support','dialogue-grounding','orientation-review-v1');
mkdirSync(directory,{recursive:true,mode:0o700});
const statePath=join(directory,'review-state.json');
const backupPath=join(directory,'review-state.previous.json');
const schemaVersion='tangram_orientation_review_v1';
const templates=PRIMARY_REGION_TEMPLATES.map(t=>({
 id:t.figureId+'@'+t.rotation,figureId:t.figureId,rotation:t.rotation,size:t.size,
 parts:t.regions.map(({construal,...geometry})=>({...geometry,candidates:construal.candidates})),
 whole:t.initial.holistic[0],relations:t.initial.analytic.relations,
}));
const sourceSha256=createHash('sha256').update(JSON.stringify(templates)).digest('hex');
const byId=new Map(templates.map(t=>[t.id,t]));
const data={schemaVersion,sourceSha256,catalogRevision:PRIMARY_REGION_CATALOG_REVISION,templates};
type ReviewRow={id:string;status:'未確認'|'確認済み'|'要修正';whole:string;wholeBasis:string[];parts:{id:string;description:string;candidates:string[]}[];note:string};
type State={schemaVersion:string;sourceSha256:string;revision:number;updatedAt:string;currentId:string;results:ReviewRow[]};
const initialRows:ReviewRow[]=templates.map(t=>({id:t.id,status:'未確認',whole:t.whole.construal,wholeBasis:[...t.whole.basis],parts:t.parts.map(p=>({id:p.id,description:p.description,candidates:[...p.candidates]})),note:''}));
function atomicWrite(path:string,value:unknown){
 const tmp=path+'.tmp-'+process.pid,fd=openSync(tmp,'w',0o600);
 try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd)}finally{closeSync(fd)}
 renameSync(tmp,path);
}
function string(v:unknown,max=2000):string{
 if(typeof v!=='string'||v.length>max)throw Error('入力形式が正しくありません。');return v;
}
function strings(v:unknown,max=24):string[]{
 if(!Array.isArray(v)||v.length>max)throw Error('候補の形式が正しくありません。');return v.map(x=>string(x));
}
function row(v:any):ReviewRow{
 const t=byId.get(v?.id);if(!t||!['未確認','確認済み','要修正'].includes(v.status)||!Array.isArray(v.parts)||v.parts.length!==t.parts.length)throw Error('図形・方向・部分の識別情報が一致しません。');
 return {id:t.id,status:v.status,whole:string(v.whole),wholeBasis:strings(v.wholeBasis),note:string(v.note,10000),parts:t.parts.map((p,i)=>{
  const q=v.parts[i];if(q?.id!==p.id)throw Error('部分IDが一致しません。');
  return {id:p.id,description:string(q.description),candidates:strings(q.candidates)};
 })};
}
function rows(v:any):ReviewRow[]{
 if(!Array.isArray(v)||v.length!==templates.length)throw Error('全120方向の結果が必要です。');
 const map=new Map<string,ReviewRow>();for(const entry of v){const r=row(entry);if(map.has(r.id))throw Error('重複した図形があります。');map.set(r.id,r)}
 return templates.map(t=>{const r=map.get(t.id);if(!r)throw Error('不足している図形があります。');return r});
}
let state:State;
if(existsSync(statePath)){
 const raw=JSON.parse(readFileSync(statePath,'utf8'));
 if(raw.schemaVersion!==schemaVersion||raw.sourceSha256!==sourceSha256||!Number.isSafeInteger(raw.revision)||raw.revision<0||!byId.has(raw.currentId))throw Error('既存の保存内容とデータが一致しません。上書きしません。');
 state={...raw,results:rows(raw.results)};
}else{state={schemaVersion,sourceSha256,revision:0,updatedAt:new Date().toISOString(),currentId:templates[0].id,results:initialRows};atomicWrite(statePath,state)}
function persist(next:State){
 const saved={...next,revision:state.revision+1,updatedAt:new Date().toISOString()};
 atomicWrite(backupPath,state);atomicWrite(statePath,saved);state=saved;return saved;
}
function exported(){
 return {...state,catalogRevision:PRIMARY_REGION_CATALOG_REVISION,partitionStatus:'all_30_user_confirmed',orientationCount:120,
 results:state.results.map(r=>{
  const t=byId.get(r.id)!;
  return {...r,figureId:t.figureId,rotation:t.rotation,size:t.size,
   parts:r.parts.map((p,i)=>({...t.parts[i],...p,construal:{status:'hypothesis',candidates:p.candidates}})),
   relations:t.relations,
  };
 })};
}
async function body(req:any){
 if(!(req.headers['content-type']||'').startsWith('application/json'))throw Error('JSONを送信してください。');
 const chunks:Buffer[]=[];let size=0;for await(const c of req){size+=c.length;if(size>4000000)throw Error('入力が大きすぎます。');chunks.push(c)}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const server=createServer(async(req,res)=>{
 const send=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value))};
 const host=req.headers.host||'';
 if(!['127.0.0.1:'+port,'localhost:'+port].includes(host))return send(403,{error:'localhost only'});
 if(req.method!=='GET'&&req.headers.origin&&req.headers.origin!=='http://'+host)return send(403,{error:'origin mismatch'});
 try{
  const path=new URL(req.url||'/','http://'+host).pathname;
  if(req.method==='GET'){
   if(path==='/api/data')return send(200,data);
   if(path==='/api/state')return send(200,state);
   if(path==='/api/export'){
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="tangram-orientation-review-results.json"','Cache-Control':'no-store'});
    return res.end(JSON.stringify(exported(),null,2)+'\n');
   }
   const asset=({'/':['index.html','text/html; charset=utf-8'],'/client.js':['client.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']} as Record<string,string[]>)[path];
   if(!asset)return send(404,{error:'not found'});
   res.writeHead(200,{'Content-Type':asset[1],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'"});
   return res.end(readFileSync(join(here,asset[0])));
  }
  if(req.method!=='POST'||!['/api/state','/api/import'].includes(path))return send(404,{error:'not found'});
  const input=await body(req);
  if(input?.revision!==state.revision)return send(409,{error:'別の画面で更新されています。上書きせず、編集を退避してください。',revision:state.revision});
  if(path==='/api/state'){
   if(input.sourceSha256!==sourceSha256||!byId.has(input.currentId))throw Error('図形データが一致しません。');
   const results=rows(input.results);
   return send(200,persist({...state,currentId:input.currentId,results}));
  }
  const imported=input.document;
  if(imported?.schemaVersion!==schemaVersion||imported.sourceSha256!==sourceSha256||!byId.has(imported.currentId))throw Error('このページで書き出した同じ版のJSONを指定してください。');
  return send(200,persist({...state,currentId:imported.currentId,results:rows(imported.results)}));
 }catch(e){return send(400,{error:e instanceof Error?e.message:String(e)})}
});
server.listen(port,'127.0.0.1',()=>console.log('Orientation review: http://127.0.0.1:'+port+'/\nState: '+statePath));
