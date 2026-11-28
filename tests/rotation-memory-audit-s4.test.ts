// D 監査（AquaGauss）: S4（diagnostics/parity-verify）が、回転別メモ（rotation）を持つ受付の記録を検証して合格し、runtime の文面の1字の違いを不合格にすること。
// 背景: 新 pin の S4 登録（p5_pilot012_rotation_memory_v1）は fixed/native を v24 の表のまま流用しており、rotation を持つ要求は replay が mismatch になる（fail-closed）。
// 統括の判断（2026-11-28）で、rotation を持つ要求の文面の独立の写しを S4 に足すことになった（B2）。この試験は、その写しを B2 の試験とは別に確かめる。
//   S0 独立性（常時・静的）: parity-verify/ が runtime の rotation 系 module を値として import しない（import type は可）。import すると S1・S2 の検出が成り立たない。
//   S1 合格（AUDIT_S4=1 か AUDIT_REQUIRE_ROTATION_MEMORY=1）: v24 の設定で最終手番を accept・confirm・propose_name・再観察にした記録（3回転方式・両方略・3/4/6図形・公開前の検査 off/on）を S4 が通す。
//      AUDIT_S4_FULL=1 は、全120の現在方向（30図形×4回転）でも誤警報が出ないことまで見る。
//   S2 不合格（AUDIT_S4_MUTATION=1 か AUDIT_S4_FULL=1）: rotation のために足された runtime の文のうち1字だけ読み込み時に変えた記録（loader）を作り、S4 の replay だけが mismatch になる。
//      S4 の写しは別の file なので変わらない（変わるなら独立でない）。指紋は disk の file から計算するので、登録された版のまま = 「登録どおりの runtime が1字違う文を送った」状態。
// 記録は子プロセス（support/rotation-memory-audit-s4-child.mts）で、木 AUDIT_REPO_ROOT の実際の runtime と模擬応答から作る（API・鍵・研究データなし）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { auditRoot } from './support/rotation-memory-audit-keys.ts';

const root = auditRoot();
const childPath = fileURLToPath(new URL('./support/rotation-memory-audit-s4-child.mts', import.meta.url));
const registerPath = fileURLToPath(new URL('./support/rotation-memory-audit-s4-hook/register.mjs', import.meta.url));
const verifyDir = root + 'dialogue-model/runtime/diagnostics/parity-verify/';
const runtimeDir = root + 'dialogue-model/runtime/';
const required = process.env.AUDIT_REQUIRE_ROTATION_MEMORY === '1';
const full = process.env.AUDIT_S4_FULL === '1';
const needed = ['dialogue-model/runtime/observation/rotation-memo.ts', 'dialogue-model/runtime/decision/rotation-memory-guidance.ts', 'tests/support/s4-v3-records.ts', 'tests/support/s4-rotation-records.ts'];
const missing = needed.filter(file => !existsSync(root + file));
const notReady = missing.length > 0 && !required ? '次のファイルが無い木: ' + missing.join(', ') : false;
const skipMatrix = notReady || (!(required || process.env.AUDIT_S4 === '1' || full) ? 'AUDIT_S4=1（か AUDIT_REQUIRE_ROTATION_MEMORY=1）のときだけ' : false);
const skipMutation = notReady || (!(process.env.AUDIT_S4_MUTATION === '1' || full) ? 'AUDIT_S4_MUTATION=1（か AUDIT_S4_FULL=1）のときだけ' : false);

type Outcome = { ok: true; result: { scenario: string; figureCount: number; byMode: Record<string, string[]>; digest: string; segments?: { phase: string; path: string; segment: string }[] } } | { ok: false; stderr: string };
function runChild(env: Record<string, string>, mutate?: { suffix: string; from: string; to: string }): Promise<Outcome> {
  const args = [...(mutate ? ['--import', registerPath] : []), childPath];
  const childEnv = { ...process.env, TREE: root, ...env, ...(mutate ? { MUTATE_SUFFIX: mutate.suffix, MUTATE_FROM: mutate.from, MUTATE_TO: mutate.to } : {}) };
  return new Promise(resolve => execFile(process.execPath, args, { env: childEnv, maxBuffer: 256 * 1024 * 1024, timeout: 300000 }, (error, stdout, stderr) => {
    const line = stdout.split('\n').find(l => l.startsWith('AUDIT_S4_RESULT '));
    resolve(line ? { ok: true, result: JSON.parse(line.slice('AUDIT_S4_RESULT '.length)) } : { ok: false, stderr: (stderr || String(error)).split('\n').filter(l => l.trim()).slice(-4).join(' | ').slice(0, 400) });
  }));
}
/** At most `limit` jobs at a time (each job is a whole node process that builds records). */
async function pool<T, R>(items: readonly T[], limit: number, job: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const i = next++; results[i] = await job(items[i]); } }));
  return results;
}

