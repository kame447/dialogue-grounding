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
    usage: { inputTokens: 13, outputTokens: 4 },
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
    new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")))));
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
