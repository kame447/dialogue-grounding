#!/usr/bin/env node
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "../config.mjs";
import { createChatClient } from "../client.mjs";
import { createNamingTask, NamingTaskError, outsideRepositoryDirectory } from "../naming-task.mjs";
import { createNamingTaskV2 } from "../v2/naming-task-v2.mjs";
import { createDecisionComparisonClient } from "../decisions-client.mjs";
import { createGroundingJudgeClient } from "../grounding/client.ts";
import { readLocalOperatorOptions } from "./local-operator-options.ts";
import { attachLocalShutdown } from "./local-shutdown.ts";
import { applyQuestionnaire, lockResult, participantReview, QUESTIONNAIRE_FORM, recordListEntry, sortRecordList } from "../v2/participant-records.ts";

const PUBLIC = dirname(fileURLToPath(import.meta.url));
// "/" serves the v2 participant UI; "/v1/" keeps the original v1 (2x3 grid) UI unchanged.
const FILES = { "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"], "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/v1/": ["v1/index.html", "text/html; charset=utf-8"],
  "/v1/app.js": ["v1/app.js", "text/javascript; charset=utf-8"], "/v1/style.css": ["v1/style.css", "text/css; charset=utf-8"] };
const PAGES = ["/", "/v1/"];
const MAX_BODY = 64 * 1024;
const MAX_SESSIONS = 64;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Writes the provisional questionnaire beside the trial record (<recordId>.questionnaire.json), never inside the repository. */
async function writeQuestionnaireFile(runDir, recordId, questionnaire) {
  if (!runDir) return;
  const directory = await outsideRepositoryDirectory(runDir);
  const temporary = join(directory, "." + recordId + ".questionnaire.tmp");
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify({ recordId, questionnaire }, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, join(directory, recordId + ".questionnaire.json"));
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
    throw new NamingTaskError("record_write_failed");
  }
}

async function readJSON(req) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new NamingTaskError("invalid_request");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new NamingTaskError("invalid_request");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new NamingTaskError("invalid_request"); }
}

export { createBaseParticipantServer as createNamingServer } from "./base-participant-server.ts";
import { createBaseParticipantServer as createNamingServer } from "./base-participant-server.ts";

export async function startNamingServer({ port = 8787, ...options } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new NamingTaskError("invalid_port");
  const server = createNamingServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return server;
}

export async function main(argv = process.argv.slice(2), env = process.env,
  { createClient = createChatClient, createDecisionClient = createDecisionComparisonClient, createGroundingClient = createGroundingJudgeClient,
    startServer = startNamingServer } = {}) {
  const { values } = parseArgs({ args: argv, options: { port: { type: "string", default: "8787" },
    "base-assignment-file": { type: "string" }, "base-store-root": { type: "string" },
    "hide-strategy": { type: "boolean", default: false }, "active-decision-judge": { type: "string" }, "utterance-style": { type: "string" },
    "grounding-shadow": { type: "boolean", default: false }, help: { type: "boolean" } } });
  if (values.help) {
    console.log("node --env-file=.env dialogue-model/runtime/web/server.mjs --port 8787 [--base-assignment-file <private-file>] [--base-store-root <private-directory>] [--hide-strategy] [--active-decision-judge decision_jev|decision_luna] [--utterance-style default|concise] [--grounding-shadow]");
    return;
  }
  const purpose = values["active-decision-judge"];
  if (purpose !== undefined && !["decision_jev", "decision_luna"].includes(purpose)) throw new Error("Invalid active decision purpose");
  const operatorOptions = readLocalOperatorOptions(env);
  const config = loadConfig(env);
  const client = createClient(config);
  const activeDecision = purpose === undefined ? null : { client: createDecisionClient(config), purpose };
  // Research-only shadow (default off): records two-axis grounding evidence privately, never changes the dialogue.
  const groundingShadow = values["grounding-shadow"] ? { judge: createGroundingClient(config) } : null;
  const server = await startServer({ port: Number(values.port), client, runDir: env.RESEARCH_RUN_DIR, hideStrategy: values["hide-strategy"], activeDecision, ...operatorOptions,
    baseAssignmentFile: values["base-assignment-file"], baseStoreRoot: values["base-store-root"],
    utteranceStyle: values["utterance-style"] ?? "default", ...(groundingShadow ? { groundingShadow } : {}) });
  console.log("共同命名課題: http://127.0.0.1:" + server.address().port);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(server => { if (server) attachLocalShutdown(server); })
    .catch(() => { console.error("起動できませんでした。接続設定とポートを確認してください。"); process.exitCode = 1; });
}
