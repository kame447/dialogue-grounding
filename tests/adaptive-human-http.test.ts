import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startOfflineParticipant} from '../dialogue-model/runtime/diagnostics/adaptive-human/offline.ts';
import {createPersona, mockHuman} from '../dialogue-model/runtime/diagnostics/adaptive-human/simulator.ts';

test('offline synthetic P1 HTTP: mock turn, public state, six names, questionnaire and same trial (no browser claim)', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'adaptive-human-http-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const server = await startOfflineParticipant(directory);
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
  await request('/api/message', {text: human.utterance, clientId: 'adaptive-human-http-1'});
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
  const id = state.trial.sessionId;
  const submitted = await request('/api/names', {confirm: true,
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
  for (const secret of ['jevTraces', 'jevLedger', 'repair-first', 'configId', '"seed"', '"private"', 'understandingChange'])
    assert.ok(!publicText.includes(secret), secret);
  await server.exportRecord(id);
  const record = JSON.parse(await readFile(join(directory, 'record.private.json'), 'utf8'));
  assert.equal(record.jevTraces.length, 1);
  assert.equal(record.jevTraces[0].status, 'committed');
  t.diagnostic(JSON.stringify({turns: 1, ...server.counts(), publicState: 'ok', submitted: true, questionnaire: true, browser: 'not exercised'}));
});
