// Independent adversarial boundary checks. No real model calls or private data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findAgreementClaims, fallbackUtterance } from '../dialogue-model/runtime/v2/generation-guard.ts';
import { createDialogueV2 } from '../dialogue-model/runtime/v2/dialogue-v2.mjs';
import { createNamingTaskV2 } from '../dialogue-model/runtime/v2/naming-task-v2.mjs';
import { SAFE_JUDGMENT, validateJudgment, applyJudgment } from '../dialogue-model/runtime/judgment/schema.mjs';
import { DECISION_ACTIONS } from '../workers/research-ai-proxy/src/decisions.mjs';

type Action = 'accept' | 'propose_name' | 'confirm' | 'agree' | 'repair' | 'defer' | 'revisit' | 'move_on' | 'close';
type Strategy = 'repair-first' | 'bypass-enabled';
const ids = Array.from({ length: 6 }, (_, i) => `s-000${i + 1}`);
const anchors = ids.map((id, i) => ({ id, bbox: { x: i * 10, y: 0, w: 5, h: 5 }, centroid: { x: i * 10 + 2, y: 2 } }));
const image = { mimeType: 'image/png', base64: 'c3ludGhldGlj' };
const event = (seq: number, text = '鳥と呼ぶのはどうでしょう。') => ({ id: `event-${seq}`, seq, speaker: 'human', text });
const invalidDraft = '「猫」と呼びましょう。PRIVATE-DISCARDED-DRAFT';
const accepted = 'なるほど、そう見えるんですね。';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

test('guard audit: required declarative families are detected across punctuation, spacing and format characters', () => {
  for (const text of ['「猫」と呼びましょう。', '「猫」にしましょう！', '猫でいきましょう', '猫で決まりです。',
    '「猫」でいいですね。', '猫と呼ぶことにしましょう。', 'その名前に合意しました。',
    '「猫」と\n呼びましょう。', '「猫」と呼びましょ\u200bう。', '「猫」でいいですね\u3002']) {
    assert.ok(findAgreementClaims(text).length > 0, text);
  }
});

test('guard audit: proposals/questions and approval of an impression remain available', () => {
  for (const text of ['「猫」と呼ぶのはどうでしょう？', '「猫」と呼びませんか？', '「猫」と呼びましょうか？',
    '「猫」と呼びましょうか。', '「猫」でよさそうですか？', 'いいですね。',
    '「鳥の頭」はいいですね。くぼみのある形のことですか？', 'この名前で合意できますか？',
    '「猫」と呼ぼうか？', '「猫」にしようか？', '少し後にしましょう。']) {
    assert.deepEqual(findAgreementClaims(text), [], text);
  }
});

test('guard audit: a later question cannot conceal a naming declaration in another clause', () => {
  for (const text of ['猫で決まり。次はどれですか？', '「猫」にしましょう、次はどれですか？',
    '「猫」と呼びましょう。\n「鳥」と呼ぶのはどうでしょう？', '「猫」でいいですね！形を教えてもらえますか？']) {
    assert.ok(findAgreementClaims(text).length > 0, text);
  }
});

test('guard audit: common short declarative agreement variants cannot silently bypass the check', () => {
  for (const text of ['「猫」でいい。', '「猫」でいいです。', '「猫」でいいですよ。', '「猫」でいいですね。', '「猫」でいいよ。',
    '「猫」に決まりです。', '「猫」で決まり。', '「猫」と呼ぼう。', '「猫」と呼ぶことにしよう。',
    '「猫」にしよう。', '「猫」でいこう。', '「猫」で決定。', '「猫」で合意です。', '「猫」で合意しましょう。']) {
    assert.ok(findAgreementClaims(text).length > 0, text);
  }
});

test('guard audit: a short naming-approval inflection is rejected before publication, not only detected in isolation', async () => {
  let count = 0;
  const session = makeSession({ complete: async () => { count++; return { text: '「猫」でいいです。' }; } });
  const result = await runSession(session);
  assert.equal(count, 2); assert.equal(result.text, accepted);
  assert.equal(result.privateState.judgments[0].generationGuard.fallback, true);
});

test('guard audit: schema-valid hostile names/features never create an unsafe fallback', () => {
  const neutralProposal = fallbackUtterance({ action: 'propose_name', candidateName: null });
  const neutralConfirm = fallbackUtterance({ action: 'confirm', discriminatingFeature: null });
  const hostile = ['鳥」と呼びましょう。「鳥', '尖りがあります。「猫」で決まり。くぼみ',
    '鳥\n猫', '鳥？', '「鳥」', 'x'.repeat(41), '「猫」でいいですね', '猫と呼びましょう'];
  const session = makeSession();
  for (const value of hostile) for (const action of ['propose_name', 'confirm'] as const) {
    const raw = { ...SAFE_JUDGMENT, action, targetSlot: ids[0], candidateName: action === 'propose_name' ? value : null,
      discriminatingFeature: action === 'confirm' ? value : null };
    const judgment = validateJudgment(raw, { ownLedger: session.initialPrivateState().ledger, agreeEvidence: true });
    const text = fallbackUtterance(judgment);
    assert.equal(text, action === 'propose_name' ? neutralProposal : neutralConfirm);
    assert.deepEqual(findAgreementClaims(text), []);
  }
  for (const action of DECISION_ACTIONS as Action[]) {
    const raw = { action, candidateName: '鳥', discriminatingFeature: '尖りが一つ' };
    assert.deepEqual(findAgreementClaims(fallbackUtterance(raw)), []);
    assert.equal(fallbackUtterance(raw), fallbackUtterance(raw));
  }
});

