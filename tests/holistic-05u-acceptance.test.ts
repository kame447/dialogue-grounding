// Independent 05u B1 acceptance. Synthetic records capture the sends they actually made.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { hash } from '../dialogue-model/runtime/diagnostics/parity-verify/core.ts';
import { interventionChecks } from '../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts';
import { LOCAL_FUNCTION_CRITERIA, LOCAL_FUNCTION_CRITERIA_V3 } from '../dialogue-model/runtime/local-grounding/classify.ts';
import type { LocalSegmentProposal } from '../dialogue-model/runtime/local-grounding/contract.ts';
import { buildRecords as buildCurrentRecords } from './support/s4-v3-records.ts';

const gitExec = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const labels = ['repair-first', 'bypass-enabled'] as const;
const producerPaths = [
  'package.json', 'dialogue-model/runtime', 'workers/research-ai-proxy/src',
  'tests/support/s4-v3-records.ts', 'tests/support/s4-integration/harness.ts',
  'tests/support/s4-integration/NORMAL-RECORDS.json',
];
const origins = [
  { lineage: 'legacy', revision: '58a95113ed19effca56e8bd58bd4a46638764231' },
  { lineage: 'style', revision: '07116ae12249f73a49854c4d79d5d22ab60ba640' },
] as const;

const criteriaSets = {
  old: { criteria: LOCAL_FUNCTION_CRITERIA, sha256: '6928dac5034e64294c2308c18671e2820c67ea9f7e2af721f66b56d9792769fc' },
  v3: { criteria: LOCAL_FUNCTION_CRITERIA_V3, sha256: '0cb169368359abf930bdfae3abf853799c53c5e2eebc83e15fc930ea065a7252' },
} as const;
type CriteriaSet = typeof criteriaSets[keyof typeof criteriaSets];
type Records = Awaited<ReturnType<typeof buildCurrentRecords>>;
type BuildRecords = typeof buildCurrentRecords;
type LocalPayload = { state: string; questions: Record<string, { criteria: Record<string, string> }> };
type RecordedSend = {
  provider: string; phase: string; payload: LocalPayload; payloadSha256: string; preProjectionPayloadSha256: string;
};
type Side = { label: string; requests: RecordedSend[] };

async function makeTemp(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), '05u-classifier-lineage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function useClassifierCriteria(directory: string, set: CriteriaSet) {
  const filename = join(directory, 'dialogue-model/runtime/local-grounding/jev-local-test.ts');
  const original = './jev-local-test-05u-original.ts';
  await rename(filename, join(dirname(filename), original));
  // Intercept the mock transport before the sender records its request. Leave
  // the decision, AI-public classifier, and all producer/verifier code intact.
  await writeFile(filename, [
    'export * from ' + JSON.stringify(original) + ';',
    'import { createJevLocalTestClassifier as createOriginal } from ' + JSON.stringify(original) + ';',
    'const criteria = ' + JSON.stringify(set.criteria) + ';',
    'export function createJevLocalTestClassifier(options) {',
    '  const { fetchImpl } = options;',
    '  if (!fetchImpl) throw new Error("05u requires an offline fixture transport");',
    '  return createOriginal({ ...options, fetchImpl(url, init) {',
    '    const body = JSON.parse(String(init.body));',
    '    const state = JSON.parse(body.state);',
    '    if (Object.hasOwn(state, "aiSeq")) throw new Error("05u is only for human local classification");',
    '    for (const [key, question] of Object.entries(body.questions)) {',
    '      if (/^segment_\\d+_act$/u.test(key)) question.criteria = criteria;',
    '    }',
    '    return fetchImpl(url, { ...init, body: JSON.stringify(body) });',
    '  } });',
    '}',
  ].join('\n'));
}

async function buildFrom(directory: string): Promise<BuildRecords> {
  const source = pathToFileURL(join(directory, 'tests/support/s4-v3-records.ts')).href;
  const fixture = await import(source) as { buildRecords: BuildRecords };
  return fixture.buildRecords;
}

const human = 'その輪郭に切れ目がありますか？';
const segment: LocalSegmentProposal = {
  segmentId: '1', quote: human, proposition: human, aspect: 'part',
  targets: [], name: null, linkedIssueId: null, respondsToTurn: null,
};
const turns = [{
  human, plan: {
    action: 'accept', target: 'none', speech: '輪郭についての質問ですね。',
    act: 'ask', extraction: JSON.stringify([segment]),
  },
}];

