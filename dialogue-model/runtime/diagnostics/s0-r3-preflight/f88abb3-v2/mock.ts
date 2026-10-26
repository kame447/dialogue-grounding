// Synthetic dependencies only. No native client, environment, key store or fetch.
import { runParityLive } from '../../parity-live/live.ts';
import type { Dependencies } from '../../parity-live/live.ts';
import { SYNTHETIC_PROBES } from '../../parity-live/cases.ts';
import type { RunManifestV2 } from '../../parity-live/manifest.ts';

export const MOCK_MODEL = 'synthetic-luna-s0-r3';
export const MOCK_JEV_MODEL = 'typesafe/jev-1.14-20261014';
const TEXT = 'A connected part is visible.';
type Call = { provider: 'luna' | 'jev'; label: string; phase: string; signal?: AbortSignal; timeoutMs?: number };
export type MockOptions = {
  returnedModel?: string;
  onCall?: (call: Call) => Promise<void> | void;
};

export function syntheticDependencies(options: MockOptions = {}) {
  const calls: Call[] = [];
  const deps: Dependencies = {
    execution: 'mock',
    createLunaClient(label) {
      return {
        async getModelPolicy() { return { purpose: 'dialogue_turn', ready: true, model: MOCK_MODEL, provider: 'openai' }; },
        async complete(messages, request = {}) {
          const phase = request.phase ?? 'unknown';
          const call: Call = { provider: 'luna', label, phase, signal: request.signal, timeoutMs: request.timeoutMs };
          calls.push(call);
          await options.onCall?.(call);
          let text = TEXT;
          if (phase === 'observation_initial') {
            const input = JSON.parse(messages[1].content as string);
            text = JSON.stringify({ figures: input.ownAnchors.map((a: { id: string }) => ({
              id: a.id, holistic: [], analytic: { shapes: ['part'], composition: 'connected parts', relations: [] }, unknowns: [],
            })) });
          } else if (phase === 'local_extraction') text = '[]';
          else if (phase === 'ai_extraction') {
            const input = JSON.parse(messages[1].content as string);
            text = JSON.stringify([{ segmentId: 's1', quote: TEXT, targets: [input.ownSlots[0]], aspect: 'part',
              proposition: 'A connected part is visible', name: null, linkedIssueId: null, respondsToTurn: null }]);
          }
          return { text, model: MOCK_MODEL, usage: { inputTokens: 1, outputTokens: 1 } };
        },
      };
    },
    createJevTransport(label) {
      return {
        readKey: async () => 'sk-or-SYNTHETIC-s0-r3-preflight-000000',
        async fetchImpl(_url, request) {
          const payload = JSON.parse(String(request.body));
          const phase = Object.keys(payload.questions).some(k => k.endsWith('_support')) ? 'ai_support'
            : Object.keys(payload.questions).some(k => k.endsWith('_act')) ? 'ai_function' : 'decision';
          const call: Call = { provider: 'jev', label, phase, signal: request.signal ?? undefined };
          calls.push(call);
          await options.onCall?.(call);
          const answers = Object.fromEntries(Object.entries(payload.questions).map(([name, q]) => {
            const values = Object.keys((q as { criteria: object }).criteria);
            const choice = name === 'human_referent' || name === 'target' || name.endsWith('_antecedent') ? 'none'
              : name === 'action' ? 'accept' : name.startsWith('candidate_') ? 'exclude' : name.endsWith('_act') ? 'assert' : 'expressed';
            if (!values.includes(choice)) throw Error('synthetic_question_unhandled');
            return [name, { type: 'choice', choice, probabilities: Object.fromEntries(values.map(v => [v, v === choice ? 1 : 0])), confidence: 1 }];
          }));
          return Response.json({ model: options.returnedModel ?? MOCK_JEV_MODEL, id: 'gen-synthetic-s0-r3-response', answers, usage: { cost: 0 } });
        },
      };
    },
  };
  return { deps, calls };
}

/** Caller supplies temporary directories; this never selects a private run. */
export async function runSynthetic(manifest: RunManifestV2, outputDir: string, cacheDir: string, options: MockOptions = {}) {
  const mock = syntheticDependencies(options);
  const result = await runParityLive({ manifest, outputDir, cacheDir, scripts: SYNTHETIC_PROBES }, mock.deps);
  return { result, calls: mock.calls };
}
