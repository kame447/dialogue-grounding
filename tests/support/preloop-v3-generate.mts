// Generates synthetic S4 intervention-replay tapes (both strategies, final turn) from the runtime modules of ONE source tree: a historical lineage checkout
// (the independent record of what that lineage did), the frozen copy, or the current tree (a control). No network, key or study data.
// The turn runner and the tape assembly are the ones tests/support/s4-v3-records.ts uses; only the module set is injected.
import { ok } from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export type Scenario = { name: string; technicalTrial?: { version: string }; turns: Array<{ human: string; plan: any }> };
export async function loadModules(root: string, lineageRoot: string | null = null) {
  const at = (p: string) => import(pathToFileURL(`${root}/dialogue-model/runtime/${p}`).href);
  const from = (p: string) => lineageRoot ? import(pathToFileURL(`${lineageRoot}/${p}`).href) : at(p);
  const [client, replay, decision, localTest, observe, interventionReplay, profileMod] = await Promise.all([
    at('client.mjs'), at('diagnostics/parity-live/replay.ts'), from('decision/jev-decision.' + (lineageRoot ? 'mts' : 'ts')),
    from('local-grounding/jev-local-test.' + (lineageRoot ? 'mts' : 'ts')), at('observation/observe.ts'),
    at('diagnostics/parity-live/intervention-replay.ts'), at('v2/research-profile.ts')]);
  return { createChatClient: client.createChatClient, createProfileDialogue: replay.createProfileDialogue, createJevDecisionClient: decision.createJevDecisionClient,
    createJevLocalTestClassifier: localTest.createJevLocalTestClassifier, buildReobservationMessages: observe.buildReobservationMessages,
    pairedInterventionReplay: interventionReplay.pairedInterventionReplay, researchTrialProfileV3: profileMod.researchTrialProfileV3 };
}
/** What one scripted turn answers. `target` is a v3 target label; `issue` answers the repair prospect's issue question. */
type Plan = { action: string; target: string; issue?: string; prospect?: string; actionScores?: Record<string, number>; speech?: string; inject?: any;
  drafts?: readonly string[];
  draftAct?: string;
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
  /** Function labels by segment for the AI's public extraction. */
  aiActs?: readonly string[];
  /** The partner-referent estimate's top label (e.g. `multiple`, `figure_3`); default the first offered. */
  referent?: string };
const TEXTS: Record<string, string> = { local_extraction: '[]', ai_extraction: '[]' };

