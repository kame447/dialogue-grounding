// Integrates the four Opus x Terra pair results for independent part construals
// (part-construal-v1/opus-{a,b,c,d}/paired-part-consensus.json) into one 468-region file,
// checks every entry against the confirmed catalog region IDs and members, and copies the
// independent observation logs next to it with their hashes.
//
//   node docs/review/part-construal-20261128/integrate-part-consensus.ts --run <part-construal-v1 dir> --out <output dir> [--catalog <primary-regions-data.ts>]
//
// The catalog geometry is read only for region IDs and members; the partition is never changed.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

type Candidate = { rank: number; noun: string; owner?: string; basis: string; confidence: string; evidence: string; weaknesses?: string };
type PairRegion = { id: string; opusIndependent: unknown; terraIndependent: unknown; consensusCandidates: Candidate[]; noCandidate: boolean;
  noCandidateReason: string; agreementStatus: string; discussion: unknown };
type PairItem = { item: string; regions: PairRegion[] };
type Template = { figureId: string; rotation: number; regions: { id: string; members: string[] }[] };

const { values } = parseArgs({ options: { run: { type: 'string' }, out: { type: 'string' }, catalog: { type: 'string' } } });
if (!values.run || !values.out) throw Error('--run and --out are required');
const run = values.run, out = values.out;
const catalogPath = resolve(values.catalog ?? new URL('../../../dialogue-model/runtime/stimuli/primary-regions-data.ts', import.meta.url).pathname);
const catalog = await import(pathToFileURL(catalogPath).href) as { PRIMARY_REGION_TEMPLATES: unknown; PRIMARY_REGION_CATALOG_REVISION: string };
const templates = catalog.PRIMARY_REGION_TEMPLATES as Template[];
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const text = (v: unknown) => typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v);

const GROUPS = [
  { group: 'a', opus: 'NobleMendel', terra: 'PolarFeynman' }, { group: 'b', opus: 'AstuteOstwald', terra: 'CherryHopper' },
  { group: 'c', opus: 'DewyLinnaeus', terra: 'SunnyBell' }, { group: 'd', opus: 'BreezyCopernicus', terra: 'HardyGuericke' },
];
const STATUSES = ['合意', '一部合意', '未合意'];
const CONFIDENCE = ['高', '中', '低'];
const BASIS = ['単独', '全体との関係', '両方'];
// Words that only restate shape or position, or are superordinate; a part construal must name a concrete part.
const VAGUE = new Set(['部分', '突起', '出っ張り', '角', '端', '先', '先端', '三角形', '三角', '四角', '四角形', '正方形', '長方形', '台形',
  '平行四辺形', '五角形', '六角形', '体', 'からだ', 'パーツ', '部品', '塊', '図形', 'もの', '物', '飾り']);

const regionsOf = new Map(templates.map(t => [`${t.figureId}@${t.rotation}`, t.regions]));
const order = [...regionsOf.keys()];
// Region identity across the four orientations of one figure: the same ID must carry the same members.
const membersById = new Map<string, string>();
const identityProblems: string[] = [];
for (const t of templates) for (const r of t.regions) {
  const key = `${t.figureId}#${r.id}`, members = [...r.members].sort().join(',');
  if (!membersById.has(key)) membersById.set(key, members);
  else if (membersById.get(key) !== members) identityProblems.push(`${t.figureId}@${t.rotation} ${r.id}: members ${members} differ from another orientation (${membersById.get(key)})`);
}

const problems: string[] = [], warnings: string[] = [];
function checkCandidate(c: Candidate, where: string) {
  if (![c.noun, c.evidence].every(s => typeof s === 'string' && s.trim())) problems.push(`${where}: noun/evidence missing`);
  if (!CONFIDENCE.includes(c.confidence)) problems.push(`${where}: confidence must be 高/中/低`);
  if (!BASIS.includes(c.basis)) problems.push(`${where}: basis must be 単独/全体との関係/両方`);
  if (typeof c.noun === 'string' && VAGUE.has(c.noun.trim())) problems.push(`${where}: vague noun "${c.noun}"`);
  if (typeof c.noun === 'string' && /[・／/]|または|など/.test(c.noun)) warnings.push(`${where}: noun may combine several names "${c.noun}"`);
}

