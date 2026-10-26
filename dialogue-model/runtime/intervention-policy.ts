// Pure version selection. Model-only validation deliberately precedes policy values.
import {resolveModelPolicy} from './model-policy.ts';
// Frozen C reference literal, not a caller-supplied/recomputed policy table.
const BYPASS_ACCEPTANCE_V1_TABLE_SHA256='376d569120ca36a3eceaf5ab95410f7eb83f25fbb681e7566a684b97c35165c8';
import type {InterventionPolicyReference} from './v2/research-profile.ts';
export type ResolvedInterventionPolicy=Readonly<{profileId:'research_trial_profile_v1'|'research_trial_profile_v2'|'research_trial_profile_v3';mode:'legacy'|'explicit';interventionPolicy:InterventionPolicyReference|null}>;
type Code='intervention_profile_invalid'|'intervention_contract_missing'|'intervention_contract_invalid'|'intervention_contract_unknown'|'intervention_table_mismatch';
export class InterventionIntegrationError extends Error {readonly code:Code;constructor(code:Code){super(code);this.name='InterventionIntegrationError';this.code=code;}}
const fail=(code:Code):never=>{throw new InterventionIntegrationError(code);};
const keys=['id','referenceMemory','decisionMode','humanReferent','localGrounding','initialObservation','questionLayout','utteranceStyle','maxReobservations','modelPolicy','timeouts','lunaRequest','outputLimit','modelContract','interventionPolicy'];
export function resolveInterventionPolicy(profile:unknown):ResolvedInterventionPolicy {
 let d!:PropertyDescriptorMap,id!:ResolvedInterventionPolicy['profileId'];
 try{
  if(!profile||typeof profile!=='object'||Object.getPrototypeOf(profile)!==Object.prototype)throw Error();
  d=Object.getOwnPropertyDescriptors(profile);
  if(!d.id?.enumerable||!Object.hasOwn(d.id,'value')||!['research_trial_profile_v1','research_trial_profile_v2','research_trial_profile_v3'].includes(d.id.value))throw Error();
  id=d.id.value;
  if(id==='research_trial_profile_v3') {if(Reflect.ownKeys(d).some(k=>typeof k!=='string'||!keys.includes(k)))throw Error();}
  else if(Object.hasOwn(d,'interventionPolicy'))throw Error();
 }catch{fail('intervention_profile_invalid');}
 // Never touch interventionPolicy accessors while diagnosing a model failure.
 resolveModelPolicy(profile);
 if(id!=='research_trial_profile_v3')return Object.freeze({profileId:id,mode:'legacy',interventionPolicy:null});
 if(!Object.hasOwn(d,'interventionPolicy'))fail('intervention_contract_missing');
 let version:unknown,digest:unknown;
 try{
  const p=d.interventionPolicy;
  if(!p.enumerable||!Object.hasOwn(p,'value')||!p.value||Object.getPrototypeOf(p.value)!==Object.prototype)throw Error();
  const r=Object.getOwnPropertyDescriptors(p.value),rk=Reflect.ownKeys(r);
  if(rk.length!==2||rk.some(k=>k!=='version'&&k!=='tableSha256')||['version','tableSha256'].some(k=>!r[k]?.enumerable||!Object.hasOwn(r[k],'value')))throw Error();
  version=r.version.value;digest=r.tableSha256.value;
  if(typeof version!=='string'||!version.length||typeof digest!=='string'||!/^[0-9a-f]{64}$/.test(digest))throw Error();
 }catch{fail('intervention_contract_invalid');}
 if(version!=='bypass_acceptance_v1')fail('intervention_contract_unknown');
 if(digest!==BYPASS_ACCEPTANCE_V1_TABLE_SHA256)fail('intervention_table_mismatch');
 return Object.freeze({profileId:id,mode:'explicit',interventionPolicy:Object.freeze({version:'bypass_acceptance_v1',tableSha256:BYPASS_ACCEPTANCE_V1_TABLE_SHA256})});
}
