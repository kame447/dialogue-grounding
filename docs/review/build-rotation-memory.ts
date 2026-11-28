// Builds the immutable rotation-memory bundle (dialogue-model/runtime/stimuli/rotation-memory-data.ts).
//
//   node docs/review/build-rotation-memory.ts [--regions <primary-regions-data.ts>] [--review <review-results-final.json>]
//     ( [--whole <consensus-120.json>] [--parts <part-construal-468.json>]  |  --export <review page export> [--require-confirmed] )
//     [--out <data module>] [--check]
//
// Inputs. Geometry always comes from primary-regions-data.ts: ONLY the confirmed partition's geometry is read from it
// (regions, members, shape, area, position, apex, contacts). Its older construal fields (construal, initial, description
// wording) are never read, so an old proposal cannot reach the bundle. The candidates come from one of:
//   - the AI proposals: consensus-120.json (whole) and part-construal-468.json (parts); adopted `candidates` only. Nothing
//     in them is confirmed by the researcher.
//   - the review page's export (orientation-app, GET /api/export): the structured layers `wholeConstrual` and
//     `parts[].independentPart` only. The free-text fields (`whole`, `wholeBasis`, role lines) are never parsed. A direction
//     counts as confirmed when its row is 確認済み, nothing is flagged 自由文と要照合 and every layer is
//     researcher_confirmed or researcher_edited. The others are listed in the report, not refused; --require-confirmed
//     turns a non-empty list into a failure (for the build that is merged).
// Output: the bundle plus its version, catalog revision, SHA-256 and the SHA-256 of every input. Evidence and weakness texts
// stay in the input files and are not part of the bundle. `--check` regenerates in memory and fails on any difference.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  AbsoluteRotation, Confidence, DirectionWord, PositionWord, ReviewStatus, RotationMemoryEntry, RotationMemoryPart, RotationMemoryViewRecord, RotationMemoryWhole,
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
const flag = (v: unknown, where: string): boolean => typeof v === 'boolean' ? v : bad(where, 'a boolean is required');
const confidence = (v: unknown, where: string): Confidence => v === '高' || v === '中' || v === '低' ? v : bad(where, 'confidence must be 高/中/低');
const rotation = (v: unknown, where: string): AbsoluteRotation => v === 0 || v === 90 || v === 180 || v === 270 ? v : bad(where, 'rotation must be 0/90/180/270');
const reviewStatus = (v: unknown, where: string): ReviewStatus => v === 'ai_unreviewed' || v === 'researcher_confirmed' || v === 'researcher_edited' ? v : bad(where, 'unknown reviewStatus');
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
export type PartSourceCandidate = { rank: number; noun: string; owner: string | null; confidence: Confidence };
export type PartSourceRow = { id: string; members: string[]; agreementStatus: string; noCandidate: boolean; candidates: PartSourceCandidate[] };
export type SourceMeta = { schemaVersion: string; catalogRevision: string; status: string };

function wholeCandidateOf(raw: unknown, where: string): WholeSourceCandidate {
  const c = rec(raw, where);
  return { rank: num(c.rank, `${where}.rank`), noun: str(c.noun, `${where}.noun`), posture: str(c.posture, `${where}.posture`), direction: str(c.direction, `${where}.direction`),
    confidence: confidence(c.confidence, `${where}.confidence`),
    parts: list(c.parts, `${where}.parts`).map(p => ({ id: str(rec(p, where).id, `${where}.parts.id`), role: str(rec(p, where).role, `${where}.parts.role`) })) };
}
function partCandidateOf(raw: unknown, where: string): PartSourceCandidate {
  const c = rec(raw, where);
  const owner = typeof c.owner === 'string' && c.owner.trim() ? oneLine(c.owner) : null;
  return { rank: num(c.rank, `${where}.rank`), noun: str(c.noun, `${where}.noun`), owner, confidence: confidence(c.confidence, `${where}.confidence`) };
}

