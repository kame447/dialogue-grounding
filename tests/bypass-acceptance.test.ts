// CONTRACT 7a36fc83. Synthetic data and in-memory fake transports only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as adapter from '../dialogue-model/runtime/decision/jev-decision.ts';
import {JEV_ACTIONS} from '../dialogue-model/runtime/decision/contract.ts';
import type {JevAction,JevDecision,JevDecisionInput,JevTarget} from '../dialogue-model/runtime/decision/contract.ts';
import type {JevDecisionPayload} from '../dialogue-model/runtime/decision/jev-decision.ts';

const fixture=(name:string)=>JSON.parse(readFileSync(new URL(`./fixtures/bypass-acceptance/${name}`,import.meta.url),'utf8'));
const input=()=>fixture('MINIMAL-INPUT.json') as JevDecisionInput;
const mock=()=>fixture('MINIMAL-ORIGINAL-MOCK.json') as JevDecision;
const native=()=>fixture('MINIMAL-ORIGINAL-NATIVE.json') as JevDecision;
const pin='376d569120ca36a3eceaf5ab95410f7eb83f25fbb681e7566a684b97c35165c8';
const cfg=(veto=false)=>({policy:`bypass_acceptance_v1:${veto?'veto':'accept'}`,vetoActions:veto?['defer','move_on']:[],tableSha256:pin});
// Missing-entry RED is explicit and each test retains its intended semantic assertion.
let imported:Record<string,any>|null=null;
try { imported=await import('../dialogue-model/runtime/decision/bypass-acceptance.ts' as string); } catch(error) {
 if ((error as NodeJS.ErrnoException).code!=='ERR_MODULE_NOT_FOUND') throw error;
}
function core(){assert.ok(imported,'R-a: new acceptance entry does not exist on fa84980');return imported;}
function frozen<T>(x:T):T {if(x&&typeof x==='object'){Object.values(x).forEach(frozen);Object.freeze(x);}return x;}
const projection=(d:JevDecision)=>({action:d.action,target:d.target,name:d.name,feature:d.feature,observe:d.observe,...(Object.hasOwn(d,'detailFigureIds')?{detailFigureIds:d.detailFigureIds}:{})});
const code=(c:string)=>(e:unknown)=>e instanceof core().BypassAcceptanceError&&(e as any).code===c&&(e as Error).message===c;
const inner=(stage:string,c:string)=>(e:unknown)=>code('alternative_failed')(e)&&assert.deepEqual((e as any).intervention.failure,{reasonCode:'alternative_failed',inner:{stage,code:c}})===undefined;
function response(p:JevDecisionPayload,action:JevAction='defer',target='figure_0',scores:Record<string,number>={}) {
 return {model:adapter.JEV_DECISION_MODEL,id:'gen-s4-synthetic',usage:{cost:0},answers:Object.fromEntries(Object.entries(p.questions).map(([key,q])=>{
 const choice=key==='action'?action:key==='target'?target:key.startsWith('candidate_')?'include':Object.keys(q.criteria)[0];
 const probabilities=Object.fromEntries(Object.keys(q.criteria).map(label=>[label,key==='action'?(scores[label]??(label===action?1:0)):(label===choice?1:0)]));
 return [key,{type:'choice',choice,probabilities}];}))};
}
async function decision(i:JevDecisionInput,action:JevAction,target='figure_0',scores:Record<string,number>={}){
 const client=adapter.createJevDecisionClient({enabled:true,readKey:async()=> 'sk-or-SYNTHETIC-s4-test-key-only',fetchImpl:async(_url,init)=>new Response(JSON.stringify(response(JSON.parse(init.body as string),action,target,scores)))})!;
 return await client.decide(i);
}
async function detail(i:JevDecisionInput,selected:{action:JevAction;target:JevTarget}){
 const target=selected.target.kind==='single'?`figure_${i.ownSlots.indexOf(selected.target.figureId)}`:selected.target.kind;
 const d=await decision(i,selected.action,target);
 return {executed:projection(d),evidence:d.evidence.stages![1]};
}