const ALL_PASS = ['shape:pass', 'binding:pass', 'execution:pass', 'replay:pass'];
const REPLAY_ONLY = ['shape:pass', 'binding:pass', 'execution:pass', 'replay:mismatch'];
const MODES = 'relative_pm90,relative_0,relative_90_180_270';
const SCENARIOS = ['accept', 'confirm', 'propose_name', 'request_observation'] as const;

// ---------------------------------------------------------------- S0
const FORBIDDEN_IMPORT = /(?:rotation-memory|rotation-memo|primary-regions|part-consumers|part-geometry)/u;
function sourceFiles(dir: string, accept: (path: string) => boolean): string[] {
  return readdirSync(dir).flatMap(name => { const path = dir + name; return statSync(path).isDirectory() ? sourceFiles(path + '/', accept) : accept(path) ? [path] : []; });
}
test('S0 独立性: parity-verify/ は runtime の rotation 系 module を値として import しない（import type は可）', { skip: existsSync(verifyDir) ? false : 'parity-verify/ が無い木' }, () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(verifyDir, path => /\.(?:ts|mjs)$/u.test(path))) {
    const text = readFileSync(file, 'utf8');
    // import … from '…'・export … from '…'・import('…')。type だけの import は消えるので数えない。
    const statements = [...text.matchAll(/^(?:import|export)\s+(type\s+)?[^;]*?from\s+['"]([^'"]+)['"]/gmu)].map(m => ({ typeOnly: m[1] !== undefined, target: m[2] }))
      .concat([...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu)].map(m => ({ typeOnly: false, target: m[1] })));
    for (const { typeOnly, target } of statements) if (!typeOnly && FORBIDDEN_IMPORT.test(target)) offenders.push(`${file.slice(root.length)} → ${target}`);
  }
  assert.deepEqual(offenders, [], 'S4 の写しが runtime の実装を import している（独立の写しでない）');
});

// ---------------------------------------------------------------- S1
test('S1 回転別メモを持つ受付の記録を S4 が検証して合格する（4つの行動・3回転方式・3/4/6図形・両方略・公開前の検査 off/on）', { skip: skipMatrix, timeout: 1500000 }, async () => {
  const cases: { env: Record<string, string>; note: string }[] = [
    ...SCENARIOS.map(scenario => ({ env: { SCENARIO: scenario, FIGURES: '3' }, note: `${scenario} 3図形 off` })),
    { env: { SCENARIO: 'confirm', FIGURES: '3', POST_CHECK: 'on' }, note: 'confirm 3図形 on' },
    { env: { SCENARIO: 'confirm', FIGURES: '6' }, note: 'confirm 6図形 off' },
    { env: { SCENARIO: 'propose_name', FIGURES: '4', LABEL: 'bypass-enabled' }, note: 'propose_name 4図形 bypass-enabled' },
    { env: { SCENARIO: 'request_observation', FIGURES: '6', POST_CHECK: 'on' }, note: 'request_observation 6図形 on' },
  ];
  const outcomes = await pool(cases, 3, ({ env }) => runChild({ ...env, MODES }));
  const failures: string[] = [];
  outcomes.forEach((outcome, i) => {
    if (!outcome.ok) { failures.push(`${cases[i].note}: 記録を作れない: ${outcome.stderr}`); return; }
    for (const mode of MODES.split(',')) if (JSON.stringify(outcome.result.byMode[mode]) !== JSON.stringify(ALL_PASS)) failures.push(`${cases[i].note} ${mode}: ${outcome.result.byMode[mode]?.join(' ')}`);
  });
  assert.deepEqual(failures, [], 'S4 が回転別メモを持つ記録を通さない');
});