export function wholeFromConsensus(document: unknown): { rows: Map<string, WholeSourceRow>; meta: SourceMeta } {
  const doc = rec(document, 'whole');
  if (doc.schemaVersion !== 'tangram_orientation_construal_consensus_v1') bad('whole', 'unsupported schemaVersion');
  const rows = new Map<string, WholeSourceRow>();
  for (const [i, raw] of list(doc.orientations, 'whole.orientations').entries()) {
    const where = `whole.orientations[${i}]`;
    const o = rec(raw, where);
    const id = str(o.id, `${where}.id`);
    if (rows.has(id)) bad(where, `duplicate ${id}`);
    const candidates = list(o.candidates, `${where}.candidates`).map((rawCandidate, k) => wholeCandidateOf(rawCandidate, `${where}.candidates[${k}]`));
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
    const candidates = list(e.candidates, `${where}.candidates`).map((rawCandidate, k) => partCandidateOf(rawCandidate, `${where}.candidates[${k}]`));
    const noCandidate = typeof e.noCandidate === 'boolean' && e.noCandidate === (candidates.length === 0) ? e.noCandidate : bad(where, 'noCandidate must match an empty candidate list');
    const agreementStatus = str(e.agreementStatus, `${where}.agreementStatus`);
    if (agreementStatus === '未合意' && candidates.length) bad(where, '未合意 regions must carry no adopted candidate');
    rows.set(id, { id, members: list(e.members, `${where}.members`).map(m => str(m, `${where}.members`)), agreementStatus, noCandidate, candidates });
  }
  return { rows, meta: { schemaVersion: str(doc.schemaVersion, 'parts'), catalogRevision: str(doc.catalogRevision, 'parts'), status: str(doc.status, 'parts') } };
}

// ---- The review page's export: structured layers only ----

export type UnconfirmedDirection = { id: string; reasons: string[] };
export type ExportSources = {
  whole: Map<string, WholeSourceRow>; parts: Map<string, PartSourceRow>; statuses: Map<string, ReviewStatus>;
  /** Directions that are not researcher-confirmed in every layer. Reported, never a reason to refuse the export. */
  unconfirmed: UnconfirmedDirection[];
  meta: { catalogRevision: string; schemaVersion: string; wholeSchemaVersion: string; partSchemaVersion: string; rows: number; revision: number | null };
};

/**
 * Reads the review page's export (orientation-app, GET /api/export). Only `wholeConstrual` and `parts[].independentPart`
 * are read. A layer that is still ai_unreviewed, a row that is not 確認済み and a row flagged needsTextCheck are listed
 * in `unconfirmed`. A layer with no AI proposal and no decision (ai: null, ai_unreviewed, no candidate, no 見立てなし)
 * builds as "no candidate" and is listed as 未入力. The per-direction reviewStatus is researcher_confirmed or
 * researcher_edited only when every layer of the direction is reviewed.
 */
