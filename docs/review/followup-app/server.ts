import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
const here = dirname(fileURLToPath(import.meta.url));
const bytes = readFileSync(join(here,'followup-data.json'));
const data = {...JSON.parse(bytes.toString()),dataSha256:createHash('sha256').update(bytes).digest('hex')};
const mod = {exports:{} as any};
runInNewContext(readFileSync(join(here,'..','region-editor-model.js'),'utf8'),{module:mod});
const model = mod.exports;
const directory = process.env.REVIEW_STATE_DIR || join(homedir(),'Library','Application Support','dialogue-grounding','figure-review-v2');
mkdirSync(directory,{recursive:true,mode:0o700});
const statePath=join(directory,'review-state.json'), backupPath=join(directory,'review-state.previous.json');
const pendingIds=new Set(['F2','F8']);
const seed=JSON.parse(readFileSync(join(here,'followup-seed.json'),'utf8'));
const locked=new Map(seed.filter((r:any)=>!pendingIds.has(r.figureId)).map((r:any)=>[r.figureId,JSON.stringify(r)]));
const validIds=new Set(data.items.map((i:any)=>i.figureId));
const reviewId='tangram-expression-review-20261128';
const port=Number(process.env.REVIEW_PORT || 5497);
function atomicWrite(path:string,value:unknown){
 const tmp=path+'.tmp-'+process.pid,fd=openSync(tmp,'w',0o600);
 try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd)}finally{closeSync(fd)}
 renameSync(tmp,path);
}
function validateRows(rows:any[]){
 const clean=JSON.parse(model.exportResults(data,rows)).results;
 for(const row of clean){
  if(row.draft.length>1000||row.note.length>10000||row.status.length>100)throw Error('入力が長すぎます。');
  if(locked.has(row.figureId)&&locked.get(row.figureId)!==JSON.stringify(row))throw Error('確定済みの図形は変更できません: '+row.figureId);
 }
 return clean;
}
let state:any;
if(existsSync(statePath)){
 state=JSON.parse(readFileSync(statePath,'utf8'));
 if(state.schemaVersion!=='tangram_review_saved_v1'||state.reviewId!==reviewId||state.dataSha256!==data.dataSha256||!Number.isSafeInteger(state.revision)||state.revision<0||!pendingIds.has(state.currentFigureId)||!Array.isArray(state.sourceHistory))throw Error('保存済みデータの識別情報が一致しません。上書きしません。');
 state.results=validateRows(state.results);
}else{
 state={schemaVersion:'tangram_review_saved_v1',reviewId,dataSha256:data.dataSha256,revision:0,updatedAt:new Date().toISOString(),currentFigureId:'F2',
 results:validateRows(seed),
 sourceHistory:[],provenance:data.provenance};
 atomicWrite(statePath,state);
}
function persist(next:any){
 const saved={...next,revision:state.revision+1,updatedAt:new Date().toISOString()};
 atomicWrite(backupPath,state);atomicWrite(statePath,saved);state=saved;return state;
}
function exportState(){
 return {...state,sourceHistory:state.sourceHistory.map(({text,...metadata}:any)=>metadata),results:state.results.map((row:any)=>{
  const item=data.items.find((i:any)=>i.figureId===row.figureId);
  return {...row,expression:model.format(item,row.groups),coordinateFrame:item.coordinateFrame,size:item.size,atoms:item.atoms,...(item.cut?{cut:item.cut}:{}),...(item.cuts?{cuts:item.cuts}:{}),
   regions:row.groups.map((members:string[])=>{
    const candidate=item.candidates.find((c:any)=>c.mask===model.mask(item,members));
    return {members,outlines:candidate.outlines.map((loop:number[])=>loop.map(p=>item.points[p]))};
   })};
 })};
}
async function body(req:any){
 if(!(req.headers['content-type']||'').startsWith('application/json'))throw Error('JSONを送信してください。');
 const chunks:Buffer[]=[];let size=0;
 for await(const chunk of req){size+=chunk.length;if(size>2000000)throw Error('入力が大きすぎます。');chunks.push(chunk)}
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
   if(path==='/api/export'){res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="tangram-review-results-followup.json"','Cache-Control':'no-store'});return res.end(JSON.stringify(exportState(),null,2)+'\n')}
   const asset=({'/':['index.html','text/html; charset=utf-8'],'/client.js':['client.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8'],'/region-editor-model.js':['../region-editor-model.js','text/javascript; charset=utf-8']} as Record<string,string[]>)[path];
   if(!asset)return send(404,{error:'not found'});
   res.writeHead(200,{'Content-Type':asset[1],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'"});
   return res.end(readFileSync(join(here,asset[0])));
  }
  if(req.method!=='POST'||!['/api/state','/api/import'].includes(path))return send(404,{error:'not found'});
  const input=await body(req);
  if(!input||input.revision!==state.revision)return send(409,{error:'別の画面で保存済みです。編集を退避してから最新データを読み込んでください。',revision:state.revision});
  if(path==='/api/state'){
   if(input.dataSha256!==data.dataSha256||!pendingIds.has(input.currentFigureId))throw Error('図形データが一致しません。');
   return send(200,persist({...state,currentFigureId:input.currentFigureId,results:validateRows(input.results)}));
  }
  if(typeof input.text!=='string'||input.text.length>300000)throw Error('取り込み結果が空または大きすぎます。');
  const imported=model.importResults(data,input.text,state.results);
  if(imported.sourceKind!=='expression_json')throw Error('追加確認ページから出力したJSONだけ読み込めます。');
  const history=[...state.sourceHistory,{importedAt:new Date().toISOString(),sourceKind:imported.sourceKind,text:imported.sourceText,cutUpdatedIds:imported.cutUpdatedIds}];
  let currentFigureId=state.currentFigureId;
  if(imported.sourceKind==='expression_json'){const source=JSON.parse(input.text);if(pendingIds.has(source.currentFigureId))currentFigureId=source.currentFigureId;}
  const saved=persist({...state,currentFigureId,results:validateRows(imported.states),sourceHistory:history});
  return send(200,{state:saved,importedCount:imported.importedCount,cutUpdatedIds:imported.cutUpdatedIds});
 }catch(error){return send(400,{error:error instanceof Error?error.message:String(error)})}
});
server.listen(port,'127.0.0.1',()=>console.log('Tangram review: http://127.0.0.1:'+port+'/\nSaved state: '+statePath));
