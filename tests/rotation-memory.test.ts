import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { FIGURE_BANK } from '../dialogue-model/runtime/stimuli/figure-bank.ts';
import { transformPolygon } from '../dialogue-model/runtime/stimuli/geometry.mjs';
import { PRIMARY_REGION_TEMPLATES } from '../dialogue-model/runtime/stimuli/primary-regions-data.ts';
import {
  ABSOLUTE_ROTATIONS, RELATIVE_ROTATIONS, ROTATION_MEMORY_CATALOG_REVISION, ROTATION_MEMORY_DATA_SHA256, ROTATION_MEMORY_VERSION,
  projectOwnRotationMemory, projectRotationMemoryEntry, rotationFeatureCandidates, rotationMemoryEntry, rotationMemoryPin, rotationNameCandidates,
  rotationSourceValue, validateOwnRotationMemory, validateRotationMemoryBundle, validateRotationMemoryEntry, validateRotationMemoryPin,
  type AbsoluteRotation, type OwnRotationMemory, type OwnRotationView, type RotationMemoryEntry,
} from '../dialogue-model/runtime/stimuli/rotation-memory.ts';
import { ROTATION_MEMORY_ENTRIES, ROTATION_MEMORY_SOURCES } from '../dialogue-model/runtime/stimuli/rotation-memory-data.ts';

// The bundle under test is the AI proposal v1 (consensus-120 and part-construal-468), not yet confirmed by the researcher.
// Content assertions below that name figures state facts of that proposal; regenerating from a confirmed export means
// updating them on purpose. Structural assertions (relative rotation, symmetry, privacy) hold for any bundle.

type Template = {
  key: string; size: [number, number]; figureId: string; rotation: number;
  regions: { id: string; members: string[]; tipDirection: string | null; description: string; construal: { candidates: string[]; canonicalCandidates: string[] } }[];
  initial: { holistic: { construal: string }[] };
};
const templates = PRIMARY_REGION_TEMPLATES as unknown as Template[];
const entry = (key: string): RotationMemoryEntry => rotationMemoryEntry(key) ?? assert.fail('no bundle entry for ' + key);
const project = (key: string, rotation: number): OwnRotationMemory => projectOwnRotationMemory({ figureKey: key, rotation }) ?? assert.fail('no projection for ' + key);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const nounsOf = (view: OwnRotationView) => ({ whole: view.whole.map(c => c.noun), parts: Object.entries(view.parts).map(([id, list]) => [id, list.map(c => c.noun)]) });
const nounsOfRecord = (view: RotationMemoryEntry['views'][AbsoluteRotation]) =>
  ({ whole: view.whole.map(c => c.noun), parts: view.parts.map(p => [p.id, p.candidates.map(c => c.noun)]) });
const allProjections = () => ROTATION_MEMORY_ENTRIES.flatMap(e => ABSOLUTE_ROTATIONS.map(rotation => ({ key: e.figureKey, rotation, memory: project(e.figureKey, rotation) })));

// ---- bundle data ----

test('bundle: version, hash, catalog revision and provenance are consistent and the bundle validates', () => {
  const hash = createHash('sha256').update(JSON.stringify({ version: ROTATION_MEMORY_VERSION, catalogRevision: ROTATION_MEMORY_CATALOG_REVISION, entries: ROTATION_MEMORY_ENTRIES })).digest('hex');
  assert.equal(hash, ROTATION_MEMORY_DATA_SHA256);
  assert.deepEqual(rotationMemoryPin(), { version: 'tangram_rotation_memory_v1', dataSha256: hash, catalogRevision: 'review-final-dae9359580d64a83' });
  assert.deepEqual(Object.keys(rotationMemoryPin()), ['version', 'dataSha256', 'catalogRevision']);
  assert.deepEqual(validateRotationMemoryPin(rotationMemoryPin()), rotationMemoryPin());
  assert.equal(validateRotationMemoryBundle(ROTATION_MEMORY_ENTRIES).length, 30);
  assert.deepEqual(validateRotationMemoryBundle(clone(ROTATION_MEMORY_ENTRIES)), clone(ROTATION_MEMORY_ENTRIES));
  // Provenance is either the two AI proposal files or the review page's export; each input is recorded with its SHA-256.
  const sources = ROTATION_MEMORY_SOURCES;
  assert.equal(sources.geometry.catalogRevision, ROTATION_MEMORY_CATALOG_REVISION);
  assert.ok(Object.values(sources).every(source => /^[a-f0-9]{64}$/u.test(String(source.sha256))));
  if (sources.export) assert.equal(sources.export.wholeConstrualSchemaVersion, 'tangram_whole_construal_review_v1');
  else for (const source of [sources.whole, sources.parts]) assert.match(String(source.status), /研究者の確認前/u);
  assert.throws(() => validateRotationMemoryPin({ ...rotationMemoryPin(), extra: 1 }), TypeError);
  assert.throws(() => validateRotationMemoryPin({ ...rotationMemoryPin(), dataSha256: 'abc' }), TypeError);
});

