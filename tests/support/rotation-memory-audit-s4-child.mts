// D 監査（AquaGauss）: S4 の独立の確認の子プロセス。1つの木（TREE）の実際の runtime と模擬応答で、最終手番が accept・confirm・propose_name・再観察のいずれかの
// 受付の記録を作り、その木の S4（parity-verify）に検証させて、介入の4つの検査（shape・binding・execution・replay）の結果を1行の JSON で出す。
// 回転別メモあり（WITH_ROTATION=1）は、投影をそのまま入れた初回メモ（B2 の rotationInitialMemo）で作る。なしは従来の記録（比較用）。
// runtime の文面を1字変えた記録は、loader（rotation-memory-audit-s4-hook/register.mjs）つきで起動して作る。S4 の写しは別の file なので変わらない。
// 環境変数: TREE, CHILD_MODE（verify | segments）, SCENARIO, FIGURES（3|4|6）, VIEWS（JSON [[図形,回転],…]）, MODES（, 区切り）, LABEL, WITH_ROTATION, （出力の digest = 両方略の要求の本文の sha256。1字変えた記録が、変えない記録と本当に違うかを見る）
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const tree = (process.env.TREE ?? '').replace(/\/?$/, '/');
if (!tree.startsWith('/')) throw new Error('TREE must be an absolute path');
const load = (path: string): Promise<any> => import(pathToFileURL(tree + path).href);
const support: any = await load('tests/support/s4-v3-records.ts');
const verifier: any = await load('dialogue-model/runtime/diagnostics/parity-verify/index.ts');
const rotationRecords: any = await load('tests/support/s4-rotation-records.ts');
const { buildRecords, OWN } = support;

const scenario = process.env.SCENARIO ?? 'confirm', figureCount = Number(process.env.FIGURES ?? 3), label = process.env.LABEL ?? 'repair-first';
const withRotation = process.env.WITH_ROTATION !== '0', modes = (process.env.MODES ?? 'relative_pm90').split(',');
const DEFAULT_VIEWS: [string, number][] = [['F6', 0], ['F9', 90], ['F1', 270], ['F15', 180], ['F2', 0], ['F27', 90]];
const views: [string, number][] = process.env.VIEWS ? JSON.parse(process.env.VIEWS) : DEFAULT_VIEWS;

// 新しい版（p5_pilot012_rotation_memory_v1）の試行の設定 = v24 の生成・合意の版、受付の介入、判断の素材（tests/v24-three-figure-s4.test.ts と同じ）。
const OPTIONS = { dialoguePolicy: 'holistic_v5', interventionVersion: 'bypass_acceptance_v3', judgmentMaterialVersion: 'jev_repair_quality_v1',
  technicalTrial: { version: 'adaptive_repair_v3' }, generationRetryVersion: 'jev_generation_retry_v24', agreeNameScopeVersion: 'jev_naming_v3' } as const;
const choose = (key: string) => key === 'human_move_on_source' ? 'other' : key === 'commitment_state' ? 'not_due' : key === 'draft_topic_shift' ? 'within_plan' : undefined;
const checkOn = (process.env.POST_CHECK ?? 'off') === 'on';
// 公開前の検査が on の下書きは出所つきの JSON。off は、confirm（特徴を答える）が {text} の JSON、accept・propose_name は平文（tests/v24-three-figure-s4.test.ts と同じ）。
const draft = (text: string, plain = false) => checkOn ? JSON.stringify({ text, observationFeatures: [] }) : plain ? text : JSON.stringify({ text });
const aiExtraction = checkOn ? JSON.stringify({ segments: [], visualFeatures: { sources: [] } }) : '[]';
const base = { referent: 'figure_0', choose, aiExtraction, postGenerationCheck: checkOn ? 'on' : 'off' };
/** 最終手番。名前の提案は、人間が公開で見立てを言い（局所抽出がそれを図形に結ぶ）、AI が名前の候補（投影の全方向の全体の名詞）の最初のものを選ぶ。 */
const finalTurn = (name: string, anchorId: string): { human: string; plan: Record<string, unknown> } => {
  const human = `${name}のような形に見えます。`;
  const turns: Record<string, { human: string; plan: Record<string, unknown> }> = {
    accept: { human: 'もう一度さっきの図形に戻って特徴を教えてください。', plan: { ...base, action: 'accept', target: 'figure_0', speech: draft('さっきの図形ですね。', true) } },
    confirm: { human: 'もう一度さっきの図形に戻って特徴を教えてください。', plan: { ...base, action: 'confirm', target: 'figure_0', speech: draft('もう一つ特徴を確かめさせてください。') } },
    propose_name: { human, plan: { ...base, action: 'propose_name', target: 'figure_0', name, speech: draft(`では、「${name}」にしませんか？`, true), act: 'construe',
      extraction: JSON.stringify([{ segmentId: 'shape', quote: human, targets: [anchorId], aspect: 'construal', proposition: human, name: null, linkedIssueId: null, respondsToTurn: null }]),
      choose: (key: string) => key === 'draft_naming' ? 'propose_chosen' : choose(key) } },
    request_observation: { human: 'もう少し詳しく見てください。', plan: { ...base, action: 'confirm', target: 'figure_0', reobserve: true, speech: draft('見てから確かめます。'),
      choose: (key: string) => key === 'observe_aspect' ? 'construal' : choose(key) } },
  };
  if (!turns[scenario]) throw new Error('unknown scenario ' + scenario);
  return turns[scenario];
};

