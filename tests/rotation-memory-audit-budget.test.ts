// D 監査（AquaGauss）: 回転別メモが原因で Jev の判断の state が 20,000 字を超えて invalid_input（新しい停止の経路）にならないことの構成上の保証。
// 条件: 最悪の組の 6/4/3 図形 × 典型・ストレスの履歴 × AI 4・13・24・32 手番。基点（回転別メモなしの同じ入力）で通る条件はすべて通り、最新の人間の発話と全方向の名詞が state に残ること。
// 基点で既に失敗する条件（ストレス × 32 手番など）は既存の挙動として記録し、境目を悪化させないことだけを見る。
// 木: AUDIT_REPO_ROOT（ビルダーの木）、投影の木: AUDIT_MEMORY_ROOT（無ければ同じ木）。B1・C の木が別々のときだけ分ける。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { auditRoot } from './support/rotation-memory-audit-keys.ts';
import { makeHarness } from './support/rotation-memory-audit-measure-jev-state.mjs';

const builderRoot = auditRoot();
const memoryRoot = (process.env.AUDIT_MEMORY_ROOT ?? builderRoot).replace(/\/?$/, '/');
const memoryFile = memoryRoot + 'dialogue-model/runtime/stimuli/rotation-memory.ts';
const guidanceFile = builderRoot + 'dialogue-model/runtime/decision/rotation-memory-guidance.ts';
const ready = existsSync(memoryFile) && existsSync(guidanceFile);
const required = process.env.AUDIT_REQUIRE_ROTATION_MEMORY === '1';
const skip = !ready && !required ? 'B1 の rotation-memory.ts か C の rotation-memory-guidance.ts が無い木（統合ブランチでは AUDIT_REQUIRE_ROTATION_MEMORY=1）' : false;

const SETS: Record<string, string[]> = {
  'contract-worst6': ['F15', 'F1', 'F19', 'F23', 'F13', 'F27'],
  'nouns-worst6': ['F15', 'F1', 'F18', 'F19', 'F20', 'F2'],
  'full-worst6': ['F15', 'F1', 'F13', 'F19', 'F23', 'F2'],
};
const AI_TURNS = [4, 13, 24, 32];

test('必須指定のとき、B1 の投影と C のガイダンスがそろっている', { skip: required ? false : '統合ブランチだけ（AUDIT_REQUIRE_ROTATION_MEMORY=1）' }, () => {
  assert.ok(existsSync(memoryFile), memoryFile);
  assert.ok(existsSync(guidanceFile), guidanceFile);
});

test('Jev の判断の各呼び出し: 回転別メモを足しても、基点で通る条件は通り、最新の人間の発話と全方向の名詞が残る', { skip }, async t => {
  const memory: any = await import(pathToFileURL(memoryFile).href);
  const harness = await makeHarness(builderRoot);
  const added: Record<string, number> = {};
  const baselineFailures: string[] = [];
  const nounsOf = (projection: any): string[] => [projection.current, ...projection.turned].flatMap((view: any) => [
    ...view.whole.map((c: any) => c.noun), ...Object.values<any[]>(view.parts).flatMap(list => list.map((c: any) => c.noun))]);
  let checked = 0;
  for (const [setName, ids] of Object.entries(SETS)) for (const n of [6, 4, 3]) for (const kind of ['typical', 'stress'] as const) for (const aiTurns of AI_TURNS) {
    const turns = aiTurns * 2 + 1, figures = ids.slice(0, n);
    const baseline = kind === 'typical' ? harness.syntheticInput(n, turns) : harness.stressInput(n, turns);
    const withRotation = structuredClone(baseline);
    const projections = figures.map(figureKey => {
      // 各図形で最も大きい投影になる現在の向きを選ぶ（最悪側）。
      const options = [0, 90, 180, 270].map(rotation => memory.projectOwnRotationMemory({ figureKey, rotation }));
      return options.sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
    });
    withRotation.observations.figures.forEach((figure: any, i: number) => { figure.rotation = projections[i]; });
    const before = harness.buildAll(baseline), after = harness.buildAll(withRotation);
    const lastHuman = baseline.publicTurns.filter((p: any) => p.speaker === 'human').at(-1).text as string;
    for (const call of Object.keys(before)) {
      const label = `${setName} ${n}図形 ${kind} AI${aiTurns}手番 ${call}`;
      if (!before[call].ok) { baselineFailures.push(`${label}: 基点で既に ${before[call].error}`); continue; }
      assert.ok(after[call].ok, `${label}: 基点は通るが回転別メモありで ${after[call].error}（新しい停止の経路）`);
      assert.ok(after[call].state.includes(lastHuman), `${label}: 最新の人間の発話が state に残っていない`);
      if (call === 'decision') {
        for (const noun of new Set(projections.flatMap(nounsOf))) assert.ok(after[call].state.includes(noun), `${label}: 名詞「${noun}」が state に無い（全方向の候補を落とさない）`);
        added[`${n}|${kind}|${aiTurns}`] = Math.max(added[`${n}|${kind}|${aiTurns}`] ?? 0, after[call].stateChars - before[call].stateChars);
      }
      checked++;
    }
  }
  t.diagnostic('比較した呼び出し: ' + checked + '。基点で既に失敗: ' + baselineFailures.length + '件（既存の挙動）');
  t.diagnostic('state の増分の最大（decision、最悪の組）: ' + JSON.stringify(added));
  assert.ok(checked > 100);
});