test('bundle: 30 figures, 120 views and 468 region views are covered; counts of the AI proposal v1', () => {
  assert.deepEqual(ROTATION_MEMORY_ENTRIES.map(e => e.figureKey).sort(), FIGURE_BANK.map(f => f.id).sort());
  const views = ROTATION_MEMORY_ENTRIES.flatMap(e => ABSOLUTE_ROTATIONS.map(r => ({ e, v: e.views[r] })));
  assert.equal(ROTATION_MEMORY_ENTRIES.reduce((n, e) => n + e.regions.length, 0), 117);
  assert.equal(views.length, 120);
  assert.equal(views.reduce((n, { e }) => n + e.regions.length, 0), 468);
  assert.equal(views.filter(({ v }) => v.whole.length > 0).length, 80);
  assert.equal(views.filter(({ v }) => v.whole.length === 0).length, 40);
  assert.equal(views.reduce((n, { v }) => n + v.whole.length, 0), 99);
  assert.equal(views.reduce((n, { v }) => n + v.parts.length, 0), 306);
  const partCandidates = views.flatMap(({ v }) => v.parts.flatMap(p => p.candidates));
  assert.equal(partCandidates.length, 388);
  assert.deepEqual([partCandidates.filter(c => c.confidence === '低').length, partCandidates.filter(c => c.confidence === '中').length], [369, 19]);
  assert.ok(views.every(({ v }) => v.reviewStatus === 'ai_unreviewed'));
  // Every whole candidate gives a role to every region of its view; every region of every view exists in all four views.
  for (const { e, v } of views) for (const c of v.whole) assert.deepEqual(c.parts.map(p => p.id), e.regions.map(r => r.id));
  // members are strings (split atoms such as "2a"/"2b" exist in eight figures)
  assert.ok(ROTATION_MEMORY_ENTRIES.every(e => e.regions.every(r => r.members.every(m => typeof m === 'string'))));
  assert.equal(ROTATION_MEMORY_ENTRIES.filter(e => e.regions.some(r => r.members.some(m => !/^\d+$/u.test(m)))).length, 8);
});

