#!/usr/bin/env node
// Researcher-only diagnostic, not an experiment trial. It measures whether the
// dialogue model can recognise one of its own figures when shown a single
// figure cropped from the other board (rotated by a multiple of 90 degrees).
// The partner crop is used only here; the naming task never sends it to the AI.
// The answer key is used only to score answers after each request.
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config.mjs";
import { createChatClient } from "../client.mjs";
import { createTrial, SLOTS } from "../stimuli/board.mjs";
import { cropOwnCells, createOwnImageRotationSheet, OWN_SLOT_LABELS } from "../visual/own-image-rotation.mjs";

export const CONDITIONS = Object.freeze(["original", "visual-aided"]);

const image = (png) => ({ type: "image_url", image_url: { url: "data:image/png;base64," + png.toString("base64") } });

const QUESTION = [
  "研究用の画像認識の確認です（対話課題ではありません）。",
  "最初の画像はあなたの6図形の盤面です。位置名は 上段左・上段中・上段右・下段左・下段中・下段右 です。",
  "最後の画像の図形1つは、あなたの6図形のどれか1つと同じ形で、向きだけが90度単位で回転している可能性があります（鏡映はありません）。",
  "どの位置の図形と同じ形かを、JSONのみで答えてください。形式: {\"slot\":\"<位置名>\"}",
].join("\n");

/** Build the request for one partner crop. Conditions differ only by the own-board aid. */
export function buildMessages({ ownPng, partnerCropPng, condition }) {
  if (!CONDITIONS.includes(condition)) throw new Error("Unsupported condition");
  const messages = [{ role: "user", content: [{ type: "text", text: QUESTION }, image(ownPng)] }];
  if (condition === "visual-aided") {
    const sheet = createOwnImageRotationSheet(ownPng, { enabled: true });
    const legend = Object.entries(OWN_SLOT_LABELS).map(([label, slot]) => label + "=" + slot).join("、");
    messages.push({ role: "user", content: [
      { type: "text", text: "補助画像: あなた自身の6図形をそれぞれ0/90/180/270度（時計回り）に回転して並べたものです。ラベルの対応: " + legend + "。" },
      image(sheet.png),
    ] });
  }
  messages.push({ role: "user", content: [{ type: "text", text: "照合する図形:" }, image(partnerCropPng)] });
  return messages;
}

export function parseSlot(text) {
  try {
    const value = JSON.parse(String(text).replace(/^\s*```(?:json)?|```\s*$/g, "").trim());
    return SLOTS.includes(value?.slot) ? value.slot : null;
  } catch {
    return null;
  }
}

/** Plan every request without sending anything. */
export function plan({ seeds, conditions = CONDITIONS }) {
  return seeds.flatMap((seed) => conditions.flatMap((condition) =>
    SLOTS.map((partnerSlot) => ({ seed, condition, partnerSlot }))));
}

export async function runBenchmark({ client, seeds, conditions = CONDITIONS }) {
  const results = [];
  for (const seed of seeds) {
    const trial = createTrial({ seed });
    const partnerCrops = cropOwnCells(trial.human.png);
    for (const condition of conditions) {
      for (const [index, partnerSlot] of SLOTS.entries()) {
        const messages = buildMessages({ ownPng: trial.ai.png, partnerCropPng: partnerCrops[index], condition });
        let answer = null, error = null, usage = null;
        try {
          const response = await client.complete(messages);
          answer = parseSlot(response.text);
          usage = response.usage;
        } catch (failure) {
          error = failure?.code || "request_failed";
        }
        // Scoring happens after the response; the key never enters the request.
        const figure = trial.key.human[partnerSlot];
        const expected = SLOTS.find((slot) => trial.key.ai[slot] === figure);
        results.push({ seed, condition, partnerSlot, answer, correct: answer === expected, error, usage });
      }
    }
  }
  const summary = Object.fromEntries(conditions.map((condition) => {
    const rows = results.filter((row) => row.condition === condition);
    return [condition, { correct: rows.filter((row) => row.correct).length, total: rows.length,
      errors: rows.filter((row) => row.error).length }];
  }));
  return { summary, results };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({ args: argv, options: {
    seeds: { type: "string", default: "9,10" },
    conditions: { type: "string", default: CONDITIONS.join(",") },
    live: { type: "boolean", default: false },
  } });
  const seeds = values.seeds.split(",").map(Number);
  if (!seeds.every(Number.isSafeInteger)) throw new Error("--seeds must be integers");
  const conditions = values.conditions.split(",");
  if (!conditions.every((condition) => CONDITIONS.includes(condition))) throw new Error("Unknown condition");
  const requests = plan({ seeds, conditions });
  if (!values.live) {
    console.log(JSON.stringify({ dryRun: true, requests: requests.length, seeds, conditions }));
    return;
  }
  const { summary, results } = await runBenchmark({ client: createChatClient(loadConfig(env)), seeds, conditions });
  console.log(JSON.stringify({ summary, perSeed: seeds.map((seed) => ({ seed, ...Object.fromEntries(conditions.map((condition) => [condition,
    results.filter((row) => row.seed === seed && row.condition === condition && row.correct).length])) })) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message || "Unexpected error");
    process.exitCode = 1;
  });
}
