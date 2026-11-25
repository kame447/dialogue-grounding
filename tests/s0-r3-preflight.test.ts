// Focused mechanical S0 r3 checks. Expectations follow the frozen S1/S2 contracts.
import test, { before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BASELINE_HEAD, ROOT, compareBaselineSnapshot, checkDraft } from '../dialogue-model/runtime/diagnostics/s0-r3-preflight/f88abb3-v2/preflight.ts';
import type { BaselineSnapshot } from '../dialogue-model/runtime/diagnostics/s0-r3-preflight/f88abb3-v2/preflight.ts';
import { MOCK_JEV_MODEL, MOCK_MODEL, runSynthetic } from '../dialogue-model/runtime/diagnostics/s0-r3-preflight/f88abb3-v2/mock.ts';
import { validateRunManifestV2 } from '../dialogue-model/runtime/diagnostics/parity-live/manifest.ts';
import { APPROVED_RUN_MANIFEST } from '../dialogue-model/runtime/diagnostics/parity-live/manifest.ts';
import type { TestContext } from 'node:test';

const entry = join(ROOT, 'dialogue-model/runtime/diagnostics/s0-r3-preflight/f88abb3-v2/preflight.ts');
const source = new URL('../dialogue-model/runtime/diagnostics/s0-r3-preflight/f88abb3-v2/manifest.mock.json', import.meta.url);
const candidate = async () => validateRunManifestV2(JSON.parse(await readFile(source, 'utf8')));
async function frozenSubject(): Promise<BaselineSnapshot> {
  // Audited baseline record, not the evolving checkout. This also works in CI's
  // shallow clone, where the historical f88abb3 Git object may not be available.
  const pins = JSON.parse(await readFile(new URL('../dialogue-model/runtime/diagnostics/s0-r3-preflight/f88abb3-v2/pins.json', import.meta.url), 'utf8'));
  return { head: pins.baselineHead, files: pins.files };
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 's0-r3-focused-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { output: join(root, 'out'), cache: join(root, 'cache') };
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(r => setImmediate(r)); };
before(() => { mock.method(globalThis, 'fetch', () => { throw Error('network_forbidden_in_s0_preflight'); }); });
after(() => { mock.restoreAll(); });

test('f88abb3 pins and pending v2 manifest bind the frozen S1/S2 profile', async () => {
  const manifest = await candidate(), report = await checkDraft(manifest, await frozenSubject());
  assert.equal(report.baselineHead, BASELINE_HEAD);
  assert.equal(report.subjectHead, BASELINE_HEAD);
  assert.equal(report.pinsSha256, '9ff6c8e681ea661bf95130db206a344fe22f77bc78d1f10a83af885d397d5692');
  assert.equal(report.sourceFiles, 184);
  assert.equal(report.launchAuthorized, false);
  assert.equal(report.profile.id, 'research_trial_profile_v2');
  assert.equal(report.profileSha256, '75ef126587ea2d0f83bab2a5db369bc9646e29e54efed13f8bc7090e9412252c');
  assert.deepEqual(report.profile.timeouts, manifest.timeouts);
  assert.deepEqual(manifest.caps, APPROVED_RUN_MANIFEST.caps);
  assert.deepEqual(manifest.trials, APPROVED_RUN_MANIFEST.trials);
  assert.equal(manifest.seed, 1701);
});

test('the old fa84980 subject cannot satisfy the frozen f88abb3 record', async () => {
  await assert.rejects(compareBaselineSnapshot({ ...await frozenSubject(), head: 'fa84980ed8698272891a3d33a69735f7d2f126b4' }), { message: 'baseline_head_mismatch' });
});

test('a changed baseline runtime source is rejected before mock execution', async () => {
  const changed = await frozenSubject();
  changed.files[0].sha256 = '0'.repeat(64);
  await assert.rejects(checkDraft(await candidate(), changed), { message: 'baseline_source_mismatch' });
});

test('v2 rejects duplicate Luna timeout, v3 and an approved mock candidate', async () => {
  const manifest = await candidate();
  assert.throws(() => validateRunManifestV2({ ...manifest, lunaRequest: { ...manifest.lunaRequest, timeoutMs: 80000 } }), { message: 'duplicate_luna_timeout' });
  assert.throws(() => validateRunManifestV2({ ...manifest, schemaVersion: 3 }), { message: 'invalid_manifest_version' });
  await assert.rejects(checkDraft({ ...manifest, approval: 'approved' }), { message: 'mock_manifest_must_be_pending' });
});