test('S1 全120の現在方向（30図形×4回転）の回転別メモで、S4 が誤警報を出さない（confirm は6図形ずつ、propose_name は各組の先頭の図形の名前の候補）', { skip: full ? notReady : 'AUDIT_S4_FULL=1 のときだけ', timeout: 3600000 }, async () => {
  const sets: { rotation: number; keys: string[] }[] = [];
  for (const rotation of [0, 90, 180, 270]) for (let group = 0; group < 5; group++) sets.push({ rotation, keys: Array.from({ length: 6 }, (_, i) => 'F' + (group * 6 + i + 1)) });
  const jobs = sets.flatMap(set => (['confirm', 'propose_name'] as const).map(scenario => ({ set, scenario })));
  const outcomes = await pool(jobs, 3, ({ set, scenario }) => runChild({ SCENARIO: scenario, FIGURES: '6', MODES: 'relative_pm90', VIEWS: JSON.stringify(set.keys.map(key => [key, set.rotation])) }));
  const failures: string[] = [];
  outcomes.forEach((outcome, i) => {
    const note = `${jobs[i].scenario} ${jobs[i].set.keys[0]}…${jobs[i].set.keys[5]}@${jobs[i].set.rotation}`;
    if (!outcome.ok) failures.push(`${note}: 記録を作れない: ${outcome.stderr}`);
    else if (JSON.stringify(outcome.result.byMode.relative_pm90) !== JSON.stringify(ALL_PASS)) failures.push(`${note}: ${outcome.result.byMode.relative_pm90?.join(' ')}`);
  });
  assert.deepEqual(failures, []);
  assert.equal(sets.length * 6, 120);
});

// ---------------------------------------------------------------- S2
/** 日本語の連なり（JSON の記号を含まない）。runtime の source に連続した文字列として現れるものだけを、読み込み時の1字変更の場所にする。 */
const JAPANESE_RUN = /[ぁ-ゟ゠-ヿ一-鿿々〇ー・、。「」（）／：；！？]{14,}/gu;
const CONTENT_CHAR = /[ぁ-ゟ゠-ヿ一-鿿]/u;
/** 記録を作る場面。confirm_on は公開前の検査 on、name_current_whole は先頭の図形（F1@270）の今の向きに全体の見立てがある。 */
const PROFILES: Record<string, Record<string, string>> = {
  accept: { SCENARIO: 'accept' }, confirm: { SCENARIO: 'confirm' }, propose_name: { SCENARIO: 'propose_name' }, request_observation: { SCENARIO: 'request_observation' },
  confirm_on: { SCENARIO: 'confirm', POST_CHECK: 'on' },
  name_current_whole: { SCENARIO: 'propose_name', VIEWS: JSON.stringify([['F1', 270], ['F9', 90], ['F6', 0]]) },
};
type Site = { kind: 'text' | 'code'; suffix: string; from: string; to: string; profile: string; note: string };
function mutationSites(segments: { profile: string; phase: string; path: string; segment: string }[]): Site[] {
  const files = sourceFiles(runtimeDir, path => /\.(?:ts|mjs)$/u.test(path) && !path.includes('/diagnostics/') && !/-data\.ts$/u.test(path)).map(path => ({ path, text: readFileSync(path, 'utf8') }));
  const sites = new Map<string, Site>();
  for (const { profile, phase, path, segment } of segments) {
    for (const match of segment.matchAll(JAPANESE_RUN)) {
      const window = match[0].slice(0, 40);
      const at = [...window].findIndex((c, i) => i >= Math.floor(window.length / 2) && CONTENT_CHAR.test(c));
      if (at < 0) continue;
      const chars = [...window]; chars[at] = chars[at] === '〇' ? '々' : '〇';
      // 従来の文（jev-decision.ts など）と同じ書き出しの文は、回転別メモの module（rotation-memory*）の側の1か所を変える。
      const holders = files.filter(file => file.text.includes(window)), own = holders.filter(file => /rotation-memory/u.test(file.path));
      const holder = holders.length === 1 ? holders[0] : own.length === 1 ? own[0] : null;
      if (!holder || holder.text.indexOf(window) !== holder.text.lastIndexOf(window)) continue;
      const suffix = holder.path.slice(runtimeDir.length), key = suffix + '#' + holder.text.indexOf(window);
      if (!sites.has(key)) sites.set(key, { kind: 'text', suffix, from: window, to: chars.join(''), profile, note: `${phase} ${path}` });
    }
  }
  return [...sites.values()].sort((a, b) => (a.suffix + a.from).localeCompare(b.suffix + b.from));
}
/** 文ではなく、層・候補の描画の code。S4 が写しの導出（描画の規則）まで持つかを見る。anchor は 68131eb（C の rotation-memory-guidance.ts・B1 の rotation-memory-shape.ts）の code。
 *  full の層（姿勢／向き）と特徴の候補（rotationFeatureCandidates）は、v24 の経路（呼び出しごとの層に full が無く、visualPurpose で特徴の候補が空）では送られないので入れない。 */
