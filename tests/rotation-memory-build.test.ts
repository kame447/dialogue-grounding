import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFromExportFile, buildFromFiles, buildRotationMemoryEntries, geometryFromTemplates, partsFromConstrual, positionWord, renderDataModule,
  rotationMemoryDataSha256, sourcesFromReviewExport, wholeFromConsensus,
} from '../docs/review/build-rotation-memory.ts';
import { validateRotationMemoryEntry, ABSOLUTE_ROTATIONS, type RotationMemoryEntry } from '../dialogue-model/runtime/stimuli/rotation-memory-shape.ts';
import { ROTATION_MEMORY_ENTRIES } from '../dialogue-model/runtime/stimuli/rotation-memory-data.ts';

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

// ---- the review page's export (structured whole and part layers) ----

const FREE_TEXT = 'FREE_TEXT_NEVER_PARSED';
function exportDoc(edit: (doc: Doc) => void = () => {}): Doc {
  const whole = wholeDoc().orientations, parts = partsDoc().entries;
  const results = ROTATIONS.map((r, i) => ({
    id: `F1@${r}`, figureId: 'F1', rotation: r, status: '確認済み', whole: FREE_TEXT, wholeBasis: [FREE_TEXT],
    wholeConstrual: { reviewStatus: 'researcher_confirmed', candidates: whole[i].candidates, noConstrual: whole[i].noConstrual, noConstrualReason: '', needsTextCheck: false, ai: { agreementStatus: '合意', discussion: 'd' } },
    parts: ['P1', 'P2'].map(regionId => {
      const row = parts.find((e: Doc) => e.id === `F1@${r}#${regionId}`);
      return { id: regionId, members: row.members, description: FREE_TEXT, candidates: [FREE_TEXT],
        independentPart: { reviewStatus: 'researcher_confirmed', candidates: row.candidates, noCandidate: row.noCandidate, noCandidateReason: '', ai: { agreementStatus: row.agreementStatus, discussion: 'd' } } };
    }),
  }));
  const doc = { schemaVersion: 'tangram_orientation_review_v1', catalogRevision: 'rev', wholeConstrualSchemaVersion: 'tangram_whole_construal_review_v1',
    independentPartSchemaVersion: 'tangram_independent_part_review_v1', revision: 7, results };
  edit(doc);
  return doc;
}
const buildFromExport = (doc: Doc) => {
  const source = sourcesFromReviewExport(doc);
  return { source, ...buildRotationMemoryEntries(geometryFromTemplates(ROTATIONS.map(template)), source.whole, source.parts, source.statuses) };
};

test('export: the structured layers give the same bundle as the proposal files; free text is never read', () => {
  const { source, entries } = buildFromExport(exportDoc());
  const fromProposals = build(inputs()).entries;
  assert.deepEqual(source.unconfirmed, []);
  assert.deepEqual(entries.map(e => ROTATIONS.map(r => e.views[r as 0 | 90 | 180 | 270].reviewStatus)), [['researcher_confirmed', 'researcher_confirmed', 'researcher_confirmed', 'researcher_confirmed']]);
  const withProposalStatus = structuredClone(entries);
  for (const r of ROTATIONS) withProposalStatus[0].views[r as 0 | 90 | 180 | 270].reviewStatus = 'ai_unreviewed';
  assert.deepEqual(withProposalStatus, fromProposals);
  assert.ok(!JSON.stringify(entries).includes(FREE_TEXT));
  assert.deepEqual(source.meta, { catalogRevision: 'rev', schemaVersion: 'tangram_orientation_review_v1', wholeSchemaVersion: 'tangram_whole_construal_review_v1', partSchemaVersion: 'tangram_independent_part_review_v1', rows: 4, revision: 7 });
});

