import { createHash } from 'node:crypto';
import { isOpeningMode, type OpeningMode } from './opening-mode.ts';
import { validatePreparedObservations } from './prepared-observations.ts';
import type { PreparedObservationReference } from './prepared-observations.ts';
export type { PreparedObservationReference, PreparedTrialObservationReference } from './prepared-observations.ts';
import { PARTICIPANT_PRODUCTION_PROFILE, type ParticipantProductionProfile } from '../web/participant-usage-policy.ts';
import type { Strategy } from './base-assignment.ts';
import type { BudgetLimits } from '../diagnostics/parity-live/audit.ts';
import { DEFAULT_COST_CAP_USD } from '../diagnostics/jev-shadow-eval/local-openrouter.ts';
import { validateParticipantModelPin } from './participant-model-pin.ts';
import type { ParticipantModelPin } from './participant-model-pin.ts';
import { ROTATION_MODES as STIMULUS_ROTATION_MODES } from '../stimuli/scatter-v2.mjs';
import { FIGURE_SETS, isSupportedFigureCount, resolveFigureSelection, validateResolvedFigureSelection } from '../stimuli/figure-bank.ts';
import type { FigureCount, ResolvedFigureSelection } from '../stimuli/figure-bank.ts';
import { INITIAL_OBSERVATION_STRUCTURED_V2, isInitialObservationGeneration, type InitialObservationGeneration } from '../observation/initial-observation-generation.ts';

import { CLAIM_PRUNE_V2, CLAIM_PRUNE_V3, type MemoryPruneVersion } from '../memory/reference-graph.mjs';
import { isAdminTermination, type AdminTermination } from './admin-termination.ts';
import { isPostGenerationCheck, type PostGenerationCheck } from './deferred-ai-extraction.ts';

export type ReceptionProtocol = { schemaVersion: 'reception_protocol_v1'; protocolId: string; revision: number;
  allowedOrders: Strategy[][]; seedPolicy: 'shared' | 'per_trial'; referenceMemory: boolean;
  betweenTrials: 'none'; receptionNumberFormat: 'daily_seq3' };
export type RotationMode = 'relative_pm90' | 'relative_0';
/** The stimulus generator's own list, so the protocol never offers a mode the generator cannot produce. */
export const ROTATION_MODES = STIMULUS_ROTATION_MODES as readonly RotationMode[];
export type BetweenTrials = 'none' | 'questionnaire_required';
/** Researcher-saved protocol. Every value is an explicit selection; nothing is defaulted. */
export type ReceptionProtocolV2 = { schemaVersion: 'reception_protocol_v2'; protocolId: string; revision: number;
  allowedOrders: Strategy[][]; seedPolicy: 'shared' | 'per_trial'; referenceMemory: boolean;
  betweenTrials: BetweenTrials; receptionNumberFormat: 'daily_seq3'; rotationMode: RotationMode };
export type ReceptionPlanV1 = { schemaVersion: 'reception_plan_v1'; protocolId: string; protocolRevision: number;
  protocolSha256: string; order: Strategy[]; trials: { index: number; strategy: Strategy; seed: number; referenceMemory: boolean }[]; approvedAt: string; memoryPruneVersion?: MemoryPruneVersion };
type P5ParticipantDialogueProfile = 'participant_dialogue_v13_p5' | 'participant_dialogue_v13_p5_naming_v4' |
  'participant_dialogue_v13_p5_semantic_guard' | 'participant_dialogue_v13_p5_human_led_move_on' |
  'participant_dialogue_v13_p5_discriminating_confirmation' |
  'participant_dialogue_v13_p5_semantic_guard_jev_naming' | 'participant_dialogue_v13_p5_jev_naming_v16_human_led_move_on';
export const PILOT012_PARTICIPANT_PROFILE = 'participant_dialogue_v17_pilot012';
export const PILOT012_V18_PARTICIPANT_PROFILE = 'participant_dialogue_v18_pilot012';
export const PILOT012_V19_PARTICIPANT_PROFILE = 'participant_dialogue_v19_pilot012';
export const PILOT012_V20_PARTICIPANT_PROFILE = 'participant_dialogue_v20_deferred_ai_extraction';
export const PILOT012_V21_PARTICIPANT_PROFILE = 'participant_dialogue_v21_issue_handling';
export const PILOT012_V22_PARTICIPANT_PROFILE = 'participant_dialogue_v22_issue_fixes';
export const PILOT012_V23_PARTICIPANT_PROFILE = 'participant_dialogue_v23_prompt_consolidation';
export const PILOT012_V24_PARTICIPANT_PROFILE = 'participant_dialogue_v24_precheck_reduction';
type Pilot012ParticipantDialogueProfile = typeof PILOT012_PARTICIPANT_PROFILE | typeof PILOT012_V18_PARTICIPANT_PROFILE |
  typeof PILOT012_V19_PARTICIPANT_PROFILE | typeof PILOT012_V20_PARTICIPANT_PROFILE | typeof PILOT012_V21_PARTICIPANT_PROFILE |
  typeof PILOT012_V22_PARTICIPANT_PROFILE | typeof PILOT012_V23_PARTICIPANT_PROFILE | typeof PILOT012_V24_PARTICIPANT_PROFILE;
export type ParticipantDialogueProfile = 'participant_dialogue_v12' | 'participant_dialogue_v12_naming_v2' |
  'participant_dialogue_v12_naming_v3' | 'participant_dialogue_v12_naming_v4' | P5ParticipantDialogueProfile | Pilot012ParticipantDialogueProfile;
