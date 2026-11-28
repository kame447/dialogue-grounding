import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { reviewServer } from './review-server-harness.ts';

type Candidate = { noun: string; posture: string; direction: string; confidence: string; parts: { id: string; role: string }[]; evidence: string; weaknesses: string };
type Whole = { id: string; reviewStatus: string; candidates: Candidate[]; noConstrual: boolean; noConstrualReason: string; needsTextCheck: boolean; ai: { agreementStatus: string; discussion: string } | null };
type Layer = { schemaVersion: string; rows: Whole[] };
type State = { revision: number; sourceSha256: string; currentId: string; results: any[]; wholeConstruals: Layer; independentParts: unknown };

const candidate = (partIds: string[], noun: string, extra: Partial<Candidate> = {}): Candidate => ({ noun, posture: '座る', direction: '右向き', confidence: '低', parts: partIds.map(id => ({ id, role: '役割' + id })), evidence: '根拠', weaknesses: '', ...extra });
// A save as the page sends it. Set a layer to undefined for the save of a page that predates it.
const save = (s: State, patch: Record<string, unknown> = {}) => ({ revision: s.revision, sourceSha256: s.sourceSha256, currentId: s.currentId, results: s.results, independentParts: s.independentParts, wholeConstruals: s.wholeConstruals, ...patch });
const withoutLayers = ({ independentParts, wholeConstruals, ...rest }: State) => rest;

test('a state file from before the whole layer loads unchanged, gains an empty layer in memory only, keeps the layer across an old-style save, and refuses a layer that breaks the rules', async () => {
  const a = await reviewServer(), b = await reviewServer();
  try {
    await a.start();
    const data = await a.get('/api/data');
    const ids = (row: string): string[] => data.templates.find((t: { id: string }) => t.id === row).parts.map((p: { id: string }) => p.id);
    assert.equal(data.wholeConstrual.schemaVersion, 'tangram_whole_construal_review_v1');
    let s = await a.get('/api/state') as State;
    const rows = structuredClone(s.results); rows[0].status = '確認済み'; rows[0].whole = '研究者が手で直した自由文'; rows[2].note = 'メモ';
    s = await a.post('/api/state', save(s, { currentId: 'F2@90', results: rows, independentParts: undefined, wholeConstruals: undefined }));
    const legacy = JSON.parse(readFileSync(a.statePath, 'utf8')); delete legacy.independentParts; delete legacy.wholeConstruals;
    const text = JSON.stringify(legacy, null, 2) + '\n';
    writeFileSync(b.statePath, text);
    await b.start();
    const loaded = await b.get('/api/state') as State;
    assert.deepEqual(withoutLayers(loaded), withoutLayers(s));
    assert.equal(loaded.wholeConstruals.rows.length, 120);
    assert.ok(loaded.wholeConstruals.rows.every((w, i) => w.id === s.results[i].id && w.ai === null && w.reviewStatus === 'ai_unreviewed' && !w.candidates.length && !w.noConstrual && !w.needsTextCheck && w.noConstrualReason === ''));
    assert.equal(readFileSync(b.statePath, 'utf8'), text, 'starting must not rewrite the old file');

    const layer = structuredClone(loaded.wholeConstruals);
    Object.assign(layer.rows[0], { reviewStatus: 'researcher_edited', needsTextCheck: true, candidates: [candidate(ids('F1@0'), 'ティーポット'), candidate(ids('F1@0'), 'リス', { confidence: '中' })], ai: { agreementStatus: '一部合意', discussion: '経過' } });
    Object.assign(layer.rows[1], { reviewStatus: 'researcher_confirmed', noConstrual: true, noConstrualReason: '理由' });
    let after = await b.post('/api/state', save(loaded, { wholeConstruals: layer, independentParts: undefined })) as State;
    assert.deepEqual(after.wholeConstruals, layer);
    assert.deepEqual(after.independentParts, loaded.independentParts);
    const rows2 = structuredClone(after.results); rows2[3].note = '別のメモ';
    after = await b.post('/api/state', save(after, { results: rows2, independentParts: undefined, wholeConstruals: undefined })) as State;
    assert.deepEqual(after.wholeConstruals, layer, 'a save without the layers keeps them');

    const before = await b.get('/api/state');
    const broken: [string, (l: Layer) => void][] = [
      ['version', l => { l.schemaVersion = 'other'; }],
      ['row count', l => { l.rows.pop(); }],
      ['unknown row', l => { l.rows[1].id = 'F99@0'; }],
      ['duplicate row', l => { l.rows[1].id = l.rows[0].id; }],
      ['unknown review status', l => { l.rows[1].reviewStatus = 'confirmed'; }],
      ['four candidates', l => { l.rows[2].candidates = [1, 2, 3, 4].map(n => candidate(ids('F1@180'), '名' + n)); }],
      ['a role is missing', l => { const c = candidate(ids('F1@180'), '名'); c.parts.pop(); l.rows[2].candidates = [c]; }],
      ['roles out of order', l => { const c = candidate(ids('F1@180'), '名'); c.parts.reverse(); l.rows[2].candidates = [c]; }],
      ['confidence', l => { l.rows[2].candidates = [candidate(ids('F1@180'), '名', { confidence: '最高' })]; }],
      ['no construal with candidates', l => { l.rows[2].candidates = [candidate(ids('F1@180'), '名')]; l.rows[2].noConstrual = true; }],
      ['long noun', l => { l.rows[2].candidates = [candidate(ids('F1@180'), 'あ'.repeat(41))]; }],
      ['needsTextCheck is not a boolean', l => { (l.rows[2] as unknown as { needsTextCheck: string }).needsTextCheck = 'yes'; }],
      ['missing ai', l => { delete (l.rows[2] as Partial<Whole>).ai; }],
      ['unknown agreement', l => { l.rows[2].ai = { agreementStatus: '不明', discussion: '' }; }],
    ];
    for (const [name, mutate] of broken) {
      const l = structuredClone(after.wholeConstruals); mutate(l);
      await b.post('/api/state', save(after, { wholeConstruals: l }), 400);
      assert.deepEqual(await b.get('/api/state'), before, name);
    }
    await b.post('/api/state', save(after, { revision: after.revision - 1, wholeConstruals: layer }), 409);
    await b.stop(); await b.start();
    assert.deepEqual(await b.get('/api/state'), before);
  } finally { await a.close(); await b.close(); }
});

