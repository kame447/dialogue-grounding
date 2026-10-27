/** Synthetic P1 transport setup adapted from tests/participant-jev-wiring.test.ts. */
import {spawn} from 'node:child_process';
import {mkdir, readFile, writeFile, rm, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {createTrialV2, modelView} from '../../stimuli/scatter-v2.mjs';
import {createObservationCache} from '../../observation/cache.ts';
import {researchHash} from '../../v2/research-profile.ts';
import {prepareParticipantJev} from '../../web/participant-jev-wiring.ts';
import {startNamingServer} from '../../web/server.mjs';
import {driveParticipant} from './harness.ts';
import {createPersona, mockHuman} from './simulator.ts';
import type {HumanInput, HumanOutput} from './simulator.ts';

/** Optional synthetic controls: the technical-trial option, the assignment label and Jev's stage-one actions in call order. */
export type OfflineOptions = {technicalTrial?: boolean; strategy?: 'repair-first' | 'bypass-enabled'; jevActions?: readonly string[]};
export async function startOfflineParticipant(outputDirectory: string, {technicalTrial = false, strategy = 'repair-first', jevActions = []}: OfflineOptions = {}) {
  await mkdir(outputDirectory, {recursive: true, mode: 0o700});
  const directory = await realpath(outputDirectory);
  const seed = 919, modelId = 'synthetic-luna-20261020', trial = createTrialV2({seed}), model = modelView(trial);
  const own = {ownImage: {mimeType: model.mimeType, base64: model.png.toString('base64')}, ownAnchors: model.anchors};
  const rawMemo = {figures: model.anchors.map((a: any) => ({id: a.id, holistic: [],
    analytic: {shapes: ['三角'], composition: '二つの部分が接する', relations: []}, unknowns: []}))};
  const cacheDirectory = join(directory, 'cache'); await mkdir(cacheDirectory, {mode: 0o700});
  const warm = await createObservationCache({directory: cacheDirectory, modelId, onMiss: 'observe',
    client: {async complete() { return {text: JSON.stringify(rawMemo), model: modelId}; }}});
  const hit = await warm.get(own);
  const assignment = {schemaVersion: 'base_assignment_config_v1', configId: '11111111-1111-4111-8111-111111111111',
    revision: 1, strategy, seed, referenceMemory: true};
  const config = {schemaVersion: 'participant_jev_config_v1', lunaRequest: {timeoutMs: null, maxCompletionTokens: 1000},
    timeouts: {observationMs: 20000, localMs: 20000, decisionMs: 20000, lunaAttemptMs: 80000, generationMs: 40000, trialMs: 600000},
    cacheDirectory, modelId, memoSha256: researchHash(hit.memo), seed,
    limits: {lunaCalls: 100, lunaTokens: 100000, lunaPosts: 100, jevPosts: 100, jevUsd: 0.05},
    ...(technicalTrial ? {technicalTrial: {version: 'adaptive_repair_v1'}} : {})};
  const configFile = join(directory, 'participant-jev.json'), baseAssignmentFile = join(directory, 'assignment.json');
  await writeFile(configFile, JSON.stringify(config), {mode: 0o600});
  await writeFile(baseAssignmentFile, JSON.stringify(assignment), {mode: 0o600});
  let generations = 0, lunaPosts = 0, jevPosts = 0, decisions = 0;
  // This transport NEVER calls native fetch, regardless of the requested upstream URL.
  const fetchImpl: typeof fetch = async (_url, init = {}) => {
    if (init.method === 'GET') return Response.json({ready: true, purpose: 'dialogue_turn', provider: 'openai', model: modelId});
    const body = JSON.parse(String(init.body));
    if (body.questions) {
      jevPosts++;
      const action = 'action' in body.questions ? jevActions[decisions++] ?? 'accept' : 'accept';
      const targeted = ['propose_name', 'agree', 'confirm', 'repair'].includes(action);
      const answers = Object.fromEntries(Object.entries(body.questions).map(([name, q]: [string, any]) => {
        const choices = Object.keys(q.criteria);
        const chosen = name === 'action' ? action : name === 'target' && targeted ? 'figure_0' :
          name === 'target' || name === 'human_referent' || name.endsWith('_antecedent') ? 'none' :
          name.startsWith('candidate_') ? 'exclude' : name.endsWith('_act') ? 'assert' : choices[0];
        if (!choices.includes(chosen)) throw new Error('synthetic_jev_fixture_mismatch');
        return [name, {type: 'choice', choice: chosen,
          probabilities: Object.fromEntries(choices.map(v => [v, v === chosen ? 1 : 0])), confidence: 1}];
      }));
      return Response.json({model: 'typesafe/jev-1.14-20261014', id: 'gen-synthetic', usage: {cost: 0.00001}, answers});
    }
    lunaPosts++;
    let parsed: any; try { parsed = JSON.parse(body.messages[1]?.content); } catch { /* generation may be prose */ }
    const final = String(body.messages.at(-1)?.content).includes('JSON') && !parsed?.candidateText && !parsed?.publicTurns;
    const text = parsed?.candidateText || parsed?.publicTurns ? '[]' : final ?
      JSON.stringify(Object.fromEntries(model.anchors.map((a: any) => [a.id, null]))) :
      ++generations % 2 ? '細い部分はありますか？' : 'その細い部分を目印に「合図」と呼びましょう。';
    return Response.json({model: modelId, choices: [{message: {content: text}}], usage: {prompt_tokens: 3, completion_tokens: 2}});
  };
  const prepared = await prepareParticipantJev({configFile, baseAssignmentFile,
    clientConfig: {provider: 'cloudflare', purpose: 'dialogue_turn', baseUrl: 'https://synthetic.invalid/v1', apiKey: 'synthetic-proxy-only'},
    fetchImpl, readKey: async () => 'sk-or-synthetic-only-private-key-0123456789'});
  const baseStoreRoot = join(directory, 'owners'); await mkdir(baseStoreRoot, {mode: 0o700});
  const adminToken = 'synthetic-adaptive-human-admin-0000000000000000';
  const server = await startNamingServer({port: 0, client: {}, participantJev: prepared, baseAssignmentFile, baseStoreRoot, adminToken,
    adminLimiter: {async limit() { return {success: true}; }}} as any);
  const appOrigin = 'http://127.0.0.1:' + (server.address() as {port: number}).port;
  return {directory, appOrigin, counts: () => ({lunaPosts, jevPosts}),
    close: () => (server as any).drainAndClose() as Promise<void>,
    async exportRecord(id: string) {
      const exported = await fetch(appOrigin + '/admin/record/' + id + '.json', {headers: {Authorization: 'Bearer ' + adminToken}});
      if (!exported.ok) throw new Error('synthetic_record_export_failed');
      await writeFile(join(directory, 'record.private.json'), await exported.text(), {mode: 0o600});
    }};
}

export async function runOffline(options: {directory: string; chrome?: string; cdpOrigin?: string; maxTurns?: number; personaSeed?: number;
  simulator?: (input: HumanInput) => HumanOutput; beforeSimulatorTurn?: () => Promise<void>} & OfflineOptions) {
  if (!options.chrome && !options.cdpOrigin) throw new Error('chrome_or_cdp_required');
  const offline = await startOfflineParticipant(options.directory, options);
  const {directory, appOrigin} = offline;
  const profile = join(directory, 'chrome-profile');
  const chrome = options.cdpOrigin ? undefined : spawn(options.chrome!, ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--user-data-dir=' + profile, '--no-first-run', '--disable-background-networking', 'about:blank'], {stdio: 'ignore'});
  let chromeError = false;
  chrome?.on('error', () => { chromeError = true; });
  const chromeExited = chrome ? new Promise<void>(resolve => {chrome.once('exit', () => resolve()); chrome.once('error', () => resolve());}) : Promise.resolve();
  try {
    let cdpOrigin = options.cdpOrigin;
    if (chrome) {
      let port: number | undefined;
      for (let attempt = 0; attempt < 150; attempt++) {
        if (chromeError || chrome.exitCode !== null || chrome.signalCode !== null) throw new Error('chrome_start_failed');
        try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break; } catch { /* bounded startup wait */ }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!port) throw new Error('chrome_start_timeout');
      cdpOrigin = 'http://127.0.0.1:' + port;
    }
    const result = await driveParticipant({appOrigin, cdpOrigin: cdpOrigin!, outputDirectory: directory,
      persona: createPersona(options.personaSeed ?? 20261027), simulator: options.simulator ?? mockHuman, beforeSimulatorTurn: options.beforeSimulatorTurn,
      maxTurns: options.maxTurns ?? 3, timeoutMs: 30000});
    await offline.exportRecord(result.sessionId!);
    return {...result, ...offline.counts()};
  } finally {
    if (chrome && chrome.exitCode === null && chrome.signalCode === null && !chromeError) chrome.kill('SIGTERM');
    const timer = setTimeout(() => chrome?.kill('SIGKILL'), 3000);
    await chromeExited; clearTimeout(timer);
    await offline.close();
    if (chrome) await rm(profile, {recursive: true, force: true});
  }
}