test('geometry: a bank rotation is a clockwise turn, and region IDs, members, positions and apexes agree in all four views', () => {
  const round = (n: number) => Math.round(n * 1e6) / 1e6 || 0;
  const pointKey = ([x, y]: number[]) => [Math.round(x * 1e6), Math.round(y * 1e6)].join(',');
  const bankKey = (figureId: string, rotation: number): string => {
    const figure = FIGURE_BANK.find(f => f.id === figureId)!;
    const rotated: number[][][] = figure.pieces.map(p => transformPolygon(p.points, { rotation }));
    const all = rotated.flat(), xs = all.map(p => p[0]), ys = all.map(p => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, h = Math.max(...ys) - y;
    return rotated.map(p => p.map(([a, b]) => pointKey([(a - x) / w, (b - y) / h])).sort().join(';')).join('|') + '@' + round(h / w);
  };
  const turns = ['右', '右下', '下', '左下', '左', '左上', '上', '右上'];
  let counterClockwiseMatches = 0;
  assert.equal(templates.length, 120);
  for (const t of templates) {
    assert.equal(bankKey(t.figureId, t.rotation), t.key, `${t.figureId}@${t.rotation} is the bank figure turned clockwise`);
    if (bankKey(t.figureId, (360 - t.rotation) % 360) === t.key) counterClockwiseMatches++;
    const e = entry(t.figureId), view = e.views[t.rotation as AbsoluteRotation];
    assert.deepEqual(e.regions.map(r => [r.id, r.members]), t.regions.map(r => [r.id, r.members]));
    assert.deepEqual(view.layout.map(l => l.id), t.regions.map(r => r.id));
    for (const [i, region] of t.regions.entries()) {
      assert.ok(region.description.startsWith(view.layout[i].at + 'の'), `${t.figureId}@${t.rotation}${region.id} position word`);
      assert.equal(view.layout[i].tipDirection, region.tipDirection);
      if (region.tipDirection !== null) {
        const apex = turns.indexOf(region.tipDirection) - turns.indexOf(entry(t.figureId).views[0].layout[i].tipDirection!);
        assert.equal(((apex % 8) + 8) % 8, t.rotation / 45, 'an apex moves r/45 steps clockwise');
      }
    }
  }
  assert.equal(counterClockwiseMatches, 60, 'only the 0 and 180 degree views are the same turned the other way round');
});

test('old template construals never reach the bundle', () => {
  const text = JSON.stringify(ROTATION_MEMORY_ENTRIES);
  assert.doesNotMatch(text, /のようにも見える/u);
  const generic = new Set(templates.flatMap(t => t.regions.flatMap(r => [...r.construal.candidates, ...r.construal.canonicalCandidates])).filter(s => s.includes('や')));
  assert.ok(generic.size > 0);
  for (const phrase of generic) assert.ok(!text.includes(phrase), `old generic construal "${phrase}"`);
  const f6 = templates.find(t => t.figureId === 'F6' && t.rotation === 0)!;
  assert.ok(f6.initial.holistic.length > 0);
  for (const h of f6.initial.holistic) assert.ok(!text.includes(h.construal), 'the old F6@0 whole construal');
  assert.deepEqual(nounsOf(project('F6', 0).current), { whole: [], parts: [] });
  // F15@270 P3: the old "翼や尖った突起" is not offered; the adopted view keeps its own candidates.
  const old = templates.find(t => t.figureId === 'F15' && t.rotation === 270)!.regions.find(r => r.id === 'P3')!;
  assert.ok(old.construal.candidates.includes('翼や尖った突起'));
  assert.ok(!('P3' in project('F15', 270).current.parts));
});

// ---- projection ----

test('projection: every relative view is the absolute view that many degrees clockwise, for all 120 current views', () => {
  for (const e of ROTATION_MEMORY_ENTRIES) for (const current of ABSOLUTE_ROTATIONS) {
    const p = project(e.figureKey, current);
    assert.deepEqual(nounsOf(p.current), nounsOfRecord(e.views[current]));
    assert.deepEqual(p.turned.map(t => t.rel), [90, 180, 270]);
    for (const t of p.turned) assert.deepEqual(nounsOf(t), nounsOfRecord(e.views[((current + t.rel) % 360) as AbsoluteRotation]));
    assert.equal(p.wholeAnywhere, ABSOLUTE_ROTATIONS.some(r => e.views[r].whole.length > 0));
    // Turning the shown view by rel gives the same view content as showing that rotation directly.
    for (const t of p.turned) {
      const shown = project(e.figureKey, current + t.rel);
      assert.deepEqual({ whole: t.whole, parts: t.parts }, shown.current);
    }
  }
});

test('projection: current view without candidates still offers the other views (independent audit fixtures)', () => {
  const f6 = project('F6', 0);
  assert.deepEqual(nounsOf(f6.current), { whole: [], parts: [] });
  assert.deepEqual(f6.turned.map(t => t.whole.map(c => c.noun)), [[], ['ウサギ'], ['ニワトリ', '馬']]);
  assert.deepEqual(Object.keys(f6.turned[0].parts), ['P1', 'P2', 'P4']);
  assert.equal(f6.wholeAnywhere, true);
  const f9 = project('F9', 90);
  assert.deepEqual(nounsOf(f9.current), { whole: [], parts: [] });
  assert.deepEqual(f9.turned.map(t => t.whole.map(c => c.noun)), [[], [], ['ハト']]);
  assert.equal(Object.keys(f9.turned[0].parts).length, 3);
  assert.equal(Object.keys(f9.turned[1].parts).length, 2);
  const f1 = project('F1', 270);
  assert.deepEqual(f1.current.whole.map(c => c.noun), ['カモ']);
  assert.deepEqual(f1.turned.map(t => t.whole.map(c => c.noun)), [['タツノオトシゴ'], ['ティーポット', 'リス'], ['ペンギン']]);
  assert.deepEqual(rotationNameCandidates(f1), ['カモ', 'タツノオトシゴ', 'ティーポット', 'リス', 'ペンギン']);
});

test('projection: regions that were not agreed carry no candidate and do not erase the rest of their view', () => {
  assert.ok(!entry('F5').views[0].parts.some(p => p.id === 'P2'));
  assert.ok(!entry('F6').views[0].parts.some(p => p.id === 'P4'));
  const f15 = entry('F15').views[270];
  assert.ok(!f15.parts.some(p => p.id === 'P3'));
  assert.deepEqual(f15.whole.map(c => c.noun).sort(), ['キツネ', '猫']);
  assert.equal(f15.parts.length, 3);
  const turned = project('F15', 0).turned.find(t => t.rel === 270)!;
  assert.ok(!('P3' in turned.parts));
  assert.equal(turned.whole.length, 2);
});

function synthetic(wholeAt: readonly AbsoluteRotation[]): RotationMemoryEntry {
  const view = (rotation: AbsoluteRotation): RotationMemoryEntry['views'][AbsoluteRotation] => ({
    layout: [{ id: 'P1', at: '上寄り', tipDirection: null }, { id: 'P2', at: '下寄り', tipDirection: '上' }],
    whole: wholeAt.includes(rotation) ? [{ rank: 1, noun: `見立て${rotation}`, posture: '立つ', direction: '右向き', confidence: '低', parts: [{ id: 'P1', role: '頭' }, { id: 'P2', role: '胴' }] }] : [],
    parts: [{ id: 'P1', candidates: [{ noun: `部分${rotation}`, confidence: rotation === 90 ? '中' : '低', owner: '物' }] }],
    reviewStatus: 'ai_unreviewed',
  });
  return validateRotationMemoryEntry({
    figureKey: 'S1',
    regions: [{ id: 'P1', members: ['1'], shapeName: '正方形', sides: 4, areaPercent: 50, adjacent: ['P2'] }, { id: 'P2', members: ['2', '2a'], shapeName: '台形', sides: 4, areaPercent: 50, concave: true, adjacent: ['P1'] }],
    views: { 0: view(0), 90: view(90), 180: view(180), 270: view(270) },
  });
}

test('projection: no whole construal in any view is different from none in the current view, and parts survive', () => {
  const none = projectRotationMemoryEntry(synthetic([]), 90);
  assert.equal(none.wholeAnywhere, false);
  assert.deepEqual(none.current.whole, []);
  assert.ok(none.turned.every(t => t.whole.length === 0));
  assert.deepEqual([none.current, ...none.turned].map(v => v.parts.P1[0].noun), ['部分90', '部分180', '部分270', '部分0']);
  assert.deepEqual(rotationNameCandidates(none), []);
  assert.deepEqual(validateOwnRotationMemory(clone(none)), none);
  const only = projectRotationMemoryEntry(synthetic([180]), 0);
  assert.equal(only.wholeAnywhere, true);
  assert.deepEqual(only.current.whole, []);
  assert.deepEqual(only.turned.map(t => t.whole.map(c => c.noun)), [[], ['見立て180'], []]);
  assert.deepEqual(only.turned[1].whole[0].roles, { P1: '頭', P2: '胴' });
  // confidence 低 is omitted, 中 is written; concave and apex are carried by the region
  assert.equal(only.current.parts.P1[0].confidence, undefined);
  assert.equal(only.turned[0].parts.P1[0].confidence, '中');
  assert.deepEqual(only.regions.map(r => [r.concave, r.tip]), [[undefined, undefined], [true, '上']]);
});

test('projection: nothing about the bank, absolute rotation, rotation mode or the partner is present', () => {
  const allowed = new Set(['regions', 'current', 'turned', 'wholeAnywhere', 'id', 'shapeName', 'areaPercent', 'at', 'tip', 'concave', 'adjacent', 'whole', 'parts', 'rel', 'noun', 'posture', 'direction', 'confidence', 'roles', 'owner']);
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === 'object') for (const [key, inner] of Object.entries(value)) {
      assert.ok(allowed.has(key) || /^P[1-9][0-9]?$/u.test(key), `unexpected key ${key}`);
      walk(inner);
    }
  };
  for (const { memory } of allProjections()) walk(memory);
  const joined = JSON.stringify(allProjections().map(p => p.memory));
  for (const forbidden of ['figureKey', 'figureId', 'rotationMode', 'relative_', 'bank', 'angle', 'members', 'reviewStatus', 'evidence', 'weakness', 'rank']) assert.ok(!joined.includes(forbidden), forbidden);
  assert.ok(strings.length > 1000);
  for (const s of strings) {
    assert.doesNotMatch(s, /(^|[^A-Za-z0-9])F\d+([^0-9]|$)/u, `figure ID in "${s}"`);
    assert.doesNotMatch(s, /(?:^|\D)(?:0|45|90|135|180|225|270|315)\s*(?:度|°)/u, `angle in "${s}"`);
    assert.doesNotMatch(s, /相手|人間側|回転|ひっくり返/u, `partner or rotation wording in "${s}"`);
  }
  // Numbers: only area ratios and the relative turn.
  const numbers = new Set<string>();
  JSON.stringify(allProjections().map(p => p.memory), (key, value) => { if (typeof value === 'number') numbers.add(key); return value; });
  assert.deepEqual([...numbers].sort(), ['areaPercent', 'rel']);
});

