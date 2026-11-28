// Applies the independent part construal AI proposal (part-construal-468.json,
// schemaVersion tangram_independent_part_construal_v1) to the running orientation review page
// (docs/review/orientation-app, default http://127.0.0.1:5498).
//
// Only the independent part layer is written, region by region. An entry that is still empty or an
// unreviewed AI proposal is replaced by the proposal; an entry the researcher confirmed or edited is
// kept. The whole construal, the part roles, notes, row statuses, the confirmed partition, the
// geometry and the current position (currentId) are sent back exactly as they were read. The state
// and the export are backed up first. A stale revision is never overwritten: the latest state is
// reloaded, what changed since the read is reported, and nothing is written. Nothing is written
// either when no entry would change.
//
//   node docs/review/part-construal-20261128/apply-part-construal-to-review.ts \
//     --part-construal <part-construal-468.json> --backup-dir <new private directory> \
//     [--state-file <review-state.json>] [--url <review URL>] [--dry-run]
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

export type Candidate = { noun: string; owner: string; basis: string; confidence: string; evidence: string; weaknesses: string };
export type Entry = { id: string; reviewStatus: string; candidates: Candidate[]; noCandidate: boolean; noCandidateReason: string; ai: { agreementStatus: string; discussion: string } | null };
export type Layer = { schemaVersion: string; rows: { id: string; parts: Entry[] }[] };
export type Row = { id: string; status: string; note: string };
export type State = { schemaVersion: string; sourceSha256: string; revision: number; updatedAt: string; currentId: string; results: Row[]; independentParts: Layer };
export type Template = { id: string; figureId: string; rotation: number; parts: { id: string; members: (string | number)[] }[] };
export type Data = { schemaVersion: string; sourceSha256: string; catalogRevision: string; templates: Template[]; independentPart: { schemaVersion: string; maxCandidates: number; confidences: string[]; bases: string[] } };
export type ProposalCandidate = { rank: number; noun: string; owner?: string; basis: string; confidence: string; evidence: string; weaknesses?: string };
export type ProposalEntry = { id: string; figureId: string; rotation: number; regionId: string; members: (string | number)[]; candidates: ProposalCandidate[]; noCandidate: boolean; noCandidateReason?: string; agreementStatus: string; discussion?: string };
export type Proposal = { schemaVersion: string; catalogRevision: string; entries: ProposalEntry[] };
export type Kind = 'added' | 'updated' | 'unchanged' | 'keptConfirmed' | 'keptEdited';

const SCHEMA = 'tangram_orientation_review_v1';
const PROPOSAL_SCHEMA = 'tangram_independent_part_construal_v1';
const AGREEMENTS = ['合意', '一部合意', '未合意'];

function text(v: unknown, max: number, what: string): string {
  if (typeof v !== 'string' || v.length > max) throw Error(what + ': text of at most ' + max + ' characters required');
  return v;
}
const optional = (v: unknown, max: number, what: string) => v === undefined ? '' : text(v, max, what);

