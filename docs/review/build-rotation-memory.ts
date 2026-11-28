// Builds the immutable rotation-memory bundle (dialogue-model/runtime/stimuli/rotation-memory-data.ts).
//
//   node docs/review/build-rotation-memory.ts [--regions <primary-regions-data.ts>] [--whole <consensus-120.json>]
//     [--parts <part-construal-468.json>] [--review <review-results-final.json>] [--out <data module>] [--check]
//
// Inputs (all AI proposals the researcher has not confirmed yet, never answer keys):
//   geometry  primary-regions-data.ts   ONLY the confirmed partition's geometry is read from it (regions, members, shape,
//             area, position, apex, contacts). Its older construal fields (construal, initial, description wording) are
//             never read, so an old proposal cannot reach the bundle.
//   whole     the 120-orientation consensus (adopted `candidates` only; an empty list = no whole construal)
//   parts     the 468-region independent part construals (adopted `candidates` only; 未合意 regions carry none)
// Output: the bundle plus its version, catalog revision, SHA-256 and the SHA-256 of every input. Evidence and weakness
// texts stay in the input files and are not part of the bundle. `--check` regenerates in memory and fails on any difference.
//
// A confirmed export of the review page can replace `whole`/`parts` once it carries structured candidates.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  AbsoluteRotation, Confidence, DirectionWord, PositionWord, RotationMemoryEntry, RotationMemoryPart, RotationMemoryViewRecord, RotationMemoryWhole,
} from '../../dialogue-model/runtime/stimuli/rotation-memory-shape.ts';

export const ROTATION_MEMORY_BUILD_VERSION = 'tangram_rotation_memory_v1';
const ROTATIONS = [0, 90, 180, 270] as const;
// Clockwise from the right on a y-down screen, as the eight-way words of the confirmed catalog are produced.
const CLOCKWISE_WORDS = ['右', '右下', '下', '左下', '左', '左上', '上', '右上'];

const here = fileURLToPath(new URL('.', import.meta.url));
const REPO_PATHS = {
  geometry: 'dialogue-model/runtime/stimuli/primary-regions-data.ts',
  whole: 'docs/review/construal-consensus-20261128/consensus-120.json',
  parts: 'docs/review/part-construal-20261128/part-construal-468.json',
  review: 'docs/review/review-results-final.json',
  out: 'dialogue-model/runtime/stimuli/rotation-memory-data.ts',
} as const;
const DEFAULT_PATHS = {
  geometry: resolve(here, '../../', REPO_PATHS.geometry), whole: resolve(here, '../../', REPO_PATHS.whole),
  parts: resolve(here, '../../', REPO_PATHS.parts), review: resolve(here, '../../', REPO_PATHS.review), out: resolve(here, '../../', REPO_PATHS.out),
};

// ---- Small strict readers (the inputs are research files, not trusted shapes) ----

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneLine = (s: string) => s.replace(/\s*\r?\n\s*/gu, ' ').trim();
const bad = (where: string, what: string): never => { throw new Error(`${where}: ${what}`); };
const str = (v: unknown, where: string): string => typeof v === 'string' && v.trim() ? oneLine(v) : bad(where, 'a non-empty string is required');
const list = (v: unknown, where: string): unknown[] => Array.isArray(v) ? v : bad(where, 'an array is required');
const rec = (v: unknown, where: string): Record<string, unknown> => isRecord(v) ? v : bad(where, 'an object is required');
const num = (v: unknown, where: string): number => typeof v === 'number' && Number.isFinite(v) ? v : bad(where, 'a finite number is required');
const confidence = (v: unknown, where: string): Confidence => v === '高' || v === '中' || v === '低' ? v : bad(where, 'confidence must be 高/中/低');
const rotation = (v: unknown, where: string): AbsoluteRotation => v === 0 || v === 90 || v === 180 || v === 270 ? v : bad(where, 'rotation must be 0/90/180/270');
const regionNumber = (id: string) => Number(id.slice(1));
const figureNumber = (id: string) => Number(id.slice(1));

