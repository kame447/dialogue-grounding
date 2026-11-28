import { literalSpan } from "../judgment/public-evidence.mjs";
import type { ObservationMemo } from "../observation/contract.ts";
import { describePart } from "../observation/part-consumers.ts";
import { rotationMemoryLayer } from "../decision/rotation-memory-guidance.ts";
import type { RotationLayer } from "../decision/rotation-memory-guidance.ts";
import { rotationSourceValue } from "../stimuli/rotation-memory-shape.ts";
import type { OwnRotationMemory, OwnRotationView } from "../stimuli/rotation-memory-shape.ts";

export type VisualFeatureSource = { figureId: string; path: (string | number)[] };
export type ExtractedVisualFeature = { source: VisualFeatureSource; quote: string };
export type VisualFeatureEvidence = { sources: ExtractedVisualFeature[] };

const MAX_FEATURES = 32; // Same bound as the existing public segment extraction.
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const index = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

const ROTATION_LAYERS: readonly RotationLayer[] = ["nouns", "roles", "full"];
type Path = (string | number)[];
/** One construal the memory offers in a view: a whole one (whole/i) or a part one of a region (parts/Pk/j). */
type Candidate = { unit: Path; noun: string; kind: "whole" | "parts" };
const candidatesOf = (view: OwnRotationView, head: Path): Candidate[] => [
  ...view.whole.map((w, i) => ({ unit: [...head, "whole", i], noun: w.noun, kind: "whole" as const })),
  ...Object.entries(view.parts).flatMap(([id, list]) => list.map((c, j) => ({ unit: [...head, "parts", id, j], noun: c.noun, kind: "parts" as const }))),
];

/**
 * A source in the pre-made rotation memory, read the way the model saw it. A path may lead to a string of the stored projection
 * (["rotation","turned",1,"whole",0,"noun"]), of a layer a call shows (["rotation","turned",1,"whole",0], ["rotation","turned",1,"view"]),
 * or be a unit itself. The unit is what a statement relies on: a candidate of a view (whole/i, parts/Pk/j: a part candidate is told apart
 * by its region too, two regions may both offer 尾), a region's part candidates, a view as a whole, or a region of the figure (regions/i).
 * A declaration and an extraction compare by their units. `scope` is set for a unit that does not name one candidate (a view, a region's
 * part candidates): the words an extraction quotes may narrow it to one. Null when the path is not a source here.
 */
function rotationSource(rotation: OwnRotationMemory, path: readonly (string | number)[]): { unit: Path; scope: Candidate[] | null } | null {
  const leaf = (): boolean => [rotation, ...ROTATION_LAYERS.map(layer => rotationMemoryLayer(rotation, layer) as unknown as OwnRotationMemory)]
    .some(shape => !!rotationSourceValue(shape, path.slice(1))?.trim());
  const rest = path.slice(1);
  if (rest[0] === "regions") {
    const i = rest[1];
    return index(i) && i < rotation.regions.length && (rest.length === 2 || leaf()) ? { unit: ["rotation", "regions", i], scope: null } : null;
  }
  let head: Path, view: OwnRotationView, tail: Path;
  if (rest[0] === "current") { head = ["rotation", "current"]; view = rotation.current; tail = rest.slice(1); }
  else if (rest[0] === "turned" && index(rest[1]) && rest[1] < rotation.turned.length) { head = ["rotation", "turned", rest[1]]; view = rotation.turned[rest[1]]; tail = rest.slice(2); }
  else return null;
  const all = candidatesOf(view, head);
  // The view itself, its one-line description or its part line.
  if (tail.length === 0 || tail.length === 1 && (tail[0] === "parts" || tail[0] === "view" && head[1] === "turned")) return { unit: head, scope: all };
  const at = (c: Candidate, n: number) => c.unit[head.length + n];
  if (tail[0] === "whole" && index(tail[1]) && tail[1] < view.whole.length) {
    return tail.length === 2 || leaf() ? { unit: [...head, "whole", tail[1]], scope: null } : null;
  }
  if (tail[0] === "parts" && typeof tail[1] === "string" && Object.hasOwn(view.parts, tail[1])) {
    const region = tail[1];
    if (tail.length === 2) return { unit: [...head, "parts", region], scope: all.filter(c => c.kind === "parts" && at(c, 1) === region) };
    const j = tail[2];
    return index(j) && j < view.parts[region].length && (tail.length === 3 || leaf()) ? { unit: [...head, "parts", region, j], scope: null } : null;
  }
  return null;
}