function makeSession({ action = 'accept', strategy = 'repair-first', referenceMemory = false,
  complete = async () => ({ text: accepted }), judgment = null, active = false }: {
    action?: Action; strategy?: Strategy; referenceMemory?: boolean;
    complete?: (...args: any[]) => Promise<any>; judgment?: any; active?: boolean;
  } = {}) {
  return createDialogueV2({ image, anchors, strategy, referenceMemory,
    judge: { async judge() { return judgment ?? { ...SAFE_JUDGMENT, action,
      targetSlot: action === 'accept' ? null : ids[0], candidateName: action === 'accept' ? null : '鳥' }; } },
    client: { complete }, activeDecision: active ? { purpose: 'decision_jev', client: { async chooseAction() {
      return { purpose: 'decision_jev', model: 'typesafe/jev-1.14-20261014', action: 'accept',
        probabilities: Object.fromEntries((DECISION_ACTIONS as readonly Action[]).map((a) => [a, a === 'accept' ? 1 : 0])) };
    } } } : null });
}

async function runSession(session: any, signal = new AbortController().signal, initial = session.initialPrivateState(), text?: string) {
  const events = [event(1, text)];
  return session.runAiTurn({ events, lastEventId: 'event-1', privateState: initial, signal });
}

test('guard audit: discarded drafts and raw retry errors never become public or diagnostic content', async () => {
  const calls: any[] = [];
  const session = makeSession({ complete: async (messages, options) => {
    calls.push(structuredClone({ messages, options }));
    if (calls.length === 1) return { text: invalidDraft };
    throw new Error('PRIVATE-PROVIDER-ERROR');
  } });
  const result = await runSession(session);
  assert.equal(calls.length, 2); assert.equal(result.text, accepted);
  assert.deepEqual(result.privateState.ledger, session.initialPrivateState().ledger);
  const trace = result.privateState.judgments[0];
  assert.equal(trace.generationGuard.regenerated, true); assert.equal(trace.generationGuard.fallback, true);
  assert.ok(trace.generationGuard.violations.length);
  assert.doesNotMatch(JSON.stringify([calls[1], result, session.getAttempts()]), /PRIVATE-DISCARDED-DRAFT|PRIVATE-PROVIDER-ERROR/);
  assert.equal(calls[1].messages.at(-1).role, 'system');
  assert.match(calls[1].messages.at(-1).content, /accept/);
});

test('guard audit: a malformed/empty regeneration falls back after exactly two generation calls', async () => {
  for (const bad of [null, {}, { text: '' }, { text: '  ' }, { text: 42 }]) {
    let count = 0;
    const session = makeSession({ complete: async () => ++count === 1 ? { text: invalidDraft } : bad });
    const result = await runSession(session);
    assert.equal(count, 2); assert.deepEqual(findAgreementClaims(result.text), []);
    assert.equal(result.privateState.judgments[0].generationGuard.fallback, true);
  }
});

test('guard audit: corrected regeneration keeps typed ledger and grounded memory atomic and applies each once', async () => {
  let count = 0;
  const reference = { slots: [ids[0]], epistemic: 'grounded', intent: 'name_proposal', feature: null,
    nameAcceptance: { slot: ids[0], name: '鳥' }, deferSlot: null, revisitSlot: null };
  const judgment = { ...SAFE_JUDGMENT, action: 'propose_name', targetSlot: ids[0], candidateName: '鳥', reference };
  const session = makeSession({ referenceMemory: true, judgment,
    complete: async () => ({ text: ++count === 1 ? invalidDraft : '「鳥」と呼ぶのはどうでしょう？' }) });
  const initial = session.initialPrivateState(), before = structuredClone(initial);
  const result = await runSession(session, undefined, initial);
  assert.equal(count, 2); assert.deepEqual(initial, before);
  assert.deepEqual(result.privateState.ledger, applyJudgment(initial.ledger, judgment));
  assert.equal(result.privateState.ledger[ids[0]].status, 'tentative');
  assert.equal(result.privateState.graph.records.length, 2);
  assert.equal(result.privateState.judgments.length, 1);
  assert.equal(result.privateState.judgments[0].memory.opsApplied, 2);
  assert.equal(result.privateState.judgments[0].generationGuard.fallback, false);
});