const CODE_SITES: Site[] = [
  { kind: 'code', suffix: 'decision/rotation-memory-guidance.ts', profile: 'confirm', note: '全体の見立ての区切り（nouns）', from: 'view.whole.map(nounMark).join("・")', to: 'view.whole.map(nounMark).join("、")' },
  { kind: 'code', suffix: 'decision/rotation-memory-guidance.ts', profile: 'confirm', note: '部分の見立ての区切り（roles の parts）', from: '.join("・")}`).join(" / ") || "なし"', to: '.join("、")}`).join(" / ") || "なし"' },
  { kind: 'code', suffix: 'decision/rotation-memory-guidance.ts', profile: 'confirm', note: '部分の見立ての区切り（nouns の1行）', from: '.join("・")}`)].join(" / ")', to: '.join("、")}`)].join(" / ")' },
  { kind: 'code', suffix: 'decision/rotation-memory-guidance.ts', profile: 'confirm', note: '「全体: 」の接頭', from: '["全体: " + (view.whole.length', to: '["全体:" + (view.whole.length' },
  { kind: 'code', suffix: 'decision/rotation-memory-guidance.ts', profile: 'confirm', note: '確信度の印の括弧', from: '`${c.noun}（${c.confidence}）`', to: '`${c.noun}(${c.confidence})`' },
  { kind: 'code', suffix: 'decision/rotation-memory-guidance.ts', profile: 'confirm', note: '領域の行（nouns）の面積の記号', from: '${r.shapeName} ${r.areaPercent}%`)', to: '${r.shapeName} ${r.areaPercent}％`)' },
  { kind: 'code', suffix: 'decision/rotation-memory-guidance.ts', profile: 'confirm', note: '領域の行（roles）の面積の記号', from: '${r.areaPercent}%${r.tip === undefined', to: '${r.areaPercent}％${r.tip === undefined' },
  { kind: 'code', suffix: 'decision/rotation-memory-guidance.ts', profile: 'confirm', note: '隣り合う領域の区切り（roles）', from: '隣:${r.adjacent.join("・")}', to: '隣:${r.adjacent.join("、")}' },
  { kind: 'code', suffix: 'stimuli/rotation-memory-shape.ts', profile: 'name_current_whole', note: '名前の候補の順（今の向き→回した向き）', from: '[rotation.current, ...rotation.turned].flatMap', to: '[...rotation.turned, rotation.current].flatMap' },
];
/** 各 file から最低1つ、残りは等間隔で `limit` 個まで。 */
function sample(sites: Site[], limit: number): Site[] {
  const picked = new Set<Site>(); const seen = new Set<string>();
  for (const site of sites) if (!seen.has(site.suffix) && picked.size < limit) { seen.add(site.suffix); picked.add(site); }
  const rest = sites.filter(site => !picked.has(site)), room = Math.max(0, limit - picked.size);
  for (let i = 0; i < room && rest.length > 0; i++) picked.add(rest[Math.floor(((i + 0.5) * rest.length) / room)]);
  return [...picked];
}

