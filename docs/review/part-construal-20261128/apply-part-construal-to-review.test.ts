import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewServer } from '../orientation-app/review-server-harness.ts';
import { applyPartConstrual, type Data, type Layer, type Proposal, type ProposalEntry, type State } from './apply-part-construal-to-review.ts';

// A proposal for every region of the served catalog: 0, 1 or 3 candidates, with every agreement status.
function proposalFor(data: Data): Proposal {
  const entries: ProposalEntry[] = [];
  data.templates.forEach((t, i) => t.parts.forEach((p, k) => {
    const n = i * 10 + k, count = n % 3 === 1 ? 1 : n % 3 === 2 ? 3 : 0;
    entries.push({
      id: t.id + '#' + p.id, figureId: t.figureId, rotation: t.rotation, regionId: p.id, members: p.members.map(String),
      candidates: Array.from({ length: count }, (_, j) => ({ rank: j + 1, noun: '名詞' + n + '-' + j, owner: j ? '' : '動物', basis: ['単独', '全体との関係', '両方'][j], confidence: j ? '低' : '中', evidence: '根拠' + n, weaknesses: j ? '' : '弱点' + n })),
      noCandidate: count === 0, noCandidateReason: count ? '' : '理由' + n,
      agreementStatus: count === 0 ? (n % 2 ? '未合意' : '合意') : n % 5 === 0 ? '一部合意' : '合意', discussion: '経過' + n,
    });
  }));
  return { schemaVersion: 'tangram_independent_part_construal_v1', catalogRevision: data.catalogRevision, entries };
}
const find = (layer: Layer, key: string) => { const [rowId, partId] = key.split('#'); return layer.rows.find(r => r.id === rowId)!.parts.find(p => p.id === partId)!; };
const own = (noun: string) => ({ noun, owner: '', basis: '単独', confidence: '中', evidence: '根拠', weaknesses: '' });

