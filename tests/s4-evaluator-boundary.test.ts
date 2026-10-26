import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile} from 'node:fs/promises';
import {runJevEvaluation} from '../dialogue-model/runtime/diagnostics/jev-decision-eval/live.ts';
import {JevTurnError} from '../dialogue-model/runtime/v2/jev-turn.ts';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
// Portable private temp root (macOS /private/tmp is absent on Linux CI).
const PRIVATE_TMP = realpathSync(tmpdir());
for(const [code,expected] of [['invalid_intervention','evaluation_unavailable'],['alternative_failed','evaluation_unavailable'],['observation_failed','observation_failed'],['untyped','evaluation_unavailable']] as const)test('legacy evaluator closed error '+code,async()=>{
 const root=await mkdtemp(PRIVATE_TMP + '/LushYukawa-evaluator-');let directory='',calls=0;
 await runJevEvaluation({outputDir:root,seed:1},{execution:'mock',expectedModel:'synthetic-model',cases:[{id:'boundary-control',steps:[{text:'Control?'}]}] as any,onStarted:d=>directory=d,client:{async complete(){calls++;throw Error('unreached');}},createComponents(){throw code==='untyped'?new Error('synthetic'):new JevTurnError(code);}});
 const lines=(await readFile(directory+'/failures.private.jsonl','utf8')).trim().split('\n').map(s=>JSON.parse(s));assert.equal(lines.length,1);assert.equal(lines[0].code,expected);assert.equal(calls,0);
});
