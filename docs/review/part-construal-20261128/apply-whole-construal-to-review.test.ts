import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewServer } from '../orientation-app/review-server-harness.ts';
import { consensusContent } from '../construal-consensus-20261128/apply-consensus-to-review.ts';
import { applyWholeConstrual, type ConsensusFile, type Data, type State, type Whole } from './apply-whole-construal-to-review.ts';

// A consensus for every orientation of the served catalog: 0, 1 or 2 candidates and every agreement status.
function consensusFor(data: Data): ConsensusFile {
  return { catalogRevision: data.catalogRevision, orientations: data.templates.map((t, i) => {
    const none = i % 7 === 3;
    return {
      id: t.id, agreementStatus: none ? (i % 2 ? '未合意' : '合意') : i % 5 === 0 ? '一部合意' : '合意', noConstrual: none, noConstrualReason: none ? '理由' + i : '', discussion: '経過' + i,
      candidates: none ? [] : [1, 2].slice(0, 1 + (i % 2)).map(rank => ({ rank, noun: '名詞' + i + '-' + rank, posture: '姿勢', direction: '左向き', confidence: rank === 1 ? '中' : '低', evidence: '根拠' + i, weaknesses: rank === 1 ? '' : '弱点', parts: t.parts.map(p => ({ id: p.id, role: '役割' + p.id + rank, evidence: '形' })) })),
    };
  }) };
}
const mine = (partIds: string[]) => ({ noun: '研究者の名詞', posture: '立つ', direction: '右向き', confidence: '中', parts: partIds.map(id => ({ id, role: '私の役割' + id })), evidence: '私の根拠', weaknesses: '' });