async function runTurn(M: any, ctx: any, profile: any, label: string, state: any, events: any[], plan: Plan, technicalTrial: { version: string } | undefined, generationRetryVersion?: string) {
  const luna: any[] = [], jev: any[] = [], traces: any[] = [], reobservations: any[] = [], boundary = { luna: -1, jev: -1 };
  let next: any, count = 0, actionCalls = 0, generationCalls = 0, lastAction = '';
  const http = M.createChatClient({ provider: 'cloudflare', apiKey: 'synthetic-offline-replay-key', purpose: profile.modelPolicy.purpose,
    baseUrl: 'http://offline.invalid/v1', timeoutMs: profile.timeouts.lunaAttemptMs },
  async () => Response.json({ model: next.model, choices: [{ message: { content: next.text } }], usage: { prompt_tokens: 0, completion_tokens: 0 } }));
  const client = { async complete(messages: any[], options: any) {
    const draft = options.phase === 'generation' && plan.drafts ? plan.drafts[generationCalls++] : undefined;
    if (options.phase === 'generation' && plan.drafts) ok(draft);
    const response = { text: options.phase === 'local_extraction' && plan.extraction !== undefined ? plan.extraction : options.phase === 'ai_extraction' && plan.aiExtraction !== undefined ? plan.aiExtraction : draft ?? TEXTS[options.phase] ?? plan.speech ?? 'もう一度、確かめてみますね。', model: 'synthetic-luna-model', usage: { inputTokens: 0, outputTokens: 0 } };
    luna.push({ phase: options.phase, response }); next = response; return http.complete(messages, options); } };
  const readKey = async () => 'sk-or-SYNTHETIC-offline-replay-key-0000';
  const fetchImpl = async (_url: any, init: any) => {
    const body = JSON.parse(init.body), answers: any = {};
    for (const [key, q] of Object.entries(body.questions) as any) {
      const labels = Object.keys(q.criteria);
      const aiSegment = plan.aiActs && Object.hasOwn(JSON.parse(body.state), 'aiSeq') ? /^segment_(\d+)_act$/u.exec(key) : null;
      const publicAct = aiSegment ? plan.aiActs?.[Number(aiSegment[1])] : undefined;
      if (key === 'action') lastAction = plan.forceAction ?? (plan.reobserve && ++actionCalls === 1 ? 'request_observation' : plan.action);
      const choice = key === 'action' ? lastAction : key === 'target' ? (lastAction === 'request_observation' ? 'figure_0' : plan.target) : key === 'repair_issue' ? plan.issue ?? 'none' : key === 'prospect' ? plan.prospect ?? 'uncertain'
        : key === 'name' && plan.name ? (labels.find(l => JSON.parse(q.criteria[l]).value === plan.name) ?? labels[0])
        : key === 'human_referent' && plan.referent ? plan.referent
        : key === 'draft_naming' ? (plan.draftAct ?? (plan.action === 'agree' ? 'adopt_chosen' : 'none')) : key === 'basis' ? 'partner_uncertain' : key.endsWith('_antecedent') ? (plan.antecedent ?? 'none') : key.endsWith('_act') ? (publicAct ?? (plan.act && labels.includes(plan.act) ? plan.act : 'assert')) : key === 'observe_aspect' ? 'orientation' : labels[0];
      if (!labels.includes(choice) && !(key === 'action' && plan.forceAction)) throw new Error(`scripted choice ${choice} is not offered for ${key}: ${labels.slice(0, 8)}`);
      answers[key] = { type: 'choice', choice, probabilities: Object.fromEntries(labels.map(l => [l, key === 'action' ? plan.actionScores?.[l] ?? (l === choice ? 1 : 0) : l === choice ? 1 : 0])) };
    }
    const response = { model: 'typesafe/jev-1.14', id: 'gen-s4a-' + ++count, usage: { cost: 0 }, answers };
    jev.push(response); return Response.json(response);
  };
  const native = M.createJevDecisionClient({ enabled: true, readKey, fetchImpl, timeoutMs: profile.timeouts.decisionMs,
    researchLimits: { maxDeadlineMs: 600000 }, questionLayout: profile.questionLayout })!;
  const jevDecision: any = { async decide(input: any, options: any) { if (plan.inject) return structuredClone(plan.inject); const d = await native.decide(input, options);
      if (d.action !== 'request_observation') { boundary.luna = luna.length; boundary.jev = jev.length; } return d; },
    completeDetail: (i: any, s: any, o: any) => native.completeDetail!(i, s, o),
    // The partner-referent estimate is asked only for a turn that scripts one (plan.referent), so every other record keeps its request stream.
    ...(plan.referent ? { estimateReferent: (i: any, o: any) => native.estimateReferent!(i, o) } : {}),
    ...(profile.dialoguePolicy ? { classifystring: (i: any, o: any) => native.classifystring!(i, o) } : {}),
    ...(technicalTrial ? { estimateRepairProspect: (i: any, o: any) => native.estimateRepairProspect!(i, o) } : {}) };
  const runtime = M.createProfileDialogue(profile, { client, image: ctx.OWN.ownImage, anchors: [...ctx.OWN.ownAnchors], strategy: label,
    observer: { async observeAll() { return structuredClone(ctx.OLD.state.observationMemo); },
      async reobserve(input: any) { const result = { observedAt: '2026-01-01T00:00:01.000Z', issue: structuredClone(input.issue),
        figures: input.figureIds.map((figureId: string) => ({ figureId, supports: ['control-feature'], contradicts: [], unknown: [] })) };
        reobservations.push(structuredClone(result)); await client.complete(M.buildReobservationMessages(input), { phase: 'observation_targeted' }); return result; } }, jevDecision,
    localGrounding: { classifier: M.createJevLocalTestClassifier({ enabled: true, readKey, fetchImpl, timeoutMs: profile.timeouts.localMs, researchLimits: { maxDeadlineMs: 600000 }, questionLayout: profile.questionLayout,
      ...(['holistic_v3', 'holistic_v5'].includes(profile.dialoguePolicy) ? { dialoguePolicy: profile.dialoguePolicy } : {}) })!,
      aiPublicTransport: { readKey, fetchImpl, timeoutMs: profile.timeouts.decisionMs } },
    onJevTurnTrace: (t: any) => traces.push(t), generationRetryVersion, ...(technicalTrial ? { technicalTrial } : {}) } as any);
  let result: any;
  try { result = await runtime.runAiTurn({ events, privateState: state, lastEventId: events.at(-1).id, requestSeq: events.at(-1).seq }); }
  catch (error) { (error as any).traces = traces; throw error; }
  ok(boundary.luna >= 0);
  return { state: structuredClone(result.privateState), trace: { ...structuredClone(traces.at(-1)), status: 'committed' }, luna, jev, reobservations, boundary, speech: result.text as string };
}

