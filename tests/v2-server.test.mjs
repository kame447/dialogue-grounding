import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { startNamingServer } from "../dialogue-model/runtime/web/server.mjs";
import { createChatClient } from "../dialogue-model/runtime/client.mjs";

const ownIds = (messages) => {
  const text = messages.map((m) => typeof m.content === "string" ? m.content : "").join("\n");
  const memo = text.match(/内部参照ID（非公開[^\n]*\n(\[.*\])/);
  return memo ? JSON.parse(memo[1]).map((a) => a.id) : [];
};

async function setup(t, { generationDelay = 0 } = {}) {
  const payloads = [];
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks)); payloads.push(body);
    const messages = body.messages;
    const last = messages.at(-1).content;
    const isJudge = messages.some((m) => m.role === "system" && typeof m.content === "string" && m.content.includes("【非公開の対話判断】"));
    const isFinal = typeof last === "string" && last.includes("最終提出要求");
    let content;
    if (isJudge) content = JSON.stringify({ action: "accept", targetSlot: null, candidateName: null, discriminatingFeature: null, note: null });
    else if (isFinal) content = JSON.stringify(Object.fromEntries(ownIds(messages).map((id) => [id, "AI名"])));
    else { if (generationDelay) await new Promise((r) => setTimeout(r, generationDelay)); content = "はい、見てみますね。"; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: "mock", choices: [{ message: { content } }] }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const client = createChatClient({ provider: "cloudflare", purpose: "dialogue_turn", apiKey: "PRIVATE-TEST-KEY",
    baseUrl: "http://127.0.0.1:" + upstream.address().port + "/v1" });
  const server = await startNamingServer({ port: 0, client, runDir: "", hideStrategy: true });
  t.after(async () => { await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => upstream.close(r))]); });
  const base = "http://127.0.0.1:" + server.address().port;
  const cookie = (await fetch(base)).headers.get("set-cookie").split(";")[0];
  const request = (path, body) => fetch(base + path, { headers: { cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  const waitIdle = async () => {
    for (let i = 0; i < 200; i++) {
      const state = await (await request("/api/state")).json();
      if (state.trial.aiStatus !== "thinking") return state;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("AI did not settle");
  };
  return { request, payloads, waitIdle };
}

test("v2 over HTTP: own scene only, immediate consecutive messages, private names, result without figure ids", async (t) => {
  const { request, payloads, waitIdle } = await setup(t, { generationDelay: 40 });
  let response = await request("/api/start", { version: 2, strategy: "repair-first", seed: 31 });
  assert.equal(response.status, 200);
  let state = await response.json();
  assert.equal(state.trial.version, 2);
  assert.equal(state.trial.scene.shapes.length, 6);
  for (const forbidden of ["seed", "trialId", "key", "anchors", "strategy", "figureId"]) assert.ok(!JSON.stringify(state).includes('"' + forbidden + '"'), forbidden);
  assert.equal((await request("/api/image")).status, 404);
  assert.equal((await request("/api/turn", { utterance: "x" })).status, 404, "v1 routes are not served for a v2 trial");

  const first = await request("/api/message", { text: "なんかサンダーみたいなの" });
  assert.equal(first.status, 202);
  const second = await request("/api/message", { text: "あ、違う、人っぽいのかも" });
  assert.equal(second.status, 202, "a second message is accepted while the AI is thinking");
  state = await waitIdle();
  assert.deepEqual(state.trial.events.map((e) => e.speaker), ["ai", "human", "human", "ai"]);

  const ids = state.trial.scene.shapes.map((s) => s.id);
  response = await request("/api/names", { names: Object.fromEntries(ids.map((id, i) => [id, i === 0 ? null : "人名" + i])), confirm: false });
  assert.equal(response.status, 400, "explicit confirmation is required");
  response = await request("/api/names", { names: Object.fromEntries(ids.map((id, i) => [id, i === 0 ? null : "人名" + i])), confirm: true });
  assert.equal(response.status, 200);
  state = await response.json();
  assert.equal(state.trial.status, "completed");
  assert.equal(state.trial.result, undefined, "withheld until the questionnaire is submitted");
  assert.equal(state.trial.resultLocked, true);
  assert.equal((await request(`/api/records/${state.trial.sessionId}/questionnaire`, { answers: { mental_effort: 4, task_difficulty: 4, smoothness: 4, bothersome: 4 }, submit: true })).status, 200);
  state = await (await request("/api/state")).json();
  assert.equal(state.trial.resultLocked, false);
  assert.equal(state.trial.result.total, 6);
  assert.ok(!JSON.stringify(state).includes("figureId"));
  assert.equal((await request("/api/message", { text: "まだ？" })).status, 400);

  for (const body of payloads) {
    const urls = body.messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((p) => p.type === "image_url").map((p) => p.image_url.url) : []);
    assert.equal(urls.length, 1, "exactly the AI's own image");
    const text = JSON.stringify(body.messages.map((m) => typeof m.content === "string" ? m.content : ""));
    for (const id of ids) assert.ok(!text.includes(id), "human id never reaches the model");
    assert.ok(!/上段|下段/.test(text));
  }
});

test("v2 refuses the visual aid and invalid versions", async (t) => {
  const { request } = await setup(t);
  assert.equal((await request("/api/start", { version: 2, strategy: "repair-first", seed: 32, visualAid: true })).status, 400);
  assert.equal((await request("/api/start", { version: 3, strategy: "repair-first", seed: 32 })).status, 400);
});

test("each UI page sees only a trial of its own version", async (t) => {
  const { request } = await setup(t);
  assert.equal((await request("/api/start", { version: 2, strategy: "repair-first", seed: 33 })).status, 200);
  assert.equal((await request("/v1/")).status, 200);
  assert.equal((await (await request("/api/state")).json()).trial, null, "the v1 page shows its start form, not the v2 trial");
  assert.equal((await request("/")).status, 200);
  assert.equal((await (await request("/api/state")).json()).trial.version, 2, "the v2 trial is still there for the v2 page");
});
