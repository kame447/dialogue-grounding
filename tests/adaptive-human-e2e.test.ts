import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runOffline} from '../dialogue-model/runtime/diagnostics/adaptive-human/offline.ts';
import {mockHuman, validateInput} from '../dialogue-model/runtime/diagnostics/adaptive-human/simulator.ts';

const modes=[{},...(['repair-first','bypass-enabled'] as const).map(strategy=>({strategy,technicalTrial:'adaptive_repair_v3' as const,
  jevActions:['confirm','repair','accept']}))];
for(const mode of modes) test(`offline P1 browser ${'strategy' in mode?mode.strategy:'default'}: adaptive chat, names, questionnaire, results and reload`,
  {skip: !process.env.ADAPTIVE_HUMAN_CHROME && !process.env.ADAPTIVE_HUMAN_CDP, timeout: 180000}, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'adaptive-human-e2e-'));
    // Set KEEP only to inspect this synthetic diagnostic's files with scanner v3.
    t.after(async () => { if (!process.env.ADAPTIVE_HUMAN_KEEP) await rm(directory, {recursive: true, force: true}); });
    let hooks = 0, calls = 0;
    const result = await runOffline({directory, ...mode, chrome: process.env.ADAPTIVE_HUMAN_CHROME, cdpOrigin: process.env.ADAPTIVE_HUMAN_CDP,
      beforeSimulatorTurn: async () => { await Promise.resolve(); hooks++; }, simulator: input => {
        assert.equal(hooks, ++calls, 'await serialization hook before each simulator call');
        validateInput(input);
        assert.deepEqual(Object.keys(input).sort(), ['boardImage', 'history', 'persona']);
        assert.equal(input.boardImage?.mimeType, 'image/png');
        assert.ok(input.boardImage!.base64.startsWith('iVBOR'), 'participant board screenshot is a PNG');
        for (const turn of input.history) assert.deepEqual(Object.keys(turn).sort(), ['speaker', 'text']);
        for (const hidden of ['"seed"', 'configId', 'assignmentId', 'strategy', 'jevLedger', 'jevTraces', 'repairFacts', 'replyVsPrevious', 'technicalTrial', 'synthetic-luna', 'holistic', 'ownImage'])
          assert.ok(!JSON.stringify(input).includes(hidden), hidden);
        return mockHuman(input);
      }});
    assert.equal(result.turns, 3); assert.equal(result.stopReason, 'turn_cap');
    assert.ok(result.lunaPosts > 0 && result.jevPosts > 0);
    const surfaces = JSON.parse(await readFile(join(directory, 'surfaces.private.json'), 'utf8'));
    assert.equal(surfaces.length, 9);
    const locked = JSON.parse(surfaces.find((s: any) => s.label === 'GET review (locked)').text);
    const unlocked = JSON.parse(surfaces.find((s: any) => s.label === 'GET review (unlocked)').text);
    assert.equal(locked.result, undefined); assert.ok(unlocked.result);
    const human = JSON.parse(await readFile(join(directory, 'human.private.json'), 'utf8'));
    assert.deepEqual(human.turns.map((v: any) => v.historyLength), [1, 3, 5]);
    assert.match(human.turns[1].output.utterance, /細い部分/);
    assert.equal(human.turns[2].output.private.understandingChange, 'increased');
    for (const surface of surfaces) {
      assert.equal(surface.status, 200);
      for (const key of ['"private"', 'understandingChange', 'repair-first', 'bypass-enabled', '"seed"', 'configId', 'jevLedger', 'jevTraces', 'repairFacts', 'replyVsPrevious', 'technicalTrial', 'synthetic-luna'])
        assert.ok(!surface.text.includes(key), key);
    }
    for (const file of ['surfaces.private.json', 'human.private.json', 'record.private.json'])
      assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
    const record=JSON.parse(await readFile(join(directory,'record.private.json'),'utf8'));
    if('technicalTrial' in mode){
      assert.deepEqual(record.options.technicalTrial,{version:mode.technicalTrial});
      assert.ok(record.jevTraces.some((r:any)=>r.repairFacts.length>0));
    }else assert.ok(!Object.hasOwn(record.options,'technicalTrial'));
    t.diagnostic(JSON.stringify({directory, ...result}));
  });
