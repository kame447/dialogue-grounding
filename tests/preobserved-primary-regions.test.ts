import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { FIGURE_BANK } from '../dialogue-model/runtime/stimuli/figure-bank.ts';
import { createPartGeometry, validatePartGeometry, REVIEWED_PART_GEOMETRY_VERSION, PART_GEOMETRY_VERSION, type PartPoint } from '../dialogue-model/runtime/stimuli/part-geometry.ts';
import { reviewedPartProjection, readPreparedInitial } from '../dialogue-model/runtime/stimuli/primary-regions.ts';
import { transformPolygon, polygonArea } from '../dialogue-model/runtime/stimuli/geometry.mjs';
import { createTrialV2, modelView, participantView } from '../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { createLunaObserver, preparedObservationMemo, validateObservationMemo, buildReobservationMessages } from '../dialogue-model/runtime/observation/observe.ts';
import { createWorkerTerraObserver } from '../dialogue-model/runtime/observation/worker-terra-observer.ts';
import { modelPartGeometry, describePart, withPartDescriptions } from '../dialogue-model/runtime/observation/part-consumers.ts';
import { encodePartCatalogValue, decodePartCatalogValue } from '../workers/tangram-experiment/src/part-catalog-storage.ts';
import { validateParticipantModelPin } from '../dialogue-model/runtime/v2/participant-model-pin.ts';
import type { ObservationInput } from '../dialogue-model/runtime/observation/contract.ts';

const reviewed=JSON.parse(readFileSync(new URL('../docs/review/review-results-final.json',import.meta.url),'utf8')).results;
const geometry=(figure:typeof FIGURE_BANK[number],rotation:number,scale=48)=>createPartGeometry(figure.pieces.map(p=>transformPolygon(p.points.map(([x,y])=>[x*scale,y*scale]),{rotation,x:400,y:400}) as PartPoint[]),REVIEWED_PART_GEOMETRY_VERSION);

test('all 120 orientations match exactly the 117 user-confirmed groups, with correct relative area and rotated geometry',()=>{
 let count=0;
 for(const figure of FIGURE_BANK){
  const source=reviewed.find((r:any)=>r.figureId===figure.id);
  for(const rotation of [0,90,180,270]){
   const full=geometry(figure,rotation);
   const primary=reviewedPartProjection(full);
   assert.ok(primary,figure.id+' '+rotation);
   assert.equal(primary.regions.length,source.groups.length);
   assert.deepEqual(primary.regions.map(p=>p.members),source.groups);
   assert.equal(primary.regions.reduce((n,p)=>n+p.areaPercent,0),100);
   for(const p of primary.regions){
    assert.ok(Math.abs(p.outlines.reduce((n,loop)=>n+polygonArea(loop),0)/(48*48*8)*100-p.areaPercent)<1e-5);
    assert.ok(p.bbox[0]>=0&&p.bbox[1]>=0&&p.bbox[0]+p.bbox[2]<=full.size[0]+1e-6&&p.bbox[1]+p.bbox[3]<=full.size[1]+1e-6);
    assert.ok(p.construal.candidates.length);
    assert.equal(p.construal.status,'hypothesis');
   }
   const raw=readPreparedInitial(full)!;
   assert.ok(raw.holistic[0].construal.startsWith('全体'));
   assert.ok(raw.holistic.every(h=>h.status==='hypothesis'&&h.basis.length>0));
   assert.ok(raw.analytic.composition.length<=480);
   assert.deepEqual(validatePartGeometry(full),full);
   count+=primary.regions.length;
  }
 }
 assert.equal(count,468);
});
test('reviewed and legacy versions are distinct and do not reinterpret legacy indices',()=>{
 const full=geometry(FIGURE_BANK[0],0);
 const legacy=createPartGeometry(FIGURE_BANK[0].pieces.map(p=>p.points));
 assert.equal(legacy.version,PART_GEOMETRY_VERSION);
 assert.equal(reviewedPartProjection(legacy),undefined);
 assert.equal(modelPartGeometry(legacy).version,'tangram_part_index_v1');
 assert.equal(modelPartGeometry(full).version,'tangram_primary_regions_v1');
 assert.match(describePart(full,1)!,/62.5%/);
 assert.equal(describePart(full,4),undefined);
 assert.ok(describePart(legacy,4));
 assert.deepEqual(decodePartCatalogValue(encodePartCatalogValue({full,legacy})),{full,legacy});
});

test('initial observation reads the prepared memo without an API call or cache wait, and uses only current own-side parts',async()=>{
 const pin=validateParticipantModelPin({schemaVersion:'participant_model_pin_v1',terraModelId:'gpt-6.1-terra-2026-11-01',lunaModelId:'gpt-6-luna-2026-10-01',jevModelId:'typesafe/jev-1.14-20261001'});
 for(const ids of [['F1','F2','F8','F30'],['F6','F11','F16','F19','F20','F30']]){
  const trial=createTrialV2({seed:41,figureSelection:{mode:'custom',figureIds:ids}});
  const model=modelView(trial,{partObservationVersion:REVIEWED_PART_GEOMETRY_VERSION});
  const own:ObservationInput={ownImage:{mimeType:model.mimeType,base64:model.png.toString('base64')},ownAnchors:model.anchors,ownParts:model.parts!};
  assert.ok(modelView(trial,{partObservationVersion:PART_GEOMETRY_VERSION}).parts!.every((p:{parts:{version:string}})=>p.parts.version===PART_GEOMETRY_VERSION));
  let calls=0,cacheCalls=0;
  const observer=createLunaObserver({async complete(){calls++;throw Error('unexpected API request')}});
  const worker=createWorkerTerraObserver({modelPin:pin,own,visual:async()=>{calls++;throw Error('unexpected API request')},cache:{async read(){cacheCalls++;throw Error('unexpected cache wait')},async putIfAbsent(){cacheCalls++;throw Error('unexpected cache write')}}});
  for(const impl of [observer,worker]){
   const memo=await impl.observeAll(own);
   assert.ok(preparedObservationMemo(own,memo.observedAt));
   assert.deepEqual(validateObservationMemo(memo,own),memo);
   const projected=withPartDescriptions(memo);
   const text=JSON.stringify(projected);
   assert.doesNotMatch(text,/"figureId":"F\d+"|"rotation":|"canonicalCandidates":/);
   for(const h of participantView(trial).shapes)assert.ok(!text.includes(h.id));
   for(const f of projected.figures){
    const p=f.parts as any;
    assert.equal(p.version,'tangram_primary_regions_v1');assert.ok(p.regions.length<=5);
    assert.equal(p.regions.length,p.descriptions.length);
    assert.ok(!Object.hasOwn(p,'rows'));
   }
   const messages=buildReobservationMessages({...own,memo,figureIds:[own.ownAnchors[0].id],issue:{aspect:'part',question:'三角形の大きさは？',partnerConstrual:null}});
   const msg=JSON.stringify(messages);
   assert.ok(msg.includes('areaPercent'));assert.ok(msg.includes('hypothesis'));
   assert.ok(!msg.includes(own.ownAnchors[1].id));
  }
  assert.equal(calls,0);assert.equal(cacheCalls,0);
 }
});
