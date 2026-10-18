// RESEARCHER ONLY. Feature-fit scorer: shows a separate Luna call the AI's six
// own-figure crops labelled A–F (a fixed order unrelated to ids or figures)
// plus feature texts, and asks which crops each feature describes. The
// label -> own-id map stays here; ids, key and gold never enter the prompt.
// Dry run: node scorer.ts --seed 137 --rows <replay.jsonl> [--rows <more.jsonl>]
// Live: add --live --cap <maxCalls> --out <dir outside repo> (writes scores.json, resumable).
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLayoutsV2 } from "../../stimuli/scatter-v2.mjs";
import { renderPolygons } from "../../stimuli/render.mjs";
import { loadConfig } from "../../config.mjs";
import { createChatClient } from "../../client.mjs";
import { parseArgs, outputDirectory, readJsonl, cappedClient } from "./common.ts";

export const LABELS = Object.freeze(["A", "B", "C", "D", "E", "F"]);
/** Board-order indices shown as A–F (fixed, not identity order). */
export const LABEL_ORDER = Object.freeze([3, 0, 5, 1, 4, 2]);
export const BATCH = 10;
export const SCORER_INSTRUCTION = "研究用の採点です。以下の6つの黒い図形（A〜F、各1枚）について、各特徴の説明が当てはまる図形をすべて選んでください。図形は回転して見てよく、向きを表す語（上下左右など）は回転を考慮して解釈してください。疑問文の形の説明も、述べている形の特徴として判定してください。どれにも当てはまらなければ空配列です。";
const PAD = 30;

export type Crop = { id: string; png: Buffer };

/** Own-board crops in board order; ids are local and never rendered. */
export function ownCrops(seed: number): Crop[] {
  return createLayoutsV2({ seed }).ai.map((p: any) => ({ id: p.id, png: renderPolygons(
    p.polygons.map((poly: number[][]) => poly.map(([x, y]) => [x - p.bbox.x + PAD, y - p.bbox.y + PAD])),
    { width: p.bbox.w + 2 * PAD, height: p.bbox.h + 2 * PAD }) }));
}

/** Pure prompt builder. One crop per message keeps each within the Worker's 4-part limit. */
export function buildScorerMessages(crops: readonly { png: Buffer }[], features: readonly string[]) {
  if (crops.length !== LABELS.length || features.length < 1 || features.length > BATCH) throw new Error("invalid_scorer_batch");
  return [
    { role: "system", content: SCORER_INSTRUCTION },
    ...LABEL_ORDER.map((index, i) => ({ role: "user", content: [
      { type: "text", text: "図形" + LABELS[i] + ":" },
      { type: "image_url", image_url: { url: "data:image/png;base64," + crops[index].png.toString("base64") } },
    ] })),
    { role: "user", content: "特徴:\n" + features.map((f, i) => `${i + 1}. ${f}`).join("\n") + "\nJSONだけを返してください。形式: {\"1\": [\"A\", ...], \"2\": [...], ...}" },
  ];
}

/** Map a scorer reply back to own ids; unknown labels are dropped. */
export function parseScorerReply(text: string, crops: readonly Crop[], features: readonly string[]): Record<string, { fits: string[] }> {
  const parsed = JSON.parse(text.replace(/^\s*```(?:json)?|```\s*$/g, "").trim());
  const idOf = Object.fromEntries(LABEL_ORDER.map((index, i) => [LABELS[i], crops[index].id]));
  const out: Record<string, { fits: string[] }> = {};
  features.forEach((feature, i) => {
    const value = parsed?.[String(i + 1)];
    if (Array.isArray(value)) out[feature] = { fits: [...new Set(value.filter((label) => Object.hasOwn(idOf, label)).map((label) => idOf[label]))] };
  });
  return out;
}

/** Every distinct feature text in replay rows: chosen features and candidate features. */
export function featuresOf(rows: any[]): string[] {
  const set = new Set<string>();
  for (const row of rows) for (const value of [row.judgment?.discriminatingFeature, row.judgment?.followUp?.discriminatingFeature,
    ...(row.diagnostics?.conflict?.candidates ?? []).map((c: any) => c.feature)]) if (typeof value === "string" && value) set.add(value);
  return [...set];
}

export async function main(argv = process.argv.slice(2), log = console.log) {
  const args = parseArgs(argv, ["seed", "rows"]);
  const out = await outputDirectory(args);
  const seed = Number(args.values.get("seed")?.[0]);
  if (!Number.isSafeInteger(seed)) throw new Error("seed_required");
  const features = featuresOf((args.values.get("rows") ?? []).flatMap((path) => readJsonl(path)));
  const file = out ? join(out, "scores.json") : null;
  const scores: Record<string, { fits: string[] }> = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const todo = features.filter((f) => !scores[f]);
  const batches = Array.from({ length: Math.ceil(todo.length / BATCH) }, (_, i) => todo.slice(i * BATCH, (i + 1) * BATCH));
  log(JSON.stringify({ mode: args.live ? "live" : "dry-run", features: features.length, todo: todo.length, calls: batches.length, cap: args.cap }));
  if (!args.live || !file) return { features, batches };
  if (args.cap < 1) throw new Error("cap_required");
  const crops = ownCrops(seed);
  const { client, usage } = cappedClient(createChatClient(loadConfig(process.env)), args.cap);
  for (const batch of batches) {
    try { Object.assign(scores, parseScorerReply((await client.complete(buildScorerMessages(crops, batch), { phase: "scorer" })).text, crops, batch)); }
    catch (error: any) { log(JSON.stringify({ error: error?.code ?? error?.message ?? "scorer_error", status: error?.status ?? null })); if (error?.message === "call_cap_reached") break; }
    writeFileSync(file, JSON.stringify(scores, null, 1));
  }
  log(JSON.stringify({ ...usage, scored: features.filter((f) => scores[f]).length, of: features.length }));
  return { features, batches, usage };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { console.error(JSON.stringify({ error: error?.message ?? "error" })); process.exitCode = 1; });
