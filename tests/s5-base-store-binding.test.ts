import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';
import {load,clone,optionalImport,need} from './support/s5-base/support.ts';
const module=await optionalImport('dialogue-model/runtime/web/base-assignment-store.ts');
test('private archive cannot rebind a saved owner record to a different valid assignment',async t=>{
 const root=await mkdtemp('/private/tmp/SandyNoether-s5-binding-'),owner=load('OWNER-ACTIVE.json'),record=clone(owner.admissions.initial.record);
 record.assignment.assignmentId='99999999-9999-4999-8999-999999999999';
 const value={schemaVersion:'base_local_owner_v1',owner,archives:{[record.recordId]:record},questionnaires:{},ledger:{[record.recordId]:946684800000},tombstones:[],lastAccessMs:946684800000};
 const file=join(root,owner.ownerId+'.owner.json');await writeFile(file,JSON.stringify(value),{mode:0o600});
 let handle:any;t.after(async()=>{await handle?.close();await rm(root,{recursive:true,force:true})});
 const open=need(module,'openBaseFileStore');await assert.rejects(async()=>{handle=await open({root,ownerId:owner.ownerId,now:()=>946684800000})});
});