test('the export carries each direction\'s whole construal, the import restores it, and an export from before the layer keeps the current one', async () => {
  const a = await reviewServer(), b = await reviewServer();
  try {
    await a.start(); await b.start();
    const data = await a.get('/api/data');
    const ids = (row: string): string[] => data.templates.find((t: { id: string }) => t.id === row).parts.map((p: { id: string }) => p.id);
    let state = await a.get('/api/state') as State;
    const layer = structuredClone(state.wholeConstruals);
    Object.assign(layer.rows[1], { reviewStatus: 'researcher_edited', needsTextCheck: true, candidates: [candidate(ids('F1@90'), 'ウサギ'), candidate(ids('F1@90'), ''), candidate(ids('F1@90'), 'ネコ', { confidence: '高' })], ai: { agreementStatus: '合意', discussion: 'd' } });
    state = await a.post('/api/state', save(state, { wholeConstruals: layer })) as State;
    const exported = await a.get('/api/export');
    assert.equal(exported.wholeConstrualSchemaVersion, 'tangram_whole_construal_review_v1');
    assert.ok(!('wholeConstruals' in exported), 'the layer is exported per direction, not twice');
    assert.deepEqual(exported.results[0].wholeConstrual, { reviewStatus: 'ai_unreviewed', candidates: [], noConstrual: false, noConstrualReason: '', needsTextCheck: false, ai: null });
    const whole = exported.results[1].wholeConstrual;
    assert.deepEqual(whole.candidates.map((c: Candidate & { rank: number }) => [c.rank, c.noun, c.confidence]), [[1, 'ウサギ', '低'], [2, 'ネコ', '高']], 'a draft candidate without a noun is not exported');
    assert.deepEqual(whole.candidates[0].parts, ids('F1@90').map(id => ({ id, role: '役割' + id })));
    assert.deepEqual({ ...whole, candidates: undefined }, { reviewStatus: 'researcher_edited', candidates: undefined, noConstrual: false, noConstrualReason: '', needsTextCheck: true, ai: { agreementStatus: '合意', discussion: 'd' } });
    assert.equal(typeof exported.results[1].whole, 'string', 'the free text stays');

    const b0 = await b.get('/api/state') as State;
    const imported = await b.post('/api/import', { revision: b0.revision, document: exported }) as State;
    assert.deepEqual(imported.wholeConstruals.rows[1].candidates.map(c => c.noun), ['ウサギ', 'ネコ']);
    assert.equal(imported.wholeConstruals.rows[1].needsTextCheck, true);
    imported.wholeConstruals.rows.forEach((w, i) => { if (i !== 1) assert.deepEqual(w, b0.wholeConstruals.rows[i]); });

    const legacyDocument = structuredClone(exported);
    for (const r of legacyDocument.results) delete r.wholeConstrual;
    delete legacyDocument.wholeConstrualSchemaVersion; legacyDocument.results[0].note = '旧版の書き出し';
    const kept = await b.post('/api/import', { revision: imported.revision, document: legacyDocument }) as State;
    assert.deepEqual(kept.wholeConstruals, imported.wholeConstruals);
    assert.equal(kept.results[0].note, '旧版の書き出し');

    const invalid = structuredClone(exported); invalid.results[3].wholeConstrual.candidates = [candidate(ids('F1@270'), '名', { confidence: '最高' })];
    await b.post('/api/import', { revision: kept.revision, document: invalid }, 400);
    assert.deepEqual(await b.get('/api/state'), kept);
  } finally { await a.close(); await b.close(); }
});
