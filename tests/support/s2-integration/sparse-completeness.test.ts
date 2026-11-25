// Classification-specific series after POSTAUDIT-S2-INTEGRATION-01 e8b3c9d2.
// The broad pre-classification RED71ae7e5b remains separate historical bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const root=process.env.S2_SOURCE_ROOT??new URL('../../../',import.meta.url).pathname;
const {collectModelObservations}=await import(pathToFileURL(root+'/dialogue-model/runtime/diagnostics/parity-verify/model-observations.ts').href);
const {aggregateClassifiedModelObservations}=await import(pathToFileURL(root+'/dialogue-model/runtime/model-observations.ts').href);
const base=():any=>JSON.parse(readFileSync(new URL('./RECORDS-ACCEPTED-SETUP.json',import.meta.url),'utf8'));
function verifyPointers(r:any,o:any){
 const files:any={'run.private.json':r.run,'summary.private.json':r.summary,'warmup.private.json':r.warmup,'failure.private.json':r.failure,'verifier-evidence.private.json':r.evidence};
 for(const t of r.trials)if(t&&Number.isSafeInteger(t.order)&&t.order>=0)files[`trial-${t.order}.private.json`]=t;
 const pointers=[...['observations','lateObservations','missing','inconsistent','rejected'].flatMap(k=>o[k].flatMap((e:any)=>e.sources)),...o.notSent];
 for(const s of pointers){
  let v=files[s.file];assert.notEqual(v,undefined,'source must actually exist');
  for(const k of s.pointer===''?[]:s.pointer.slice(1).split('/').map((x:string)=>x.replace(/~1/g,'/').replace(/~0/g,'~'))){assert.ok(v!==null&&typeof v==='object'&&Object.hasOwn(v,k),'pointer must resolve to an actual own value: '+s.pointer);v=v[k];}
 }
}
function checked(r:any){const o=collectModelObservations(r),a=aggregateClassifiedModelObservations(o);verifyPointers(r,o);return {o,a};}
function missing(r:any){const {o,a}=checked(r);assert.equal(a.technicalState,'technical_unknown');assert.equal(a.reason,'evidence_missing');assert.ok(o.missing.some((e:any)=>e.reason==='source_missing'));return {o,a};}
test('S2F-1 baseline with valid skipped plan remains accepted',()=>{const {o,a}=checked(base());assert.equal(a.technicalState,'technical_accepted');assert.equal(o.missing.length,0)});
test('S2F-1 dense null started slot remains source_missing',()=>{const r=base();r.summary.skipped=[];r.summary.runOrder.push(null);const {o}=missing(r);assert.equal(o.observations.length,1)});
test('S2F-1 hole is a source gap, not a structural exception or acceptance',()=>{const r=base();r.summary.skipped=[];r.summary.runOrder.length=2;assert.equal(Object.hasOwn(r.summary.runOrder,1),false);const {o}=missing(r);assert.equal(o.observations.length,1);assert.ok(o.missing.some((e:any)=>e.sources.some((s:any)=>s.file==='summary.private.json'&&(s.pointer===''||s.pointer==='/runOrder'))))});
test('S2F-2 valid trial-only input uses its existing mapped root',()=>{const r={trials:base().trials};const {o}=missing(r);const gaps=o.missing.filter((e:any)=>e.reason==='source_missing');assert.ok(gaps.length>0);assert.ok(gaps.every((e:any)=>e.sources.length>0));assert.ok(gaps.every((e:any)=>e.sources.some((s:any)=>s.file==='trial-0.private.json')))});
test('S2F-2 genuinely anchorless input retains empty source exception',()=>{const {o}=missing({trials:[]});assert.ok(o.missing.some((e:any)=>e.reason==='source_missing'&&e.sources.length===0))});
test('analogous plan hole has source gap with only existing anchors',()=>{const r=base();delete r.run.manifest.trials[1];missing(r)});
test('analogous skipped hole cannot fabricate an absent index pointer',()=>{const r=base();delete r.summary.skipped[0];missing(r)});
test('analogous last evidence hole cannot disappear from seq completeness',()=>{const r=base();delete r.evidence.events[4];missing(r)});
test('analogous call hole cannot make complete owners out of a subset',()=>{const r=base();r.trials[0].calls.length=2;missing(r)});
test('analogous warmup calls hole remains a completeness source gap',()=>{const r=base();r.warmup.calls.length=1;missing(r)});
test('invalid trial order does not fabricate a trial filename',()=>{const r=base().trials[0];r.order=-1;const {o}=missing({trials:[r]});assert.ok(o.missing.every((e:any)=>e.sources.every((s:any)=>!s.file.startsWith('trial-'))))});
test('analogous sendIds hole cannot hide incomplete send ownership',()=>{const r=base();r.trials[0].calls[0].sendIds.length=2;missing(r)});
