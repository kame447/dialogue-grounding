// D 監査（AquaGauss）: 回転別メモの元データと、B1 の投影（stimuli/rotation-memory.ts）を、元データから独立に作った期待値で検査する。
// 検査する木は AUDIT_REPO_ROOT（無ければこのリポジトリ）、元データは AUDIT_DATA_DIR か検査する木の docs/review/ 配下（tests/support/rotation-memory-audit-data.ts）。
// B1 のコードが無い木では投影の試験を skip する。統合ブランチでは AUDIT_REQUIRE_ROTATION_MEMORY=1 を付け、無ければ失敗にする。
// 既存の試験と重複しない範囲だけ: 回転の向き（実際の自側の提示と確定分割の照合）、120方向の全件、相対回転、プライバシー、全方向なしでも部分あり。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { auditRoot } from './support/rotation-memory-audit-keys.ts';
import { loadSources, positionWords, relativeCentroid, ROTATIONS, sourcesAvailable } from './support/rotation-memory-audit-data.ts';
import type { SourceView } from './support/rotation-memory-audit-data.ts';

const root = auditRoot();
const memoryFile = root + 'dialogue-model/runtime/stimuli/rotation-memory.ts';
const haveMemory = existsSync(memoryFile), haveSources = sourcesAvailable();
const required = process.env.AUDIT_REQUIRE_ROTATION_MEMORY === '1';
const skipMemory = !(haveMemory && haveSources) && !required ? 'B1 の rotation-memory.ts か元データが無い木（統合ブランチでは AUDIT_REQUIRE_ROTATION_MEMORY=1）' : false;
const skipSources = !haveSources && !required ? '元データが無い（AUDIT_DATA_DIR か docs/review/ 配下）' : false;

test('必須指定のとき、B1 の rotation-memory.ts と元データがそろっている', { skip: required ? false : '統合ブランチだけ（AUDIT_REQUIRE_ROTATION_MEMORY=1）' }, () => {
  assert.ok(haveMemory, 'rotation-memory.ts');
  assert.ok(haveSources, '元データ');
});

// ---- 元データそのものの確認（契約の数値）。B1 のコードには依存しない ----
test('元データ: 120方向・117領域・468部分の被覆と契約の数値', { skip: skipSources }, () => {
  const s = loadSources();
  assert.equal(s.figureIds.length, 30);
  assert.equal(s.views.size, 120);
  const regionCount = [...s.figures.values()].reduce((n, f) => n + f.regions.length, 0);
  assert.equal(regionCount, 117);
  assert.equal(regionCount * 4, 468);
  const withWhole = [...s.views.values()].filter(v => v.whole.length > 0).length;
  assert.equal(withWhole, 80);
  assert.equal([...s.views.values()].reduce((n, v) => n + v.whole.length, 0), 99);
  assert.equal([...s.views.values()].reduce((n, v) => n + Object.values(v.parts).reduce((m, c) => m + c.length, 0), 0), 388);
  assert.equal([...s.views.values()].reduce((n, v) => n + Object.keys(v.parts).length, 0), 306);
  assert.equal(s.noCandidateParts.size, 162);
  // 全方向で全体なしの図形は実データに無い。現方向に全体なしの40方向は、すべて別の方向に全体がある。
  for (const id of s.figureIds) assert.ok(ROTATIONS.some(r => s.views.get(`${id}@${r}`)!.whole.length > 0), id + ' は全方向で全体なし');
  const neither = [...s.views].filter(([, v]) => v.whole.length === 0 && Object.keys(v.parts).length === 0).map(([k]) => k).sort();
  assert.deepEqual(neither, ['F6@0', 'F9@90']);
  // 部分の未合意は3領域だけで、候補なしとして扱われ、同じ方向の他の領域・全体は残る。
  const unagreed = [...s.agreement].filter(([, status]) => status === '未合意').map(([key]) => key).sort();
  assert.deepEqual(unagreed, ['F15@270#P3', 'F5@0#P2', 'F6@0#P4']);
  for (const key of unagreed) assert.ok(s.noCandidateParts.has(key), key);
  assert.ok(s.views.get('F15@270')!.whole.length >= 1 && Object.keys(s.views.get('F15@270')!.parts).length >= 1, 'F15@270 の他の候補が残る');
  // 領域IDと members は同じ図形の4方向で一致する。
  const parts = new Map<string, string>();
  for (const [key, status] of s.agreement) { void status; parts.set(key, ''); }
  for (const id of s.figureIds) for (const r of ROTATIONS) for (const region of s.figures.get(id)!.regions) assert.ok(s.agreement.has(`${id}@${r}#${region.id}`), `${id}@${r}#${region.id}`);
});

