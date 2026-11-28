import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reviewServer } from './review-server-harness.ts';

type Candidate = { noun: string; owner: string; basis: string; confidence: string; evidence: string; weaknesses: string };
type Entry = { id: string; reviewStatus: string; candidates: Candidate[]; noCandidate: boolean; noCandidateReason: string; ai: { agreementStatus: string; discussion: string } | null };
type Layer = { schemaVersion: string; rows: { id: string; parts: Entry[] }[] };
type State = { revision: number; sourceSha256: string; currentId: string; results: any[]; independentParts: Layer };

const candidate = (noun: string, extra: Partial<Candidate> = {}): Candidate => ({ noun, owner: '動物', basis: '両方', confidence: '低', evidence: '形の根拠', weaknesses: '', ...extra });
// A save as the page sends it. Set independentParts to undefined for the save of a page that predates the layer.
const save = (s: State, patch: Record<string, unknown> = {}) => ({ revision: s.revision, sourceSha256: s.sourceSha256, currentId: s.currentId, results: s.results, independentParts: s.independentParts, ...patch });
const withoutLayer = ({ independentParts, wholeConstruals, ...rest }: State & { wholeConstruals?: unknown }) => rest;

test('a state file from before the independent layer loads unchanged, gains an empty layer in memory only, and keeps the layer across an old-style save', async () => {
  const a = await reviewServer(), b = await reviewServer(), c = await reviewServer();
  try {
    await a.start();
    let s = await a.get('/api/state') as State;
    const rows = structuredClone(s.results);
    rows[0].status = '確認済み'; rows[1].whole = '研究者の見立て'; rows[2].note = 'メモ'; rows[3].parts[0].description = '研究者の説明'; rows[4].status = '要修正';
    s = await a.post('/api/state', save(s, { currentId: 'F2@90', results: rows, independentParts: undefined }));
    const legacy = JSON.parse(readFileSync(a.statePath, 'utf8')); delete legacy.independentParts; delete legacy.wholeConstruals;
    assert.equal(legacy.revision, s.revision);
    const text = JSON.stringify(legacy, null, 2) + '\n';
    writeFileSync(b.statePath, text);
    await b.start();
    const loaded = await b.get('/api/state') as State;
    assert.deepEqual(withoutLayer(loaded), withoutLayer(s));
    assert.equal(loaded.independentParts.rows.flatMap(r => r.parts).length, 468);
    assert.ok(loaded.independentParts.rows.flatMap(r => r.parts).every(p => p.ai === null && p.reviewStatus === 'ai_unreviewed' && !p.candidates.length && !p.noCandidate && p.noCandidateReason === ''));
    assert.equal(readFileSync(b.statePath, 'utf8'), text, 'starting must not rewrite the old file');
    // The save of a page that predates the layer changes the rows only; the file then carries the layer.
    const rows2 = structuredClone(loaded.results); rows2[5].status = '要修正';
    const after = await b.post('/api/state', save(loaded, { results: rows2, independentParts: undefined })) as State;
    assert.equal(after.revision, loaded.revision + 1);
    assert.deepEqual(after.independentParts, loaded.independentParts);
    assert.deepEqual(JSON.parse(readFileSync(b.statePath, 'utf8')).independentParts, loaded.independentParts);
    assert.equal(JSON.parse(readFileSync(join(b.dir, 'review-state.previous.json'), 'utf8')).revision, loaded.revision);

    // A damaged layer is never replaced by an empty one: the server refuses to start and leaves the file alone.
    const damaged = JSON.stringify({ ...JSON.parse(readFileSync(a.statePath, 'utf8')), independentParts: { schemaVersion: 'bad', rows: [] } }, null, 2) + '\n';
    writeFileSync(c.statePath, damaged);
    await assert.rejects(c.start(), /独立部分/);
    assert.equal(readFileSync(c.statePath, 'utf8'), damaged);
  } finally { await a.close(); await b.close(); await c.close(); }
});

