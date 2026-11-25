// Synthetic S4 records for the explicit two_stage_v3 layout, built from the real runtime and the real offline replay (no network, key or study data).
// Each turn runs through createProfileDialogue with scripted answers that are recorded into a replay tape, so a multi-turn adaptive history
// (repair history, previous action, prospect) is genuine. The final turn becomes one canonical trial of the NORMAL record set.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { researchTrialProfileV3 } from '../../dialogue-model/runtime/v2/research-profile.ts';
import { createProfileDialogue } from '../../dialogue-model/runtime/diagnostics/parity-live/replay.ts';
import { pairedInterventionReplay } from '../../dialogue-model/runtime/diagnostics/parity-live/intervention-replay.ts';
import { hash } from '../../dialogue-model/runtime/diagnostics/parity-verify/core.ts';
import { createJevDecisionClient } from '../../dialogue-model/runtime/decision/jev-decision.ts';
import type { DialoguePolicy, DraftAct } from '../../dialogue-model/runtime/decision/contract.ts';
import { createJevLocalTestClassifier } from '../../dialogue-model/runtime/local-grounding/jev-local-test.ts';
import { createChatClient } from '../../dialogue-model/runtime/client.mjs';
import { buildReobservationMessages } from '../../dialogue-model/runtime/observation/observe.ts';
import type { RecordedGenerationRetryVersion } from '../../dialogue-model/runtime/v2/generation-guard.ts';
import type { ObservationMemo } from '../../dialogue-model/runtime/observation/contract.ts';
import { image } from './s4-integration/harness.ts';

export const normal = JSON.parse(await readFile(new URL('./s4-integration/NORMAL-RECORDS.json', import.meta.url), 'utf8'));
export const OWN = { ownImage: image, ownAnchors: normal.trials[0].replay[0].result.sides[0].material.own.ownAnchors };
export const MODEL = normal.trials[0].replay[0].result.sides[0].material.model;
export const OLD = normal.trials[0].replay[0].tape;
export type Label = 'repair-first' | 'bypass-enabled';
export type TrialVersion = 'adaptive_repair_v1' | 'adaptive_repair_v2' | 'adaptive_repair_v3';
/** What one scripted turn answers. `target` is a v3 target label; `issue` answers the repair prospect's issue question. */
export type Plan = { action: string; target: string; issue?: string; prospect?: string; actionScores?: Record<string, number>; speech?: string; inject?: any;
  drafts?: readonly string[];
  draftAct?: DraftAct;
  /** Raw JSON text the local-extraction request returns (public name proposals etc.); `act` answers the classifier's `*_act` questions (default assert). */
  extraction?: string; act?: string;
  /** The turn's first decision is a request_observation of figure_0 (one self-side reobservation); `action`/`target` are the terminal decision after it. */
  reobserve?: boolean;
  /** The action question is answered with this label even when it is not offered (a corrupt native response). */
  forceAction?: string;
  /** The name detail question is answered with the candidate whose value is this name (default: the first offered). */
  name?: string;
  /** The classifier's antecedent answer (`claim_0` etc.; default none), for a reply that must be linked to an earlier claim. */
  antecedent?: string;
  /** Raw JSON text the AI-public extraction request returns (the AI's own claims about its public reply); default none. */
  aiExtraction?: string;
  /** The partner-referent estimate's top label (e.g. `multiple`, `figure_3`); default the first offered. */
  referent?: string };
const TEXTS: Record<string, string> = { local_extraction: '[]', ai_extraction: '[]' };