// Checks the whole proposal against the catalog the review page serves, and returns the entries in the
// shape the page stores (an unreviewed AI proposal), keyed "<figure>@<rotation>#<region>".
export function validateProposal(proposal: Proposal, data: Data): Map<string, Entry> {
  if (proposal?.schemaVersion !== PROPOSAL_SCHEMA) throw Error('unexpected proposal schemaVersion: ' + proposal?.schemaVersion);
  if (proposal.catalogRevision !== data.catalogRevision) throw Error('proposal catalogRevision ' + proposal.catalogRevision + ' differs from the review page (' + data.catalogRevision + ')');
  if (!Array.isArray(proposal.entries)) throw Error('proposal has no entries');
  const given = new Map<string, ProposalEntry>();
  for (const e of proposal.entries) { if (given.has(e.id)) throw Error('duplicate proposal entry ' + e.id); given.set(e.id, e); }
  const { maxCandidates, confidences, bases } = data.independentPart;
  const result = new Map<string, Entry>();
  for (const t of data.templates) for (const p of t.parts) {
    const key = t.id + '#' + p.id, e = given.get(key);
    if (!e) throw Error('missing proposal entry ' + key);
    if (e.figureId !== t.figureId || e.rotation !== t.rotation || e.regionId !== p.id) throw Error(key + ': figureId, rotation or regionId differ from the catalog');
    const members = (m: unknown) => Array.isArray(m) ? m.map(String).sort().join('+') : null;
    if (members(e.members) !== members(p.members)) throw Error(key + ': members differ from the catalog');
    if (!Array.isArray(e.candidates) || e.candidates.length > maxCandidates) throw Error(key + ': 0-' + maxCandidates + ' candidates required');
    const candidates = e.candidates.map((c, i): Candidate => {
      if (c.rank !== i + 1) throw Error(key + ': candidate ranks must be 1..n in order');
      const noun = text(c.noun, 40, key + ' noun'), evidence = text(c.evidence, 1000, key + ' evidence');
      if (!noun.trim() || !evidence.trim()) throw Error(key + ': noun and evidence are required');
      if (!bases.includes(c.basis)) throw Error(key + ': bad basis ' + c.basis);
      if (!confidences.includes(c.confidence)) throw Error(key + ': bad confidence ' + c.confidence);
      return { noun, owner: optional(c.owner, 40, key + ' owner'), basis: c.basis, confidence: c.confidence, evidence, weaknesses: optional(c.weaknesses, 1000, key + ' weaknesses') };
    });
    if (e.noCandidate !== (candidates.length === 0)) throw Error(key + ': noCandidate must match an empty candidate list');
    const reason = optional(e.noCandidateReason, 1000, key + ' noCandidateReason');
    if (e.noCandidate && !reason.trim()) throw Error(key + ': noCandidateReason required');
    if (!AGREEMENTS.includes(e.agreementStatus)) throw Error(key + ': bad agreementStatus ' + e.agreementStatus);
    if (e.agreementStatus === '未合意' && !e.noCandidate) throw Error(key + ': 未合意 cannot carry adopted candidates');
    result.set(key, { id: p.id, reviewStatus: 'ai_unreviewed', candidates, noCandidate: e.noCandidate, noCandidateReason: e.noCandidate ? reason : '', ai: { agreementStatus: e.agreementStatus, discussion: optional(e.discussion, 4000, key + ' discussion') } });
  }
  if (given.size !== result.size) throw Error('proposal has entries outside the catalog');
  return result;
}

const isBlank = (e: Entry) => e.ai === null && e.reviewStatus === 'ai_unreviewed' && e.candidates.length === 0 && !e.noCandidate && e.noCandidateReason === '';
export function classify(current: Entry, proposed: Entry): Kind {
  if (current.reviewStatus === 'researcher_confirmed') return 'keptConfirmed';
  if (current.reviewStatus === 'researcher_edited') return 'keptEdited';
  if (isDeepStrictEqual(current, proposed)) return 'unchanged';
  return isBlank(current) ? 'added' : 'updated';
}

