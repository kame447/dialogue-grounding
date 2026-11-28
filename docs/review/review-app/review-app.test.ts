import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';

test('review edits, confirmation, export, import, restart and stale-write protection', async () => {
 const dir=mkdtempSync(join(tmpdir(),'tangram-review-test-'));
 const probe=createServer().listen(0,'127.0.0.1');await once(probe,'listening');
 const address=probe.address();assert.ok(address&&typeof address==='object');
 const port=address.port;await new Promise<void>((resolve,reject)=>probe.close(error=>error?reject(error):resolve()));
 const url='http://127.0.0.1:'+port;
 let child:ChildProcess|null=null;
 const get=async(path:string)=>{const r=await fetch(url+path);assert.equal(r.status,200);return r.json()};
 const post=async(path:string,body:unknown,expected=200)=>{const r=await fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,expected);return r.json()};
 async function stop(){if(child&&child.exitCode===null){const ended=once(child,'exit');child.kill();await ended}child=null}
 async function start(){
  child=spawn(process.execPath,[new URL('./server.ts',import.meta.url).pathname],{env:{...process.env,REVIEW_PORT:String(port),REVIEW_STATE_DIR:dir},stdio:'pipe'});
  let error='';child.stderr!.on('data',c=>error+=c);
  for(let i=0;i<100;i++){try{await get('/api/state');return}catch{if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,25))}}
  throw Error('server failed '+error);
 }
 try{
  await start();const data=await get('/api/data');let state=await get('/api/state');
  assert.equal(data.items.length,30);assert.equal(state.results.length,30);
  assert.equal(state.results[0].status,'確認済み');assert.equal(state.results.filter((r:any)=>r.status==='前回確認済み（分割未取得）').length,23);
  const rows=structuredClone(state.results);
  rows[1]={...rows[1],groups:[['1','2'],['3','4','5','6','7']],draft:'1+2 / 3+4+5+6+7',status:'確認済み'};
  rows[5]={...rows[5],draft:'1+2a+',status:'未確認',note:'入力途中'};
  const payload={revision:state.revision,dataSha256:data.dataSha256,currentFigureId:'F11',results:rows};
  state=await post('/api/state',payload);
  assert.equal(state.results[1].status,'確認済み');assert.equal(state.results[5].draft,'1+2a+');assert.equal(state.currentFigureId,'F11');
  assert.equal(JSON.parse(readFileSync(join(dir,'review-state.json'),'utf8')).revision,state.revision);
  await post('/api/state',payload,409);
  const before=state;await stop();await start();state=await get('/api/state');assert.deepEqual(state,before);
  const exported=await get('/api/export');
  assert.equal(exported.results[1].expression,'1+2 / 3+4+5+6+7');assert.equal(exported.results[1].regions.length,2);assert.ok(exported.results[1].regions[0].outlines.length);
  assert.equal(exported.results[5].draft,'1+2a+');assert.ok(JSON.stringify(exported).length<300000);
  const imported=await post('/api/import',{revision:state.revision,text:JSON.stringify(exported)});
  state=imported.state;assert.deepEqual(state.results,before.results);assert.equal(state.currentFigureId,'F11');assert.equal(imported.importedCount,30);
  const legacy=await post('/api/import',{revision:state.revision,text:'F3: 1+2 / 3+4+5+6+7 (確認済み)\nF6: 1+2+3 / 4 / 5+6+7 (確認済み)'});
  state=legacy.state;assert.equal(state.results[2].draft,'1+2 / 3+4+5+6+7');assert.equal(state.results[2].status,'確認済み');assert.equal(state.results[5].status,'未確認');assert.deepEqual(legacy.cutUpdatedIds,['F6']);assert.ok(state.results[5].groups.some((g:string[])=>g.join('+')==='1+2a+3'));
  assert.deepEqual(state.results[1],before.results[1]);
  const bad=structuredClone(state.results);bad[0].groups=[['1','1']];
  await post('/api/state',{revision:state.revision,dataSha256:data.dataSha256,currentFigureId:'F1',results:bad},400);
  assert.deepEqual(await get('/api/state'),state);
  assert.ok(JSON.parse(readFileSync(join(dir,'review-state.previous.json'),'utf8')).revision<state.revision);
  assert.equal((await fetch(url+'/')).status,200);
  assert.equal((await fetch(url+'/client.js')).status,200);
 }finally{await stop();rmSync(dir,{recursive:true,force:true})}
});