test('projection: the four views are given symmetrically', () => {
  for (const { memory } of allProjections()) {
    assert.deepEqual(Object.keys(memory), ['regions', 'current', 'turned', 'wholeAnywhere']);
    assert.deepEqual(Object.keys(memory.current), ['whole', 'parts']);
    for (const t of memory.turned) assert.deepEqual(Object.keys(t), ['rel', 'whole', 'parts']);
    for (const view of [memory.current, ...memory.turned]) for (const c of view.whole) {
      assert.deepEqual(Object.keys(c).filter(k => k !== 'confidence'), ['noun', 'posture', 'direction', 'roles']);
      assert.deepEqual(Object.keys(c.roles), memory.regions.map(r => r.id), 'a role for every region');
    }
  }
});

test('projection: equal input gives equal bytes, a fresh object each time, and the bundle is not exposed to mutation', () => {
  const forward = allProjections().map(p => JSON.stringify(p.memory));
  const backward = [...allProjections().map(p => ({ ...p }))].reverse().map(p => JSON.stringify(project(p.key, p.rotation))).reverse();
  assert.deepEqual(forward, backward);
  const a = project('F1', 270), b = project('F1', 270);
  assert.notEqual(a, b);
  a.current.whole[0].noun = '改変'; a.regions[0].adjacent.push('P9'); a.turned.pop();
  assert.equal(JSON.stringify(project('F1', 270)), JSON.stringify(b));
  assert.ok(Object.isFrozen(entry('F1')) && Object.isFrozen(entry('F1').views[0]) && Object.isFrozen(entry('F1').views[0].whole));
  assert.throws(() => { (entry('F1') as { figureKey: string }).figureKey = 'F2'; }, TypeError);
});