export function sourcesFromReviewExport(document: unknown): ExportSources {
  const doc = rec(document, 'export');
  if (doc.schemaVersion !== 'tangram_orientation_review_v1') bad('export', 'unsupported schemaVersion');
  if (doc.wholeConstrualSchemaVersion !== 'tangram_whole_construal_review_v1') bad('export', 'the whole-construal layer is missing or of another version');
  if (doc.independentPartSchemaVersion !== 'tangram_independent_part_review_v1') bad('export', 'the independent-part layer is missing or of another version');
  const whole = new Map<string, WholeSourceRow>(), parts = new Map<string, PartSourceRow>(), statuses = new Map<string, ReviewStatus>();
  const unconfirmed: UnconfirmedDirection[] = [];
  const results = list(doc.results, 'export.results');
  for (const [i, raw] of results.entries()) {
    const where = `export.results[${i}]`;
    const r = rec(raw, where);
    const id = str(r.id, `${where}.id`);
    if (whole.has(id)) bad(where, `duplicate ${id}`);
    const status = r.status === '未確認' || r.status === '確認済み' || r.status === '要修正' ? r.status : bad(where, 'unknown row status');
    const reasons: string[] = status === '確認済み' ? [] : [`行の状態が${status}`];
    const w = rec(r.wholeConstrual, `${where}.wholeConstrual`);
    const wholeStatus = reviewStatus(w.reviewStatus, `${where}.wholeConstrual`);
    const wholeAi = w.ai === null ? null : rec(w.ai, `${where}.wholeConstrual.ai`);
    const wholeCandidates = list(w.candidates, `${where}.wholeConstrual.candidates`).map((rawCandidate, k) => wholeCandidateOf(rawCandidate, `${where}.wholeConstrual.candidates[${k}]`));
    const noConstrual = flag(w.noConstrual, `${where}.wholeConstrual.noConstrual`);
    if (noConstrual && wholeCandidates.length) bad(where, 'a direction marked without a construal cannot carry candidates');
    if (flag(w.needsTextCheck, `${where}.wholeConstrual.needsTextCheck`)) reasons.push('自由文と要照合');
    if (wholeStatus === 'ai_unreviewed') reasons.push(wholeAi === null ? '全体の見立てが未入力' : '全体の見立てがAI案のまま');
    whole.set(id, { id, agreementStatus: wholeAi === null ? 'AI案なし' : str(wholeAi.agreementStatus, `${where}.wholeConstrual.ai`), noConstrual, candidates: wholeCandidates });
    const layers: ReviewStatus[] = [wholeStatus];
    for (const [k, rawPart] of list(r.parts, `${where}.parts`).entries()) {
      const pw = `${where}.parts[${k}]`;
      const p = rec(rawPart, pw);
      const partId = str(p.id, `${pw}.id`);
      const ip = rec(p.independentPart, `${pw}.independentPart`);
      const partStatus = reviewStatus(ip.reviewStatus, `${pw}.independentPart`);
      const partAi = ip.ai === null ? null : rec(ip.ai, `${pw}.independentPart.ai`);
      const candidates = list(ip.candidates, `${pw}.independentPart.candidates`).map((rawCandidate, n) => partCandidateOf(rawCandidate, `${pw}.independentPart.candidates[${n}]`));
      const noCandidate = flag(ip.noCandidate, `${pw}.independentPart.noCandidate`);
      if (noCandidate && candidates.length) bad(pw, 'a region marked without a candidate cannot carry candidates');
      const agreementStatus = partAi === null ? 'AI案なし' : str(partAi.agreementStatus, `${pw}.independentPart.ai`);
      if (partStatus === 'ai_unreviewed' && agreementStatus === '未合意' && candidates.length) bad(pw, '未合意 regions must carry no adopted candidate');
      if (partStatus === 'ai_unreviewed') reasons.push(`${partId}の部分の見立てが${partAi === null ? '未入力' : 'AI案のまま'}`);
      parts.set(`${id}#${partId}`, { id: `${id}#${partId}`, members: list(p.members, `${pw}.members`).map(m => str(m, `${pw}.members`)), agreementStatus, noCandidate, candidates });
      layers.push(partStatus);
    }
    statuses.set(id, layers.some(s => s === 'ai_unreviewed') ? 'ai_unreviewed' : layers.some(s => s === 'researcher_edited') ? 'researcher_edited' : 'researcher_confirmed');
    if (reasons.length) unconfirmed.push({ id, reasons });
  }
  return { whole, parts, statuses, unconfirmed, meta: {
    catalogRevision: str(doc.catalogRevision, 'export'), schemaVersion: str(doc.schemaVersion, 'export'), wholeSchemaVersion: str(doc.wholeConstrualSchemaVersion, 'export'),
    partSchemaVersion: str(doc.independentPartSchemaVersion, 'export'), rows: results.length, revision: Number.isSafeInteger(doc.revision) ? doc.revision as number : null,
  } };
}

// ---- Bundle construction ----

