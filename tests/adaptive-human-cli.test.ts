import test from 'node:test';
import assert from 'node:assert/strict';
import {main} from '../dialogue-model/runtime/diagnostics/adaptive-human/run.ts';

test('offline CLI accepts all explicit trial versions without silently falling back',async()=>{
  for(const version of ['adaptive_repair_v1','adaptive_repair_v2','adaptive_repair_v3'])
    await assert.rejects(main(['--out','/private/tmp/unused-adaptive-cli','--trial-version',version]),/chrome_or_cdp_required/);
  for(const args of [['--trial-version','adaptive_repair_v4'],['--strategy','unknown'],['--mode','live','--trial-version','adaptive_repair_v3']])
    await assert.rejects(main(['--out','/private/tmp/unused-adaptive-cli',...args]),/invalid_adaptive_human_arguments/);
});
