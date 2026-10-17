import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createChatClient, AIConnectionError } from "../dialogue-model/runtime/client.mjs";

const config = {
  model: "mock-multimodal",
  apiKey: "test-only-secret",
  baseUrl: "https://mock.invalid/v1",
  timeoutMs: 2000,
  maxCompletionTokens: 200,
};

test("provider transport posts the configured payload and parses responses", async () => {
  let received;
  const client = createChatClient(config, async (url, options) => {
    received = { url: String(url), options };
    return {
      ok: true,
      async json() {
        return {
          model: "mock-multimodal-version",
          choices: [{ message: { content: "確認しました" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 13, completion_tokens: 4 },
        };
      },
    };
  });
  const messages = [{ role: "user", content: "テスト" }];
  const result = await client.complete(messages);
  assert.equal(received.url, "https://mock.invalid/v1/chat/completions");
  assert.equal(received.options.method, "POST");
  assert.equal(received.options.headers.Authorization, "Bearer test-only-secret");
  assert.deepEqual(JSON.parse(received.options.body), {
    model: "mock-multimodal",
    messages,
    max_completion_tokens: 200,
  });
  assert.deepEqual(result, {
    text: "確認しました",
    model: "mock-multimodal-version",
    finishReason: "stop",
    usage: { inputTokens: 13, outputTokens: 4 }, retryCount: 0, timeoutMs: 2000,
  });
});

test("an HTTP error never exposes the provider response or API key", async () => {
  const client = createChatClient(config, async () => ({
    ok: false,
    status: 401,
    async text() { return "sensitive echo test-only-secret"; },
  }));
  await assert.rejects(client.complete([{ role: "user", content: "hello" }]), (error) => {
    assert.ok(error instanceof AIConnectionError);
    assert.equal(error.status, 401);
    assert.doesNotMatch(error.message, /test-only-secret|sensitive/);
    return true;
  });
});

test("timeout is reported without logging request contents", async () => {
  const client = createChatClient({ ...config, timeoutMs: 5 }, async (_url, { signal }) =>
    new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")))), { sleep: async () => {} });
  await assert.rejects(client.complete([{ role: "user", content: "private" }]), /timeout/);
});

test("real local HTTP server exercises the network and multimodal JSON path", async () => {
  const received = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url, authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "認識しました" } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = server.address().port;
    const client = createChatClient({
      ...config, baseUrl: "http://127.0.0.1:" + port + "/v1", maxCompletionTokens: undefined,
    });
    const result = await client.complete([{
      role: "user",
      content: [
        { type: "text", text: "この図を見てください" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
      ],
    }]);
    assert.equal(result.text, "認識しました");
    assert.equal(received[0].url, "/v1/chat/completions");
    assert.equal(received[0].authorization, "Bearer test-only-secret");
    assert.equal(received[0].body.messages[0].content[1].type, "image_url");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("only transient HTTP statuses get at most two exponential retries with unchanged image payload", async (t) => {
  for (const transient of [429, 502, 503, 504]) {
    await t.test(String(transient), async () => {
      const bodies = []; const waits = [];
      const server = createServer(async (req, res) => {
        const chunks = []; for await (const c of req) chunks.push(c);
        bodies.push(JSON.parse(Buffer.concat(chunks)));
        res.setHeader("Content-Type", "application/json");
        if (bodies.length < 3) { res.writeHead(transient); res.end("PRIVATE-UPSTREAM-ECHO"); }
        else res.end(JSON.stringify({ model: "fixed-worker-model", choices: [{ message: { content: "再試行後の応答" } }] }));
      });
      server.listen(0, "127.0.0.1"); await once(server, "listening");
      try {
        const client = createChatClient({ provider: "cloudflare", purpose: "dialogue_turn", apiKey: "local-key",
          baseUrl: "http://127.0.0.1:" + server.address().port + "/v1" }, undefined, { sleep: async (ms) => { waits.push(ms); } });
        const result = await client.complete([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] }]);
        assert.equal(result.retryCount, 2); assert.equal(result.timeoutMs, 90000);
        assert.deepEqual(waits, [500, 1000]); assert.equal(bodies.length, 3);
        assert.deepEqual(bodies[0], bodies[1]); assert.deepEqual(bodies[1], bodies[2]);
        assert.equal(bodies[0].purpose, "dialogue_turn"); assert.ok(!Object.hasOwn(bodies[0], "model"));
      } finally { await new Promise((r) => server.close(r)); }
    });
  }
});

test("non-transient HTTP and malformed success responses never retry or expose raw data", async () => {
  for (const status of [400, 401, 403, 404, 408, 500, 501]) {
    let calls = 0;
    const client = createChatClient(config, async () => { calls++; return new Response("PRIVATE-RAW-ERROR", { status }); },
      { sleep: async () => assert.fail("must not retry") });
    await assert.rejects(client.complete([{ role: "user", content: "PRIVATE-PROMPT" }]), (error) => {
      assert.equal(error.status, status); assert.equal(error.retryCount, 0);
      assert.doesNotMatch(error.message, /PRIVATE|test-only-secret/); return true;
    });
    assert.equal(calls, 1);
  }
  for (const body of ["bad JSON PRIVATE", JSON.stringify({ choices: [] })]) {
    let calls = 0;
    const client = createChatClient(config, async () => { calls++; return new Response(body); }, { sleep: async () => assert.fail("must not retry") });
    await assert.rejects(client.complete([{ role: "user", content: "public" }]), /invalid_json|empty_response/);
    assert.equal(calls, 1);
  }
});

test("network and timeout retry counts survive terminal errors; one transient network failure can recover", async () => {
  for (const mode of ["network", "timeout"]) {
    let calls = 0; const waits = [];
    const client = createChatClient({ ...config, timeoutMs: 2 }, async (_url, { signal }) => {
      calls++;
      if (mode === "network") throw new Error("PRIVATE-NETWORK-ERROR");
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("PRIVATE-TIMEOUT-ERROR"))));
    }, { sleep: async (ms) => { waits.push(ms); } });
    await assert.rejects(client.complete([{ role: "user", content: "PRIVATE-PROMPT" }]), (error) => {
      assert.equal(error.code, mode === "network" ? "network_error" : "timeout");
      assert.equal(error.retryCount, 2); assert.doesNotMatch(error.message, /PRIVATE/); return true;
    });
    assert.equal(calls, 3); assert.deepEqual(waits, [500, 1000]);
  }
  let calls = 0;
  const client = createChatClient(config, async () => {
    if (++calls === 1) throw new Error("temporary");
    return Response.json({ choices: [{ message: { content: "recovered" } }] });
  }, { sleep: async () => {} });
  assert.equal((await client.complete([{ role: "user", content: "public" }])).retryCount, 1);
});

test("default timeout follows image presence while an explicit timeout overrides both", async () => {
  const fetchImpl = async () => Response.json({ choices: [{ message: { content: "ok" } }] });
  const plain = [{ role: "user", content: "public" }];
  const withImage = [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }];
  const client = createChatClient({ ...config, timeoutMs: undefined }, fetchImpl);
  assert.equal((await client.complete(plain)).timeoutMs, 45000);
  assert.equal((await client.complete(withImage)).timeoutMs, 90000);
  const explicit = createChatClient({ ...config, timeoutMs: 12345 }, fetchImpl);
  assert.equal((await explicit.complete(plain)).timeoutMs, 12345);
  assert.equal((await explicit.complete(withImage)).timeoutMs, 12345);
});
