// Run the real v24 pipeline offline (scripted answers, no network) for several scenes and capture every request body it would send.
// TREE = repo root to run against, PREP = prepared-4e09b62.json (stand-in memos), WITH_PARTS=1 keeps the 4e09b62 `parts`, OUT = result json.
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = process.env.TREE!, OUT = process.env.OUT!, PREP = process.env.PREP!;
const WITH_PARTS = process.env.WITH_PARTS === '1';
const WITH_ROTATION = process.env.WITH_ROTATION === '1';
const WORST = process.env.WORST === '1';
const COUNTS = (process.env.COUNTS ?? '4,6').split(',').map(Number);
const imp = (p: string) => import(pathToFileURL(ROOT + '/' + p).href);
const sup = await imp('tests/support/s4-v3-records.ts');
const { researchTrialProfileV3 } = await imp('dialogue-model/runtime/v2/research-profile.ts');
const prepared = JSON.parse(readFileSync(PREP, 'utf8'));
const { normal, runTurn, initialState, OWN } = sup;

const m = normal.run.manifest;
const profile = JSON.parse(JSON.stringify(researchTrialProfileV3(m.lunaRequest, m.timeouts, 'two_stage_v3', 'holistic_v5', 'bypass_acceptance_v3', 'jev_repair_quality_v1')));
const technicalTrial = { version: 'adaptive_repair_v3' };
const GEN = 'jev_generation_retry_v24';
const choose = (key: string) => key === 'human_move_on_source' ? 'other' : key === 'commitment_state' ? 'not_due' : key === 'draft_topic_shift' ? 'within_plan' : undefined;

type Scene = { id: string; human: string; plan: Record<string, unknown> };
const scenesFor = (firstId: string): Scene[] => [
  { id: 's1_whole_question', human: 'こんにちは。私の画面の図形について、そちらの一つ目は何かに見えますか？', plan: {
    postGenerationCheck: 'off', action: 'accept', target: 'figure_0', referent: 'figure_0', choose,
    speech: '座っている鳥のように見えます。', aiExtraction: '[]' } },
  { id: 's2_feature_confirm_reobserve', human: '耳みたいに尖った出っ張りはありますか？', plan: {
    postGenerationCheck: 'off', action: 'confirm', target: 'figure_0', referent: 'figure_0', choose, reobserve: true,
    speech: JSON.stringify({ text: '上のほうに小さく尖った部分があります。そちらはどうですか？' }), aiExtraction: '[]' } },
  { id: 's3_agree_name', human: '鳥という名前でどうですか？', plan: {
    postGenerationCheck: 'off', action: 'agree', target: 'figure_0', referent: 'figure_0', name: '鳥', act: 'name_propose',
    speech: 'はい、「鳥」で決まりですね。',
    extraction: JSON.stringify([{ segmentId: 'name', quote: '鳥という名前でどうですか？', targets: [firstId], aspect: 'name', proposition: '鳥という名前でどうですか？', name: '鳥', linkedIssueId: null, respondsToTurn: null }]),
    choose: (key: string) => key === 'naming_grounding' ? 'grounded_name_0' : key === 'naming_evidence' ? 'turn_1' : choose(key),
    aiExtraction: '[]' } },
];

const { projectOwnRotationMemory } = WITH_ROTATION ? await imp('dialogue-model/runtime/stimuli/rotation-memory.ts') : ({} as any);
const KEYS: [string, number][] = WORST ? [['F15', 270], ['F23', 0], ['F19', 0], ['F27', 0], ['F1', 0], ['F13', 0]] : [['F6', 0], ['F9', 90], ['F1', 270], ['F15', 270], ['F19', 0], ['F23', 180]];
function ownFor(n: number) {
  if (WITH_ROTATION) {
    const anchors = OWN.ownAnchors.slice(0, n);
    const slots = anchors.map((a: { id: string }) => a.id);
    const memo = { observedAt: '2026-01-01T00:00:00.000Z', figures: anchors.map((a: { id: string; bbox: unknown }, i: number) => ({ id: a.id, region: { ...(a.bbox as object) }, holistic: [],
      analytic: { shapes: [], composition: '形・位置・接続は rotation を参照。', relations: [] }, unknowns: [], reobservations: [], rotation: projectOwnRotationMemory({ figureKey: KEYS[i][0], rotation: KEYS[i][1] }) })) };
    return { own: { ...OWN, ownAnchors: anchors }, memo, slots };
  }
  if (WITH_PARTS) {
    const p = prepared[String(n)];
    if (!p) return null;
    return { own: { ownImage: OWN.ownImage, ownAnchors: p.anchors, ownParts: p.ownParts }, memo: { ...p.memo, observedAt: '2026-01-01T00:00:00.000Z' }, slots: p.anchors.map((a: { id: string }) => a.id) };
  }
  const p = prepared[String(n === 3 ? 4 : n)];
  const anchors = OWN.ownAnchors.slice(0, n);
  const slots = anchors.map((a: { id: string }) => a.id);
  const memo = { observedAt: '2026-01-01T00:00:00.000Z', figures: anchors.map((a: { id: string; bbox: unknown }, i: number) => {
    const { parts: _parts, region: _region, id: _id, ...rest } = p.memo.figures[i];
    return { id: a.id, region: { ...(a.bbox as object) }, ...rest };
  }) };
  return { own: { ...OWN, ownAnchors: anchors }, memo, slots };
}

const result: Record<string, unknown>[] = [];
for (const n of COUNTS) {
  const o = ownFor(n);
  if (!o) { console.log('skip', n); continue; }
  for (const scene of scenesFor(o.slots[0])) {
    const base = initialState({ profile, memo: o.memo, generationRetryVersion: GEN, agreeNameScopeVersion: 'jev_naming_v3' });
    base.ledger = Object.fromEntries(o.slots.map((id: string) => [id, { status: 'unassigned', name: null }]));
    base.graph.slots = o.slots;
    base.observationMemo = structuredClone(o.memo);
    const events = [{ id: 'event-1', seq: 1, speaker: 'human', text: scene.human }];
    for (const label of ['repair-first', 'bypass-enabled'] as const) {
      const captures: { provider: string; body: string }[] = [];
      const plan = { ...scene.plan, captureRequest: (provider: string, body: string) => captures.push({ provider, body }) };
      try {
        const r = await runTurn(profile, label, structuredClone(base), structuredClone(events), plan, technicalTrial, GEN, o.own, label);
        const lunaPhases: string[] = r.luna.map((x: { phase: string }) => x.phase);
        let li = 0;
        const requests = captures.map(c => {
          if (c.provider === 'luna') return { provider: 'luna', phase: lunaPhases[li++], body: JSON.parse(c.body) };
          return { provider: 'jev', phase: 'jev', body: JSON.parse(c.body) };
        });
        result.push({ figures: n, scene: scene.id, label, requests, speech: r.speech, action: r.trace.executed?.action });
        console.log(n, scene.id, label, 'requests', requests.length, 'action', r.trace.executed?.action);
      } catch (e) {
        console.log(n, scene.id, label, 'ERROR', (e as Error).message.slice(0, 300));
        result.push({ figures: n, scene: scene.id, label, error: (e as Error).message });
      }
    }
  }
}
writeFileSync(OUT, JSON.stringify(result));
