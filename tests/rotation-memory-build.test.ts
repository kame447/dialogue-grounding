import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  buildFromFiles, buildRotationMemoryEntries, geometryFromTemplates, partsFromConstrual, positionWord, renderDataModule,
  rotationMemoryDataSha256, wholeFromConsensus,
} from '../docs/review/build-rotation-memory.ts';
import { validateRotationMemoryEntry } from '../dialogue-model/runtime/stimuli/rotation-memory-shape.ts';

// Synthetic inputs in the real file formats: one figure F1, two regions, four rotations.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = any;
const ROTATIONS = [0, 90, 180, 270];
const APEX = ['上', '右', '下', '左']; // clockwise, one step per 90 degrees

function template(rotation: number): Doc {
  const region = (id: string, members: string[], centroid: [number, number], over: Doc = {}) => ({
    id, members, shape: 'square', shapeName: '正方形', sides: 4, convex: true, areaPercent: 50, bbox: [0, 0, 1, 1], outlines: [[[0, 0]]], tipDirection: null,
    description: (centroid[1] < 100 / 3 ? '上' : '下') + '寄りの大きな正方形（全体面積の50%）。',
    construal: { status: 'hypothesis', candidates: ['SENTINEL_OLD'], canonicalCandidates: ['SENTINEL_OLD'] }, centroid,
    contacts: [{ part: id === 'P1' ? 'P2' : 'P1', direction: '下', relation: '辺で接する' }], ...over,
  });
  return {
    key: 'k' + rotation, size: [100, 100], figureId: 'F1', rotation,
    regions: [region('P1', ['1'], [50, 20], { tipDirection: APEX[rotation / 90] }), region('P2', ['2', '2a'], [50, 80], { convex: false })],
    initial: { holistic: [{ construal: 'SENTINEL_OLD_WHOLE', basis: ['x'], status: 'hypothesis' }], analytic: { shapes: [], composition: '', relations: [] }, unknowns: [] },
  };
}
const cand = (rank: number, noun: string, confidence: string) => ({
  rank, noun, posture: '座る', direction: '左向き', confidence, evidence: 'EVIDENCE_TEXT', weaknesses: 'WEAKNESS_TEXT',
  parts: [{ id: 'P1', role: '頭', evidence: 'e1' }, { id: 'P2', role: '胴', evidence: 'e2' }],
});
function wholeDoc(): Doc {
  return { schemaVersion: 'tangram_orientation_construal_consensus_v1', catalogRevision: 'rev', status: 'AI案（研究者の確認前）',
    orientations: ROTATIONS.map(r => ({ id: `F1@${r}`, agreementStatus: '合意', noConstrual: r !== 90, candidates: r === 90 ? [cand(1, 'ウサギ', '低'), cand(2, '猫', '中')] : [] })) };
}
function partsDoc(): Doc {
  const entries = ROTATIONS.flatMap(r => ['P1', 'P2'].map(regionId => {
    const adopted = r === 90 && regionId === 'P1'
      ? [{ rank: 1, noun: '耳', owner: '', basis: '両方', confidence: '低', evidence: 'EVIDENCE_TEXT', weaknesses: '' },
        { rank: 2, noun: '屋根', owner: '家', basis: '単独', confidence: '中', evidence: 'EVIDENCE_TEXT', weaknesses: '' }]
      : [];
    const disagreed = r === 0 && regionId === 'P2';
    return { id: `F1@${r}#${regionId}`, figureId: 'F1', rotation: r, regionId, members: regionId === 'P1' ? ['1'] : ['2', '2a'], candidates: adopted,
      noCandidate: adopted.length === 0, agreementStatus: disagreed ? '未合意' : '合意' };
  }));
  return { schemaVersion: 'tangram_independent_part_construal_v1', catalogRevision: 'rev', status: 'AI案（研究者の確認前）', entries };
}
type Inputs = { templates: Doc[]; whole: Doc; parts: Doc };
const inputs = (): Inputs => ({ templates: ROTATIONS.map(template), whole: wholeDoc(), parts: partsDoc() });
const build = ({ templates, whole, parts }: Inputs) =>
  buildRotationMemoryEntries(geometryFromTemplates(templates), wholeFromConsensus(whole).rows, partsFromConstrual(parts).rows);