// ---- Geometry: only the confirmed partition ----

export type GeometryRegion = {
  id: string; members: string[]; shapeName: string; sides: number | null; convex: boolean | null; areaPercent: number;
  centroid: [number, number]; tipDirection: string | null; contacts: string[]; description: string;
};
export type GeometryView = { figureId: string; rotation: AbsoluteRotation; size: [number, number]; regions: GeometryRegion[] };

/** Reads geometry fields explicitly; any older construal field of a template is left unread on purpose. */
export function geometryFromTemplates(templates: unknown): GeometryView[] {
  return list(templates, 'templates').map((raw, i) => {
    const where = `template ${i}`;
    const t = rec(raw, where);
    const size = list(t.size, `${where}.size`).map(n => num(n, `${where}.size`));
    if (size.length !== 2 || size.some(n => n <= 0)) bad(where, 'size must be two positive numbers');
    return {
      figureId: str(t.figureId, `${where}.figureId`), rotation: rotation(t.rotation, `${where}.rotation`), size: [size[0], size[1]],
      regions: list(t.regions, `${where}.regions`).map((rawRegion, k) => {
        const rw = `${where}.regions[${k}]`;
        const r = rec(rawRegion, rw);
        const centroid = list(r.centroid, `${rw}.centroid`).map(n => num(n, `${rw}.centroid`));
        if (centroid.length !== 2) bad(rw, 'centroid must be two numbers');
        return {
          id: str(r.id, `${rw}.id`), members: list(r.members, `${rw}.members`).map(m => str(m, `${rw}.members`)), shapeName: str(r.shapeName, `${rw}.shapeName`),
          sides: r.sides === null ? null : num(r.sides, `${rw}.sides`), convex: r.convex === null ? null : typeof r.convex === 'boolean' ? r.convex : bad(rw, 'convex must be boolean or null'),
          areaPercent: num(r.areaPercent, `${rw}.areaPercent`), centroid: [centroid[0], centroid[1]] as [number, number],
          tipDirection: r.tipDirection === null ? null : str(r.tipDirection, `${rw}.tipDirection`),
          contacts: list(r.contacts, `${rw}.contacts`).map(c => str(rec(c, `${rw}.contacts`).part, `${rw}.contacts.part`)), description: str(r.description, `${rw}.description`),
        };
      }),
    };
  });
}

/** Thirds of the figure's bounding box, the same words the earlier prepared region notes used. */
export function positionWord([x, y]: readonly [number, number], [w, h]: readonly [number, number]): PositionWord {
  const a = x / w < 1 / 3 ? '左' : x / w > 2 / 3 ? '右' : '';
  const b = y / h < 1 / 3 ? '上' : y / h > 2 / 3 ? '下' : '';
  return (a || b ? a + b + '寄り' : '中央付近') as PositionWord;
}

// ---- Whole and part sources ----

export type WholeSourceCandidate = { rank: number; noun: string; posture: string; direction: string; confidence: Confidence; parts: { id: string; role: string }[] };
export type WholeSourceRow = { id: string; agreementStatus: string; noConstrual: boolean; candidates: WholeSourceCandidate[] };
export type PartSourceRow = {
  id: string; members: string[]; agreementStatus: string; noCandidate: boolean;
  candidates: { rank: number; noun: string; owner: string | null; confidence: Confidence }[];
};
export type SourceMeta = { schemaVersion: string; catalogRevision: string; status: string };