/** One scenario's final turn as a replay tape plus the recorded request hashes (as buildRecords makes them), run once per strategy. */
export async function generateTape(M: any, ctx: any, scenario: Scenario, label: 'repair-first' | 'bypass-enabled') {
  const m = ctx.normal.run.manifest;
  const profile = JSON.parse(JSON.stringify(M.researchTrialProfileV3(m.lunaRequest, m.timeouts, 'two_stage_v3', undefined)));
  let state: any = structuredClone(ctx.OLD.state), events: any[] = [], seq = 0;
  const { turns, technicalTrial } = scenario;
  for (let i = 0; i < turns.length; i++) {
    events = [...events, { id: `human-${++seq}`, seq, speaker: 'human', text: turns[i].human }];
    const run = { state, events: structuredClone(events) };
    if (i < turns.length - 1) { const r = await runTurn(M, ctx, profile, label, state, events, turns[i].plan, technicalTrial); state = r.state; events = [...events, { id: `ai-${++seq}`, seq, speaker: 'ai', text: r.speech }]; continue; }
    const a = await runTurn(M, ctx, profile, 'repair-first', run.state, run.events, turns[i].plan, technicalTrial);
    const b = await runTurn(M, ctx, profile, 'bypass-enabled', run.state, run.events, turns[i].plan, technicalTrial);
    const seg = (r: any) => ({ luna: r.luna.slice(r.boundary.luna), jev: r.jev.slice(r.boundary.jev), reobservations: [] });
    const tape: any = { schemaVersion: 'parity_intervention_replay_v1', state: run.state, events: run.events,
      common: { luna: a.luna.slice(0, a.boundary.luna), jev: a.jev.slice(0, a.boundary.jev), reobservations: structuredClone(a.reobservations) },
      tails: { 'repair-first': seg(a), 'bypass-enabled': seg(b) }, recorded: { label, expectedRequests: [] }, ...(technicalTrial ? { technicalTrial } : {}) };
    const probe: any = await M.pairedInterventionReplay(tape, ctx.OWN, ctx.MODEL, profile);
    ok(probe.status !== 'not_reached', String(probe.error));
    const recorded = probe.sides.find((s: any) => s.label === label);
    tape.recorded.expectedRequests = recorded.requests.map((r: any, k: number) => ({ provider: r.provider, phase: r.phase, requestSha256: r.preProjectionPayloadSha256,
      actualSendMeasured: true, sendIds: [k + 1], ...(r.provider === 'luna' ? { messagesSha256: r.completeMessagesSha256 } : {}) }));
    return { tape, profile, trace: (label === 'repair-first' ? a : b).trace };
  }
  throw new Error('scenario without turns');
}
