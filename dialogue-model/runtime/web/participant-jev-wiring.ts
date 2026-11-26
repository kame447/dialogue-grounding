import { ParticipantUsageLedger } from './participant-usage.ts';
import { PARTICIPANT_PRODUCTION_PROFILE, PARTICIPANT_USAGE_ONLY, type ParticipantUsageOnly } from './participant-usage-policy.ts';
// Node loopback only. Explicit private configuration; never an assignment method.
import { AsyncLocalStorage } from 'node:async_hooks';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createChatClient } from '../client.mjs';
import { NamingTaskError } from '../naming-error.mjs';
import { createTrialV2, modelView } from '../stimuli/scatter-v2.mjs';
import { STRATEGIES } from '../judgment/instructions.mjs';
import { isLegacyFigureSelection, resolveFigureSelection, validateResolvedFigureSelection } from '../stimuli/figure-bank.ts';
import { data } from '../v2/base-assignment-data.ts';
import { privateDirectory, readPrivateAssignment } from './base-assignment-store.ts';
import { researchHash, researchTrialProfileV3 } from '../v2/research-profile.ts';
import type { ResearchTrialProfileV3 } from '../v2/research-profile.ts';
import { resolveInterventionPolicy } from '../intervention-policy.ts';
import { RESEARCH_MAX_DEADLINE_MS } from '../v2/research-timeouts.ts';
import { researchGenerationClient } from '../v2/research-generation-client.ts';
import { createObservationCache } from '../observation/cache.ts';
import type { ObservationCacheAudit } from '../observation/cache.ts';
import { createLunaObserver } from '../observation/observe.ts';
import type { ObservationInput, ObservationObserver } from '../observation/contract.ts';
import { createJevDecisionClient, JevDecisionError, validateRepairProspectMaterial, checkDecisionFailureEvidence } from '../decision/jev-decision.ts';
import type { JevDecisionClient, AdaptiveRepairTrial, JevQuestionLayout } from '../decision/contract.ts';
import { isHolisticPolicy, isHolisticV3Plus } from '../decision/contract.ts';
import { hasNameProposal, traceMarkerInvalid } from '../decision/naming-request.ts';
import { literalSpan } from '../judgment/public-evidence.mjs';
import { createJevLocalTestClassifier, JevLocalTestError } from '../local-grounding/jev-local-test.ts';
import { validJevSharedConstrualTrace } from '../v2/jev-turn.ts';
import type { JevTurnLocalOptions, JevTurnOptions } from '../v2/jev-turn.ts';
import { RunBudget } from '../diagnostics/parity-live/audit.ts';
import type { BudgetLimits, SendReceipt } from '../diagnostics/parity-live/audit.ts';
import { checkModelIdentity, MODEL_CONTRACT_V2 } from '../model-identity-contract.ts';
import { RESEARCH_MAX_JEV_USD } from '../diagnostics/jev-shadow-eval/local-openrouter.ts';
import { inferenceHistory } from '../v2/agreement-gate.ts';
import { defaultGenerationRetryVersion, hasVersionedViewpoint, isGenerationV12, isGenerationV13, validGenerationRetryVersion, validAgreeNameScope } from '../v2/generation-guard.ts';
import type { GenerationRetryVersion } from '../v2/generation-guard.ts';

export type JevResearchLedger = RunBudget | ParticipantUsageLedger;
const AI_NAME_ACCEPTANCES_V1 = 'ai_name_acceptances_v1';
type ParticipantJevVersionPin = Readonly<{
  generationRetryVersion: 'jev_generation_retry_v12' | 'jev_generation_retry_v13'; namingRestoreVersion: typeof AI_NAME_ACCEPTANCES_V1;
}>;
export type JevResearchOptions<Ledger extends JevResearchLedger = RunBudget> = Readonly<{ profile: ResearchTrialProfileV3; observer: ObservationObserver;
  jevDecision: JevDecisionClient; localGrounding: JevTurnLocalOptions; ledger: Ledger; technicalTrial?: AdaptiveRepairTrial;
  generationRetryVersion?: GenerationRetryVersion;
  newTrialAgreeNameScopeVersion?: JevTurnOptions["newTrialAgreeNameScopeVersion"]; pinnedVersions?: ParticipantJevVersionPin }>;
type SelectedJevResearchOptions = JevResearchOptions<JevResearchLedger> & {
  namingRestoreVersion?: typeof AI_NAME_ACCEPTANCES_V1; participantPrompts?: true };
