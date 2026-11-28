// Applies the structured whole construal AI proposal (consensus-120.json, 120 orientations) to the running
// orientation review page (docs/review/orientation-app, default http://127.0.0.1:5498) as its structured
// whole-construal layer (wholeConstruals).
//
// Only the whole-construal layer is written, orientation by orientation. An entry that is still empty or an
// unreviewed AI proposal is replaced by the proposal; an entry the researcher confirmed or edited is kept.
// The free text (whole, wholeBasis, part roles), notes, row statuses, the independent part layer and the
// current position (currentId) are sent back exactly as they were read. The layer is never filled by parsing
// the free text. When a row's free text differs from the text the AI proposal would produce (the researcher
// edited it by hand), the proposal is still entered as an unreviewed AI proposal, but the row is marked
// needsTextCheck ("自由文と要照合") so the researcher compares the two on the page; the builder reports such rows.
// The state and the export are backed up first. A stale revision is never overwritten: the latest state is
// reloaded, what changed since the read is reported, and nothing is written. Nothing is written either when no
// entry would change.
//
//   node docs/review/part-construal-20261128/apply-whole-construal-to-review.ts \
//     --consensus <consensus-120.json> --backup-dir <new private directory> \
//     [--state-file <review-state.json>] [--url <review URL>] [--dry-run]
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { consensusContent, sameContent, validateEntries, type Entry as ConsensusEntry, type Template as ConsensusTemplate } from '../construal-consensus-20261128/apply-consensus-to-review.ts';

export type WholeCandidate = { noun: string; posture: string; direction: string; confidence: string; parts: { id: string; role: string }[]; evidence: string; weaknesses: string };
export type Whole = { id: string; reviewStatus: string; candidates: WholeCandidate[]; noConstrual: boolean; noConstrualReason: string; needsTextCheck: boolean; ai: { agreementStatus: string; discussion: string } | null };
export type WholeLayer = { schemaVersion: string; rows: Whole[] };
export type Row = { id: string; status: string; note: string; whole: string; wholeBasis: string[]; parts: { id: string; description: string; candidates: string[] }[] };
export type State = { schemaVersion: string; sourceSha256: string; revision: number; updatedAt: string; currentId: string; results: Row[]; wholeConstruals: WholeLayer };
export type Data = { schemaVersion: string; sourceSha256: string; catalogRevision: string; templates: ConsensusTemplate[]; wholeConstrual: { schemaVersion: string; maxCandidates: number; confidences: string[] } };
export type ConsensusFile = { schemaVersion?: string; catalogRevision: string; orientations: (ConsensusEntry & { discussion?: string })[] };
export type Kind = 'added' | 'updated' | 'unchanged' | 'keptConfirmed' | 'keptEdited';

const SCHEMA = 'tangram_orientation_review_v1';
function limit(v: unknown, max: number, what: string) {
  if (typeof v !== 'string' || v.length > max) throw Error(what + ': text of at most ' + max + ' characters required');
}

// Validates the consensus against the catalog (with the consensus tool's own validator) and against the limits the page
// enforces, and returns the proposed layer entries. needsTextCheck is set from the current free text of each row.
export function proposeWholes(consensus: ConsensusFile, data: Data, state: State): { entries: Whole[]; textMismatch: string[] } {
  if (consensus?.catalogRevision !== data.catalogRevision) throw Error('consensus catalogRevision ' + consensus?.catalogRevision + ' differs from the review page (' + data.catalogRevision + ')');
  const byId = validateEntries(consensus.orientations, data.templates);
  const { maxCandidates, confidences } = data.wholeConstrual;
  const entries: Whole[] = [], textMismatch: string[] = [];
  data.templates.forEach((t, i) => {
    const e = byId.get(t.id)! as ConsensusEntry & { discussion?: string };
    if (e.candidates.length > maxCandidates) throw Error(t.id + ': at most ' + maxCandidates + ' candidates');
    e.candidates.forEach((c, k) => {
      if (c.rank !== k + 1) throw Error(t.id + ': candidate ranks must be 1..n in order');
      if (!confidences.includes(c.confidence)) throw Error(t.id + ': bad confidence ' + c.confidence);
      limit(c.noun, 40, t.id + ' noun'); limit(c.posture, 80, t.id + ' posture'); limit(c.direction, 80, t.id + ' direction');
      limit(c.evidence, 1000, t.id + ' evidence'); limit(c.weaknesses ?? '', 1000, t.id + ' weaknesses');
      c.parts.forEach(p => limit(p.role, 200, t.id + ' role'));
    });
    limit(e.noConstrualReason ?? '', 1000, t.id + ' noConstrualReason'); limit(e.discussion ?? '', 4000, t.id + ' discussion');
    const matches = sameContent(state.results[i], consensusContent(t, e));
    if (!matches) textMismatch.push(t.id);
    entries.push({
      id: t.id, reviewStatus: 'ai_unreviewed',
      candidates: e.candidates.map(c => ({ noun: c.noun, posture: c.posture, direction: c.direction, confidence: c.confidence, parts: c.parts.map(p => ({ id: p.id, role: p.role })), evidence: c.evidence, weaknesses: c.weaknesses ?? '' })),
      noConstrual: e.noConstrual, noConstrualReason: e.noConstrual ? e.noConstrualReason : '', needsTextCheck: !matches,
      ai: { agreementStatus: e.agreementStatus, discussion: e.discussion ?? '' },
    });
  });
  return { entries, textMismatch };
}

const isBlank = (w: Whole) => w.ai === null && w.reviewStatus === 'ai_unreviewed' && w.candidates.length === 0 && !w.noConstrual && !w.needsTextCheck;
export function classify(current: Whole, proposed: Whole): Kind {
  if (current.reviewStatus === 'researcher_confirmed') return 'keptConfirmed';
  if (current.reviewStatus === 'researcher_edited') return 'keptEdited';
  if (isDeepStrictEqual(current, proposed)) return 'unchanged';
  return isBlank(current) ? 'added' : 'updated';
}

