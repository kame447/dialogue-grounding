// Digests of everything the two earlier rotation modes (relative_pm90, relative_0) produce: the generated stimuli, the Jev requests of
// the holistic_v5 judgment, and the prepared-observation pool keys. The expected table is tests/fixtures/rotation-legacy-bytes/digests-620ef5c.json,
// generated ONCE from base 620ef5c (before relative_90_180_270 existed) by `node tests/support/rotation-legacy-digests.ts 620ef5c`.
// Never regenerate it from a later commit to make a test pass: a mismatch means an earlier mode's bytes changed.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLayoutsV2, createTrialV2, trialStimulusV2 } from '../../dialogue-model/runtime/stimuli/scatter-v2.mjs';
import { buildHumanReferentPayload, buildJevCandidateSetPayload, buildJevDecisionDetailPayload, buildJevDecisionPayload, buildJevTargetPayload,
  buildRepairProspectPayload } from '../../dialogue-model/runtime/decision/jev-decision.ts';
import { preparedObservationPoolKey, type PreparedObservationParticipant } from '../../workers/tangram-experiment/src/prepared-observation-recipe.ts';
import type { ReceptionProtocolV3 } from '../../dialogue-model/runtime/v2/reception.ts';
import { validateParticipantModelPin } from '../../dialogue-model/runtime/v2/participant-model-pin.ts';
import { INITIAL_OBSERVATION_STRUCTURED_V2 } from '../../dialogue-model/runtime/observation/initial-observation-generation.ts';

export const LEGACY_MODES = [undefined, 'relative_pm90', 'relative_0'] as const;
type LegacyMode = typeof LEGACY_MODES[number];
const label = (mode: LegacyMode) => mode ?? 'implicit';