export async function runTurn(profile: any, label: Label, state: any, events: any[], plan: Plan, technicalTrial: { version: TrialVersion } | undefined, generationRetryVersion?: RecordedGenerationRetryVersion) {
  const luna: any[] = [], jev: any[] = [], traces: any[] = [], reobservations: any[] = [], boundary = { luna: -1, jev: -1 };
  let next: any, count = 0, actionCalls = 0, generationCalls = 0, lastAction = '';
  const http = createChatClient({ provider: 'cloudflare', apiKey: 'synthetic-offline-replay-key', purpose: profile.modelPolicy.purpose,
    baseUrl: 'http://offline.invalid/v1', timeoutMs: profile.timeouts.lunaAttemptMs },
  async () => Response.json({ model: next.model, choices: [{ message: { content: next.text } }], usage: { prompt_tokens: 0, completion_tokens: 0 } }));
  const client = { async complete(messages: any[], options: any) {
    const draft = options.phase === 'generation' && plan.drafts ? plan.drafts[generationCalls++] : undefined;
    if (options.phase === 'generation' && plan.drafts) assert.ok(draft);
    const response = { text: options.phase === 'local_extraction' && plan.extraction !== undefined ? plan.extraction : options.phase === 'ai_extraction' && plan.aiExtraction !== undefined ? plan.aiExtraction : draft ?? TEXTS[options.phase] ?? plan.speech ?? 'もう一度、確かめてみますね。', model: 'synthetic-luna-model', usage: { inputTokens: 0, outputTokens: 0 } };
    luna.push({ phase: options.phase, response }); next = response; return http.complete(messages, options); } };
  const readKey = async () => 'sk-or-SYNTHETIC-offline-replay-key-0000';
  const fetchImpl = async (_url: any, init: any) => {
    const body = JSON.parse(init.body), answers: any = {};
    for (const [key, q] of Object.entries(body.questions) as any) {
      const labels = Object.keys(q.criteria);
      if (key === 'action') lastAction = plan.forceAction ?? (plan.reobserve && ++actionCalls === 1 ? 'request_observation' : plan.action);
      const choice = key === 'action' ? lastAction : key === 'target' ? (lastAction === 'request_observation' ? 'figure_0' : plan.target) : key === 'repair_issue' ? plan.issue ?? 'none' : key === 'prospect' ? plan.prospect ?? 'uncertain'
        : key === 'name' && plan.name ? (labels.find(l => JSON.parse(q.criteria[l]).value === plan.name) ?? labels[0])
        : key === 'human_referent' && plan.referent ? plan.referent
        : key === 'draft_naming' ? (plan.draftAct ?? (plan.action === 'agree' ? 'adopt_chosen' : 'none')) : key === 'basis' ? 'partner_uncertain' : key.endsWith('_antecedent') ? (plan.antecedent ?? 'none') : key.endsWith('_act') ? (plan.act && labels.includes(plan.act) ? plan.act : 'assert') : key === 'observe_aspect' ? 'orientation' : labels[0];
      if (!labels.includes(choice) && !(key === 'action' && plan.forceAction)) throw new Error(`scripted choice ${choice} is not offered for ${key}: ${labels.slice(0, 8)}`);
      answers[key] = { type: 'choice', choice, probabilities: Object.fromEntries(labels.map(l => [l, key === 'action' ? plan.actionScores?.[l] ?? (l === choice ? 1 : 0) : l === choice ? 1 : 0])) };
    }
    const response = { model: 'typesafe/jev-1.14', id: 'gen-s4a-' + ++count, usage: { cost: 0 }, answers };
    jev.push(response); return Response.json(response);
  };
  const native = createJevDecisionClient({ enabled: true, readKey, fetchImpl, timeoutMs: profile.timeouts.decisionMs,
    researchLimits: { maxDeadlineMs: 600000 }, questionLayout: profile.questionLayout })!;
  const jevDecision: any = { async decide(input: any, options: any) { if (plan.inject) return structuredClone(plan.inject); const d = await native.decide(input, options);
      if (d.action !== 'request_observation') { boundary.luna = luna.length; boundary.jev = jev.length; } return d; },
    completeDetail: (i: any, s: any, o: any) => native.completeDetail!(i, s, o),
    // The partner-referent estimate is asked only for a turn that scripts one (plan.referent), so every other record keeps its request stream.
    ...(plan.referent ? { estimateReferent: (i: any, o: any) => native.estimateReferent!(i, o) } : {}),
    ...(profile.dialoguePolicy ? { classifyDraftAct: (i: any, o: any) => native.classifyDraftAct!(i, o) } : {}),
    ...(technicalTrial ? { estimateRepairProspect: (i: any, o: any) => native.estimateRepairProspect!(i, o) } : {}) };
  const runtime = createProfileDialogue(profile, { client, image: OWN.ownImage, anchors: [...OWN.ownAnchors], strategy: label,
    observer: { async observeAll() { return structuredClone(OLD.state.observationMemo); },
      async reobserve(input: any) { const result = { observedAt: '2026-01-01T00:00:01.000Z', issue: structuredClone(input.issue),
        figures: input.figureIds.map((figureId: string) => ({ figureId, supports: ['control-feature'], contradicts: [], unknown: [] })) };
        reobservations.push(structuredClone(result)); await client.complete(buildReobservationMessages(input), { phase: 'observation_targeted' }); return result; } }, jevDecision,
    localGrounding: { classifier: createJevLocalTestClassifier({ enabled: true, readKey, fetchImpl, timeoutMs: profile.timeouts.localMs, researchLimits: { maxDeadlineMs: 600000 }, questionLayout: profile.questionLayout,
      ...(['holistic_v3', 'holistic_v5'].includes(profile.dialoguePolicy) ? { dialoguePolicy: profile.dialoguePolicy } : {}) })!,
      aiPublicTransport: { readKey, fetchImpl, timeoutMs: profile.timeouts.decisionMs } },
    onJevTurnTrace: (t: any) => traces.push(t), generationRetryVersion, ...(technicalTrial ? { technicalTrial } : {}) } as any);
  let result: any;
  try { result = await runtime.runAiTurn({ events, privateState: state, lastEventId: events.at(-1).id, requestSeq: events.at(-1).seq }); }
  catch (error) { (error as any).traces = traces; throw error; }
  assert.ok(boundary.luna >= 0);
  return { state: structuredClone(result.privateState), trace: { ...structuredClone(traces.at(-1)), status: 'committed' }, luna, jev, reobservations, boundary, speech: result.text as string };
}

