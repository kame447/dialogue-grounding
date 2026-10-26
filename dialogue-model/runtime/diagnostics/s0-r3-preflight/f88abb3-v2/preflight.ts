// main f88abb3 / manifest v2 only. This file cannot launch a real model.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { validateRunManifestV2 } from '../../parity-live/manifest.ts';
import { researchTrialProfileV2, researchHash } from '../../../v2/research-profile.ts';
import { runSynthetic } from './mock.ts';

export const BASELINE_HEAD = 'f88abb32736141ac7ad6dd2fee4740df3a019490';
export const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const git = promisify(execFile);
const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
type Pins = { baselineHead: string; scope: string; files: { path: string; sha256: string }[] };
export type BaselineSnapshot = { head: string; files: Pins['files'] };

async function loadPins() {
  const bytes = await readFile(new URL('./pins.json', import.meta.url));
  const pins = JSON.parse(bytes.toString('utf8')) as Pins;
  if (pins.baselineHead !== BASELINE_HEAD || pins.scope !== 'main-f88abb3-v2-dry-only' || !pins.files.length) throw Error('baseline_pins_invalid');
  return { pins, pinsSha256: sha256(bytes) };
}

/** Compare a recorded subject without depending on the current checkout/history. */
export async function compareBaselineSnapshot(subject: BaselineSnapshot) {
  const { pins, pinsSha256 } = await loadPins();
  if (!subject || subject.head !== BASELINE_HEAD) throw Error('baseline_head_mismatch');
  if (!isDeepStrictEqual(subject, { head: BASELINE_HEAD, files: pins.files })) throw Error('baseline_source_mismatch');
  return { baselineHead: BASELINE_HEAD, subjectHead: subject.head, sourceFiles: pins.files.length, pinsSha256 };
}

export async function assertBaselineHead(subjectHead: string, root = ROOT) {
  try { await git('git', ['merge-base', '--is-ancestor', BASELINE_HEAD, subjectHead], { cwd: root }); }
  catch { throw Error('baseline_head_mismatch'); }
}

/** The immutable file set is the complete tracked runtime at the baseline. */
export async function inspectBaseline(root = ROOT, readBytes = (path: string) => readFile(path)) {
  const { pins, pinsSha256 } = await loadPins();
  const { stdout } = await git('git', ['rev-parse', 'HEAD'], { cwd: root });
  const subjectHead = stdout.trim();
  // Allow a descendant containing only this new tooling; pin every baseline runtime byte.
  await assertBaselineHead(subjectHead, root);
  for (const pin of pins.files) {
    if (!pin.path.startsWith('dialogue-model/runtime/') || pin.path.includes('..') || !/^[a-f0-9]{64}$/u.test(pin.sha256)) throw Error('baseline_pins_invalid');
    if (sha256(await readBytes(join(root, pin.path))) !== pin.sha256) throw Error('baseline_source_mismatch');
  }
  return { baselineHead: BASELINE_HEAD, subjectHead, sourceFiles: pins.files.length, pinsSha256 };
}

export async function checkDraft(value: unknown, recordedSubject?: BaselineSnapshot) {
  const manifest = validateRunManifestV2(value);
  // This candidate is deliberately pending, even if its source template was approved.
  if (manifest.approval !== 'pending') throw Error('mock_manifest_must_be_pending');
  // Only the library's unit-test boundary accepts a recorded subject. The CLI
  // always omits it and verifies real disk bytes and ancestry via inspectBaseline.
  const baseline = recordedSubject === undefined ? await inspectBaseline() : await compareBaselineSnapshot(recordedSubject);
  const profile = researchTrialProfileV2(manifest.lunaRequest, manifest.timeouts);
  return { draft: true, launchAuthorized: false, scope: 'main-f88abb3-v2-dry-only', ...baseline,
    manifestSha256: researchHash(manifest), profileSha256: researchHash(profile), profile };
}

export async function main(args: string[]) {
  const [mode, manifestPath] = args;
  if (mode?.startsWith('--live')) return { exitCode: 2, report: { draft: true, launchAuthorized: false, reason: 'draft_live_unapproved' } };
  if (!['--check-draft', '--dry-mock'].includes(mode) || args.length > 2) return { exitCode: 2, report: { draft: true, launchAuthorized: false, reason: 'arguments_invalid' } };
  try {
    const manifest = JSON.parse(await readFile(manifestPath ?? new URL('./manifest.mock.json', import.meta.url), 'utf8'));
    const checked = await checkDraft(manifest);
    if (mode === '--check-draft') return { exitCode: 0, report: { ...checked, mode } };
    const root = await mkdtemp(join(tmpdir(), 's0-r3-preflight-'));
    try {
      const { result } = await runSynthetic(validateRunManifestV2(manifest), join(root, 'output'), join(root, 'cache'));
      const passed = result.summary.status === 'wiring_passed';
      return { exitCode: passed ? 0 : 1, report: { ...checked, mode, synthetic: true, status: result.summary.status, trials: result.trials.length } };
    } finally { await rm(root, { recursive: true, force: true }); }
  } catch {
    // Do not expose paths, model payloads or native error responses.
    return { exitCode: 1, report: { draft: true, launchAuthorized: false, reason: 'draft_preflight_rejected' } };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { exitCode, report } = await main(process.argv.slice(2));
  console.log(JSON.stringify(report));
  process.exitCode = exitCode;
}
