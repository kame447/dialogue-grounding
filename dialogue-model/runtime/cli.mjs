#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.mjs";
import { createChatClient } from "./client.mjs";
import { createDialogueSession, STRATEGIES } from "./session.mjs";
import { readParticipantImage } from "./image.mjs";

const HELP = [
  "Research dialogue AI connection (Node.js >= 22)",
  "node --env-file=.env dialogue-model/runtime/cli.mjs --smoke",
  "node --env-file=.env dialogue-model/runtime/cli.mjs --check",
  "node --env-file=.env dialogue-model/runtime/cli.mjs --show-model",
  "node --env-file=.env dialogue-model/runtime/cli.mjs --strategy repair-first --image /path/my-tangrams.png",
  "node --env-file=.env dialogue-model/runtime/cli.mjs --strategy bypass-enabled --image /path/my-tangrams.png --message 'この図形はどう呼びますか？'",
  "The image must show ONLY the AI participant's own six figures.",
].join("\n");

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean" },
      check: { type: "boolean" },
      "show-model": { type: "boolean" },
      smoke: { type: "boolean" },
      strategy: { type: "string" },
      image: { type: "string" },
      message: { type: "string" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(HELP);
    return;
  }

  const config = loadConfig(env);
  if (values.check) {
    console.log("Configured provider=" + config.provider +
      (config.purpose ? " purpose=" + config.purpose : " model=" + config.model) +
      " endpoint=" + config.baseUrl + " (no request sent)");
    return;
  }

  const client = createChatClient(config);
  if (values["show-model"]) {
    const policy = await client.getModelPolicy();
    console.log("Worker purpose=" + policy.purpose + " provider=" + policy.provider +
      " model=" + policy.model + " ready=" + policy.ready);
    return;
  }
  if (values.smoke) {
    const result = await client.complete([
      { role: "user", content: "日本語で短く挨拶してください。" },
    ]);
    console.log("AI API reachable: model=" + result.model);
    return;
  }

  if (!STRATEGIES.includes(values.strategy)) {
    throw new Error("--strategy must be repair-first or bypass-enabled");
  }
  if (!values.image) throw new Error("--image is required for a dialogue session");

  const image = await readParticipantImage(values.image);
  const session = createDialogueSession({ client, strategy: values.strategy, image });

  if (values.message !== undefined) {
    const result = await session.turn(values.message);
    console.log(result.text);
    return;
  }

  const readline = createInterface({ input: stdin, output: stdout });
  try {
    console.log("Dialogue strategy: " + values.strategy + " (type /exit to finish)");
    for (;;) {
      const utterance = await readline.question("相手> ");
      if (utterance.trim() === "/exit") break;
      if (!utterance.trim()) continue;
      const result = await session.turn(utterance);
      console.log("AI> " + result.text);
    }
  } finally {
    readline.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message || "Unexpected error");
    process.exitCode = 1;
  });
}