export type ApplyOptions = { url: string; proposal: Proposal; backupDir: string; stateFile?: string; dryRun?: boolean; beforePost?: () => Promise<void> };
export async function applyPartConstrual(o: ApplyOptions) {
  const get = async (path: string) => { const r = await fetch(o.url + path, { cache: 'no-store' }); if (!r.ok) throw Error('GET ' + path + ': ' + r.status); return r; };
  const data = await (await get('/api/data')).json() as Data;
  const state = await (await get('/api/state')).json() as State;
  if (data.schemaVersion !== SCHEMA || state.schemaVersion !== SCHEMA || state.sourceSha256 !== data.sourceSha256) throw Error('review data and state do not match this tool');
  if (!data.independentPart || !state.independentParts || state.independentParts.schemaVersion !== data.independentPart.schemaVersion) throw Error('the review server does not have the independent part layer (older code)');
  if (data.templates.length !== 120 || state.results.length !== 120 || state.results.some((r, i) => r.id !== data.templates[i].id) || state.independentParts.rows.some((r, i) => r.id !== data.templates[i].id)) throw Error('expected the 120 orientations in catalog order');
  const proposed = validateProposal(o.proposal, data);
  if (existsSync(o.backupDir)) throw Error('backup directory already exists: ' + o.backupDir);
  mkdirSync(o.backupDir, { recursive: true, mode: 0o700 });
  const save = (name: string, content: string) => writeFileSync(join(o.backupDir, name), content, { mode: 0o600 });
  save('state-before.json', JSON.stringify(state, null, 2) + '\n');
  save('export-before.json', await (await get('/api/export')).text());
  if (o.stateFile) copyFileSync(o.stateFile, join(o.backupDir, 'review-state-file-before.json'));

  const kinds: Record<Kind, string[]> = { added: [], updated: [], unchanged: [], keptConfirmed: [], keptEdited: [] };
  const rows = state.independentParts.rows.map(row => ({ id: row.id, parts: row.parts.map(current => {
    const key = row.id + '#' + current.id, next = proposed.get(key)!, kind = classify(current, next);
    kinds[kind].push(key);
    return kind === 'added' || kind === 'updated' ? next : current;
  }) }));
  state.independentParts.rows.forEach((row, i) => row.parts.forEach((p, k) => {
    const kept = kinds.keptConfirmed.includes(row.id + '#' + p.id) || kinds.keptEdited.includes(row.id + '#' + p.id);
    if (kept && !isDeepStrictEqual(rows[i].parts[k], p)) throw Error('invariant broken: a reviewed entry would change: ' + row.id + '#' + p.id);
  }));
  const plan = { revision: state.revision, updatedAt: state.updatedAt, currentId: state.currentId, counts: Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, v.length])) as Record<Kind, number>, changed: { added: kinds.added, updated: kinds.updated }, kept: { keptConfirmed: kinds.keptConfirmed, keptEdited: kinds.keptEdited } };
  save('plan.json', JSON.stringify(plan, null, 2) + '\n');
  if (o.dryRun) return { dryRun: true as const, plan };
  if (!kinds.added.length && !kinds.updated.length) return { noChange: true as const, plan };
  if (o.beforePost) await o.beforePost();
  const body = { revision: state.revision, sourceSha256: data.sourceSha256, currentId: state.currentId, results: state.results, independentParts: { schemaVersion: state.independentParts.schemaVersion, rows } };
  const response = await fetch(o.url + '/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (response.status === 409) {
    const latest = await (await get('/api/state')).json() as State;
    const conflict = {
      conflict: true as const, readRevision: state.revision, latestRevision: latest.revision, latestUpdatedAt: latest.updatedAt,
      currentIdChanged: latest.currentId !== state.currentId,
      rowsChangedSinceRead: latest.results.filter((r, i) => !isDeepStrictEqual(r, state.results[i])).map(r => r.id),
      entriesChangedSinceRead: latest.independentParts.rows.flatMap((row, i) => row.parts.filter((p, k) => !isDeepStrictEqual(p, state.independentParts.rows[i].parts[k])).map(p => row.id + '#' + p.id)),
    };
    save('conflict.json', JSON.stringify(conflict, null, 2) + '\n');
    return { ...conflict, plan };
  }
  if (!response.ok) throw Error('update rejected: ' + response.status + ' ' + await response.text());
  const saved = await response.json() as State;
  if (saved.revision !== state.revision + 1 || saved.currentId !== state.currentId || !isDeepStrictEqual(saved.results, state.results) || !isDeepStrictEqual(saved.independentParts.rows, rows)) throw Error('saved state differs from the planned update');
  save('state-after.json', JSON.stringify(saved, null, 2) + '\n');
  save('export-after.json', await (await get('/api/export')).text());
  return { conflict: false as const, revision: saved.revision, currentId: saved.currentId, plan };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { url: { type: 'string', default: 'http://127.0.0.1:5498' }, 'part-construal': { type: 'string' }, 'backup-dir': { type: 'string' }, 'state-file': { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
  if (!values['part-construal'] || !values['backup-dir']) throw Error('--part-construal and --backup-dir are required');
  const result = await applyPartConstrual({ url: values.url!, proposal: JSON.parse(readFileSync(values['part-construal'], 'utf8')), backupDir: values['backup-dir'], stateFile: values['state-file'], dryRun: values['dry-run'] });
  const conflict = 'conflict' in result && result.conflict;
  console.log(JSON.stringify(conflict ? result : { ...result, plan: { ...result.plan, changed: undefined, kept: undefined } }, null, 2));
  if (conflict) process.exitCode = 3;
}
