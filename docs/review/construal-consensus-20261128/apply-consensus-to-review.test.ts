import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { applyConsensus, concreteDraftContent, type Data, type Draft, type Entry, type State } from './apply-consensus-to-review.ts';

const drafts = JSON.parse(readFileSync(new URL('../orientation-app/concrete-construal-draft.json', import.meta.url), 'utf8')) as Record<string, Draft>;

function entriesFor(data: Data): Entry[] {
  return data.templates.map((t, i) => i % 7 === 3
    ? { id: t.id, agreementStatus: i % 2 ? '未合意' : '合意', noConstrual: true, noConstrualReason: '理由' + i, candidates: [], uncertainty: '' }
    : { id: t.id, agreementStatus: '合意', noConstrual: false, noConstrualReason: '', uncertainty: '迷い' + i, candidates: [
      { rank: 1, noun: '名詞' + i, posture: '姿勢', direction: '左向き', confidence: '中', evidence: '根拠', weaknesses: '', parts: t.parts.map(p => ({ id: p.id, role: '役割' + p.id, evidence: '形' })) },
      { rank: 2, noun: '別名' + i, posture: '立つ', direction: '上', confidence: '低', evidence: '根拠2', weaknesses: '', parts: t.parts.map(p => ({ id: p.id, role: '部位' + p.id, evidence: '形' })) },
    ] });
}

test('consensus replaces only untouched unconfirmed AI drafts, keeps position, and never overwrites a newer revision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'consensus-apply-test-'));
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const address = probe.address(); assert.ok(address && typeof address === 'object'); const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close(e => e ? reject(e) : resolve()));
  const url = 'http://127.0.0.1:' + port;
  let child: ChildProcess | null = spawn(process.execPath, [new URL('../orientation-app/server.ts', import.meta.url).pathname], { env: { ...process.env, REVIEW_PORT: String(port), REVIEW_STATE_DIR: join(dir, 'state') }, stdio: 'pipe' });
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url + '/api/state')).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
    const get = async (p: string) => (await fetch(url + p)).json();
    const post = async (body: unknown) => { const r = await fetch(url + '/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(r.status, 200); return r.json() as Promise<State>; };
    const data = await get('/api/data') as Data;
    let state = await get('/api/state') as State;
    const user = structuredClone(state.results);
    user[0].status = '確認済み';
    user[1].whole = '研究者が書き換えた見立て';
    user[2].note = '研究者のメモ';
    Object.assign(user[3], concreteDraftContent(data.templates[3], drafts[user[3].id]));
    user[4].status = '要修正';
    state = await post({ revision: state.revision, sourceSha256: state.sourceSha256, currentId: 'F2@90', results: user });
    const before = structuredClone(state);
    const entries = entriesFor(data);

    await assert.rejects(applyConsensus({ url, entries: entries.slice(1), drafts, backupDir: join(dir, 'missing') }), /missing consensus entry/);
    const wrongParts = structuredClone(entries); wrongParts[0].candidates[0].parts.reverse();
    if (wrongParts[0].candidates[0].parts.length > 1) await assert.rejects(applyConsensus({ url, entries: wrongParts, drafts, backupDir: join(dir, 'wrong') }), /must list/);
    assert.deepEqual(await get('/api/state'), before);

    const dry = await applyConsensus({ url, entries, drafts, backupDir: join(dir, 'dry'), dryRun: true });
    assert.deepEqual(dry.plan.counts, { reviewed: 2, edited: 2, template: 115, concreteDraft: 1 });
    assert.deepEqual(await get('/api/state'), before);

    const done = await applyConsensus({ url, entries, drafts, backupDir: join(dir, 'apply'), stateFile: join(dir, 'state', 'review-state.json') });
    assert.ok('conflict' in done && done.conflict === false);
    const after = await get('/api/state') as State;
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.currentId, 'F2@90');
    for (const i of [0, 1, 2, 4]) assert.deepEqual(after.results[i], before.results[i]);
    for (const [i, row] of after.results.entries()) {
      assert.equal(row.status, before.results[i].status); assert.equal(row.note, before.results[i].note);
      assert.deepEqual(row.parts.map(p => p.description), before.results[i].parts.map(p => p.description));
    }
    assert.match(after.results[5].whole, /^候補1：名詞5（姿勢、左向き）\n候補2：別名5/);
    assert.deepEqual(after.results[5].parts[0].candidates, ['役割P1（候補1：名詞5）', '部位P1（候補2：別名5）']);
    assert.equal(after.results[3].whole, '見立てなし（未合意）');
    assert.deepEqual(after.results[3].parts[0].candidates, []);
    assert.equal(after.results[10].whole, '見立てなし');
    for (const name of ['state-before.json', 'export-before.json', 'review-state-file-before.json', 'plan.json', 'state-after.json', 'export-after.json']) assert.ok(existsSync(join(dir, 'apply', name)), name);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'apply', 'state-before.json'), 'utf8')), before);
    const exported = JSON.parse(readFileSync(join(dir, 'apply', 'export-after.json'), 'utf8'));
    assert.deepEqual(exported.results[5].parts[0].construal.candidates, ['役割P1（候補1：名詞5）', '部位P1（候補2：別名5）']);
    const geometry = await get('/api/data') as { templates: { parts: { outlines: unknown }[] }[] };
    assert.deepEqual(exported.results[5].parts[0].outlines, geometry.templates[5].parts[0].outlines);

    // A save from the review page between our read and our write must win; we only report it.
    const reset = structuredClone(before.results);
    const second = await post({ revision: after.revision, sourceSha256: after.sourceSha256, currentId: 'F2@90', results: reset });
    const conflict = await applyConsensus({ url, entries, drafts, backupDir: join(dir, 'conflict'), beforePost: async () => {
      const latest = await get('/api/state') as State; const rows = structuredClone(latest.results); rows[6].status = '確認済み';
      await post({ revision: latest.revision, sourceSha256: latest.sourceSha256, currentId: 'F3@0', results: rows });
    } });
    assert.ok('conflict' in conflict && conflict.conflict === true);
    if (conflict.conflict) {
      assert.deepEqual(conflict.rowsChangedSinceRead, [second.results[6].id]);
      assert.equal(conflict.currentIdChanged, true);
    }
    const final = await get('/api/state') as State;
    assert.equal(final.revision, second.revision + 1); assert.equal(final.currentId, 'F3@0'); assert.equal(final.results[6].status, '確認済み');
    assert.deepEqual(final.results[7], before.results[7]);
    assert.ok(existsSync(join(dir, 'conflict', 'conflict.json')));
  } finally {
    if (child && child.exitCode === null) { const end = once(child, 'exit'); child.kill(); await end; }
    child = null; rmSync(dir, { recursive: true, force: true });
  }
});
