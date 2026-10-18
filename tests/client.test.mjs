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

test("POST 429/503 get at most two exponential retries with unchanged image payload", async (t) => {
  for (const transient of [429, 503]) {
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
  for (const status of [400, 401, 403, 404, 408, 500, 501, 502, 504]) {
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

test("POST ambiguous 502/504 and network failures send only once", async () => {
  for (const failure of [502, 504, "unknown", "ECONNRESET", "UND_ERR_SOCKET", "ETIMEDOUT"]) {
    let calls = 0; const waits = [];
    const client = createChatClient(config, async () => {
      calls++;
      if (typeof failure === "number") return new Response('{"error":"upstream_unavailable PRIVATE"}', { status: failure });
      throw new TypeError("PRIVATE-NETWORK-ERROR", { cause: Object.assign(new Error("PRIVATE-CAUSE"), { code: failure }) });
    }, { sleep: async (ms) => { waits.push(ms); } });
    await assert.rejects(client.complete([{ role: "user", content: "PRIVATE-PROMPT" }]), (error) => {
      assert.ok(error instanceof AIConnectionError);
      assert.equal(error.status, typeof failure === "number" ? failure : null);
      assert.equal(error.retryCount, 0);
      assert.equal(error.timeoutMs, config.timeoutMs);
      assert.doesNotMatch(JSON.stringify(error) + error.message, /PRIVATE|test-only-secret/); return true;
    });
    assert.equal(calls, 1, String(failure)); assert.deepEqual(waits, []);
  }
});

test("POST timeout before headers or while reading a response sends only once", async () => {
  for (const stage of ["headers", "body"]) {
    let calls = 0; const waits = [];
    const client = createChatClient({ ...config, timeoutMs: 2 }, async (_url, { signal }) => {
      calls++;
      const waitForAbort = () => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("PRIVATE-TIMEOUT"))));
      return stage === "headers" ? waitForAbort() : { ok: true, json: waitForAbort };
    }, { sleep: async (ms) => { waits.push(ms); } });
    await assert.rejects(client.complete([{ role: "user", content: "PRIVATE-PROMPT" }]), (error) => {
      assert.equal(error.code, "timeout"); assert.equal(error.retryCount, 0);
      assert.equal(error.timeoutMs, 2); assert.equal(error.status, null);
      assert.doesNotMatch(error.message, /PRIVATE/); return true;
    });
    assert.equal(calls, 1); assert.deepEqual(waits, []);
  }
});

test("POST pre-connect failures can retry twice and recover without changing payload", async () => {
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]) {
    for (const recover of [false, true]) {
      const bodies = [], waits = [];
      const client = createChatClient(config, async (_url, options) => {
        bodies.push(options.body);
        if (recover && bodies.length === 3) return Response.json({ choices: [{ message: { content: "recovered" } }] });
        throw new TypeError("PRIVATE-FETCH-FAILURE", { cause: Object.assign(new Error("PRIVATE-CAUSE"), { code }) });
      }, { sleep: async (ms) => { waits.push(ms); } });
      if (recover) assert.equal((await client.complete([{ role: "user", content: "public" }])).retryCount, 2);
      else await assert.rejects(client.complete([{ role: "user", content: "public" }]), (error) => {
        assert.equal(error.code, "network_error"); assert.equal(error.retryCount, 2); assert.equal(error.status, null);
        assert.doesNotMatch(JSON.stringify(error) + error.message, /PRIVATE/); return true;
      });
      assert.equal(bodies.length, 3); assert.deepEqual(waits, [500, 1000]);
      assert.equal(new Set(bodies).size, 1);
    }
  }
});

test("POST body-read failures never retry even with a pre-connect-looking error code", async () => {
  let calls = 0;
  const client = createChatClient(config, async () => {
    calls++;
    return { ok: true, async json() { throw Object.assign(new Error("PRIVATE-READ-ERROR"), { code: "ECONNREFUSED" }); } };
  }, { sleep: async () => assert.fail("must not retry a received response") });
  await assert.rejects(client.complete([{ role: "user", content: "public" }]), { code: "network_error", retryCount: 0 });
  assert.equal(calls, 1);
});

test("POST only retries aggregate connection errors when every cause is pre-connect", async () => {
  for (const codes of [["ECONNREFUSED", "ENOTFOUND"], ["ECONNREFUSED", "ECONNRESET"], []]) {
    let calls = 0; const waits = [];
    const client = createChatClient(config, async () => {
      calls++;
      throw new TypeError("PRIVATE-FETCH-ERROR", { cause: new AggregateError(
        codes.map((code) => Object.assign(new Error("PRIVATE-CAUSE"), { code }))) });
    }, { sleep: async (ms) => { waits.push(ms); } });
    const retryCount = codes.length === 2 && codes[1] === "ENOTFOUND" ? 2 : 0;
    await assert.rejects(client.complete([{ role: "user", content: "public" }]), { code: "network_error", retryCount });
    assert.equal(calls, retryCount + 1);
    assert.deepEqual(waits, retryCount ? [500, 1000] : []);
  }
});

test("POST stops on an ambiguous failure even after a retryable HTTP response", async () => {
  for (const terminal of [502, 504, "timeout"]) {
    let calls = 0; const waits = [];
    const client = createChatClient({ ...config, timeoutMs: 2 }, async (_url, { signal }) => {
      if (++calls === 1) return new Response("PRIVATE-RAW-ERROR", { status: 429 });
      if (typeof terminal === "number") return new Response("PRIVATE-RAW-ERROR", { status: terminal });
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("PRIVATE-TIMEOUT"))));
    }, { sleep: async (ms) => { waits.push(ms); } });
    await assert.rejects(client.complete([{ role: "user", content: "public" }]), {
      retryCount: 1, status: typeof terminal === "number" ? terminal : null,
    });
    assert.equal(calls, 2); assert.deepEqual(waits, [500]);
  }
});

test("POST retry exhaustion retains 429/503 status and retryCount", async () => {
  for (const status of [429, 503]) {
    let calls = 0; const waits = [];
    const client = createChatClient(config, async () => {
      calls++; return new Response("PRIVATE-RAW-ERROR", { status });
    }, { sleep: async (ms) => { waits.push(ms); } });
    await assert.rejects(client.complete([{ role: "user", content: "public" }]), (error) => {
      assert.equal(error.status, status); assert.equal(error.retryCount, 2);
      assert.doesNotMatch(error.message, /PRIVATE/); return true;
    });
    assert.equal(calls, 3); assert.deepEqual(waits, [500, 1000]);
  }
});

test("GET model-policy retains retries for 502/504, network errors and timeouts", async () => {
  for (const failure of [429, 502, 503, 504, "network", "timeout"]) {
    let calls = 0; const waits = [];
    const client = createChatClient({ ...config, provider: "cloudflare", purpose: "dialogue_turn", timeoutMs: 2 }, async (_url, { signal, method }) => {
      assert.equal(method, undefined); calls++;
      if (calls === 3) return Response.json({ purpose: "dialogue_turn", model: "test-model", provider: "openai", ready: true });
      if (typeof failure === "number") return new Response("PRIVATE-RAW-ERROR", { status: failure });
      if (failure === "network") throw new Error("PRIVATE-NETWORK-ERROR");
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("PRIVATE-TIMEOUT"))));
    }, { sleep: async (ms) => { waits.push(ms); } });
    assert.equal((await client.getModelPolicy()).retryCount, 2);
    assert.equal(calls, 3); assert.deepEqual(waits, [500, 1000]);
  }
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
