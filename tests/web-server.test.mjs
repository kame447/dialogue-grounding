import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { startNamingServer } from "../dialogue-model/runtime/web/server.mjs";
import { SLOTS } from "../dialogue-model/runtime/naming-task.mjs";
import { createChatClient } from "../dialogue-model/runtime/client.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2qwAAAABJRU5ErkJggg==", "base64");
const names = (prefix) => Object.fromEntries(SLOTS.map((slot, i) => [slot, prefix + i]));
const trial = ({ seed }) => ({ trialId: "web-trial", seed, human: { png, mimeType: "image/png" }, ai: { png, mimeType: "image/png" },
  key: { human: names("PRIVATE-FIGURE"), ai: names("PRIVATE-FIGURE") } });
const score = ({ humanSubmission, aiSubmission }) => ({ provisional: true, success: true,
  figures: SLOTS.map((humanSlot) => ({ human: { slot: humanSlot, rawName: humanSubmission[humanSlot] }, ai: { slot: humanSlot, rawName: aiSubmission[humanSlot] }, matched: true })) });

async function setup(t, { hideStrategy = false, fail = false } = {}) {
  const payloads = [];
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    payloads.push(JSON.parse(Buffer.concat(chunks)));
    if (fail) { res.writeHead(500); res.end("RAW-ERROR-SECRET-TOKEN-PROMPT-IMAGE"); return; }
    const final = payloads.at(-1).messages.at(-1).content.includes("最終提出要求");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: "mock", choices: [{ message: { content: final ? JSON.stringify(names("AI-PRIVATE-")) : "公開AI発話" } }] }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const client = createChatClient({ provider: "cloudflare", purpose: "dialogue_turn", apiKey: "PRIVATE-TEST-KEY",
    baseUrl: "http://127.0.0.1:" + upstream.address().port + "/v1" });
  const server = await startNamingServer({ port: 0, client, createTrial: trial, scoreTrial: score, runDir: "", hideStrategy });
  t.after(async () => {
    await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => upstream.close(r))]);
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const page = await fetch(base);
  const cookie = page.headers.get("set-cookie").split(";")[0];
  async function request(path, body, extra = {}) {
    return fetch(base + path, { headers: { cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...extra },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  }
  return { server, base, page, cookie, payloads, request };
}

test("local Web workflow serves own image, public chat, private submission, then provisional per-figure result", async (t) => {
  const { server, page, request, payloads } = await setup(t, { hideStrategy: true });
  assert.equal(server.address().address, "127.0.0.1");
  assert.match(await page.text(), /研究者用：試行の開始/);
  assert.match(page.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  let response = await request("/api/start", { strategy: "bypass-enabled", seed: 102 });
  assert.equal(response.status, 200);
  let state = await response.json();
  assert.ok(!Object.hasOwn(state.trial, "strategy"));
  assert.equal(state.trial.seed, 102);
  const image = await request("/api/image");
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  state = await (await request("/api/turn", { utterance: "公開人間発話" })).json();
  assert.equal(state.trial.publicHistory.length, 2);
  state = await (await request("/api/ai-submit", {})).json();
  assert.equal(state.trial.aiSubmitted, true);
  assert.ok(!Object.hasOwn(state.trial, "aiSubmission"));
  assert.ok(!JSON.stringify(state).includes("AI-PRIVATE-"));
  assert.ok(!Object.hasOwn((await (await request("/api/state")).json()).trial, "result"));
  const human = names("HUMAN-PRIVATE-");
  response = await request("/api/submit", { submission: human });
  assert.equal(response.status, 200);
  state = await response.json();
  assert.equal(state.trial.status, "completed");
  assert.equal(state.trial.result.provisional, true); assert.equal(state.trial.result.figures.length, 6);
  assert.equal(state.trial.aiSubmission[SLOTS[0]], "AI-PRIVATE-0");
  assert.doesNotMatch(JSON.stringify(payloads), /HUMAN-PRIVATE|PRIVATE-FIGURE/);
  assert.equal((await request("/api/turn", { utterance: "終了後" })).status, 400);
});

test("submitting human names first triggers private AI final request, without transmitting human names", async (t) => {
  const { request, payloads } = await setup(t);
  await request("/api/start", { strategy: "repair-first", seed: 100 });
  const result = await (await request("/api/submit", { submission: names("PRIVATE-HUMAN") })).json();
  assert.equal(result.trial.status, "completed"); assert.equal(payloads.length, 1);
  assert.doesNotMatch(JSON.stringify(payloads), /PRIVATE-HUMAN/);
});

test("Web errors never return raw API errors, prompts, images, or tokens; failed turn is not committed", async (t) => {
  const { request } = await setup(t, { fail: true });
  await request("/api/start", { strategy: "repair-first", seed: 100 });
  const response = await request("/api/turn", { utterance: "PRIVATE-PROMPT-TEXT" });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "ai_unavailable" });
  const state = await (await request("/api/state")).json();
  assert.deepEqual(state.trial.publicHistory, []);
  const submitted = await request("/api/submit", { submission: names("human") });
  assert.equal(submitted.status, 502);
  assert.deepEqual(await submitted.json(), { error: "ai_unavailable" });
  const failed = await (await request("/api/state")).json();
  assert.equal(failed.trial.humanSubmitted, true); assert.equal(failed.trial.status, "submission_error");
  assert.ok(!Object.hasOwn(failed.trial, "result"));
});

test("Web rejects cross-origin/foreign host requests and isolates browser sessions", async (t) => {
  const { base, request } = await setup(t);
  assert.equal((await fetch(base + "/api/state")).status, 401);
  assert.equal((await request("/api/start", { strategy: "repair-first", seed: 100 }, { Origin: "https://untrusted.invalid" })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(base + "/api/state", { headers: { Host: "attacker.invalid" } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject); req.end();
  });
  assert.equal(foreignHostStatus, 403);
  await request("/api/start", { strategy: "repair-first", seed: 100 });
  const otherPage = await fetch(base);
  const otherCookie = otherPage.headers.get("set-cookie").split(";")[0];
  const other = await fetch(base + "/api/state", { headers: { cookie: otherCookie } });
  assert.equal((await other.json()).trial, null);
  assert.equal((await request("/does-not-exist")).status, 404);
  assert.equal((await request("/api/start", { strategy: "unsupported", seed: 100 })).status, 400);
  const current = await (await request("/api/state")).json();
  assert.equal(current.trial.seed, 100);
});