// ---- 回転の向き: 実際の自側の提示（createLayoutsV2）の重心が、確定分割を画面で時計回りに r 度回した重心と一致する ----
test('回転の向き: 120方向すべてで、提示された自側の図形の重心位置が時計回り r 度の幾何と一致する', { skip: skipSources }, async () => {
  const scatter: any = await import(pathToFileURL(root + 'dialogue-model/runtime/stimuli/scatter-v2.mjs').href);
  const s = loadSources();
  const sets = ['legacy-v1', 'bank-set-a', 'bank-set-b', 'bank-set-c', 'bank-set-d'];
  const seen = new Set<string>();
  let checked = 0;
  for (const mode of ['relative_pm90', 'relative_0', 'relative_90_180_270']) for (const setId of sets) for (let seed = 0; seed < 60; seed++) {
    const layouts = scatter.createLayoutsV2({ seed, rotationMode: mode, figureSelection: { mode: 'preset', setId } });
    for (const side of ['human', 'ai'] as const) for (const p of layouts[side] as any[]) {
      const figure = s.figures.get(p.figureId)!;
      const expected = relativeCentroid(figure, figure.atoms.map(a => a.id), p.rotation);
      const x = (p.centroid.x - p.bbox.x) / p.bbox.w, y = (p.centroid.y - p.bbox.y) / p.bbox.h;
      assert.ok(Math.abs(x - expected.x) < 1e-6 && Math.abs(y - expected.y) < 1e-6,
        `${p.figureId}@${p.rotation} (${side}, ${mode}, seed ${seed}): 提示 (${x.toFixed(4)}, ${y.toFixed(4)}) ≠ 時計回りの幾何 (${expected.x.toFixed(4)}, ${expected.y.toFixed(4)})`);
      seen.add(`${p.figureId}@${p.rotation}`); checked++;
    }
  }
  assert.equal(seen.size, 120, '120方向をすべて覆う（見つからない方向: ' + [...s.views.keys()].filter(k => !seen.has(k)).join(',') + '）');
  assert.ok(checked > 1000);
});

// ---- B1 の投影 ----
const load = async (): Promise<any> => import(pathToFileURL(memoryFile).href);
const mark = (confidence: string) => confidence === '低' ? undefined : confidence;
function assertView(actual: any, expected: SourceView, label: string) {
  assert.deepEqual(actual.whole.map((c: any) => c.noun), expected.whole.map(c => c.noun), label + ' 全体の名詞（順序も）');
  expected.whole.forEach((c, i) => {
    const a = actual.whole[i];
    assert.equal(a.posture, c.posture, label); assert.equal(a.direction, c.direction, label);
    assert.equal(a.confidence, mark(c.confidence), label + ' 確信度の印（低は省略）');
    assert.deepEqual(a.roles, Object.fromEntries(c.parts.map(p => [p.id, p.role])), label + ' 役割');
  });
  assert.deepEqual(Object.keys(actual.parts).sort(), Object.keys(expected.parts).sort(), label + ' 部分の候補がある領域');
  for (const [region, candidates] of Object.entries(expected.parts)) {
    assert.deepEqual(actual.parts[region].map((c: any) => c.noun), candidates.map(c => c.noun), `${label}#${region} 部分の名詞`);
    candidates.forEach((c, i) => {
      assert.equal(actual.parts[region][i].confidence, mark(c.confidence), `${label}#${region} 確信度の印`);
      assert.equal(actual.parts[region][i].owner, c.owner, `${label}#${region} owner`);
    });
  }
}