test('build: one figure is bundled from geometry, adopted whole candidates and adopted part candidates only', () => {
  const { entries, stats } = build(inputs());
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.deepEqual(validateRotationMemoryEntry(entry), entry);
  assert.deepEqual(entry.regions, [
    { id: 'P1', members: ['1'], shapeName: '正方形', sides: 4, areaPercent: 50, adjacent: ['P2'] },
    { id: 'P2', members: ['2', '2a'], shapeName: '正方形', sides: 4, areaPercent: 50, concave: true, adjacent: ['P1'] },
  ]);
  assert.deepEqual(entry.views[90].whole.map(c => [c.rank, c.noun, c.confidence, c.parts]), [
    [1, 'ウサギ', '低', [{ id: 'P1', role: '頭' }, { id: 'P2', role: '胴' }]], [2, '猫', '中', [{ id: 'P1', role: '頭' }, { id: 'P2', role: '胴' }]],
  ]);
  assert.deepEqual(entry.views[90].parts, [{ id: 'P1', candidates: [{ noun: '耳', confidence: '低' }, { noun: '屋根', confidence: '中', owner: '家' }] }]);
  assert.deepEqual(entry.views[0].whole, []);
  assert.deepEqual(entry.views[0].parts, [], 'no adopted candidate and a region without agreement both give no entry');
  assert.deepEqual(entry.views[180].layout, [{ id: 'P1', at: '上寄り', tipDirection: '下' }, { id: 'P2', at: '下寄り', tipDirection: null }]);
  assert.ok(ROTATIONS.every(r => entry.views[r as 0 | 90 | 180 | 270].reviewStatus === 'ai_unreviewed'));
  assert.deepEqual(stats, { figures: 1, views: 4, wholeViews: 1, noWholeViews: 3, wholeCandidates: 2, regionViews: 8, partRegionViews: 1, noPartRegionViews: 7, partCandidates: 2, disagreedRegionViews: 1 });
  const text = JSON.stringify(entries);
  for (const left of ['SENTINEL_OLD', 'EVIDENCE_TEXT', 'WEAKNESS_TEXT', 'evidence', 'weakness', 'basis', 'discussion']) assert.ok(!text.includes(left), left);
});

test('build: older construal fields of a geometry template are never read', () => {
  const geometry = geometryFromTemplates(inputs().templates);
  assert.ok(!JSON.stringify(geometry).includes('SENTINEL_OLD'));
  assert.deepEqual(Object.keys(geometry[0].regions[0]).sort(), ['areaPercent', 'centroid', 'contacts', 'convex', 'description', 'id', 'members', 'shapeName', 'sides', 'tipDirection']);
  assert.throws(() => geometryFromTemplates([{ ...template(0), size: [1, 2, 3] }]), /size/u);
  assert.throws(() => geometryFromTemplates([{ ...template(0), rotation: 45 }]), /rotation/u);
  assert.throws(() => geometryFromTemplates('nope'), /array/u);
});

test('build: inconsistent sources are refused instead of repaired', () => {
  const refuse = (message: RegExp, edit: (i: Inputs) => void) => { const i = inputs(); edit(i); assert.throws(() => build(i), message); };
  refuse(/role for each region/u, i => { i.whole.orientations[1].candidates[0].parts.pop(); });
  refuse(/ranks must be 1\.\.n/u, i => { i.whole.orientations[1].candidates[1].rank = 3; });
  refuse(/noConstrual must match/u, i => { i.whole.orientations[0].noConstrual = false; });
  refuse(/no whole-construal row/u, i => { i.whole.orientations.pop(); });
  refuse(/outside the confirmed catalog/u, i => { i.whole.orientations.push({ ...i.whole.orientations[0], id: 'F9@0' }); });
  refuse(/duplicate/u, i => { i.whole.orientations[1].id = 'F1@0'; });
  refuse(/members differ/u, i => { i.parts.entries[0].members = ['9']; });
  refuse(/no part-construal row/u, i => { i.parts.entries.pop(); });
  refuse(/outside the confirmed catalog/u, i => { i.parts.entries.push({ ...i.parts.entries[0], id: 'F1@0#P7', regionId: 'P7' }); });
  refuse(/noCandidate must match/u, i => { i.parts.entries[0].noCandidate = false; });
  refuse(/未合意 regions must carry no adopted candidate/u, i => { i.parts.entries[2].agreementStatus = '未合意'; i.parts.entries[2].noCandidate = false; i.parts.entries[2].candidates = [{ rank: 1, noun: '耳', owner: '', confidence: '低' }]; });
  refuse(/clockwise/u, i => { i.templates[1].regions[0].tipDirection = '左'; });
  refuse(/position word/u, i => { i.templates[0].regions[0].description = '下寄りの大きな正方形。'; });
  refuse(/differ from the rotation 0 view/u, i => { i.templates[2].regions[1].areaPercent = 49; });
  refuse(/all four rotations/u, i => { i.templates.pop(); });
  refuse(/confidence must be/u, i => { i.whole.orientations[1].candidates[0].confidence = '最高'; });
  assert.throws(() => wholeFromConsensus({ ...wholeDoc(), schemaVersion: 'other' }), /schemaVersion/u);
  assert.throws(() => partsFromConstrual({ ...partsDoc(), schemaVersion: 'other' }), /schemaVersion/u);
});

