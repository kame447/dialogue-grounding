import { ModelIntegrationError, resolveModelPolicy } from '../../model-policy.ts';
import { checkModelIdentity, MODEL_CONTRACT_V2 } from '../../model-identity-contract.ts';
import { aggregateClassifiedModelObservations } from '../../model-observations.ts';
import type { ModelObservationSet, ModelTechnicalSummary, SourcePointer } from '../../model-observations.ts';
import { collectModelObservations } from './model-observations.ts';
import { check, list, row, rows } from './core.ts';
import type { Check, Records, Row } from './core.ts';

export function explicitModelPolicy(records: Records): boolean {
  try { return resolveModelPolicy(records.run?.profile).mode === 'explicit'; } catch { return false; }
}
/** Predicate relation only. Exact equality between response/call/trace stays separate. */
export function requestedReturnedModel(records: Records, call: Row): boolean {
  if (call.provider !== 'jev' || !explicitModelPolicy(records)) return typeof call.requestedModel === 'string' && call.model === call.requestedModel;
  return call.requestedModel === MODEL_CONTRACT_V2.requested && checkModelIdentity(call.requestedModel, call.model).status === 'accepted';
}
export type ModelCheckContext = {checks: Check[]; observations?: ModelObservationSet; error?: string; explicit: boolean};
const technical = (id: string, summary: ModelTechnicalSummary): Check => check(id,
  summary.technicalState === 'technical_accepted' ? 'pass' : summary.technicalState === 'technical_rejected' ? 'mismatch' : 'not_reached',
  summary.reason, {...summary});
