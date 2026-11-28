import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const url=process.env.REVIEW_URL||'http://127.0.0.1:5498';
const get=async(path:string)=>{const r=await fetch(url+path);if(!r.ok)throw Error('GET '+path+': '+r.status);return r.json()};
const data=await get('/api/data'), state=await get('/api/state');
assert.equal(data.schemaVersion,'tangram_orientation_review_v1');assert.equal(data.catalogRevision,'review-final-dae9359580d64a83');assert.equal(data.templates.length,120);
const raw=readFileSync(new URL('concrete-construal-draft.tsv',import.meta.url),'utf8').trim().split('\n');
const drafts=new Map(raw.map(line=>{const [id,first,second,parts]=line.split('\t');return [id,{first,second,roles:parts.split('/')}]}));
assert.equal(raw.length,120);assert.equal(drafts.size,120);
const equal=(a:any,b:any)=>JSON.stringify(a)===JSON.stringify(b);
let updated=0;const skipped:string[]=[];
const results=state.results.map((r:any)=>{
 const t=data.templates.find((t:any)=>t.id===r.id),d=drafts.get(r.id);
 assert.ok(d&&t,r.id);assert.equal(d.roles.length,t.parts.length,r.id);
 const untouched=r.status==='未確認'&&!r.note&&r.whole===t.whole.construal&&equal(r.wholeBasis,t.whole.basis)&&r.parts.every((p:any,i:number)=>p.description===t.parts[i].description&&equal(p.candidates,t.parts[i].candidates));
 if(!untouched){skipped.push(r.id);return r;}
 updated++;
 return {...r,whole:'候補1：'+d.first+'\n候補2：'+d.second,
 wholeBasis:[d.first+'として見た場合：'+d.roles.map((role,i)=>t.parts[i].id+'＝'+role).join('、')+'。','候補2は別の見立て。どちらも形からの仮説で、正解名称ではない。'],
 parts:r.parts.map((p:any,i:number)=>({...p,candidates:[d.roles[i]+'（'+d.first+'として見た場合）',...p.candidates.filter((s:string)=>!/[や]|または|角張った塊|細長い板|尖った突起|四角い出っ張り/.test(s)&&s!==d.roles[i])].slice(0,3)}))};
});
assert.ok(results.every((r:any,i:number)=>r.id===state.results[i].id&&r.status===state.results[i].status&&r.note===state.results[i].note));
if(!updated){console.log('Nothing to update; all rows already changed or reviewed');process.exit(0)}
const response=await fetch(url+'/api/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...state,results})});
if(!response.ok)throw Error('Update rejected: '+response.status+' '+await response.text());
const saved=await response.json();
assert.equal(saved.revision,state.revision+1);assert.deepEqual(saved.results,results);
console.log(JSON.stringify({updated,skipped,revision:saved.revision,currentId:saved.currentId}));