test('C legacy control: frozen synthetic native original is valid before new entry exists',()=>{
 assert.deepEqual(adapter.validateJevDecision(native(),input()),native());
 assert.equal(createHash('sha256').update(readFileSync(new URL('./fixtures/bypass-acceptance/bypass-acceptance-v1.canonical.json',import.meta.url))).digest('hex'),pin);
});
test('C API and immutable canonical policy identity',()=>{
 const c=core();for(const name of ['interventionForStrategy','planBypassAcceptance','applyBypassAcceptance','BypassAcceptanceError'])assert.equal(typeof c[name],'function');
 const bytes=readFileSync(new URL('./fixtures/bypass-acceptance/bypass-acceptance-v1.canonical.json',import.meta.url),'utf8');
 assert.equal(c.BYPASS_ACCEPTANCE_V1_CANONICAL_JSON,bytes);assert.equal(c.BYPASS_ACCEPTANCE_V1_TABLE_SHA256,pin);assert.deepEqual(c.BYPASS_ACCEPTANCE_V1,JSON.parse(bytes));assert.ok(Object.isFrozen(c.BYPASS_ACCEPTANCE_V1.policies['repair-first'].vetoActions));
 assert.deepEqual(c.interventionForStrategy('repair-first'),cfg(true));assert.deepEqual(c.interventionForStrategy('bypass-enabled'),cfg());
});
for(const bad of [null,undefined,0,true,[],['repair-first'],'REPAIR-FIRST','repair-first ',{toString:()=> 'repair-first'}])test(`C policy label type ${String(bad)}`,()=>assert.throws(()=>core().interventionForStrategy(bad),code('invalid_intervention')));
for(const [name,change] of Object.entries({null:():null=>null,missing:()=>({policy:'bypass_acceptance_v1:accept',vetoActions:[]}),unknown:()=>({...cfg(),policy:'other'}),digest:()=>({...cfg(),tableSha256:'0'.repeat(64)}),extra:()=>({...cfg(),extra:true}),wrongVeto:()=>({...cfg(true),vetoActions:['move_on','defer']}),scalarArray:()=>({...cfg(),policy:['bypass_acceptance_v1:accept']}),nullProto:()=>Object.assign(Object.create(null),cfg())}))test(`C closed config ${name}`,()=>assert.throws(()=>core().planBypassAcceptance(input(),mock(),change()),code('invalid_intervention')));
for(const action of JEV_ACTIONS.filter(a=>a!=='request_observation'))test(`C A1/A2 adopted ${action}`,async()=>{
 const c=core(),i=input(),d=mock();d.action=action;d.target={kind:'single',figureId:'own-0'};
 if(action==='propose_name'||action==='agree')d.name='name-0';if(action==='confirm'||action==='repair')d.feature='feature-0';
 const before=structuredClone({i,d});let calls=0;
 const r=await c.applyBypassAcceptance(frozen(i),frozen(d),cfg(),async()=>{calls++;throw Error('unexpected');});
 assert.deepEqual(r.executed,projection(d));assert.equal(r.intervention.reasonCode,'no_intervention');assert.equal(r.intervention.disposition,'adopted');assert.equal(r.intervention.rerank,null);assert.equal(r.intervention.alternative,null);assert.equal(r.intervention.detailEvidence,null);assert.equal(r.intervention.failure,null);assert.equal(calls,0);assert.deepEqual({i,d},before);
 assert.deepEqual(Object.keys(r).sort(),['executed','intervention']);assert.ok(Object.isFrozen(r.executed.target));
 if(!['defer','move_on'].includes(action)){const v=await c.applyBypassAcceptance(i,d,cfg(true));assert.deepEqual(v.executed,r.executed);assert.equal(v.intervention.reasonCode,'not_in_veto_set');}
});
test('C own omitted detailFigureIds stays absent; [] stays present',async()=>{
 const c=core(),a=await c.applyBypassAcceptance(input(),mock(),cfg());assert.equal(Object.hasOwn(a.executed,'detailFigureIds'),false);
 const d=mock();d.detailFigureIds=[];const b=await c.applyBypassAcceptance(input(),d,cfg());assert.deepEqual(b.executed.detailFigureIds,[]);assert.equal(Object.hasOwn(b.executed,'detailFigureIds'),true);
});
for(const [name,change] of Object.entries({extra:(d:any)=>({...d,raw:'private'}),speakerLike:(d:any)=>({...d,action:['accept']}),undefinedDetail:(d:any)=>({...d,detailFigureIds:undefined}),calibrated:(d:any)=>({...d,calibrated:true}),target:(d:any)=>({...d,target:{kind:'single',figureId:'other'}}),observation:(d:any)=>({...d,action:'request_observation'}),accessor:(d:any)=>Object.defineProperty(d,'action',{enumerable:true,get(){throw Error('must not evaluate')}}),symbol:(d:any)=>({...d,[Symbol('extra')]:1}),prototype:(d:any)=>Object.setPrototypeOf(d,{})}))test(`C invalid original ${name}`,()=>assert.throws(()=>core().planBypassAcceptance(input(),change(mock()),cfg()),code('invalid_original')));
for(const [name,change] of Object.entries({extra:(i:any)=>({...i,condition:'repair-first'}),wrongTurn:(i:any)=>({...i,turn:'1'}),undefinedOptional:(i:any)=>({...i,humanReferent:undefined}),slots:(i:any)=>({...i,ownSlots:['own-0']}),cycle:(i:any)=>{i.priorClaims.push(i);return i;},getter:(i:any)=>Object.defineProperty(i,'turn',{enumerable:true,get(){throw Error('must not evaluate')}})}))test(`C invalid input ${name}`,()=>assert.throws(()=>core().planBypassAcceptance(change(input()),mock(),cfg()),code('invalid_input')));
test('C validation precedence config before input before original before callback',async()=>{
 const c=core();assert.throws(()=>c.planBypassAcceptance(null,null,null),code('invalid_intervention'));
 assert.throws(()=>c.planBypassAcceptance(null,null,cfg()),code('invalid_input'));
 await assert.rejects(c.applyBypassAcceptance(input(),null,cfg(),null),code('invalid_original'));
 await assert.rejects(c.applyBypassAcceptance(input(),mock(),cfg(),null),code('invalid_detail_callback'));
});
test('C A3 plan uses saved native action scores without changing original target',()=>{
 const c=core(),i=input(),d=native(),before=structuredClone(d);const p=c.planBypassAcceptance(i,d,cfg(true));
 assert.deepEqual(p,{original:projection(d),policy:cfg(true).policy,disposition:'rejected',reasonCode:'vetoed_bypass_action',rerank:{policyId:'saved_action_scores_v1',ranking:[{action:'confirm',score:0.7},{action:'accept',score:0.1},{action:'propose_name',score:0},{action:'repair',score:0},{action:'revisit',score:0},{action:'agree',score:0},{action:'close',score:0}],selected:{action:'confirm',target:{kind:'single',figureId:'own-0'}}}});assert.deepEqual(d,before);assert.ok(Object.isFrozen(p.rerank.ranking));
});
test('C A4 zero/tie remains eligible and literal JEV_ACTIONS tie picks accept',async()=>{
 const c=core(),i=input(),d=await decision(i,'move_on');let calls=0;
 const r=await c.applyBypassAcceptance(i,d,cfg(true),async()=>{calls++;throw Error('unexpected');});
 assert.equal(r.executed.action,'accept');assert.equal(calls,0);assert.deepEqual(r.intervention.rerank.ranking.map((r:any)=>r.action),['accept','propose_name','confirm','repair','revisit','agree','close']);
});
for(const action of ['accept','revisit','close'] as const)test(`C no-detail ${action} costs zero callbacks`,async()=>{
 const c=core(),i=input(),d=await decision(i,'defer','figure_0',{[action]:0.9});let calls=0;
 const r=await c.applyBypassAcceptance(i,d,cfg(true),async()=>{calls++;throw Error('unexpected');});
 assert.deepEqual(r.executed,{action,target:d.target,name:null,feature:null,observe:null,detailFigureIds:[]});assert.equal(calls,0);assert.equal(r.intervention.detailEvidence,null);assert.deepEqual(r.intervention.alternative,r.executed);
});
for(const action of ['propose_name','agree','confirm','repair'] as const)test(`C detail ${action} exactly one private-free selected callback`,async()=>{
 const c=core(),i=input(),d=await decision(i,'defer','figure_0',{[action]:0.9}),before=JSON.stringify({i,d});let calls=0;
 const r=await c.applyBypassAcceptance(i,d,cfg(true),async(ci:any,s:any)=>{calls++;assert.deepEqual(ci,i);assert.deepEqual(s,{action,target:d.target});assert.doesNotMatch(JSON.stringify({ci,s}),/bypass_acceptance|vetoActions|vetoed|rejected/);return detail(ci,s);});
 assert.equal(calls,1);assert.equal(r.executed.action,action);assert.deepEqual(r.executed.target,d.target);assert.deepEqual(r.executed.detailFigureIds,['own-0']);assert.equal(r.intervention.detailEvidence.stage,'detail');assert.equal(JSON.stringify({i,d}),before);
});
test('C preflight skips invalid single-name targets and retains full multiple scope',async()=>{
 const c=core(),i=input(),d=await decision(i,'defer','multiple',{propose_name:1,agree:1,confirm:0.8});const p=c.planBypassAcceptance(i,d,cfg(true));
 assert.equal(p.rerank.selected.action,'confirm');assert.deepEqual(p.rerank.selected.target,d.target);assert.equal(p.rerank.ranking.some((x:any)=>['propose_name','agree'].includes(x.action)),false);
 const r=await c.applyBypassAcceptance(i,d,cfg(true),detail);assert.deepEqual(r.executed.target,d.target);assert.deepEqual(r.executed.detailFigureIds,['own-0']);
});
test('C preflight skips empty catalogs and revisit none before any send',async()=>{
 const c=core(),i=input();i.observations.figures.forEach(f=>{f.holistic=[];f.analytic={shapes:[],composition:'',relations:[]};});
 const d=await decision(i,'move_on','none',{confirm:1,repair:1,propose_name:1,agree:1,revisit:1,close:0.5});let calls=0;
 const r=await c.applyBypassAcceptance(i,d,cfg(true),async()=>{calls++;throw Error('unexpected');});assert.equal(r.executed.action,'close');assert.equal(calls,0);
});
test('C A4 input-negative: valid mock cannot fabricate saved scores',async()=>{
 const c=core(),d=mock();d.action='move_on';assert.throws(()=>c.planBypassAcceptance(input(),d,cfg(true)),inner('rerank','invalid_scores'));
});
for(const bad of [NaN,Infinity,-0.1,1.1,'0.8',null,[],undefined])test(`C invalid complete native score ${String(bad)}`,()=>{
 const c=core(),d=native();(d.evidence.scores.action as any).confirm=bad;assert.throws(()=>c.planBypassAcceptance(input(),d,cfg(true)),code('invalid_original'));
});
test('C native missing score cannot become ordinary no-candidate run',()=>{
 const c=core(),d=native();delete d.evidence.scores.action.confirm;delete d.evidence.stages![0].scores.action.confirm;assert.throws(()=>c.planBypassAcceptance(input(),d,cfg(true)),code('invalid_original'));
});
test('C missing detail callback fails closed, executed never committed',async()=>{
 await assert.rejects(core().applyBypassAcceptance(input(),native(),cfg(true)),inner('detail','detail_unavailable'));
});
for(const c of ['timeout','aborted','cost_cap','network_error'] as const)test(`C callback ${c} preserved without retry`,async()=>{
 let calls=0;await assert.rejects(core().applyBypassAcceptance(input(),native(),cfg(true),async()=>{calls++;throw new adapter.JevDecisionError(c);}),inner('detail',c));assert.equal(calls,1);
});
for(const thrown of [Error('PRIVATE_ERROR_CANARY'),{toString:null},null,'PRIVATE_ERROR_CANARY'])test('C arbitrary callback failure is fixed/sanitized',async()=>{
 await assert.rejects(core().applyBypassAcceptance(input(),native(),cfg(true),async()=>{throw thrown;}),(e:any)=>{assert.equal(e.code,'alternative_failed');assert.equal(e.intervention.failure.inner.code,'invalid_response');assert.equal(e.intervention.alternative,null);assert.equal(e.intervention.detailEvidence,null);assert.doesNotMatch(JSON.stringify(e),/PRIVATE_ERROR_CANARY/);assert.ok(Object.isFrozen(e.intervention.failure.inner));return true;});
});
test('C valid detail evidence cannot authorize a changed execution action/target',async()=>{
 await assert.rejects(core().applyBypassAcceptance(input(),native(),cfg(true),async(i:any,s:any)=>{const r=await detail(i,s);r.executed.target={kind:'none'};return r;}),inner('executed','invalid_executed'));
});
test('C malformed resolved detail evidence fails, not another candidate',async()=>{
 let calls=0;await assert.rejects(core().applyBypassAcceptance(input(),native(),cfg(true),async()=>{calls++;return {executed:projection(mock()),evidence:{}};}),inner('detail','invalid_response'));assert.equal(calls,1);
});
test('C trace exact keys and no old evidence overwritten',async()=>{
 const c=core(),i=input(),d=native(),copy=structuredClone(d);const r=await c.applyBypassAcceptance(i,d,cfg(true),detail);
 assert.deepEqual(Object.keys(r.intervention).sort(),['schemaVersion','policy','disposition','reasonCode','original','rerank','alternative','detailEvidence','failure'].sort());assert.deepEqual(d,copy);assert.equal(Object.hasOwn(r.executed,'evidence'),false);assert.equal(r.intervention.schemaVersion,'jev_intervention_v1');
});