test('layer edits persist, a layer that breaks the rules is refused without any change, and a stale revision is refused', async () => {
  const server = await reviewServer();
  try {
    await server.start();
    let state = await server.get('/api/state') as State;
    const layer = structuredClone(state.independentParts);
    Object.assign(layer.rows[0].parts[0], { reviewStatus: 'researcher_edited', candidates: [candidate('耳'), candidate('とさか', { owner: 'ニワトリ', basis: '全体との関係' })], noCandidate: false, ai: { agreementStatus: '一部合意', discussion: '経過' } });
    Object.assign(layer.rows[0].parts[1], { reviewStatus: 'researcher_confirmed', noCandidate: true, noCandidateReason: '理由' });
    state = await server.post('/api/state', save(state, { independentParts: layer }));
    assert.deepEqual(state.independentParts, layer);
    const rows = structuredClone(state.results); rows[2].note = '別のメモ';
    state = await server.post('/api/state', save(state, { results: rows, independentParts: undefined }));
    assert.deepEqual(state.independentParts, layer, 'a save without the layer keeps it');

    const before = await server.get('/api/state');
    const broken: [string, (l: Layer) => void][] = [
      ['version', l => { l.schemaVersion = 'other'; }],
      ['row count', l => { l.rows.pop(); }],
      ['unknown row', l => { l.rows[1].id = 'F99@0'; }],
      ['duplicate row', l => { l.rows[1].id = l.rows[0].id; }],
      ['part id', l => { l.rows[1].parts[0].id = 'P9'; }],
      ['unknown review status', l => { l.rows[1].parts[0].reviewStatus = 'confirmed'; }],
      ['four candidates', l => { l.rows[1].parts[0].candidates = [1, 2, 3, 4].map(n => candidate('名' + n)); }],
      ['confidence', l => { l.rows[1].parts[0].candidates = [candidate('名', { confidence: '最高' })]; }],
      ['basis', l => { l.rows[1].parts[0].candidates = [candidate('名', { basis: '不明' })]; }],
      ['no candidate with candidates', l => { l.rows[1].parts[0].candidates = [candidate('名')]; l.rows[1].parts[0].noCandidate = true; }],
      ['long noun', l => { l.rows[1].parts[0].candidates = [candidate('あ'.repeat(41))]; }],
      ['missing ai', l => { delete (l.rows[1].parts[0] as Partial<Entry>).ai; }],
      ['unknown agreement', l => { l.rows[1].parts[0].ai = { agreementStatus: '不明', discussion: '' }; }],
    ];
    for (const [name, mutate] of broken) {
      const l = structuredClone(state.independentParts); mutate(l);
      await server.post('/api/state', save(state, { independentParts: l }), 400);
      assert.deepEqual(await server.get('/api/state'), before, name);
    }
    await server.post('/api/state', save(state, { revision: state.revision - 1 }), 409);
    await server.post('/api/state', save(state, { revision: state.revision - 1, independentParts: layer }), 409);
    assert.deepEqual(await server.get('/api/state'), before);
    await server.stop(); await server.start();
    assert.deepEqual(await server.get('/api/state'), before);
  } finally { await server.close(); }
});

test('the export carries each region\'s independent part, the import restores it, and an export from before the layer keeps the current one', async () => {
  const a = await reviewServer(), b = await reviewServer();
  try {
    await a.start(); await b.start();
    let state = await a.get('/api/state') as State;
    const layer = structuredClone(state.independentParts);
    Object.assign(layer.rows[1].parts[1], { reviewStatus: 'researcher_edited', candidates: [candidate('耳'), candidate(''), candidate('尾')], noCandidate: false, ai: { agreementStatus: '合意', discussion: 'd' } });
    state = await a.post('/api/state', save(state, { independentParts: layer }));
    const exported = await a.get('/api/export');
    assert.equal(exported.independentPartSchemaVersion, 'tangram_independent_part_review_v1');
    assert.ok(!('independentParts' in exported), 'the layer is exported per region, not twice');
    assert.deepEqual(exported.results[0].parts[0].independentPart, { reviewStatus: 'ai_unreviewed', candidates: [], noCandidate: false, noCandidateReason: '', ai: null });
    const part = exported.results[1].parts[1];
    assert.deepEqual(part.independentPart.candidates.map((c: Candidate & { rank: number }) => [c.rank, c.noun]), [[1, '耳'], [2, '尾']], 'a draft candidate without a noun is not exported');
    assert.deepEqual({ ...part.independentPart, candidates: undefined }, { reviewStatus: 'researcher_edited', candidates: undefined, noCandidate: false, noCandidateReason: '', ai: { agreementStatus: '合意', discussion: 'd' } });
    assert.ok(Array.isArray(part.outlines) && part.construal.status === 'hypothesis', 'the existing export fields stay');

    const b0 = await b.get('/api/state') as State;
    const imported = await b.post('/api/import', { revision: b0.revision, document: exported }) as State;
    assert.deepEqual(imported.independentParts.rows[1].parts[1].candidates.map(c => c.noun), ['耳', '尾']);
    assert.equal(imported.independentParts.rows[1].parts[1].reviewStatus, 'researcher_edited');
    imported.independentParts.rows.forEach((r, i) => r.parts.forEach((p, k) => { if (i !== 1 || k !== 1) assert.deepEqual(p, b0.independentParts.rows[i].parts[k]); }));

    const legacyDocument = structuredClone(exported);
    for (const r of legacyDocument.results) for (const q of r.parts) delete q.independentPart;
    delete legacyDocument.independentPartSchemaVersion; legacyDocument.results[0].note = '旧版の書き出し';
    const kept = await b.post('/api/import', { revision: imported.revision, document: legacyDocument }) as State;
    assert.deepEqual(kept.independentParts, imported.independentParts);
    assert.equal(kept.results[0].note, '旧版の書き出し');

    const partial = structuredClone(exported); delete partial.results[3].parts[0].independentPart;
    await b.post('/api/import', { revision: kept.revision, document: partial }, 400);
    assert.deepEqual(await b.get('/api/state'), kept);
  } finally { await a.close(); await b.close(); }
});