export function isP5ParticipantDialogueProfile(value: unknown): value is P5ParticipantDialogueProfile {
  return value === 'participant_dialogue_v13_p5' || value === 'participant_dialogue_v13_p5_naming_v4' ||
    value === 'participant_dialogue_v13_p5_semantic_guard' || value === 'participant_dialogue_v13_p5_human_led_move_on' ||
    value === 'participant_dialogue_v13_p5_discriminating_confirmation' ||
    value === 'participant_dialogue_v13_p5_semantic_guard_jev_naming' ||
    value === 'participant_dialogue_v13_p5_jev_naming_v16_human_led_move_on';
}
export function isPilot012ParticipantDialogueProfile(value: unknown): value is Pilot012ParticipantDialogueProfile {
  return value === PILOT012_PARTICIPANT_PROFILE || value === PILOT012_V18_PARTICIPANT_PROFILE ||
    value === PILOT012_V19_PARTICIPANT_PROFILE || value === PILOT012_V20_PARTICIPANT_PROFILE ||
    value === PILOT012_V21_PARTICIPANT_PROFILE || value === PILOT012_V22_PARTICIPANT_PROFILE ||
    value === PILOT012_V23_PARTICIPANT_PROFILE || value === PILOT012_V24_PARTICIPANT_PROFILE;
}
export function isParticipantDialogueProfile(value: unknown): value is ParticipantDialogueProfile {
  return value === 'participant_dialogue_v12' || value === 'participant_dialogue_v12_naming_v2' ||
    value === 'participant_dialogue_v12_naming_v3' || value === 'participant_dialogue_v12_naming_v4' ||
    isP5ParticipantDialogueProfile(value) || isPilot012ParticipantDialogueProfile(value);
}
export function participantMemoryPruneVersion(profile?: ParticipantDialogueProfile): MemoryPruneVersion {
  return isPilot012ParticipantDialogueProfile(profile) ? CLAIM_PRUNE_V3 : CLAIM_PRUNE_V2;
}
export type ParticipantPlanSettings = {
  preparedObservations?: PreparedObservationReference;
  openingMode?: OpeningMode;
  memoryPruneVersion?: MemoryPruneVersion;
  participantModelPin?: ParticipantModelPin;
  participantLimits?: Readonly<BudgetLimits>;
  participantRuntimeProfile?: ParticipantProductionProfile;
  participantDialogueProfile?: ParticipantDialogueProfile;
  postGenerationCheck?: PostGenerationCheck;
  initialObservationGeneration?: InitialObservationGeneration;
};
export type ReceptionPlanV2 = ParticipantPlanSettings & { schemaVersion: 'reception_plan_v2'; protocolId: string; protocolRevision: number;
  protocolSha256: string; order: Strategy[]; betweenTrials: BetweenTrials; approvedAt: string;
  trials: { index: number; strategy: Strategy; seed: number; referenceMemory: boolean; rotationMode: RotationMode }[] };
export type FigureSetPolicy = 'shared' | 'per_trial';
/** Researcher-chosen figure source. `selectionSeed: null` asks the approval step to draw one seed. */
export type ProtocolFigureSelection =
  | { mode: 'preset'; setId: string }
  | { mode: 'seeded_random'; selectionSeed: number | null; figureCount?: FigureCount }
  | { mode: 'custom'; figureIds: readonly string[] };
export type ReceptionProtocolV3 = { schemaVersion: 'reception_protocol_v3'; protocolId: string; revision: number;
  allowedOrders: Strategy[][]; seedPolicy: 'shared' | 'per_trial'; referenceMemory: boolean;
  betweenTrials: BetweenTrials; receptionNumberFormat: 'daily_seq3'; rotationMode: RotationMode;
  figureSelection: ProtocolFigureSelection; figureSetPolicy: FigureSetPolicy };
export type ReceptionPlanV3 = ParticipantPlanSettings & { schemaVersion: 'reception_plan_v3'; protocolId: string; protocolRevision: number;
  protocolSha256: string; order: Strategy[]; betweenTrials: BetweenTrials; approvedAt: string;
  trials: { index: number; strategy: Strategy; seed: number; referenceMemory: boolean; rotationMode: RotationMode; figureSelection: ResolvedFigureSelection }[] };
export type ReceptionPlan = ReceptionPlanV1 | ReceptionPlanV2 | ReceptionPlanV3;
/** The protocol version a researcher saw when choosing an order. */
export type DisplayedProtocol = { protocolId: string; revision: number; sha256: string };
export type ReceptionStatus = 'pending' | 'approved' | 'in_progress' | 'finished' | 'cancelled' | 'interrupted';
export type Reception = { schemaVersion: 'reception_v1'; receptionId: string; objectId: string; createdAt: string;
  number: string | null; status: ReceptionStatus; plan: ReceptionPlan | null; revision: number;
  trials: { index: number; recordId: string | null }[]; termination?: AdminTermination };
export type ReceptionSummary = Pick<Reception, 'receptionId' | 'objectId' | 'createdAt' | 'number' | 'status' | 'revision' | 'trials'>;
export type ReceptionErrorCode = 'protocol_unconfigured' | 'reception_conflict' | 'invalid_order' | 'reception_unavailable' |
  'reception_not_approved' | 'trial_changed' | 'reception_finished' | 'protocol_changed' | 'reception_closed' |
  'reception_required' | 'questionnaire_required' | 'prepared_observations_unavailable';