test('the part construal replaces only empty or unreviewed AI entries, keeps researcher work and position, and never overwrites a newer revision', async () => {
  const server = await reviewServer(), work = mkdtempSync(join(tmpdir(), 'part-construal-apply-test-'));
  const apply = (proposal: Proposal, name: string, extra: Record<string, unknown> = {}) => applyPartConstrual({ url: server.url, proposal, backupDir: join(work, name), ...extra });
  try {
    await server.start();
    const data = await server.get('/api/data') as Data;
    const proposal = proposalFor(data), total = proposal.entries.length;
    assert.equal(total, 468);
    let state = await server.get('/api/state') as State;
    // Work the researcher did before the apply: F1@0 was confirmed before the layer existed, plus a note, a 要修正 row,
    // a confirmed entry, an edited entry, an older unreviewed AI proposal, and the current position.
    const rows = structuredClone(state.results); rows[0].status = '確認済み'; rows[1].note = '研究者のメモ'; rows[2].status = '要修正';
    const layer = structuredClone(state.independentParts);
    Object.assign(find(layer, 'F2@90#P1'), { reviewStatus: 'researcher_confirmed', candidates: [own('確認した名詞')], ai: { agreementStatus: '合意', discussion: '旧案' } });
    Object.assign(find(layer, 'F3@0#P2'), { reviewStatus: 'researcher_edited', noCandidate: true, noCandidateReason: '研究者が見立てなしにした' });
    Object.assign(find(layer, 'F4@0#P1'), { candidates: [own('古い案')], ai: { agreementStatus: '合意', discussion: '古い合議' } });
    state = await server.post('/api/state', { revision: state.revision, sourceSha256: state.sourceSha256, currentId: 'F2@90', results: rows, independentParts: layer });
    const before = structuredClone(state);

    // An invalid proposal is refused before anything is backed up or written.
    const reject = async (name: string, mutate: (p: Proposal) => void, pattern: RegExp) => {
      const p = structuredClone(proposal); mutate(p);
      await assert.rejects(apply(p, 'invalid-' + name), pattern, name);
      assert.ok(!existsSync(join(work, 'invalid-' + name)), name + ': no backup for an invalid proposal');
      assert.deepEqual(await server.get('/api/state'), before, name);
    };
    await reject('missing', p => { p.entries.shift(); }, /missing proposal entry/);
    await reject('members', p => { p.entries[0].members = ['99']; }, /members differ/);
    await reject('catalog', p => { p.catalogRevision = 'other'; }, /catalogRevision/);
    await reject('four', p => { const e = p.entries.find(x => x.noCandidate)!; e.noCandidate = false; e.candidates = [1, 2, 3, 4].map(rank => ({ rank, noun: '名', basis: '単独', confidence: '低', evidence: 'e' })); }, /candidates required/);
    await reject('basis', p => { p.entries.find(x => x.candidates.length)!.candidates[0].basis = '不明'; }, /bad basis/);
    await reject('extra', p => { p.entries.push({ ...p.entries[0], id: 'F99@0#P1', figureId: 'F99' }); }, /outside the catalog/);
    await reject('flag', p => { p.entries.find(x => x.candidates.length)!.noCandidate = true; }, /noCandidate must match/);
    await reject('disagreed', p => { p.entries.find(x => x.candidates.length)!.agreementStatus = '未合意'; }, /未合意 cannot carry/);

    const dry = await apply(proposal, 'dry', { dryRun: true });
    assert.ok('dryRun' in dry);
    assert.deepEqual(dry.plan.counts, { added: total - 3, updated: 1, unchanged: 0, keptConfirmed: 1, keptEdited: 1 });
    assert.deepEqual(await server.get('/api/state'), before);
    assert.ok(existsSync(join(work, 'dry', 'plan.json')));

    const done = await apply(proposal, 'apply', { stateFile: server.statePath });
    assert.ok('conflict' in done && done.conflict === false);
    const after = await server.get('/api/state') as State;
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.currentId, 'F2@90');
    assert.deepEqual(after.results, before.results, 'rows, notes, statuses and the whole construal are untouched');
    const proposed = new Map(proposal.entries.map(e => [e.id, e]));
    for (const row of after.independentParts.rows) for (const p of row.parts) {
      const key = row.id + '#' + p.id, e = proposed.get(key)!;
      if (key === 'F2@90#P1' || key === 'F3@0#P2') { assert.deepEqual(p, find(before.independentParts, key), key); continue; }
      assert.equal(p.reviewStatus, 'ai_unreviewed', key);
      assert.deepEqual(p.candidates.map(c => c.noun), e.candidates.map(c => c.noun), key);
      assert.equal(p.noCandidate, e.noCandidate, key);
      assert.deepEqual(p.ai, { agreementStatus: e.agreementStatus, discussion: e.discussion }, key);
    }
    assert.ok(!find(after.independentParts, 'F4@0#P1').candidates.some(c => c.noun === '古い案'), 'an older unreviewed proposal is replaced');
    assert.equal(after.results[0].status, '確認済み');
    assert.equal(find(after.independentParts, 'F1@0#P1').reviewStatus, 'ai_unreviewed', 'a row confirmed before the layer still has unreviewed proposals');
    for (const name of ['state-before.json', 'export-before.json', 'review-state-file-before.json', 'plan.json', 'state-after.json', 'export-after.json']) assert.ok(existsSync(join(work, 'apply', name)), name);
    assert.deepEqual(JSON.parse(readFileSync(join(work, 'apply', 'state-before.json'), 'utf8')), before);
    const first = proposal.entries.find(e => e.candidates.length)!, [rowId, partId] = first.id.split('#');
    const exportedPart = JSON.parse(readFileSync(join(work, 'apply', 'export-after.json'), 'utf8')).results.find((r: { id: string }) => r.id === rowId).parts.find((q: { id: string }) => q.id === partId);
    assert.equal(exportedPart.independentPart.candidates[0].noun, first.candidates[0].noun);
    assert.equal(exportedPart.independentPart.reviewStatus, 'ai_unreviewed');

    // Applying the same proposal again changes nothing and does not bump the revision.
    const again = await apply(proposal, 'again');
    assert.ok('noChange' in again);
    assert.deepEqual(again.plan.counts, { added: 0, updated: 0, unchanged: total - 2, keptConfirmed: 1, keptEdited: 1 });
    assert.deepEqual(await server.get('/api/state'), after);

    // A save from the review page between our read and our write wins; the script only reports it.
    const revised = structuredClone(proposal), reviewed = ['F2@90#P1', 'F3@0#P2'];
    const [e1, e2] = revised.entries.filter(e => e.candidates.length && !reviewed.includes(e.id));
    e1.candidates[0].evidence = '改訂した根拠'; e2.candidates[0].evidence = '別の改訂';
    const conflict = await apply(revised, 'conflict', { beforePost: async () => {
      const latest = await server.get('/api/state') as State;
      const resultsX = structuredClone(latest.results); resultsX[6].status = '確認済み';
      const layerX = structuredClone(latest.independentParts); find(layerX, e2.id).reviewStatus = 'researcher_edited';
      await server.post('/api/state', { revision: latest.revision, sourceSha256: latest.sourceSha256, currentId: 'F3@0', results: resultsX, independentParts: layerX });
    } });
    assert.ok('conflict' in conflict && conflict.conflict === true);
    if (conflict.conflict) {
      assert.deepEqual(conflict.rowsChangedSinceRead, [after.results[6].id]);
      assert.deepEqual(conflict.entriesChangedSinceRead, [e2.id]);
      assert.equal(conflict.currentIdChanged, true);
    }
    assert.ok(existsSync(join(work, 'conflict', 'conflict.json')));
    const raced = await server.get('/api/state') as State;
    assert.equal(raced.revision, after.revision + 1);
    assert.equal(raced.currentId, 'F3@0');
    assert.equal(raced.results[6].status, '確認済み');
    assert.equal(find(raced.independentParts, e1.id).candidates[0].evidence, proposed.get(e1.id)!.candidates[0].evidence, 'the newer state was not overwritten');

    // Run again on the latest state: the entry the researcher edited meanwhile is kept, the other is revised.
    const retry = await apply(revised, 'retry');
    assert.ok('conflict' in retry && retry.conflict === false);
    assert.deepEqual(retry.plan.counts, { added: 0, updated: 1, unchanged: total - 4, keptConfirmed: 1, keptEdited: 2 });
    const last = await server.get('/api/state') as State;
    assert.equal(find(last.independentParts, e1.id).candidates[0].evidence, '改訂した根拠');
    assert.equal(find(last.independentParts, e2.id).candidates[0].evidence, proposed.get(e2.id)!.candidates[0].evidence, 'a researcher-edited entry is not replaced');
    assert.equal(last.currentId, 'F3@0');
  } finally { await server.close(); rmSync(work, { recursive: true, force: true }); }
});