export function modelChecks(records: Records): ModelCheckContext {
  if (!records.run || !Object.hasOwn(records.run, 'profile')) return {explicit: true,
    checks: ['identity.model_contract', 'identity.model_observations', 'identity.model_technical'].map(id => check(id, 'not_reached', 'evidence_missing'))};
  let explicit = false;
  try { explicit = resolveModelPolicy(records.run.profile).mode === 'explicit'; }
  catch (error) {
    const code = error instanceof ModelIntegrationError ? error.code : 'model_profile_invalid';
    return {explicit: true, error: code, checks: ['identity.model_contract', 'identity.model_observations', 'identity.model_technical'].map(id => check(id, 'mismatch', code))};
  }
  if (!explicit) return {checks: [], explicit: false};
  const contract = check('identity.model_contract', 'pass', 'model_contract_valid');
  try {
    const observations = collectModelObservations(records), result = aggregateClassifiedModelObservations(observations);
    const observed = result.inconsistentCount > 0 || observations.rejected.length > 0 ? 'mismatch' :
      result.missingCount > 0 || result.observedCount === 0 ? 'not_reached' : 'pass';
    return {explicit, observations, checks: [contract, check('identity.model_observations', observed, result.reason), technical('identity.model_technical', result)]};
  } catch {
    return {explicit, error: 'model_observations_invalid', checks: [contract,
      check('identity.model_observations', 'mismatch', 'model_observations_invalid'), check('identity.model_technical', 'mismatch', 'model_observations_invalid')]};
  }
}
function mapping(records: Records) {
  const plan = list(row(records.run?.manifest).trials), started = list(records.summary?.runOrder), skipped = list(records.summary?.skipped);
  if (!Array.isArray(row(records.run?.manifest).trials) || !Array.isArray(records.summary?.runOrder) || !Array.isArray(records.summary?.skipped)) return null;
  const removed = new Set<number>();
  for (const s of skipped.map(row)) {
    if (!Number.isSafeInteger(s.plannedIndex) || Number(s.plannedIndex) < 0 || !plan[Number(s.plannedIndex)] || removed.has(Number(s.plannedIndex)) ||
        s.status !== 'not_reached' || s.scriptId !== row(plan[Number(s.plannedIndex)]).scriptId || s.label !== row(plan[Number(s.plannedIndex)]).label) return null;
    removed.add(Number(s.plannedIndex));
  }
  const positions = plan.map((_, i) => i).filter(i => !removed.has(i));
  if (positions.length !== started.length || started.some((s, i) => row(s).scriptId !== row(plan[positions[i]]).scriptId || row(s).label !== row(plan[positions[i]]).label)) return null;
  const valid = (trial: Row) => Number.isSafeInteger(trial.order) && Number(trial.order) >= 0 &&
    records.trials.filter(t => t.order === trial.order).length === 1 && trial.plannedIndex === positions[Number(trial.order)] &&
    row(started[Number(trial.order)]).scriptId === trial.scriptId && row(started[Number(trial.order)]).label === trial.label;
  return {positions, started, valid};
}
type Dependency = {orders: Set<number>; unresolved: boolean; shared: boolean};
/** Internal projection seam; input is the already-collected complete snapshot. */
export function scopedModelCheck(records: Records, full: ModelObservationSet | undefined, order: number, contextError?: string): Check {
  const id = 'smoke.model_technical.' + order;
  let policy;
  try {
    if (!records.run || !Object.hasOwn(records.run, 'profile')) return check(id, 'not_reached', 'evidence_missing');
    policy = resolveModelPolicy(records.run.profile);
  } catch (error) { return check(id, 'mismatch', error instanceof ModelIntegrationError ? error.code : 'model_profile_invalid'); }
  if (policy.mode !== 'explicit') return check(id, 'not_reached', 'evidence_missing');
  if (contextError || !full) return check(id, 'mismatch', contextError ?? 'model_observations_invalid');
  try {
    // Structural validation cannot be repaired by dropping a malformed entry.
    aggregateClassifiedModelObservations(full);
    const map = mapping(records), events = rows(records.evidence?.events);
    const actualTarget = records.trials.find(t => t.order === order), bound = !!map && !!actualTarget && map.valid(actualTarget);
    const sources = new Map<string, unknown>([['run.private.json', records.run], ['summary.private.json', records.summary],
      ['warmup.private.json', records.warmup], ['failure.private.json', records.failure], ['verifier-evidence.private.json', records.evidence]]);
    for (const t of records.trials) if (Number.isSafeInteger(t.order) && Number(t.order) >= 0) sources.set('trial-' + t.order + '.private.json', t);
    const calls = records.trials.flatMap(t => rows(t.calls).map(c => ({call: c, trial: t})));
    const dependency = (entry: {callId?: number | null; sendId?: number | null; sources: readonly SourcePointer[]}): Dependency => {
      const d: Dependency = {orders: new Set(), unresolved: false, shared: false};
      const addOrder = (n: unknown) => { if (map && Number.isSafeInteger(n) && Number(n) >= 0 && map.started[Number(n)]) d.orders.add(Number(n)); else d.unresolved = true; };
      const addEvent = (e: Row) => {
        if (e.type === 'stop') {
          if (e.scope === undefined || e.scope === 'run') { d.shared = true; return; }
          if (e.scope === 'trial') { addOrder(e.trialOrder); return; }
          if (e.scope !== 'instance' || typeof e.instanceId !== 'string' || typeof e.provider !== 'string') { d.unresolved = true; return; }
          const related = events.filter(x => x.provider === e.provider && x.instanceId === e.instanceId &&
            (e.scopeDetail !== 'logical_call' || x.callId === e.callId && (e.phase === undefined || x.phase === e.phase)) && x.type === 'send');
          if (!related.length || e.scopeDetail !== undefined && e.scopeDetail !== 'logical_call') d.unresolved = true;
          related.forEach(x => addOrder(x.trialOrder)); return;
        }
        if (!['reserve', 'send', 'response', 'refused'].includes(String(e.type))) { d.unresolved = true; return; }
        addOrder(e.trialOrder);
        if (e.provider !== 'jev' || typeof e.instanceId !== 'string' || !Number.isSafeInteger(e.callId)) d.unresolved = true;
        const cs = calls.filter(x => x.call.id === e.callId);
        // An absent expected trial file is localized by the valid started map;
        // a present owner with bad binding cannot prove exclusivity.
        if (cs.length === 0 && !records.trials.some(t => t.order === e.trialOrder)) return;
        if (cs.length === 0) { d.unresolved = true; return; }
        cs.forEach(x => { if (!map?.valid(x.trial)) d.unresolved = true; addOrder(x.trial.order); });
      };
      if (entry.callId !== null && entry.callId !== undefined) {
        const cs = calls.filter(x => x.call.id === entry.callId);
        cs.forEach(x => { if (!map?.valid(x.trial)) d.unresolved = true; addOrder(x.trial.order); });
        const es = events.filter(e => e.callId === entry.callId && ['reserve', 'send', 'response'].includes(String(e.type)));
        es.forEach(addEvent); if (!cs.length && !es.length) d.unresolved = true;
      }
      if (entry.sendId !== null && entry.sendId !== undefined) {
        const es = events.filter(e => e.sendId === entry.sendId && ['reserve', 'send', 'response'].includes(String(e.type)));
        es.forEach(addEvent); if (!es.length) d.unresolved = true;
        calls.filter(x => list(x.call.sendIds).includes(entry.sendId)).forEach(x => { if (!map?.valid(x.trial)) d.unresolved = true; addOrder(x.trial.order); });
      }
      if (!entry.sources.length) d.unresolved = true;
      for (const s of entry.sources) {
        const source = sources.get(s.file);
        if (source === undefined) { d.unresolved = true; continue; }
        let value: unknown = source;
        const tokens = s.pointer === '' ? [] : s.pointer.slice(1).split('/').map(x => x.replace(/~1/gu, '/').replace(/~0/gu, '~'));
        for (const token of tokens) {
          if (value === null || typeof value !== 'object' || !Object.hasOwn(value, token)) { d.unresolved = true; value = undefined; break; }
          value = (value as Row)[token];
        }
        if (value === undefined) { d.unresolved = true; continue; }
        if (s.file.startsWith('trial-')) {
          const t = row(source); if (!map?.valid(t)) d.unresolved = true; addOrder(t.order);
        } else if (s.file === 'warmup.private.json' || s.file === 'failure.private.json') d.unresolved = true;
        else if (s.file === 'verifier-evidence.private.json') {
          if (tokens[0] !== 'events' || tokens.length < 2 || !/^(?:0|[1-9][0-9]*)$/u.test(tokens[1])) { d.shared = true; continue; }
          const e = row(events[Number(tokens[1])]);
          if (events.some((x, i) => x.seq !== i + 1)) { d.shared = true; continue; }
          addEvent(e);
        } else if (s.file === 'summary.private.json' && tokens[0] === 'runOrder' && tokens.length >= 2 && map) addOrder(Number(tokens[1]));
        else if (s.file === 'run.private.json' && tokens[0] === 'manifest' && tokens[1] === 'trials' && tokens.length >= 3 && map) {
          const n = map.positions.indexOf(Number(tokens[2])); if (n < 0) d.unresolved = true; else addOrder(n);
        } else {
          // Valid contextual roots do not turn a proven local issue into shared.
          // Root-only gaps, identity disagreements and mapping gaps stay shared.
          if (!d.orders.size || (entry as {reason?: string}).reason !== 'source_missing') d.shared = true;
        }
      }
      if (!d.orders.size) d.unresolved = true;
      return d;
    };
    const keep = (entry: {callId?: number | null; sendId?: number | null; sources: readonly SourcePointer[]}) => {
      const d = dependency(entry); return d.shared || d.unresolved || d.orders.has(order);
    };
    const projected: ModelObservationSet = {schemaVersion: full.schemaVersion,
      observations: full.observations.filter(keep), lateObservations: full.lateObservations.filter(keep),
      missing: full.missing.filter(keep), inconsistent: full.inconsistent.filter(keep), rejected: full.rejected.filter(keep),
      notSent: full.notSent.filter(s => keep({sources: [s]}))};
    const result = aggregateClassifiedModelObservations(projected);
    if (result.technicalState === 'technical_rejected') return technical(id, result);
    if (!bound) return check(id, 'not_reached', 'model_scope_unresolved');
    return technical(id, result);
  } catch { return check(id, 'mismatch', 'model_observations_invalid'); }
}
