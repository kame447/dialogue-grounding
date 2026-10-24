// Synthetic researcher setup for tests. Never sent in participant requests.
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
export async function privateBaseOptions(t,{seed=1,strategy='repair-first',referenceMemory=false}={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'s5-test-private-'))),owners=join(root,'owners'),config=join(root,'assignment.json');await mkdir(owners,{mode:0o700});
 await writeFile(config,JSON.stringify({schemaVersion:'base_assignment_config_v1',configId:randomUUID(),revision:1,strategy,seed,referenceMemory}),{mode:0o600});
 t.after(()=>rm(root,{recursive:true,force:true}));
 return {baseAssignmentFile:config,baseStoreRoot:owners,runDir:null,adminToken:'synthetic-test-admin-012345678901234567890123',adminLimiter:{async limit(){return {success:true}}}};
}
