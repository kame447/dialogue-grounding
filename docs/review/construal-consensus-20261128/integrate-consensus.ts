// Integrates the four Opus x Terra pair results (paired-review-v1/opus-{a,b,c,d}/paired-consensus.json)
// into one 120-orientation consensus, checks every entry against the confirmed catalog part IDs,
// and copies the independent observation logs next to it with their hashes.
//
//   node docs/review/construal-consensus-20261128/integrate-consensus.ts --run <private run dir> --out <output dir> [--qa <qa.json>]
//
// The catalog geometry is read only for part IDs; the partition is never changed.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { PRIMARY_REGION_TEMPLATES, PRIMARY_REGION_CATALOG_REVISION } from '../../../dialogue-model/runtime/stimuli/primary-regions-data.ts';

type PartRole = { id: string; role: string; evidence: string };
type Candidate = { rank: number; noun: string; posture: string; direction: string; confidence: string; parts: PartRole[]; evidence: string; weaknesses?: string };
type PairItem = { item: string; opusSource: string; opusIndependent: unknown; terraIndependent: unknown; consensusCandidates: Candidate[]; noConstrual: boolean; noConstrualReason: string; agreementStatus: string; discussion: unknown; uncertainty?: string };
type Qa = Record<string, { result: string; note: string }>;

const { values } = parseArgs({ options: { run: { type: 'string' }, out: { type: 'string' }, qa: { type: 'string' } } });
if (!values.run || !values.out) throw Error('--run and --out are required');
const run = values.run, out = values.out, review = join(run, 'paired-review-v1');
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const STATUSES = ['合意', '一部合意', '未合意'];
const CONFIDENCE = ['高', '中', '低'];
// Broad categories that do not name a concrete kind. 人 is a single kind (like 犬) and is allowed
// when the candidate states the posture.
const VAGUE = new Set(['動物', '鳥', '魚', '虫', '道具', '乗り物', '建物', '塊', '図形', '生き物', '物', 'もの', '容器', '家具', '楽器', '植物', '花', '木', '記号', '模様']);
const partIds = new Map((PRIMARY_REGION_TEMPLATES as unknown as { figureId: string; rotation: number; regions: { id: string }[] }[]).map(t => [t.figureId + '@' + t.rotation, t.regions.map(r => r.id)]));
const order = [...partIds.keys()];
const assignment = read(join(review, 'assignment.json')) as { groups: { group: string; agent: string; terraPeer: string; directory: string; reuseCount: number; pendingCount: number }[] };
const qa: Qa = values.qa ? read(values.qa) : {};

const problems: string[] = [], warnings: string[] = [];
const text = (v: unknown) => typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v);
function checkCandidate(id: string, c: Candidate, where: string) {
  const ids = partIds.get(id)!;
  if (![c.noun, c.posture, c.direction, c.evidence].every(s => typeof s === 'string' && s.trim())) problems.push(`${where}: candidate text missing`);
  if (!CONFIDENCE.includes(c.confidence)) problems.push(`${where}: confidence must be 高/中/低`);
  if (!Array.isArray(c.parts) || [...c.parts.map(p => p.id)].sort().join(',') !== [...ids].sort().join(',')) problems.push(`${where}: parts must cover ${ids.join(',')}`);
  else if (c.parts.some(p => !text(p.role).trim() || !text(p.evidence).trim())) problems.push(`${where}: part role/evidence missing`);
  if (VAGUE.has(c.noun.trim())) problems.push(`${where}: vague category noun "${c.noun}"`);
  if (/[・／/]|または|など/.test(c.noun)) warnings.push(`${where}: noun may combine several names "${c.noun}"`);
}