export type BuildStats = {
  figures: number; views: number; wholeViews: number; noWholeViews: number; wholeCandidates: number;
  regionViews: number; partRegionViews: number; noPartRegionViews: number; partCandidates: number; disagreedRegionViews: number;
};

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** `statuses` (keyed like `F1@0`) gives each view's reviewStatus; every view is ai_unreviewed when it is omitted. */
export function buildRotationMemoryEntries(
  geometry: readonly GeometryView[], whole: ReadonlyMap<string, WholeSourceRow>, parts: ReadonlyMap<string, PartSourceRow>,
  statuses: ReadonlyMap<string, ReviewStatus> = new Map(),
): { entries: RotationMemoryEntry[]; stats: BuildStats } {
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
      const record: RotationMemoryViewRecord = { layout, whole: wholeRows, parts: partRows, reviewStatus: statuses.get(key) ?? 'ai_unreviewed' };
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

export type SourceRecord = { path: string; sha256: string } & Record<string, string | number | null>;
export type BuildSources = { geometry: SourceRecord; review?: SourceRecord } & ({ whole: SourceRecord; parts: SourceRecord } | { export: SourceRecord });

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** The pin hash covers exactly what can reach a model: version, catalog revision and the entries. */
export function rotationMemoryDataSha256(entries: readonly RotationMemoryEntry[], catalogRevision: string, version = ROTATION_MEMORY_BUILD_VERSION): string {
  return sha256(JSON.stringify({ version, catalogRevision, entries }));
}

export function renderDataModule(entries: readonly RotationMemoryEntry[], sources: BuildSources, catalogRevision: string, version = ROTATION_MEMORY_BUILD_VERSION): { text: string; dataSha256: string } {
  const dataSha256 = rotationMemoryDataSha256(entries, catalogRevision, version);
  const text = [
    '// Generated by docs/review/build-rotation-memory.ts. Candidates are AI proposals or the researcher\'s confirmed edits (see each view\'s reviewStatus), never an answer key.',
    '// Do not edit by hand: a changed bundle needs a new version and a new pin (see rotation-memory-shape.ts and rotation-memory.ts).',
    `import type { RotationMemoryEntry } from './rotation-memory-shape.ts';`,
    `export const ROTATION_MEMORY_VERSION = ${JSON.stringify(version)};`,
    `export const ROTATION_MEMORY_CATALOG_REVISION = ${JSON.stringify(catalogRevision)};`,
    `export const ROTATION_MEMORY_DATA_SHA256 = ${JSON.stringify(dataSha256)};`,
    `export const ROTATION_MEMORY_SOURCES: Record<string, Record<string, string | number | null>> = ${JSON.stringify(sources, null, 1)};`,
    'export const ROTATION_MEMORY_ENTRIES: readonly RotationMemoryEntry[] = [',
    entries.map(entry => JSON.stringify(entry)).join(',\n'),
    '];',
    '',
  ].join('\n');
  return { text, dataSha256 };
}

type RegionsModule = { PRIMARY_REGION_CATALOG_REVISION?: unknown; PRIMARY_REGION_TEMPLATES?: unknown };
export type BuildResult = { text: string; dataSha256: string; entries: RotationMemoryEntry[]; stats: BuildStats; catalogRevision: string; unconfirmed?: UnconfirmedDirection[] };

/** The confirmed partition: geometry from primary-regions-data.ts, cross-checked against the confirmed review file when given. */
async function loadGeometry(paths: { geometry: string; review?: string | undefined }) {
  const module = await import(pathToFileURL(resolve(paths.geometry)).href) as RegionsModule;
  const catalogRevision = str(module.PRIMARY_REGION_CATALOG_REVISION, 'geometry.catalogRevision');
  const geometry = geometryFromTemplates(module.PRIMARY_REGION_TEMPLATES);
  const sources: { geometry: SourceRecord; review?: SourceRecord } = { geometry: { path: REPO_PATHS.geometry, sha256: sha256(readFileSync(paths.geometry)), catalogRevision } };
  if (paths.review !== undefined) {
    const reviewRaw = readFileSync(paths.review), digest = sha256(reviewRaw);
    if (catalogRevision !== `review-final-${digest.slice(0, 16)}`) bad('review', 'the confirmed partition file does not match the catalog revision');
    for (const row of list(rec(JSON.parse(reviewRaw.toString('utf8')), 'review').results, 'review.results')) {
      const r = rec(row, 'review.results');
      const view = geometry.find(g => g.figureId === r.figureId && g.rotation === 0);
      if (!view || !sameJson(list(r.groups, 'review.groups').map(g => list(g, 'review.groups').map(String)), view.regions.map(region => region.members))) bad(String(r.figureId), 'confirmed groups differ from the geometry members');
    }
    sources.review = { path: REPO_PATHS.review, sha256: digest };
  }
  return { catalogRevision, geometry, sources };
}

export async function buildFromFiles(paths: { geometry: string; whole: string; parts: string; review?: string | undefined }): Promise<BuildResult> {
  const { catalogRevision, geometry, sources: base } = await loadGeometry(paths);
  const wholeRaw = readFileSync(paths.whole), partsRaw = readFileSync(paths.parts);
  const whole = wholeFromConsensus(JSON.parse(wholeRaw.toString('utf8')));
  const parts = partsFromConstrual(JSON.parse(partsRaw.toString('utf8')));
  for (const meta of [whole.meta, parts.meta]) if (meta.catalogRevision !== catalogRevision) bad('sources', 'catalog revision differs from the geometry');
  const sources: BuildSources = { ...base,
    whole: { path: REPO_PATHS.whole, sha256: sha256(wholeRaw), schemaVersion: whole.meta.schemaVersion, status: whole.meta.status, orientations: whole.rows.size },
    parts: { path: REPO_PATHS.parts, sha256: sha256(partsRaw), schemaVersion: parts.meta.schemaVersion, status: parts.meta.status, entries: parts.rows.size },
  };
  const { entries, stats } = buildRotationMemoryEntries(geometry, whole.rows, parts.rows);
  return { ...renderDataModule(entries, sources, catalogRevision), entries, stats, catalogRevision };
}

/** Builds from the review page's export (structured layers). Not-yet-confirmed directions are returned in `unconfirmed`. */
export async function buildFromExportFile(paths: { geometry: string; export: string; review?: string | undefined }): Promise<BuildResult> {
  const { catalogRevision, geometry, sources: base } = await loadGeometry(paths);
  const raw = readFileSync(paths.export);
  const parsed = sourcesFromReviewExport(JSON.parse(raw.toString('utf8')));
  if (parsed.meta.catalogRevision !== catalogRevision) bad('export', 'catalog revision differs from the geometry');
  const sources: BuildSources = { ...base, export: { path: basename(paths.export), sha256: sha256(raw), schemaVersion: parsed.meta.schemaVersion,
    wholeConstrualSchemaVersion: parsed.meta.wholeSchemaVersion, independentPartSchemaVersion: parsed.meta.partSchemaVersion, results: parsed.meta.rows, revision: parsed.meta.revision } };
  const { entries, stats } = buildRotationMemoryEntries(geometry, parsed.whole, parsed.parts, parsed.statuses);
  return { ...renderDataModule(entries, sources, catalogRevision), entries, stats, catalogRevision, unconfirmed: parsed.unconfirmed };
}

async function main() {
  const { values } = parseArgs({ options: {
    regions: { type: 'string' }, whole: { type: 'string' }, parts: { type: 'string' }, review: { type: 'string' }, out: { type: 'string' }, check: { type: 'boolean' },
    export: { type: 'string' }, 'require-confirmed': { type: 'boolean' },
  } });
  const out = values.out ?? DEFAULT_PATHS.out;
  if (values['require-confirmed'] && values.export === undefined) { console.error('--require-confirmed needs --export: the AI proposal files are never confirmed by the researcher'); process.exitCode = 1; return; }
  const geometry = values.regions ?? DEFAULT_PATHS.geometry, review = values.review ?? DEFAULT_PATHS.review;
  const built = values.export !== undefined
    ? await buildFromExportFile({ geometry, export: values.export, review })
    : await buildFromFiles({ geometry, whole: values.whole ?? DEFAULT_PATHS.whole, parts: values.parts ?? DEFAULT_PATHS.parts, review });
  console.log(`rotation memory ${ROTATION_MEMORY_BUILD_VERSION}: ${built.stats.figures} figures, ${built.stats.views} views (${built.stats.wholeViews} with a whole construal, ${built.stats.noWholeViews} without), ${built.stats.regionViews} region views (${built.stats.partRegionViews} with part candidates), ${Buffer.byteLength(built.text)} bytes, sha256 ${built.dataSha256}`);
  if (built.unconfirmed !== undefined) {
    console.log(`confirmed in every layer: ${built.stats.views - built.unconfirmed.length} of ${built.stats.views} directions; not confirmed: ${built.unconfirmed.length}`);
    for (const row of built.unconfirmed) console.log(`  ${row.id}: ${row.reasons.join('、')}`);
    if (values['require-confirmed'] && built.unconfirmed.length) { console.error('not every direction is confirmed; nothing was written'); process.exitCode = 1; return; }
  }
  if (values.check) {
    if (readFileSync(out, 'utf8') !== built.text) { console.error('the data module differs from a fresh build'); process.exitCode = 1; } else console.log('the data module matches a fresh build');
    return;
  }
  writeFileSync(out, built.text);
  console.log(`wrote ${out}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
