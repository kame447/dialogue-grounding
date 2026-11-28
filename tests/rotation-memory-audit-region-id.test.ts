// D 監査（AquaGauss）P-3: 内部の領域ID（P1…）が、生成へ渡り得る「特徴の候補の文言」に入らないこと（統括の決定: 特徴の文言から ID の接頭辞を外し、形・位置・つながりで言う）。
// モデル内部の参照用の ID（state の regions・roles のキー）は残してよい。ここで見るのは、Jev の detail 問いで選ばれて公開発話の生成へ渡る特徴の文言と、
// B1 の rotationFeatureCandidates の出力（catalog.features の元）。公開前の検査の対象は広げない（検査を増やさない方針）。
// 木: AUDIT_REPO_ROOT（C のビルダー）、投影: AUDIT_MEMORY_ROOT（無ければ同じ木）。コードが無い木では skip（統合ブランチでは AUDIT_REQUIRE_ROTATION_MEMORY=1）。
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
const skip = !ready && process.env.AUDIT_REQUIRE_ROTATION_MEMORY !== '1' ? 'B1 の rotation-memory.ts か C の rotation-memory-guidance.ts が無い木' : false;
const REGION_ID = /(?<![A-Za-z0-9])P[1-9][0-9]?(?![A-Za-z0-9])/u;
const FIGURES = Array.from({ length: 30 }, (_, i) => 'F' + (i + 1));

test('rotationFeatureCandidates の文言に領域IDが無い（120の現在方向すべて）', { skip }, async () => {
  const memory: any = await import(pathToFileURL(memoryFile).href);
  for (const figureKey of FIGURES) for (const rotation of [0, 90, 180, 270]) {
    const features: string[] = memory.rotationFeatureCandidates(memory.projectOwnRotationMemory({ figureKey, rotation }));
    assert.ok(features.length > 0, `${figureKey}@${rotation}: 特徴の候補がある`);
    for (const feature of features) assert.ok(!REGION_ID.test(feature), `${figureKey}@${rotation}: 特徴の文言に領域ID「${feature}」`);
  }
});

test('Jev の detail 問いの特徴の候補（生成へ渡る値）に領域IDが無い', { skip }, async () => {
  const memory: any = await import(pathToFileURL(memoryFile).href);
  const decision: any = await import(pathToFileURL(builderRoot + 'dialogue-model/runtime/decision/jev-decision.ts').href);
  const harness = await makeHarness(builderRoot);
  let checkedValues = 0;
  for (let start = 0; start < FIGURES.length; start += 3) for (const rotation of [0, 90, 180, 270]) {
    const input = harness.syntheticInput(3, 7), withRotation = structuredClone(input);
    withRotation.observations.figures.forEach((figure: any, i: number) => { figure.rotation = memory.projectOwnRotationMemory({ figureKey: FIGURES[start + i], rotation }); });
    const selected = { kind: 'single', figureId: input.ownSlots[0] };
    const payload = decision.buildJevDecisionDetailPayload(withRotation, { action: 'confirm', target: selected }, { questionLayout: 'two_stage_v3' });
    for (const question of Object.values<any>(payload.questions)) for (const criterion of Object.values<string>(question.criteria)) {
      let value: unknown = criterion;
      try { value = JSON.parse(criterion).value; } catch { /* 値でない基準文はそのまま */ }
      assert.ok(!REGION_ID.test(String(value)), `${FIGURES[start]}…@${rotation}: 特徴の値に領域ID「${String(value).slice(0, 60)}」`);
      checkedValues++;
    }
  }
  assert.ok(checkedValues > 200);
});

// 特徴の候補（Jev の detail 問い）に、メモの定型の1行（analytic.composition のプレースホルダ）が「選べる特徴」として並ばない。
// 並ぶと、選ばれた特徴として「形・位置・接続は rotation を参照。」が生成へ渡り、内部の語 rotation を含む意味のない文が公開発話の材料になる。
test('detail 問いの特徴の候補に、メモの定型のプレースホルダ（形・位置・接続は rotation を参照 など）が無い', {
  skip: !existsSync(builderRoot + 'dialogue-model/runtime/observation/rotation-memo.ts') && process.env.AUDIT_REQUIRE_ROTATION_MEMORY !== '1' ? 'B2 の rotation-memo.ts が無い木' : skip }, async () => {
  const memory: any = await import(pathToFileURL(memoryFile).href);
  const memoModule: any = await import(pathToFileURL(builderRoot + 'dialogue-model/runtime/observation/rotation-memo.ts').href);
  const decision: any = await import(pathToFileURL(builderRoot + 'dialogue-model/runtime/decision/jev-decision.ts').href);
  const harness = await makeHarness(builderRoot);
  const placeholders = [memoModule.ROTATION_MEMO_COMPOSITION, memoModule.ROTATION_MEMO_ABSENT];
  let checked = 0;
  for (let start = 0; start < FIGURES.length; start += 3) {
    const input = harness.syntheticInput(3, 7);
    const anchors = input.observations.figures.map((figure: any) => ({ id: figure.id, bbox: figure.region }));
    const projections = new Map<string, unknown>();
    anchors.forEach((anchor: any, i: number) => projections.set(anchor.id, memory.projectOwnRotationMemory({ figureKey: FIGURES[start + i], rotation: 90 })));
    input.observations = memoModule.rotationInitialMemo(anchors, projections, '2026-01-01T00:00:00.000Z');
    const payload = decision.buildJevDecisionDetailPayload(input, { action: 'confirm', target: { kind: 'single', figureId: input.ownSlots[0] } }, { questionLayout: 'two_stage_v3' });
    for (const question of Object.values<any>(payload.questions)) for (const criterion of Object.values<string>(question.criteria)) {
      let value: unknown = criterion;
      try { value = JSON.parse(criterion).value; } catch { /* 値でない基準文はそのまま */ }
      for (const placeholder of placeholders) assert.ok(!String(value).includes(placeholder), `${FIGURES[start]}…: 特徴の候補に定型のプレースホルダ「${placeholder}」`);
      checked++;
    }
  }
  assert.ok(checked > 50);
});