test('S2 rotation のために足された runtime の文・描画を1字変えると、S4 の replay だけが mismatch になる（S4 の写しは runtime から独立）', { skip: skipMutation, timeout: 3600000 }, async () => {
  // 0. 変えない記録が先に合格すること（合格しない記録では、どの1字変更も「不合格」になってしまい、写しを確かめたことにならない）。
  const names = Object.keys(PROFILES);
  const controls = await pool(names, 3, name => runChild({ ...PROFILES[name], FIGURES: '3', MODES: 'relative_pm90' }));
  const digestOf = new Map<string, string>();
  controls.forEach((outcome, i) => {
    assert.ok(outcome.ok, `${names[i]}: 記録を作れない`);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.result.byMode.relative_pm90, ALL_PASS, `${names[i]}: 変えない記録が S4 を通らない`);
    digestOf.set(names[i], outcome.result.digest);
  });
  // 1. 回転別メモのために足された文（従来の同じ種類の要求にない文）を、場面ごとに集め、runtime の source のどこにあるかを探す。
  const discoveryProfiles = ['accept', 'confirm', 'propose_name', 'request_observation', 'confirm_on'];
  const discovered = await pool(discoveryProfiles, 3, name => runChild({ ...PROFILES[name], FIGURES: '3', CHILD_MODE: 'segments' }));
  const segments = discovered.flatMap((outcome, i) => outcome.ok ? (outcome.result.segments ?? []).map(s => ({ profile: discoveryProfiles[i], ...s })) : []);
  assert.ok(segments.length > 100, '回転別メモのために足された文を集められない: ' + segments.length);
  const textSites = mutationSites(segments);
  assert.ok(new Set(textSites.map(s => s.suffix)).size >= 2, '文の1字変更の場所が少なすぎる: ' + [...new Set(textSites.map(s => s.suffix))].join(', '));
  for (const site of CODE_SITES) {
    const text = readFileSync(runtimeDir + site.suffix, 'utf8');
    assert.equal(text.split(site.from).length - 1, 1, `描画の1字変更の anchor が source に1つだけ無い（code が変わったなら、この表を更新する）: ${site.suffix} ${site.note}`);
  }
  // 2. それぞれを読み込み時に変えて記録を作り直し、S4 に通す。
  const chosen = [...sample(textSites, full ? 400 : 60), ...CODE_SITES];
  const outcomes = await pool(chosen, 3, site => runChild({ ...PROFILES[site.profile], FIGURES: '3', MODES: 'relative_pm90' }, { suffix: site.suffix, from: site.from, to: site.to }));
  const undetected: string[] = [], inconclusive: string[] = [], otherChecks: string[] = [];
  let detected = 0;
  outcomes.forEach((outcome, i) => {
    const site = chosen[i], label = `[${site.kind}] ${site.suffix} 「${site.from.slice(0, 24)}」→「${site.to.slice(0, 24)}」（${site.profile}・${site.note}）`;
    if (!outcome.ok) { inconclusive.push(label + ' runtime が変えた文で記録を作れない: ' + outcome.stderr.slice(0, 120)); return; }
    if (outcome.result.digest === digestOf.get(site.profile)) { inconclusive.push(label + ' 送る要求が変わらない（この場面では使われない）'); return; }
    const statuses = outcome.result.byMode.relative_pm90;
    if (JSON.stringify(statuses) === JSON.stringify(REPLAY_ONLY)) detected++;
    else if (JSON.stringify(statuses) === JSON.stringify(ALL_PASS)) undetected.push(label + '  ← S4 が通した（写しが無いか、runtime から文・描画を取っている）');
    else otherChecks.push(label + ' ' + statuses?.join(' '));
  });
  console.log(`S2: ${chosen.length}か所（文 ${textSites.length} 候補・${new Set(textSites.map(s => s.suffix)).size} file ＋ 描画 ${CODE_SITES.length}）のうち、replay だけの不合格 ${detected}、通した ${undetected.length}、他の検査の不合格 ${otherChecks.length}、判定できず ${inconclusive.length}`);
  for (const line of inconclusive) console.log('  判定できず: ' + line);
  assert.deepEqual(undetected, [], '1字変えた文・描画を S4 が通した');
  assert.deepEqual(otherChecks, [], '1字変えたのに replay 以外の検査が落ちた（記録の整合が壊れている）');
  assert.ok(detected >= Math.floor(chosen.length * 0.8), `判定できた場所が少なすぎる: ${detected}/${chosen.length}`);
});