test('build: position words are thirds of the figure box', () => {
  const box: [number, number] = [90, 90];
  assert.equal(positionWord([45, 45], box), '中央付近');
  assert.equal(positionWord([30, 30], box), '中央付近', 'a third exactly is the middle');
  assert.equal(positionWord([60, 60], box), '中央付近');
  assert.equal(positionWord([10, 10], box), '左上寄り');
  assert.equal(positionWord([80, 80], box), '右下寄り');
  assert.equal(positionWord([45, 10], box), '上寄り');
  assert.equal(positionWord([10, 45], box), '左寄り');
  assert.equal(positionWord([80, 10], box), '右上寄り');
  assert.equal(positionWord([10, 80], box), '左下寄り');
  assert.equal(positionWord([45, 80], box), '下寄り');
  assert.equal(positionWord([80, 45], box), '右寄り');
});

test('build: the data module and its hash are deterministic and any content change is a new hash', () => {
  const { entries } = build(inputs());
  const sources = { geometry: { path: 'a', sha256: '1'.repeat(64) }, whole: { path: 'b', sha256: '2'.repeat(64) }, parts: { path: 'c', sha256: '3'.repeat(64) } };
  const first = renderDataModule(entries, sources, 'review-final-0000000000000000');
  const second = renderDataModule(structuredClone(entries), sources, 'review-final-0000000000000000');
  assert.equal(first.text, second.text);
  assert.equal(first.dataSha256, createHash('sha256').update(JSON.stringify({ version: 'tangram_rotation_memory_v1', catalogRevision: 'review-final-0000000000000000', entries })).digest('hex'));
  assert.equal(first.dataSha256, rotationMemoryDataSha256(entries, 'review-final-0000000000000000'));
  assert.match(first.text, /^\/\/ Generated by docs\/review\/build-rotation-memory\.ts/u);
  assert.ok(first.text.includes(`export const ROTATION_MEMORY_DATA_SHA256 = "${first.dataSha256}"`));
  const changed = structuredClone(entries);
  changed[0].views[90].whole[0].noun = '犬';
  assert.notEqual(rotationMemoryDataSha256(changed, 'review-final-0000000000000000'), first.dataSha256);
  assert.notEqual(rotationMemoryDataSha256(entries, 'review-final-0000000000000000', 'tangram_rotation_memory_v2'), first.dataSha256);
  // The source hashes are provenance, not content: they do not move the pin hash.
  assert.equal(renderDataModule(entries, { ...sources, whole: { path: 'b', sha256: '9'.repeat(64) } }, 'review-final-0000000000000000').dataSha256, first.dataSha256);
});

const repoPath = (path: string) => new URL('../' + path, import.meta.url);
const inputsPresent = ['docs/review/construal-consensus-20261128/consensus-120.json', 'docs/review/part-construal-20261128/part-construal-468.json']
  .every(path => existsSync(repoPath(path)));

test('build: the committed data module is exactly what a fresh build of the repository inputs gives', {
  skip: inputsPresent ? false : 'part-construal-468.json is added to the repository by the integration branch; run build-rotation-memory.ts --check then',
}, async () => {
  const fresh = await buildFromFiles({
    geometry: repoPath('dialogue-model/runtime/stimuli/primary-regions-data.ts').pathname, whole: repoPath('docs/review/construal-consensus-20261128/consensus-120.json').pathname,
    parts: repoPath('docs/review/part-construal-20261128/part-construal-468.json').pathname, review: repoPath('docs/review/review-results-final.json').pathname,
  });
  assert.equal(readFileSync(repoPath('dialogue-model/runtime/stimuli/rotation-memory-data.ts'), 'utf8'), fresh.text);
  assert.deepEqual([fresh.stats.figures, fresh.stats.views, fresh.stats.regionViews], [30, 120, 468]);
});
