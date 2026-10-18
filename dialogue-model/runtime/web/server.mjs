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
import { createNamingTaskV2 } from "../v2/naming-task-v2.mjs";

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
  hideStrategy = false, now = Date.now, createTask = createNamingTask, createTaskV2 = createNamingTaskV2 } = {}) {
  const sessions = new Map();
  const reclaimable = (session) => {
    if (session.requests || session.starting) return false;
    const state = session.task?.getState();
    return !state?.busy && (!state || ["completed", "submission_error"].includes(state.status));
  };
  function expireSessions(timestamp) {
    // Never expire an unfinished trial, including a retryable submission or
    // scoring failure. Deleting the entry also releases its in-memory images.
    for (const [id, session] of sessions) {
      if (timestamp - session.lastAccess >= SESSION_IDLE_MS && reclaimable(session)) sessions.delete(id);
    }
  }
  function makeRoom() {
    if (sessions.size < MAX_SESSIONS) return true;
    let oldest;
    for (const entry of sessions) {
      const session = entry[1];
      if (reclaimable(session) && (!session.task || session.task.getState().status === "completed") &&
          (!oldest || session.lastAccess < oldest[1].lastAccess)) oldest = entry;
    }
    if (oldest) sessions.delete(oldest[0]);
    return sessions.size < MAX_SESSIONS;
  }
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(value));
    };
    let session;
    try {
      const expectedHost = "127.0.0.1:" + res.socket.localPort;
      if (req.headers.host !== expectedHost ||
          (req.headers.origin && req.headers.origin !== "http://" + expectedHost)) return json(403, { error: "request_forbidden" });
      const pathname = new URL(req.url, "http://" + expectedHost).pathname;
      const timestamp = now();
      expireSessions(timestamp);
      const cookie = req.headers.cookie?.match(/(?:^|;\s*)naming_session=([a-f0-9]{64})(?:;|$)/)?.[1];
      session = sessions.get(cookie);
      if (session) { session.lastAccess = timestamp; session.requests++; }
      if (req.method === "GET" && Object.hasOwn(FILES, pathname)) {
        const [file, type] = FILES[pathname];
        if (PAGES.includes(pathname) && !session) {
          if (!makeRoom()) return json(503, { error: "session_limit" });
          const id = randomBytes(32).toString("hex");
          session = { task: null, starting: false, lastAccess: timestamp, requests: 1 };
          sessions.set(id, session);
          res.setHeader("Set-Cookie", "naming_session=" + id + "; HttpOnly; SameSite=Strict; Path=/");
        }
        res.writeHead(200, { "Content-Type": type });
        return res.end(await readFile(resolve(PUBLIC, file)));
      }
      if (!session) return json(401, { error: "session_required" });
      const state = () => {
        const value = session.task ? { ...session.task.getState() } : null;
        if (value) { delete value.visualAid; delete value.referenceMemory; }
        if (value && hideStrategy) delete value.strategy;
        return { trial: value, hideStrategy, busy: session.starting || Boolean(value?.busy) };
      };
      if (req.method === "GET" && pathname === "/api/state") return json(200, state());
      if (req.method === "GET" && pathname === "/api/image") {
        if (!session.task) return json(409, { error: "trial_required" });
        // v2 participants see their own scene as vector paths; no PNG route.
        if (session.task.version === 2) return json(404, { error: "not_found" });
        const image = session.task.getHumanImage();
        res.writeHead(200, { "Content-Type": image.mimeType });
        return res.end(image.png);
      }
      const V1_ROUTES = ["/api/turn", "/api/submit"], V2_ROUTES = ["/api/message", "/api/names", "/api/retry"];
      if (req.method !== "POST" || !["/api/start", "/api/ai-submit", ...V1_ROUTES, ...V2_ROUTES].includes(pathname)) return json(404, { error: "not_found" });
      const body = await readJSON(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new NamingTaskError("invalid_request");
      if (pathname === "/api/start") {
        const { visualAid = false, referenceMemory = false, version = 1 } = body;
        if (typeof visualAid !== "boolean" || typeof referenceMemory !== "boolean" || ![1, 2].includes(version)) throw new NamingTaskError("invalid_request");
        // v2 keeps the visual aid off: measured as no benefit, and it is a v1 ablation only.
        if (version === 2 && visualAid) throw new NamingTaskError("invalid_request");
        if (session.starting || session.task?.getState().busy) throw new NamingTaskError("busy");
        session.starting = true;
        try {
          session.task = version === 2
            ? await createTaskV2({ client, runDir, strategy: body.strategy, seed: body.seed, referenceMemory })
            : await createTask({ client, createTrial, scoreTrial, runDir, strategy: body.strategy, seed: body.seed, visualAid, referenceMemory });
        } finally { session.starting = false; }
      } else {
        if (!session.task) throw new NamingTaskError("trial_required");
        if (session.starting) throw new NamingTaskError("busy");
        const isV2 = session.task.version === 2;
        if ((isV2 && V1_ROUTES.includes(pathname)) || (!isV2 && V2_ROUTES.includes(pathname))) return json(404, { error: "not_found" });
        if (pathname === "/api/message") {
          const receipt = session.task.message(body.text, typeof body.clientId === "string" ? body.clientId.slice(0, 80) : undefined);
          return json(202, { eventId: receipt.eventId, ...state() });
        }
        if (pathname === "/api/retry") await session.task.retry();
        if (pathname === "/api/names") {
          if (body.confirm !== true) throw new NamingTaskError("invalid_submission");
          await session.task.submitHuman({ names: body.names });
          if (!session.task.getState().aiSubmitted) await session.task.submitAI();
        }
        if (pathname === "/api/turn") await session.task.turn(body.utterance);
        if (pathname === "/api/ai-submit") await session.task.submitAI();
        if (pathname === "/api/submit") {
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
        "ai_unavailable", "scoring_error", "record_write_failed", "repository_output_forbidden", "invalid_output_directory",
        "invalid_message", "invalid_options", "ai_busy", "ai_retry_required", "submission_error"];
      const code = error instanceof NamingTaskError && allowed.includes(error.code) ? error.code : "operation_failed";
      if (!res.headersSent) json(code === "scoring_error" ? 500 : ["ai_unavailable", "invalid_ai_submission"].includes(code) ? 502
        : ["ai_busy", "ai_retry_required"].includes(code) ? 409 : 400, { error: code });
      else res.end();
    } finally {
      if (session) { session.requests--; session.lastAccess = now(); }
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