const orientations: Record<string, unknown>[] = [];
const logs: Record<string, string> = {};
mkdirSync(join(out, 'logs'), { recursive: true });
function copyLog(from: string, name: string) {
  if (!existsSync(from)) return false;
  copyFileSync(from, join(out, 'logs', name));
  logs[name] = createHash('sha256').update(readFileSync(from)).digest('hex');
  return true;
}
for (const g of assignment.groups) {
  const dir = g.directory, mapping = read(join(dir, 'mapping.json')) as Record<string, string>;
  const raw = read(join(dir, 'paired-consensus.json'));
  const items = (Array.isArray(raw) ? raw : raw.items) as PairItem[];
  if (!Array.isArray(items) || items.length !== 30) { problems.push(`group ${g.group}: 30 items required`); continue; }
  items.forEach((x, i) => {
    const expected = 'item-' + String(i + 1).padStart(2, '0'), id = mapping[x.item], where = `${g.group}/${x.item}(${id})`;
    if (x.item !== expected || !id) { problems.push(`group ${g.group}: item order/id mismatch at ${i + 1}`); return; }
    if (!STATUSES.includes(x.agreementStatus)) problems.push(`${where}: agreementStatus`);
    if (!['parent', 'reviewer'].includes(x.opusSource)) problems.push(`${where}: opusSource`);
    const candidates = Array.isArray(x.consensusCandidates) ? x.consensusCandidates : [];
    if (candidates.length > 3) problems.push(`${where}: more than 3 candidates`);
    if (x.noConstrual !== (candidates.length === 0)) problems.push(`${where}: noConstrual must match an empty candidate list`);
    if (x.noConstrual && !text(x.noConstrualReason).trim()) problems.push(`${where}: noConstrualReason missing`);
    if (x.agreementStatus === '未合意' && candidates.length) problems.push(`${where}: 未合意 must not carry adopted candidates`);
    if (!text(x.discussion).trim()) problems.push(`${where}: discussion missing`);
    candidates.forEach((c, k) => checkCandidate(id, c, `${where} candidate ${k + 1}`));
    const [figureId, rotation] = id.split('@');
    const ids = partIds.get(id)!;
    orientations.push({
      id, figureId, rotation: Number(rotation), group: g.group, item: x.item, opusAgent: x.opusSource === 'parent' ? 'CherryCurie' : g.agent, terraAgent: g.terraPeer,
      agreementStatus: x.agreementStatus, noConstrual: x.noConstrual, noConstrualReason: text(x.noConstrualReason),
      candidates: candidates.map((c, k) => ({ ...c, rank: k + 1, parts: ids.map(pid => c.parts.find(p => p.id === pid)!).filter(Boolean) })),
      ...(x.uncertainty ? { uncertainty: x.uncertainty } : {}),
      discussion: x.discussion, opusSource: x.opusSource, opusIndependent: x.opusIndependent, terraIndependent: x.terraIndependent,
      ...(qa[id] ? { qa: qa[id] } : {}),
    });
  });
  copyLog(join(dir, 'TASK.md'), `opus-${g.group}-task.md`);
  copyLog(join(dir, 'mapping.json'), `mapping-${g.group}.json`);
  copyLog(join(dir, 'round1-independent.json'), `opus-${g.group}-round1-independent.json`);
  copyLog(join(dir, 'completed-parent-observations.json'), `opus-${g.group}-reused-parent-observations.json`);
  copyLog(join(dir, 'paired-consensus.json'), `pair-${g.group}-paired-consensus.json`);
  for (const name of readdirSync(dir).filter(n => /^round2-.*\.md$/.test(n)).sort()) copyLog(join(dir, name), `opus-${g.group}-${name}`);
  copyLog(join(run, 'images-v1', 'terra-' + g.group, 'round1-observations.json'), `terra-${g.group}-round1-observations.json`);
  copyLog(join(run, 'images-v1', 'terra-' + g.group, 'round2-crossreview.json'), `terra-${g.group}-round2-crossreview.json`);
}
copyLog(join(review, 'assignment.json'), 'assignment.json');
copyLog(join(run, 'opus-round1.jsonl'), 'opus-parent-round1.jsonl');
copyLog(join(run, 'images-v1', 'opus', 'mapping.json'), 'opus-parent-sheet-mapping.json');
copyLog(join(run, 'terra-task-round1.md'), 'terra-task-round1.md');
copyLog(join(run, 'images-v1', 'manifest.json'), 'observation-images-manifest.json');

const seen = new Set(orientations.map(o => o.id as string));
for (const id of order) if (!seen.has(id)) problems.push(`missing orientation ${id}`);
if (seen.size !== orientations.length) problems.push('duplicate orientation');
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
orientations.sort((a, b) => order.indexOf(a.id as string) - order.indexOf(b.id as string));

const counts = (key: string) => Object.fromEntries(STATUSES.map(s => [s, orientations.filter(o => o[key] === s).length]));
const summary = { orientations: orientations.length, agreement: counts('agreementStatus'), noConstrual: orientations.filter(o => o.noConstrual).length, withCandidates: orientations.filter(o => !o.noConstrual).length, candidates: orientations.reduce((n, o) => n + (o.candidates as unknown[]).length, 0) };
writeFileSync(join(out, 'consensus-120.json'), JSON.stringify({
  schemaVersion: 'tangram_orientation_construal_consensus_v1', catalogRevision: PRIMARY_REGION_CATALOG_REVISION, baseCommit: '4307078',
  status: 'AIの合議による見立て案。研究者の確認前で、正解名称ではない。分割・形・面積・接続は確定済みの catalog のまま。',
  summary, warnings, orientations,
}, null, 2) + '\n');

const md: string[] = ['# 回転別の見立て 合議案（120方向）', '', 'AI（Claude Opus 5.5 と GPT-6.1 Terra）の独立観察を照合した合議案。研究者の確認前で、正解名称ではない。生成手順と検証は README.md を参照。', '',
  `合意 ${summary.agreement['合意']}・一部合意 ${summary.agreement['一部合意']}・未合意 ${summary.agreement['未合意']}、見立てあり ${summary.withCandidates}・見立てなし ${summary.noConstrual}（候補 ${summary.candidates} 件）。`, ''];
for (const o of orientations as any[]) {
  if (o.rotation === 0) md.push(`## ${o.figureId}`, '');
  const head = `- **${o.id}**（${o.group}/${o.item}・${o.agreementStatus}）`;
  if (o.noConstrual) { md.push(`${head} ${o.agreementStatus === '未合意' ? '見立てなし（未合意）' : '見立てなし'}：${o.noConstrualReason}`); continue; }
  md.push(head);
  for (const c of o.candidates) md.push(`  - 候補${c.rank}：${c.noun}（${c.posture}、${c.direction}、確信度${c.confidence}） — ${c.parts.map((p: PartRole) => `${p.id}＝${p.role}`).join('、')}。${c.evidence}${c.weaknesses ? `（弱点：${c.weaknesses}）` : ''}`);
}
writeFileSync(join(out, 'consensus-120.md'), md.join('\n') + '\n');
writeFileSync(join(out, 'logs', 'sha256.json'), JSON.stringify(logs, null, 2) + '\n');
console.log(JSON.stringify({ summary, warnings: warnings.length, logs: Object.keys(logs).length }, null, 2));
if (warnings.length) console.error(warnings.join('\n'));