const entries: Record<string, unknown>[] = [];
const logs: Record<string, string> = {};
mkdirSync(join(out, 'logs'), { recursive: true });
function copyLog(from: string, name: string) {
  if (!existsSync(from)) return false;
  copyFileSync(from, join(out, 'logs', name));
  logs[name] = sha(from);
  return true;
}
const mapping = read(join(run, 'parent', 'terra-mapping.json')) as Record<string, Record<string, string>>;
for (const g of GROUPS) {
  const opusDir = join(run, `opus-${g.group}`), terraDir = join(run, `terra-${g.group}`), map = mapping[`terra-${g.group}`];
  const raw = read(join(opusDir, 'paired-part-consensus.json'));
  const items = (Array.isArray(raw) ? raw : raw.items) as PairItem[];
  if (!Array.isArray(items) || items.length !== 30) { problems.push(`group ${g.group}: 30 items required`); continue; }
  items.forEach((x, i) => {
    const expected = 'item-' + String(i + 1).padStart(2, '0'), id = map[x.item];
    if (x.item !== expected || !id) { problems.push(`group ${g.group}: item order/id mismatch at ${i + 1}`); return; }
    const catalogRegions = regionsOf.get(id);
    if (!catalogRegions) { problems.push(`${g.group}/${x.item}: ${id} not in catalog`); return; }
    const got = (x.regions ?? []).map(r => r.id);
    if (got.join(',') !== catalogRegions.map(r => r.id).join(',')) { problems.push(`${g.group}/${x.item}(${id}): regions ${got.join(',')} must be ${catalogRegions.map(r => r.id).join(',')}`); return; }
    for (const r of x.regions) {
      const where = `${g.group}/${x.item}(${id})#${r.id}`;
      const candidates = Array.isArray(r.consensusCandidates) ? r.consensusCandidates : [];
      if (!STATUSES.includes(r.agreementStatus)) problems.push(`${where}: agreementStatus`);
      if (candidates.length > 3) problems.push(`${where}: more than 3 candidates`);
      if (r.noCandidate !== (candidates.length === 0)) problems.push(`${where}: noCandidate must match an empty candidate list`);
      if (r.noCandidate && !text(r.noCandidateReason).trim()) problems.push(`${where}: noCandidateReason missing`);
      if (r.agreementStatus === '未合意' && candidates.length) problems.push(`${where}: 未合意 must not carry adopted candidates`);
      if (!text(r.discussion).trim()) problems.push(`${where}: discussion missing`);
      candidates.forEach((c, k) => checkCandidate(c, `${where} candidate ${k + 1}`));
      const [figureId, rotation] = id.split('@');
      entries.push({
        id: `${id}#${r.id}`, figureId, rotation: Number(rotation), regionId: r.id,
        members: catalogRegions.find(c => c.id === r.id)!.members,
        candidates: candidates.map((c, k) => ({ rank: k + 1, noun: c.noun, ...(c.owner ? { owner: c.owner } : {}), basis: c.basis,
          confidence: c.confidence, evidence: c.evidence, weaknesses: c.weaknesses ?? '' })),
        noCandidate: r.noCandidate, noCandidateReason: text(r.noCandidateReason), agreementStatus: r.agreementStatus,
        group: g.group, item: x.item, opusAgent: g.opus, terraAgent: g.terra,
        opusIndependent: r.opusIndependent, terraIndependent: r.terraIndependent, discussion: r.discussion,
      });
    }
  });
  copyLog(join(opusDir, 'round1-parts.json'), `opus-${g.group}-round1-parts.json`);
  copyLog(join(opusDir, 'round2-request.md'), `opus-${g.group}-round2-request.md`);
  copyLog(join(opusDir, 'paired-part-consensus.json'), `pair-${g.group}-paired-part-consensus.json`);
  copyLog(join(terraDir, 'round1-parts.json'), `terra-${g.group}-round1-parts.json`);
  copyLog(join(terraDir, 'round2-crossreview-parts.json'), `terra-${g.group}-round2-crossreview-parts.json`);
}
copyLog(join(run, 'parent', 'terra-mapping.json'), 'mapping.json');
copyLog(join(run, 'parent', 'sha256-round1.log'), 'sha256-round1.log');

