// The frozen pre-loop (legacy, style) runtime copies: what they are pinned to, where they live and what may not import them. Synthetic only; no network.
// The copies are the original files at the lineage commits with only relative import specifiers rewritten, so the check is: every file is pinned by SHA-256,
// the pinned original equals the copy once import specifiers are normalized (shallow clones too), and with history the real `git show` blob says the same.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frozenRoot = join(repo, 'dialogue-model/runtime/diagnostics/parity-live/frozen/preloop-v3');
const pins = JSON.parse(readFileSync(join(repo, 'tests/fixtures/s4/preloop-v3-frozen-pins.json'), 'utf8')) as {
  lineages: Record<string, { commit: string; files: Array<{ source: string; sourceBlob: string; sourceSha256: string; frozen: string; frozenSha256: string; normalizedSha256: string }> }> };
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const specifier = /(from\s+|import\s*\(\s*|import\s+)(['"])(\.{1,2}\/[^'"]+)\2/gu;
const normalize = (text: string) => text.replace(specifier, (_all, lead: string, quote: string) => `${lead}${quote}<rel>${quote}`);
const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? (name === 'node_modules' || name === '.git' ? [] : walk(path)) : [path];
});
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] });
const hasCommit = (commit: string) => { try { git('cat-file', '-e', commit + '^{commit}'); return true; } catch { return false; } };

test('the frozen set is exactly the pinned files, byte for byte', () => {
  for (const [lineage, { files }] of Object.entries(pins.lineages)) {
    const present = walk(join(frozenRoot, lineage)).map(path => relative(frozenRoot, path)).sort();
    assert.deepEqual(present, files.map(file => file.frozen).sort(), lineage + ': no file beyond the pinned set, none missing');
    for (const file of files) assert.equal(sha(readFileSync(join(frozenRoot, file.frozen))), file.frozenSha256, file.frozen);
  }
});

test('every frozen file equals its pinned original once relative import specifiers are normalized (works without history)', () => {
  for (const { files } of Object.values(pins.lineages)) for (const file of files) {
    const frozen = readFileSync(join(frozenRoot, file.frozen), 'utf8');
    assert.equal(sha(normalize(frozen)), file.normalizedSha256, file.frozen + ': only import lines may differ from the original');
    assert.ok(frozen.length > 0);
  }
});

for (const [lineage, { commit, files }] of Object.entries(pins.lineages)) {
  test(`${lineage}: with history, the frozen files match the blobs of ${commit.slice(0, 7)} (skipped in a shallow clone)`, t => {
    if (!hasCommit(commit)) return t.skip('lineage commit is not in this clone');
    for (const file of files) {
      const original = git('show', `${commit}:${file.source}`);
      assert.equal(git('rev-parse', `${commit}:${file.source}`).toString().trim(), file.sourceBlob, file.source + ': blob id');
      assert.equal(sha(original), file.sourceSha256, file.source + ': original bytes');
      assert.equal(normalize(readFileSync(join(frozenRoot, file.frozen), 'utf8')), normalize(original.toString('utf8')), file.frozen + ': differs from the original outside import lines');
    }
  });
}

const sourceFiles = (dir: string) => walk(join(repo, dir)).filter(path => /\.(ts|mts|mjs|js|tsx)$/u.test(path));
const importsFrozen = (path: string) => /preloop-v3\/|preloop-v3-replay|frozen\/preloop/u.test(readFileSync(path, 'utf8'));

test('no live, participant, worker or verifier path imports the frozen copies or their replay', () => {
  const allowed = new Set([join(repo, 'dialogue-model/runtime/diagnostics/parity-live/preloop-v3-replay.ts')]);
  for (const dir of ['dialogue-model', 'workers']) for (const path of sourceFiles(dir)) {
    if (path.startsWith(frozenRoot) || allowed.has(path)) continue;
    assert.equal(importsFrozen(path), false, relative(repo, path) + ' must not reference the frozen pre-loop copies');
  }
  // The frozen set reaches no live path either: it may only import its own files and current pure modules, never the live harness or the participant web path.
  for (const path of walk(frozenRoot).filter(file => /\.(mts|mjs)$/u.test(file))) {
    for (const match of readFileSync(path, 'utf8').matchAll(specifier)) {
      const target = resolve(dirname(path), match[3]);
      assert.ok(!/\/parity-live\/(live|replay|intervention-replay)\.ts$/u.test(target) && !target.includes('/runtime/web/'), `${relative(repo, path)} imports ${match[3]}`);
    }
  }
});

test('the runtime type check explicitly leaves the frozen copies out, and they are .mts files', () => {
  const config = JSON.parse(readFileSync(join(repo, 'tsconfig.runtime.json'), 'utf8')) as { exclude?: string[]; include: string[] };
  assert.ok(config.exclude?.includes('dialogue-model/runtime/diagnostics/parity-live/frozen/**'), 'excluded from tsc: they are historical code written for older sibling modules');
  for (const path of walk(frozenRoot)) assert.match(path, /\.(mts|mjs|md)$/u, relative(repo, path));
});