export class ReceptionError extends Error {
  readonly code: ReceptionErrorCode;
  constructor(code: ReceptionErrorCode) { super(code); this.name = 'ReceptionError'; this.code = code; }
}
const fail = (code: ReceptionErrorCode = 'reception_unavailable'): never => { throw new ReceptionError(code); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const owner = /^[a-f0-9]{64}$/u;
const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const strategy = (v: unknown): v is Strategy => v === 'repair-first' || v === 'bypass-enabled';
const iso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
function object(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length || names.some(k => typeof k !== 'string' || !keys.includes(k))) return fail();
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) return fail(); }
  return value as Record<string, any>;
}
export function validateParticipantLimits(value: unknown): Readonly<BudgetLimits> {
  const { lunaCalls, lunaTokens, lunaPosts, jevPosts, jevUsd } = object(value, ['lunaCalls','lunaTokens','lunaPosts','jevPosts','jevUsd']);
  if ([lunaCalls, lunaTokens, lunaPosts, jevPosts].some(v => !int(v) || v < 1) ||
      typeof jevUsd !== 'number' || !Number.isFinite(jevUsd) || jevUsd <= 0 || jevUsd > DEFAULT_COST_CAP_USD) return fail();
  return Object.freeze({ lunaCalls, lunaTokens, lunaPosts, jevPosts, jevUsd });
}
function order(value: unknown): Strategy[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2 || value.some(v => !strategy(v)) || new Set(value).size !== value.length) return fail();
  return [...value];
}
/** No defaults: absent, malformed and unknown versions all fail closed. */
export function validateReceptionProtocol(value: unknown): ReceptionProtocol {
  try {
    const p = object(value, ['schemaVersion','protocolId','revision','allowedOrders','seedPolicy','referenceMemory','betweenTrials','receptionNumberFormat']);
    if (p.schemaVersion !== 'reception_protocol_v1' || !uuid.test(p.protocolId) || !int(p.revision) || p.revision < 1 ||
      !Array.isArray(p.allowedOrders) || !p.allowedOrders.length || !['shared','per_trial'].includes(p.seedPolicy) ||
      typeof p.referenceMemory !== 'boolean' || p.betweenTrials !== 'none' || p.receptionNumberFormat !== 'daily_seq3') return fail();
    return { schemaVersion: 'reception_protocol_v1', protocolId: p.protocolId, revision: p.revision,
      allowedOrders: p.allowedOrders.map(order), seedPolicy: p.seedPolicy, referenceMemory: p.referenceMemory,
      betweenTrials: 'none', receptionNumberFormat: p.receptionNumberFormat };
  } catch { return fail('protocol_unconfigured'); }
}
export function canonicalReceptionProtocol(value: unknown): string { return JSON.stringify(validateReceptionProtocol(value)); }
const rotation = (v: unknown): v is RotationMode => ROTATION_MODES.some(mode => mode === v);
const between = (v: unknown): v is BetweenTrials => v === 'none' || v === 'questionnaire_required';
/** v2 has no defaults either: a missing, null or unknown value fails closed (never the v1 meaning). */
export function validateReceptionProtocolV2(value: unknown): ReceptionProtocolV2 {
  try {
    const p = object(value, ['schemaVersion','protocolId','revision','allowedOrders','seedPolicy','referenceMemory','betweenTrials','receptionNumberFormat','rotationMode']);
    if (p.schemaVersion !== 'reception_protocol_v2' || !uuid.test(p.protocolId) || !int(p.revision) || p.revision < 1 ||
      !Array.isArray(p.allowedOrders) || !p.allowedOrders.length || !['shared','per_trial'].includes(p.seedPolicy) ||
      typeof p.referenceMemory !== 'boolean' || !between(p.betweenTrials) || p.receptionNumberFormat !== 'daily_seq3' || !rotation(p.rotationMode)) return fail();
    const allowedOrders = p.allowedOrders.map(order);
    if (new Set(allowedOrders.map(o => o.join(','))).size !== allowedOrders.length) return fail();
    return { schemaVersion: 'reception_protocol_v2', protocolId: p.protocolId, revision: p.revision, allowedOrders,
      seedPolicy: p.seedPolicy, referenceMemory: p.referenceMemory, betweenTrials: p.betweenTrials,
      receptionNumberFormat: p.receptionNumberFormat, rotationMode: p.rotationMode };
  } catch { return fail('protocol_unconfigured'); }
}
export function canonicalReceptionProtocolV2(value: unknown): string { return JSON.stringify(validateReceptionProtocolV2(value)); }
function protocolFigureSelection(value: unknown): ProtocolFigureSelection {
  const head = object(value, Array.isArray((value as { figureIds?: unknown } | null)?.figureIds) ? ['mode','figureIds']
    : value && typeof value === 'object' && 'setId' in value ? ['mode','setId']
      : ['mode','selectionSeed', ...(value && typeof value === 'object' && Object.hasOwn(value, 'figureCount') ? ['figureCount'] : [])]);
  if (head.mode === 'preset') {
    if (typeof head.setId !== 'string' || !Object.hasOwn(FIGURE_SETS, head.setId)) return fail();
    return { mode: 'preset', setId: head.setId };
  }
  if (head.mode === 'seeded_random') {
    if (head.selectionSeed !== null && !int(head.selectionSeed)) return fail();
    if (Object.hasOwn(head, 'figureCount') && !isSupportedFigureCount(head.figureCount)) return fail();
    return { mode: 'seeded_random', selectionSeed: head.selectionSeed,
      ...(Object.hasOwn(head, 'figureCount') ? { figureCount: head.figureCount as FigureCount } : {}) };
  }
  if (head.mode === 'custom') {
    try { return { mode: 'custom', figureIds: [...resolveFigureSelection({ mode: 'custom', figureIds: head.figureIds }).figureIds] }; } catch { return fail(); }
  }
  return fail();
}
/** v3 adds the figure source and its policy; neither is ever defaulted. */
export function validateReceptionProtocolV3(value: unknown): ReceptionProtocolV3 {
  try {
    const p = object(value, ['schemaVersion','protocolId','revision','allowedOrders','seedPolicy','referenceMemory','betweenTrials','receptionNumberFormat','rotationMode','figureSelection','figureSetPolicy']);
    if (p.schemaVersion !== 'reception_protocol_v3' || !uuid.test(p.protocolId) || !int(p.revision) || p.revision < 1 ||
      !Array.isArray(p.allowedOrders) || !p.allowedOrders.length || !['shared','per_trial'].includes(p.seedPolicy) ||
      typeof p.referenceMemory !== 'boolean' || !between(p.betweenTrials) || p.receptionNumberFormat !== 'daily_seq3' || !rotation(p.rotationMode) ||
      !['shared','per_trial'].includes(p.figureSetPolicy)) return fail();
    const allowedOrders = p.allowedOrders.map(order);
    if (new Set(allowedOrders.map(o => o.join(','))).size !== allowedOrders.length) return fail();
    const figureSelection = protocolFigureSelection(p.figureSelection);
    // A preset or custom set is one fixed set, so it cannot be redrawn per trial.
    if (figureSelection.mode !== 'seeded_random' && p.figureSetPolicy !== 'shared') return fail();
    return { schemaVersion: 'reception_protocol_v3', protocolId: p.protocolId, revision: p.revision, allowedOrders,
      seedPolicy: p.seedPolicy, referenceMemory: p.referenceMemory, betweenTrials: p.betweenTrials,
      receptionNumberFormat: p.receptionNumberFormat, rotationMode: p.rotationMode, figureSelection, figureSetPolicy: p.figureSetPolicy };
  } catch { return fail('protocol_unconfigured'); }
}
export function canonicalReceptionProtocolV3(value: unknown): string { return JSON.stringify(validateReceptionProtocolV3(value)); }
export const receptionProtocolSha256 = (canonical: string): string => createHash('sha256').update(canonical).digest('hex');
const PLAN_KEYS = ['schemaVersion','protocolId','protocolRevision','protocolSha256','order','betweenTrials','trials','approvedAt'];
function participantPlan(value: unknown) {
  const fields = value && typeof value === 'object' ? value : {};
  const hasPrepared = Object.hasOwn(fields, 'preparedObservations');
  const hasPrune = Object.hasOwn(fields, 'memoryPruneVersion');
  const hasOpeningMode = Object.hasOwn(fields, 'openingMode');
  const hasPin = Object.hasOwn(fields, 'participantModelPin');
  const hasLimits = Object.hasOwn(fields, 'participantLimits');
  const hasProfile = Object.hasOwn(fields, 'participantRuntimeProfile');
  const hasGeneration = Object.hasOwn(fields, 'initialObservationGeneration');
  const hasDialogueProfile = Object.hasOwn(fields, 'participantDialogueProfile');
  const hasPostGenerationCheck = Object.hasOwn(fields, 'postGenerationCheck');
  if ((hasLimits || hasProfile || hasGeneration) && !hasPin || hasLimits && hasProfile) return fail();
  const p = object(value, [...PLAN_KEYS, ...(hasPrepared ? ['preparedObservations'] : []), ...(hasOpeningMode ? ['openingMode'] : []),
    ...(hasPrune ? ['memoryPruneVersion'] : []), ...(hasPin ? ['participantModelPin'] : []), ...(hasLimits ? ['participantLimits'] : []),
    ...(hasProfile ? ['participantRuntimeProfile'] : []), ...(hasGeneration ? ['initialObservationGeneration'] : []),
    ...(hasDialogueProfile ? ['participantDialogueProfile'] : []), ...(hasPostGenerationCheck ? ['postGenerationCheck'] : [])]);
  if (hasOpeningMode && !isOpeningMode(p.openingMode)) return fail();
  if (hasProfile && p.participantRuntimeProfile !== PARTICIPANT_PRODUCTION_PROFILE) return fail();
  const generation = isInitialObservationGeneration(p.initialObservationGeneration) ? p.initialObservationGeneration : undefined;
  if (hasGeneration && generation === undefined) return fail();
  const pin = hasPin ? validateParticipantModelPin(p.participantModelPin) : undefined;
  if (pin?.schemaVersion === 'participant_model_pin_v3' && !hasProfile) return fail();
  const dialogueProfile = p.participantDialogueProfile;
  const postGenerationCheck = p.postGenerationCheck;
  if (hasPostGenerationCheck !== (dialogueProfile === PILOT012_V24_PARTICIPANT_PROFILE) ||
      hasPostGenerationCheck && !isPostGenerationCheck(postGenerationCheck)) return fail();
  if (hasDialogueProfile && (pin?.schemaVersion !== 'participant_model_pin_v3' || !hasProfile ||
      !isParticipantDialogueProfile(dialogueProfile))) return fail();
  const memoryPruneVersion = participantMemoryPruneVersion(dialogueProfile);
  if (hasPrune && p.memoryPruneVersion !== memoryPruneVersion) return fail();
  if (isPilot012ParticipantDialogueProfile(dialogueProfile) &&
      (!hasPrune || generation !== INITIAL_OBSERVATION_STRUCTURED_V2)) return fail();
  const limits = hasLimits ? validateParticipantLimits(p.participantLimits) : undefined;
  const preparedObservations = hasPrepared ? validatePreparedObservations(p.preparedObservations, Array.isArray(p.trials) ? p.trials.length : 0) : undefined;
  if (preparedObservations && (!pin || !hasProfile || !iso(p.approvedAt) || preparedObservations.preparedAt > p.approvedAt)) return fail();
  const participant: ParticipantPlanSettings = {
    ...(preparedObservations ? { preparedObservations } : {}),
    ...(hasOpeningMode ? { openingMode: p.openingMode as OpeningMode } : {}),
    ...(hasPrune ? { memoryPruneVersion } : {}),
    ...(pin ? { participantModelPin: pin } : {}),
    ...(limits ? { participantLimits: limits } : {}),
    ...(hasProfile ? { participantRuntimeProfile: PARTICIPANT_PRODUCTION_PROFILE } : {}),
    ...(generation ? { initialObservationGeneration: generation } : {}),
    ...(hasDialogueProfile ? { participantDialogueProfile: dialogueProfile } : {}),
    ...(isPostGenerationCheck(postGenerationCheck) ? { postGenerationCheck } : {}),
  };
  return { p, participant };
}
function validatePlanV2(value: unknown): ReceptionPlanV2 {
  const { p, participant } = participantPlan(value);
  const strategies = order(p.order);
  if (p.schemaVersion !== 'reception_plan_v2' || !uuid.test(p.protocolId) || !int(p.protocolRevision) || p.protocolRevision < 1 ||
    typeof p.protocolSha256 !== 'string' || !owner.test(p.protocolSha256) || !iso(p.approvedAt) || !between(p.betweenTrials) ||
    !Array.isArray(p.trials) || p.trials.length !== strategies.length) return fail();
  const trials = p.trials.map((raw: unknown, index: number) => {
    const t = object(raw, ['index','strategy','seed','referenceMemory','rotationMode']);
    if (t.index !== index || t.strategy !== strategies[index] || !int(t.seed) || typeof t.referenceMemory !== 'boolean' || (participant.participantModelPin || participant.memoryPruneVersion) && !t.referenceMemory || !rotation(t.rotationMode)) return fail();
    return { index, strategy: strategies[index], seed: t.seed, referenceMemory: t.referenceMemory, rotationMode: t.rotationMode as RotationMode };
  });
  return { schemaVersion: 'reception_plan_v2', protocolId: p.protocolId, protocolRevision: p.protocolRevision,
    protocolSha256: p.protocolSha256, order: strategies, betweenTrials: p.betweenTrials, approvedAt: p.approvedAt, trials,
    ...participant };
}
function resolvedSelection(value: unknown): ResolvedFigureSelection {
  object(value, ['bankVersion','mode','setId','selectionSeed','figureIds']);
  try { return validateResolvedFigureSelection(value); } catch { return fail(); }
}
function validatePlanV3(value: unknown): ReceptionPlanV3 {
  const { p, participant } = participantPlan(value);
  const strategies = order(p.order);
  if (p.schemaVersion !== 'reception_plan_v3' || !uuid.test(p.protocolId) || !int(p.protocolRevision) || p.protocolRevision < 1 ||
    typeof p.protocolSha256 !== 'string' || !owner.test(p.protocolSha256) || !iso(p.approvedAt) || !between(p.betweenTrials) ||
    !Array.isArray(p.trials) || p.trials.length !== strategies.length) return fail();
  const trials = p.trials.map((raw: unknown, index: number) => {
    const t = object(raw, ['index','strategy','seed','referenceMemory','rotationMode','figureSelection']);
    if (t.index !== index || t.strategy !== strategies[index] || !int(t.seed) || typeof t.referenceMemory !== 'boolean' || (participant.participantModelPin || participant.memoryPruneVersion) && !t.referenceMemory || !rotation(t.rotationMode)) return fail();
    return { index, strategy: strategies[index], seed: t.seed, referenceMemory: t.referenceMemory, rotationMode: t.rotationMode as RotationMode,
      figureSelection: resolvedSelection(t.figureSelection) };
  });
  return { schemaVersion: 'reception_plan_v3', protocolId: p.protocolId, protocolRevision: p.protocolRevision,
    protocolSha256: p.protocolSha256, order: strategies, betweenTrials: p.betweenTrials, approvedAt: p.approvedAt, trials, ...participant };
}
/** Each saved plan version is validated strictly by its own schema; v1 keeps its exact shape. */
export function validateReceptionPlan(value: unknown): ReceptionPlan {
  try {
    if (value && typeof value === 'object' && (value as { schemaVersion?: unknown }).schemaVersion === 'reception_plan_v2') return validatePlanV2(value);
    if (value && typeof value === 'object' && (value as { schemaVersion?: unknown }).schemaVersion === 'reception_plan_v3') return validatePlanV3(value);
    const hasPrune = value && typeof value === 'object' && Object.hasOwn(value, 'memoryPruneVersion');
    const p = object(value, ['schemaVersion','protocolId','protocolRevision','protocolSha256','order','trials','approvedAt',
      ...(hasPrune ? ['memoryPruneVersion'] : [])]);
    if (hasPrune && p.memoryPruneVersion !== CLAIM_PRUNE_V2) return fail();
    const strategies = order(p.order);
    if (p.schemaVersion !== 'reception_plan_v1' || !uuid.test(p.protocolId) || !int(p.protocolRevision) || p.protocolRevision < 1 ||
      typeof p.protocolSha256 !== 'string' || !owner.test(p.protocolSha256) || !iso(p.approvedAt) ||
      !Array.isArray(p.trials) || p.trials.length !== strategies.length) return fail();
    const trials = p.trials.map((raw: unknown, index: number) => {
      const t = object(raw, ['index','strategy','seed','referenceMemory']);
      if (t.index !== index || t.strategy !== strategies[index] || !int(t.seed) || typeof t.referenceMemory !== 'boolean' || hasPrune && !t.referenceMemory) return fail();
      return { index, strategy: strategies[index], seed: t.seed, referenceMemory: t.referenceMemory };
    });
    return { schemaVersion: 'reception_plan_v1', protocolId: p.protocolId, protocolRevision: p.protocolRevision,
      protocolSha256: p.protocolSha256, order: strategies, trials, approvedAt: p.approvedAt, ...(hasPrune ? { memoryPruneVersion: CLAIM_PRUNE_V2 } : {}) };
  } catch { return fail(); }
}
/** Effective values: a v1 plan predates these settings and means the old mechanism. */
export function effectiveRotationMode(plan: ReceptionPlan, index: number): RotationMode {
  if (!int(index) || index < 0 || index >= plan.trials.length) return fail();
  return plan.schemaVersion === 'reception_plan_v2' || plan.schemaVersion === 'reception_plan_v3' ? plan.trials[index].rotationMode : 'relative_pm90';
}
export function effectiveBetweenTrials(plan: ReceptionPlan): BetweenTrials {
  return plan.schemaVersion === 'reception_plan_v2' || plan.schemaVersion === 'reception_plan_v3' ? plan.betweenTrials : 'none';
}
/** v1 and v2 plans predate the figure bank and mean the legacy F1-F6 set. */
export function effectiveFigureSelection(plan: ReceptionPlan, index: number): ResolvedFigureSelection {
  if (!int(index) || index < 0 || index >= plan.trials.length) return fail();
  return plan.schemaVersion === 'reception_plan_v3' ? plan.trials[index].figureSelection : resolveFigureSelection(undefined);
}
export function effectiveParticipantModelPin(plan: ReceptionPlan): ParticipantModelPin | undefined {
  return plan.schemaVersion === 'reception_plan_v1' ? undefined : plan.participantModelPin;
}
export function validateReception(value: unknown): Reception {
  try {
    const keys = ['schemaVersion','receptionId','objectId','createdAt','number','status','plan','revision','trials'];
    if (value && typeof value === 'object' && Object.hasOwn(value, 'termination')) keys.push('termination');
    const r = object(value, keys);
    if (r.schemaVersion !== 'reception_v1' || !uuid.test(r.receptionId) || !owner.test(r.objectId) || !iso(r.createdAt) ||
      r.number !== null && (typeof r.number !== 'string' || !/^\d{3}$/u.test(r.number)) ||
      !['pending','approved','in_progress','finished','cancelled','interrupted'].includes(r.status) ||
      (r.status === 'interrupted' ? !isAdminTermination(r.termination) : Object.hasOwn(r, 'termination')) ||
      !int(r.revision) || r.revision < 0 || !Array.isArray(r.trials)) return fail();
    const plan = r.plan === null ? null : validateReceptionPlan(r.plan);
    const trials = r.trials.map((raw: unknown, index: number) => {
      const t = object(raw, ['index','recordId']);
      if (t.index !== index || !plan || index >= plan.trials.length || t.recordId !== null && !uuid.test(t.recordId)) return fail();
      return { index, recordId: t.recordId as string | null };
    });
    if (r.status === 'pending' && (plan || trials.length) || ['approved','in_progress','finished','interrupted'].includes(r.status) && !plan ||
      ['approved','cancelled'].includes(r.status) && trials.length || ['in_progress','interrupted'].includes(r.status) && !trials.length ||
      r.status === 'finished' && (!plan || trials.length !== plan.trials.length || trials.some((t: {recordId: string|null}) => !t.recordId))) return fail();
    return { schemaVersion:'reception_v1', receptionId:r.receptionId, objectId:r.objectId, createdAt:r.createdAt,
      number:r.number, status:r.status, plan, revision:r.revision, trials,
      ...(r.status === 'interrupted' ? { termination: { ...r.termination } } : {}) };
  } catch { return fail(); }
}
export function createReception(input: { receptionId: string; objectId: string; createdAt: string; number: string | null }): Reception {
  return validateReception({ schemaVersion:'reception_v1', ...input, status:'pending', plan:null, revision:0, trials:[] });
}
function displayed(value: unknown): DisplayedProtocol {
  try {
    const d = object(value, ['protocolId','revision','sha256']);
    if (!uuid.test(d.protocolId) || !int(d.revision) || d.revision < 1 || typeof d.sha256 !== 'string' || !owner.test(d.sha256)) return fail();
    return { protocolId: d.protocolId, revision: d.revision, sha256: d.sha256 };
  } catch { return fail('protocol_changed'); }
}
/** Check the approval intent before claiming a prepared bundle; this does not draw any random material. */
export function validateReceptionApprovalInput(value: unknown, options: {
  expectedRevision: number; order: number; protocol: unknown; expected?: unknown;
}): void {
  const r = validateReception(value);
  const version = options.protocol && typeof options.protocol === 'object' ? (options.protocol as { schemaVersion?: unknown }).schemaVersion : undefined;
  const p = version === 'reception_protocol_v3' ? validateReceptionProtocolV3(options.protocol)
    : version === 'reception_protocol_v2' ? validateReceptionProtocolV2(options.protocol) : validateReceptionProtocol(options.protocol);
  if (r.status !== 'pending' || r.revision !== options.expectedRevision) return fail('reception_conflict');
  if (p.schemaVersion !== 'reception_protocol_v1') {
    const shown = displayed(options.expected);
    if (shown.protocolId !== p.protocolId || shown.revision !== p.revision || shown.sha256 !== receptionProtocolSha256(JSON.stringify(p))) return fail('protocol_changed');
  }
  if (!int(options.order) || !p.allowedOrders[options.order]) return fail('invalid_order');
}

