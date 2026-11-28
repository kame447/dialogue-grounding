import { PRIMARY_REGION_TEMPLATES, PRIMARY_REGION_CATALOG_REVISION } from './primary-regions-data.ts';
import { REVIEWED_PART_GEOMETRY_VERSION, type PartGeometry, type PartPoint, type PartShape } from './part-geometry.ts';
import type { AnalyticObservation, HolisticObservation } from '../observation/contract.ts';

export { PRIMARY_REGION_CATALOG_REVISION };
export { REVIEWED_PART_GEOMETRY_VERSION };
type Region = {
 members:string[]; id:string; shape:PartShape; shapeName:string; sides:number|null; convex:boolean|null;
 areaPercent:number; outlines:PartPoint[][]; bbox:[number,number,number,number]; centroid:PartPoint;
 tipDirection:string|null; description:string;
 construal:{status:'hypothesis';candidates:string[]};
 contacts:{part:string;direction:string;relation:string}[];
};
type Initial={holistic:HolisticObservation[];analytic:AnalyticObservation;unknowns:string[]};
type Template={key:string;size:PartPoint;regions:Region[];initial:Initial};
export type ReviewedPartProjection={version:'tangram_primary_regions_v1';origin:PartPoint;size:PartPoint;regions:Region[]};
const round=(n:number)=>Math.round(n*1e8)/1e8||0;
const pointKey=([x,y]:number[])=>[Math.round(x*1e6),Math.round(y*1e6)].join(',');
const templates = new Map((PRIMARY_REGION_TEMPLATES as unknown as Template[]).map(t=>[t.key,t]));
function templateFor(geometry:PartGeometry):Template|undefined {
 if(geometry.version!==REVIEWED_PART_GEOMETRY_VERSION)return;
 const pieces=Array.from({length:7},(_,i)=>geometry.parts.find(p=>p.members.length===1&&p.members[0]===i+1)!.outlines[0]);
 const [w,h]=geometry.size;
 const key=pieces.map(p=>p.map(([x,y])=>pointKey([x/w,y/h])).sort().join(';')).join('|')+'@'+Math.round(h/w*1e6)/1e6;
 return templates.get(key);
}
/** Only selected self-side geometry is projected; no stimulus-bank ID or partner mapping. */
export function reviewedPartProjection(geometry:PartGeometry):ReviewedPartProjection|undefined {
 const template=templateFor(geometry);if(!template)return;
 const scale=geometry.size[0]/template.size[0];
 const scalePoint=([x,y]:PartPoint):PartPoint=>[round(x*scale),round(y*scale)];
 return {version:'tangram_primary_regions_v1',origin:[...geometry.origin],size:[...geometry.size],regions:template.regions.map(r=>({
  ...structuredClone(r),construal:{status:'hypothesis',candidates:[...r.construal.candidates]},outlines:r.outlines.map(p=>p.map(scalePoint)),bbox:r.bbox.map(x=>round(x*scale)) as Region['bbox'],
  centroid:scalePoint(r.centroid),
 }))};
}
export function readPreparedInitial(geometry:PartGeometry):Initial|undefined {
 const template=templateFor(geometry);return template?structuredClone(template.initial):undefined;
}
