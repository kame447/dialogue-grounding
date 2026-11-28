// Shared validation internals. node:crypto is already available to the Worker
// under its existing nodejs_compat flag (also used by the stimulus generator).
import { isOpeningMode } from './opening-mode.ts';
import { preparedTrialObservation, validatePreparedTrialObservation } from './prepared-observations.ts';
import { validateObservationMemo } from '../observation/observe.ts';
import { researchHash } from './research-profile.ts';
import { sameRotationMemoryPin, validateRotationMemoryRecord } from './rotation-memory-pin.ts';
import { CLAIM_PRUNE_V2 } from '../memory/reference-graph.mjs';
import { createHash } from 'node:crypto';
import type { BaseAssignmentConfig, BaseAssignment, BaseRecord, BaseOwnerState, StartIntent } from './base-assignment.ts';
import { validateReceptionPlan, effectiveRotationMode, effectiveFigureSelection, effectiveParticipantModelPin, ROTATION_MODES } from './reception.ts';
import { PARTICIPANT_PRODUCTION_PROFILE } from '../web/participant-usage-policy.ts';
import { validateParticipantModelPin } from './participant-model-pin.ts';
import { resolveFigureSelection, validateResolvedFigureSelection, isLegacyFigureSelection } from '../stimuli/figure-bank.ts';
import type { ResolvedFigureSelection } from '../stimuli/figure-bank.ts';
import type { RotationMode } from './reception.ts';
import { isAdminTermination, isIncompleteTrialStatus } from './admin-termination.ts';
export type BaseAssignmentErrorCode = 'invalid_request' | 'assignment_unconfigured' | 'assignment_invalid' |
  'assignment_conflict' | 'assignment_record_invalid';
export class BaseAssignmentError extends Error {
  readonly code: BaseAssignmentErrorCode;
  constructor(code: BaseAssignmentErrorCode) { super(code); this.name = 'BaseAssignmentError'; this.code = code; }
}
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export const OWNER = /^[a-f0-9]{64}$/u;
const SHA = OWNER;
export function data(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('shape');
  const names = Reflect.ownKeys(value);
  if (names.some(k => typeof k !== 'string') || keys && (names.length !== keys.length || names.some(k => !keys.includes(k as string)))) throw new Error('keys');
  const out: Record<string, unknown> = {};
  for (const key of names as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new Error('data');
    Object.defineProperty(out, key, { value: descriptor.value, enumerable: true, writable: true, configurable: true });
  }
  return out;
}
export const FAILURE_CAUSES = ['observation_timeout', 'observation_invalid', 'observation_unavailable', 'observation_aborted', 'decision_failed',
  'generation_failed', 'invalid_state', 'unknown'] as const;