/**
 * An extraction that only reaches a view (or a region's part candidates) names the candidate through the words it quotes. A noun that one
 * candidate of that scope has names that candidate. A noun that several candidates have (two regions both offering 尾) does not tell which
 * one: the source then stays as it is, which no declared candidate equals, like a quote that names none (the source is not verified).
 */
function narrow(memo: ObservationMemo, source: VisualFeatureSource, quote: string): VisualFeatureSource[] {
  if (source.path[0] !== "rotation") return [source];
  const rotation = memo.figures.find(candidate => candidate.id === source.figureId)?.rotation;
  const found = rotation ? rotationSource(rotation, source.path) : null;
  if (!found?.scope) return [source];
  const byNoun = new Map<string, Candidate[]>();
  for (const c of found.scope) if (quote.includes(c.noun)) byNoun.set(c.kind + ":" + c.noun, [...byNoun.get(c.kind + ":" + c.noun) ?? [], c]);
  const named = [...byNoun.values()].filter(group => group.length === 1).map(([c]) => c.unit);
  const unresolved = named.length === 0 || [...byNoun.values()].some(group => group.length > 1);
  return [...named.map(path => ({ figureId: source.figureId, path })), ...(unresolved ? [source] : [])];
}

function sourceValue(memo: ObservationMemo, source: VisualFeatureSource): string | undefined {
  const figure = memo.figures.find(candidate => candidate.id === source.figureId);
  if (!figure) return;
  const { path } = source;
  const [section, entry, field, item] = path;
  if (section === "parts" && entry === "descriptions" && path.length === 3 && index(field)) {
    try { return describePart((figure as typeof figure & { parts?: unknown }).parts, field); }
    catch { return; }
  }
  if (section === "analytic") {
    if (entry === "composition" && path.length === 2) return figure.analytic.composition;
    if ((entry === "shapes" || entry === "relations") && path.length === 3 && index(field)) {
      return figure.analytic[entry][field];
    }
  }
  if (section === "holistic" && index(entry)) {
    if (field === "construal" && path.length === 3) return figure.holistic[entry]?.construal;
    if (field === "basis" && path.length === 4 && index(item)) return figure.holistic[entry]?.basis[item];
  }
  if (section === "reobservations" && index(entry) && (field === "supports" || field === "contradicts") &&
      path.length === 4 && index(item)) return figure.reobservations[entry]?.[field][item];
}

function readSource(value: unknown, memo: ObservationMemo, targets: readonly string[]): VisualFeatureSource | null {
  if (!exact(value, ["figureId", "path"]) || typeof value.figureId !== "string" ||
      !targets.includes(value.figureId) || !Array.isArray(value.path)) return null;
  const source = { figureId: value.figureId, path: [...value.path] };
  if (source.path[0] === "rotation") {
    const rotation = memo.figures.find(candidate => candidate.id === source.figureId)?.rotation;
    const found = rotation ? rotationSource(rotation, source.path) : null;
    return found ? { figureId: source.figureId, path: found.unit } : null;
  }
  return sourceValue(memo, source)?.trim() ? source : null;
}

function sourceKey(source: VisualFeatureSource): string {
  return JSON.stringify([source.figureId, source.path]);
}

