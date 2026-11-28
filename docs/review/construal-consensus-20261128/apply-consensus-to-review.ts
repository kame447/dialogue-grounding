// Applies the 120-orientation construal consensus to the running orientation review page
// (docs/review/orientation-app, default http://127.0.0.1:5498).
//
// Only rows that are 未確認, carry no note, and still equal one of the two earlier AI drafts
// (the catalog template, or the concrete second draft written by
// orientation-app/apply-concrete-draft.ts) are replaced. Rows the researcher confirmed,
// marked 要修正 or edited, notes, the geometric part descriptions, the confirmed partition and
// the current position (currentId) are kept. The state and export are backed up first. A stale
// revision is never overwritten: the latest state is reloaded, the rows that changed since the
// read are reported, and nothing is written.
//
//   node docs/review/construal-consensus-20261128/apply-consensus-to-review.ts \
//     --consensus docs/review/construal-consensus-20261128/consensus-120.json \
//     --drafts docs/review/orientation-app/concrete-construal-draft.json \
//     --backup-dir <new private directory> [--state-file <review-state.json>] [--url <review URL>] [--dry-run]
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

export type Part = { id: string; description: string; candidates: string[] };
export type Row = { id: string; status: string; whole: string; wholeBasis: string[]; note: string; parts: Part[] };
export type State = { schemaVersion: string; sourceSha256: string; revision: number; updatedAt: string; currentId: string; results: Row[] };
export type Template = { id: string; parts: { id: string; description: string; candidates: string[] }[]; whole: { construal: string; basis: string[] } };
export type Data = { schemaVersion: string; sourceSha256: string; catalogRevision: string; templates: Template[] };
export type Draft = { first: string; second: string; roles: string[] };
export type Candidate = { rank: number; noun: string; posture: string; direction: string; confidence: string; parts: { id: string; role: string; evidence: string }[]; evidence: string; weaknesses?: string };
export type Entry = { id: string; agreementStatus: '合意' | '一部合意' | '未合意'; noConstrual: boolean; noConstrualReason: string; candidates: Candidate[]; uncertainty?: string };
export type Kind = 'reviewed' | 'edited' | 'template' | 'concreteDraft';
type Content = Pick<Row, 'whole' | 'wholeBasis' | 'parts'>;

const SCHEMA = 'tangram_orientation_review_v1';
const STATUSES = ['合意', '一部合意', '未合意'];
const FOOTER = '形からの仮説で、正解名称ではない。';
const oneLine = (s: string) => s.replace(/\s*\r?\n\s*/g, ' ').trim();
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
export function sameContent(a: Content, b: Content) {
  return a.whole === b.whole && sameList(a.wholeBasis, b.wholeBasis) && a.parts.length === b.parts.length
    && a.parts.every((p, i) => p.id === b.parts[i].id && p.description === b.parts[i].description && sameList(p.candidates, b.parts[i].candidates));
}
const sameRow = (a: Row, b: Row) => a.id === b.id && a.status === b.status && a.note === b.note && sameContent(a, b);

export function templateContent(t: Template): Content {
  return { whole: t.whole.construal, wholeBasis: [...t.whole.basis], parts: t.parts.map(p => ({ id: p.id, description: p.description, candidates: [...p.candidates] })) };
}
// The same transformation as orientation-app/apply-concrete-draft.ts applies to an untouched row.
export function concreteDraftContent(t: Template, d: Draft): Content {
  return {
    whole: '候補1：' + d.first + '\n候補2：' + d.second,
    wholeBasis: [d.first + 'として見た場合：' + d.roles.map((role, i) => t.parts[i].id + '＝' + role).join('、') + '。', '候補2は別の見立て。どちらも形からの仮説で、正解名称ではない。'],
    parts: t.parts.map((p, i) => ({ id: p.id, description: p.description, candidates: [d.roles[i] + '（' + d.first + 'として見た場合）', ...p.candidates.filter(s => !/[や]|または|角張った塊|細長い板|尖った突起|四角い出っ張り/.test(s) && s !== d.roles[i])].slice(0, 3) })),
  };
}
export function classify(row: Row, t: Template, d: Draft | undefined): Kind {
  if (row.status !== '未確認') return 'reviewed';
  if (row.note !== '') return 'edited';
  if (sameContent(row, templateContent(t))) return 'template';
  if (d && d.roles.length === t.parts.length && sameContent(row, concreteDraftContent(t, d))) return 'concreteDraft';
  return 'edited';
}