export class ParticipantJevError extends Error {
  readonly code: string;
  constructor(code: 'invalid_config' | 'wrong_own_material' | 'initialization_failed' | 'model_mismatch') {
    super(code); this.name = 'ParticipantJevError'; this.code = code;
  }
}
const invalid = (): never => { throw new NamingTaskError('invalid_options'); };
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const nonnegative = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
// Profile/config data must not run accessors while being compared with code-owned values.
function jsonData(value: unknown): unknown {
  if (value === null || ['string','boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonData);
  return Object.fromEntries(Object.entries(data(value)).map(([k,v]) => [k,jsonData(v)]));
}
function checkedTechnicalTrial(value: unknown): AdaptiveRepairTrial {
  const trial = data(value, ['version']);
  if (trial.version !== 'adaptive_repair_v1' && trial.version !== 'adaptive_repair_v2' && trial.version !== 'adaptive_repair_v3') throw Error();
  return { version: trial.version };
}
function checkedProfile(value: unknown): ResearchTrialProfileV3 {
  const profile = jsonData(value) as ResearchTrialProfileV3;
  if (resolveInterventionPolicy(profile).mode !== 'explicit') return invalid();
  // The stored value (or its absence) decides the version: a profile without dialoguePolicy is rebuilt without one.
  const expected = researchTrialProfileV3(profile.lunaRequest, profile.timeouts, profile.questionLayout, profile.dialoguePolicy ?? null);
  if (researchHash(profile) !== researchHash(expected)) return invalid();
  return expected;
}
/** Plan O records exist only on failed decide() attempts and must re-validate to the identical closed record. */
function checkedDecisionFailure(trace: any, layout: JevQuestionLayout, p5Enabled: boolean, usagePolicy?: ParticipantUsageOnly): boolean {
  // The local v3 rule is recorded together with its evidence; a bare rule name on a trace is a damaged record.
  if (!Object.hasOwn(trace, 'decisionFailure')) return trace.decisionRejectionCode !== 'action_target_not_allowed';
  const f = trace.decisionFailure;
  if (trace.status !== 'error' || !['decision_failed', 'invalid_decision'].includes(trace.errorCode) || !f || typeof f !== 'object' ||
      Object.getPrototypeOf(f) !== Object.prototype || Reflect.ownKeys(f).length !== 1 || !Object.hasOwn(f, 'evidence')) return false;
  if (f.evidence === null) return trace.decisionRejectionCode !== 'action_target_not_allowed';
  // The trace names its own condition (a typed naming request of a holistic_v3 turn): only then may accept be missing from the first stage.
  const checked = checkDecisionFailureEvidence(f.evidence, { usagePolicy, p5Enabled, acceptOptional: trace.namingRequest === true && Array.isArray(trace.local?.claims) && hasNameProposal(trace.local.claims, trace.turnIndex) });
  if (checked === null || checked.questionLayout !== layout || researchHash(checked) !== researchHash(jsonData(f.evidence))) return false;
  // A decision the local v3 table refused names its rule twice, in the turn and in the evidence, and in no other way; no native failure may carry it.
  const local = checked.rejectionCode === 'action_target_not_allowed' && checked.stages.length === 0;
  if (local) return trace.errorCode === 'invalid_decision' && trace.decisionRejectionCode === 'action_target_not_allowed';
  return trace.decisionRejectionCode !== 'action_target_not_allowed';
}

/** Restore only the dependency of a verified AI acceptance. Its local ID belongs to the turn that installed it. */
function checkedAiNameAcceptances(trace: any, previousJudgment: any, earlierClaims: readonly any[], graphRecords: readonly any[], events: readonly any[]) {
  const { nameAcceptances, nameIds } = trace.aiPublic?.application ?? {};
  if (!Array.isArray(nameAcceptances) || !Array.isArray(nameIds)) return invalid();
  const retained = new Map(graphRecords.filter(record => record.turn === trace.turnIndex).map(record => [record.id, record]));
  const execution = previousJudgment?.jevTurn?.executed;
  const aiSeq = previousJudgment?.aiPublic?.aiSeq;
  const source = events[aiSeq - 1];
  const prefix = `${trace.turnIndex}:ai`;
  const seen = new Set<string>();
  const claims = nameAcceptances.map(value => {
    const { id, respondsTo } = data(value, ['id', 'respondsTo']);
    if (typeof id !== 'string' || !id.startsWith(prefix) || !/^[1-9]\d*$/u.test(id.slice(prefix.length)) ||
        !nameIds.includes(id) || seen.has(id) || typeof respondsTo !== 'string') return invalid();
    const proposal = earlierClaims.find(c => c?.id === respondsTo);
    const retainedClaim = retained.get(id);
    const human = events[proposal?.sourceTurn - 1];
    if (execution?.action !== 'agree' || execution.target?.kind !== 'single' || aiSeq !== previousJudgment.turnIndex + 1 ||
        source?.seq !== aiSeq || source?.speaker !== 'ai' ||
        aiSeq >= trace.turnIndex || source.nonReferential || previousJudgment.generationGuard?.fallback ||
        proposal?.kind !== 'claim' || proposal.speaker !== 'human' || proposal.act !== 'name_propose' || proposal.aspect !== 'name' ||
        proposal.sourceTurn >= aiSeq || proposal.targets?.length !== 1 || proposal.targets[0] !== execution.target.figureId ||
        typeof proposal.name !== 'string' || literalSpan(source.text, execution.name)?.text !== proposal.name ||
        human?.speaker !== 'human' || typeof human.text !== 'string' || !human.text.includes(proposal.name) ||
        retainedClaim && (retainedClaim.kind !== 'claim' || retainedClaim.act !== 'name_accept' || retainedClaim.speaker !== 'ai' ||
          retainedClaim.sourceTurn !== aiSeq || retainedClaim.respondsTo !== respondsTo)) return invalid();
    seen.add(id);
    return { kind: 'claim', id, turn: trace.turnIndex, act: 'name_accept', respondsTo };
  });
  if ([...retained.values()].some(c => c.kind === 'claim' && c.speaker === 'ai' && c.act === 'name_accept' && !seen.has(c.id))) return invalid();
  return claims;
}

/** R2: classify restore before any queue, initial observer, or model work. */
export function selectParticipantJev(restore: any, provided: unknown, context: {
  referenceMemory: boolean; strategy: string; style: string; legacy: unknown[];
}): SelectedJevResearchOptions | null {
  try {
    const marker = restore?.options?.jevResearch;
    if (restore) {
      if (marker !== undefined && marker !== true && marker !== false) return invalid();
      if (marker !== true) {
        const state = restore.queueState?.privateState;
        if (['profileSha256','interventionPolicy','technicalTrial','questionLayout','dialoguePolicy','generationRetryVersion','jevNamingRestoreVersion'].some(k => Object.hasOwn(restore.options ?? {},k)) ||
            ['jevTraces','aiPublicSettlement','initialObservation','jevLedger'].some(k => Object.hasOwn(restore,k)) ||
            state && (['schemaVersion','interventionPolicy','observationMemo','repairHistory','aiPublic'].some(k=>Object.hasOwn(state,k)) ||
              state.judgments?.some((j: any) => j.jevTurn))) return invalid();
        return null;
      }
    }
    if (provided === null || provided === undefined) return marker === true ? invalid() : null;
    const raw = data(provided);
    const v = data(raw,['profile','observer','jevDecision','localGrounding','ledger',...(Object.hasOwn(raw,'technicalTrial')?['technicalTrial']:[]),
      ...(Object.hasOwn(raw,'generationRetryVersion')?['generationRetryVersion']:[]),
      ...(Object.hasOwn(raw,'newTrialAgreeNameScopeVersion')?['newTrialAgreeNameScopeVersion']:[]),
      ...(Object.hasOwn(raw,'pinnedVersions')?['pinnedVersions']:[])]);
    const technicalTrial = Object.hasOwn(v,'technicalTrial') ? checkedTechnicalTrial(v.technicalTrial) : undefined;
    // The frozen order is outer shape, explicit profile, memory, strategy.
    let profile = checkedProfile(v.profile);
    // A restored record keeps the policy it was created with, or none: a record without dialoguePolicy never gains one on restore.
    if (restore) {
      const savedPolicy = Object.hasOwn(restore.options ?? {}, 'dialoguePolicy') ? restore.options.dialoguePolicy : undefined;
      if (savedPolicy !== undefined && !isHolisticPolicy(savedPolicy)) return invalid();
      // The stored value (or its absence) decides the version, whatever the creation default is now.
      if (savedPolicy !== profile.dialoguePolicy) profile = researchTrialProfileV3(profile.lunaRequest, profile.timeouts, profile.questionLayout, savedPolicy ?? null);
    }
    const savedGenerationVersion = restore?.options?.generationRetryVersion;
    if (restore && Object.hasOwn(restore.options ?? {}, 'generationRetryVersion') &&
        (!hasVersionedViewpoint(savedGenerationVersion) || !validGenerationRetryVersion(savedGenerationVersion, profile.questionLayout, profile.dialoguePolicy))) return invalid();
    const requestedGenerationVersion = v.generationRetryVersion;
    if (!restore && Object.hasOwn(v, 'generationRetryVersion') &&
        (!hasVersionedViewpoint(requestedGenerationVersion) ||
          !validGenerationRetryVersion(requestedGenerationVersion, profile.questionLayout, profile.dialoguePolicy))) return invalid();
    const pinned = Object.hasOwn(v, 'pinnedVersions') ? data(v.pinnedVersions, ['generationRetryVersion','namingRestoreVersion']) : null;
    if (pinned && (Object.hasOwn(v, 'generationRetryVersion') ||
        pinned.generationRetryVersion !== 'jev_generation_retry_v12' && pinned.generationRetryVersion !== 'jev_generation_retry_v13' ||
        pinned.namingRestoreVersion !== AI_NAME_ACCEPTANCES_V1 ||
        !validGenerationRetryVersion(pinned.generationRetryVersion, profile.questionLayout, profile.dialoguePolicy) ||
        restore && (savedGenerationVersion !== pinned.generationRetryVersion ||
          restore.options.jevNamingRestoreVersion !== pinned.namingRestoreVersion))) return invalid();
    const generationRetryVersion = profile.dialoguePolicy === 'holistic_v5' && profile.questionLayout === 'two_stage_v3'
      ? restore ? savedGenerationVersion ?? 'jev_generation_retry_v2'
        : (pinned?.generationRetryVersion ?? requestedGenerationVersion) as GenerationRetryVersion | undefined ?? defaultGenerationRetryVersion(profile.questionLayout, profile.dialoguePolicy)
      : undefined;
    const newTrialAgreeNameScopeVersion = v.newTrialAgreeNameScopeVersion;
    if (Object.hasOwn(v, 'newTrialAgreeNameScopeVersion') &&
        (newTrialAgreeNameScopeVersion !== 'scoped_v7' || !restore &&
          !validAgreeNameScope(newTrialAgreeNameScopeVersion, generationRetryVersion))) return invalid();
    const p5Enabled = isGenerationV13(generationRetryVersion);
    const namingRestoreVersion = restore ? restore.options?.jevNamingRestoreVersion :
      pinned || isGenerationV12(generationRetryVersion) ? AI_NAME_ACCEPTANCES_V1 : undefined;
    if (restore && Object.hasOwn(restore.options ?? {}, 'jevNamingRestoreVersion') &&
        (namingRestoreVersion !== AI_NAME_ACCEPTANCES_V1 || !isGenerationV12(generationRetryVersion))) return invalid();
    if (restore && !validAgreeNameScope(restore.queueState?.privateState?.agreeNameScopeVersion, generationRetryVersion)) return invalid();
    if (context.referenceMemory !== true) return invalid();
    if (!STRATEGIES.includes(context.strategy)) return invalid();
    if (context.legacy.some(v => v !== null && v !== undefined) || context.style !== profile.utteranceStyle) return invalid();
    const observer = v.observer as ObservationObserver, jevDecision = v.jevDecision as JevDecisionClient;
    let local = v.localGrounding as JevTurnLocalOptions;
    if (typeof observer?.observeAll !== 'function' || typeof observer.reobserve !== 'function' || typeof jevDecision?.decide !== 'function' ||
        typeof local?.classifier?.classify !== 'function' || local.timeoutMs !== profile.timeouts.localMs ||
        local.aiPublicClaims !== profile.localGrounding.aiPublicClaims || !(v.ledger instanceof RunBudget || v.ledger instanceof ParticipantUsageLedger)) return invalid();
    if (restore) {
      const savedProfile = restore.options.participantRuntimeProfile;
      if (v.ledger instanceof ParticipantUsageLedger ? savedProfile !== PARTICIPANT_PRODUCTION_PROFILE :
        Object.hasOwn(restore.options,'participantRuntimeProfile') || restore.jevLedger?.schemaVersion === PARTICIPANT_PRODUCTION_PROFILE) return invalid();
      const savedTrial = Object.hasOwn(restore.options,'technicalTrial') ? checkedTechnicalTrial(restore.options.technicalTrial) : undefined;
      if (JSON.stringify(savedTrial) !== JSON.stringify(technicalTrial)) return invalid();
      // A v2 record names its layout; a v1 record never does. profileSha256 below also differs between layouts.
      const savedLayout = Object.hasOwn(restore.options,'questionLayout') ? restore.options.questionLayout : 'two_stage_v1';
      if (savedLayout !== profile.questionLayout || Object.hasOwn(restore.options,'questionLayout') && savedLayout !== 'two_stage_v2' && savedLayout !== 'two_stage_v3') return invalid();
      if (restore.jevTraces?.some?.((trace:any)=>!checkedDecisionFailure(trace,profile.questionLayout,p5Enabled,v.ledger instanceof ParticipantUsageLedger ? PARTICIPANT_USAGE_ONLY : undefined))) return invalid();
      if (restore.options.profileSha256 !== researchHash(profile) ||
          researchHash(jsonData(restore.options.interventionPolicy)) !== researchHash(profile.interventionPolicy) ||
          restore.queueState?.privateState?.schemaVersion !== 'jev_private_state_v2' ||
          !restore.queueState?.privateState?.observationMemo || !Array.isArray(restore.jevTraces) ||
          !digest(restore.initialObservation?.memoSha256) || !Object.hasOwn(restore,'aiPublicSettlement') || !restore.jevLedger ||
          restore.jevTraces.some((trace:any)=>trace?.schemaVersion!=='jev_turn_trace_v2'||
            trace.intervention!==null&&!['bypass_acceptance_v1:accept','bypass_acceptance_v1:veto'].includes(trace.intervention?.policy)||
            !technicalTrial&&trace.intervention?.rerank?.policyId==='saved_action_scores_open_issue_v1')) return invalid();
      // The typed-naming-request marker is recomputed from the turn's verified claims and the stored version, and the copies of a committed turn (trace and saved state)
      // must be equal in every field they share.
      const savedJudgments: any[] = Array.isArray(restore.queueState?.privateState?.judgments) ? restore.queueState.privateState.judgments : [];
      const ownSlots = restore.queueState.privateState.graph.slots;
      const earlierClaims: any[] = [];
      let previousJudgment: any;
      for (const trace of restore.jevTraces) {
        if (hasVersionedViewpoint(trace.generationRetryVersion) && trace.generationRetryVersion !== generationRetryVersion ||
            hasVersionedViewpoint(generationRetryVersion) && trace.finalAction && trace.generationRetryVersion !== generationRetryVersion ||
            Object.hasOwn(trace,'generationRetryVersion') && trace.generationRetryVersion !== 'jev_generation_retry_v2' &&
              !hasVersionedViewpoint(trace.generationRetryVersion)) return invalid();
        if (!validJevSharedConstrualTrace(trace, ownSlots, generationRetryVersion)) return invalid();
        const committed = trace.status === 'committed';
        const sameTurnAi = namingRestoreVersion && committed ? checkedAiNameAcceptances(trace, previousJudgment, earlierClaims,
          restore.queueState.privateState.graph.records, restore.queueState.events) : [];
        if (!namingRestoreVersion && Object.hasOwn(trace.aiPublic?.application ?? {}, 'nameAcceptances')) return invalid();
        if (traceMarkerInvalid(trace, savedJudgments, restore.queueState?.privateState?.ledger, { markerAllowed: isHolisticV3Plus(profile.dialoguePolicy) && profile.questionLayout === 'two_stage_v3',
          unmarkedChecked: isHolisticV3Plus(profile.dialoguePolicy) }, sameTurnAi.length ? [...earlierClaims, ...sameTurnAi] : earlierClaims)) return invalid();
        if (committed) {
          const judgment = savedJudgments.find((j: any) => j?.turnIndex === trace.turnIndex && j?.jevTurn?.attemptNumber === trace.attemptNumber);
          if (!judgment) return invalid();
          for (const key of ['executed','humanReferent','repairProspect','repairGate','repairFacts','draftActs','draftSharedClaims','namingRequest','namingReconfirm','sharedConstruals'])
            if (Object.hasOwn(trace, key) !== Object.hasOwn(judgment.jevTurn, key) || Object.hasOwn(trace, key) && researchHash(jsonData(trace[key])) !== researchHash(jsonData(judgment.jevTurn[key]))) return invalid();
          if (p5Enabled && (researchHash(jsonData(trace.decisions.at(-1))) !== researchHash(jsonData(judgment.jevTurn.decision)) ||
              researchHash(jsonData(trace.intervention)) !== researchHash(jsonData(judgment.jevTurn.intervention)))) return invalid();
          if (Array.isArray(trace.local?.claims)) earlierClaims.push(...trace.local.claims);
          earlierClaims.push(...sameTurnAi);
          previousJudgment = judgment;
        }
      }
      // v2/v3 prospects are asked over open entries; v1 retains the full history.
      const v2 = technicalTrial?.version === 'adaptive_repair_v2' || technicalTrial?.version === 'adaptive_repair_v3';
      if (restore.jevTraces.some((trace:any)=>Object.hasOwn(trace,'repairGate') ? !v2 : v2 && Object.hasOwn(trace,'repairProspect'))) return invalid();
      const v3 = technicalTrial?.version === 'adaptive_repair_v3';
      if (restore.jevTraces.some((trace:any)=>Object.hasOwn(trace,'repairFacts') !== v3)) return invalid();
      for (const trace of restore.jevTraces) if (Object.hasOwn(trace,'repairProspect')) {
        if (!technicalTrial) return invalid();
        validateRepairProspectMaterial(trace.repairProspect,Object.hasOwn(trace,'repairGate')?inferenceHistory(trace.repairHistory,trace.repairGate):trace.repairHistory,trace.turnIndex);
      }
    }
    // A classifier built for another version than the selected one is replaced by one for the selected version (a restored record keeps its stored criteria).
    const rebuilt = typeof (local.classifier as any)?.forPolicy === 'function' ? (local.classifier as any).forPolicy(profile.dialoguePolicy) : undefined;
    if (rebuilt) local = {...local,classifier:rebuilt};
    return {profile,observer,jevDecision,localGrounding:local,ledger:v.ledger,...(technicalTrial?{technicalTrial}:{}),...(generationRetryVersion?{generationRetryVersion}:{}),
      ...(pinned ? {participantPrompts:true as const} : {}),
      ...(!restore && newTrialAgreeNameScopeVersion === 'scoped_v7' ? {newTrialAgreeNameScopeVersion} : {}),
      ...(namingRestoreVersion?{namingRestoreVersion}:{})};
  } catch { return invalid(); }
}

const initialAudits = new WeakMap<ObservationObserver,{audit:ObservationCacheAudit;memoSha256:string}>();
export const participantInitialObservation = (observer: ObservationObserver) => structuredClone(initialAudits.get(observer) ?? null);
const researchLimits = Object.freeze({maxDeadlineMs:RESEARCH_MAX_DEADLINE_MS});

/** Only cache HIT can initialize a participant; reobserve is a separate capability. */
export async function createParticipantCacheObserver(options: {directory:string;modelId:string;memoSha256:string;
  own:ObservationInput;profile:ResearchTrialProfileV3;reobserver:ObservationObserver}): Promise<ObservationObserver> {
  const ownHash = researchHash(options.own);
  const cache = await createObservationCache({directory:options.directory,modelId:options.modelId,onMiss:'error',
    timeoutMs:options.profile.timeouts.observationMs,researchLimits});
  const check = (input: ObservationInput) => {
    if (researchHash(input) !== ownHash) throw new ParticipantJevError('wrong_own_material');
  };
  const observer: ObservationObserver = {
    async observeAll(input,callOptions) {
      check(input);
      try {
        const hit = await cache.get(input,callOptions), memoSha256 = researchHash(hit.memo);
        if (hit.audit.status !== 'HIT' || memoSha256 !== options.memoSha256) throw Error();
        initialAudits.set(observer,{audit:hit.audit,memoSha256});
        return hit.memo;
      } catch { throw new ParticipantJevError('initialization_failed'); }
    },
    async reobserve(input,callOptions) {
      check({ownImage:input.ownImage,ownAnchors:input.ownAnchors});
      return options.reobserver.reobserve(input,{...callOptions,timeoutMs:options.profile.timeouts.observationMs});
    },
  };
  return observer;
}

type Scope = {turn:number|null;phase:string|null;boundary:'common'|'tail'};
const contexts = new WeakMap<RunBudget,AsyncLocalStorage<Scope>>();
function scope(ledger:RunBudget) { let value=contexts.get(ledger);if(!value){value=new AsyncLocalStorage();contexts.set(ledger,value);}return value; }
export function withParticipantJevTurn<T>(ledger:RunBudget,turn:number,operation:()=>Promise<T>):Promise<T> {
  return scope(ledger).run({turn,phase:null,boundary:'common'},operation);
}
type ChatClient = {complete(messages:any[],options?:any):Promise<any>};
export function participantLunaClient(client:ChatClient,ledger:JevResearchLedger,profile:ResearchTrialProfileV3):ChatClient {
  const timed=researchGenerationClient(client,profile.timeouts.generationMs);
  return {async complete(messages,options={}) {
    if (options.signal?.aborted) throw Object.assign(Error('aborted'),{name:'AbortError'});
    if (ledger instanceof ParticipantUsageLedger) {
      const phase = ['generation','final_submission','ai_extraction'].includes(options.phase) ? options.phase : 'dialogue';
      return ledger.logical(ledger.chatProvider(phase), phase, () => timed.complete(messages,options));
    }
    ledger.beforeSend();ledger.lunaCalls++;
    const parent=scope(ledger).getStore(),phase=options.phase ?? null;
    return scope(ledger).run({turn:parent?.turn??null,phase,boundary:['generation','final_submission','ai_extraction'].includes(phase)?'tail':parent?.boundary??'common'},
      ()=>timed.complete(messages,options));
  }};
}
async function jevOperation<T>(ledger:RunBudget,kind:string,operation:()=>Promise<T>):Promise<T> {
  ledger.beforeSend();
  try{return await operation();}catch(error){
    if(error instanceof JevDecisionError||error instanceof JevLocalTestError){
      ledger.refuse(kind,error.code);
      if(['cost_cap','cost_unreported','model_mismatch'].includes(error.code))ledger.stop(error.code);
    }
    throw error;
  }
}
type WireReceipt = SendReceipt & {requestSha256:string;requestedId:string;returnedId:string|null;version:string|null;boundary:'common'|'tail'};
const safeModel = (v:unknown):string|null => typeof v==='string' && v.length<=128 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(v)?v:null;
/** Reservations happen at the real POST boundary, including native client retries. */
export function participantLedgerFetch(ledger:RunBudget,provider:'luna'|'jev',expectedLunaModel:string,fetchImpl:typeof fetch):typeof fetch {
  return async (url,init={}) => {
    if ((init.method??'GET').toUpperCase()!=='POST') throw new ParticipantJevError('invalid_config');
    if (init.signal?.aborted) throw Object.assign(Error('aborted'),{name:'AbortError'});
    const context=scope(ledger).getStore();
    const body=JSON.parse(String(init.body));
    const entry=ledger.reserve(provider,context?.phase??(body.questions?.action?'decision':body.questions?.human_referent?'human_referent':body.questions?.draft_shared_claim?'draft_shared_claim':'jev'),context?.turn??null) as WireReceipt;
    Object.assign(entry,{requestSha256:researchHash(body),requestedId:provider==='jev'?MODEL_CONTRACT_V2.requested:expectedLunaModel,
      returnedId:null,version:null,boundary:context?.boundary??'common'});
    ledger.sent(entry);
    try {
      const response=await fetchImpl(url,init);
      let payload:any=null;
      if(response.ok)try{payload=await response.clone().json();}catch{/* Account as unknown; never copy raw errors. */}
      const returnedId=safeModel(payload?.model);
      const identity=provider==='jev'?checkModelIdentity(MODEL_CONTRACT_V2.requested,payload?.model):null;
      const matches=provider==='jev'?identity?.status==='accepted':returnedId===expectedLunaModel;
      Object.assign(entry,{returnedId,version:identity?.version??null});
      const tokens=(value:unknown)=>nonnegative(value)?value:null;
      ledger.observe(entry,{model:returnedId,modelMatches:matches,
        costUsd:typeof payload?.usage?.cost==='number'&&Number.isFinite(payload.usage.cost)&&payload.usage.cost>=0?payload.usage.cost:null,
        inputTokens:tokens(payload?.usage?.prompt_tokens),outputTokens:tokens(payload?.usage?.completion_tokens)});
      if(response.ok&&!matches){ledger.stop('model_mismatch');throw new ParticipantJevError('model_mismatch');}
      return response;
    } catch(error) {ledger.unknown(entry);throw error;}
  };
}

/** R2: carry all reservations and observed thresholds across a process restart. */
export function restoreParticipantJevLedger(ledger:RunBudget,saved:any):void {
  try {
    if(researchHash(jsonData(saved.limits))!==researchHash(ledger.limits)||!nonnegative(saved.lunaCalls)||
      !Array.isArray(saved.sends)||!Array.isArray(saved.refusals)||!Array.isArray(saved.stops)||
      typeof saved.halted!=='boolean'||typeof saved.jevUnknown!=='boolean'||
      saved.haltReason!==null&&(typeof saved.haltReason!=='string'||!/^[a-z_]+$/u.test(saved.haltReason))) return invalid();
    const sends:SendReceipt[]=saved.sends.map((entry:any,i:number)=>{
      const s=jsonData(entry) as SendReceipt;
      if(s.id!==i+1||!['luna','jev'].includes(s.provider)||!['in_flight','sent_result_unknown','observed_response'].includes(s.status)||
        [s.costUsd,s.inputTokens,s.outputTokens].some(v=>v!==null&&(typeof v!=='number'||!Number.isFinite(v)||v<0)))return invalid();
      return s;
    });
    ledger.lunaCalls=saved.lunaCalls;ledger.halted=saved.halted;ledger.haltReason=saved.haltReason;ledger.jevUnknown=saved.jevUnknown;
    ledger.sends.splice(0,ledger.sends.length,...sends);
    ledger.refusals.splice(0,ledger.refusals.length,...structuredClone(saved.refusals));
    ledger.stops.splice(0,ledger.stops.length,...structuredClone(saved.stops));
    for(const send of ledger.sends)if(send.status==='in_flight')ledger.unknown(send);
    ledger.checkObservedLimits();
  }catch{return invalid();}
}

export type ParticipantJevConfig = {schemaVersion:'participant_jev_config_v1';lunaRequest:ResearchTrialProfileV3['lunaRequest'];
  timeouts:ResearchTrialProfileV3['timeouts'];cacheDirectory:string;modelId:string;memoSha256:string;seed:number;limits:BudgetLimits;technicalTrial?:AdaptiveRepairTrial;
  /** Optional; omitted means two_stage_v1. two_stage_v2 must be chosen explicitly per trial. */
  questionLayout?:JevQuestionLayout};
export function validateParticipantJevConfig(value:unknown):{config:ParticipantJevConfig;profile:ResearchTrialProfileV3} {
  try {
    const raw=data(value);
    const c=jsonData(data(raw,['schemaVersion','lunaRequest','timeouts','cacheDirectory','modelId','memoSha256','seed','limits',...(Object.hasOwn(raw,'technicalTrial')?['technicalTrial']:[]),
      ...(Object.hasOwn(raw,'questionLayout')?['questionLayout']:[])])) as ParticipantJevConfig;
    if(Object.hasOwn(c,'technicalTrial'))c.technicalTrial=checkedTechnicalTrial(c.technicalTrial);
    if(Object.hasOwn(c,'questionLayout')&&c.questionLayout!=='two_stage_v1'&&c.questionLayout!=='two_stage_v2'&&c.questionLayout!=='two_stage_v3')throw Error();
    if(c.schemaVersion!=='participant_jev_config_v1'||typeof c.cacheDirectory!=='string'||!safeModel(c.modelId)||!digest(c.memoSha256)||!Number.isSafeInteger(c.seed))throw Error();
    const limits=data(c.limits,['lunaCalls','lunaTokens','lunaPosts','jevPosts','jevUsd']);
    // The explicit per-trial research Jev budget may exceed the 0.05 default, never RESEARCH_MAX_JEV_USD; the same
    // value reaches RunBudget and every Jev adapter (they receive researchLimits, see maxJevCostCapUsd).
    if(!['lunaCalls','lunaTokens','lunaPosts','jevPosts'].every(k=>positive(limits[k]))||typeof limits.jevUsd!=='number'||!Number.isFinite(limits.jevUsd)||limits.jevUsd<=0||limits.jevUsd>RESEARCH_MAX_JEV_USD)throw Error();
    data(c.lunaRequest,['timeoutMs','maxCompletionTokens']);
    // holistic_v3 (the creation default) is recorded for a technical-trial v3 only; a plain v3 keeps its original decision, generation, guards and requests.
    return {config:c,profile:researchTrialProfileV3(c.lunaRequest,c.timeouts,c.questionLayout??'two_stage_v1',c.technicalTrial?undefined:null)};
  }catch{throw new ParticipantJevError('invalid_config');}
}

/** Called before listen(). Returns a per-task factory, so trials never share a budget. */
export async function prepareParticipantJev(options:{configFile:string;baseAssignmentFile:string;clientConfig:any;
  utteranceStyle?:string;activeDecision?:unknown;groundingShadow?:unknown;fetchImpl?:typeof fetch;
  readKey?:()=>Promise<string>;createClient?:typeof createChatClient}) {
  try {
    await privateDirectory(dirname(options.configFile));
    const handle=await open(options.configFile,constants.O_RDONLY|constants.O_NOFOLLOW);
    let raw:unknown;
    try{const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o777)!==0o600||stat.size>32768)throw Error();raw=JSON.parse(await handle.readFile('utf8'));}finally{await handle.close();}
    const {config,profile}=validateParticipantJevConfig(raw);
    if((options.utteranceStyle??'default')!==profile.utteranceStyle||options.activeDecision||options.groundingShadow)throw Error();
    const assignment=await readPrivateAssignment(options.baseAssignmentFile);
    if(!assignment.referenceMemory||assignment.seed!==config.seed||!STRATEGIES.includes(assignment.strategy))throw Error();
    // The P1 cache holds the relative_pm90 board; other rotation modes are refused per task below.
    const model=modelView(createTrialV2({seed:config.seed,rotationMode:'relative_pm90'}));
    const own:ObservationInput={ownImage:{mimeType:model.mimeType,base64:model.png.toString('base64')},ownAnchors:model.anchors};
    const absent:ObservationObserver={async observeAll(){throw Error();},async reobserve(){throw Error();}};
    const startup=await createParticipantCacheObserver({directory:config.cacheDirectory,modelId:config.modelId,memoSha256:config.memoSha256,own,profile,reobserver:absent});
    await startup.observeAll(own);
    const fetchImpl=options.fetchImpl??globalThis.fetch;
    if(options.clientConfig?.provider!=='cloudflare'||options.clientConfig?.purpose!=='dialogue_turn')throw Error();
    // A single free GET; config cannot select a URL or a model for completions.
    const response=await fetchImpl(new URL(options.clientConfig.baseUrl.replace(/\/+$/u,'')+'/model-policy'),{
      method:'GET',redirect:'error',headers:{Authorization:'Bearer '+options.clientConfig.apiKey},signal:AbortSignal.timeout(profile.timeouts.lunaAttemptMs)});
    if(!response.ok)throw Error();
    const policy=data(await response.json());
    if(policy.ready!==true||policy.purpose!=='dialogue_turn'||typeof policy.provider!=='string'||!['openai','gemini'].includes(policy.provider)||policy.model!==config.modelId)throw Error();
    return {config,profile,async taskOptions(value:{seed:number;referenceMemory:boolean;strategy:string;rotationMode?:string;figureSelection?:unknown;restore?:any}) {
      // An old assigned record stays on the original caller's client and options.
      if(value.restore&&value.restore.options?.jevResearch!==true)return {};
      const saved=value.restore?.options;
      // The P1 fixed cache was observed on the legacy figure set: any other selection fails closed.
      for(const candidate of [value.figureSelection,saved&&typeof saved==='object'&&Object.hasOwn(saved,'figureSelection')?saved.figureSelection:undefined]){
        if(candidate===undefined)continue;
        try{
          const selection=candidate&&typeof candidate==='object'&&Object.hasOwn(candidate,'bankVersion')?validateResolvedFigureSelection(candidate):resolveFigureSelection(candidate);
          if(!isLegacyFigureSelection(selection))throw Error();
        }catch{throw new ParticipantJevError('invalid_config');}
      }
      const rotationMode=value.restore?(saved&&typeof saved==='object'&&Object.hasOwn(saved,'rotationMode')?saved.rotationMode:'relative_pm90'):value.rotationMode??'relative_pm90';
      if(rotationMode!=='relative_pm90')throw new ParticipantJevError('invalid_config');
      if(value.seed!==config.seed||value.referenceMemory!==true||!STRATEGIES.includes(value.strategy))throw new ParticipantJevError('invalid_config');
      const ledger=new RunBudget(config.limits);
      const {maxCompletionTokens:_oldOutputLimit,...baseClientConfig}=options.clientConfig;
      const native=(options.createClient??createChatClient)({...baseClientConfig,timeoutMs:profile.timeouts.lunaAttemptMs,
        ...(profile.lunaRequest.maxCompletionTokens===null?{}:{maxCompletionTokens:profile.lunaRequest.maxCompletionTokens})},
        participantLedgerFetch(ledger,'luna',config.modelId,fetchImpl));
      const jevFetch=participantLedgerFetch(ledger,'jev',config.modelId,fetchImpl);
      const transport={...(options.readKey?{readKey:options.readKey}:{}),fetchImpl:jevFetch,costCapUsd:config.limits.jevUsd,
        timeoutMs:profile.timeouts.decisionMs,researchLimits};
      const aiPublicTransport={...transport,fetchImpl:(url:string,init:RequestInit)=>{
        const parent=scope(ledger).getStore(),questions=JSON.parse(String(init.body)).questions;
        const phase=Object.keys(questions).some(key=>key.endsWith('_support'))?'ai_support':'ai_function';
        return scope(ledger).run({turn:parent?.turn??null,phase,boundary:'tail'},()=>jevFetch(url,init));
      }};
      const nativeDecision=createJevDecisionClient({enabled:true,...transport,questionLayout:profile.questionLayout})!;
      const {estimateRepairProspect:_prospect,...nativeWithoutProspect}=nativeDecision;
      const jevDecision={...nativeWithoutProspect,
        get lastEvidence(){return nativeDecision.lastEvidence;},get lastReferentEvidence(){return nativeDecision.lastReferentEvidence;},
        get spentUsd(){return nativeDecision.spentUsd;},get callCount(){return nativeDecision.callCount;},
        get referentCallCount(){return nativeDecision.referentCallCount;},
        decide:(...args:Parameters<typeof nativeDecision.decide>)=>jevOperation(ledger,'jev_decision',()=>nativeDecision.decide(...args)),
        estimateReferent:(...args:Parameters<typeof nativeDecision.estimateReferent>)=>jevOperation(ledger,'jev_referent',()=>nativeDecision.estimateReferent(...args)),
        ...(config.technicalTrial ? {estimateRepairProspect:(...args:Parameters<typeof nativeDecision.estimateRepairProspect>)=>{
          const parent=scope(ledger).getStore();
          return scope(ledger).run({turn:parent?.turn??null,phase:'jev_prospect',boundary:'common'},
            ()=>jevOperation(ledger,'jev_prospect',()=>nativeDecision.estimateRepairProspect(...args)));
        }} : {}),
        ...(isHolisticPolicy(profile.dialoguePolicy)&&nativeDecision.classifyDraftAct ? {classifyDraftAct:async(...args:Parameters<NonNullable<typeof nativeDecision.classifyDraftAct>>)=>{
          ledger.beforeSend();
          const parent=scope(ledger).getStore();
          const res=await scope(ledger).run({turn:parent?.turn??null,phase:'jev_draft_act',boundary:'tail'},()=>nativeDecision.classifyDraftAct!(...args));
          // The native client reports a failed question as status "error"; the shared budget still has to learn of a cap or identity stop.
          if(res.status==='error'&&res.error){ledger.refuse('jev_draft_act',res.error);if(['cost_cap','cost_unreported','model_mismatch'].includes(res.error))ledger.stop(res.error);}
          return res;
        }} : {}),
        ...(isHolisticPolicy(profile.dialoguePolicy)&&nativeDecision.classifyDraftSharedClaim ? {classifyDraftSharedClaim:async(...args:Parameters<NonNullable<typeof nativeDecision.classifyDraftSharedClaim>>)=>{
          ledger.beforeSend();
          const parent=scope(ledger).getStore();
          const res=await scope(ledger).run({turn:parent?.turn??null,phase:'jev_draft_shared_claim',boundary:'tail'},()=>nativeDecision.classifyDraftSharedClaim!(...args));
          if(res.status==='error'&&res.error){ledger.refuse('jev_draft_shared_claim',res.error);if(['cost_cap','cost_unreported','model_mismatch'].includes(res.error))ledger.stop(res.error);}
          return res;
        }} : {}),
        completeDetail:(...args:Parameters<typeof nativeDecision.completeDetail>)=>{
        const parent=scope(ledger).getStore();
        return scope(ledger).run({turn:parent?.turn??null,phase:'alternative_detail',boundary:'tail'},()=>jevOperation(ledger,'jev_detail',()=>nativeDecision.completeDetail(...args)));
      }};
      // Logical phase timers remain outside; the native transport gets the common attempt limit.
      const client:ChatClient={complete:(messages,callOptions={})=>native.complete(messages,{...callOptions,timeoutMs:profile.timeouts.lunaAttemptMs})};
      const observer=await createParticipantCacheObserver({directory:config.cacheDirectory,modelId:config.modelId,memoSha256:config.memoSha256,own,profile,
        reobserver:createLunaObserver(participantLunaClient(client,ledger,profile),{timeoutMs:profile.timeouts.observationMs,researchLimits})});
      // The classification criteria follow the version of the trial that really runs: a restored record keeps its stored version, so the classifier is rebuilt for the
      // selected profile (forPolicy, called by selectParticipantJev once the stored version is known) instead of being reused from the creation default.
      const makeClassifier=(policy:string|undefined):any=>{
        const classifier=createJevLocalTestClassifier({enabled:true,...transport,questionLayout:profile.questionLayout,...(isHolisticV3Plus(policy)?{dialoguePolicy:policy as string}:{})})!;
        return {...classifier,get lastEvidence(){return classifier.lastEvidence;},get spentUsd(){return classifier.spentUsd;},
          get callCount(){return classifier.callCount;},classify:(...args:Parameters<typeof classifier.classify>)=>jevOperation(ledger,'jev_local',()=>classifier.classify(...args)),
          forPolicy:(next:string|undefined)=>next===policy?undefined:makeClassifier(next)};
      };
      const jevResearch:JevResearchOptions={profile,observer,jevDecision,
        localGrounding:{classifier:makeClassifier(profile.dialoguePolicy),timeoutMs:profile.timeouts.localMs,
          researchLimits,aiPublicClaims:profile.localGrounding.aiPublicClaims,aiPublicTransport},ledger,...(config.technicalTrial?{technicalTrial:config.technicalTrial}:{})};
      return {client,jevResearch};
    }};
  }catch{throw new ParticipantJevError('invalid_config');}
}
