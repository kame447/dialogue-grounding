import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startOfflineParticipant} from '../dialogue-model/runtime/diagnostics/adaptive-human/offline.ts';
import {createPersona, mockHuman} from '../dialogue-model/runtime/diagnostics/adaptive-human/simulator.ts';
import type {OfflineOptions} from '../dialogue-model/runtime/diagnostics/adaptive-human/offline.ts';

const modes: OfflineOptions[] = [{}, ...(['repair-first','bypass-enabled'] as const).map(strategy=>({strategy,technicalTrial:'adaptive_repair_v3' as const,
  jevActions:['confirm','repair','accept']}))];
const pairFacts: unknown[][]=[];
for(const mode of modes) test(`offline synthetic P1 HTTP ${mode.strategy??'default'} ${mode.technicalTrial??'OFF'}: chat, restart, submission (no browser claim)`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'adaptive-human-http-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const facts: unknown[]=[];
  const server = await startOfflineParticipant(directory,{...mode,onJevRequest(payload){
    const p=payload as any;
    if(p.questions.action||p.questions.repair_issue){
      const history=JSON.parse(p.state).repairHistory;
      if(mode.technicalTrial)facts.push(history.map((r:any)=>r.facts));
      else assert.ok(history.every((r:any)=>!Object.hasOwn(r,'facts')));
    }
  }});
  t.after(() => server.close());
  const cookie = (await fetch(server.appOrigin)).headers.get('set-cookie')!.split(';')[0];
  async function request(path: string, body?: unknown) {
    const response = await fetch(server.appOrigin + path, {headers: {Cookie: cookie,
      ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
      ...(body === undefined ? {} : {method: 'POST', body: JSON.stringify(body)})});
    assert.equal(response.status, path === '/api/message' ? 202 : 200, path);
    return response.json() as Promise<any>;
  }
  const first = await request('/api/start', {version: 2});
  assert.equal(first.trial.aiStatus, 'idle');
  assert.deepEqual(server.counts(), {lunaPosts: 0, jevPosts: 0});
  const persona = createPersona(20261027), human = mockHuman({persona,
    history: first.trial.events.map((v: any) => ({speaker: v.speaker, text: v.text}))});
  await request('/api/message', {text: human.utterance, clientId: 'adaptive-human-http-1', expectedRecordId:first.trial.sessionId});
  let state: any;
  const end = Date.now() + 10000;
  do {
    state = await request('/api/state');
    if (state.trial.aiStatus === 'error') assert.fail('synthetic_participant_ai_error');
    if (state.trial.aiStatus === 'idle' && state.trial.events.length === first.trial.events.length + 2) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < end);
  assert.equal(state.trial.aiStatus, 'idle');
  assert.deepEqual(state.trial.events.map((v: any) => v.speaker), [...first.trial.events.map((v: any) => v.speaker), 'human', 'ai']);
  const next = mockHuman({persona, history: state.trial.events.map((v: any) => ({speaker: v.speaker, text: v.text}))});
  assert.match(next.utterance, /細い部分/);
  const turns=mode.technicalTrial?3:1;
  for(let turn=2;turn<=turns;turn++){
    const before=state.trial.events.length;
    await request('/api/message',{text:'細い部分について確認したいです',clientId:'adaptive-http-'+turn,expectedRecordId:state.trial.sessionId});
    const deadline=Date.now()+10000;
    do{
      state=await request('/api/state');
      if(state.trial.aiStatus==='error')assert.fail('synthetic_participant_ai_error');
      if(state.trial.aiStatus==='idle'&&state.trial.events.length===before+2)break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }while(Date.now()<deadline);
    assert.equal(state.trial.aiStatus,'idle');
    assert.equal(state.trial.events.length,before+2);
  }
  const id = state.trial.sessionId;
  await server.exportRecord(id);
  const beforeRestart=JSON.parse(await readFile(join(directory,'record.private.json'),'utf8'));
  const postCounts=server.counts();
  await server.restart();
  const afterRestart=await request('/api/state');
  assert.equal(afterRestart.trial.sessionId,id);
  assert.deepEqual(afterRestart.trial.events,state.trial.events);
  assert.deepEqual(server.counts(),postCounts,'server restore makes no upstream POST');
  await server.exportRecord(id);
  const restored=JSON.parse(await readFile(join(directory,'record.private.json'),'utf8'));
  for(const key of ['jevLedger','jevTraces','attempts','queueState'])assert.deepEqual(restored[key],beforeRestart[key],key);
  const submitted = await request('/api/names', {confirm: true, expectedRecordId:id,
    names: Object.fromEntries(state.trial.scene.shapes.map((v: any, index: number) => [v.id, '合成の名前' + (index + 1)]))});
  assert.equal(submitted.trial.status, 'completed');
  const locked = await request(`/api/records/${id}/review`);
  assert.equal(locked.result, undefined);
  const form = await request(`/api/records/${id}/questionnaire`);
  await request(`/api/records/${id}/questionnaire`, {submit: true,
    answers: Object.fromEntries(form.form.items.map((v: any) => [v.id, 4])), comment: ''});
  const unlocked = await request(`/api/records/${id}/review`);
  assert.equal(unlocked.result.figures.length, 6);
  assert.equal((await request('/api/state')).trial.sessionId, id);
  const publicText = JSON.stringify({state, locked, unlocked});
  for (const secret of ['jevTraces', 'jevLedger', 'repair-first', 'bypass-enabled', 'repairFacts', 'replyVsPrevious', 'technicalTrial', 'configId', '"seed"', '"private"', 'understandingChange'])
    assert.ok(!publicText.includes(secret), secret);
  await server.exportRecord(id);
  const record = JSON.parse(await readFile(join(directory, 'record.private.json'), 'utf8'));
  assert.equal(record.jevTraces.length, turns);
  assert.equal(record.jevTraces[0].status, 'committed');
  if(mode.technicalTrial){
    assert.deepEqual(record.options.technicalTrial,{version:'adaptive_repair_v3'});
    assert.ok(facts.some((f:any)=>f.length>0),'exercise nonempty mechanical facts in the actual HTTP payload');
    assert.ok(facts.flat().every(f=>f!==undefined),'every transmitted history entry has facts');
    pairFacts.push(facts);
    if(pairFacts.length===2)assert.deepEqual(pairFacts[0],pairFacts[1],'both strategies send identical repair facts');
  }else assert.ok(!Object.hasOwn(record.options,'technicalTrial'));
  t.diagnostic(JSON.stringify({turns, ...server.counts(), publicState: 'ok', submitted: true, questionnaire: true, browser: 'not exercised'}));
});
