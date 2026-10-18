// RESEARCHER ONLY. Shared rendering, sampling and parsing for the rotation
// discrimination benches. Images contain only black silhouettes on white:
// no figure ids, labels, numbers or answer hints are drawn or written.
import { createHash } from "node:crypto";
import { FIGURES } from "../../stimuli/figures.mjs";
import { transformPolygon } from "../../stimuli/geometry.mjs";
import { renderPolygons } from "../../stimuli/render.mjs";
import type { Figure, Point } from "./shape-similarity.ts";

export const SLOTS = Object.freeze(["上段左", "上段中", "上段右", "下段左", "下段中", "下段右"] as const);
export type Slot = (typeof SLOTS)[number];
export type ChatMessage = { role: "user"; content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> };
export type ChatClient = { complete(messages: ChatMessage[]): Promise<{ text: string; model?: string; usage?: unknown }> };

// One common scale for every image keeps all figures the same area, as in v2.
const SCALE = 48;
const CELL = 400;
const figures = FIGURES as unknown as ReadonlyArray<Figure>;

function centred(id: string, degrees: number, cx: number, cy: number): Point[][] {
  const figure = figures.find((f) => f.id === id);
  if (!figure) throw new TypeError("Unknown figure");
  const rotated = figure.pieces.map((p) => transformPolygon(p.points, { rotation: degrees }) as Point[]);
  const all = rotated.flat();
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
  const mx = (Math.min(...xs) + Math.max(...xs)) / 2, my = (Math.min(...ys) + Math.max(...ys)) / 2;
  return rotated.map((poly) => poly.map(([x, y]) => [cx + (x - mx) * SCALE, cy + (y - my) * SCALE] as Point));
}

/** One 400x400 silhouette, bounding-box centred. */
export function renderSingle(id: string, degrees: number): Buffer {
  return renderPolygons(centred(id, degrees, CELL / 2, CELL / 2), { width: CELL, height: CELL });
}

export type BoardEntry = { figureId: string; rotation: number };
/** 1200x800 unlabeled 2x3 board; entries are in SLOTS order. */
export function renderBoard(entries: readonly BoardEntry[]): Buffer {
  if (entries.length !== 6) throw new TypeError("A board has exactly six entries");
  const polygons = entries.flatMap((e, i) => centred(e.figureId, e.rotation, (i % 3) * CELL + CELL / 2, Math.floor(i / 3) * CELL + CELL / 2));
  return renderPolygons(polygons, { width: CELL * 3, height: CELL * 2 });
}

export function imagePart(png: Buffer) {
  return { type: "image_url" as const, image_url: { url: "data:image/png;base64," + png.toString("base64") } };
}

/** Deterministic PRNG, so every item (and its dry-run plan) is reproducible. */
export function randomSource(scope: string): () => number {
  let state = createHash("sha256").update("rotation-bench-v1:" + scope).digest().readUInt32LE();
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function parseJson(text: string): unknown {
  const body = String(text).replace(/^\s*```(?:json)?/u, "").replace(/```\s*$/u, "").trim();
  try { return JSON.parse(body); } catch { return null; }
}

export function parseSlot(text: string): Slot | null {
  const value = parseJson(text) as { slot?: unknown } | null;
  return SLOTS.includes(value?.slot as Slot) ? (value!.slot as Slot) : null;
}

export function parseSame(text: string): boolean | null {
  const value = parseJson(text) as { same?: unknown } | null;
  return typeof value?.same === "boolean" ? value.same : null;
}

/** Wilson 95% interval for k successes out of n. */
export function wilson(k: number, n: number): [number, number] {
  if (!n) return [0, 1];
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / d, half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** Exact one-sided binomial P(X >= k) under chance p. */
export function binomialTail(k: number, n: number, p: number): number {
  let total = 0;
  for (let i = k; i <= n; i++) {
    let c = 1;
    for (let j = 0; j < i; j++) c = c * (n - j) / (j + 1);
    total += c * p ** i * (1 - p) ** (n - i);
  }
  return Math.min(1, total);
}

/** Forbidden-substring scan for prompts: figure ids, slot answer, key words. */
export function leakFindings(text: string): string[] {
  const findings: string[] = [];
  if (/\bF[1-6]\b/u.test(text)) findings.push("figure_id");
  if (/s-[0-9a-f]{4}/u.test(text)) findings.push("local_id");
  if (/正解|answer|key|figureId/iu.test(text)) findings.push("key_word");
  return findings;
}
