import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
test('120 independent memo reviews persist, export/import, and cannot change the partition',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'orientation-review-test-'));
 const probe=createServer().listen(0,'127.0.0.1');await once(probe,'listening');
 const address=probe.address();assert.ok(address&&typeof address==='object');const port=address.port;
 await new Promise<void>((resolve,reject)=>probe.close(e=>e?reject(e):resolve()));
 const url='http://127.0.0.1:'+port;let child:ChildProcess|null=null;
 async function stop(){if(child&&child.exitCode===null){const end=once(child,'exit');child.kill();await end}child=null}
 async function start(){
  child=spawn(process.execPath,[new URL('./server.ts',import.meta.url).pathname],{env:{...process.env,REVIEW_PORT:String(port),REVIEW_STATE_DIR:dir},stdio:'pipe'});
  let err='';child.stderr!.on('data',c=>err+=c);
  for(let i=0;i<100;i++){try{const r=await fetch(url+'/api/state');if(r.ok)return}catch{}if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,50))}
  throw Error(err||'server failed');
 }
 const get=async(p:string)=>{const r=await fetch(url+p);assert.equal(r.status,200);return r.json()};
 const post=async(p:string,v:unknown,status=200)=>{const r=await fetch(url+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(v)});assert.equal(r.status,status);return r.json()};
 try{
  await start();const data=await get('/api/data');let state=await get('/api/state');
  assert.equal(data.templates.length,120);assert.equal(new Set(data.templates.map((t:any)=>t.figureId)).size,30);
  assert.equal(data.templates.reduce((n:number,t:any)=>n+t.parts.length,0),468);
  assert.equal(state.results.length,120);
  const f1=data.templates.filter((t:any)=>t.figureId==='F1');
  assert.deepEqual(f1.map((t:any)=>t.rotation),[0,90,180,270]);
  assert.deepEqual(f1.map((t:any)=>t.parts[0].tipDirection),['上','右','下','左']);
  for(const t of f1)assert.deepEqual(t.parts.map((p:any)=>p.areaPercent),[12.5,62.5,12.5,12.5]);
  const result=structuredClone(state.results);
  result[1].status='確認済み';result[1].whole='独立した90度の見立て';result[1].parts[0].candidates=['翼','先端'];result[1].parts[0].description='修正後の説明';
  result[1].note='記録';result[1].parts[0].outlines=[[[0,0],[1,0],[1,1]]];
  const update={revision:state.revision,sourceSha256:state.sourceSha256,currentId:'F1@180',results:result};
  state=await post('/api/state',update);
  assert.equal(state.results[0].whole,f1[0].whole.construal);
  assert.equal(state.results[1].whole,'独立した90度の見立て');
  assert.equal(state.results[1].status,'確認済み');assert.equal(state.currentId,'F1@180');
  assert.equal(state.results[2].status,'未確認');assert.ok(!Object.hasOwn(state.results[1].parts[0],'outlines'));
  await post('/api/state',update,409);
  const expected=state;await stop();await start();state=await get('/api/state');assert.deepEqual(state,expected);
  const exported=await get('/api/export');
  assert.equal(exported.results[1].parts[0].description,'修正後の説明');
  assert.deepEqual(exported.results[1].parts[0].outlines,f1[1].parts[0].outlines);
  assert.deepEqual(exported.results[1].parts[0].construal.candidates,['翼','先端']);
  state=await post('/api/import',{revision:state.revision,document:exported});
  assert.deepEqual(state.results,expected.results);assert.equal(state.currentId,expected.currentId);
  const invalid=structuredClone(state.results);invalid[0].parts[0].id='P999';
  await post('/api/state',{revision:state.revision,sourceSha256:state.sourceSha256,currentId:state.currentId,results:invalid},400);
  assert.deepEqual(await get('/api/state'),state);
  assert.equal(JSON.parse(readFileSync(join(dir,'review-state.json'),'utf8')).revision,state.revision);
  assert.ok(JSON.parse(readFileSync(join(dir,'review-state.previous.json'),'utf8')).revision<state.revision);
  assert.equal((await fetch(url+'/')).status,200);
 }finally{await stop();rmSync(dir,{recursive:true,force:true})}
});
