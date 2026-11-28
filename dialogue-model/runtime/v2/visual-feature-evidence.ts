import { literalSpan } from "../judgment/public-evidence.mjs";
import type { ObservationMemo } from "../observation/contract.ts";
import { describePart } from "../observation/part-consumers.ts";
import { rotationSourceValue } from "../stimuli/rotation-memory-shape.ts";

export type VisualFeatureSource = { figureId: string; path: (string | number)[] };
export type ExtractedVisualFeature = { source: VisualFeatureSource; quote: string };
export type VisualFeatureEvidence = { sources: ExtractedVisualFeature[] };

const MAX_FEATURES = 32; // Same bound as the existing public segment extraction.
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const index = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function sourceValue(memo: ObservationMemo, source: VisualFeatureSource): string | undefined {
  const figure = memo.figures.find(candidate => candidate.id === source.figureId);
  if (!figure) return;
  const { path } = source;
  const [section, entry, field, item] = path;
  // The pre-made rotation memory: ["rotation", ...path inside the projection], e.g. ["rotation","turned",1,"parts","P1",0,"noun"].
  if (section === "rotation" && path.length > 1) return figure.rotation ? rotationSourceValue(figure.rotation, path.slice(1)) : undefined;
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
  return sourceValue(memo, source)?.trim() ? source : null;
}

function sourceKey(source: VisualFeatureSource): string {
  return JSON.stringify([source.figureId, source.path]);
}

export function readVisualFeatureSources(value: unknown, memo: ObservationMemo, targets: readonly string[]): VisualFeatureSource[] | null {
  if (!Array.isArray(value) || value.length > MAX_FEATURES) return null;
  const sources: VisualFeatureSource[] = [], keys = new Set<string>();
  for (const entry of value) {
    const source = readSource(entry, memo, targets);
    if (!source) return null;
    const key = sourceKey(source);
    if (keys.has(key)) return null;
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
    sources.push({ source, quote: span?.text ?? entry.quote });
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