test('CLI live modes always refuse before reading even a missing manifest', async () => {
  for (const flag of ['--live', '--live-approved']) {
    try { await promisify(execFile)(process.execPath, [entry, flag, '/missing/synthetic-manifest.json']); assert.fail('live mode accepted'); }
    catch (error) {
      const e = error as { code: number; stdout: string };
      assert.equal(e.code, 2);
      assert.deepEqual(JSON.parse(e.stdout), { draft: true, launchAuthorized: false, reason: 'draft_live_unapproved' });
    }
  }
});

test('the pending mock manifest completes both labels and preserves accepted snapshot IDs', async t => {
  const dirs = await fixture(t), manifest = await candidate();
  const { result, calls } = await runSynthetic(manifest, dirs.output, dirs.cache);
  assert.equal(result.summary.status, 'wiring_passed');
  assert.equal(result.trials.length, manifest.trials.length);
  assert.deepEqual(new Set(result.trials.map(t => t.label)), new Set(['repair-first', 'bypass-enabled']));
  assert.ok(result.trials.every(t => t.profileSha256 === result.trials[0].profileSha256 && t.completed && t.failure === null));
  const jev = result.trials.flatMap(t => t.calls.filter(c => c.provider === 'jev'));
  assert.ok(jev.length > 0);
  assert.ok(jev.every(c => c.status === 'ok' && c.model === MOCK_JEV_MODEL));
  assert.ok(result.trials.flatMap(t => t.calls.filter(c => c.provider === 'luna')).every(c => c.model === MOCK_MODEL));
  assert.ok(calls.filter(c => c.phase === 'generation').every(c => c.timeoutMs === manifest.timeouts.generationMs));
  assert.equal(calls.filter(c => c.phase === 'observation_initial').length, 1);
  assert.ok(result.trials.every(t => t.replay.every(r => r.result.status === 'same_material_same_payload')));
});

test('unknown Jev snapshot stops the run, saves its fixed error and skips later trials', async t => {
  const dirs = await fixture(t), manifest = await candidate();
  const { result } = await runSynthetic(manifest, dirs.output, dirs.cache, { returnedModel: 'typesafe/jev-1.14-20990101' });
  assert.equal(result.summary.status, 'wiring_failed');
  assert.equal(result.trials.length, 1);
  assert.equal(result.trials[0].failure, 'model_unknown_version');
  const saved = JSON.parse(await readFile(join(result.directory, 'trial-0.private.json'), 'utf8'));
  const rejected = saved.calls.find((c: { provider: string }) => c.provider === 'jev');
  assert.equal(rejected.error, 'model_unknown_version');
  assert.equal(rejected.status, 'error');
  assert.equal(rejected.model, null);
  assert.equal(rejected.costUsd, 0);
  assert.equal(saved.turns.length, 0);
});

test('shared local deadline aborts AI extraction; late synthetic response cannot commit or send another stage', async t => {
  const dirs = await fixture(t), manifest = await candidate();
  let now = 0, entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const held = new Promise<void>(r => { release = r; });
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let extractionSignal: AbortSignal | undefined, finished = false;
  const work = runSynthetic(manifest, dirs.output, dirs.cache, { async onCall(call) {
    if (call.phase === 'ai_extraction') { extractionSignal = call.signal; entered(); await held; }
  } }).then(value => { finished = true; return value; });
  await started;
  now = manifest.timeouts.localMs - 1;
  t.mock.timers.tick(now);
  await flush();
  assert.equal(finished, false);
  now++;
  t.mock.timers.tick(1);
  const { result, calls } = await work;
  assert.equal(result.summary.status, 'wiring_failed');
  assert.equal(result.trials.length, 1);
  const trial = result.trials[0];
  assert.equal(trial.failure, 'stage_wiring_failed');
  assert.equal(trial.turns.length, 0);
  assert.equal(extractionSignal?.aborted, true);
  const savedBefore = await readFile(join(result.directory, 'trial-0.private.json'), 'utf8');
  const primary = trial.failure, count = calls.length;
  release();
  await flush();
  assert.equal(trial.failure, primary);
  assert.equal(calls.length, count);
  assert.equal(calls.some(c => c.phase === 'ai_function' || c.phase === 'ai_support'), false);
  assert.equal(await readFile(join(result.directory, 'trial-0.private.json'), 'utf8'), savedBefore);
  assert.equal(JSON.parse(savedBefore).deadlines.configured.localMs, manifest.timeouts.localMs);
});
