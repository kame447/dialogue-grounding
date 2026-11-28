import { readFileSync, writeFileSync } from 'node:fs';
import { loopsOf } from '../../../dialogue-model/runtime/stimuli/part-geometry.ts';
import { polygonArea, intersectionArea } from '../../../dialogue-model/runtime/stimuli/geometry.mjs';
import assert from 'node:assert/strict';
const read=(name:string)=>JSON.parse(readFileSync(new URL(name,import.meta.url),'utf8'));
const base=read('../region-expression-editor-data.json');
const result=read('../review-results-r287.json');
assert.equal(result.revision,287);
const patches:any={
 F2:{cuts:[{sourcePiece:2,endpoints:[[180,90],[270,90]]},{sourcePiece:3,endpoints:[[270,90],[360,90]]}],
 atoms:{'2':[[[270,0],[270,90],[180,90]],[[180,90],[270,90],[270,180],[90,180]]],
 '3':[[[270,0],[360,90],[270,90]],[[270,90],[360,90],[270,180]]]},
 groups:[['1','2b','3b','4'],['2a','3a'],['5','7'],['6']],
 explanation:'2と3を高さ90の位置で切り、1・2b・3b・4を大きな三角形にする案。残った2a+3aは小さな三角形。5+7と6は別のまとまり。'},
 F8:{cuts:[{sourcePiece:7,endpoints:[[450,0],[450,90]]}],
 atoms:{'7':[[[360,90],[450,0],[450,90]],[[450,0],[540,0],[450,90]]]},
 groups:[['3'],['1','2'],['4'],['5','6','7a'],['7b']],
 explanation:'7を中央の縦線で切り、左側7aを5・6と合わせて大きな三角形にする案。右側7bは独立。'}
};
const data={...base,round:3,provenance:{sourceRevision:result.revision,sourceSha256:'0ccf97e997c3e40bad1c7086bfa4323e8bc9e8b96169b8b809469edbaf62f1ae',pendingIds:['F2','F8']}};
const seeds:any[]=[];
for(const item of data.items){
 const row=result.results.find((r:any)=>r.figureId===item.figureId);
 assert.deepEqual(row.atoms,item.atoms);assert.deepEqual(row.size,item.size);
 const patch=patches[item.figureId];
 if(!patch){
  assert.equal(row.status,'確認済み');item.initialGroups=row.groups;
  seeds.push({figureId:row.figureId,groups:row.groups,status:row.status,note:row.note,draft:row.draft});
  continue;
 }
 const original=item.atoms;
 item.atoms=original.flatMap((a:any)=>{
  const parts=patch.atoms[a.id];if(!parts)return [a];
  assert.equal(parts.reduce((n:number,p:any)=>n+polygonArea(p),0),polygonArea(a.polygon));
  for(const p of parts)assert.equal(intersectionArea(p,a.polygon),polygonArea(p));
  assert.equal(intersectionArea(parts[0],parts[1]),0);
  return parts.map((polygon:any,i:number)=>({id:a.id+'ab'[i],sourcePiece:a.sourcePiece,polygon}));
 });
 for(let i=0;i<item.atoms.length;i++)for(let j=i+1;j<item.atoms.length;j++)assert.equal(intersectionArea(item.atoms[i].polygon,item.atoms[j].polygon),0);
 const keys=new Map<string,number>();const points:number[][]=[];
 const idx=(p:number[])=>{const key=p.join(',');if(!keys.has(key)){keys.set(key,points.length);points.push(p)}return keys.get(key)!};
 item.wholeMask=2**item.atoms.length-1;item.candidates=[];
 for(let mask=1;mask<=item.wholeMask;mask++){
  const parts=item.atoms.filter((_:any,i:number)=>mask&(1<<i)).map((a:any)=>a.polygon);
  const {outlines}=loopsOf(parts);
  const signed=(p:number[][])=>p.reduce((n,a,i)=>n+a[0]*p[(i+1)%p.length][1]-a[1]*p[(i+1)%p.length][0],0)/2;
  assert.equal(Math.abs(outlines.reduce((n,p)=>n+signed(p),0)),parts.reduce((n:number,p:any)=>n+polygonArea(p),0));
  item.candidates.push({mask,outlines:outlines.map(loop=>loop.map(idx))});
 }
 item.points=points;item.cuts=patch.cuts;delete item.cut;item.initialGroups=patch.groups;
 item.initialExpression=patch.groups.map((g:string[])=>g.join('+')).join(' / ');
 item.note=patch.explanation;item.previousNote=row.note;
 const mask=patch.groups[item.figureId==='F2'?0:3].reduce((n:number,id:string)=>n+2**item.atoms.findIndex((a:any)=>a.id===id),0);
 assert.equal(item.candidates.find((c:any)=>c.mask===mask).outlines[0].length,3);
 seeds.push({figureId:row.figureId,groups:patch.groups,status:'要再確認',note:row.note,draft:item.initialExpression});
}
writeFileSync(new URL('followup-data.json',import.meta.url),JSON.stringify(data)+'\n');
writeFileSync(new URL('followup-seed.json',import.meta.url),JSON.stringify(seeds)+'\n');
console.log('28 confirmed, 2 new proposals; all candidate areas verified');