test('export: directions that are not confirmed in every layer are listed, not refused, and never reported as confirmed', () => {
  const { source, entries } = buildFromExport(exportDoc(doc => {
    doc.results[0].status = '要修正';                                                   // F1@0: row not confirmed
    doc.results[0].wholeConstrual.reviewStatus = 'ai_unreviewed';                          // F1@0: no proposal, no decision
    doc.results[0].wholeConstrual.ai = null; doc.results[0].wholeConstrual.noConstrual = false; doc.results[0].wholeConstrual.candidates = [];
    doc.results[1].wholeConstrual.reviewStatus = 'researcher_edited';                      // F1@90: edited by the researcher
    doc.results[1].wholeConstrual.candidates[0].noun = '犬';
    doc.results[2].parts[1].independentPart.reviewStatus = 'ai_unreviewed';                // F1@180: a part still the AI proposal
    doc.results[3].wholeConstrual.needsTextCheck = true;                                   // F1@270: free text differs from the proposal
    doc.results[2].parts[0].independentPart.reviewStatus = 'researcher_edited';            // an AI 未合意 region the researcher decided: accepted
    doc.results[2].parts[0].independentPart.ai.agreementStatus = '未合意';
    doc.results[2].parts[0].independentPart.candidates = [{ rank: 1, noun: '角', owner: '', basis: '単独', confidence: '低', evidence: 'e', weaknesses: '' }]; doc.results[2].parts[0].independentPart.noCandidate = false;
  }));
  const statusOf = (r: number) => entries[0].views[r as 0 | 90 | 180 | 270].reviewStatus;
  assert.deepEqual(ROTATIONS.map(statusOf), ['ai_unreviewed', 'researcher_edited', 'ai_unreviewed', 'researcher_confirmed']);
  assert.deepEqual(source.unconfirmed, [
    { id: 'F1@0', reasons: ['行の状態が要修正', '全体の見立てが未入力'] },
    { id: 'F1@180', reasons: ['P2の部分の見立てがAI案のまま'] },
    { id: 'F1@270', reasons: ['自由文と要照合'] },
  ]);
  assert.deepEqual(entries[0].views[0].whole, [], 'a layer without any decision builds as no candidate');
  assert.deepEqual(entries[0].views[90].whole.map(c => c.noun), ['犬', '猫']);
  assert.deepEqual(entries[0].views[180].parts, [{ id: 'P1', candidates: [{ noun: '角', confidence: '低' }] }]);
});

test('export: foreign or malformed exports are refused', () => {
  const refuse = (message: RegExp, edit: (doc: Doc) => void) => assert.throws(() => sourcesFromReviewExport(exportDoc(edit)), message);
  refuse(/unsupported schemaVersion/u, doc => { doc.schemaVersion = 'other'; });
  refuse(/whole-construal layer/u, doc => { delete doc.wholeConstrualSchemaVersion; });
  refuse(/independent-part layer/u, doc => { doc.independentPartSchemaVersion = 'tangram_independent_part_review_v0'; });
  refuse(/wholeConstrual/u, doc => { delete doc.results[0].wholeConstrual; });
  refuse(/independentPart/u, doc => { delete doc.results[0].parts[0].independentPart; });
  refuse(/unknown reviewStatus/u, doc => { doc.results[0].wholeConstrual.reviewStatus = 'confirmed'; });
  refuse(/unknown row status/u, doc => { doc.results[0].status = 'ok'; });
  refuse(/duplicate/u, doc => { doc.results[1].id = 'F1@0'; });
  refuse(/without a construal cannot carry candidates/u, doc => { doc.results[1].wholeConstrual.noConstrual = true; });
  refuse(/without a candidate cannot carry candidates/u, doc => { doc.results[1].parts[0].independentPart.noCandidate = true; });
  refuse(/未合意 regions must carry no adopted candidate/u, doc => {
    const part = doc.results[1].parts[0].independentPart; part.reviewStatus = 'ai_unreviewed'; part.ai.agreementStatus = '未合意';
  });
  refuse(/boolean/u, doc => { delete doc.results[0].wholeConstrual.needsTextCheck; });
  // A confirmed export of another catalog or with another partition is refused when built.
  const wrongMembers = exportDoc(doc => { doc.results[0].parts[0].members = ['9']; });
  assert.throws(() => buildFromExport(wrongMembers), /members differ/u);
});