test('projection: input edges — unknown figures give nothing, other rotations are rejected or normalised', () => {
  assert.equal(projectOwnRotationMemory({ figureKey: 'F99', rotation: 0 }), undefined);
  assert.equal(projectOwnRotationMemory({ figureKey: '', rotation: 90 }), undefined);
  assert.equal(rotationMemoryEntry('F99'), undefined);
  for (const bad of [45, 91, 1.5, NaN, Infinity, '90', null, undefined]) assert.throws(() => projectOwnRotationMemory({ figureKey: 'F1', rotation: bad as number }), TypeError);
  assert.deepEqual(project('F1', 360), project('F1', 0));
  assert.deepEqual(project('F1', -90), project('F1', 270));
  assert.deepEqual(project('F1', 450), project('F1', 90));
});

// ---- validation and readers ----

test('validateOwnRotationMemory accepts every projection after a JSON round trip and rejects altered shapes', () => {
  for (const { memory } of allProjections()) assert.deepEqual(validateOwnRotationMemory(clone(memory)), memory);
  const base = project('F1', 270);
  const withEdit = (edit: (m: OwnRotationMemory) => unknown) => () => validateOwnRotationMemory(edit(clone(base)));
  const cases: [string, (m: OwnRotationMemory) => unknown][] = [
    ['extra top key', m => ({ ...m, extra: 1 })],
    ['turned order', m => ({ ...m, turned: [m.turned[1], m.turned[0], m.turned[2]] })],
    ['turned count', m => ({ ...m, turned: m.turned.slice(0, 2) })],
    ['rel value', m => { (m.turned[0] as { rel: number }).rel = 45; return m; }],
    ['wholeAnywhere', m => ({ ...m, wholeAnywhere: false })],
    ['unknown region in roles', m => { m.turned[0].whole[0].roles.P9 = '頭'; return m; }],
    ['missing roles', m => { delete (m.current.whole[0] as { roles?: unknown }).roles; return m; }],
    ['explicit low confidence', m => { (m.current.whole[0] as { confidence?: string }).confidence = '低'; return m; }],
    ['bad confidence', m => { (m.current.whole[0] as { confidence?: string }).confidence = '最高'; return m; }],
    ['duplicate region id', m => { m.regions[1].id = 'P1'; return m; }],
    ['adjacent to unknown', m => { m.regions[0].adjacent = ['P9']; return m; }],
    ['unknown position word', m => { (m.regions[0] as { at: string }).at = '真上'; return m; }],
    ['too many part candidates', m => { m.current.parts.P1 = [...Array(4)].map(() => ({ noun: '耳' })); return m; }],
    ['empty noun', m => { m.current.whole[0].noun = '  '; return m; }],
    ['image-like text', m => { m.current.whole[0].noun = 'data:image/png;base64,AAAA'; return m; }],
    ['non-plain object', m => Object.assign(Object.create({ inherited: 1 }), m)],
    ['array as object', m => [m]],
    ['own __proto__ key', () => JSON.parse('{"__proto__":{"regions":[]},"regions":[],"current":{},"turned":[],"wholeAnywhere":false}')],
  ];
  for (const [name, edit] of cases) assert.throws(withEdit(edit), TypeError, name);
  assert.throws(() => validateOwnRotationMemory(null), TypeError);
});

