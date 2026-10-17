#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stdin, stdout } from "node:process";
import { loadConfig } from "./config.mjs";
import { createChatClient } from "./client.mjs";
import { createNamingTask, SLOTS, STRATEGIES, validateSubmission, outsideRepositoryDirectory, NamingTaskError } from "./naming-task.mjs";

const HELP = [
  "6図形共同命名（操作確認用プロトタイプ）",
  "node --env-file=.env dialogue-model/runtime/naming-cli.mjs --strategy repair-first --seed 1 --image-dir /outside/repository/images",
  "非対話: 上記に --script /outside/repository/turns.jsonl を追加",
  'JSONL: {"utterance":"公開発話"} または公開発話のJSON文字列。最終行は {"submission":{"上段左":"名称",...6位置}} にできます。',
  "/submit で6位置の名称を順に入力して確定。/submit <JSON> も使用可能。/exit で終了。",
  "AI最終提出は人間の提出後に照合します。実験条件・採点は暫定です。",
].join("\n");

function scriptActions(text) {
  if (text.length > 2 * 1024 * 1024) throw new NamingTaskError("invalid_script");
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    let value;
    try { value = JSON.parse(line); } catch { throw new NamingTaskError("invalid_script"); }
    if (typeof value === "string") value = { utterance: value };
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1) throw new NamingTaskError("invalid_script");
    if (Object.hasOwn(value, "utterance") && typeof value.utterance === "string" && value.utterance.trim() && value.utterance.length <= 12000) return value;
    if (Object.hasOwn(value, "submission")) return { submission: validateSubmission(value.submission) };
    throw new NamingTaskError("invalid_script");
  });
}

export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const output = dependencies.output ?? stdout;
  const input = dependencies.input ?? stdin;
  const say = (text) => output.write(text + "\n");
  const { values } = parseArgs({ args: argv, options: {
    help: { type: "boolean" }, strategy: { type: "string" }, seed: { type: "string" },
    "image-dir": { type: "string" }, script: { type: "string" },
  } });
  if (values.help) { say(HELP); return; }
  if (!STRATEGIES.includes(values.strategy) || !values.seed?.trim() || !values["image-dir"]) throw new NamingTaskError("invalid_cli_options");
  const seed = Number(values.seed);
  if (!/^-?\d+$/.test(values.seed) || !Number.isSafeInteger(seed)) throw new NamingTaskError("invalid_seed");
  const actions = values.script ? scriptActions(await readFile(values.script, "utf8")) : null;
  const imageDir = await outsideRepositoryDirectory(values["image-dir"]);
  const client = dependencies.client ?? createChatClient(loadConfig(env));
  const task = await createNamingTask({ client, strategy: values.strategy, seed,
    createTrial: dependencies.createTrial, scoreTrial: dependencies.scoreTrial, runDir: env.RESEARCH_RUN_DIR });
  await mkdir(imageDir, { recursive: true, mode: 0o700 });
  if (await outsideRepositoryDirectory(imageDir) !== imageDir) throw new NamingTaskError("repository_output_forbidden");
  const imagePath = join(imageDir, "human-" + randomUUID() + ".png");
  await writeFile(imagePath, task.getHumanImage().png, { mode: 0o600, flag: "wx" });
  say("あなたの画像: " + imagePath);
  say("画像の6図形は2段3列です。相手の画面では配置と向きが異なります。");
  say("/submit で最終提出、/exit で終了します。採点規則は暫定です。");
  async function turn(utterance) {
    const state = await task.turn(utterance);
    say("AI> " + state.publicHistory.at(-1).content);
  }
  async function submit(submission) {
    await task.submitHuman(submission);
    const state = await task.submitAI();
    say("照合結果（暫定・provisional）: " + JSON.stringify({ aiSubmission: state.aiSubmission, result: state.result }));
  }
  if (actions) {
    // Parse all lines before making any API request; never add future lines to context.
    for (const action of actions) {
      if (Object.hasOwn(action, "utterance")) await turn(action.utterance);
      else await submit(action.submission);
    }
    return task.getState();
  }
  const readline = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY), crlfDelay: Infinity });
  const lines = readline[Symbol.asyncIterator]();
  try {
    for (;;) {
      output.write("あなた> ");
      const next = await lines.next();
      if (next.done) break;
      const text = next.value.trim();
      if (text === "/exit") break;
      if (!text) continue;
      if (text === "/submit" || text.startsWith("/submit ")) {
        let submission;
        if (text.startsWith("/submit ")) {
          try { submission = validateSubmission(JSON.parse(text.slice(8))); }
          catch { throw new NamingTaskError("invalid_submission"); }
        } else {
          submission = {};
          for (const slot of SLOTS) {
            output.write(slot + "の名称（未命名は空欄）> ");
            const name = await lines.next();
            if (name.done || name.value.trim() === "/exit") return task.getState();
            submission[slot] = name.value;
          }
        }
        await submit(submission);
        break;
      }
      try { await turn(text); }
      catch (error) {
        if (!(error instanceof NamingTaskError) || error.code !== "ai_unavailable") throw error;
        say("AIに接続できませんでした。発話は確定していません。再入力できます。");
      }
    }
  } finally { readline.close(); }
  return task.getState();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error("共同命名課題を完了できませんでした。引数、接続設定、リポジトリ外の保存先を確認してください。");
    process.exitCode = 1;
  });
}
