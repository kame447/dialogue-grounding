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
// 構造化の層: 独立部分の見立て（領域ごと）と全体の見立て（方向ごと）。どちらも results（自由文の全体の見立て・役割・メモ・確認状態）とは別。
// 旧版の保存内容には無く、読み込み時に空の欄を補う（次の保存まで保存ファイルは書き換えない）。
// results とは別のトップレベルに置くので、この層を知らない旧版のサーバーや画面を通っても失われない。
const independentVersion='tangram_independent_part_review_v1';
const wholeVersion='tangram_whole_construal_review_v1';
const reviewStatuses=['ai_unreviewed','researcher_confirmed','researcher_edited'] as const;
const confidences=['高','中','低'] as const;
const bases=['単独','全体との関係','両方'] as const;
const agreements=['合意','一部合意','未合意'] as const;
const maxCandidates=3;
const templates=PRIMARY_REGION_TEMPLATES.map(t=>({
 id:t.figureId+'@'+t.rotation,figureId:t.figureId,rotation:t.rotation,size:t.size,
 parts:t.regions.map(({construal,...geometry})=>({...geometry,candidates:construal.candidates})),
 whole:t.initial.holistic[0],relations:t.initial.analytic.relations,
}));
const sourceSha256=createHash('sha256').update(JSON.stringify(templates)).digest('hex');
const byId=new Map(templates.map(t=>[t.id,t]));
const data={schemaVersion,sourceSha256,catalogRevision:PRIMARY_REGION_CATALOG_REVISION,templates,
 independentPart:{schemaVersion:independentVersion,maxCandidates,reviewStatuses,confidences,bases},
 wholeConstrual:{schemaVersion:wholeVersion,maxCandidates,reviewStatuses,confidences}};
