// D 監査（AquaGauss）D-C4: Jev 判断の state の字数を、図形数（3/4/6）と対話の長さの関数として測る（75c66cc で測定。他の木も AUDIT_REPO_ROOT で測れる）。
// 使い方: node tests/support/rotation-memory-audit-measure-jev-state.mjs [<repo root>]   （ネットワークは使わない。合成入力）
// 入力は tests/support/rotation-legacy-digests.ts の input() と同じ形式。長さだけを変えた合成の対話（1発話 約60字、人間1発話につき claim 2件、memo 540字/図形）。
// ストレスは発話の長さ ×2・claim ×3。20,000 字を超えて削り順でも縮まらないと buildJevDecisionPayload は invalid_input を投げる（停止の経路）。
// 試験（tests/rotation-memory-audit-budget.test.ts）からは makeHarness(root) で使う。
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LINES_H = ['丸い形が真ん中にあるのはどれですか。', 'その形に細い枝が二本ついていますか。', '三角が二つ並んでいる形のことです。', '上のほうが少し尖っている感じです。', '右側に小さな四角がくっついています。', 'さっきの形と似ているけれど少し違います。', '長い辺が斜めに伸びている形はありますか。', 'ああ、それです。こちらでも同じように見えます。', '全体は横に長い形で、端が細くなっています。', 'その呼び方でいいと思います。'];
const LINES_A = ['丸い部分が真ん中にある形ですね。', '細い枝が二本あるように見えます。', '三角が二つ並んでいる形だと思います。', '上が尖っている形は、こちらにもあります。', '右に小さな四角がつながっています。', '似ているけれど、少し違うかもしれません。', '長い辺が斜めに伸びている形が見えます。', 'こちらでも同じに見えます。', '横に長くて、端が細い形です。', 'ではその呼び方にしましょうか。'];
const pad = (s, n) => s.length >= n ? s : s + '。' + 'ー'.repeat(Math.max(0, n - s.length - 1));
const normalizeRoot = root => root.replace(/\/?$/, '/');