/** Figure selections of the stimuli: the original six, the four-figure pilot set, and the two ways to pick three figures. */
export const SELECTIONS: Record<string, unknown> = {
  legacy6: undefined,
  pilot4: { mode: 'preset', setId: 'pilot-four-v1' },
  custom3: { mode: 'custom', figureIds: ['F2', 'F17', 'F30'] },
  seeded3: { mode: 'seeded_random', selectionSeed: 11, figureCount: 3 },
};
export const SEEDS: number[] = [...Array(8).keys(), -1, 1701, 104729, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
export const LAYOUT_SEEDS: number[] = [...Array(200).keys()];

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => JSON.stringify(value, (_k, x) => x && x.type === 'Buffer' && Array.isArray(x.data) ? Buffer.from(x.data).toString('base64') : x);

export function stimulusDigests(modes: readonly LegacyMode[]) {
  const out: Record<string, { trialIds: string[]; perSeed: string[]; aggregate: string; layouts: string }> = {};
  for (const mode of modes) for (const [name, selection] of Object.entries(SELECTIONS)) {
    // The implicit default is the stored-record path (records from before the mode existed): the original six figures and the three-figure pick are enough.
    if (mode === undefined && name !== 'legacy6' && name !== 'custom3') continue;
    const options = { ...(mode === undefined ? {} : { rotationMode: mode }), ...(selection === undefined ? {} : { figureSelection: selection }) };
    const trialIds: string[] = [], perSeed: string[] = [], all = createHash('sha256');
    for (const seed of SEEDS) {
      const trial = createTrialV2({ seed, ...options });
      const digest = sha(json(trial) + '\n' + JSON.stringify(trialStimulusV2(trial)));
      trialIds.push(trial.trialId); perSeed.push(digest.slice(0, 16)); all.update(digest);
    }
    const layouts = createHash('sha256');
    for (const seed of LAYOUT_SEEDS) layouts.update(json(createLayoutsV2({ seed, ...options })) + '\n');
    out[`${label(mode)}|${name}`] = { trialIds, perSeed, aggregate: all.digest('hex'), layouts: layouts.digest('hex') };
  }
  return out;
}

// Synthetic judgment input (the same material as tests/judgment-material-v5.test.ts), so the requests need no network or study data.
const normal = JSON.parse(readFileSync(fileURLToPath(new URL('./s4-integration/NORMAL-RECORDS.json', import.meta.url)), 'utf8'));
const OLD = normal.trials[0].replay[0].tape;
const slots: string[] = normal.trials[0].replay[0].result.sides[0].material.own.ownAnchors.map((a: { id: string }) => a.id);
const NAME = '糸巻き';
const lines = [
  { turn: 1, speaker: 'human', text: `この丸い形は「${NAME}」と呼びませんか？` }, { turn: 2, speaker: 'ai', text: 'では、その形を呼びましょう。' },
  { turn: 3, speaker: 'human', text: '枝のある形は\nあとで確かめたいです。' }, { turn: 4, speaker: 'ai', text: '細い枝が二本ある形ですか？' },
  { turn: 5, speaker: 'human', text: 'はい、二本です。' }, { turn: 6, speaker: 'ai', text: '二本と分かりました。' }, { turn: 7, speaker: 'human', text: 'もう一度確かめたい。' },
];
const claim = (id: string, sourceTurn: number, speaker: string, quote: string, over: Record<string, unknown> = {}) => ({ id, turn: sourceTurn, issueId: 'i-' + id, targets: [slots[0]],
  aspect: 'part', act: 'assert', proposition: '命題-' + id, name: null, speaker, sourceTurn, quote, respondsTo: null, source: speaker === 'human' ? 'partner_statement' : 'ai_hypothesis', ...over });
const input = (extra: Record<string, unknown>) => ({
  turn: 7, publicTurns: lines, ownSlots: slots, observations: structuredClone(OLD.state.observationMemo), issueSummary: '',
  priorClaims: [claim('c1', 1, 'human', NAME, { aspect: 'name', act: 'name_propose', name: NAME }), claim('c5', 5, 'human', 'はい、二本です。', { targets: [slots[1]], respondsTo: 'c4' })],
  repairHistory: [{ turn: 3, issueId: null, action: 'confirm', question: '細い枝が二本ある', partnerClaims: [{ id: 'c5', act: 'assert', proposition: '命題-c5', targets: [slots[1]] }],
    candidatesBefore: [slots[1]], candidatesAfter: [slots[1]], addedClaimIds: ['c5'], removedClaimIds: [], progress: 'changed' }],
  previousAction: { turn: 6, action: 'accept', target: { kind: 'single', figureId: slots[1] }, name: null, feature: null }, publicNames: [],
  nameLedger: Object.fromEntries(slots.map((id, i) => [id, i === 0 ? { status: 'agreed', name: NAME } : { status: 'unassigned', name: null }])), ...extra }) as any;
const judgmentLedger = [{ turn: 2, action: 'agree', target: { kind: 'single', figureId: slots[0] }, name: NAME, feature: null },
  { turn: 4, action: 'confirm', target: { kind: 'single', figureId: slots[1] }, name: null, feature: '細い枝が二本ある' }];
const NOTATIONS: Record<string, Record<string, unknown>> = { plain: {}, v6: { notationV6: true }, v11: { notationV6: true, notationV11: true } };

/** A builder that rejects its input leaves the error message as the digest, so a changed rejection is also a change. */
const requestDigest = (build: () => unknown) => {
  try { return sha(JSON.stringify(build())); } catch (error) { return 'error:' + (error instanceof Error ? error.message : String(error)); }
};

export function requestDigests(modes: readonly LegacyMode[]) {
  const out: Record<string, Record<string, string>> = {};
  const selected = { kind: 'single', figureId: slots[1] } as any;
  for (const mode of modes) for (const layout of ['two_stage_v1', 'two_stage_v2', 'two_stage_v3'] as const) {
    for (const [version, ledger] of [['v4', {}], ['v5', { judgmentLedger }]] as const) for (const [notation, flags] of Object.entries(NOTATIONS)) {
      const extra = { ...(mode === undefined ? {} : { rotationMode: mode }), ...ledger, ...flags };
      // Every request kind that carries the rotation premise: the first-stage questions, the target and candidate-set questions,
      // the detail questions, the partner-referent estimate and the repair-prospect questions.
      out[`${label(mode)}|${layout}|${version}|${notation}`] = {
        decision: requestDigest(() => buildJevDecisionPayload(input(extra), { questionLayout: layout, dialoguePolicy: 'holistic_v5' })),
        target: requestDigest(() => buildJevTargetPayload(input(extra), 'confirm')),
        candidateSet: requestDigest(() => buildJevCandidateSetPayload(input(extra), 'confirm')),
        detail: requestDigest(() => buildJevDecisionDetailPayload(input(extra), { action: 'confirm', target: selected }, { questionLayout: layout })),
        referent: requestDigest(() => buildHumanReferentPayload(input(extra))),
        prospect: requestDigest(() => buildRepairProspectPayload(input(extra), { questionLayout: layout })),
      };
    }
  }
  return out;
}

// The pool-key inputs of tests/prepared-observation-recipe.test.ts.
const pin = validateParticipantModelPin({ schemaVersion: 'participant_model_pin_v3', terraModelId: 'gpt-6.1-terra-2026-11-01', jevModelId: 'typesafe/jev-1.14-20261014' });
const participant: PreparedObservationParticipant = {
  participantModelPin: pin, participantRuntimeProfile: 'participant_production_usage_v1',
  participantDialogueProfile: 'participant_dialogue_v23_prompt_consolidation',
  memoryPruneVersion: 'claim_prune_v3', openingMode: 'scripted_v1', initialObservationGeneration: INITIAL_OBSERVATION_STRUCTURED_V2,
};
const protocol = (extra: Partial<ReceptionProtocolV3>): ReceptionProtocolV3 => ({ schemaVersion: 'reception_protocol_v3', protocolId: '20000000-0000-4000-8000-000000000001', revision: 1,
  allowedOrders: [['repair-first', 'bypass-enabled'], ['bypass-enabled', 'repair-first']], seedPolicy: 'shared',
  referenceMemory: true, betweenTrials: 'questionnaire_required', receptionNumberFormat: 'daily_seq3', rotationMode: 'relative_pm90',
  figureSelection: { mode: 'preset', setId: 'pilot-four-v1' }, figureSetPolicy: 'shared', ...extra });
const POOL_SELECTIONS = {
  pilot4: { mode: 'preset', setId: 'pilot-four-v1' }, legacy6: { mode: 'preset', setId: 'legacy-v1' },
  custom3: { mode: 'custom', figureIds: ['F2', 'F17', 'F30'] }, seeded3: { mode: 'seeded_random', selectionSeed: 11, figureCount: 3 },
} as unknown as Record<string, ReceptionProtocolV3['figureSelection']>;

export function poolKeys() {
  const out: Record<string, string> = {};
  for (const rotationMode of ['relative_pm90', 'relative_0'] as const) for (const [name, figureSelection] of Object.entries(POOL_SELECTIONS)) {
    // revision and protocolId vary too: a three-figure stock is shared across them, any other set is not.
    for (const [variant, extra] of [['rev1', {}], ['rev2', { revision: 2, protocolId: '20000000-0000-4000-8000-000000000002' }]] as const) {
      out[`${rotationMode}|${name}|${variant}`] = preparedObservationPoolKey({ protocol: protocol({ rotationMode, figureSelection, ...extra }), orderIndex: 0, participant });
    }
  }
  return out;
}

export function computeLegacyDigests() {
  return { stimuli: stimulusDigests(LEGACY_MODES), requests: requestDigests(LEGACY_MODES), poolKeys: poolKeys() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify({ baseCommit: process.argv[2] ?? null, ...computeLegacyDigests() }, null, 1) + '\n');
}