export function wholeFromConsensus(document: unknown): { rows: Map<string, WholeSourceRow>; meta: SourceMeta } {
  const doc = rec(document, 'whole');
  if (doc.schemaVersion !== 'tangram_orientation_construal_consensus_v1') bad('whole', 'unsupported schemaVersion');
  const rows = new Map<string, WholeSourceRow>();
  for (const [i, raw] of list(doc.orientations, 'whole.orientations').entries()) {
    const where = `whole.orientations[${i}]`;
    const o = rec(raw, where);
    const id = str(o.id, `${where}.id`);
    if (rows.has(id)) bad(where, `duplicate ${id}`);
    const candidates = list(o.candidates, `${where}.candidates`).map((rawCandidate, k): WholeSourceCandidate => {
      const cw = `${where}.candidates[${k}]`;
      const c = rec(rawCandidate, cw);
      return { rank: num(c.rank, `${cw}.rank`), noun: str(c.noun, `${cw}.noun`), posture: str(c.posture, `${cw}.posture`), direction: str(c.direction, `${cw}.direction`),
        confidence: confidence(c.confidence, `${cw}.confidence`),
        parts: list(c.parts, `${cw}.parts`).map(p => ({ id: str(rec(p, cw).id, `${cw}.parts.id`), role: str(rec(p, cw).role, `${cw}.parts.role`) })) };
    });
    const noConstrual = typeof o.noConstrual === 'boolean' && o.noConstrual === (candidates.length === 0) ? o.noConstrual : bad(where, 'noConstrual must match an empty candidate list');
    rows.set(id, { id, agreementStatus: str(o.agreementStatus, `${where}.agreementStatus`), noConstrual, candidates });
  }
  return { rows, meta: { schemaVersion: str(doc.schemaVersion, 'whole'), catalogRevision: str(doc.catalogRevision, 'whole'), status: str(doc.status, 'whole') } };
}

export function partsFromConstrual(document: unknown): { rows: Map<string, PartSourceRow>; meta: SourceMeta } {
  const doc = rec(document, 'parts');
  if (doc.schemaVersion !== 'tangram_independent_part_construal_v1') bad('parts', 'unsupported schemaVersion');
  const rows = new Map<string, PartSourceRow>();
  for (const [i, raw] of list(doc.entries, 'parts.entries').entries()) {
    const where = `parts.entries[${i}]`;
    const e = rec(raw, where);
    const id = str(e.id, `${where}.id`);
    if (rows.has(id)) bad(where, `duplicate ${id}`);
    const candidates = list(e.candidates, `${where}.candidates`).map((rawCandidate, k) => {
      const cw = `${where}.candidates[${k}]`;
      const c = rec(rawCandidate, cw);
      const owner = typeof c.owner === 'string' && c.owner.trim() ? oneLine(c.owner) : null;
      return { rank: num(c.rank, `${cw}.rank`), noun: str(c.noun, `${cw}.noun`), owner, confidence: confidence(c.confidence, `${cw}.confidence`) };
    });
    const noCandidate = typeof e.noCandidate === 'boolean' && e.noCandidate === (candidates.length === 0) ? e.noCandidate : bad(where, 'noCandidate must match an empty candidate list');
    const agreementStatus = str(e.agreementStatus, `${where}.agreementStatus`);
    if (agreementStatus === '未合意' && candidates.length) bad(where, '未合意 regions must carry no adopted candidate');
    rows.set(id, { id, members: list(e.members, `${where}.members`).map(m => str(m, `${where}.members`)), agreementStatus, noCandidate, candidates });
  }
  return { rows, meta: { schemaVersion: str(doc.schemaVersion, 'parts'), catalogRevision: str(doc.catalogRevision, 'parts'), status: str(doc.status, 'parts') } };
}

// ---- Bundle construction ----