/** root の木の Jev ビルダーと、その木の合成入力の部品を返す。 */
export async function makeHarness(root) {
  root = normalizeRoot(root);
  const decision = await import(pathToFileURL(root + 'dialogue-model/runtime/decision/jev-decision.ts').href);
  const normal = JSON.parse(readFileSync(root + 'tests/support/s4-integration/NORMAL-RECORDS.json', 'utf8'));
  const OLD = normal.trials[0].replay[0].tape;
  const allSlots = OLD.state.observationMemo.figures.map(f => f.id);

  function memoFor(n, perFigure) {
    const base = structuredClone(OLD.state.observationMemo);
    base.figures = base.figures.slice(0, n).map((f, i) => ({ ...f,
      holistic: [{ construal: '見立て-' + i, basis: [pad('図形の一部がそのように見える根拠の記述', Math.max(20, Math.floor(perFigure * 0.45)))], status: 'hypothesis' }],
      analytic: { shapes: ['三角', '四角'], composition: pad('二つの部分が辺でつながる構成', Math.max(20, Math.floor(perFigure * 0.3))), relations: ['隣り合う'] } }));
    return base;
  }

  /** 最新の手番が人間の発話になる合成入力（turns は奇数）。 */
  function syntheticInput(n, turns, perFigure = 540) {
    const slots = allSlots.slice(0, n);
    const lines = [];
    for (let t = 1; t <= turns; t++) lines.push({ turn: t, speaker: t % 2 ? 'human' : 'ai', text: (t % 2 ? LINES_H : LINES_A)[t % 10] + (t % 3 === 0 ? '少し詳しく言うと、' + (t % 2 ? LINES_H : LINES_A)[(t + 3) % 10] : '') });
    const claims = lines.filter(l => l.speaker === 'human').flatMap((l, k) => [0, 1].map(j => ({ id: 'c' + l.turn + '_' + j, turn: l.turn, issueId: 'i-' + l.turn + '_' + j,
      targets: [slots[(k + j) % n]], aspect: j ? 'contour' : 'part', act: 'assert', proposition: '命題-' + l.turn + '_' + j + ' 部分の形についての主張', name: null, speaker: 'human',
      sourceTurn: l.turn, quote: l.text.slice(0, 20), respondsTo: null, source: 'partner_statement' })));
    const aiTurns = lines.filter(l => l.speaker === 'ai');
    const lastAi = aiTurns.at(-1);
    const ledger = aiTurns.slice(0, -1).map((l, k) => ({ turn: l.turn, action: k % 3 === 2 ? 'confirm' : 'accept', target: { kind: 'single', figureId: slots[k % n] }, name: null, feature: k % 3 === 2 ? '細い枝が二本ある' : null }));
    const repairHistory = ledger.filter(a => a.action === 'confirm').map(a => ({ turn: a.turn, issueId: null, action: 'confirm', question: a.feature, partnerClaims: [], candidatesBefore: [a.target.figureId],
      candidatesAfter: [a.target.figureId], addedClaimIds: [], removedClaimIds: [], progress: 'unknown' }));
    return { turn: turns, publicTurns: lines, ownSlots: slots, observations: memoFor(n, perFigure), issueSummary: '', priorClaims: claims, repairHistory,
      previousAction: lastAi ? { turn: lastAi.turn, action: 'accept', target: { kind: 'single', figureId: slots[0] }, name: null, feature: null } : undefined, publicNames: [],
      nameLedger: Object.fromEntries(slots.map(id => [id, { status: 'unassigned', name: null }])), judgmentLedger: ledger, rotationMode: 'relative_90_180_270' };
  }

  /** 発話の長さ ×2、claim ×3 にした悲観的な入力。 */
  function stressInput(n, turns) {
    const input = syntheticInput(n, turns);
    input.publicTurns = input.publicTurns.map(t => ({ ...t, text: t.text + t.text }));
    input.priorClaims = input.priorClaims.flatMap(c => [c, { ...c, id: c.id + 'x', issueId: c.issueId + 'x', proposition: c.proposition + 'の補足' }, { ...c, id: c.id + 'y', issueId: c.issueId + 'y' }]);
    return input;
  }

  /** Jev の判断の各呼び出し（decision・target・candidateSet・detail・referent・prospect）の state。投げたときは error。 */
  function buildAll(input, layout = 'two_stage_v3') {
    const selected = { kind: 'single', figureId: input.ownSlots[Math.min(1, input.ownSlots.length - 1)] };
    const calls = {
      decision: () => decision.buildJevDecisionPayload(input, { questionLayout: layout, dialoguePolicy: 'holistic_v5' }),
      target: () => decision.buildJevTargetPayload(input, 'confirm'),
      candidateSet: () => decision.buildJevCandidateSetPayload(input, 'confirm'),
      detail: () => decision.buildJevDecisionDetailPayload(input, { action: 'confirm', target: selected }, { questionLayout: layout }),
      referent: () => decision.buildHumanReferentPayload(input),
      prospect: () => decision.buildRepairProspectPayload(input, { questionLayout: layout }),
    };
    return Object.fromEntries(Object.entries(calls).map(([name, build]) => {
      try { const payload = build(); const state = payload.state ?? payload.payload?.state; return [name, { ok: true, stateChars: String(state).length, state: String(state) }]; }
      catch (error) { return [name, { ok: false, error: error instanceof Error ? error.message : String(error) }]; }
    }));
  }

  function measure(input) {
    const r = buildAll(input).decision;
    if (!r.ok) return { error: r.error };
    const omitted = JSON.parse(r.state).inputBudget?.omitted ?? null;
    return { stateChars: r.stateChars, headroom: 20000 - r.stateChars, omittedTurns: omitted?.publicTurns, omittedClaims: omitted?.claims };
  }
  return { syntheticInput, stressInput, buildAll, measure };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? process.env.AUDIT_REPO_ROOT ?? fileURLToPath(new URL('../../', import.meta.url));
  const { syntheticInput, stressInput, measure } = await makeHarness(root);
  const rows = [];
  for (const n of [3, 4, 6]) for (const aiTurns of [4, 8, 13, 24, 32]) {
    const turns = aiTurns * 2 + 1;
    rows.push({ figures: n, aiTurns, case: 'typical', ...measure(syntheticInput(n, turns)) });
    rows.push({ figures: n, aiTurns, case: 'stress', ...measure(stressInput(n, turns)) });
  }
  console.table(rows);
}
