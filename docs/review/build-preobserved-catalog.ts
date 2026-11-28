import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loopsOf, classify, type PartPoint } from '../../dialogue-model/runtime/stimuli/part-geometry.ts';
import { polygonArea, boundarySegments, intersectionArea, sharesEdge } from '../../dialogue-model/runtime/stimuli/geometry.mjs';
const raw=readFileSync(new URL('review-results-final.json',import.meta.url));
const source=JSON.parse(raw.toString());
const digest=createHash('sha256').update(raw).digest('hex');
assert.equal(digest,'dae9359580d64a8355e0648a822215a4cf8bd77ac9ff4b15623b38a4b288a5cd');
const hypotheses=JSON.parse(readFileSync(new URL('part-construal-hypotheses.json',import.meta.url),'utf8'));
const wholeHypotheses=JSON.parse(readFileSync(new URL('whole-construal-hypotheses.json',import.meta.url),'utf8'));
const round=(n:number)=>Math.round(n*1e6)/1e6||0;
function bounds(polygons:PartPoint[][]):[number,number,number,number] {
 const all=polygons.flat(),xs=all.map(p=>p[0]),ys=all.map(p=>p[1]),x=Math.min(...xs),y=Math.min(...ys);
 return [x,y,Math.max(...xs)-x,Math.max(...ys)-y].map(round) as [number,number,number,number];
}
function rotate([x,y]:PartPoint,turn:number):PartPoint{return [[x,y],[-y,x],[-x,-y],[y,-x]][turn] as PartPoint}
const pointKey=([x,y]:PartPoint)=>[Math.round(x*1e6),Math.round(y*1e6)].join(',');
const pieceKey=(pieces:PartPoint[][],w:number,h:number)=>pieces.map(p=>p.map(([x,y])=>pointKey([x/w,y/h])).sort().join(';')).join('|')+'@'+round(h/w);
const jp:Record<string,string>={triangle:'三角形',square:'正方形',rectangle:'長方形',rhombus:'ひし形',parallelogram:'平行四辺形',trapezoid:'台形',quadrilateral:'四角形',pentagon:'五角形',hexagon:'六角形',polygon:'多角形',compound:'複合形状'};
const direction=(dx:number,dy:number)=>Math.abs(dx)+Math.abs(dy)<1e-8?'中央':['右','右下','下','左下','左','左上','上','右上'][(Math.round(Math.atan2(dy,dx)/(Math.PI/4))+8)%8];
const centroid=(p:PartPoint[]):PartPoint=>{
 let a=0,x=0,y=0;
 for(let i=0;i<p.length;i++){const [u,v]=p[i],[s,t]=p[(i+1)%p.length],c=u*t-v*s;a+=c;x+=(u+s)*c;y+=(v+t)*c}
 return [x/(3*a),y/(3*a)];
};
function regionCentroid(polygons:PartPoint[][]):PartPoint{
 let x=0,y=0,a=0;for(const p of polygons){const w=polygonArea(p),c=centroid(p);x+=w*c[0];y+=w*c[1];a+=w}return [x/a,y/a];
}
function position([x,y]:PartPoint,w:number,h:number){
 const a=x/w<1/3?'左':x/w>2/3?'右':'',b=y/h<1/3?'上':y/h>2/3?'下':'';
 return a||b?a+b+'寄り':'中央付近';
}
function triangleInfo(p:PartPoint[]){
 if(p.length!==3)return {shapeName:'三角形',tipDirection:null};
 const lengths=p.map((_,i)=>Math.hypot(p[(i+1)%3][0]-p[(i+2)%3][0],p[(i+1)%3][1]-p[(i+2)%3][1]));
 const same=(a:number,b:number)=>Math.abs(a-b)<1e-6;
 const i=lengths.findIndex((v,i)=>same(lengths[(i+1)%3],lengths[(i+2)%3])&&!same(v,lengths[(i+1)%3]));
 const sorted=lengths.map(x=>x*x).sort((a,b)=>a-b),right=Math.abs(sorted[0]+sorted[1]-sorted[2])<1e-5;
 const name=right&&i>=0?'直角二等辺三角形':right?'直角三角形':i>=0?'二等辺三角形':'三角形';
 return {shapeName:name,tipDirection:i<0?null:direction(p[i][0]-(p[(i+1)%3][0]+p[(i+2)%3][0])/2,p[i][1]-(p[(i+1)%3][1]+p[(i+2)%3][1])/2)};
}
function genericConstrual(shape:string,loc:string){
 if(shape.includes('三角形'))return [loc.includes('上')?'屋根や尖った突起':loc.includes('下')?'ひれや尖った足':'翼や尖った突起'];
 if(shape==='正方形')return [loc.includes('上')?'四角い頭や箱':loc.includes('下')?'四角い足や台':'四角い出っ張り'];
 if(shape==='平行四辺形'||shape==='長方形')return ['細長い板や柄'];
 return ['角張った塊や胴体'];
}
assert.equal(source.results.length,30);
const entries:any[]=[];
for(const row of source.results){
 assert.equal(row.status,'確認済み');
 assert.equal(row.regions.length,hypotheses[row.figureId].length);
 const ids=row.atoms.map((a:any)=>a.id).sort();assert.deepEqual(row.groups.flat().sort(),ids);
 const atoms: {id:string; sourcePiece:number; polygon:PartPoint[]}[]=row.atoms;
 assert.equal(atoms.reduce((n,a)=>n+polygonArea(a.polygon),0),64800);
 for(let i=0;i<atoms.length;i++)for(let j=i+1;j<atoms.length;j++)assert.equal(intersectionArea(atoms[i].polygon,atoms[j].polygon),0);
 const original=Array.from({length:7},(_,i)=>loopsOf(atoms.filter(a=>a.sourcePiece===i+1).map(a=>a.polygon)).outlines[0]);
 for(let turn=0;turn<4;turn++){
  const rotated=original.map(p=>p.map(a=>rotate(a,turn))),[x,y,w,h]=bounds(rotated);
  const tx=(p:PartPoint):PartPoint=>{const [u,v]=rotate(p,turn);return [round(u-x),round(v-y)]};
  const pieces=original.map(p=>p.map(tx));
  const all=atoms.map(a=>a.polygon.map(tx));
  // The complete contour is available for independent geometry checks.
  const fullBoundary=boundarySegments(all);
  assert.ok(fullBoundary.length);
  const parts=row.groups.map((members:string[],i:number)=>{
   const polygons=atoms.filter(a=>members.includes(a.id)).map(a=>a.polygon.map(tx));
   const {outlines,simple}=loopsOf(polygons), cls=classify(outlines,simple);
   assert.ok(simple,row.figureId);
   const area=polygons.reduce((n,p)=>n+polygonArea(p),0),areaPercent=area/64800*100;
   const bbox=bounds(outlines),[bx,by,bw,bh]=bbox,c=regionCentroid(polygons),loc=position(c,w,h);
   const tri=cls.shape==='triangle'?triangleInfo(outlines[0]):null;
   const shapeName=tri?.shapeName??(cls.shape==='polygon'&&cls.sides?cls.sides+'角形':jp[cls.shape]);
   const label=areaPercent>=40?'大きな':areaPercent<=12.5?'小さな':'中程度の';
   const geometryDescription=loc+'の'+label+shapeName+'（全体面積の'+areaPercent+'%、幅'+Math.round(bw/w*100)+'%、高さ'+Math.round(bh/h*100)+'%）'+(tri?.tipDirection?'。二等辺の頂点は'+tri.tipDirection+'向き':'')+(cls.convex===false?'。輪郭にくぼみがある':'')+'。';
   const candidates=turn===0?hypotheses[row.figureId][i]:genericConstrual(shapeName,loc);
   return {members,id:'P'+(i+1),...cls,shapeName,areaPercent,bbox,outlines,centroid:c,tipDirection:tri?.tipDirection??null,description:geometryDescription,construal:{status:'hypothesis',candidates,canonicalCandidates:hypotheses[row.figureId][i]},polygons};
  });
  assert.equal(parts.reduce((n:number,p:any)=>n+p.areaPercent,0),100);
  const regions=parts.map((p:any,i:number)=>{
   const {polygons,centroid:c,...rest}=p;
   const contacts=parts.flatMap((q:any,j:number)=>i!==j&&polygons.some((a:PartPoint[])=>q.polygons.some((b:PartPoint[])=>sharesEdge(a,b)))?[{part:q.id,direction:direction(q.centroid[0]-c[0],q.centroid[1]-c[1]),relation:'辺で接する'}]:[]);
   return {...rest,centroid:c.map(round),contacts};
  });
  const shapes=regions.map((r:any)=>r.id+': '+r.description);
  const relations=regions.flatMap((r:any,i:number)=>r.contacts.filter((c:any)=>Number(c.part.slice(1))>i+1).map((c:any)=>c.part+'は'+r.id+'から見て'+c.direction+'寄りで、辺を共有する。'));
  const composition=regions.map((r:any)=>r.id+'は'+r.description).join(' ');
  assert.ok(composition.length<=480);
  const [wholeLabel,wholeBasis]=wholeHypotheses[row.figureId][turn] as [string,number[]];
  const holistic=[{construal:'全体は'+wholeLabel+'のようにも見える',basis:wholeBasis.map(i=>regions[i-1].id+'：'+regions[i-1].description),status:'hypothesis'},...regions.map((r:any)=>({construal:r.id+'は'+r.construal.candidates.join('・')+'のようにも見える',basis:[r.description],status:'hypothesis'}))];
  entries.push({key:pieceKey(pieces,w,h),size:[w,h],figureId:row.figureId,rotation:turn*90,regions,initial:{holistic,analytic:{shapes,composition,relations},unknowns:['内部境界は人が確認した一つの分け方で、見立ては仮説。別の分け方や相手の認識もあり得る。']}});
 }
}
assert.equal(entries.length,120);
assert.equal(new Set(entries.map(e=>e.key)).size,120);
const json=JSON.stringify(entries);
writeFileSync(new URL('../../dialogue-model/runtime/stimuli/primary-regions-data.ts',import.meta.url),'// Generated from final user-reviewed partitions and separately authored hypotheses. Do not change without a new observation version.\nexport const PRIMARY_REGION_CATALOG_REVISION = "review-final-'+digest.slice(0,16)+'";\nexport const PRIMARY_REGION_TEMPLATES = '+json+';\n');
console.log('precomputed',entries.length,'orientations;',entries.reduce((n,e)=>n+e.regions.length,0),'regions;',Buffer.byteLength(json),'bytes');