/**
 * v1 (pure, legacy) freezes a v1 plan exactly as before. v2 requires the displayed
 * version and compares it with the same protocol snapshot the plan is copied from.
 */
export async function approveReception(value: unknown, options: ParticipantPlanSettings & {
  expectedRevision: number; order: number; protocol: unknown; expected?: unknown; approvedAt: string; randomSeed: () => number;
}): Promise<Reception> {
  const r = validateReception(value);
  const v24 = options.participantDialogueProfile === PILOT012_V24_PARTICIPANT_PROFILE;
  if (options.postGenerationCheck !== undefined && (!v24 || !isPostGenerationCheck(options.postGenerationCheck))) return fail();
  const participant = {
    ...(options.preparedObservations !== undefined ? { preparedObservations: options.preparedObservations } : {}),
    ...(options.openingMode !== undefined ? { openingMode: options.openingMode } : {}),
    ...(options.memoryPruneVersion !== undefined ? { memoryPruneVersion: options.memoryPruneVersion } : {}),
    ...(options.participantModelPin !== undefined ? { participantModelPin: options.participantModelPin } : {}),
    ...(options.participantLimits !== undefined ? { participantLimits: options.participantLimits } : {}),
    ...(options.participantRuntimeProfile !== undefined ? { participantRuntimeProfile: options.participantRuntimeProfile } : {}),
    ...(options.participantDialogueProfile !== undefined ? { participantDialogueProfile: options.participantDialogueProfile } : {}),
    ...(v24 ? { postGenerationCheck: options.postGenerationCheck ?? 'off' } : {}),
    ...(options.initialObservationGeneration !== undefined ? { initialObservationGeneration: options.initialObservationGeneration } : {}),
  };
  if (options.protocol && typeof options.protocol === 'object' && (options.protocol as { schemaVersion?: unknown }).schemaVersion === 'reception_protocol_v3') {
    const p = validateReceptionProtocolV3(options.protocol), canonical = JSON.stringify(p), sha256 = receptionProtocolSha256(canonical);
    if (r.status !== 'pending' || r.revision !== options.expectedRevision) return fail('reception_conflict');
    const shown = displayed(options.expected);
    if (shown.protocolId !== p.protocolId || shown.revision !== p.revision || shown.sha256 !== sha256) return fail('protocol_changed');
    if (!int(options.order) || !p.allowedOrders[options.order]) return fail('invalid_order');
    const selected = p.allowedOrders[options.order], seeds = selected.map((_, i) => i === 0 || p.seedPolicy === 'per_trial' ? options.randomSeed() : null);
    // Figure seeds are drawn after the trial seeds, so the trial seed sequence equals v2's.
    const figures: ResolvedFigureSelection[] = [];
    try {
      if (p.figureSetPolicy === 'shared') {
        const one = p.figureSelection.mode === 'seeded_random'
          ? resolveFigureSelection({ ...p.figureSelection, selectionSeed: p.figureSelection.selectionSeed ?? options.randomSeed() })
          : resolveFigureSelection(p.figureSelection);
        selected.forEach(() => figures.push(one));
      } else {
        if (p.figureSelection.mode !== 'seeded_random') return fail();
        const selection = p.figureSelection, base = selection.selectionSeed;
        selected.forEach((_, i) => {
          let seed = base === null ? options.randomSeed() : base + i;
          // Distinct seeds can still draw the same figures in a different order.
          for (let attempt = 0; attempt < 32; attempt++) {
            if (!int(seed)) throw new Error('seed');
            const candidate = resolveFigureSelection({ ...selection, selectionSeed: seed });
            if (!figures.some(prior => candidate.figureIds.every(id => prior.figureIds.includes(id)))) {
              figures.push(candidate);
              return;
            }
            seed = base === null && attempt < 16 ? options.randomSeed() : seed + 1;
          }
          throw new Error('figure_set_collision');
        });
      }
    } catch { return fail(); }
    const plan = validateReceptionPlan({ schemaVersion:'reception_plan_v3', protocolId:p.protocolId, protocolRevision:p.revision,
      protocolSha256:sha256, order:selected, betweenTrials:p.betweenTrials, approvedAt:options.approvedAt,
      ...participant, trials:selected.map((strategy, index) => ({ index, strategy, seed:seeds[index] ?? seeds[0], referenceMemory:p.referenceMemory,
        rotationMode:p.rotationMode, figureSelection:figures[index] })) });
    return validateReception({ ...r, status:'approved', plan, revision:r.revision+1 });
  }
  if (options.protocol && typeof options.protocol === 'object' && (options.protocol as { schemaVersion?: unknown }).schemaVersion === 'reception_protocol_v2') {
    const p = validateReceptionProtocolV2(options.protocol), canonical = JSON.stringify(p), sha256 = receptionProtocolSha256(canonical);
    if (r.status !== 'pending' || r.revision !== options.expectedRevision) return fail('reception_conflict');
    const shown = displayed(options.expected);
    if (shown.protocolId !== p.protocolId || shown.revision !== p.revision || shown.sha256 !== sha256) return fail('protocol_changed');
    if (!int(options.order) || !p.allowedOrders[options.order]) return fail('invalid_order');
    const selected = p.allowedOrders[options.order], seeds = selected.map((_, i) => i === 0 || p.seedPolicy === 'per_trial' ? options.randomSeed() : null);
    const plan = validateReceptionPlan({ schemaVersion:'reception_plan_v2', protocolId:p.protocolId, protocolRevision:p.revision,
      protocolSha256:sha256, order:selected, betweenTrials:p.betweenTrials, approvedAt:options.approvedAt,
      ...participant, trials:selected.map((strategy, index) => ({ index, strategy, seed:seeds[index] ?? seeds[0], referenceMemory:p.referenceMemory, rotationMode:p.rotationMode })) });
    return validateReception({ ...r, status:'approved', plan, revision:r.revision+1 });
  }
  const { memoryPruneVersion, ...legacyParticipant } = participant;
  if (Object.keys(legacyParticipant).length) return fail('protocol_unconfigured');
  const p = validateReceptionProtocol(options.protocol);
  if (r.status !== 'pending' || r.revision !== options.expectedRevision) return fail('reception_conflict');
  if (!int(options.order) || !p.allowedOrders[options.order]) return fail('invalid_order');
  const selected = p.allowedOrders[options.order], seeds = selected.map((_, i) => i === 0 || p.seedPolicy === 'per_trial' ? options.randomSeed() : null);
  const plan = validateReceptionPlan({ schemaVersion:'reception_plan_v1', protocolId:p.protocolId, protocolRevision:p.revision,
    protocolSha256:createHash('sha256').update(canonicalReceptionProtocol(p)).digest('hex'), order:selected,
    trials:selected.map((strategy, index) => ({ index, strategy, seed:seeds[index] ?? seeds[0], referenceMemory:p.referenceMemory })), approvedAt:options.approvedAt,
    ...(memoryPruneVersion ? { memoryPruneVersion } : {}) });
  return validateReception({ ...r, status:'approved', plan, revision:r.revision+1 });
}
export function cancelReception(value: unknown, expectedRevision: number): Reception {
  const r = validateReception(value);
  if (!['pending','approved'].includes(r.status) || r.trials.length || r.revision !== expectedRevision) return fail('reception_conflict');
  return validateReception({ ...r, status:'cancelled', revision:r.revision+1 });
}
export function terminateReception(reception: Reception, expectedRevision: number, termination: AdminTermination): Reception {
  if (reception.status === 'interrupted') return reception;
  if (reception.status !== 'in_progress' || reception.revision !== expectedRevision) return fail('reception_conflict');
  return validateReception({ ...reception, status:'interrupted', revision:reception.revision+1, termination });
}
/** Public projection: three fields only. `questionnaire` means the plan waits for the predecessor's questionnaire. */
export function participantReception(value: unknown, context: { awaitingQuestionnaire?: boolean } = {}) {
  const r = validateReception(value);
  const status = r.status === 'in_progress' && context.awaitingQuestionnaire === true ? 'questionnaire'
    : ({ pending:'waiting', approved:'ready', in_progress:'in_progress', finished:'finished', cancelled:'unavailable', interrupted:'interrupted' } as const)[r.status];
  return { number:r.number, status, revision:r.revision };
}
export function receptionSummary(value: unknown): ReceptionSummary {
  const r = validateReception(value);
  return { receptionId:r.receptionId, objectId:r.objectId, number:r.number, createdAt:r.createdAt, status:r.status, revision:r.revision, trials:r.trials };
}
/** Supported mechanism only: researchers select a format in their protocol. */
const numberFormats = {
  daily_seq3: { format: (seq: number) => seq <= 999 ? String(seq).padStart(3,'0') : null,
    day: (ms: number) => new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0,10) },
};
export function formatReceptionNumber(format: string, seq: number): string | null {
  if (format !== 'daily_seq3' || !int(seq) || seq < 1) return fail();
  return numberFormats[format].format(seq);
}
export function receptionNumberDay(format: string, ms: number): string {
  if (format !== 'daily_seq3' || !int(ms) || !Number.isFinite(new Date(ms).getTime())) return fail();
  return numberFormats[format].day(ms);
}