test('投影: 120の現在方向すべてで、現在・相対90/180/270 の見立てが元データと一致し、全方向の候補を落とさない', { skip: skipMemory }, async () => {
  const memory = await load(), s = loadSources();
  for (const id of s.figureIds) for (const current of ROTATIONS) {
    const label = `${id}@${current}`;
    const p = memory.projectOwnRotationMemory({ figureKey: id, rotation: current });
    assert.ok(p, label);
    assertView(p.current, s.views.get(label)!, label + ' 現在');
    assert.deepEqual(p.turned.map((t: any) => t.rel), [90, 180, 270], label);
    for (const t of p.turned) assertView(t, s.views.get(`${id}@${(current + t.rel) % 360}`)!, `${label} 相対${t.rel}`);
    assert.equal(p.wholeAnywhere, ROTATIONS.some(r => s.views.get(`${id}@${r}`)!.whole.length > 0), label + ' wholeAnywhere');
    assert.deepEqual(p.regions.map((r: any) => r.id), s.figures.get(id)!.regions.map(r => r.id), label + ' 領域ID');
  }
});

test('投影: 現在方向の領域の位置の語が、確定分割を時計回りに回した幾何と一致する', { skip: skipMemory }, async () => {
  const memory = await load(), s = loadSources();
  for (const id of s.figureIds) for (const current of ROTATIONS) {
    const p = memory.projectOwnRotationMemory({ figureKey: id, rotation: current }), figure = s.figures.get(id)!;
    p.regions.forEach((region: any, i: number) => {
      const rel = relativeCentroid(figure, figure.regions[i].members, current);
      assert.ok(positionWords(rel.x, rel.y).includes(region.at), `${id}@${current}#${region.id}: ${region.at} ≠ ${positionWords(rel.x, rel.y)} (${rel.x.toFixed(3)}, ${rel.y.toFixed(3)})`);
      assert.ok(Math.abs(region.areaPercent - rel.area / figure.atoms.reduce((n, a) => n + relativeCentroid(figure, [a.id], 0).area, 0) * 100) < 1e-6, `${id}#${region.id} 面積比`);
    });
  }
});

test('投影: 未合意の領域は候補なしのまま、同じ方向の他の見立てを巻き込まない', { skip: skipMemory }, async () => {
  const memory = await load();
  const cases: [string, number, string][] = [['F5', 0, 'P2'], ['F6', 0, 'P4'], ['F15', 270, 'P3']];
  for (const [id, view, region] of cases) for (const current of ROTATIONS) {
    const p = memory.projectOwnRotationMemory({ figureKey: id, rotation: current });
    const relative = (view - current + 360) % 360;
    const target = relative === 0 ? p.current : p.turned.find((t: any) => t.rel === relative);
    assert.equal(target.parts[region], undefined, `${id}@${view}#${region} は候補なし（現在 ${current}）`);
  }
  const f15 = memory.projectOwnRotationMemory({ figureKey: 'F15', rotation: 270 });
  assert.ok(f15.current.whole.length >= 1 && Object.keys(f15.current.parts).length >= 1);
});