const isRecordWith = (v: unknown, key: string) => !!v && typeof v === 'object' && Object.hasOwn(v, key);
export const safeInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
export function readStartIntent(value: unknown): StartIntent {
  return guard('invalid_request', () => {
    const i = data(value);
    if (typeof i.id !== 'string' || !V4.test(i.id) || Object.keys(i).some(k => !['id', 'expectedReceptionRevision', 'expectedRecordId'].includes(k)) ||
        Object.hasOwn(i, 'expectedReceptionRevision') && (!safeInt(i.expectedReceptionRevision) || i.expectedReceptionRevision < 0) ||
        Object.hasOwn(i, 'expectedRecordId') && (typeof i.expectedRecordId !== 'string' || !UUID.test(i.expectedRecordId) || i.expectedReceptionRevision === undefined)) throw new Error('start intent');
    return i as StartIntent;
  });
}
const positive = (v: unknown): v is number => safeInt(v) && v > 0;
const strategy = (v: unknown) => v === 'repair-first' || v === 'bypass-enabled';
function guard<T>(code: BaseAssignmentErrorCode, fn: () => T): T { try { return fn(); } catch { throw new BaseAssignmentError(code); } }
export function validateBaseAssignmentConfig(value: unknown): BaseAssignmentConfig {
  return guard(value === null || value === undefined ? 'assignment_unconfigured' : 'assignment_invalid', () => {
    const c = data(value);
    if (!Object.hasOwn(c, 'referenceMemory')) c.referenceMemory = true;
    data(c, ['schemaVersion', 'configId', 'revision', 'strategy', 'seed', 'referenceMemory']);
    if (c.schemaVersion !== 'base_assignment_config_v1' || typeof c.configId !== 'string' || !V4.test(c.configId) ||
        !positive(c.revision) || !strategy(c.strategy) || !safeInt(c.seed) || typeof c.referenceMemory !== 'boolean') throw new Error('value');
    return Object.freeze({ schemaVersion: 'base_assignment_config_v1', configId: c.configId, revision: c.revision,
      strategy: c.strategy, seed: c.seed, referenceMemory: c.referenceMemory }) as BaseAssignmentConfig;
  });
}
export function validateBaseStart(value: unknown): Readonly<{ version: 2 }> {
  return guard('invalid_request', () => { const b = data(value, ['version']); if (b.version !== 2) throw new Error('version'); return Object.freeze({ version: 2 }); });
}
export function canonicalBaseAssignmentConfig(value: unknown): string { return JSON.stringify(validateBaseAssignmentConfig(value)); }
export function configFromAssignment(a: BaseAssignment): BaseAssignmentConfig {
  if (a.source.kind !== 'server_config_v1') throw new BaseAssignmentError('assignment_record_invalid');
  return validateBaseAssignmentConfig({ schemaVersion: 'base_assignment_config_v1', configId: a.source.configId,
    revision: a.source.revision, strategy: a.strategy, seed: a.seed, referenceMemory: a.referenceMemory });
}
export function readAssignment(value: unknown): BaseAssignment {
  return guard('assignment_record_invalid', () => {
    const a = data(value, ['schemaVersion', 'assignmentId', 'strategy', 'seed', 'referenceMemory', 'source', 'createdAt']);
    const rawSource = data(a.source);
    if (rawSource.kind === 'reception_plan_v1' || rawSource.kind === 'reception_plan_v2' || rawSource.kind === 'reception_plan_v3') {
      const s = data(rawSource, ['kind','adapter','receptionId','protocolId','protocolRevision','protocolSha256','trialIndex','plan']);
      const plan = validateReceptionPlan(s.plan);
      // The provenance kind names the embedded plan version; mixing them is never accepted.
      if (s.kind !== plan.schemaVersion) throw new Error('version');
      if (!safeInt(s.trialIndex) || s.trialIndex < 0 || s.trialIndex >= plan.trials.length) throw new Error('index');
      const t = plan.trials[s.trialIndex];
      if (a.schemaVersion !== 'base_assignment_v1' || typeof a.assignmentId !== 'string' || !V4.test(a.assignmentId) ||
        s.adapter !== 'worker_binding' || typeof s.receptionId !== 'string' || !V4.test(s.receptionId) ||
        s.protocolId !== plan.protocolId || s.protocolRevision !== plan.protocolRevision || s.protocolSha256 !== plan.protocolSha256 ||
        a.strategy !== t.strategy || a.seed !== t.seed || a.referenceMemory !== t.referenceMemory ||
        typeof a.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(a.createdAt) || new Date(a.createdAt).toISOString() !== a.createdAt) throw new Error('assignment');
      return Object.freeze({ schemaVersion:'base_assignment_v1', assignmentId:a.assignmentId, strategy:a.strategy,
        seed:a.seed, referenceMemory:a.referenceMemory, source:Object.freeze({ kind:plan.schemaVersion, adapter:s.adapter,
          receptionId:s.receptionId, protocolId:s.protocolId, protocolRevision:s.protocolRevision, protocolSha256:s.protocolSha256,
          trialIndex:s.trialIndex, plan }), createdAt:a.createdAt }) as BaseAssignment;
    }
    // Preserve every existing server_config_v1 field and digest validation.
    const hasPrune = Object.hasOwn(rawSource, 'memoryPruneVersion');
    const hasOpeningMode = Object.hasOwn(rawSource, 'openingMode');
    const s = data(rawSource, ['kind', 'adapter', 'configId', 'revision', 'configSha256', ...(hasPrune ? ['memoryPruneVersion'] : []), ...(hasOpeningMode ? ['openingMode'] : [])]);
    if (hasOpeningMode && !isOpeningMode(s.openingMode)) throw new Error('opening_mode');
    if (hasPrune && (s.memoryPruneVersion !== CLAIM_PRUNE_V2 || s.adapter !== 'local_private_file' || a.referenceMemory !== true)) throw new Error('memory_prune_version');
    if (a.schemaVersion !== 'base_assignment_v1' || typeof a.assignmentId !== 'string' || !V4.test(a.assignmentId) ||
        !strategy(a.strategy) || !safeInt(a.seed) || typeof a.referenceMemory !== 'boolean' || s.kind !== 'server_config_v1' ||
        !['local_private_file', 'worker_binding'].some(v => v === s.adapter) || typeof s.configId !== 'string' || !V4.test(s.configId) ||
        !positive(s.revision) || typeof s.configSha256 !== 'string' || !SHA.test(s.configSha256) || typeof a.createdAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(a.createdAt) || new Date(a.createdAt).toISOString() !== a.createdAt) throw new Error('assignment');
    const result = { schemaVersion: 'base_assignment_v1', assignmentId: a.assignmentId, strategy: a.strategy, seed: a.seed, referenceMemory: a.referenceMemory, source: Object.freeze({ kind: s.kind, adapter: s.adapter, configId: s.configId, revision: s.revision, configSha256: s.configSha256, ...(hasPrune ? { memoryPruneVersion: CLAIM_PRUNE_V2 } : {}), ...(hasOpeningMode ? { openingMode: s.openingMode } : {}) }), createdAt: a.createdAt } as BaseAssignment;
    const canonical = canonicalBaseAssignmentConfig(configFromAssignment(result));
    if (createHash('sha256').update(canonical).digest('hex') !== s.configSha256) throw new Error('digest');
    return Object.freeze(result);
  });
}
/** The stimulus mode an assignment requires. server_config_v1 and v1 plans predate the setting. */
export function assignmentRotationMode(a: BaseAssignment): RotationMode {
  return a.source.kind === 'server_config_v1' ? 'relative_pm90' : effectiveRotationMode(a.source.plan, a.source.trialIndex);
}
export function assignmentMemoryPruneVersion(a: BaseAssignment) {
  return a.source.kind === 'server_config_v1' ? a.source.memoryPruneVersion : a.source.plan.memoryPruneVersion;
}
export function assignmentPartObservationVersion(a: BaseAssignment) {
  return a.source.kind === 'reception_plan_v2' || a.source.kind === 'reception_plan_v3'
    ? a.source.plan.partObservationVersion : undefined;
}
export function assignmentRotationMemory(a: BaseAssignment) {
  return a.source.kind === 'reception_plan_v2' || a.source.kind === 'reception_plan_v3'
    ? a.source.plan.rotationMemory : undefined;
}
export function assignmentOpeningMode(a: BaseAssignment) {
  return a.source.kind === 'server_config_v1' ? a.source.openingMode
    : a.source.kind === 'reception_plan_v1' ? undefined : a.source.plan.openingMode;
}
export function assignmentPreparedObservation(a: BaseAssignment) {
  if (a.source.kind !== 'reception_plan_v2' && a.source.kind !== 'reception_plan_v3') return undefined;
  return a.source.plan.preparedObservations ? preparedTrialObservation(a.source.plan.preparedObservations, a.source.trialIndex) : undefined;
}
export function assignmentParticipantModelPin(a: BaseAssignment) {
  return a.source.kind === 'server_config_v1' ? undefined : effectiveParticipantModelPin(a.source.plan);
}
/** The figure selection an assignment requires; only reception_plan_v3 carries one, everything older is the legacy set. */
export function assignmentFigureSelection(a: BaseAssignment): ResolvedFigureSelection {
  return a.source.kind === 'reception_plan_v3' ? effectiveFigureSelection(a.source.plan, a.source.trialIndex) : resolveFigureSelection(undefined);
}
export function assignmentParticipantDialogueProfile(a: BaseAssignment) {
  return a.source.kind === 'reception_plan_v2' || a.source.kind === 'reception_plan_v3'
    ? a.source.plan.participantDialogueProfile : undefined;
}
const angles = (value: unknown) => { const o = data(value); if (Object.values(o).some(v => typeof v !== 'number' || !Number.isFinite(v))) throw new Error('angle'); };
/**
 * New records carry both options.rotationMode and the generated stimulus; only
 * records from server_config_v1 or v1 plans may predate both. Nothing is filled in.
 */