export type BuildStats = {
  figures: number; views: number; wholeViews: number; noWholeViews: number; wholeCandidates: number;
  regionViews: number; partRegionViews: number; noPartRegionViews: number; partCandidates: number; disagreedRegionViews: number;
};

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function buildRotationMemoryEntries(geometry: readonly GeometryView[], whole: ReadonlyMap<string, WholeSourceRow>, parts: ReadonlyMap<string, PartSourceRow>): { entries: RotationMemoryEntry[]; stats: BuildStats } {
  const byFigure = new Map<string, Map<number, GeometryView>>();
  for (const view of geometry) {
    const views = byFigure.get(view.figureId) ?? new Map<number, GeometryView>();
    if (views.has(view.rotation)) bad(view.figureId, `duplicate rotation ${view.rotation}`);
    views.set(view.rotation, view);
    byFigure.set(view.figureId, views);
  }
  const stats: BuildStats = { figures: 0, views: 0, wholeViews: 0, noWholeViews: 0, wholeCandidates: 0, regionViews: 0, partRegionViews: 0, noPartRegionViews: 0, partCandidates: 0, disagreedRegionViews: 0 };
  const entries = [...byFigure.keys()].sort((a, b) => figureNumber(a) - figureNumber(b)).map((figureId): RotationMemoryEntry => {
    const views = byFigure.get(figureId)!;
    if (!ROTATIONS.every(r => views.has(r))) bad(figureId, 'all four rotations are required');
    const base = views.get(0)!;
    const common = (view: GeometryView) => view.regions.map(r => ({ id: r.id, members: r.members, shapeName: r.shapeName, sides: r.sides, convex: r.convex, areaPercent: r.areaPercent, adjacent: [...r.contacts].sort((a, b) => regionNumber(a) - regionNumber(b)) }));
    for (const r of ROTATIONS) if (!sameJson(common(views.get(r)!), common(base))) bad(`${figureId}@${r}`, 'region IDs, members, shape, area or adjacency differ from the rotation 0 view');
    // Rotation sense: a bank rotation r is a clockwise turn of r degrees on the screen, so an apex word moves r/45 steps clockwise.
    for (const region of base.regions) {
      if (region.tipDirection === null) continue;
      const start = CLOCKWISE_WORDS.indexOf(region.tipDirection);
      if (start < 0) bad(`${figureId}${region.id}`, `unknown apex word ${region.tipDirection}`);
      for (const r of [90, 180, 270]) if (views.get(r)!.regions.find(x => x.id === region.id)!.tipDirection !== CLOCKWISE_WORDS[(start + r / 45) % 8]) bad(`${figureId}${region.id}@${r}`, 'apex does not follow a clockwise turn');
    }
    const regions = base.regions.map(r => ({
      id: r.id, members: [...r.members], shapeName: r.shapeName, sides: r.sides, areaPercent: r.areaPercent,
      ...(r.convex === false ? { concave: true as const } : {}), adjacent: [...r.contacts].sort((a, b) => regionNumber(a) - regionNumber(b)),
    }));
    const ids = regions.map(r => r.id);
    const viewRecords = Object.fromEntries(ROTATIONS.map(r => {
      const view = views.get(r)!;
      const key = `${figureId}@${r}`;
      const layout = view.regions.map(region => {
        const at = positionWord(region.centroid, view.size);
        if (!region.description.startsWith(at + 'の')) bad(`${key}${region.id}`, 'position word does not match the confirmed description');
        return { id: region.id, at, tipDirection: region.tipDirection === null ? null : region.tipDirection as DirectionWord };
      });
      const row = whole.get(key) ?? bad(key, 'no whole-construal row');
      const wholeRows: RotationMemoryWhole[] = row.candidates.map((c, i) => {
        if (c.rank !== i + 1) bad(key, 'whole candidate ranks must be 1..n in order');
        if (!sameJson(c.parts.map(p => p.id), ids)) bad(key, 'every whole candidate must give a role for each region, in order');
        return { rank: c.rank, noun: c.noun, posture: c.posture, direction: c.direction, confidence: c.confidence, parts: c.parts.map(p => ({ id: p.id, role: p.role })) };
      });
      const partRows: RotationMemoryPart[] = [];
      for (const region of view.regions) {
        const partKey = `${key}#${region.id}`;
        const part = parts.get(partKey) ?? bad(partKey, 'no part-construal row');
        if (!sameJson([...part.members].sort(), [...region.members].sort())) bad(partKey, 'members differ from the confirmed region');
        stats.regionViews++;
        if (part.agreementStatus === '未合意') stats.disagreedRegionViews++;
        if (!part.candidates.length) { stats.noPartRegionViews++; continue; }
        part.candidates.forEach((c, i) => { if (c.rank !== i + 1) bad(partKey, 'part candidate ranks must be 1..n in order'); });
        stats.partRegionViews++; stats.partCandidates += part.candidates.length;
        partRows.push({ id: region.id, candidates: part.candidates.map(c => ({ noun: c.noun, confidence: c.confidence, ...(c.owner === null ? {} : { owner: c.owner }) })) });
      }
      stats.views++; stats.wholeCandidates += wholeRows.length;
      if (wholeRows.length) stats.wholeViews++; else stats.noWholeViews++;
      const record: RotationMemoryViewRecord = { layout, whole: wholeRows, parts: partRows, reviewStatus: 'ai_unreviewed' };
      return [r, record] as const;
    })) as Record<AbsoluteRotation, RotationMemoryViewRecord>;
    stats.figures++;
    return { figureKey: figureId, regions, views: viewRecords };
  });
  for (const key of whole.keys()) if (!byFigure.get(key.split('@')[0])?.has(Number(key.split('@')[1]))) bad(key, 'whole-construal row outside the confirmed catalog');
  for (const key of parts.keys()) {
    const [view, regionId] = key.split('#');
    const geometryView = byFigure.get(view.split('@')[0])?.get(Number(view.split('@')[1]));
    if (!geometryView?.regions.some(r => r.id === regionId)) bad(key, 'part-construal row outside the confirmed catalog');
  }
  return { entries, stats };
}