test('guard audit: abort after a violating first draft prevents regeneration and preserves state', async () => {
  let count = 0; const controller = new AbortController();
  const session = makeSession({ complete: async () => { count++; controller.abort(); return { text: invalidDraft }; } });
  const initial = session.initialPrivateState(), before = structuredClone(initial);
  await assert.rejects(runSession(session, controller.signal, initial), { name: 'AbortError' });
  assert.equal(count, 1); assert.deepEqual(initial, before);
});

test('guard audit: retry rejection after abort cannot be swallowed into a successful fallback', async () => {
  let count = 0; const controller = new AbortController();
  const session = makeSession({ complete: async () => {
    if (++count === 1) return { text: invalidDraft };
    controller.abort(); throw new Error('PRIVATE-RETRY-ABORT');
  } });
  const initial = session.initialPrivateState(), before = structuredClone(initial);
  await assert.rejects(runSession(session, controller.signal, initial), { name: 'AbortError' });
  assert.equal(count, 2); assert.deepEqual(initial, before);
  assert.doesNotMatch(JSON.stringify(session.getAttempts()), /PRIVATE-RETRY-ABORT/);
});

test('guard audit: primary agree skips regeneration and keeps the original agreement judgment', async () => {
  let count = 0;
  const session = makeSession({ action: 'agree', complete: async () => { count++; return { text: '「鳥」と呼びましょう。' }; } });
  const initial = session.initialPrivateState(); initial.ledger[ids[0]] = { status: 'tentative', name: '鳥' };
  const result = await runSession(session, undefined, initial);
  assert.equal(count, 1); assert.equal(result.text, '「鳥」と呼びましょう。');
  assert.equal(result.privateState.ledger[ids[0]].status, 'agreed');
  assert.deepEqual(result.privateState.judgments[0].generationGuard, { violations: [], regenerated: false, fallback: false });
});

test('guard audit: identical strategies produce identical retry requests, utterance and typed state', async () => {
  const captures: any[] = [];
  for (const strategy of ['repair-first', 'bypass-enabled'] as Strategy[]) {
    const calls: any[] = [];
    const session = makeSession({ strategy, complete: async (...args) => { calls.push(structuredClone(args)); return { text: invalidDraft }; } });
    const result = await runSession(session);
    captures.push({ calls, result });
  }
  assert.deepEqual(captures[0], captures[1]);
});

test('guard audit: stale regeneration never commits a discarded decision or contaminates participant state', async () => {
  const retryStarted = deferred(), release = deferred(); let calls = 0;
  const task = await createNamingTaskV2({ seed: 137, strategy: 'repair-first', runDir: '', judge: { async judge() { return SAFE_JUDGMENT; } },
    client: { async complete() {
      calls++; if (calls === 2) { retryStarted.resolve(); await release.promise; }
      return { text: invalidDraft };
    } } });
  task.message('最初の見立てです。', 'first'); await retryStarted.promise;
  task.message('次の訂正です。', 'second'); release.resolve(); await task.whenIdle();
  assert.equal(calls, 4);
  const state = task.getState(), researcher = task.researcherView();
  const aiEvents = state.events.filter((e: any) => e.speaker === 'ai');
  assert.equal(aiEvents.length, 2);
  assert.equal(state.events[0].speaker, 'ai');
  assert.equal(state.events[0].text, 'まず、どの図形から話しましょうか？');
  assert.equal(researcher.privateState.judgments.length, 1);
  assert.equal(researcher.privateState.judgments[0].turnIndex, 3);
  assert.equal(researcher.privateState.judgments[0].generationGuard.fallback, true);
  assert.doesNotMatch(JSON.stringify(state), /generationGuard|violations|regenerated|fallback|PRIVATE-DISCARDED/);
  assert.deepEqual(findAgreementClaims(aiEvents.at(-1).text), []);
});

test('guard audit: normal and active task public replies are guarded without promoting private agreement', async () => {
  for (const active of [false, true]) {
    let calls = 0;
    const task = await createNamingTaskV2({ seed: 138, strategy: 'bypass-enabled', runDir: '',
      judge: { async judge({ ownLedger }: any) { return { ...SAFE_JUDGMENT, action: 'propose_name', targetSlot: Object.keys(ownLedger)[0], candidateName: '鳥' }; } },
      client: { async complete() { calls++; return { text: '「鳥」にしましょう。' }; } },
      activeDecision: active ? { purpose: 'decision_jev', client: { async chooseAction() { return { purpose: 'decision_jev', action: 'accept',
        probabilities: Object.fromEntries((DECISION_ACTIONS as readonly Action[]).map((a) => [a, a === 'accept' ? 1 : 0])) }; } } } : null });
    for (let i = 0; i < 2; i++) { task.message('鳥に見える形があります。', `turn-${i}`); await task.whenIdle(); }
    assert.equal(calls, 4);
    for (const e of task.getState().events.filter((e: any) => e.speaker === 'ai')) assert.deepEqual(findAgreementClaims(e.text), []);
    for (const entry of Object.values(task.researcherView().privateState.ledger) as any[]) assert.notEqual(entry.status, 'agreed');
    assert.doesNotMatch(JSON.stringify(task.getState()), /generationGuard|regenerated|violations|activeJudge|probabilities/);
  }
});