test('the whole construal replaces only empty or unreviewed AI entries, marks rows whose free text differs, keeps researcher work and position, and never overwrites a newer revision', async () => {
  const server = await reviewServer(), work = mkdtempSync(join(tmpdir(), 'whole-construal-apply-test-'));
  const apply = (consensus: ConsensusFile, name: string, extra: Record<string, unknown> = {}) => applyWholeConstrual({ url: server.url, consensus, backupDir: join(work, name), ...extra });
  try {
    await server.start();
    const data = await server.get('/api/data') as Data;
    const consensus = consensusFor(data), total = consensus.orientations.length;
    assert.equal(total, 120);
    let state = await server.get('/api/state') as State;
    // The consensus text is already in the free text of every row (applied earlier); the researcher then hand-edited and confirmed
    // F1@0, wrote a note on another row, marked one 要修正, confirmed one structured entry, edited one, and left an older unreviewed AI proposal.
    const rows = structuredClone(state.results);
    data.templates.forEach((t, i) => Object.assign(rows[i], consensusContent(t, consensus.orientations[i])));
    rows[0].status = '確認済み'; rows[0].whole = '研究者が手で直した自由文'; rows[2].note = 'メモ'; rows[4].status = '要修正';
    const layer = structuredClone(state.wholeConstruals);
    Object.assign(layer.rows[5], { reviewStatus: 'researcher_confirmed', candidates: [mine(data.templates[5].parts.map(p => p.id))], ai: { agreementStatus: '合意', discussion: '旧案' } });
    Object.assign(layer.rows[6], { reviewStatus: 'researcher_edited', noConstrual: true, noConstrualReason: '研究者が見立てなしにした' });
    Object.assign(layer.rows[7], { candidates: [mine(data.templates[7].parts.map(p => p.id))], ai: { agreementStatus: '合意', discussion: '古い合議' } });
    state = await server.post('/api/state', { revision: state.revision, sourceSha256: state.sourceSha256, currentId: 'F2@90', results: rows, wholeConstruals: layer });
    const before = structuredClone(state);

    // An invalid consensus is refused before anything is backed up or written.
    const reject = async (name: string, mutate: (c: ConsensusFile) => void, pattern: RegExp) => {
      const c = structuredClone(consensus); mutate(c);
      await assert.rejects(apply(c, 'invalid-' + name), pattern, name);
      assert.ok(!existsSync(join(work, 'invalid-' + name)), name + ': no backup for an invalid consensus');
      assert.deepEqual(await server.get('/api/state'), before, name);
    };
    const withCandidates = (c: ConsensusFile) => c.orientations.find(o => o.candidates.length)!;
    await reject('missing', c => { c.orientations.shift(); }, /missing consensus entry/);
    await reject('catalog', c => { c.catalogRevision = 'other'; }, /catalogRevision/);
    await reject('four', c => { const o = withCandidates(c); o.candidates = [1, 2, 3, 4].map(rank => ({ ...o.candidates[0], rank })); }, /0-3 candidates/);
    await reject('confidence', c => { withCandidates(c).candidates[0].confidence = '最高'; }, /bad confidence/);
    await reject('noun', c => { withCandidates(c).candidates[0].noun = 'あ'.repeat(41); }, /noun/);
    await reject('rank', c => { withCandidates(c).candidates[0].rank = 2; }, /ranks/);
    await reject('parts', c => { withCandidates(c).candidates[0].parts.pop(); }, /must list/);

    const dry = await apply(consensus, 'dry', { dryRun: true });
    assert.ok('dryRun' in dry);
    assert.deepEqual(dry.plan.counts, { added: total - 3, updated: 1, unchanged: 0, keptConfirmed: 1, keptEdited: 1 });
    assert.deepEqual(dry.plan.textDiffersFromProposal, ['F1@0']);
    assert.deepEqual(dry.plan.needsTextCheck, ['F1@0']);
    assert.deepEqual(await server.get('/api/state'), before);

    const done = await apply(consensus, 'apply', { stateFile: server.statePath });
    assert.ok('conflict' in done && done.conflict === false);
    const after = await server.get('/api/state') as State;
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.currentId, 'F2@90');
    assert.deepEqual(after.results, before.results, 'free text, notes, statuses and part roles are untouched');
    assert.deepEqual((after as unknown as { independentParts: unknown }).independentParts, (before as unknown as { independentParts: unknown }).independentParts, 'the independent part layer is untouched');
    after.wholeConstruals.rows.forEach((w: Whole, i) => {
      if (i === 5 || i === 6) { assert.deepEqual(w, before.wholeConstruals.rows[i], w.id); return; }
      const e = consensus.orientations[i];
      assert.equal(w.reviewStatus, 'ai_unreviewed', w.id);
      assert.equal(w.noConstrual, e.noConstrual, w.id);
      assert.equal(w.needsTextCheck, i === 0, w.id + ': only the hand-edited row is marked');
      assert.deepEqual(w.ai, { agreementStatus: e.agreementStatus, discussion: e.discussion }, w.id);
      assert.deepEqual(w.candidates.map(c => [c.noun, c.posture, c.direction, c.confidence, c.evidence, c.weaknesses, c.parts.map(p => p.id + '=' + p.role).join(',')]),
        e.candidates.map(c => [c.noun, c.posture, c.direction, c.confidence, c.evidence, c.weaknesses ?? '', c.parts.map(p => p.id + '=' + p.role).join(',')]), w.id);
    });
    assert.ok(!after.wholeConstruals.rows[7].candidates.some(c => c.noun === '研究者の名詞'), 'an older unreviewed proposal is replaced');
    assert.equal(after.results[0].status, '確認済み');
    for (const name of ['state-before.json', 'export-before.json', 'review-state-file-before.json', 'plan.json', 'state-after.json', 'export-after.json']) assert.ok(existsSync(join(work, 'apply', name)), name);
    assert.deepEqual(JSON.parse(readFileSync(join(work, 'apply', 'state-before.json'), 'utf8')), before);
    const exported = JSON.parse(readFileSync(join(work, 'apply', 'export-after.json'), 'utf8'));
    assert.equal(exported.results[0].wholeConstrual.needsTextCheck, true);
    assert.equal(exported.results[0].whole, '研究者が手で直した自由文');
    assert.equal(exported.results[1].wholeConstrual.candidates[0].noun, consensus.orientations[1].candidates[0].noun);

    // Applying the same consensus again changes nothing and does not bump the revision.
    const again = await apply(consensus, 'again');
    assert.ok('noChange' in again);
    assert.deepEqual(again.plan.counts, { added: 0, updated: 0, unchanged: total - 2, keptConfirmed: 1, keptEdited: 1 });
    assert.deepEqual(await server.get('/api/state'), after);

    // A save from the review page between our read and our write wins; the script only reports it.
    const revised = structuredClone(consensus), reviewed = [5, 6];
    const picks = revised.orientations.map((o, i) => ({ o, i })).filter(({ o, i }) => o.candidates.length && !reviewed.includes(i) && i > 8);
    const [first, second] = picks;
    first.o.candidates[0].evidence = '改訂した根拠'; second.o.candidates[0].evidence = '別の改訂';
    const conflict = await apply(revised, 'conflict', { beforePost: async () => {
      const latest = await server.get('/api/state') as State;
      const resultsX = structuredClone(latest.results); resultsX[12].status = '確認済み';
      const layerX = structuredClone(latest.wholeConstruals); layerX.rows[second.i].reviewStatus = 'researcher_edited';
      await server.post('/api/state', { revision: latest.revision, sourceSha256: latest.sourceSha256, currentId: 'F3@0', results: resultsX, wholeConstruals: layerX });
    } });
    assert.ok('conflict' in conflict && conflict.conflict === true);
    if (conflict.conflict) {
      assert.deepEqual(conflict.rowsChangedSinceRead, [after.results[12].id]);
      assert.deepEqual(conflict.entriesChangedSinceRead, [after.wholeConstruals.rows[second.i].id]);
      assert.equal(conflict.currentIdChanged, true);
    }
    assert.ok(existsSync(join(work, 'conflict', 'conflict.json')));
    const raced = await server.get('/api/state') as State;
    assert.equal(raced.revision, after.revision + 1);
    assert.equal(raced.currentId, 'F3@0');
    assert.equal(raced.wholeConstruals.rows[first.i].candidates[0].evidence, consensus.orientations[first.i].candidates[0].evidence, 'the newer state was not overwritten');

    // Run again on the latest state: the entry the researcher edited meanwhile is kept, the other is revised.
    const retry = await apply(revised, 'retry');
    assert.ok('conflict' in retry && retry.conflict === false);
    assert.deepEqual(retry.plan.counts, { added: 0, updated: 1, unchanged: total - 4, keptConfirmed: 1, keptEdited: 2 });
    const last = await server.get('/api/state') as State;
    assert.equal(last.wholeConstruals.rows[first.i].candidates[0].evidence, '改訂した根拠');
    assert.equal(last.wholeConstruals.rows[second.i].candidates[0].evidence, consensus.orientations[second.i].candidates[0].evidence, 'a researcher-edited entry is not replaced');
    assert.equal(last.currentId, 'F3@0');
  } finally { await server.close(); rmSync(work, { recursive: true, force: true }); }
});