// ---- Output ----

export type SourceRecord = { path: string; sha256: string } & Record<string, string | number>;
export type BuildSources = { geometry: SourceRecord; whole: SourceRecord; parts: SourceRecord; review?: SourceRecord };

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** The pin hash covers exactly what can reach a model: version, catalog revision and the entries. */
export function rotationMemoryDataSha256(entries: readonly RotationMemoryEntry[], catalogRevision: string, version = ROTATION_MEMORY_BUILD_VERSION): string {
  return sha256(JSON.stringify({ version, catalogRevision, entries }));
}

export function renderDataModule(entries: readonly RotationMemoryEntry[], sources: BuildSources, catalogRevision: string, version = ROTATION_MEMORY_BUILD_VERSION): { text: string; dataSha256: string } {
  const dataSha256 = rotationMemoryDataSha256(entries, catalogRevision, version);
  const text = [
    '// Generated by docs/review/build-rotation-memory.ts from AI proposals the researcher has not confirmed yet. Not an answer key.',
    '// Do not edit by hand: a changed bundle needs a new version and a new pin (see rotation-memory-shape.ts and rotation-memory.ts).',
    `import type { RotationMemoryEntry } from './rotation-memory-shape.ts';`,
    `export const ROTATION_MEMORY_VERSION = ${JSON.stringify(version)};`,
    `export const ROTATION_MEMORY_CATALOG_REVISION = ${JSON.stringify(catalogRevision)};`,
    `export const ROTATION_MEMORY_DATA_SHA256 = ${JSON.stringify(dataSha256)};`,
    `export const ROTATION_MEMORY_SOURCES = ${JSON.stringify(sources, null, 1)};`,
    'export const ROTATION_MEMORY_ENTRIES: readonly RotationMemoryEntry[] = [',
    entries.map(entry => JSON.stringify(entry)).join(',\n'),
    '];',
    '',
  ].join('\n');
  return { text, dataSha256 };
}

