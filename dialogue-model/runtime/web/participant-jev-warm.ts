#!/usr/bin/env node
// Researcher-only warm-up. This CLI never starts a participant server.
import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { open, writeFile, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config.mjs';
import { createChatClient } from '../client.mjs';
import { createTrialV2, modelView } from '../stimuli/scatter-v2.mjs';
import { createObservationCache } from '../observation/cache.ts';
import { researchHash } from '../v2/research-profile.ts';
import { RESEARCH_MAX_DEADLINE_MS } from '../v2/research-timeouts.ts';
import { RunBudget } from '../diagnostics/parity-live/audit.ts';
import { validateParticipantJevConfig, participantLedgerFetch, participantLunaClient } from './participant-jev-wiring.ts';
import { privateDirectory, readPrivateAssignment } from './base-assignment-store.ts';
import { data } from '../v2/base-assignment-data.ts';

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({ args: argv, options: { config: { type: 'string' },
    'base-assignment-file': { type: 'string' }, 'confirm-live': { type: 'boolean', default: false }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('node --env-file=.env dialogue-model/runtime/web/participant-jev-warm.ts --config <private-file> --base-assignment-file <private-file> --confirm-live');
    return;
  }
  // The operator must separately authorize paid warm-up and choose all limits.
  if (!values['confirm-live'] || !values.config || !values['base-assignment-file']) throw Error('warmup_not_authorized');
  const file = resolve(values.config);
  await privateDirectory(dirname(file));
  const input = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: unknown;
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 32768) throw Error('invalid_config');
    raw = JSON.parse(await input.readFile('utf8'));
  } finally { await input.close(); }
  const { config, profile } = validateParticipantJevConfig(raw);
  const assignment = await readPrivateAssignment(resolve(values['base-assignment-file']));
  if (!assignment.referenceMemory || assignment.seed !== config.seed) throw Error('invalid_assignment');
  const base = loadConfig(env);
  if (base.provider !== 'cloudflare') throw Error('invalid_provider');
  const policyResponse = await fetch(new URL(base.baseUrl + '/model-policy'), { method: 'GET', redirect: 'error',
    headers: { Authorization: 'Bearer ' + base.apiKey }, signal: AbortSignal.timeout(profile.timeouts.lunaAttemptMs) });
  if (!policyResponse.ok) throw Error('model_policy_unavailable');
  const policy = data(await policyResponse.json());
  if (policy.ready !== true || policy.purpose !== 'dialogue_turn' || policy.model !== config.modelId) throw Error('model_mismatch');
  const budget = new RunBudget(config.limits);
  const { maxCompletionTokens: _oldLimit, ...settings } = base;
  const native = createChatClient({ ...settings, timeoutMs: profile.timeouts.lunaAttemptMs,
    ...(profile.lunaRequest.maxCompletionTokens === null ? {} : { maxCompletionTokens: profile.lunaRequest.maxCompletionTokens }) },
    participantLedgerFetch(budget, 'luna', config.modelId, fetch));
  const client = participantLunaClient({ complete: (messages, options = {}) => native.complete(messages,
    { ...options, timeoutMs: profile.timeouts.lunaAttemptMs }) }, budget, profile);
  const model = modelView(createTrialV2({ seed: config.seed }));
  const own = { ownImage: { mimeType: model.mimeType, base64: model.png.toString('base64') }, ownAnchors: model.anchors };
  const cache = await createObservationCache({ directory: config.cacheDirectory, modelId: config.modelId, client,
    onMiss: 'observe', timeoutMs: profile.timeouts.observationMs, researchLimits: { maxDeadlineMs: RESEARCH_MAX_DEADLINE_MS } });
  const result = await cache.get(own);
  const memoSha256 = researchHash(result.memo), temporary = file + '.' + randomUUID() + '.tmp';
  const receipt = file + '.warmup-' + randomUUID() + '.private.json';
  await writeFile(receipt, JSON.stringify({ schemaVersion: 'participant_jev_warmup_v1',
    memoSha256, audit: result.audit, ledger: budget.snapshot() }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try {
    await writeFile(temporary, JSON.stringify({ ...config, memoSha256 }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
  console.log('participant warm-up ready; private receipt: ' + receipt);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(() => { console.error('participant_jev_warm_failed'); process.exitCode = 1; });
}
