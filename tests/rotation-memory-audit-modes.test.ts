// D 監査（AquaGauss）: 回転別メモの部分が、3つの回転方式（relative_pm90・relative_0・relative_90_180_270）でバイト同一であること（統括 D-C3）。
// 回転方式で変わってよいのは、state に記録される rotationMode の値と、課題条件の文（ROTATION_V5 / ROTATION_V5_90_180_270 / なし）だけ。
// Jev の判断の各呼び出し（decision・target・candidateSet・detail・referent・prospect）の state と問い（instructions・criteria）で見る。
// 木: AUDIT_REPO_ROOT（C のビルダー）、投影: AUDIT_MEMORY_ROOT（無ければ同じ木）。コードが無い木では skip（統合ブランチでは AUDIT_REQUIRE_ROTATION_MEMORY=1）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { auditRoot } from './support/rotation-memory-audit-keys.ts';
import { makeHarness } from './support/rotation-memory-audit-measure-jev-state.mjs';
import { PREMISE_90_180_270, PREMISE_PM90 } from './support/s4-rotation-records.ts';

const builderRoot = auditRoot();
const memoryRoot = (process.env.AUDIT_MEMORY_ROOT ?? builderRoot).replace(/\/?$/, '/');
const memoryFile = memoryRoot + 'dialogue-model/runtime/stimuli/rotation-memory.ts';
const guidanceFile = builderRoot + 'dialogue-model/runtime/decision/rotation-memory-guidance.ts';
const skip = !(existsSync(memoryFile) && existsSync(guidanceFile)) && process.env.AUDIT_REQUIRE_ROTATION_MEMORY !== '1' ? 'B1 の rotation-memory.ts か C の rotation-memory-guidance.ts が無い木' : false;
const MODES = ['relative_pm90', 'relative_0', 'relative_90_180_270'] as const;
const withoutPremise = (text: string) => text.split('\\n' + PREMISE_PM90).join('').split('\\n' + PREMISE_90_180_270).join('');

test('回転別メモの state と問いは、3つの回転方式で（rotationMode の値と課題条件の文を除き）バイト同一', { skip }, async () => {
  const memory: any = await import(pathToFileURL(memoryFile).href);
  const harness = await makeHarness(builderRoot);
  const ids = ['F6', 'F9', 'F1', 'F15', 'F2', 'F27'], rotations = [0, 90, 270, 180, 0, 90];
  for (const n of [3, 6]) for (const aiTurns of [4, 13]) {
    const base = harness.syntheticInput(n, aiTurns * 2 + 1);
    base.observations.figures.forEach((figure: any, i: number) => { figure.rotation = memory.projectOwnRotationMemory({ figureKey: ids[i], rotation: rotations[i] }); });
    const results = MODES.map(mode => ({ mode, built: harness.buildAll({ ...structuredClone(base), rotationMode: mode }) }));
    for (const call of Object.keys(results[0].built)) {
      const reference = results[0].built[call];
      for (const { mode, built } of results.slice(1)) {
        const label = `${n}図形 AI${aiTurns}手番 ${call} ${MODES[0]} vs ${mode}`;
        assert.equal(built[call].ok, reference.ok, label + ' 成否');
        if (!reference.ok) continue;
        assert.equal(built[call].state.replace(`"rotationMode":"${mode}"`, `"rotationMode":"${MODES[0]}"`), reference.state, label + ' state（回転別メモの部分を含む）');
        assert.equal(withoutPremise(built[call].questions), withoutPremise(reference.questions), label + ' 問い（課題条件の文を除く）');
      }
    }
  }
});

test('課題条件の文はモード別に1つだけ残る（pm90 は ±90、90_180_270 はその文、relative_0 は無し）', { skip }, async () => {
  const memory: any = await import(pathToFileURL(memoryFile).href);
  const harness = await makeHarness(builderRoot);
  const base = harness.syntheticInput(3, 9);
  base.observations.figures.forEach((figure: any, i: number) => { figure.rotation = memory.projectOwnRotationMemory({ figureKey: ['F6', 'F9', 'F1'][i], rotation: [0, 90, 270][i] }); });
  const count = (text: string, sentence: string) => text.split(sentence).length - 1;
  const expected: Record<string, [boolean, boolean]> = { relative_pm90: [true, false], relative_0: [false, false], relative_90_180_270: [false, true] };
  for (const mode of MODES) {
    const built = harness.buildAll({ ...structuredClone(base), rotationMode: mode });
    for (const call of ['decision', 'referent']) {
      const questions = Object.values<any>(JSON.parse(built[call].questions as string));
      assert.ok(questions.length > 0, `${mode} ${call}`);
      for (const question of questions) {
        // 同じ問いの中で課題条件の文を重ねない（モードに合う文が1回、合わない文は0回）。
        assert.equal(count(question.instructions, PREMISE_PM90), expected[mode][0] ? 1 : 0, `${mode} ${call}: ±90 の文`);
        assert.equal(count(question.instructions, PREMISE_90_180_270), expected[mode][1] ? 1 : 0, `${mode} ${call}: 90/180/270 の文`);
      }
    }
  }
});