async function build(rotation: boolean) {
  let memo: unknown, name = '鳥';
  const anchors = OWN.ownAnchors.slice(0, figureCount);
  if (rotation) {
    const memoModule: any = await load('dialogue-model/runtime/observation/rotation-memo.ts');
    const memory: any = await load('dialogue-model/runtime/stimuli/rotation-memory.ts');
    const projections = new Map(anchors.map((anchor: any, i: number) => [anchor.id, memory.projectOwnRotationMemory({ figureKey: views[i][0], rotation: views[i][1] })]));
    memo = memoModule.rotationInitialMemo(anchors, projections, '2026-01-01T00:00:00.000Z');
    name = memory.rotationNameCandidates(projections.get(anchors[0].id))[0] ?? name;
  }
  return buildRecords({ ...OPTIONS, label, turns: [finalTurn(name, anchors[0].id)], ...(memo ? { memo } : {}), figureCount });
}

const INTERVENTION = /^intervention\.trial\.0\.attempt\.0\./u;
const statusesOf = (records: unknown): string[] => verifier.verifyRecords(records).checks.filter((c: { id: string }) => INTERVENTION.test(c.id)).map((c: { id: string; status: string }) => c.id.split('.').pop() + ':' + c.status);
const out = (value: unknown) => console.log('AUDIT_S4_RESULT ' + JSON.stringify(value));

if ((process.env.CHILD_MODE ?? 'verify') === 'segments') {
  // 回転別メモありの要求の文のうち、同じ種類の従来の要求にない文（回転別メモのために足された文面）を、要求の種類・位置とともに出す。
  const [rotation, base] = [await build(true), await build(false)];
  const requestsOf = (records: any) => records.trials[0].replay[0].result.sides[0].requests as any[];
  const leaves = (value: unknown, path: string[], into: Map<string, string>) => {
    if (typeof value === 'string') into.set(path.join('.'), value);
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) leaves(child, [...path, key], into);
  };
  const split = (text: string) => text.split(/(?<=。)|\n/u).map(s => s.trim()).filter(s => s.length > 3);
  const segments: { phase: string; path: string; segment: string }[] = [];
  for (const request of requestsOf(rotation)) {
    const mine = new Map<string, string>(), theirs = new Map<string, string>(); leaves(request.payload, [], mine);
    for (const other of requestsOf(base).filter(r => r.provider === request.provider && r.phase === request.phase)) leaves(other.payload, [], theirs);
    const known = new Set([...theirs.values()].flatMap(split));
    for (const [path, text] of mine) { if (/(^|\.)(role|type|model|purpose)$/u.test(path)) continue; for (const segment of split(text)) if (!known.has(segment)) segments.push({ phase: `${request.provider}/${request.phase}`, path, segment }); }
  }
  out({ scenario, segments });
} else {
  const records: any = await build(withRotation);
  const byMode: Record<string, string[]> = {};
  for (const mode of modes) byMode[mode] = statusesOf(mode === 'relative_pm90' ? records : rotationRecords.retargetToMode(records, mode));
  const sent = records.trials[0].replay[0].result.sides.map((side: any) => side.requests.map((request: any) => request.payload));
  out({ scenario, figureCount, byMode, digest: createHash('sha256').update(JSON.stringify(sent)).digest('hex') });
}
