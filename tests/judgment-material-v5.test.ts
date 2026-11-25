// Synthetic material only. holistic_v5 writes the same validated material compactly; these checks pin the written form and its budget behaviour.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildJevDecisionDetailPayload, buildJevDecisionPayload } from '../dialogue-model/runtime/decision/jev-decision.ts';
import { claimKeepOrder, decodeMaterialV5, JUDGMENT_V5_LEGEND } from '../dialogue-model/runtime/decision/judgment-material-v5.ts';
import { OLD, OWN } from './support/s4-v3-records.ts';

const slots: string[] = OWN.ownAnchors.map((a: { id: string }) => a.id);
const NAME = '糸巻き';
const lines = [
  { turn: 1, speaker: 'human', text: `この丸い形は「${NAME}」と呼びませんか？` }, { turn: 2, speaker: 'ai', text: 'では、その形を呼びましょう。' },
  { turn: 3, speaker: 'human', text: '枝のある形は\nあとで確かめたいです。' }, { turn: 4, speaker: 'ai', text: '細い枝が二本ある形ですか？' },
  { turn: 5, speaker: 'human', text: 'はい、二本です。' }, { turn: 6, speaker: 'ai', text: '二本と分かりました。' }, { turn: 7, speaker: 'human', text: 'もう一度確かめたい。' },
];
const claim = (id: string, sourceTurn: number, speaker: string, quote: string, over: Record<string, unknown> = {}) => ({ id, turn: sourceTurn, issueId: 'i-' + id, targets: [slots[0]],
  aspect: 'part', act: 'assert', proposition: '命題-' + id, name: null, speaker, sourceTurn, quote, respondsTo: null, source: speaker === 'human' ? 'partner_statement' : 'ai_hypothesis', ...over });
const input = (extra: Record<string, unknown> = {}, claims: any[] | null = null, summary = '') => ({
  turn: 7, publicTurns: lines, ownSlots: slots, observations: structuredClone(OLD.state.observationMemo), issueSummary: summary,
  priorClaims: claims ?? [claim('c1', 1, 'human', NAME, { aspect: 'name', act: 'name_propose', name: NAME }), claim('c5', 5, 'human', 'はい、二本です。', { targets: [slots[1]], respondsTo: 'c4' })],
  repairHistory: [{ turn: 3, issueId: null, action: 'confirm', question: '細い枝が二本ある', partnerClaims: [{ id: 'c5', act: 'assert', proposition: '命題-c5', targets: [slots[1]] }],
    candidatesBefore: [slots[1]], candidatesAfter: [slots[1]], addedClaimIds: ['c5'], removedClaimIds: [], progress: 'changed' }],
  previousAction: { turn: 6, action: 'accept', target: { kind: 'single', figureId: slots[1] }, name: null, feature: null }, publicNames: [], ...extra }) as any;
const ledger = [{ turn: 2, action: 'agree', target: { kind: 'single', figureId: slots[0] }, name: NAME, feature: null },
  { turn: 4, action: 'confirm', target: { kind: 'single', figureId: slots[1] }, name: null, feature: '細い枝が二本ある' }];
const nameLedger = Object.fromEntries(slots.map((id, i) => [id, i === 0 ? { status: 'agreed', name: NAME } : { status: 'unassigned', name: null }]));
const send = (i: any, policy: 'v4' | 'v5') => JSON.parse(buildJevDecisionPayload({ ...i, nameLedger, ...(policy === 'v5' ? { judgmentLedger: ledger } : {}) }, { questionLayout: 'two_stage_v3', dialoguePolicy: 'holistic_v5' }).state);

test('the written form reads back to the older material except the claims\' quotes, and states each figure\'s name and executed actions', () => {
  const legacy = send(input(), 'v4'), v5 = send(input(), 'v5');
  assert.equal(v5.view, 'judgment_v5');
  const back = decodeMaterialV5(v5);
  assert.deepEqual(back.publicTurns, legacy.publicTurns);
  assert.deepEqual(back.priorClaims.map(({ quote, source, ...rest }: any) => rest), legacy.priorClaims.map(({ quote, source, turn, ...rest }: any) => ({ ...rest, turn: rest.sourceTurn })));
  assert.deepEqual(back.repairHistory, legacy.repairHistory);
  for (const key of ['turn', 'ownSlots', 'observations', 'issueSummary', 'previousAction', 'publicNames', 'inputBudget']) assert.deepEqual(back[key], legacy[key], key);
  assert.deepEqual(v5.figures.f0, { status: 'agreed', name: NAME, actions: [['agree', 2, NAME]] });
  assert.deepEqual(v5.figures.f1.actions, [['confirm', 4, '細い枝が二本ある']]);
  // each public event is one line, and a claim points at its source line instead of quoting it
  assert.deepEqual(v5.publicTurns, ['U1 h: ' + lines[0].text, 'U2 ai: ' + lines[1].text, 'U3 h: ' + lines[2].text, 'U4 ai: ' + lines[3].text, 'U5 h: ' + lines[4].text, 'U6 ai: ' + lines[5].text, 'U7 h: ' + lines[6].text]);
  assert.ok(!JSON.stringify(v5.claims).includes('はい、二本です。'));
});