test('validateRotationMemoryEntry rejects broken bundle records', () => {
  const base = clone(entry('F1'));
  const broken: [string, (e: RotationMemoryEntry) => unknown][] = [
    ['missing view', e => { delete (e.views as Partial<typeof e.views>)[270]; return e; }],
    ['asymmetric adjacency', e => { e.regions[0].adjacent = ['P2', 'P3']; return e; }],
    ['area does not sum to 100', e => { e.regions[0].areaPercent = 10; return e; }],
    ['whole without a role for each region', e => { e.views[0].whole = [{ rank: 1, noun: '猫', posture: '座る', direction: '右向き', confidence: '低', parts: [{ id: 'P1', role: '頭' }] }]; return e; }],
    ['rank gap', e => { e.views[90].whole = [{ rank: 2, noun: '猫', posture: '座る', direction: '右向き', confidence: '低', parts: e.regions.map(r => ({ id: r.id, role: '体' })) }]; return e; }],
    ['unknown review status', e => { (e.views[0] as { reviewStatus: string }).reviewStatus = 'confirmed'; return e; }],
    ['members not strings', e => { (e.regions[0] as { members: unknown }).members = [1]; return e; }],
  ];
  for (const [name, edit] of broken) assert.throws(() => validateRotationMemoryEntry(edit(clone(base))), TypeError, name);
  assert.throws(() => validateRotationMemoryBundle([base, base]), TypeError);
});

test('readers: rotationSourceValue, rotationNameCandidates and rotationFeatureCandidates', () => {
  const p = project('F1', 270);
  assert.equal(rotationSourceValue(p, ['current', 'whole', 0, 'noun']), 'カモ');
  assert.equal(rotationSourceValue(p, ['turned', 0, 'whole', 0, 'noun']), 'タツノオトシゴ');
  assert.equal(rotationSourceValue(p, ['turned', 0, 'whole', 0, 'roles', 'P1']), p.turned[0].whole[0].roles.P1);
  assert.equal(rotationSourceValue(p, ['turned', 1, 'whole', 1, 'noun']), 'リス');
  assert.equal(rotationSourceValue(p, ['regions', 0, 'shapeName']), p.regions[0].shapeName);
  const withParts = p.turned.find(t => Object.keys(t.parts).length)!;
  const [firstId] = Object.keys(withParts.parts);
  assert.equal(rotationSourceValue(p, ['turned', p.turned.indexOf(withParts), 'parts', firstId, 0, 'noun']), withParts.parts[firstId][0].noun);
  for (const path of [['turned', 9], ['current', 'whole', 7, 'noun'], ['current', 'wholeAnywhere'], ['wholeAnywhere'], ['turned', 0, 'rel'], ['__proto__'], ['constructor'], ['current', 'whole', '0', 'noun'], ['current', 'whole', 0.5, 'noun'], []])
    assert.equal(rotationSourceValue(p, path as (string | number)[]), undefined, JSON.stringify(path));
  const features = rotationFeatureCandidates(p);
  assert.ok(features.every(f => f.endsWith('。') && f.length <= 400));
  for (const noun of rotationNameCandidates(p)) assert.ok(features.every(f => !f.includes(noun)), 'features carry no construal word');
});

