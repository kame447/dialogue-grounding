import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveGenerationOutcome, findOrientationLeaks } from '../dialogue-model/runtime/v2/generation-guard.ts';
import { buildJevDraftActPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { hash, verifyRecords } from '../dialogue-model/runtime/diagnostics/parity-verify/index.ts';
import { buildRecords, normal, OLD, OWN, runTurn } from './support/s4-v3-records.ts';
import { researchTrialProfileV3 } from '../dialogue-model/runtime/v2/research-profile.ts';

const orientationReason = '前の下書きに、自分側の見え方だと示されていない方位の語（上下左右・端・向き・斜め・縦長・横長など）がありました。公開発話では、回転しても変わらない形や部分同士のつながりに言い換えてください。方位が区別に必要なら、その語と同じ節で自分側の画面での見え方だと明示し、相手には形の対応を尋ねてください。';
const sharedReason = '前の下書きは、相手側の位置や向きを自分側と同じだと断定していました。相手側の位置や向きは、相手自身の説明として引用するか、相手の見え方を尋ねてください。';

test('holistic_v5 distinguishes local observations, attributed reports and questions from asserted shared orientation', () => {
  for (const text of [
    'こちらの画面では右端に切れ目があります。そちらにも切れ目がある形ですか？',
    'そちらの画面では右向きに見えると言っていましたね。',
    'そちらの画面では右向きに見えますか？',
    'そちらも同じ向きではないですね。',
    'そちらでは「右端に切れ目がある」と説明していましたね。',
    '切れ目と尖った部分がつながった形ですか？',
  ]) assert.deepEqual(findOrientationLeaks(text, 'holistic_v5'), [], text);
  for (const text of [
    'そちらの画面では右端に切れ目があります。',
    'こちらの画面では右端に切れ目があり、そちらも同じ位置にあります。',
  ]) {
    assert.deepEqual(findOrientationLeaks(text, 'holistic_v4'), [], text);
    const codes = findOrientationLeaks(text, 'holistic_v5');
    assert.deepEqual(codes, ['shared_view_assumption'], text);
    assert.equal(deriveGenerationOutcome(codes, codes, '切れ目のある形ですか？', true).kind, 'stop');
  }
  assert.deepEqual(findOrientationLeaks('右端に切れ目がある形ですか？', 'holistic_v5'), ['orientation_leak']);
  const continuation = 'こちらでは右端に切れ目が見えますが、左側に突起があります。';
  assert.deepEqual(findOrientationLeaks(continuation, 'holistic_v5', 'jev_generation_retry_v2'), ['orientation_leak']);
  assert.deepEqual(findOrientationLeaks(continuation, 'holistic_v5'), []);
});

for (const label of ['bypass-enabled', 'repair-first'] as const) {
  test(`${label}: retry reason bytes follow the saved version and the two orientation codes`, async () => {
    const unmarked = '右上に丸い突起がありますか？';
    const partner = 'そちらの画面では左端に細い棒が見えます。';
    const human = 'どんな形か教えてください。';
    const next = '細い棒と丸い突起がつながっていますか？';
    const versions = ['jev_generation_retry_v2', 'jev_generation_retry_v4'] as const;
    const exercise = (draft: string, generationRetryVersion: (typeof versions)[number]) =>
      buildRecords({ label, dialoguePolicy: 'holistic_v5', generationRetryVersion, technicalTrial: { version: 'adaptive_repair_v3' },
        turns: [{ human, plan: { action: 'confirm', target: 'figure_0', drafts: [draft, next] } }] });
    const statuses = (records: any) => verifyRecords(records).checks.filter(c => /^intervention\.trial\.0\.attempt\.0\./u.test(c.id)).map(c => c.status);
    for (const version of versions) {
      const scenarios = version === 'jev_generation_retry_v4'
        ? [[unmarked, orientationReason], [partner, sharedReason], [unmarked + partner, orientationReason + sharedReason]]
        : [[unmarked + partner, null]];
      for (const [draft, reason] of scenarios) {
        const records = await exercise(draft!, version);
        assert.deepEqual(statuses(records), ['pass', 'pass', 'pass', 'pass']);
        const replay = records.trials[0].replay[0];
        assert.equal(replay.tape.generationRetryVersion, version);
        for (const side of replay.result.sides) {
          const retry = side.requests.filter((request: any) => request.phase === 'generation')[1];
          const actual = retry.payload.messages.at(-1).content.split('\n').at(-1);
          if (reason === null) assert.match(actual, /^前の下書きの方位の参照枠を明確にして書き直してください。/u);
          else assert.equal(actual, reason);
        }
        if (reason === null) continue;
        const altered = structuredClone(records);
        const sides = altered.trials[0].replay[0].result.sides;
        const otherIndex = sides.findIndex((side: any) => side.label !== label);
        const other = sides[otherIndex];
        const retry = other.requests.filter((request: any) => request.phase === 'generation')[1];
        retry.payload.messages.at(-1).content = retry.payload.messages.at(-1).content.replace(reason, reason === sharedReason ? orientationReason : sharedReason);
        retry.completeMessagesSha256 = hash(retry.payload.messages);
        retry.payloadSha256 = retry.preProjectionPayloadSha256 = hash(retry.payload);
        altered.evidence.pairedReplay[0][otherIndex === 0 ? 'left' : 'right'] = structuredClone(other);
        assert.ok(statuses(altered).includes('mismatch'));
      }
    }
  });

  test(`holistic_v5 ${label}: only a selected feature with orientation wording gets the adjacent viewpoint note`, async () => {
    const note = '以下のdiscriminatingFeatureにある上下左右・横長などの向きの語は、自分側の画面での見え方です。公開発話では、回転しても変わらない形や部分同士のつながりに言い換えてください。向きが区別に必要なら、その語と同じ節で「こちらの画面では」などと自分側の見え方だと明示し、相手には形の対応を尋ねてください。';
    const statuses = (records: any) => verifyRecords(records).checks.filter(c => /^intervention\.trial\.0\.attempt\.0\./u.test(c.id)).map(c => c.status);
    for (const [feature, annotated] of [
      ['左端に横長の部分がつながる', true],
      ['こちらの画面では右端に切れ目があります', true],
      ['切れ目と細い棒がつながる', false],
    ] as const) {
      const memo = structuredClone(OLD.state.observationMemo);
      memo.figures.find((figure: {id: string}) => figure.id === OWN.ownAnchors[0].id).analytic.shapes[0] = feature;
      memo.figures.find((figure: {id: string}) => figure.id === OWN.ownAnchors[1].id).analytic.shapes[0] = '右上に突起がある';
      const records = await buildRecords({ label, dialoguePolicy: 'holistic_v5', memo,
        technicalTrial: { version: 'adaptive_repair_v3' }, turns: [{ human: 'この形の特徴を教えてください。',
          plan: { action: 'confirm', target: 'figure_0', drafts: ['右端に切れ目がある形ですか？', '切れ目がある形ですか？'] } }] });
      const trial = records.trials[0];
      assert.deepEqual(statuses(records), ['pass', 'pass', 'pass', 'pass']);
      assert.equal(trial.attempts[0].executed.feature, feature);
      const sides = trial.replay[0].result.sides;
      for (const side of sides) {
        const [initial, retry] = side.requests.filter((request: any) => request.phase === 'generation');
        const act = initial.payload.messages[2].content;
        const lines = act.split('\n');
        assert.equal(JSON.parse(lines.at(-1)).discriminatingFeature, feature);
        assert.equal(lines.at(-2) === note, annotated);
        assert.equal(lines.includes(note), annotated);
        assert.ok(retry.payload.messages.at(-1).content.includes(act));
      }
      if (annotated) {
        const tampered = structuredClone(records);
        const otherIndex = sides.findIndex((side: any) => side.label !== label);
        const other = tampered.trials[0].replay[0].result.sides[otherIndex];
        const initial = other.requests.find((request: any) => request.phase === 'generation');
        initial.payload.messages[2].content = initial.payload.messages[2].content.replace(note + '\n', '');
        initial.completeMessagesSha256 = hash(initial.payload.messages);
        initial.payloadSha256 = initial.preProjectionPayloadSha256 = hash(initial.payload);
        tampered.evidence.pairedReplay[0][otherIndex === 0 ? 'left' : 'right'] = structuredClone(other);
        assert.ok(statuses(tampered).includes('mismatch'));
      }
    }
  });

  test(`holistic_v5 ${label}: the retry restates confirmation and S4 binds the exact framing and naming criteria`, async () => {
    const slot = OWN.ownAnchors[0].id, ledger = structuredClone(OLD.state.ledger);
    ledger[slot] = { status: 'agreed', name: '小舟' };
    ledger[OWN.ownAnchors[1].id] = { status: 'agreed', name: '別枠の名前' };
    const name = '帆', human = `この形を「${name}」と呼びませんか？`;
    const drafts = ['そちらの画面では右端に切れ目があります。', '切れ目が一つある形ですか？'];
    const records = await buildRecords({ label, dialoguePolicy: 'holistic_v5', technicalTrial: { version: 'adaptive_repair_v3' }, ledger,
      turns: [{ human, plan: { action: 'confirm', target: 'figure_0', referent: 'figure_0', act: 'name_propose', drafts,
        extraction: JSON.stringify([{ segmentId: 's1', quote: name, proposition: name, name, targets: [slot], aspect: 'name',
          linkedIssueId: null, respondsToTurn: null }]) } }] });
    const trial = records.trials[0], trace = trial.attempts[0], { tape, result } = trial.replay[0];
    const statuses = (r: any) => verifyRecords(r).checks.filter(c => /^intervention\.trial\.0\.attempt\.0\./.test(c.id)).map(c => c.status);
    assert.deepEqual(statuses(records), ['pass', 'pass', 'pass', 'pass']);
    assert.equal(result.status, 'same_material_intervention_verified');
    assert.equal(trace.namingRequest, true);
    assert.equal(trace.executed.action, 'confirm');
    assert.equal(trace.executed.name, null);
    assert.deepEqual(trace.generationGuard, { violations: ['shared_view_assumption'], regenerated: true, fallback: false });
    assert.equal(trace.publicSpeech, drafts[1]);
    assert.deepEqual(trial.lastCommittedState.ledger, ledger);
    assert.deepEqual(tape.state.ledger, ledger);
    const side = result.sides.find((s: any) => s.label === label);
    const gens = side.requests.filter((r: any) => r.phase === 'generation');
    assert.equal(gens.length, 2);
    const act = gens[0].payload.messages[2].content;
    assert.match(act, /その特徴だけを確かめてください。.*採用・再提案しないでください。その案に触れる場合は、相手の提案だと分かる引用に留めてください。/u);
    assert.match(act, /同じ図形と別の図形のどちらについて話しているかを確かめてください。この案を採用して合意済みの名前を変更しないでください。/u);
    assert.deepEqual(JSON.parse(act.split('\n').at(-2)), { agreedName: '小舟', proposedNames: [name] });
    assert.doesNotMatch(act, /別枠の名前/u);
    assert.ok(gens[1].payload.messages.at(-1).content.includes(act));
    assert.ok(gens[1].payload.messages.at(-1).content.endsWith(sharedReason));
    const classify = side.requests.find((r: any) => r.phase === 'draft_naming');
    assert.match(classify.payload.questions.draft_naming.criteria.adopt_chosen, /nullでなく/u);
    assert.match(classify.payload.questions.draft_naming.criteria.adopt_other, /nullのとき/u);

    const corrupted = structuredClone(records);
    const verdict = corrupted.trials[0].replay[0].result;
    const opposite = verdict.sides.findIndex((s: any) => s.label !== label);
    const comparison = verdict.sides[opposite];
    const retry = comparison.requests.filter((r: any) => r.phase === 'generation')[1];
    retry.payload.messages.at(-1).content += '。';
    retry.completeMessagesSha256 = hash(retry.payload.messages);
    retry.payloadSha256 = retry.preProjectionPayloadSha256 = hash(retry.payload);
    corrupted.evidence.pairedReplay[0][opposite === 0 ? 'left' : 'right'] = structuredClone(comparison);
    assert.ok(statuses(corrupted).includes('mismatch'));

    const changedName = structuredClone(records);
    const other = changedName.trials[0].replay[0].result.sides[opposite];
    const initial = other.requests.find((r: any) => r.phase === 'generation');
    initial.payload.messages[2].content = initial.payload.messages[2].content.replace('"agreedName":"小舟"', '"agreedName":"小島"');
    initial.completeMessagesSha256 = hash(initial.payload.messages);
    initial.payloadSha256 = initial.preProjectionPayloadSha256 = hash(initial.payload);
    changedName.evidence.pairedReplay[0][opposite === 0 ? 'left' : 'right'] = structuredClone(other);
    assert.ok(statuses(changedName).includes('mismatch'));
  });

  test(`holistic_v5 ${label}: naming conflict context requires an agreed name and a new name bound to the selected figure`, async () => {
    const slot = OWN.ownAnchors[0].id, other = OWN.ownAnchors[1].id;
    const cases = [
      { status: 'agreed', name: '帆', targets: [], referent: 'figure_0', request: true, conflict: true },
      { status: 'agreed', name: '帆', targets: [other], referent: 'figure_1', request: true, conflict: false },
      { status: 'agreed', name: '帆', targets: [], referent: 'none', request: true, conflict: false },
      { status: 'agreed', name: 'コブネ', targets: [slot], referent: 'figure_0', request: false, conflict: false },
      { status: 'tentative', name: '帆', targets: [slot], referent: 'figure_0', request: true, conflict: false },
    ];
    for (const { status, name, targets, referent, request, conflict } of cases) {
      const ledger = structuredClone(OLD.state.ledger);
      ledger[slot] = { status, name: 'こぶね' };
      const records = await buildRecords({ label, dialoguePolicy: 'holistic_v5', ledger,
        technicalTrial: { version: 'adaptive_repair_v3' }, turns: [{ human: `この形を「${name}」と呼びませんか？`,
          plan: { action: 'confirm', target: 'figure_0', referent, act: 'name_propose', speech: '切れ目が一つある形ですか？',
            extraction: JSON.stringify([{ segmentId: 's1', quote: name, proposition: name, name, targets, aspect: 'name',
              linkedIssueId: null, respondsToTurn: null }]) } }] });
      const trial = records.trials[0];
      assert.equal(trial.attempts[0].namingRequest === true, request);
      assert.deepEqual(trial.lastCommittedState.ledger, ledger);
      for (const side of trial.replay[0].result.sides) {
        const act = side.requests.find((r: any) => r.phase === 'generation').payload.messages[2].content;
        assert.equal(act.includes('"agreedName"'), conflict);
      }
      assert.deepEqual(verifyRecords(records).checks.filter(c => /^intervention\.trial\.0\.attempt\.0\./.test(c.id)).map(c => c.status),
        ['pass', 'pass', 'pass', 'pass']);
    }
  });
}

test('v5 draft-act criteria preserve the closed labels and the null selected-name input', () => {
  const input = { turn: 1, publicTurns: [], reasons: ['typed_context'], selected: { action: 'confirm' as const,
    target: { kind: 'single' as const, figureId: OWN.ownAnchors[0].id }, name: null }, draft: '切れ目がありますか？' };
  const old = buildJevDraftActPayload(input, 'holistic_v4');
  const revised = buildJevDraftActPayload(input, 'holistic_v5');
  assert.equal(revised.state, old.state);
  assert.deepEqual(Object.keys(revised.questions.draft_naming.criteria), Object.keys(old.questions.draft_naming.criteria));
  assert.notEqual(revised.questions.draft_naming.instructions, old.questions.draft_naming.instructions);
  assert.equal(JSON.parse(revised.state).selected.name, null);
});

test('v5 stops a repeated name adoption under confirm in both conditions', async () => {
  const { lunaRequest, timeouts } = normal.run.manifest;
  const profile = researchTrialProfileV3(lunaRequest, timeouts, 'two_stage_v3', 'holistic_v5');
  for (const label of ['bypass-enabled', 'repair-first'] as const) {
    const state = structuredClone(OLD.state), before = structuredClone(state.ledger);
    const adoption = 'この形は「帆」にしましょう。';
    await assert.rejects(runTurn(profile, label, state, [{ id: 'human-1', seq: 1, speaker: 'human', text: '切れ目がありますか？' }],
      { action: 'confirm', target: 'figure_0', drafts: [adoption, adoption], draftAct: 'adopt_other' }, { version: 'adaptive_repair_v3' }),
      (err: any) => {
        assert.equal(err.code, 'unsafe_generation');
        assert.equal(err.traces.at(-1).publicSpeech, null);
        assert.equal(err.traces.at(-1).executed.action, 'confirm');
        assert.deepEqual(err.traces.at(-1).generationGuard, { violations: ['draft_act_mismatch'], regenerated: true, fallback: false });
        return true;
      });
    assert.deepEqual(state.ledger, before);
  }
});

test('new two_stage_v3 research profiles default to holistic_v5 and explicit policies remain pinned', () => {
  const { lunaRequest, timeouts } = normal.run.manifest;
  assert.equal(researchTrialProfileV3(lunaRequest, timeouts, 'two_stage_v3').dialoguePolicy, 'holistic_v5');
  assert.equal(researchTrialProfileV3(lunaRequest, timeouts, 'two_stage_v3', 'holistic_v4').dialoguePolicy, 'holistic_v4');
  assert.equal(researchTrialProfileV3(lunaRequest, timeouts, 'two_stage_v3', null).dialoguePolicy, undefined);
  assert.equal(researchTrialProfileV3(lunaRequest, timeouts, 'two_stage_v2').dialoguePolicy, undefined);
});

for (const label of ['bypass-enabled', 'repair-first'] as const) {
  test(`${label}: accept gets a direct feature-answer instruction tied to the saved generation version`, async () => {
    const note = 'acceptで相手が図形の有無や特定の特徴を直接尋ねたら、相槌だけで済ませず、まずその問いに答えてください。';
    for (const generationRetryVersion of ['jev_generation_retry_v2', 'jev_generation_retry_v4'] as const) {
      const text = '細い棒とつながった形は見えます。';
      const records = await buildRecords({ label, dialoguePolicy: 'holistic_v5', generationRetryVersion,
        technicalTrial: { version: 'adaptive_repair_v3' }, turns: [{ human: '細い棒とつながっていますか？',
          plan: { action: 'accept', target: 'figure_0', drafts: ['上端に細い棒があります。', text] } }] });
      const trial = records.trials[0];
      assert.equal(trial.attempts[0].executed.action, 'accept');
      assert.equal(trial.attempts[0].publicSpeech, text);
      assert.deepEqual(verifyRecords(records).checks.filter(c => /^intervention\.trial\.0\.attempt\.0\./u.test(c.id)).map(c => c.status),
        ['pass', 'pass', 'pass', 'pass']);
      for (const side of trial.replay[0].result.sides) {
        const messages = side.requests.filter((r: any) => r.phase === 'generation').map((r: any) => r.payload.messages);
        for (const content of [messages[0][2].content, messages[1].at(-1).content]) {
          assert.equal(content.includes(note), generationRetryVersion === 'jev_generation_retry_v4');
        }
      }
    }
  });
}