function capturedSend(records: Records, expected: CriteriaSet) {
  const trial = records.trials[0];
  assert.equal(trial.profile.questionLayout, 'two_stage_v3');
  assert.equal(Object.hasOwn(trial.profile, 'dialoguePolicy'), false);
  const { tape, result } = trial.replay[0];
  const sides = result.sides as Side[];
  assert.deepEqual(sides.map(side => side.label), labels);
  for (const side of sides) {
    const local = side.requests.filter(request => request.phase === 'local_function');
    assert.equal(local.length, 1);
    const send = local[0];
    assert.equal(send.provider, 'jev');
    assert.equal(JSON.parse(send.payload.state).segments.length, 1);
    const criteria = send.payload.questions.segment_0_act.criteria;
    assert.deepEqual(criteria, expected.criteria);
    assert.equal(createHash('sha256').update(JSON.stringify(criteria), 'utf8').digest('hex'), expected.sha256);
    const sha256 = hash(send.payload);
    assert.equal(send.payloadSha256, sha256);
    assert.equal(send.preProjectionPayloadSha256, sha256);
    if (side.label === trial.label) {
      const index = side.requests.indexOf(send);
      assert.equal(tape.recorded.expectedRequests[index].requestSha256, sha256);
      assert.equal(trial.calls[index].requestSha256, sha256);
    }
  }
  return sides.map(side => ({
    label: side.label,
    otherSends: side.requests.filter(send => send.phase !== 'local_function')
      .map(send => [send.provider, send.phase, send.preProjectionPayloadSha256]),
  }));
}
function checkS4(records: Records, verdict: 'pass' | 'mismatch') {
  const before = hash(records);
  const checks = interventionChecks(records);
  assert.equal(hash(records), before);
  assert.deepEqual(['shape', 'binding', 'execution', 'replay'].map(kind =>
    checks.find(check => check.id === 'intervention.trial.0.attempt.0.' + kind)?.status), ['pass', 'pass', 'pass', verdict]);
}

async function compareRecordings(t: TestContext, correct: BuildRecords, crossed: BuildRecords, normal: CriteriaSet, wrong: CriteriaSet) {
  for (const label of labels) {
    const plan = { label, dialoguePolicy: null, turns };
    const original = await correct(plan);
    const mismatched = await crossed(plan);
    const originalSends = capturedSend(original, normal);
    const mismatchedSends = capturedSend(mismatched, wrong);
    assert.deepEqual(mismatchedSends, originalSends, 'all requests outside human classification must be identical');
    await t.test(label + ' accepts the matching criteria', () => checkS4(original, 'pass'));
    await t.test(label + ' rejects the other criteria in replay', () => checkS4(mismatched, 'mismatch'));
  }
}

test('B1 versionless loop records require V3 local classification', async t => {
  // The shallow-checkout control uses only files already present on disk.
  const crossed = await makeTemp(t);
  for (const path of producerPaths) {
    const destination = join(crossed, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(repoRoot, path), destination, { recursive: true });
  }
  await useClassifierCriteria(crossed, criteriaSets.old);
  await compareRecordings(t, buildCurrentRecords, await buildFrom(crossed), criteriaSets.v3, criteriaSets.old);
});

for (const { lineage, revision } of origins) {
  test('B1 versionless ' + lineage + ' records require the historical local classification', async t => {
    try {
      await gitExec('git', ['cat-file', '-e', revision + '^{commit}'], { cwd: repoRoot });
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 1 || error.code === 128)) {
        t.skip('historical Git object is unavailable in this checkout');
        return;
      }
      throw error;
    }
    const original = await makeTemp(t);
    const crossed = await makeTemp(t);
    const archive = join(original, 'source.tar');
    await gitExec('git', ['archive', '--output=' + archive, revision, ...producerPaths], { cwd: repoRoot });
    await gitExec('tar', ['-xf', archive, '-C', original]);
    await gitExec('tar', ['-xf', archive, '-C', crossed]);
    await useClassifierCriteria(crossed, criteriaSets.v3);
    await compareRecordings(t, await buildFrom(original), await buildFrom(crossed), criteriaSets.old, criteriaSets.v3);
  });
}