test('rotationFeatureCandidates: region IDs never appear; regions are called by position, shape and area', () => {
  for (const { memory } of allProjections()) {
    const features = rotationFeatureCandidates(memory);
    assert.ok(features.every(f => !/P\d/u.test(f)), 'an internal region ID in a feature');
    assert.equal(new Set(features).size, features.length, 'each statement once');
    const labels = memory.regions.map(r => `${r.at}の${r.shapeName}（${r.areaPercent}%）`);
    const pairs = memory.regions.reduce((n, r) => n + r.adjacent.length, 0) / 2;
    if (new Set(labels).size === labels.length) assert.equal(features.length, memory.regions.length + pairs);
    else assert.ok(features.length <= memory.regions.length + pairs);
  }
  const first = rotationFeatureCandidates(project('F1', 0));
  assert.match(first[0], /^[^P]*の[^P]*（全体面積の[\d.]+%）/u);
  // Regions that cannot be told apart by position, shape and area get no relation statement and one shape statement.
  const region = (id: string, shapeName: string, areaPercent: number, at: OwnRotationMemory['regions'][number]['at'], adjacent: string[]) => ({ id, shapeName, areaPercent, at, adjacent });
  const emptyView = { whole: [], parts: {} };
  const synthetic: OwnRotationMemory = validateOwnRotationMemory({
    regions: [region('P1', '正方形', 25, '上寄り', ['P2', 'P3']), region('P2', '正方形', 25, '上寄り', ['P1', 'P3']), region('P3', '台形', 50, '下寄り', ['P1', 'P2'])],
    current: emptyView, turned: RELATIVE_ROTATIONS.map(rel => ({ rel, ...emptyView })), wholeAnywhere: false,
  });
  assert.deepEqual(rotationFeatureCandidates(synthetic), ['上寄りの正方形（全体面積の25%）。', '下寄りの台形（全体面積の50%）。']);
  const distinct = validateOwnRotationMemory({
    regions: [{ ...region('P1', '直角二等辺三角形', 12.5, '上寄り', ['P2']), tip: '上' }, { ...region('P2', '五角形', 87.5, '中央付近', ['P1']), concave: true }],
    current: emptyView, turned: RELATIVE_ROTATIONS.map(rel => ({ rel, ...emptyView })), wholeAnywhere: false,
  });
  assert.deepEqual(rotationFeatureCandidates(distinct), [
    '上寄りの直角二等辺三角形（全体面積の12.5%）。頂点は上向き。', '中央付近の五角形（全体面積の87.5%）。輪郭にくぼみがある。',
    '上寄りの直角二等辺三角形（12.5%）と中央付近の五角形（87.5%）は辺で接する。',
  ]);
});

// ---- size guard ----

test('size: the full projection stays inside the provisional budget for 3, 4 and 6 figures (guard; layers are pinned by their owner)', () => {
  // Measured 2026-11-28 on the AI proposal v1: per figure max 2,042 (median 1,323); worst sets 5,549 / 7,220 / 10,519.
  const perFigure = ROTATION_MEMORY_ENTRIES.map(e => Math.max(...ABSOLUTE_ROTATIONS.map(r => JSON.stringify(project(e.figureKey, r)).length))).sort((a, b) => a - b);
  assert.ok(perFigure[perFigure.length - 1] <= 2100, `largest figure ${perFigure[perFigure.length - 1]}`);
  const worst = (n: number) => perFigure.slice(-n).reduce((a, b) => a + b, 0);
  const caps = { 3: 5700, 4: 7400, 6: 10800 };
  for (const n of [3, 4, 6] as const) assert.ok(worst(n) <= caps[n], `${n} figures: ${worst(n)} > ${caps[n]}`);
  // Dense group named by the independent audit: F15, F1, F19, F23, F13, F27.
  const dense = ['F15', 'F1', 'F19', 'F23', 'F13', 'F27'].map(k => Math.max(...ABSOLUTE_ROTATIONS.map(r => JSON.stringify(project(k, r)).length))).reduce((a, b) => a + b, 0);
  assert.ok(dense <= caps[6], `dense six ${dense}`);
  assert.deepEqual(RELATIVE_ROTATIONS, [90, 180, 270]);
});