const expectedIds = order.flatMap(id => regionsOf.get(id)!.map(r => `${id}#${r.id}`));
const seen = new Set(entries.map(e => e.id as string));
for (const id of expectedIds) if (!seen.has(id)) problems.push(`missing region ${id}`);
if (seen.size !== entries.length) problems.push('duplicate region');
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
entries.sort((a, b) => expectedIds.indexOf(a.id as string) - expectedIds.indexOf(b.id as string));

const counts = Object.fromEntries(STATUSES.map(s => [s, entries.filter(e => e.agreementStatus === s).length]));
const withCandidates = entries.filter(e => !e.noCandidate);
const summary = { regions: entries.length, orientations: order.length, agreement: counts, withCandidates: withCandidates.length,
  noCandidate: entries.length - withCandidates.length, candidates: entries.reduce((n, e) => n + (e.candidates as unknown[]).length, 0),
  regionIdentityAcrossRotations: identityProblems.length ? identityProblems : 'ok' };
writeFileSync(join(out, 'part-construal-468.json'), JSON.stringify({
  schemaVersion: 'tangram_independent_part_construal_v1', catalogRevision: catalog.PRIMARY_REGION_CATALOG_REVISION,
  status: 'AIの合議による独立部分の見立て案。研究者の確認前で、正解名称ではない。全体の見立てとは別に、各領域を単独・全体との関係から見た部分の見立て。分割・形・面積・接続は確定済みの catalog のまま。',
  summary, warnings, entries,
}, null, 2) + '\n');

const md: string[] = ['# 独立部分の見立て 合議案（120方向・468領域）', '',
  'AI（Claude Opus 5.5 と GPT-6.1 Terra）の独立観察を照合した合議案。全体の見立てとは別に、各領域を単独・全体との関係から見た部分の見立て。研究者の確認前で、正解名称ではない。生成手順と検証は README.md を参照。', '',
  `合意 ${counts['合意']}・一部合意 ${counts['一部合意']}・未合意 ${counts['未合意']}。候補あり ${summary.withCandidates} 領域・候補なし ${summary.noCandidate} 領域（候補 ${summary.candidates} 件）。`, ''];
let current = '';
for (const e of entries as any[]) {
  const orientation = `${e.figureId}@${e.rotation}`;
  if (e.rotation === 0 && e.regionId === 'P1') md.push(`## ${e.figureId}`, '');
  if (orientation !== current) { md.push(`- **${orientation}**（${e.group}/${e.item}）`); current = orientation; }
  if (e.noCandidate) { md.push(`  - ${e.regionId}：候補なし${e.agreementStatus === '未合意' ? '（未合意）' : ''}。${e.noCandidateReason}`); continue; }
  md.push(`  - ${e.regionId}（${e.agreementStatus}）：` + e.candidates.map((c: Candidate) =>
    `${c.noun}${c.owner ? `（${c.owner}）` : ''}・${c.basis}・確信度${c.confidence} — ${c.evidence}${c.weaknesses ? `（弱点：${c.weaknesses}）` : ''}`).join(' ／ '));
}
writeFileSync(join(out, 'part-construal-468.md'), md.join('\n') + '\n');
writeFileSync(join(out, 'logs', 'sha256.json'), JSON.stringify(logs, null, 2) + '\n');
console.log(JSON.stringify({ summary, warnings: warnings.length, logs: Object.keys(logs).length }, null, 2));
if (warnings.length) console.error(warnings.join('\n'));
