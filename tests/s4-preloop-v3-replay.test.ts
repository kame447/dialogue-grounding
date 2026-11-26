// Dynamic request replay of pre-loop (legacy, style) S4 tapes through the frozen lineage runtime. The tapes were recorded by the real runtime of each lineage commit
// (tests/support/preloop-v3-generate.mts on a checkout of that commit). Synthetic only; no network, key or study data.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { pairedInterventionReplay } from '../dialogue-model/runtime/diagnostics/parity-live/intervention-replay.ts';
import { pairedPreLoopV3Replay } from '../dialogue-model/runtime/diagnostics/parity-live/preloop-v3-replay.ts';
import type { PreLoopLineage } from '../dialogue-model/runtime/diagnostics/parity-live/preloop-v3-replay.ts';
import { MODEL, OLD, OWN, normal } from './support/s4-v3-records.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
type Side = { tape?: any; executed?: any; fallback?: boolean | null; generationError?: string };
const fixture = JSON.parse(readFileSync(join(repo, 'tests/fixtures/s4/preloop-v3-tapes-20261126.json'), 'utf8')) as
  { lineages: Record<PreLoopLineage, { commit: string; profile: any; scenarios: Record<string, Record<'repair-first' | 'bypass-enabled', Side>> }> };
const lineages: PreLoopLineage[] = ['legacy', 'style'];
const other = (lineage: PreLoopLineage): PreLoopLineage => lineage === 'legacy' ? 'style' : 'legacy';
const labels = ['repair-first', 'bypass-enabled'] as const;
const run = (lineage: PreLoopLineage, tape: any, profile: any, as: any = { lineage }) => pairedPreLoopV3Replay(structuredClone(tape), OWN as any, MODEL, structuredClone(profile), as);
const tapes = (lineage: PreLoopLineage) => Object.entries(fixture.lineages[lineage].scenarios).flatMap(([name, sides]) =>
  labels.flatMap(label => sides[label].tape ? [{ name, label, tape: sides[label].tape, side: sides[label] }] : []));

for (const lineage of lineages) {
  const { profile } = fixture.lineages[lineage];

  test(`${lineage}: every recorded scenario replays to a verified intervention in both strategies`, async () => {
    const list = tapes(lineage);
    assert.ok(list.length >= 13, 'scenarios S1-S7 (legacy S7 cannot be generated: it has no fallback)');
    for (const { name, label, tape } of list) {
      const result = await run(lineage, tape, profile);
      assert.equal(result.status, 'same_material_intervention_verified', `${name} ${label}: ${result.error}`);
      assert.equal(result.commonEqual && result.policyConformant && result.recordedPayloadsReproduced, true, `${name} ${label}`);
    }
  });

  test(`${lineage}: naming the other lineage never verifies (no fallback to the other lineage)`, async () => {
    for (const { name, label, tape } of tapes(lineage)) {
      const result = await run(lineage, tape, profile, { lineage: other(lineage) });
      assert.notEqual(result.status, 'same_material_intervention_verified', `${name} ${label}`);
    }
  });

  test(`${lineage}: the current runtime's replay does not reproduce these requests, and cannot run the name and agree paths`, async () => {
    for (const { name, label, tape } of tapes(lineage)) {
      const result = await pairedInterventionReplay(structuredClone(tape), OWN as any, MODEL, structuredClone(profile));
      assert.notEqual(result.status, 'same_material_intervention_verified', `${name} ${label}`);
      if (/^S[34]-/u.test(name)) assert.equal(result.status, 'not_reached', `${name} ${label}: the current catalog drops a partner's name and the current agree candidates differ`);
    }
  });
}

test('the recorded scenarios exercise the lineage differences they are named for', () => {
  const executed = (lineage: PreLoopLineage, name: string, label: 'repair-first' | 'bypass-enabled') => fixture.lineages[lineage].scenarios[name][label].executed?.action;
  for (const lineage of lineages) {
    assert.equal(executed(lineage, 'S3-propose-partner-name', 'repair-first'), 'propose_name', lineage + ': a partner-proposed name stays a candidate');
    assert.equal(executed(lineage, 'S4-agree-unbound', 'repair-first'), 'agree', lineage + ': an unbound partner proposal can be agreed');
    assert.deepEqual([executed(lineage, 'S2-defer-veto', 'repair-first'), executed(lineage, 'S2-defer-veto', 'bypass-enabled')], ['accept', 'defer'], lineage + ': the veto differs by strategy');
  }
  assert.equal(fixture.lineages.style.scenarios['S7-orientation-leak-twice']['repair-first'].fallback, true, 'style falls back after two orientation leaks');
  assert.equal(fixture.lineages.legacy.scenarios['S7-orientation-leak-twice']['repair-first'].generationError, 'unsafe_generation', 'legacy has no fallback');
});

