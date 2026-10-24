// Pure aggregation of already-classified observations; no registry lookup or I/O.
export type SourcePointer = Readonly<{file: string; pointer: string}>;
export type ClassifiedModelObservation = Readonly<{callId: number; sendId: number; responseSeq: number;
  returnedId: string; version: string | null; sources: readonly SourcePointer[]}>;
export type ModelRejectionCode = 'model_invalid' | 'model_not_allowed' | 'model_unknown_version';
export type ObservationIssueReason = 'response_missing' | 'model_missing' | 'binding_missing' | 'ordering_missing' |
  'source_missing' | 'duplicate_conflict' | 'owner_conflict' | 'call_response_conflict' | 'recorded_model_rejection';
export type ObservationIssue = Readonly<{callId: number | null; sendId: number | null; responseSeq: number | null;
  reason: ObservationIssueReason; rejectionCode: ModelRejectionCode | null; sources: readonly SourcePointer[]}>;
export type ModelObservationSet = Readonly<{schemaVersion: 'model_observation_set_v1';
  observations: readonly ClassifiedModelObservation[]; lateObservations: readonly ClassifiedModelObservation[];
  missing: readonly ObservationIssue[]; inconsistent: readonly ObservationIssue[]; rejected: readonly ObservationIssue[];
  notSent: readonly SourcePointer[]}>;