export type ApplyOptions = { url: string; consensus: ConsensusFile; backupDir: string; stateFile?: string; dryRun?: boolean; beforePost?: () => Promise<void> };
export async function applyWholeConstrual(o: ApplyOptions) {
  const get = async (path: string) => { const r = await fetch(o.url + path, { cache: 'no-store' }); if (!r.ok) throw Error('GET ' + path + ': ' + r.status); return r; };
  const data = await (await get('/api/data')).json() as Data;
  const state = await (await get('/api/state')).json() as State;
  if (data.schemaVersion !== SCHEMA || state.schemaVersion !== SCHEMA || state.sourceSha256 !== data.sourceSha256) throw Error('review data and state do not match this tool');
  if (!data.wholeConstrual || !state.wholeConstruals || state.wholeConstruals.schemaVersion !== data.wholeConstrual.schemaVersion) throw Error('the review server does not have the whole construal layer (older code)');
  if (data.templates.length !== 120 || state.results.length !== 120 || state.results.some((r, i) => r.id !== data.templates[i].id) || state.wholeConstruals.rows.some((r, i) => r.id !== data.templates[i].id)) throw Error('expected the 120 orientations in catalog order');
  const { entries, textMismatch } = proposeWholes(o.consensus, data, state);
  if (existsSync(o.backupDir)) throw Error('backup directory already exists: ' + o.backupDir);
  mkdirSync(o.backupDir, { recursive: true, mode: 0o700 });
  const save = (name: string, content: string) => writeFileSync(join(o.backupDir, name), content, { mode: 0o600 });
  save('state-before.json', JSON.stringify(state, null, 2) + '\n');
  save('export-before.json', await (await get('/api/export')).text());
  if (o.stateFile) copyFileSync(o.stateFile, join(o.backupDir, 'review-state-file-before.json'));

  const kinds: Record<Kind, string[]> = { added: [], updated: [], unchanged: [], keptConfirmed: [], keptEdited: [] };
  const rows = state.wholeConstruals.rows.map((current, i) => {
    const kind = classify(current, entries[i]);
    kinds[kind].push(current.id);
    return kind === 'added' || kind === 'updated' ? entries[i] : current;
  });
  state.wholeConstruals.rows.forEach((w, i) => { if (w.reviewStatus !== 'ai_unreviewed' && !isDeepStrictEqual(rows[i], w)) throw Error('invariant broken: a reviewed entry would change: ' + w.id); });
  const plan = {
    revision: state.revision, updatedAt: state.updatedAt, currentId: state.currentId,
    counts: Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, v.length])) as Record<Kind, number>,
    needsTextCheck: rows.filter(w => w.needsTextCheck).map(w => w.id), textDiffersFromProposal: textMismatch,
    changed: { added: kinds.added, updated: kinds.updated }, kept: { keptConfirmed: kinds.keptConfirmed, keptEdited: kinds.keptEdited },
  };
  save('plan.json', JSON.stringify(plan, null, 2) + '\n');
  if (o.dryRun) return { dryRun: true as const, plan };
  if (!kinds.added.length && !kinds.updated.length) return { noChange: true as const, plan };
  if (o.beforePost) await o.beforePost();
  const body = { revision: state.revision, sourceSha256: data.sourceSha256, currentId: state.currentId, results: state.results, wholeConstruals: { schemaVersion: state.wholeConstruals.schemaVersion, rows } };
  const response = await fetch(o.url + '/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (response.status === 409) {
    const latest = await (await get('/api/state')).json() as State;
    const conflict = {
      conflict: true as const, readRevision: state.revision, latestRevision: latest.revision, latestUpdatedAt: latest.updatedAt,
      currentIdChanged: latest.currentId !== state.currentId,
      rowsChangedSinceRead: latest.results.filter((r, i) => !isDeepStrictEqual(r, state.results[i])).map(r => r.id),
      entriesChangedSinceRead: latest.wholeConstruals.rows.filter((w, i) => !isDeepStrictEqual(w, state.wholeConstruals.rows[i])).map(w => w.id),
    };
    save('conflict.json', JSON.stringify(conflict, null, 2) + '\n');
    return { ...conflict, plan };
  }
  if (!response.ok) throw Error('update rejected: ' + response.status + ' ' + await response.text());
  const saved = await response.json() as State;
  if (saved.revision !== state.revision + 1 || saved.currentId !== state.currentId || !isDeepStrictEqual(saved.results, state.results) || !isDeepStrictEqual(saved.wholeConstruals.rows, rows)) throw Error('saved state differs from the planned update');
  save('state-after.json', JSON.stringify(saved, null, 2) + '\n');
  save('export-after.json', await (await get('/api/export')).text());
  return { conflict: false as const, revision: saved.revision, currentId: saved.currentId, plan };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { url: { type: 'string', default: 'http://127.0.0.1:5498' }, consensus: { type: 'string' }, 'backup-dir': { type: 'string' }, 'state-file': { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
  if (!values.consensus || !values['backup-dir']) throw Error('--consensus and --backup-dir are required');
  const result = await applyWholeConstrual({ url: values.url!, consensus: JSON.parse(readFileSync(values.consensus, 'utf8')), backupDir: values['backup-dir'], stateFile: values['state-file'], dryRun: values['dry-run'] });
  const conflict = 'conflict' in result && result.conflict;
  console.log(JSON.stringify(conflict ? result : { ...result, plan: { ...result.plan, changed: undefined, kept: undefined } }, null, 2));
  if (conflict) process.exitCode = 3;
}