function checkRotation(r: Record<string, unknown>, options: Record<string, unknown>, a: BaseAssignment): void {
  const hasMode = Object.hasOwn(options, 'rotationMode'), hasStimulus = Object.hasOwn(r, 'stimulus');
  if (!hasMode && !hasStimulus && a.source.kind !== 'reception_plan_v2' && a.source.kind !== 'reception_plan_v3') {
    if (Object.hasOwn(options, 'figureSelection')) throw new Error('figureSelection');
    return;
  }
  if (!hasMode || !hasStimulus || !ROTATION_MODES.some(m => m === options.rotationMode) || options.rotationMode !== assignmentRotationMode(a)) throw new Error('mode');
  const stimulus = data(r.stimulus), recorded = data(stimulus.angles, ['human', 'ai']);
  if (typeof stimulus.version !== 'string' || !stimulus.version || stimulus.rotationMode !== options.rotationMode) throw new Error('stimulus');
  angles(recorded.human); angles(recorded.ai);
  checkFigureSelection(r, options, stimulus, a);
}
const STIMULUS_FIGURE_KEYS = ['bankVersion', 'figureSetId', 'figureIds', 'selectionSeed', 'selectionMode'] as const;
/**
 * reception_plan_v3 records must carry options.figureSelection equal to the plan's. Older sources may omit it
 * (and then the stimulus must not carry figure metadata); a present selection is always strictly validated.
 */