test('投影: モデル入力に figureKey・絶対回転・回転方式・内部用の項目が無く、同じ入力で同じバイト、共有状態を持たない', { skip: skipMemory }, async () => {
  const memory = await load(), s = loadSources();
  const keys = new Set(['regions', 'current', 'turned', 'wholeAnywhere', 'id', 'shapeName', 'areaPercent', 'at', 'tip', 'concave', 'adjacent', 'whole', 'parts', 'rel',
    'noun', 'posture', 'direction', 'confidence', 'roles', 'owner']);
  const walk = (value: unknown, path: string, inRegionMap: boolean) => {
    if (typeof value === 'string') { assert.ok(!/\bF\d{1,2}\b|bank|relative_|rotationMode|figureKey|tangram/iu.test(value), `${path}: 内部の語 ${value}`); return; }
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, `${path}[${i}]`, false)); return; }
    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        assert.ok(inRegionMap ? /^P[1-9][0-9]?$/u.test(key) : keys.has(key), `${path}.${key}: 想定外のキー`);
        walk(child, `${path}.${key}`, !inRegionMap && (key === 'roles' || key === 'parts'));
      }
    }
  };
  for (const id of s.figureIds) for (const current of ROTATIONS) {
    const input = { figureKey: id, rotation: current };
    const first = JSON.stringify(memory.projectOwnRotationMemory(input));
    walk(JSON.parse(first), `${id}@${current}`, false);
    memory.projectOwnRotationMemory({ figureKey: id, rotation: (current + 90) % 360 });
    assert.equal(JSON.stringify(memory.projectOwnRotationMemory(input)), first, id + '@' + current + ' 同じ入力で同じバイト');
    // 360 の倍数で同じ向きとして扱う（ただし絶対回転は出力に現れない）
    assert.equal(JSON.stringify(memory.projectOwnRotationMemory({ figureKey: id, rotation: current + 360 })), first);
  }
});

test('投影: 束に無い図形は undefined（止めない）、90度の倍数でない回転は TypeError', { skip: skipMemory }, async () => {
  const memory = await load();
  assert.equal(memory.projectOwnRotationMemory({ figureKey: 'F99', rotation: 0 }), undefined);
  assert.throws(() => memory.projectOwnRotationMemory({ figureKey: 'F1', rotation: 45 }), TypeError);
});

test('投影: 全方向で全体なしでも部分の候補は残り、wholeAnywhere は false（合成の図形）', { skip: skipMemory }, async () => {
  const memory = await load();
  const view = (parts: unknown[]) => ({ layout: [{ id: 'P1', at: '中央付近', tipDirection: null }, { id: 'P2', at: '上寄り', tipDirection: '上' }], whole: [], parts, reviewStatus: 'ai_unreviewed' });
  const entry = { figureKey: 'FX', regions: [
    { id: 'P1', members: ['1'], shapeName: '三角形', sides: 3, areaPercent: 50, adjacent: ['P2'] },
    { id: 'P2', members: ['2'], shapeName: '三角形', sides: 3, areaPercent: 50, adjacent: ['P1'] }],
  views: { 0: view([{ id: 'P1', candidates: [{ noun: '耳', confidence: '低' }] }]), 90: view([]),
    180: view([{ id: 'P2', candidates: [{ noun: '屋根', confidence: '中', owner: '家' }] }]), 270: view([]) } };
  memory.validateRotationMemoryEntry(entry);
  const at0 = memory.projectRotationMemoryEntry(entry, 0), at90 = memory.projectRotationMemoryEntry(entry, 90);
  for (const p of [at0, at90]) { assert.equal(p.wholeAnywhere, false); assert.deepEqual(p.current.whole, []); for (const t of p.turned) assert.deepEqual(t.whole, []); }
  assert.deepEqual(at0.current.parts, { P1: [{ noun: '耳' }] });
  assert.deepEqual(at0.turned.find((t: any) => t.rel === 180).parts, { P2: [{ noun: '屋根', owner: '家', confidence: '中' }] });
  assert.deepEqual(at90.turned.find((t: any) => t.rel === 90).parts, { P2: [{ noun: '屋根', owner: '家', confidence: '中' }] });
  assert.deepEqual(at90.turned.find((t: any) => t.rel === 270).parts, { P1: [{ noun: '耳' }] });
});
