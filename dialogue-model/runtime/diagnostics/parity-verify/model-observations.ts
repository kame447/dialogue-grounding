import { checkModelIdentity, MODEL_CONTRACT_V2 } from '../../model-identity-contract.ts';
import type { ClassifiedModelObservation, ModelObservationSet, ModelRejectionCode, ObservationIssue, ObservationIssueReason, SourcePointer } from '../../model-observations.ts';
import type { Records } from './core.ts';
import { failureKind } from './failure-records.ts';

type Data = Record<string, any>;
type Owner = {call: Data; order: number | null; file: string; pointer: string; sources: SourcePointer[]};
type Event = {value: Data; source: SourcePointer};
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const natural = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const plain = (v: unknown): v is Data => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
// Optional source arrays need every own position. A hole is missing evidence,
// not a value at that index and not proof that no work took place.
const dense = (v: unknown): v is any[] => Array.isArray(v) && Reflect.ownKeys(v).length === v.length + 1 &&
  Reflect.ownKeys(v).every(k => k === 'length' || typeof k === 'string' && /^(?:0|[1-9][0-9]*)$(?![\s\S])/u.test(k) && Number(k) < v.length);
const ptr = (file: string, pointer = ''): SourcePointer => ({file, pointer});
const textOrder = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const mergeSources = (xs: readonly SourcePointer[]) => [...new Map(xs.map(x => [JSON.stringify(x), {...x}])).values()]
  .sort((a, b) => textOrder(a.file, b.file) || textOrder(a.pointer, b.pointer));