type Template=typeof templates[number];
type ReviewRow={id:string;status:'未確認'|'確認済み'|'要修正';whole:string;wholeBasis:string[];parts:{id:string;description:string;candidates:string[]}[];note:string};
type Ai={agreementStatus:typeof agreements[number];discussion:string}|null;
type IndependentCandidate={noun:string;owner:string;basis:typeof bases[number];confidence:typeof confidences[number];evidence:string;weaknesses:string};
type IndependentPart={id:string;reviewStatus:typeof reviewStatuses[number];candidates:IndependentCandidate[];noCandidate:boolean;noCandidateReason:string;ai:Ai};
type IndependentLayer={schemaVersion:string;rows:{id:string;parts:IndependentPart[]}[]};
type WholeCandidate={noun:string;posture:string;direction:string;confidence:typeof confidences[number];parts:{id:string;role:string}[];evidence:string;weaknesses:string};
type WholeConstrual={id:string;reviewStatus:typeof reviewStatuses[number];candidates:WholeCandidate[];noConstrual:boolean;noConstrualReason:string;needsTextCheck:boolean;ai:Ai};
type WholeLayer={schemaVersion:string;rows:WholeConstrual[]};
type State={schemaVersion:string;sourceSha256:string;revision:number;updatedAt:string;currentId:string;results:ReviewRow[];independentParts:IndependentLayer;wholeConstruals:WholeLayer};
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
function choice<T extends string>(v:unknown,list:readonly T[]):T{
 if(typeof v!=='string'||!(list as readonly string[]).includes(v))throw Error('構造化した見立ての値が正しくありません。');return v as T;
}
function aiInfo(v:any):Ai{
 return v===null?null:{agreementStatus:choice(v?.agreementStatus,agreements),discussion:string(v?.discussion,4000)};
}
function independentCandidate(v:any):IndependentCandidate{
 return {noun:string(v?.noun,40),owner:string(v?.owner,40),basis:choice(v?.basis,bases),confidence:choice(v?.confidence,confidences),evidence:string(v?.evidence,1000),weaknesses:string(v?.weaknesses,1000)};
}
function independentPart(v:any,id:string):IndependentPart{
 if(v?.id!==id)throw Error('部分IDが一致しません。');
 if(!Array.isArray(v.candidates)||v.candidates.length>maxCandidates)throw Error('独立部分の見立ては0〜'+maxCandidates+'件です。');
 const candidates=v.candidates.map(independentCandidate);
 if(typeof v.noCandidate!=='boolean'||(v.noCandidate&&candidates.length>0))throw Error('独立部分の見立てと「見立てなし」が両立しません。');
 return {id,reviewStatus:choice(v.reviewStatus,reviewStatuses),candidates,noCandidate:v.noCandidate,noCandidateReason:string(v.noCandidateReason,1000),ai:aiInfo(v.ai)};
}
function independentRows(v:any):IndependentLayer['rows']{
 if(!Array.isArray(v)||v.length!==templates.length)throw Error('全120方向の独立部分の見立てが必要です。');
 const map=new Map<string,IndependentLayer['rows'][number]>();
 for(const entry of v){
  const t=byId.get(entry?.id);if(!t||map.has(t.id))throw Error('独立部分の見立ての図形・方向が正しくありません。');
  if(!Array.isArray(entry.parts)||entry.parts.length!==t.parts.length)throw Error('独立部分の見立ての部分数が一致しません。');
  map.set(t.id,{id:t.id,parts:t.parts.map((p,i)=>independentPart(entry.parts[i],p.id))});
 }
 return templates.map(t=>{const r=map.get(t.id);if(!r)throw Error('独立部分の見立てが不足しています。');return r});
}
function independentLayer(v:any):IndependentLayer{
 if(v?.schemaVersion!==independentVersion)throw Error('独立部分の見立ての版が一致しません。');
 return {schemaVersion:independentVersion,rows:independentRows(v.rows)};
}
function blankLayer():IndependentLayer{
 return {schemaVersion:independentVersion,rows:templates.map(t=>({id:t.id,parts:t.parts.map(p=>({id:p.id,reviewStatus:'ai_unreviewed' as const,candidates:[],noCandidate:false,noCandidateReason:'',ai:null}))}))};
}
// 全体の見立て（構造化）: 方向ごとに候補0〜3件。各候補は、その方向の全領域の役割を領域の並びどおりに持つ。
function wholeCandidate(v:any,t:Template):WholeCandidate{
 if(!Array.isArray(v?.parts)||v.parts.length!==t.parts.length)throw Error('全体の見立ての領域ごとの役割が一致しません。');
 return {noun:string(v.noun,40),posture:string(v.posture,80),direction:string(v.direction,80),confidence:choice(v.confidence,confidences),
  parts:t.parts.map((p,i)=>{const q=v.parts[i];if(q?.id!==p.id)throw Error('部分IDが一致しません。');return {id:p.id,role:string(q.role,200)}}),
  evidence:string(v.evidence,1000),weaknesses:string(v.weaknesses,1000)};
}
function wholeConstrual(v:any,t:Template):WholeConstrual{
 if(v?.id!==t.id)throw Error('全体の見立ての図形・方向が一致しません。');
 if(!Array.isArray(v.candidates)||v.candidates.length>maxCandidates)throw Error('全体の見立ては0〜'+maxCandidates+'件です。');
 const candidates=v.candidates.map((c:any)=>wholeCandidate(c,t));
 if(typeof v.noConstrual!=='boolean'||(v.noConstrual&&candidates.length>0))throw Error('全体の見立てと「見立てなし」が両立しません。');
 if(typeof v.needsTextCheck!=='boolean')throw Error('全体の見立ての照合の印が正しくありません。');
 return {id:t.id,reviewStatus:choice(v.reviewStatus,reviewStatuses),candidates,noConstrual:v.noConstrual,noConstrualReason:string(v.noConstrualReason,1000),needsTextCheck:v.needsTextCheck,ai:aiInfo(v.ai)};
}
function wholeLayer(v:any):WholeLayer{
 if(v?.schemaVersion!==wholeVersion)throw Error('全体の見立ての版が一致しません。');
 if(!Array.isArray(v.rows)||v.rows.length!==templates.length)throw Error('全120方向の全体の見立てが必要です。');
 const map=new Map<string,WholeConstrual>();
 for(const entry of v.rows){const t=byId.get(entry?.id);if(!t||map.has(t.id))throw Error('全体の見立ての図形・方向が正しくありません。');map.set(t.id,wholeConstrual(entry,t))}
 return {schemaVersion:wholeVersion,rows:templates.map(t=>{const r=map.get(t.id);if(!r)throw Error('全体の見立てが不足しています。');return r})};
}
function blankWholeLayer():WholeLayer{
 return {schemaVersion:wholeVersion,rows:templates.map(t=>({id:t.id,reviewStatus:'ai_unreviewed' as const,candidates:[],noConstrual:false,noConstrualReason:'',needsTextCheck:false,ai:null}))};
}
let state:State;
if(existsSync(statePath)){
 const raw=JSON.parse(readFileSync(statePath,'utf8'));
 if(raw.schemaVersion!==schemaVersion||raw.sourceSha256!==sourceSha256||!Number.isSafeInteger(raw.revision)||raw.revision<0||!byId.has(raw.currentId))throw Error('既存の保存内容とデータが一致しません。上書きしません。');
 state={...raw,results:rows(raw.results),
  independentParts:raw.independentParts===undefined?blankLayer():independentLayer(raw.independentParts),
  wholeConstruals:raw.wholeConstruals===undefined?blankWholeLayer():wholeLayer(raw.wholeConstruals)};
 if(raw.independentParts===undefined)console.log('独立部分の見立て: 旧版の保存内容に空の欄を補いました（次の保存まで保存ファイルは変わりません）。');
 if(raw.wholeConstruals===undefined)console.log('全体の見立ての構造化: 旧版の保存内容に空の欄を補いました（次の保存まで保存ファイルは変わりません）。');
}else{state={schemaVersion,sourceSha256,revision:0,updatedAt:new Date().toISOString(),currentId:templates[0].id,results:initialRows,independentParts:blankLayer(),wholeConstruals:blankWholeLayer()};atomicWrite(statePath,state)}
function persist(next:State){
 const saved={...next,revision:state.revision+1,updatedAt:new Date().toISOString()};
 atomicWrite(backupPath,state);atomicWrite(statePath,saved);state=saved;return saved;
}
// 書き出し: 各方向に wholeConstrual、各部分に independentPart を付ける。名詞が空の下書きの候補は含めない。
function exportedIndependent(p:IndependentPart){
 return {reviewStatus:p.reviewStatus,candidates:p.candidates.filter(c=>c.noun.trim()!=='').map((c,i)=>({rank:i+1,...c})),noCandidate:p.noCandidate,noCandidateReason:p.noCandidateReason,ai:p.ai};
}
function exportedWhole(w:WholeConstrual){
 return {reviewStatus:w.reviewStatus,candidates:w.candidates.filter(c=>c.noun.trim()!=='').map((c,i)=>({rank:i+1,...c})),noConstrual:w.noConstrual,noConstrualReason:w.noConstrualReason,needsTextCheck:w.needsTextCheck,ai:w.ai};
}
function exported(){
 const {independentParts,wholeConstruals,...base}=state;
 const layers=new Map(independentParts.rows.map(r=>[r.id,r])),wholes=new Map(wholeConstruals.rows.map(r=>[r.id,r]));
 return {...base,catalogRevision:PRIMARY_REGION_CATALOG_REVISION,partitionStatus:'all_30_user_confirmed',orientationCount:120,independentPartSchemaVersion:independentVersion,wholeConstrualSchemaVersion:wholeVersion,
 results:state.results.map(r=>{
  const t=byId.get(r.id)!,layer=layers.get(r.id)!;
  return {...r,figureId:t.figureId,rotation:t.rotation,size:t.size,wholeConstrual:exportedWhole(wholes.get(r.id)!),
   parts:r.parts.map((p,i)=>({...t.parts[i],...p,construal:{status:'hypothesis',candidates:p.candidates},independentPart:exportedIndependent(layer.parts[i])})),
   relations:t.relations,
  };
 })};
}
// 取り込み: 書き出しの各部分の independentPart・各方向の wholeConstrual から層を作る。この層を持たない旧版の書き出しは、現在の層をそのまま保つ。
function importedLayer(documentRows:any[]):IndependentLayer{
 const current=new Map(state.independentParts.rows.map(r=>[r.id,r]));
 const given=new Map<string,any>(documentRows.map(r=>[r.id,r]));
 return {schemaVersion:independentVersion,rows:templates.map(t=>{
  const parts:any[]=given.get(t.id).parts,have=parts.filter(p=>p?.independentPart!==undefined).length;
  if(have===0)return current.get(t.id)!;
  if(have!==parts.length)throw Error('独立部分の見立てが一部の部分にしかありません。');
  return {id:t.id,parts:t.parts.map((p,i)=>independentPart({id:p.id,...parts[i].independentPart},p.id))};
 })};
}
function importedWholeLayer(documentRows:any[]):WholeLayer{
 const current=new Map(state.wholeConstruals.rows.map(r=>[r.id,r]));
 const given=new Map<string,any>(documentRows.map(r=>[r.id,r]));
 return {schemaVersion:wholeVersion,rows:templates.map(t=>{
  const w=given.get(t.id).wholeConstrual;
  return w===undefined?current.get(t.id)!:wholeConstrual({id:t.id,...w},t);
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
   // independentParts・wholeConstruals を送らない旧版の画面・道具は、保存済みの層を変えない。
   const independentParts=input.independentParts===undefined?state.independentParts:independentLayer(input.independentParts);
   const wholeConstruals=input.wholeConstruals===undefined?state.wholeConstruals:wholeLayer(input.wholeConstruals);
   return send(200,persist({...state,currentId:input.currentId,results,independentParts,wholeConstruals}));
  }
  const imported=input.document;
  if(imported?.schemaVersion!==schemaVersion||imported.sourceSha256!==sourceSha256||!byId.has(imported.currentId))throw Error('このページで書き出した同じ版のJSONを指定してください。');
  const results=rows(imported.results);
  return send(200,persist({...state,currentId:imported.currentId,results,independentParts:importedLayer(imported.results),wholeConstruals:importedWholeLayer(imported.results)}));
 }catch(e){return send(400,{error:e instanceof Error?e.message:String(e)})}
});
server.listen(port,'127.0.0.1',()=>console.log('Orientation review: http://127.0.0.1:'+port+'/\nState: '+statePath));