for(const action of ['propose_name','agree','confirm','repair'] as const)test(`C native selected-detail ${action}: one ordinary payload and parser`,async()=>{
 const i=input(),selected={action,target:{kind:'single' as const,figureId:'own-0'}},wire:JevDecisionPayload[]=[];
 const client=adapter.createJevDecisionClient({enabled:true,readKey:async()=> 'sk-or-SYNTHETIC-s4-test-key-only',fetchImpl:async(_url,init)=>{const p=JSON.parse(init.body as string);wire.push(p);return new Response(JSON.stringify(response(p)));}})! as any;
 assert.equal(typeof client.completeDetail,'function','R-a: selected-detail adapter absent');assert.equal(typeof (adapter as any).parseJevExecutedDetail,'function');
 const r=await client.completeDetail(i,selected);assert.equal(wire.length,1);assert.deepEqual(wire[0],adapter.buildJevDecisionDetailPayload(i,selected));assert.equal(r.executed.action,action);assert.deepEqual(r.executed.target,selected.target);assert.equal(r.evidence.stage,'detail');assert.deepEqual((adapter as any).parseJevExecutedDetail(i,selected,r.evidence),r.executed);assert.equal(client.callCount,1);assert.equal(client.lastEvidence.stages.length,1);assert.equal(client.lastEvidence.status,'ok');
});
for(const action of ['request_observation','accept','close','revisit'] as const)test(`C selected-detail rejects ${action} before key/read/send`,async()=>{
 let reads=0,sends=0;const client=adapter.createJevDecisionClient({enabled:true,readKey:async()=>{reads++;return 'sk-or-SYNTHETIC-s4-test-key-only';},fetchImpl:async()=>{sends++;throw Error('unexpected');}})! as any;
 assert.equal(typeof client.completeDetail,'function');await assert.rejects(client.completeDetail(input(),{action,target:{kind:'single',figureId:'own-0'}}),(e:unknown)=>e instanceof adapter.JevDecisionError);assert.equal(reads,0);assert.equal(sends,0);
});
test('C selected-detail cost budget rejects before send after a prior maximum',async()=>{
 let sends=0;const client=adapter.createJevDecisionClient({enabled:true,costCapUsd:0.05,readKey:async()=> 'sk-or-SYNTHETIC-s4-test-key-only',fetchImpl:async(_url,init)=>{sends++;const data=response(JSON.parse(init.body as string),'defer');data.usage.cost=0.04;return new Response(JSON.stringify(data));}})! as any;
 assert.equal(typeof client.completeDetail,'function');await client.decide(input());await assert.rejects(client.completeDetail(input(),{action:'confirm',target:{kind:'single',figureId:'own-0'}}),(e:any)=>e.code==='cost_cap');assert.equal(sends,1);
});
test('C selected-detail aborted signal rejects before key/send',async()=>{
 let reads=0,sends=0;const client=adapter.createJevDecisionClient({enabled:true,readKey:async()=>{reads++;return 'sk-or-SYNTHETIC-s4-test-key-only';},fetchImpl:async()=>{sends++;throw Error('unexpected');}})! as any;
 assert.equal(typeof client.completeDetail,'function');await assert.rejects(client.completeDetail(input(),{action:'confirm',target:{kind:'single',figureId:'own-0'}},{signal:AbortSignal.abort()}),(e:any)=>e.code==='aborted');assert.equal(reads,0);assert.equal(sends,0);
});