function freeze<T>(v: T): T { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameData((a as Data)[k], (b as Data)[k]));
}
// Never invoke accessors while inspecting external, detached records.
function dataOnly(value: unknown, seen = new Set<object>()): void {
  if (value === null || ['string', 'boolean', 'number', 'undefined'].includes(typeof value)) return;
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype) || seen.has(value)) throw Error('model_observations_invalid');
  seen.add(value);
  const ds = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(ds).some(k => typeof k !== 'string' || !Object.hasOwn(ds[k], 'value'))) throw Error('model_observations_invalid');
  for (const d of Object.values(ds)) dataOnly(d.value, seen);
  seen.delete(value);
}
/** One frozen event snapshot is the sole observation authority. No paths are read. */
export function collectModelObservations(records: Records): ModelObservationSet {
  try {
    if (!plain(records) || !Array.isArray(records.trials) || Reflect.ownKeys(records).some(k => typeof k !== 'string' ||
        !['run', 'summary', 'warmup', 'failure', 'trials', 'billing', 'deadlineRevisions', 'packets', 'storage', 'evidence'].includes(k))) throw Error();
    dataOnly(records);
    return collect(records);
  } catch { throw Error('model_observations_invalid'); }
}
function collect(records: Records): ModelObservationSet {
  const r = records as Data;
  const out: {schemaVersion: 'model_observation_set_v1'; observations: ClassifiedModelObservation[]; lateObservations: ClassifiedModelObservation[];
    missing: ObservationIssue[]; inconsistent: ObservationIssue[]; rejected: ObservationIssue[]; notSent: SourcePointer[]} = {
    schemaVersion: 'model_observation_set_v1', observations: [], lateObservations: [], missing: [], inconsistent: [], rejected: [], notSent: []};
  const mappedTrials = r.trials.filter((t: unknown) => plain(t) && natural(t.order));
  const roots = [...['run', 'summary', 'warmup', 'failure', 'evidence'].filter(k => Object.hasOwn(r, k) && r[k] !== undefined)
    .map(k => ptr(k === 'evidence' ? 'verifier-evidence.private.json' : k + '.private.json')),
    ...mappedTrials.filter((t: Data) => mappedTrials.filter((other: Data) => other.order === t.order).length === 1)
      .map((t: Data) => ptr('trial-' + t.order + '.private.json'))];
  const anchor = (xs: SourcePointer[]) => xs.length ? xs : roots.length ? roots.slice(0, 1) : [];
  const add = (kind: 'missing' | 'inconsistent' | 'rejected', reason: ObservationIssueReason, xs: SourcePointer[],
    callId: unknown = null, sendId: unknown = null, responseSeq: unknown = null, rejectionCode: ModelRejectionCode | null = null) => {
    out[kind].push({callId: positive(callId) ? callId : null, sendId: positive(sendId) ? sendId : null,
      responseSeq: positive(responseSeq) ? responseSeq : null, reason, rejectionCode, sources: mergeSources(reason === 'source_missing' ? anchor(xs) : xs)});
  };
  const gap = (xs: SourcePointer[], callId?: unknown, sendId?: unknown, seq?: unknown) => add('missing', 'source_missing', xs, callId, sendId, seq);
  const run = plain(r.run) ? r.run : {}, summary = plain(r.summary) ? r.summary : {};
  const plan = plain(run.manifest) && dense(run.manifest.trials) ? run.manifest.trials : null;
  const runOrder = dense(summary.runOrder) ? summary.runOrder : null;
  const skipped = dense(summary.skipped) ? summary.skipped : null;
  let completePlan = !!plan && !!runOrder && !!skipped;
  if (!plan || typeof run.runId !== 'string') gap(Object.hasOwn(r, 'run') ? [ptr('run.private.json')] : []);
  if (!runOrder || !skipped || typeof summary.runId !== 'string') gap(Object.hasOwn(r, 'summary') ? [ptr('summary.private.json')] : []);
  if (typeof run.runId === 'string' && typeof summary.runId === 'string' && run.runId !== summary.runId)
    add('inconsistent', 'owner_conflict', [ptr('run.private.json', '/runId'), ptr('summary.private.json', '/runId')]);
  const remaining: number[] = [], skippedIndices = new Set<number>();
  if (plan && runOrder && skipped) {
    for (let i = 0; i < skipped.length; i++) {
      const s = skipped[i], source = ptr('summary.private.json', '/skipped/' + i);
      if (!plain(s) || !natural(s.plannedIndex) || s.plannedIndex >= plan.length || !plain(plan[s.plannedIndex]) ||
          s.status !== 'not_reached' || s.scriptId !== plan[s.plannedIndex].scriptId || s.label !== plan[s.plannedIndex].label) {
        completePlan = false; gap([source]); continue;
      }
      if (skippedIndices.has(s.plannedIndex)) add('inconsistent', 'duplicate_conflict', [source]);
      skippedIndices.add(s.plannedIndex);
    }
    for (let i = 0; i < plan.length; i++) if (!skippedIndices.has(i)) remaining.push(i);
    if (remaining.length !== runOrder.length) { completePlan = false; gap([ptr('summary.private.json', '/runOrder'), ptr('run.private.json', '/manifest/trials')]); }
    runOrder.forEach((p: unknown, i: number) => {
      const expected = plan[remaining[i]];
      if (!plain(p) || !plain(expected) || typeof p.scriptId !== 'string' || typeof p.label !== 'string') { completePlan = false; gap([ptr('summary.private.json', '/runOrder/' + i)]); }
      else if (p.scriptId !== expected.scriptId || p.label !== expected.label) add('inconsistent', 'owner_conflict', [ptr('summary.private.json', '/runOrder/' + i), ptr('run.private.json', '/manifest/trials/' + remaining[i])]);
    });
  }
  const owners = new Map<number, Owner[]>(), ownerFiles = new Map<number | null, {file: string; calls: any[] | null}>();
  const addCalls = (calls: any[], order: number | null, file: string) => {
    ownerFiles.set(order, {file, calls});
    calls.forEach((call, i) => {
      const source = ptr(file, '/calls/' + i);
      if (!plain(call) || !positive(call.id)) { gap([source]); return; }
      const owner: Owner = {call, order, file, pointer: source.pointer, sources: [source]}, previous = owners.get(call.id) ?? [];
      const exact = previous.find(o => o.order === order && o.file === file && sameData(o.call, call));
      if (exact) { exact.sources.push(source); return; }
      if (previous.length) add('inconsistent', 'owner_conflict', [...previous.map(o => ptr(o.file, o.pointer)), source], call.id);
      owners.set(call.id, [...previous, owner]);
      if (!dense(call.sendIds)) gap([source], call.id);
      else if (call.sendIds.some((id: unknown) => !positive(id)) || new Set(call.sendIds).size !== call.sendIds.length)
        add('inconsistent', 'owner_conflict', [ptr(file, source.pointer + '/sendIds')], call.id);
    });
  };
  const seenOrders = new Set<number>();
  for (const t of r.trials) {
    if (!plain(t) || !natural(t.order)) { gap([]); continue; }
    const file = 'trial-' + t.order + '.private.json';
    if (seenOrders.has(t.order)) add('inconsistent', 'duplicate_conflict', [ptr(file, '/order')]);
    seenOrders.add(t.order);
    const p = plan?.[t.plannedIndex], started = runOrder?.[t.order];
    if (completePlan && (!started || t.plannedIndex !== remaining[t.order] || t.scriptId !== p?.scriptId || t.label !== p?.label))
      add('inconsistent', 'owner_conflict', [ptr(file), ptr('summary.private.json', '/runOrder')]);
    if (!dense(t.calls)) { ownerFiles.set(t.order, {file, calls: null}); gap([ptr(file)]); }
    else addCalls(t.calls, t.order, file);
  }
  runOrder?.forEach((_: unknown, i: number) => { if (!seenOrders.has(i)) gap([ptr('summary.private.json', '/runOrder/' + i)]); });
  if (plain(r.warmup) && dense(r.warmup.calls)) addCalls(r.warmup.calls, null, 'warmup.private.json');
  else if (plain(r.failure) && ['warmup', 'legacy_v0'].includes(failureKind(r.failure)) && dense(r.failure.calls)) addCalls(r.failure.calls, null, 'failure.private.json');
  else gap(Object.hasOwn(r, 'warmup') ? [ptr('warmup.private.json')] : Object.hasOwn(r, 'failure') ? [ptr('failure.private.json')] : []);
  const evidence = plain(r.evidence) ? r.evidence : {}, events: Event[] = [];
  let ordered = dense(evidence.events);
  if (!ordered) gap(Object.hasOwn(r, 'evidence') ? [ptr('verifier-evidence.private.json')] : []);
  else {
    const seqs = new Set<number>();
    evidence.events.forEach((e: unknown, i: number) => {
      const source = ptr('verifier-evidence.private.json', '/events/' + i);
      if (!plain(e)) { ordered = false; gap([source]); return; }
      if (positive(e.seq) && seqs.has(e.seq)) { ordered = false; add('inconsistent', 'duplicate_conflict', [source], e.callId, e.sendId, e.seq); }
      if (e.seq !== i + 1) { ordered = false; gap([source], e.callId, e.sendId, e.seq); }
      if (positive(e.seq)) seqs.add(e.seq);
      events.push({value: e, source});
    });
  }
  const identityKeys = ['provider', 'instanceId', 'trialOrder', 'callId', 'phase'];
  const sameIdentity = (a: Data, b: Data) => identityKeys.every(k => a[k] === b[k]);
  const usableIdentity = (e: Data) => e.provider === 'jev' && typeof e.instanceId === 'string' && e.instanceId.length > 0 &&
    (e.trialOrder === null || natural(e.trialOrder)) && positive(e.callId) && typeof e.phase === 'string' && e.phase.length > 0;
  const jevSends = events.filter(x => x.value.type === 'send' && x.value.provider === 'jev');
  const sendOwners = new Map<number, Event>();
  const actual = new Set<number>();
  for (const sent of jevSends) {
    const e = sent.value, callOwners = positive(e.callId) ? owners.get(e.callId) ?? [] : [];
    actual.add(e.callId);
    const xs = [sent.source];
    if (!positive(e.sendId) || !usableIdentity(e)) { add('missing', 'binding_missing', xs, e.callId, e.sendId, e.seq); continue; }
    const prior = sendOwners.get(e.sendId);
    if (prior) { add('inconsistent', 'duplicate_conflict', [prior.source, sent.source], e.callId, e.sendId, e.seq); continue; }
    sendOwners.set(e.sendId, sent);
    const file = ownerFiles.get(e.trialOrder);
    if (!file || file.calls === null) {
      if (completePlan && natural(e.trialOrder) && !runOrder?.[e.trialOrder]) add('inconsistent', 'owner_conflict', xs, e.callId, e.sendId, e.seq);
      else gap(xs, e.callId, e.sendId, e.seq);
      continue;
    }
    const candidates = callOwners.filter(o => o.order === e.trialOrder && o.call.provider === e.provider && o.call.phase === e.phase);
    if (candidates.length !== 1 || callOwners.length !== 1) {
      add('inconsistent', 'owner_conflict', [...xs, ptr(file.file, '/calls')], e.callId, e.sendId, e.seq); continue;
    }
    const owner = candidates[0], call = owner.call;
    xs.push(...owner.sources);
    if (!dense(call.sendIds)) { gap(xs, e.callId, e.sendId, e.seq); continue; }
    if (call.sendIds.filter((s: unknown) => s === e.sendId).length !== 1) { add('inconsistent', 'owner_conflict', xs, e.callId, e.sendId, e.seq); continue; }
    const reservations = events.filter(x => x.value.type === 'reserve' && x.value.sendId === e.sendId);
    if (!reservations.length) add('missing', 'binding_missing', xs, e.callId, e.sendId, e.seq);
    else if (reservations.length !== 1 || !sameIdentity(reservations[0].value, e) || reservations[0].value.seq >= e.seq)
      add('inconsistent', 'owner_conflict', [...xs, ...reservations.map(x => x.source)], e.callId, e.sendId, e.seq);
    const responses = events.filter(x => x.value.type === 'response' && x.value.sendId === e.sendId);
    const owned = responses.filter(x => sameIdentity(x.value, e) && x.value.seq > e.seq);
    if (owned.length !== responses.length) add('inconsistent', 'owner_conflict', [...xs, ...responses.map(x => x.source)], e.callId, e.sendId, e.seq);
    const known = owned.filter(x => x.value.model !== null && x.value.model !== undefined);
    const names = new Set(known.map(x => x.value.model));
    if (names.size > 1) add('inconsistent', 'duplicate_conflict', [...xs, ...known.map(x => x.source)], e.callId, e.sendId, known[0]?.value.seq);
    const stops: Event[] = [];
    let scopeUncertain = false;
    for (const stop of events.filter(x => x.value.type === 'stop')) {
      const s = stop.value;
      if (s.scope === undefined || s.scope === 'run') { stops.push(stop); continue; }
      if (s.scope === 'trial') {
        if (!natural(s.trialOrder)) scopeUncertain = true;
        else if (s.trialOrder === e.trialOrder) stops.push(stop);
      } else if (s.scope === 'instance') {
        if (typeof s.provider !== 'string' || typeof s.instanceId !== 'string') { scopeUncertain = true; continue; }
        if (s.provider !== e.provider || s.instanceId !== e.instanceId) continue;
        if (s.scopeDetail === 'logical_call' && !positive(s.callId)) { scopeUncertain = true; continue; }
        if (s.trialOrder !== undefined && s.trialOrder !== e.trialOrder || s.scopeDetail === 'logical_call' &&
            (s.callId !== e.callId || s.phase !== undefined && s.phase !== e.phase)) {
          if (s.scopeDetail === 'logical_call' && positive(s.callId) && s.callId !== e.callId) continue;
          add('inconsistent', 'owner_conflict', [...xs, stop.source], e.callId, e.sendId, s.seq); continue;
        }
        if (s.scopeDetail !== undefined && s.scopeDetail !== 'logical_call' || s.scopeDetail === 'logical_call' && !positive(s.callId)) { scopeUncertain = true; continue; }
        stops.push(stop);
      } else scopeUncertain = true;
    }
    const close = stops.length ? Math.min(...stops.map(x => x.value.seq)) : Infinity;
    if (close <= e.seq) add('inconsistent', 'owner_conflict', [...xs, ...stops.filter(x => x.value.seq === close).map(x => x.source)], e.callId, e.sendId, e.seq);
    const proof = ordered && !scopeUncertain && reservations.length === 1 && sameIdentity(reservations[0].value, e) && reservations[0].value.seq < e.seq;
    const responseSources = owned.map(x => x.source);
    const code = (v: unknown): ModelRejectionCode | null => {
      const result = checkModelIdentity(MODEL_CONTRACT_V2.requested, v);
      return result.status === 'accepted' ? null : result.status === 'invalid' ? 'model_invalid' : result.status === 'unknown_version' ? 'model_unknown_version' : 'model_not_allowed';
    };
    for (const response of known) {
      const rejection = code(response.value.model);
      if (rejection) add('rejected', 'recorded_model_rejection', [...xs, response.source], e.callId, e.sendId, response.value.seq, rejection);
    }
    const callRejection = call.model === null || call.model === undefined ? null : code(call.model);
    if (callRejection) add('rejected', 'recorded_model_rejection', xs, e.callId, e.sendId, known[0]?.value.seq, callRejection);
    const finalSend = !jevSends.some(x => x.value.callId === e.callId && x.value.seq > e.seq);
    if (finalSend && call.model !== null && call.model !== undefined && known.some(x => x.value.model !== call.model))
      add('inconsistent', 'call_response_conflict', [...xs, ...responseSources], e.callId, e.sendId, known[0]?.value.seq);
    const rejectionStop = ['model_invalid', 'model_not_allowed', 'model_unknown_version'].includes(call.error) ? stops.find(x => x.value.reason === call.error) : undefined;
    if ((call.model === null || call.model === undefined) && rejectionStop) {
      add('rejected', 'recorded_model_rejection', [...xs, ...responseSources, rejectionStop.source], e.callId, e.sendId, rejectionStop.value.seq, call.error);
      continue;
    }
    const accepted = known.filter(x => code(x.value.model) === null);
    const matching = accepted.filter(x => call.model !== null && call.model !== undefined && !callRejection && (!finalSend || x.value.model === call.model));
    const main = proof ? matching.find(x => x.value.seq < close) : undefined;
    const late = proof ? accepted.find(x => x.value.seq > close) : undefined;
    const observed = main ?? late;
    if (observed && names.size === 1) {
      const classification = checkModelIdentity(MODEL_CONTRACT_V2.requested, observed.value.model);
      const value = {callId: e.callId, sendId: e.sendId, responseSeq: observed.value.seq, returnedId: observed.value.model,
        version: classification.version, sources: mergeSources([...xs, ...known.map(x => x.source)])};
      (main ? out.observations : out.lateObservations).push(value);
    }
    if (!main && !callRejection && !known.some(x => code(x.value.model) !== null)) {
      const reason = !owned.length ? 'response_missing' : call.model === null || call.model === undefined ? 'model_missing' : 'ordering_missing';
      add('missing', reason, [...xs, ...responseSources], e.callId, e.sendId, owned[0]?.value.seq);
    }
  }
  for (const response of events.filter(x => x.value.provider === 'jev' && x.value.type === 'response')) {
    if (!positive(response.value.sendId) || !sendOwners.has(response.value.sendId)) {
      const e = response.value, owner = ownerFiles.get(e.trialOrder);
      if (owner?.calls) add('inconsistent', 'owner_conflict', [response.source, ptr(owner.file, '/calls')], e.callId, e.sendId, e.seq);
      else gap([response.source], e.callId, e.sendId, e.seq);
    }
  }
  // Call-owned sends must also be accounted for when a send event is absent.
  const claimedSends = new Map<number, Owner>();
  for (const list of owners.values()) for (const owner of list) {
    const call = owner.call, source = ptr(owner.file, owner.pointer);
    if (call.provider !== 'jev' || !Array.isArray(call.sendIds)) continue;
    if (!call.sendIds.length && !actual.has(call.id)) out.notSent.push(...owner.sources);
    for (const sendId of call.sendIds) if (positive(sendId)) {
      const prior = claimedSends.get(sendId);
      if (prior && prior.call.id !== call.id) add('inconsistent', 'owner_conflict', [ptr(prior.file, prior.pointer), source], call.id, sendId);
      claimedSends.set(sendId, owner);
      if (!sendOwners.has(sendId)) add('missing', 'binding_missing', [source], call.id, sendId);
    }
  }
  const numberOrder = (a: number | null, b: number | null) => a === b ? 0 : a === null ? 1 : b === null ? -1 : a - b;
  for (const key of ['missing', 'inconsistent', 'rejected'] as const) {
    const unique = new Map<string, ObservationIssue>();
    for (const row of out[key]) {
      const identity = JSON.stringify([row.callId, row.sendId, row.responseSeq, row.reason, row.rejectionCode,
        row.reason === 'source_missing' && row.callId === null && row.sendId === null ? row.sources : null]);
      const previous = unique.get(identity);
      unique.set(identity, previous ? {...row, sources: mergeSources([...previous.sources, ...row.sources])} : row);
    }
    out[key] = [...unique.values()].sort((a, b) => numberOrder(a.responseSeq, b.responseSeq) || numberOrder(a.callId, b.callId) || numberOrder(a.sendId, b.sendId) || textOrder(a.reason, b.reason));
  }
  for (const key of ['observations', 'lateObservations'] as const) out[key].sort((a, b) => a.responseSeq - b.responseSeq || a.callId - b.callId || a.sendId - b.sendId);
  out.notSent = mergeSources(out.notSent);
  return freeze(out);
}