test('the legend is appended to the instructions of a v5 request only', () => {
  const v4 = buildJevDecisionPayload({ ...input(), nameLedger }, { questionLayout: 'two_stage_v3', dialoguePolicy: 'holistic_v5' });
  const v5 = buildJevDecisionPayload({ ...input(), nameLedger, judgmentLedger: ledger }, { questionLayout: 'two_stage_v3', dialoguePolicy: 'holistic_v5' });
  for (const q of Object.values<any>(v5.questions)) assert.ok(q.instructions.includes(JUDGMENT_V5_LEGEND));
  for (const q of Object.values<any>(v4.questions)) assert.ok(!q.instructions.includes(JUDGMENT_V5_LEGEND));
});

test('over the character budget the least relevant claims go first; names, replies to confirmations and what they answer stay, and public history stays whole', () => {
  const filler = Array.from({ length: 150 }, (_, k) => claim('f' + k, 1 + (k % 6), lines[k % 6].speaker, lines[k % 6].text.slice(0, 6), { proposition: '細部-' + k + 'あ'.repeat(120) }));
  const claims = [claim('c1', 1, 'human', NAME, { aspect: 'name', act: 'name_propose', name: NAME }), claim('c4', 4, 'ai', '二本ある形', { respondsTo: null }),
    claim('c5', 5, 'human', 'はい、二本です。', { targets: [slots[1]], respondsTo: 'c4' }), ...filler];
  const v5 = send(input({}, claims, '論点'.repeat(1500)), 'v5');
  const ids = new Set(v5.claims.map((c: unknown[]) => c[0]));
  assert.ok(v5.inputBudget.omitted.claims > 0, 'something had to go');
  for (const id of ['c1', 'c4', 'c5']) assert.ok(ids.has(id), id + ' stays');
  assert.equal(v5.publicTurns.length, lines.length);
  assert.equal(v5.inputBudget.omitted.publicTurns, 0);
  assert.ok(JSON.stringify(v5).length <= 20000);
  assert.deepEqual(claimKeepOrder(claims, input().repairHistory).slice(-3).sort(), ['c1', 'c4', 'c5']);
});

const feature = (OLD.state.observationMemo as any)!.figures.find((f: any) => f.id === slots[1]).analytic.shapes[0] as string;
const detailValues = (extra: Record<string, unknown>, previous: any) => Object.values<string>(buildJevDecisionDetailPayload(
  { ...input({ previousAction: previous }), nameLedger, ...extra }, { action: 'confirm', target: { kind: 'single', figureId: slots[1] } }, { questionLayout: 'two_stage_v3' })!.questions.feature.criteria).map(v => JSON.parse(v).value);
const asked = [{ turn: 3, action: 'confirm', target: { kind: 'multiple', figureIds: [slots[1], slots[2]] }, name: null, feature }]; // turn 3 has the partner's answer c5 in the repair history
const unanswered = [{ ...asked[0], turn: 2 }];
const afterAccept = { turn: 6, action: 'accept', target: { kind: 'single', figureId: slots[1] }, name: null, feature: null };

test('holistic_v5 never asks again a feature already asked of the figure, even after the scope narrowed or an accept in between; before v5 the unbroken same-scope run decides', () => {
  assert.ok(detailValues({}, afterAccept).includes(feature), 'before holistic_v5 the feature comes back');
  const v5 = detailValues({ judgmentLedger: asked }, afterAccept);
  assert.ok(!v5.includes(feature) && v5.length > 0);
  // only an answered feature is excluded: one still without an answer, or whose answer was withdrawn, may be asked again
  assert.ok(detailValues({ judgmentLedger: unanswered }, afterAccept).includes(feature));
  const withdrawn = [claim('c1', 1, 'human', NAME, { aspect: 'name', act: 'name_propose', name: NAME }), claim('c5', 5, 'human', 'はい、二本です。', { targets: [slots[1]], respondsTo: 'c4' }),
    claim('w7', 7, 'human', 'もう一度確かめたい。', { targets: [slots[1]], act: 'withdraw', respondsTo: 'c5' })];
  assert.ok(detailValues({ judgmentLedger: asked, priorClaims: withdrawn }, afterAccept).includes(feature));
  // a revisit just before lifts the exclusion (the figure is looked at again)
  assert.ok(detailValues({ judgmentLedger: asked }, { ...afterAccept, action: 'revisit' }).includes(feature));
});

test('the rotation premise is part of the v5 instructions only, and only for relative_pm90 (omitted means that original mode)', () => {
  const sent = (extra: Record<string, unknown>) => buildJevDecisionPayload({ ...input(), nameLedger, ...extra }, { questionLayout: 'two_stage_v3', dialoguePolicy: 'holistic_v5' });
  const texts = (p: any) => Object.values<any>(p.questions).map(q => q.instructions);
  for (const extra of [{ judgmentLedger: ledger }, { judgmentLedger: ledger, rotationMode: 'relative_pm90' }]) {
    for (const t of texts(sent(extra))) assert.match(t, /relative_pm90/u);
  }
  assert.equal(JSON.parse(sent({ judgmentLedger: ledger }).state).rotationMode, 'relative_pm90');
  const zero = sent({ judgmentLedger: ledger, rotationMode: 'relative_0' });
  for (const t of texts(zero)) { assert.doesNotMatch(t, /relative_pm90|90度/u); assert.ok(t.includes(JUDGMENT_V5_LEGEND)); }
  assert.equal(JSON.parse(zero.state).rotationMode, 'relative_0');
  for (const t of texts(sent({}))) assert.doesNotMatch(t, /relative_pm90/u);
  assert.throws(() => sent({ judgmentLedger: ledger, rotationMode: 'relative_x' }), /invalid_input/u);
});
