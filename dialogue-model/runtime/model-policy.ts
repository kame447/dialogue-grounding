import { MODEL_CONTRACT_V2, MODEL_CONTRACT_V2_TABLE_SHA256 } from './model-identity-contract.ts';
import { validateResearchTimeouts } from './v2/research-timeouts.ts';

export type ModelContractReference = Readonly<{version: 'model-contract-v2'; tableSha256: string}>;
export type ResolvedModelPolicy = Readonly<{
  profileId: 'research_trial_profile_v1' | 'research_trial_profile_v2' | 'research_trial_profile_v3';
  mode: 'legacy' | 'explicit'; modelContract: ModelContractReference | null;
}>;
export type ModelIntegrationErrorCode = 'model_profile_invalid' | 'model_contract_missing' |
  'model_contract_invalid' | 'model_contract_unknown' | 'model_table_mismatch';
export class ModelIntegrationError extends Error {
  readonly code: ModelIntegrationErrorCode;
  constructor(code: ModelIntegrationErrorCode) { super(code); this.name = 'ModelIntegrationError'; this.code = code; }
}
const rootKeys = ['id', 'referenceMemory', 'decisionMode', 'humanReferent', 'localGrounding', 'initialObservation',
  'questionLayout', 'utteranceStyle', 'maxReobservations', 'modelPolicy', 'timeouts', 'lunaRequest', 'outputLimit', 'modelContract'];
function descriptors(value: unknown): PropertyDescriptorMap {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw Error();
  return Object.getOwnPropertyDescriptors(value);
}
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const d = descriptors(value), own = Reflect.ownKeys(d);
  if (own.length !== keys.length || own.some(k => typeof k !== 'string' || !keys.includes(k)) || keys.some(k => !d[k] || !Object.hasOwn(d[k], 'value'))) throw Error();
  return Object.fromEntries(keys.map(k => [k, d[k].value]));
}
function fixed(value: unknown, expected: Record<string, unknown>): void {
  const v = fields(value, Object.keys(expected));
  if (Object.keys(expected).some(k => v[k] !== expected[k])) throw Error();
}
/** Recognize legacy descriptors without strengthening the historical profile contract. */
export function resolveModelPolicy(profile: unknown): ResolvedModelPolicy {
  let d: PropertyDescriptorMap;
  try {
    d = descriptors(profile);
    if (!d.id || !Object.hasOwn(d.id, 'value')) throw Error();
    if (d.id.value === 'research_trial_profile_v1') {
      if (Object.hasOwn(d, 'modelContract')) throw Error();
      return Object.freeze({profileId: 'research_trial_profile_v1', mode: 'legacy', modelContract: null});
    }
    if (d.id.value !== 'research_trial_profile_v2' && d.id.value !== 'research_trial_profile_v3') throw Error();
    const integrated = d.id.value === 'research_trial_profile_v3';
    const keys = Reflect.ownKeys(d);
    if (keys.some(k => typeof k !== 'string' || !rootKeys.includes(k) && !(integrated && k === 'interventionPolicy')) ||
        rootKeys.filter(k => k !== 'modelContract').some(k => !d[k] || !Object.hasOwn(d[k], 'value'))) throw Error();
    const v = Object.fromEntries(rootKeys.filter(k => k !== 'modelContract').map(k => [k, d[k].value]));
    if (integrated) {
      const data = (x: unknown, seen = new Set<object>()): void => {
        if (x === null || typeof x === 'string' || typeof x === 'boolean' || typeof x === 'number' && Number.isFinite(x)) return;
        if (!x || typeof x !== 'object' || seen.has(x)) throw Error();
        const array=Array.isArray(x), keys=Reflect.ownKeys(x);
        if (Object.getPrototypeOf(x)!==(array?Array.prototype:Object.prototype) || array && keys.length!==(x as unknown[]).length+1) throw Error();
        seen.add(x); for (const k of keys) { if(array && k==='length') continue; const p=Object.getOwnPropertyDescriptor(x,k)!;
          if(typeof k!=='string'||!p.enumerable||!Object.hasOwn(p,'value') || array && (!/^(0|[1-9][0-9]*)$/.test(k)||Number(k)>=(x as unknown[]).length)) throw Error(); data(p.value,seen); } seen.delete(x);
      };
      if(rootKeys.filter(k=>k!=='modelContract').some(k=>!d[k].enumerable)) throw Error(); data(v);
    }
    if (v.referenceMemory !== true || v.decisionMode !== 'jev' || v.humanReferent !== true ||
        v.initialObservation !== 'cache_required' || v.questionLayout !== 'two_stage_v1' || v.utteranceStyle !== 'default' || v.maxReobservations !== 1) throw Error();
    fixed(v.localGrounding, {enabled: true, aiPublicClaims: true});
    fixed(v.modelPolicy, {purpose: 'dialogue_turn', resolver: 'research_worker', jevModel: MODEL_CONTRACT_V2.requested});
    validateResearchTimeouts(fields(v.timeouts, ['observationMs', 'localMs', 'decisionMs', 'lunaAttemptMs', 'generationMs', 'trialMs']));
    const luna = fields(v.lunaRequest, ['timeoutMs', 'maxCompletionTokens']);
    if (luna.timeoutMs !== null || luna.maxCompletionTokens !== null &&
        (typeof luna.maxCompletionTokens !== 'number' || !Number.isSafeInteger(luna.maxCompletionTokens) || luna.maxCompletionTokens < 1 || luna.maxCompletionTokens > 8192)) throw Error();
    if (v.outputLimit !== (luna.maxCompletionTokens === null ? 'worker_dependent_effective_value_unverified' : 'explicit_client_request')) throw Error();
  } catch { throw new ModelIntegrationError('model_profile_invalid'); }
  if (!Object.hasOwn(d, 'modelContract')) throw new ModelIntegrationError('model_contract_missing');
  let ref: Record<string, unknown>;
  try {
    if (!Object.hasOwn(d.modelContract, 'value') || d.id.value === 'research_trial_profile_v3' && !d.modelContract.enumerable) throw Error();
    ref = fields(d.modelContract.value, ['version', 'tableSha256']);
    if (typeof ref.version !== 'string' || ref.version.length === 0 || typeof ref.tableSha256 !== 'string' ||
        ref.tableSha256.length !== 64 || /[^0-9a-f]/u.test(ref.tableSha256)) throw Error();
  } catch { throw new ModelIntegrationError('model_contract_invalid'); }
  if (ref.version !== MODEL_CONTRACT_V2.version) throw new ModelIntegrationError('model_contract_unknown');
  if (ref.tableSha256 !== MODEL_CONTRACT_V2_TABLE_SHA256) throw new ModelIntegrationError('model_table_mismatch');
  return Object.freeze({profileId: d.id.value as 'research_trial_profile_v2'|'research_trial_profile_v3', mode: 'explicit',
    modelContract: Object.freeze({version: MODEL_CONTRACT_V2.version, tableSha256: MODEL_CONTRACT_V2_TABLE_SHA256})});
}