// The committed bundle written out as a fully confirmed review export, built again through files and the command line.
function bundleAsExport(entries: readonly RotationMemoryEntry[], edit: (doc: Doc) => void = () => {}): Doc {
  const results = entries.flatMap(e => ABSOLUTE_ROTATIONS.map(r => {
    const v = e.views[r];
    return {
      id: `${e.figureKey}@${r}`, figureId: e.figureKey, rotation: r, status: '確認済み', whole: FREE_TEXT, wholeBasis: [FREE_TEXT],
      wholeConstrual: { reviewStatus: 'researcher_confirmed', noConstrual: v.whole.length === 0, noConstrualReason: '', needsTextCheck: false, ai: { agreementStatus: '合意', discussion: '' },
        candidates: v.whole.map(c => ({ rank: c.rank, noun: c.noun, posture: c.posture, direction: c.direction, confidence: c.confidence, parts: c.parts, evidence: 'e', weaknesses: '' })) },
      parts: e.regions.map(region => {
        const adopted = v.parts.find(p => p.id === region.id)?.candidates ?? [];
        return { id: region.id, members: region.members, description: FREE_TEXT, candidates: [FREE_TEXT],
          independentPart: { reviewStatus: 'researcher_confirmed', noCandidate: adopted.length === 0, noCandidateReason: '', ai: { agreementStatus: '合意', discussion: '' },
            candidates: adopted.map((c, i) => ({ rank: i + 1, noun: c.noun, owner: c.owner ?? '', basis: '両方', confidence: c.confidence, evidence: 'e', weaknesses: '' })) } };
      }),
    };
  }));
  const doc = { schemaVersion: 'tangram_orientation_review_v1', catalogRevision: 'review-final-dae9359580d64a83', wholeConstrualSchemaVersion: 'tangram_whole_construal_review_v1',
    independentPartSchemaVersion: 'tangram_independent_part_review_v1', revision: 42, results };
  edit(doc);
  return doc;
}

test('export: all 120 directions round trip through files and the command line; unconfirmed data cannot be written with --require-confirmed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rotation-memory-export-'));
  try {
    const geometry = fileURLToPath(repoPath('dialogue-model/runtime/stimuli/primary-regions-data.ts'));
    const review = fileURLToPath(repoPath('docs/review/review-results-final.json'));
    const confirmedFile = join(dir, 'confirmed-export.json');
    writeFileSync(confirmedFile, JSON.stringify(bundleAsExport(ROTATION_MEMORY_ENTRIES)));
    const built = await buildFromExportFile({ geometry, export: confirmedFile, review });
    assert.deepEqual(built.unconfirmed, []);
    assert.deepEqual(built.entries.map(e => ({ ...e, views: Object.fromEntries(ABSOLUTE_ROTATIONS.map(r => [r, { ...e.views[r], reviewStatus: 'ai_unreviewed' }])) })), structuredClone(ROTATION_MEMORY_ENTRIES));
    assert.ok(built.entries.every(e => ABSOLUTE_ROTATIONS.every(r => e.views[r].reviewStatus === 'researcher_confirmed')));
    assert.notEqual(built.dataSha256, rotationMemoryDataSha256(ROTATION_MEMORY_ENTRIES, 'review-final-dae9359580d64a83'), 'a confirmed bundle is a different bundle');
    assert.match(built.text, /"export": \{\s+"path": "confirmed-export\.json",\s+"sha256": "[a-f0-9]{64}"/u);
    assert.ok(!built.text.includes(dir), 'no directory of the machine in the data');
    assert.ok(!built.text.includes(FREE_TEXT));

    const run = (...args: string[]) => spawnSync(process.execPath, [fileURLToPath(repoPath('docs/review/build-rotation-memory.ts')), '--regions', geometry, '--review', review, ...args], { encoding: 'utf8' });
    const out = join(dir, 'data.ts');
    const ok = run('--export', confirmedFile, '--require-confirmed', '--out', out);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(readFileSync(out, 'utf8'), built.text);
    assert.equal(run('--export', confirmedFile, '--require-confirmed', '--out', out, '--check').status, 0);

    const pendingFile = join(dir, 'pending-export.json');
    writeFileSync(pendingFile, JSON.stringify(bundleAsExport(ROTATION_MEMORY_ENTRIES, doc => {
      doc.results[0].wholeConstrual.needsTextCheck = true; doc.results[5].parts[0].independentPart.reviewStatus = 'ai_unreviewed'; doc.results[7].status = '未確認';
    })));
    const pendingOut = join(dir, 'pending-data.ts');
    const refused = run('--export', pendingFile, '--require-confirmed', '--out', pendingOut);
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /not confirmed: 3/u);
    assert.match(refused.stdout, /F1@0: 自由文と要照合/u);
    assert.ok(!existsSync(pendingOut), 'nothing is written when a direction is not confirmed');
    const listed = run('--export', pendingFile, '--out', pendingOut);
    assert.equal(listed.status, 0, 'without --require-confirmed the list is a report, not a failure');
    assert.ok(existsSync(pendingOut));
    assert.equal(run('--require-confirmed', '--out', pendingOut).status, 1, 'the proposal files are never confirmed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
