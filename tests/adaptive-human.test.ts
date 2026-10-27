import test from 'node:test';
import assert from 'node:assert/strict';
import {createPersona, mockHuman, validateInput, validateOutput} from '../dialogue-model/runtime/diagnostics/adaptive-human/simulator.ts';
import {liveHuman} from '../dialogue-model/runtime/diagnostics/adaptive-human/live.ts';

const persona = createPersona(20261027);
const input = {persona, history: [{speaker: 'ai' as const, text: '細い部分はありますか？'}]};

// Compile-only assertions: structurally wider variables must not cross the typed boundary.
function checkTypes() {
  const hidden = {...input, strategy: 'private'};
  // @ts-expect-error strategy is not a simulator input
  mockHuman(hidden);
  const hiddenPersona = {...input, persona: {...persona, seed: 919}};
  // @ts-expect-error an assignment seed is not a persona field
  mockHuman(hiddenPersona);
  const hiddenTurn = {...input, history: [{...input.history[0], gold: true}]};
  // @ts-expect-error annotations are not public utterance data
  mockHuman(hiddenTurn);
}
void checkTypes;

test('simulator rejects extra keys at every input boundary, without evaluating accessors', () => {
  for (const key of ['aiImage', 'answerKey', 'gold', 'strategy', 'jevDecision', 'seed', 'assignment', 'configId'])
    assert.throws(() => validateInput({...input, [key]: 'private'}), /invalid_adaptive_human_data/);
  assert.throws(() => validateInput({...input, persona: {...persona, seed: 1}}));
  assert.throws(() => validateInput({...input, history: [{...input.history[0], id: 'private'}]}));
  assert.throws(() => validateInput({...input, boardImage: {mimeType: 'image/png', base64: 'AAAA', aiImage: 'private'}}));
  assert.throws(() => validateInput({...input, boardImage: {mimeType: 'text/html', base64: 'AAAA'}}));
  let reads = 0;
  const accessor = Object.defineProperty({...input}, 'boardImage', {get() { reads++; throw Error('sensitive'); }});
  assert.throws(() => validateInput(accessor)); assert.equal(reads, 0);
  assert.throws(() => validateInput(Object.assign(Object.create({seed: 1}), input)));
  assert.throws(() => validateInput({...input, [Symbol('private')]: 1}));
  assert.throws(() => validateInput({...input, history: Object.assign([...input.history], {gold: 'private'})}));
  const history = [...input.history];
  Object.defineProperty(history, '0', {get() { reads++; throw Error('sensitive'); }});
  assert.throws(() => validateInput({...input, history})); assert.equal(reads, 0);
});

test('mock is deterministic and adapts to questions, understood name proposals and uncertainty', () => {
  assert.deepEqual(createPersona(20261027), persona);
  const visible = {...input, boardImage: {mimeType: 'image/png' as const, base64: 'AAAA'}};
  assert.deepEqual(mockHuman(visible), mockHuman(structuredClone(visible)));
  const answer = mockHuman(input);
  assert.match(answer.utterance, /細い部分/); assert.ok(answer.private.question);
  const confirmation = mockHuman({persona, history: [...input.history, {speaker: 'human', text: answer.utterance},
    {speaker: 'ai', text: 'その細い部分を目印に「合図」と呼びましょう。'}]});
  assert.match(confirmation.utterance, /合図/);
  assert.equal(confirmation.private.understandingChange, 'increased');
  assert.equal(confirmation.private.question, null);
  const unclear = mockHuman({persona, history: [{speaker: 'ai', text: '「合図」にしましょう。'}]});
  assert.ok(unclear.private.question); assert.equal(unclear.private.understandingChange, 'unchanged');
  const unknown = mockHuman({persona, history: [{speaker: 'human', text: 'よく分かりません。'}, {speaker: 'ai', text: 'なるほど。'}]});
  for (const output of [answer, confirmation, unclear, unknown, mockHuman({persona, history: []})]) {
    assert.doesNotMatch(output.utterance, /飛ば|次へ|次の図形/); assert.equal(output.done, false);
  }
});

test('live uses runtime client with purpose only and sends only persona, public history and optional participant image', async () => {
  const output = mockHuman(input), requests: any[] = [];
  const simulate = liveHuman({baseUrl: 'https://synthetic.invalid/v1', apiKey: 'synthetic-only'}, async (url, init) => {
    requests.push({url: String(url), body: JSON.parse(String(init?.body))});
    return Response.json({choices: [{message: {content: JSON.stringify(output)}}], model: 'synthetic-luna'});
  });
  assert.deepEqual(await simulate({...input, boardImage: {mimeType: 'image/png', base64: 'AAAA'}}), output);
  const wire = requests[0];
  assert.equal(wire.url, 'https://synthetic.invalid/v1/chat/completions');
  assert.equal(wire.body.purpose, 'dialogue_turn'); assert.equal(Object.hasOwn(wire.body, 'model'), false);
  const content = wire.body.messages[1].content;
  assert.deepEqual(JSON.parse(content[0].text), input);
  assert.equal(content[1].image_url.url, 'data:image/png;base64,AAAA');
  await assert.rejects(simulate({...input, configId: 'private'} as any));
  assert.equal(requests.length, 1);
});

test('closed live output rejects extra keys and invalid private assessments with sanitized errors', async () => {
  const output = mockHuman(input);
  for (const value of [{...output, strategy: 'private'}, {...output, private: {...output.private, gold: 'private'}},
    {...output, private: {...output.private, uncertainty: 2}}, {...output, private: {...output.private, beliefs: [{referent: 'shape', name: null, understanding: 0.2, id: 'secret'}]}}])
    assert.throws(() => validateOutput(value));
  const simulate = liveHuman({baseUrl: 'https://synthetic.invalid/v1', apiKey: 'synthetic-only'}, async () =>
    Response.json({choices: [{message: {content: '{"secret-upstream-echo":true}'}}]}));
  await assert.rejects(simulate(input), {message: 'invalid_adaptive_human_response'});
});