type RegionsModule = { PRIMARY_REGION_CATALOG_REVISION?: unknown; PRIMARY_REGION_TEMPLATES?: unknown };

export async function buildFromFiles(paths: { geometry: string; whole: string; parts: string; review?: string | undefined }) {
  const module = await import(pathToFileURL(resolve(paths.geometry)).href) as RegionsModule;
  const catalogRevision = str(module.PRIMARY_REGION_CATALOG_REVISION, 'geometry.catalogRevision');
  const geometry = geometryFromTemplates(module.PRIMARY_REGION_TEMPLATES);
  const wholeRaw = readFileSync(paths.whole), partsRaw = readFileSync(paths.parts);
  const whole = wholeFromConsensus(JSON.parse(wholeRaw.toString('utf8')));
  const parts = partsFromConstrual(JSON.parse(partsRaw.toString('utf8')));
  for (const meta of [whole.meta, parts.meta]) if (meta.catalogRevision !== catalogRevision) bad('sources', 'catalog revision differs from the geometry');
  const sources: BuildSources = {
    geometry: { path: REPO_PATHS.geometry, sha256: sha256(readFileSync(paths.geometry)), catalogRevision },
    whole: { path: REPO_PATHS.whole, sha256: sha256(wholeRaw), schemaVersion: whole.meta.schemaVersion, status: whole.meta.status, orientations: whole.rows.size },
    parts: { path: REPO_PATHS.parts, sha256: sha256(partsRaw), schemaVersion: parts.meta.schemaVersion, status: parts.meta.status, entries: parts.rows.size },
  };
  if (paths.review !== undefined) {
    const reviewRaw = readFileSync(paths.review), digest = sha256(reviewRaw);
    if (catalogRevision !== `review-final-${digest.slice(0, 16)}`) bad('review', 'the confirmed partition file does not match the catalog revision');
    const results = list(rec(JSON.parse(reviewRaw.toString('utf8')), 'review').results, 'review.results');
    for (const row of results) {
      const r = rec(row, 'review.results');
      const view = geometry.find(g => g.figureId === r.figureId && g.rotation === 0);
      if (!view || !sameJson(list(r.groups, 'review.groups').map(g => list(g, 'review.groups').map(String)), view.regions.map(region => region.members))) bad(String(r.figureId), 'confirmed groups differ from the geometry members');
    }
    sources.review = { path: REPO_PATHS.review, sha256: digest };
  }
  const { entries, stats } = buildRotationMemoryEntries(geometry, whole.rows, parts.rows);
  return { ...renderDataModule(entries, sources, catalogRevision), entries, stats, catalogRevision };
}

async function main() {
  const { values } = parseArgs({ options: {
    regions: { type: 'string' }, whole: { type: 'string' }, parts: { type: 'string' }, review: { type: 'string' }, out: { type: 'string' }, check: { type: 'boolean' },
  } });
  const out = values.out ?? DEFAULT_PATHS.out;
  const built = await buildFromFiles({ geometry: values.regions ?? DEFAULT_PATHS.geometry, whole: values.whole ?? DEFAULT_PATHS.whole,
    parts: values.parts ?? DEFAULT_PATHS.parts, review: values.review ?? DEFAULT_PATHS.review });
  console.log(`rotation memory ${ROTATION_MEMORY_BUILD_VERSION}: ${built.stats.figures} figures, ${built.stats.views} views (${built.stats.wholeViews} with a whole construal, ${built.stats.noWholeViews} without), ${built.stats.regionViews} region views (${built.stats.partRegionViews} with part candidates), ${Buffer.byteLength(built.text)} bytes, sha256 ${built.dataSha256}`);
  if (values.check) {
    if (readFileSync(out, 'utf8') !== built.text) { console.error('the data module differs from a fresh build'); process.exitCode = 1; } else console.log('the data module matches a fresh build');
    return;
  }
  writeFileSync(out, built.text);
  console.log(`wrote ${out}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
