#!/usr/bin/env node
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "../config.mjs";
import { createChatClient } from "../client.mjs";
import { createNamingTask, NamingTaskError } from "../naming-task.mjs";

const PUBLIC = dirname(fileURLToPath(import.meta.url));
const FILES = { "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"], "/style.css": ["style.css", "text/css; charset=utf-8"] };
const MAX_BODY = 64 * 1024;

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

export function createNamingServer({ client, createTrial, scoreTrial, runDir = process.env.RESEARCH_RUN_DIR,
  hideStrategy = false } = {}) {
  const sessions = new Map();
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(value));
    };
    try {
      const expectedHost = "127.0.0.1:" + res.socket.localPort;
      if (req.headers.host !== expectedHost ||
          (req.headers.origin && req.headers.origin !== "http://" + expectedHost)) return json(403, { error: "request_forbidden" });
      if (req.method === "GET" && FILES[req.url]) {
        const [file, type] = FILES[req.url];
        const cookie = req.headers.cookie?.match(/(?:^|;\s*)naming_session=([a-f0-9]{64})(?:;|$)/)?.[1];
        if (req.url === "/" && !sessions.has(cookie)) {
          if (sessions.size >= 64) return json(503, { error: "session_limit" });
          const id = randomBytes(32).toString("hex");
          sessions.set(id, { task: null, starting: false });
          res.setHeader("Set-Cookie", "naming_session=" + id + "; HttpOnly; SameSite=Strict; Path=/");
        }
        res.writeHead(200, { "Content-Type": type });
        return res.end(await readFile(resolve(PUBLIC, file)));
      }
      const cookie = req.headers.cookie?.match(/(?:^|;\s*)naming_session=([a-f0-9]{64})(?:;|$)/)?.[1];
      const session = sessions.get(cookie);
      if (!session) return json(401, { error: "session_required" });
      const state = () => {
        const value = session.task?.getState() ?? null;
        if (value && hideStrategy) delete value.strategy;
        return { trial: value, hideStrategy, busy: session.starting || Boolean(value?.busy) };
      };
      if (req.method === "GET" && req.url === "/api/state") return json(200, state());
      if (req.method === "GET" && req.url === "/api/image") {
        if (!session.task) return json(409, { error: "trial_required" });
        const image = session.task.getHumanImage();
        res.writeHead(200, { "Content-Type": image.mimeType });
        return res.end(image.png);
      }
      if (req.method !== "POST" || !["/api/start", "/api/turn", "/api/submit", "/api/ai-submit"].includes(req.url)) return json(404, { error: "not_found" });
      const body = await readJSON(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new NamingTaskError("invalid_request");
      if (req.url === "/api/start") {
        if (session.starting || session.task?.getState().busy) throw new NamingTaskError("busy");
        session.starting = true;
        try {
          session.task = await createNamingTask({ client, createTrial, scoreTrial, runDir, strategy: body.strategy, seed: body.seed });
        } finally { session.starting = false; }
      } else {
        if (!session.task) throw new NamingTaskError("trial_required");
        if (session.starting) throw new NamingTaskError("busy");
        if (req.url === "/api/turn") await session.task.turn(body.utterance);
        if (req.url === "/api/ai-submit") await session.task.submitAI();
        if (req.url === "/api/submit") {
          await session.task.submitHuman(body.submission);
          const current = session.task.getState();
          if (!current.aiSubmitted && current.status !== "submission_error") await session.task.submitAI();
        }
      }
      return json(200, state());
    } catch (error) {
      // Neither exception messages nor upstream bodies cross this boundary.
      const allowed = ["invalid_strategy", "invalid_seed", "invalid_submission", "invalid_utterance", "invalid_request",
        "busy", "dialogue_closed", "already_submitted", "trial_required", "invalid_ai_submission",
        "ai_unavailable", "record_write_failed", "repository_output_forbidden", "invalid_output_directory"];
      const code = error instanceof NamingTaskError && allowed.includes(error.code) ? error.code : "operation_failed";
      if (!res.headersSent) json(["ai_unavailable", "invalid_ai_submission"].includes(code) ? 502 : 400, { error: code });
      else res.end();
    }
  });
}

export async function startNamingServer({ port = 8787, ...options } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new NamingTaskError("invalid_port");
  const server = createNamingServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return server;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({ args: argv, options: { port: { type: "string", default: "8787" },
    "hide-strategy": { type: "boolean", default: false }, help: { type: "boolean" } } });
  if (values.help) {
    console.log("node --env-file=.env dialogue-model/runtime/web/server.mjs --port 8787 [--hide-strategy]");
    return;
  }
  const client = createChatClient(loadConfig(env));
  const server = await startNamingServer({ port: Number(values.port), client, runDir: env.RESEARCH_RUN_DIR, hideStrategy: values["hide-strategy"] });
  console.log("共同命名課題: http://127.0.0.1:" + server.address().port);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error("起動できませんでした。接続設定とポートを確認してください。"); process.exitCode = 1; });
}