export type Turn = { human: string; plan: Plan };
/** NORMAL rebuilt as one canonical trial whose final turn follows the earlier scripted turns (all of them under `label`). */
/** dialoguePolicy: omitted = the creation default (holistic_v1); null = the earlier version (no policy), for controls of the older lineages. */
export async function buildRecords({ label = 'repair-first' as Label, technicalTrial, turns, ledger, dialoguePolicy, memo, generationRetryVersion, agreeNameScopeVersion }: {
  label?: Label; technicalTrial?: { version: TrialVersion }; turns: Turn[]; ledger?: Record<string, any>; dialoguePolicy?: DialoguePolicy | null; memo?: ObservationMemo; generationRetryVersion?: RecordedGenerationRetryVersion;
  agreeNameScopeVersion?: 'scoped_v1' | 'scoped_v2';
}) {
  const n = structuredClone(normal), tr = n.trials[0], m = n.run.manifest;
  const profile = JSON.parse(JSON.stringify(researchTrialProfileV3(m.lunaRequest, m.timeouts, 'two_stage_v3', dialoguePolicy)));
  const digest = hash(profile);
  for (const s of [n.run, n.summary, tr]) { s.profile = structuredClone(profile); s.profileSha256 = digest; }
  tr.identity.profile = digest; tr.label = label; m.trials[0].label = label; n.summary.runOrder[0].label = label;
  let state: any = structuredClone(OLD.state); if (ledger) state.ledger = structuredClone(ledger);
  if (agreeNameScopeVersion) state.agreeNameScopeVersion = agreeNameScopeVersion;
  if (memo) state.observationMemo = structuredClone(memo);
  let events: any[] = [], seq = 0;
  for (let i = 0; i < turns.length; i++) {
    events = [...events, { id: `human-${++seq}`, seq, speaker: 'human', text: turns[i].human }];
    const run = { state, events: structuredClone(events) };
    const last = i === turns.length - 1;
    if (!last) { const r = await runTurn(profile, label, state, events, turns[i].plan, technicalTrial, generationRetryVersion); state = r.state; events = [...events, { id: `ai-${++seq}`, seq, speaker: 'ai', text: r.speech }]; continue; }
    // The final turn is run once per label: the common segment (before the original decision) is shared, each tail is that label's own.
    const runs = { 'repair-first': await runTurn(profile, 'repair-first', run.state, run.events, turns[i].plan, technicalTrial, generationRetryVersion),
      'bypass-enabled': await runTurn(profile, 'bypass-enabled', run.state, run.events, turns[i].plan, technicalTrial, generationRetryVersion) };
    const a = runs['repair-first'], b = runs['bypass-enabled'];
    assert.deepEqual([a.luna.slice(0, a.boundary.luna), a.jev.slice(0, a.boundary.jev)], [b.luna.slice(0, b.boundary.luna), b.jev.slice(0, b.boundary.jev)]);
    assert.deepEqual(a.reobservations, b.reobservations);
    const seg = (r: any) => ({ luna: r.luna.slice(r.boundary.luna), jev: r.jev.slice(r.boundary.jev), reobservations: [] });
    const version = runs[label].trace.generationRetryVersion ?? generationRetryVersion;
    const tape: any = { schemaVersion: 'parity_intervention_replay_v1', state: run.state, events: run.events,
      common: { luna: a.luna.slice(0, a.boundary.luna), jev: a.jev.slice(0, a.boundary.jev), reobservations: structuredClone(a.reobservations) },
      tails: { 'repair-first': seg(a), 'bypass-enabled': seg(b) }, recorded: { label, expectedRequests: [] }, ...(technicalTrial ? { technicalTrial } : {}),
      ...(version ? { generationRetryVersion: version } : {}) };
    const probe: any = await pairedInterventionReplay(tape, OWN as any, MODEL, profile);
    assert.equal(probe.status === 'not_reached', false, String(probe.error));
    const recorded = probe.sides.find((s: any) => s.label === label);
    tape.recorded.expectedRequests = recorded.requests.map((r: any, k: number) => ({ provider: r.provider, phase: r.phase, requestSha256: r.preProjectionPayloadSha256,
      actualSendMeasured: true, sendIds: [k + 1], ...(r.provider === 'luna' ? { messagesSha256: r.completeMessagesSha256 } : {}) }));
    const result: any = await pairedInterventionReplay(tape, OWN as any, MODEL, profile);
    assert.equal(result.status, 'same_material_intervention_verified', String(result.error));
    const { trace, state: after } = runs[label];
    // The record keeps its own run's intervention, including the measured latency of the alternative's detail evidence (audit/06 R2).
    const template = (provider: string) => normal.trials[0].calls.find((c: any) => c.provider === provider);
    const turn = trace.turnIndex;
    tr.calls = recorded.requests.map((r: any, k: number) => ({ ...structuredClone(template(r.provider)), id: k + 1, sendIds: [k + 1], phase: r.phase, turn,
      requestSha256: r.provider === 'luna' ? r.completeMessagesSha256 : r.preProjectionPayloadSha256,
      ...(r.provider === 'luna' ? { expectedHttpRequestSha256: r.preProjectionPayloadSha256, httpRequestSha256: r.preProjectionPayloadSha256 } : {}) }));
    tr.http = recorded.requests.flatMap((r: any, k: number) => r.provider === 'luna' ? [{ method: 'POST', kind: 'completion_post', phase: r.phase, callId: k + 1, sendId: k + 1,
      hashScheme: 'canonical_json_sha256', requestSha256: r.preProjectionPayloadSha256, status: 200, outcome: 'returned' }] : []);
    tr.attempts = [trace];
    tr.turns = [{ ...structuredClone(tr.turns[0]), turn, publicText: trace.publicSpeech, trace: [structuredClone(trace)], state: structuredClone(after) }];
    tr.lastCommittedState = structuredClone(after); tr.replay = [{ tape, result }];
    n.evidence.pairedReplay = [{ trialOrder: 0, turn, left: result.sides[0], right: result.sides[1] }];
  }
  return JSON.parse(JSON.stringify(n));
}
