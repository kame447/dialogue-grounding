// Read-only check of the orientation review page after it was switched to the code that has the two structured
// layers (independent part construal and whole construal). Only GET requests are sent. It compares the page with
// the state file and the export taken before the switch (see review-page-switch-runbook.md).
//
//   node docs/review/part-construal-20261128/verify-switch.ts --url http://127.0.0.1:5498 \
//     --before-state <review-state.before.json> --before-export <export-before.json> \
//     [--layer empty|applied] [--whole-layer empty|applied]
//
// --layer        : the independent part layer. empty = right after the switch, before part-construal-468.json is applied
//                  (the state is the same revision as before and every region is empty); applied = every region has an AI proposal.
// --whole-layer  : the whole construal layer, the same two states for consensus-120.json (default: the value of --layer).
// Everything else (rows, statuses, notes, the free text of the whole construal, the current position, geometry) must
// equal the state before the switch. Exit code 1 with the first difference when something differs.
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import assert from 'node:assert/strict';

type Part = { id: string; reviewStatus: string; candidates: unknown[]; noCandidate: boolean; noCandidateReason: string; ai: unknown };
type Whole = { id: string; reviewStatus: string; candidates: unknown[]; noConstrual: boolean; noConstrualReason: string; needsTextCheck: boolean; ai: unknown };
const { values } = parseArgs({ options: { url: { type: 'string', default: 'http://127.0.0.1:5498' }, 'before-state': { type: 'string' }, 'before-export': { type: 'string' }, layer: { type: 'string', default: 'empty' }, 'whole-layer': { type: 'string' } } });
const wholeLayer = values['whole-layer'] ?? values.layer!;
if (!values['before-state'] || !values['before-export'] || !['empty', 'applied'].includes(values.layer!) || !['empty', 'applied'].includes(wholeLayer)) throw Error('--before-state, --before-export, --layer empty|applied and --whole-layer empty|applied are required');
const json = async (path: string) => { const r = await fetch(values.url + path, { cache: 'no-store' }); assert.ok(r.ok, 'GET ' + path + ': ' + r.status); return r.json(); };
const beforeState = JSON.parse(readFileSync(values['before-state'], 'utf8')), beforeExport = JSON.parse(readFileSync(values['before-export'], 'utf8'));
const data = await json('/api/data'), state = await json('/api/state'), exported = await json('/api/export');

try {
  assert.equal(state.schemaVersion, beforeState.schemaVersion, 'schemaVersion');
  assert.equal(data.sourceSha256, beforeState.sourceSha256, 'sourceSha256 of the catalog data');
  assert.equal(state.sourceSha256, beforeState.sourceSha256, 'sourceSha256 of the state');
  assert.equal(data.catalogRevision, beforeExport.catalogRevision, 'catalogRevision');
  assert.equal(state.currentId, beforeState.currentId, 'currentId (the current position)');
  assert.ok(isDeepStrictEqual(state.results, beforeState.results), 'results (statuses, notes, whole construal text, part roles and descriptions) differ from before the switch');
  if (values.layer === 'empty' && wholeLayer === 'empty') {
    assert.equal(state.revision, beforeState.revision, 'revision must not change by the switch itself');
    assert.equal(state.updatedAt, beforeState.updatedAt, 'updatedAt must not change by the switch itself');
  } else assert.ok(state.revision > beforeState.revision, 'revision must have increased by an apply');

  assert.equal(state.independentParts?.schemaVersion, data.independentPart?.schemaVersion, 'independent layer schemaVersion');
  assert.equal(state.independentParts.rows.length, 120, 'independent layer rows');
  const parts: Part[] = state.independentParts.rows.flatMap((r: { parts: Part[] }) => r.parts);
  assert.equal(parts.length, 468, 'independent layer regions');
  const independentLayer = {
    regions: parts.length,
    withCandidates: parts.filter(p => p.candidates.length).length,
    candidates: parts.reduce((n, p) => n + p.candidates.length, 0),
    noCandidate: parts.filter(p => p.noCandidate).length,
    unreviewedAi: parts.filter(p => p.reviewStatus === 'ai_unreviewed' && p.ai !== null).length,
    confirmed: parts.filter(p => p.reviewStatus === 'researcher_confirmed').length,
    edited: parts.filter(p => p.reviewStatus === 'researcher_edited').length,
  };
  if (values.layer === 'empty') assert.ok(parts.every(p => p.ai === null && p.reviewStatus === 'ai_unreviewed' && !p.candidates.length && !p.noCandidate && p.noCandidateReason === ''), 'every independent part must be empty right after the switch');
  else assert.ok(parts.every(p => p.ai !== null), 'every independent part must carry an AI proposal after the apply');

  assert.equal(state.wholeConstruals?.schemaVersion, data.wholeConstrual?.schemaVersion, 'whole layer schemaVersion');
  const wholes: Whole[] = state.wholeConstruals.rows;
  assert.equal(wholes.length, 120, 'whole layer rows');
  assert.ok(wholes.every((w, i) => w.id === state.results[i].id), 'whole layer rows must follow the catalog order');
  const wholeSummary = {
    rows: wholes.length,
    withCandidates: wholes.filter(w => w.candidates.length).length,
    candidates: wholes.reduce((n, w) => n + w.candidates.length, 0),
    noConstrual: wholes.filter(w => w.noConstrual).length,
    unreviewedAi: wholes.filter(w => w.reviewStatus === 'ai_unreviewed' && w.ai !== null).length,
    confirmed: wholes.filter(w => w.reviewStatus === 'researcher_confirmed').length,
    edited: wholes.filter(w => w.reviewStatus === 'researcher_edited').length,
    needsTextCheck: wholes.filter(w => w.needsTextCheck).map(w => w.id),
  };
  if (wholeLayer === 'empty') assert.ok(wholes.every(w => w.ai === null && w.reviewStatus === 'ai_unreviewed' && !w.candidates.length && !w.noConstrual && w.noConstrualReason === '' && !w.needsTextCheck), 'every whole construal must be empty right after the switch');
  else assert.ok(wholes.every(w => w.ai !== null), 'every whole construal must carry an AI proposal after the apply');

  // The export must differ from the one before the switch only by the two layers (and revision/updatedAt).
  const strip = (e: any) => ({ ...e, revision: 0, updatedAt: '', independentPartSchemaVersion: undefined, wholeConstrualSchemaVersion: undefined,
    results: e.results.map((r: any) => ({ ...r, wholeConstrual: undefined, parts: r.parts.map(({ independentPart, ...q }: any) => q) })) });
  assert.ok(isDeepStrictEqual(strip(exported), strip(beforeExport)), 'the export differs from the export before the switch outside the two layers');
  console.log(JSON.stringify({ ok: true, url: values.url, expectedLayers: { independentParts: values.layer, wholeConstruals: wholeLayer }, revision: state.revision, beforeRevision: beforeState.revision, currentId: state.currentId, independentParts: independentLayer, wholeConstruals: wholeSummary }, null, 2));
} catch (e) {
  console.error('NG: ' + (e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
}