export type ModelTechnicalSummary = Readonly<{
  technicalState: 'technical_accepted' | 'technical_rejected' | 'technical_unknown';
  reason: 'input_inconsistent' | ModelRejectionCode | 'model_version_mixed' | 'evidence_missing' | 'empty_observation_set' | 'all_observed_accepted';
  acceptedReturnedIds: readonly string[]; observedVersions: readonly string[]; versionIdentified: boolean;
  observedCount: number; missingCount: number; inconsistentCount: number;
}>;
const invalid = (): never => { throw Error('model_observations_invalid'); };
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return invalid();
  const d = Object.getOwnPropertyDescriptors(value), own = Reflect.ownKeys(d);
  if (own.length !== keys.length || own.some(k => typeof k !== 'string' || !keys.includes(k)) || keys.some(k => !d[k] || !Object.hasOwn(d[k], 'value'))) return invalid();
  return Object.fromEntries(keys.map(k => [k, d[k].value]));
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return invalid();
  const d = Object.getOwnPropertyDescriptors(value as object), n = d.length.value as number;
  if (Reflect.ownKeys(d).length !== n + 1 || Array.from({length: n}, (_, i) => d[i]).some(x => !x || !Object.hasOwn(x, 'value'))) return invalid();
  return Array.from({length: n}, (_, i) => d[i].value);
}
function id(value: unknown, nullable = false): number | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return invalid();
  return value;
}
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sourceOrder = (a: SourcePointer, b: SourcePointer) => compareText(a.file, b.file) || compareText(a.pointer, b.pointer);
function sources(value: unknown, allowEmpty = false): SourcePointer[] {
  const rows = array(value).map(row => {
    const v = object(row, ['file', 'pointer']);
    if (typeof v.file !== 'string' || !['run.private.json', 'summary.private.json', 'failure.private.json', 'warmup.private.json', 'verifier-evidence.private.json'].includes(v.file) &&
        !/^trial-(?:0|[1-9][0-9]*)\.private\.json$(?![\s\S])/u.test(v.file)) return invalid();
    if (typeof v.pointer !== 'string' || v.pointer !== '' && !v.pointer.startsWith('/') || /~(?![01])/u.test(v.pointer as string)) return invalid();
    return {file: v.file, pointer: v.pointer as string};
  });
  if (!rows.length && !allowEmpty) return invalid();
  return [...new Map(rows.map(s => [JSON.stringify(s), s])).values()].sort(sourceOrder);
}
function observation(value: unknown): ClassifiedModelObservation {
  const v = object(value, ['callId', 'sendId', 'responseSeq', 'returnedId', 'version', 'sources']);
  const alias = 'typesafe/jev-1.14';
  if (typeof v.returnedId !== 'string' || v.version !== null && (typeof v.version !== 'string' || v.version.length !== 8 || /[^0-9]/u.test(v.version)) ||
      v.returnedId !== (v.version === null ? alias : alias + '-' + v.version)) return invalid();
  return {callId: id(v.callId)!, sendId: id(v.sendId)!, responseSeq: id(v.responseSeq)!, returnedId: v.returnedId,
    version: v.version as string | null, sources: sources(v.sources)};
}
const missingReasons = ['response_missing', 'model_missing', 'binding_missing', 'ordering_missing', 'source_missing'];
const conflictReasons = ['duplicate_conflict', 'owner_conflict', 'call_response_conflict'];
const rejectionCodes = ['model_invalid', 'model_not_allowed', 'model_unknown_version'];
function issue(value: unknown, kind: 'missing' | 'inconsistent' | 'rejected'): ObservationIssue {
  const v = object(value, ['callId', 'sendId', 'responseSeq', 'reason', 'rejectionCode', 'sources']);
  if (typeof v.reason !== 'string' || !(kind === 'missing' ? missingReasons : kind === 'inconsistent' ? conflictReasons : ['recorded_model_rejection']).includes(v.reason) ||
      (kind === 'rejected' ? typeof v.rejectionCode !== 'string' || !rejectionCodes.includes(v.rejectionCode) : v.rejectionCode !== null)) return invalid();
  return {callId: id(v.callId, true), sendId: id(v.sendId, true), responseSeq: id(v.responseSeq, true), reason: v.reason as ObservationIssueReason,
    rejectionCode: v.rejectionCode as ModelRejectionCode | null, sources: sources(v.sources, v.reason === 'source_missing')};
}
const numOrder = (a: number | null, b: number | null) => a === b ? 0 : a === null ? 1 : b === null ? -1 : a - b;
const issueOrder = (a: ObservationIssue, b: ObservationIssue) => numOrder(a.responseSeq, b.responseSeq) || numOrder(a.callId, b.callId) || numOrder(a.sendId, b.sendId) || compareText(a.reason, b.reason) || compareText(a.rejectionCode ?? '', b.rejectionCode ?? '');
function uniqueIssues(rows: readonly ObservationIssue[]): ObservationIssue[] {
  const map = new Map<string, ObservationIssue>();
  for (const row of rows) {
    // Distinct source gaps with no identity retain their dependency anchors.
    const key = JSON.stringify([row.callId, row.sendId, row.responseSeq, row.reason, row.rejectionCode,
      row.reason === 'source_missing' && row.callId === null && row.sendId === null ? row.sources : null]);
    const prev = map.get(key);
    map.set(key, prev ? {...prev, sources: sources([...prev.sources, ...row.sources], row.reason === 'source_missing')} : row);
  }
  return [...map.values()].sort(issueOrder);
}
export function aggregateClassifiedModelObservations(value: unknown): ModelTechnicalSummary {
  try {
    const v = object(value, ['schemaVersion', 'observations', 'lateObservations', 'missing', 'inconsistent', 'rejected', 'notSent']);
    if (v.schemaVersion !== 'model_observation_set_v1') return invalid();
    const order = (a: ClassifiedModelObservation, b: ClassifiedModelObservation) => a.responseSeq - b.responseSeq || a.callId - b.callId || a.sendId - b.sendId || compareText(a.returnedId, b.returnedId);
    const main = array(v.observations).map(observation).sort(order), late = array(v.lateObservations).map(observation).sort(order);
    const missing = uniqueIssues(array(v.missing).map(x => issue(x, 'missing')));
    const conflicts = array(v.inconsistent).map(x => issue(x, 'inconsistent'));
    const rejected = uniqueIssues(array(v.rejected).map(x => issue(x, 'rejected')));
    sources(v.notSent, true);
    const seen = new Map<number, ClassifiedModelObservation>(), placed = new Map<string, 'main' | 'late'>();
    const uniqueMain = new Map<string, ClassifiedModelObservation>();
    for (const [rows, placement] of [[main, 'main'], [late, 'late']] as const) for (const row of rows) {
      const old = seen.get(row.sendId), key = row.callId + ':' + row.sendId, previousPlacement = placed.get(key);
      if (old && (old.callId !== row.callId || old.returnedId !== row.returnedId || old.version !== row.version) || previousPlacement && previousPlacement !== placement) {
        conflicts.push({callId: row.callId, sendId: row.sendId, responseSeq: row.responseSeq,
          reason: old && old.callId !== row.callId ? 'owner_conflict' : 'duplicate_conflict', rejectionCode: null,
          sources: sources([...(old?.sources ?? []), ...row.sources])});
      }
      if (!old) seen.set(row.sendId, row);
      placed.set(key, placement);
      if (placement === 'main' && !uniqueMain.has(key)) uniqueMain.set(key, row);
    }
    const inconsistent = uniqueIssues(conflicts), observed = [...uniqueMain.values()];
    const acceptedReturnedIds = Object.freeze([...new Set(main.map(x => x.returnedId))].sort(compareText));
    const observedVersions = Object.freeze([...new Set(main.flatMap(x => x.version === null ? [] : [x.version]))].sort(compareText));
    let technicalState: ModelTechnicalSummary['technicalState'], reason: ModelTechnicalSummary['reason'];
    if (inconsistent.length) { technicalState = 'technical_rejected'; reason = 'input_inconsistent'; }
    else if (rejected.length) { technicalState = 'technical_rejected'; reason = rejected[0].rejectionCode!; }
    else if (observedVersions.length > 1) { technicalState = 'technical_rejected'; reason = 'model_version_mixed'; }
    else if (missing.length) { technicalState = 'technical_unknown'; reason = 'evidence_missing'; }
    else if (!observed.length) { technicalState = 'technical_unknown'; reason = 'empty_observation_set'; }
    else { technicalState = 'technical_accepted'; reason = 'all_observed_accepted'; }
    return Object.freeze({technicalState, reason, acceptedReturnedIds, observedVersions,
      versionIdentified: technicalState === 'technical_accepted' && observed.every(x => x.version !== null),
      observedCount: observed.length, missingCount: missing.length, inconsistentCount: inconsistent.length});
  } catch { return invalid(); }
}