function checkFigureSelection(_r: Record<string, unknown>, options: Record<string, unknown>, stimulus: Record<string, unknown>, a: BaseAssignment): void {
  const has = Object.hasOwn(options, 'figureSelection');
  if (!has) {
    if (a.source.kind === 'reception_plan_v3') throw new Error('figureSelection');
    if (STIMULUS_FIGURE_KEYS.some(k => Object.hasOwn(stimulus, k))) throw new Error('figureSelection');
    return;
  }
  const recorded = validateResolvedFigureSelection(options.figureSelection);
  const expected = assignmentFigureSelection(a);
  if (JSON.stringify(recorded) !== JSON.stringify(expected)) throw new Error('figureSelection');
  if (isLegacyFigureSelection(recorded)) {
    if (STIMULUS_FIGURE_KEYS.some(k => Object.hasOwn(stimulus, k))) throw new Error('stimulus');
    return;
  }
  if (stimulus.bankVersion !== recorded.bankVersion || stimulus.figureSetId !== recorded.setId || stimulus.selectionSeed !== recorded.selectionSeed ||
      stimulus.selectionMode !== recorded.mode || !Array.isArray(stimulus.figureIds) || stimulus.figureIds.length !== recorded.figureIds.length ||
      stimulus.figureIds.some((id, i) => id !== recorded.figureIds[i])) throw new Error('stimulus');
}
export function validateBoundBaseRecord(record: unknown, assignment: unknown): void {
  guard('assignment_record_invalid', () => {
    const a = readAssignment(assignment), r = data(record), own = readAssignment(r.assignment), options = data(r.options), queue = data(r.queueState);
    checkRotation(r, options, a);
    const pin = assignmentParticipantModelPin(a);
    const recordedPin = Object.hasOwn(options, 'participantModelPin')
      ? validateParticipantModelPin(options.participantModelPin) : undefined;
    if (JSON.stringify(pin) !== JSON.stringify(recordedPin) || pin && options.jevResearch !== true) throw new Error('model_pin');
    const plan = a.source.kind === 'reception_plan_v2' || a.source.kind === 'reception_plan_v3' ? a.source.plan : null;
    const profile = plan?.participantRuntimeProfile;
    const partObservationVersion = assignmentPartObservationVersion(a);
    if (partObservationVersion ? options.partObservationVersion !== partObservationVersion : Object.hasOwn(options, 'partObservationVersion')) throw new Error('part_observation_version');
    const rotationMemory = assignmentRotationMemory(a);
    const recordedRotation = Object.hasOwn(options, 'rotationMemory') ? validateRotationMemoryRecord(options.rotationMemory) : undefined;
    // The record's pin is the plan's. The bundle actually used is only recorded: a different one never refuses a restore.
    if (rotationMemory ? !recordedRotation || !sameRotationMemoryPin(recordedRotation.pin, rotationMemory) : recordedRotation !== undefined) throw new Error('rotation_memory');
    if (rotationMemory) {
      // The saved projection is the initial memo itself; its recorded hash is checked, the current bundle never is.
      const initialMemo = validateObservationMemo(data(queue.privateState).observationMemo);
      for (const figure of initialMemo.figures) figure.reobservations = [];
      if (researchHash(initialMemo) !== data(r.initialObservation).memoSha256) throw new Error('rotation_memory');
    }
    const openingMode = assignmentOpeningMode(a);
    if (openingMode ? options.openingMode !== openingMode : Object.hasOwn(options, 'openingMode')) throw new Error('opening_mode');
    const memoryPruneVersion = assignmentMemoryPruneVersion(a);
    const graph = (queue.privateState as { graph?: { memoryPruneVersion?: unknown } } | null)?.graph;
    if ((memoryPruneVersion ? options.memoryPruneVersion !== memoryPruneVersion : Object.hasOwn(options, 'memoryPruneVersion')) ||
        graph?.memoryPruneVersion !== memoryPruneVersion) throw new Error('memory_prune_version');
    const preparedObservation = assignmentPreparedObservation(a);
    const recordedObservation = Object.hasOwn(options, 'preparedObservation') ? validatePreparedTrialObservation(options.preparedObservation) : undefined;
    if (JSON.stringify(preparedObservation) !== JSON.stringify(recordedObservation)) throw new Error('prepared_observation');
    if (preparedObservation) {
      // Reobservations append evidence; the initial memo's contents and timestamp remain unchanged.
      const initialMemo = validateObservationMemo(data(queue.privateState).observationMemo);
      for (const figure of initialMemo.figures) figure.reobservations = [];
      if (createHash('sha256').update(JSON.stringify(initialMemo)).digest('hex') !== preparedObservation.memoSha256 ||
          researchHash(initialMemo) !== data(r.initialObservation).memoSha256) throw new Error('prepared_observation');
    }
    const generation = plan?.initialObservationGeneration;
    const dialogueProfile = assignmentParticipantDialogueProfile(a);
    if (dialogueProfile === undefined ? Object.hasOwn(options, 'participantDialogueProfile')
      : options.participantDialogueProfile !== dialogueProfile) throw new Error('dialogue_profile');
    const postGenerationCheck = plan?.postGenerationCheck;
    if (postGenerationCheck === undefined ? Object.hasOwn(options, 'postGenerationCheck')
      : options.postGenerationCheck !== postGenerationCheck) throw new Error('post_generation_check');
    if (generation ? options.initialObservationGeneration !== generation : Object.hasOwn(options, 'initialObservationGeneration')) {
      throw new Error('observation_generation');
    }
    const ledger = r.jevLedger && typeof r.jevLedger === 'object' ? data(r.jevLedger) : null;
    if (profile ? options.participantRuntimeProfile !== profile || ledger?.schemaVersion !== PARTICIPANT_PRODUCTION_PROFILE ||
        ledger.assignmentId !== a.assignmentId || Object.hasOwn(ledger, 'limits')
      : Object.hasOwn(options, 'participantRuntimeProfile') || ledger?.schemaVersion === PARTICIPANT_PRODUCTION_PROFILE) throw new Error('runtime_profile');
    if (typeof r.recordId !== 'string' || !UUID.test(r.recordId) || r.version !== 2 || r.seed !== a.seed || r.strategy !== a.strategy ||
        options.referenceMemory !== a.referenceMemory ||
        (r.status === 'interrupted' ? !isAdminTermination(r.termination)
          : !(isIncompleteTrialStatus(r.status) || r.status === 'completed') || Object.hasOwn(r, 'termination')) ||
        !Array.isArray(queue.pendingHumanEventIds) || queue.pendingHumanEventIds.some(v => typeof v !== 'string') ||
        queue.errorCode !== null && typeof queue.errorCode !== 'string' || JSON.stringify(own) !== JSON.stringify(a)) throw new Error('record');
  });
}
/** Detached owner state: never trust a saved active pointer without its envelope. */
export function readOwner(value: unknown, ownerId: string): BaseOwnerState {
  return guard('assignment_record_invalid', () => {
    const o = data(value, ['schemaVersion', 'ownerId', 'revision', 'activeKey', 'admissions']), admissions = data(o.admissions);
    if (!OWNER.test(ownerId) || o.schemaVersion !== 'base_owner_v1' || o.ownerId !== ownerId || !safeInt(o.revision) || o.revision < 0 ||
        o.activeKey !== null && (typeof o.activeKey !== 'string' || !Object.hasOwn(admissions, o.activeKey))) throw new Error('owner');
    if (o.activeKey === null && Object.keys(admissions).length) throw new Error('pointer');
    const assignmentIds = new Set<string>(), recordIds = new Set<string>(), intentIds = new Set<string>();
    for (const [key, v] of Object.entries(admissions)) {
      if (key !== 'initial' && (!key.startsWith('after:') || !UUID.test(key.slice(6)))) throw new Error('key');
      const hasCause = isRecordWith(v, 'failureCause'), hasIntent = isRecordWith(v, 'startIntent');
      const e = data(v, ['schemaVersion', 'assignment', 'status', 'record', 'errorCode',
        ...(hasCause ? ['failureCause'] : []), ...(hasIntent ? ['startIntent'] : [])]), a = readAssignment(e.assignment);
      if (hasIntent) {
        const intent = readStartIntent(e.startIntent);
        if (intentIds.has(intent.id) || (a.source.kind === 'server_config_v1') !== (intent.expectedReceptionRevision === undefined) ||
            intent.expectedRecordId !== (key === 'initial' ? undefined : key.slice(6))) throw new Error('start intent');
        intentIds.add(intent.id);
      }
      if (e.schemaVersion !== 'base_assigned_session_v1' || assignmentIds.has(a.assignmentId)) throw new Error('assignment'); assignmentIds.add(a.assignmentId);
      if (e.status === 'active' ? e.record === null || e.errorCode !== null : e.status === 'preparing' ? e.errorCode !== null :
          e.status !== 'failed' || !['start_interrupted', 'initialization_failed', 'record_write_failed', 'assignment_record_invalid', 'record_deleted'].some(c => c === e.errorCode)) throw new Error('status');
      if (e.errorCode === 'record_deleted' && e.record !== null) throw new Error('deleted');
      if (hasCause && (e.status !== 'failed' || e.errorCode !== 'initialization_failed' || !FAILURE_CAUSES.some(c => c === e.failureCause))) throw new Error('cause');
      if (e.record !== null) { validateBoundBaseRecord(e.record, a); const id = (e.record as BaseRecord).recordId; if (recordIds.has(id)) throw new Error('record'); recordIds.add(id); }
    }
    return structuredClone(value) as BaseOwnerState;
  });
}