export function validateEntries(entries: Entry[], templates: Template[]) {
  const byId = new Map<string, Entry>();
  for (const e of entries) { if (byId.has(e.id)) throw Error('duplicate consensus entry ' + e.id); byId.set(e.id, e); }
  for (const t of templates) {
    const e = byId.get(t.id);
    if (!e) throw Error('missing consensus entry ' + t.id);
    if (!STATUSES.includes(e.agreementStatus)) throw Error(t.id + ': bad agreementStatus');
    if (!Array.isArray(e.candidates) || e.candidates.length > 3) throw Error(t.id + ': 0-3 candidates required');
    if (e.noConstrual !== (e.candidates.length === 0)) throw Error(t.id + ': noConstrual must match an empty candidate list');
    if (e.noConstrual && !e.noConstrualReason.trim()) throw Error(t.id + ': noConstrualReason required');
    if (e.agreementStatus === '未合意' && !e.noConstrual) throw Error(t.id + ': 未合意 cannot carry adopted candidates');
    const ids = t.parts.map(p => p.id).join(',');
    for (const c of e.candidates) {
      if (![c.noun, c.posture, c.direction, c.evidence].every(s => typeof s === 'string' && s.trim())) throw Error(t.id + ': candidate text missing');
      if (c.parts.map(p => p.id).join(',') !== ids) throw Error(t.id + ': candidate parts must list ' + ids + ' in order');
      if (c.parts.some(p => !p.role.trim() || !p.evidence.trim())) throw Error(t.id + ': part role and evidence required');
    }
  }
  if (byId.size !== templates.length) throw Error('consensus has entries outside the catalog');
  return byId;
}

export function consensusContent(t: Template, e: Entry): Content {
  const tail = '合議：' + e.agreementStatus + '（Opus と Terra の独立観察を照合）。' + FOOTER;
  if (e.noConstrual) return {
    whole: e.agreementStatus === '未合意' ? '見立てなし（未合意）' : '見立てなし',
    wholeBasis: [oneLine(e.noConstrualReason), ...(e.uncertainty ? ['不確かさ：' + oneLine(e.uncertainty)] : []), tail],
    parts: t.parts.map(p => ({ id: p.id, description: p.description, candidates: [] })),
  };
  return {
    whole: e.candidates.map((c, i) => '候補' + (i + 1) + '：' + oneLine(c.noun) + '（' + oneLine(c.posture) + '、' + oneLine(c.direction) + '）').join('\n'),
    wholeBasis: [
      ...e.candidates.map((c, i) => '候補' + (i + 1) + '：' + c.parts.map(p => p.id + '＝' + oneLine(p.role)).join('、') + '。' + oneLine(c.evidence) + (c.weaknesses && c.weaknesses.trim() ? '（弱点：' + oneLine(c.weaknesses) + '）' : '')),
      ...(e.uncertainty ? ['不確かさ：' + oneLine(e.uncertainty)] : []),
      tail,
    ],
    parts: t.parts.map(p => ({ id: p.id, description: p.description, candidates: e.candidates.map((c, i) => oneLine(c.parts.find(q => q.id === p.id)!.role) + '（候補' + (i + 1) + '：' + oneLine(c.noun) + '）') })),
  };
}