export function readVisualFeatureSources(value: unknown, memo: ObservationMemo, targets: readonly string[]): VisualFeatureSource[] | null {
  if (!Array.isArray(value) || value.length > MAX_FEATURES) return null;
  const sources: VisualFeatureSource[] = [], keys = new Set<string>(), declared = new Set<string>();
  for (const entry of value) {
    const source = readSource(entry, memo, targets);
    if (!source) return null;
    // Repeating the very same path is refused as before. Two paths that read as one rotation unit are one source.
    const written = JSON.stringify([(entry as { figureId: string }).figureId, (entry as { path: unknown[] }).path]);
    if (declared.has(written)) return null;
    declared.add(written);
    const key = sourceKey(source);
    if (keys.has(key)) continue;
    keys.add(key); sources.push(source);
  }
  return sources;
}

/** The extractor assigns meaning. The program only locates a public span and resolves each memo path. */
export function readVisualFeatureEvidence(value: unknown, memo: ObservationMemo, targets: readonly string[],
  text?: string): VisualFeatureEvidence | null {
  if (!exact(value, ["sources"]) || !Array.isArray(value.sources) || value.sources.length > MAX_FEATURES) return null;
  const sources: ExtractedVisualFeature[] = [];
  for (const entry of value.sources) {
    if (!exact(entry, ["source", "quote"]) || typeof entry.quote !== "string" || !entry.quote.trim() || entry.quote.length > 160) return null;
    const source = readSource(entry.source, memo, targets);
    const span = text === undefined ? undefined : literalSpan(text, entry.quote);
    if (!source || text !== undefined && (!span || span.text.length > 160)) return null;
    const quote = span?.text ?? entry.quote;
    for (const narrowed of narrow(memo, source, quote)) sources.push({ source: narrowed, quote });
  }
  return { sources };
}

export function sameVisualFeatureSources(declared: readonly VisualFeatureSource[], extracted: VisualFeatureEvidence): boolean {
  const observed = new Set(extracted.sources.map(entry => sourceKey(entry.source)));
  return declared.length === observed.size && declared.every(source => observed.has(sourceKey(source)));
}

export function readVisualFeatureDraft(raw: string, memo: ObservationMemo, targets: readonly string[], combined: boolean,
  ignoreSources = false) {
  try {
    const value: unknown = JSON.parse(raw);
    const keys = combined ? ["text", "moveOn"] : ["text"];
    if (!(exact(value, [...keys, "observationFeatures"]) || ignoreSources && exact(value, keys)) ||
        typeof value.text !== "string" || !value.text.trim() || value.text.length > 12000) return null;
    let moveOn: string | null = null;
    if (combined) {
      if (typeof value.moveOn !== "string" || !value.moveOn.trim() || value.text.length + value.moveOn.length + 1 > 12000) return null;
      moveOn = value.moveOn;
    }
    const sources = ignoreSources ? [] : readVisualFeatureSources(value.observationFeatures, memo, targets);
    return sources === null ? null : { text: value.text, moveOn, sources };
  } catch { return null; }
}

export const VISUAL_FEATURE_SOURCES_V19 = '観察で使った特徴の出所を figureId と path で示してください。path の配列の位置は0から数えます。例は ["analytic","shapes",0]、["analytic","composition"]、["analytic","relations",0]、["holistic",0,"construal"]、["holistic",0,"basis",0]、["reobservations",0,"supports",0]、["reobservations",0,"contradicts",0] です。観察の不明点は根拠として扱わず、相手の発話に触れることと、自分側の観察に根拠を置くことを区別してください。';
export const VISUAL_FEATURE_SELECTION_V19 = 'Jevが選んだ行動、対象、解消したい論点の範囲で、観察メモから確認や修復に使う具体的な特徴を選んでください。相手が具体的な特徴を質問していれば先にその問いを扱い、肯定・否定・訂正された点と未解決の点を区別してください。全体像から必要な細部へ進み、候補の区別や説明の対応に役立つ点を優先してください。根拠が不足していればその不確かさを示し、必要な情報を自然に尋ねてください。メモに記載がないことから特徴がないと断定せず、今の論点に無関係な共通特徴を選ばないでください。';
export const VISUAL_FEATURE_DRAFT_V19 = '出力は text（公開発話）と observationFeatures（公開発話で使った観察の出所の配列）を持つJSONオブジェクトです。観察に根拠を置く特徴を使わなければ observationFeatures は空配列です。';