// One item at a time (parity-verify/README): each corruption of a genuine tape is detected, and never verifies.
const tamper = (lineage: PreLoopLineage, scenario: string, label: 'repair-first' | 'bypass-enabled', change: (tape: any) => void) => {
  const { profile, scenarios } = fixture.lineages[lineage];
  const tape = structuredClone(scenarios[scenario][label].tape);
  change(tape);
  return run(lineage, tape, profile);
};
for (const lineage of lineages) {
  const scenario = 'S3-propose-partner-name', label = 'bypass-enabled' as const;
  test(`${lineage}: one changed recorded request hash is a mismatch`, async () => {
    const result = await tamper(lineage, scenario, label, tape => { const r = tape.recorded.expectedRequests[1]; r.requestSha256 = (r.requestSha256[0] === '0' ? '1' : '0') + r.requestSha256.slice(1); });
    assert.equal(result.status, 'same_material_intervention_mismatch');
    assert.equal(result.recordedPayloadsReproduced, false);
  });
  test(`${lineage}: missing, extra or unusable material is refused and never verified`, async () => {
    const missing = await tamper(lineage, scenario, label, tape => { tape.common.jev.pop(); });
    assert.deepEqual([missing.status, missing.error], ['not_reached', 'replay_material_missing']);
    const noTail = await tamper(lineage, scenario, label, tape => { tape.tails['bypass-enabled'] = null; });
    assert.deepEqual([noTail.status, noTail.error], ['not_reached', 'replay_material_missing']);
    const extra = await tamper(lineage, scenario, label, tape => { tape.common.jev.push(structuredClone(tape.common.jev[0])); });
    assert.equal(extra.status, 'not_reached');
    assert.equal(extra.error, 'replay_unused_material');
    const stray = await tamper(lineage, scenario, label, tape => { tape.generationRetryVersion = 'jev_generation_retry_v2'; });
    assert.deepEqual([stray.status, stray.error], ['not_reached', 'replay_material_invalid']);
    const scope = await tamper(lineage, scenario, label, tape => { tape.state.agreeNameScopeVersion = 'scoped_v1'; });
    assert.notEqual(scope.status, 'same_material_intervention_verified');
  });
  test(`${lineage}: a state the lineage never wrote does not verify`, async () => {
    const changed = await tamper(lineage, scenario, label, tape => { tape.state.ledger[Object.keys(tape.state.ledger)[0]] = { status: 'agreed', name: 'なりすまし' }; });
    assert.notEqual(changed.status, 'same_material_intervention_verified');
  });
  test(`${lineage}: an unusable lineage option, a holistic profile or a getter is refused without running anything`, async () => {
    const { profile, scenarios } = fixture.lineages[lineage];
    const tape = scenarios[scenario][label].tape;
    for (const bad of [{ lineage: 'loop' }, { lineage: 'holistic_v1' }, {}, { lineage, extra: true }, null, 'legacy']) {
      const result = await run(lineage, tape, profile, bad);
      assert.deepEqual([result.status, result.error], ['not_reached', 'replay_material_invalid'], JSON.stringify(bad));
    }
    let touched = false;
    const hostile = Object.defineProperty({}, 'lineage', { enumerable: true, get() { touched = true; return lineage; } });
    assert.equal((await run(lineage, tape, profile, hostile)).error, 'replay_material_invalid');
    assert.equal(touched, false, 'the getter is never invoked');
    const holistic = await run(lineage, tape, { ...structuredClone(profile), dialoguePolicy: 'holistic_v1' });
    assert.deepEqual([holistic.status, holistic.error], ['not_reached', 'replay_material_invalid']);
  });
}

const withoutLatency = (value: any): any => Array.isArray(value) ? value.map(withoutLatency) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === 'latencyMs' ? 0 : withoutLatency(child)])) : value;
// With history, the tapes are regenerated from a real checkout of each lineage commit and must be the recorded ones (the independent link to the lineage's own code).
for (const lineage of lineages) {
  test(`${lineage}: with history, a fresh run of the lineage commit's own runtime records the same tapes (skipped in a shallow clone)`, async t => {
    const { commit, scenarios } = fixture.lineages[lineage];
    try { execFileSync('git', ['cat-file', '-e', commit + '^{commit}'], { cwd: repo, stdio: 'ignore' }); } catch { return t.skip('lineage commit is not in this clone'); }
    const root = mkdtempSync(join(tmpdir(), 'preloop-' + lineage + '-'));
    try {
      execFileSync('sh', ['-c', `git archive ${commit} dialogue-model workers | tar -x -C ${root}`], { cwd: repo, stdio: 'ignore' });
      const { generateTape, loadModules } = await import('./support/preloop-v3-generate.mts');
      const { scenarios: build } = await import('./support/preloop-v3-scenarios.mts');
      const modules = await loadModules(root);
      const ctx = { OWN, MODEL, OLD, normal };
      for (const scenario of build(OWN.ownAnchors[0].id as string)) for (const label of labels) {
        const recorded = scenarios[scenario.name][label];
        let fresh: any = null;
        try { fresh = await generateTape(modules, ctx, scenario, label); } catch (error) { assert.equal((error as Error).message, recorded.generationError, scenario.name); continue; }
        // Measured latencies are the only run-dependent values (an earlier turn's saved evidence); everything else must be identical.
        assert.deepEqual(withoutLatency(fresh.tape), withoutLatency(recorded.tape), `${scenario.name} ${label}`);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