export type ApplyOptions = { url: string; entries: Entry[]; drafts: Record<string, Draft>; backupDir: string; stateFile?: string; dryRun?: boolean; beforePost?: () => Promise<void> };
export async function applyConsensus(o: ApplyOptions) {
  const get = async (path: string) => { const r = await fetch(o.url + path, { cache: 'no-store' }); if (!r.ok) throw Error('GET ' + path + ': ' + r.status); return r; };
  const data = await (await get('/api/data')).json() as Data;
  const state = await (await get('/api/state')).json() as State;
  if (data.schemaVersion !== SCHEMA || state.schemaVersion !== SCHEMA || state.sourceSha256 !== data.sourceSha256) throw Error('review data and state do not match this tool');
  if (data.templates.length !== 120 || state.results.length !== 120 || state.results.some((r, i) => r.id !== data.templates[i].id)) throw Error('expected the 120 orientations in catalog order');
  const entries = validateEntries(o.entries, data.templates);
  if (existsSync(o.backupDir)) throw Error('backup directory already exists: ' + o.backupDir);
  mkdirSync(o.backupDir, { recursive: true, mode: 0o700 });
  const save = (name: string, text: string) => writeFileSync(join(o.backupDir, name), text, { mode: 0o600 });
  save('state-before.json', JSON.stringify(state, null, 2) + '\n');
  save('export-before.json', await (await get('/api/export')).text());
  if (o.stateFile) copyFileSync(o.stateFile, join(o.backupDir, 'review-state-file-before.json'));

  const kinds: Record<Kind, string[]> = { reviewed: [], edited: [], template: [], concreteDraft: [] };
  const results = state.results.map((row, i) => {
    const t = data.templates[i], kind = classify(row, t, o.drafts[row.id]);
    kinds[kind].push(row.id);
    return kind === 'template' || kind === 'concreteDraft' ? { ...row, ...consensusContent(t, entries.get(row.id)!) } : row;
  });
  results.forEach((r, i) => {
    const before = state.results[i];
    if (r.id !== before.id || r.status !== before.status || r.note !== before.note || r.parts.some((p, k) => p.id !== before.parts[k].id || p.description !== before.parts[k].description)) throw Error('invariant broken for ' + r.id);
  });
  const plan = { revision: state.revision, updatedAt: state.updatedAt, currentId: state.currentId, counts: Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, v.length])), kept: { reviewed: kinds.reviewed, edited: kinds.edited }, replaced: { template: kinds.template, concreteDraft: kinds.concreteDraft } };
  save('plan.json', JSON.stringify(plan, null, 2) + '\n');
  if (o.dryRun) return { dryRun: true as const, plan };
  if (o.beforePost) await o.beforePost();
  const response = await fetch(o.url + '/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: state.revision, sourceSha256: data.sourceSha256, currentId: state.currentId, results }) });
  if (response.status === 409) {
    const latest = await (await get('/api/state')).json() as State;
    const conflict = { conflict: true as const, readRevision: state.revision, latestRevision: latest.revision, latestUpdatedAt: latest.updatedAt, currentIdChanged: latest.currentId !== state.currentId, rowsChangedSinceRead: latest.results.filter((r, i) => !sameRow(r, state.results[i])).map(r => r.id) };
    save('conflict.json', JSON.stringify(conflict, null, 2) + '\n');
    return { ...conflict, plan };
  }
  if (!response.ok) throw Error('update rejected: ' + response.status + ' ' + await response.text());
  const saved = await response.json() as State;
  if (saved.revision !== state.revision + 1 || saved.currentId !== state.currentId || saved.results.some((r, i) => !sameRow(r, results[i]))) throw Error('saved state differs from the planned update');
  save('state-after.json', JSON.stringify(saved, null, 2) + '\n');
  save('export-after.json', await (await get('/api/export')).text());
  return { conflict: false as const, revision: saved.revision, currentId: saved.currentId, plan };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { url: { type: 'string', default: 'http://127.0.0.1:5498' }, consensus: { type: 'string' }, drafts: { type: 'string' }, 'backup-dir': { type: 'string' }, 'state-file': { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
  if (!values.consensus || !values.drafts || !values['backup-dir']) throw Error('--consensus, --drafts and --backup-dir are required');
  const consensus = JSON.parse(readFileSync(values.consensus, 'utf8'));
  const result = await applyConsensus({ url: values.url!, entries: consensus.orientations, drafts: JSON.parse(readFileSync(values.drafts, 'utf8')), backupDir: values['backup-dir'], stateFile: values['state-file'], dryRun: values['dry-run'] });
  const conflict = 'conflict' in result && result.conflict;
  console.log(JSON.stringify(conflict ? result : { ...result, plan: { ...result.plan, kept: undefined, replaced: undefined } }, null, 2));
  if (conflict) process.exitCode = 3;
}
