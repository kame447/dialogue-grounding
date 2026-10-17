import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runCLI(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dialogue-model/runtime/cli.mjs", ...args], {
      env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("the CLI reaches a local API and can run an image dialogue", async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    requests.push(JSON.parse(Buffer.concat(buffers).toString()));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: "mock-version",
      choices: [{ message: { content: "名前を考えましょう。" } }] }));
  });
  const dir = await mkdtemp(join(tmpdir(), "dialogue-cli-"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const imagePath = join(dir, "six-figures.png");
    await writeFile(imagePath,
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2qwAAAABJRU5ErkJggg==", "base64"));
    const env = {
      RESEARCH_AI_PROVIDER: "custom",
      RESEARCH_AI_BASE_URL: "http://127.0.0.1:" + server.address().port + "/v1",
      RESEARCH_AI_MODEL: "mock-model",
      RESEARCH_AI_API_KEY: "local-test-key",
    };
    const smoke = await runCLI(["--smoke"], env);
    assert.equal(smoke.code, 0, smoke.stderr);
    assert.match(smoke.stdout, /AI API reachable: model=mock-version/);
    const dialogue = await runCLI([
      "--strategy", "repair-first", "--image", imagePath,
      "--message", "これは何に見えますか？",
    ], env);
    assert.equal(dialogue.code, 0, dialogue.stderr);
    assert.match(dialogue.stdout, /名前を考えましょう/);
    assert.equal(requests.length, 2);
    assert.ok(requests[1].messages.some((message) =>
      Array.isArray(message.content) && message.content.some((part) => part.type === "image_url")));
    assert.equal(requests[1].messages.at(-1).content, "これは何に見えますか？");
  } finally {
    server.close();
    await once(server, "close");
    await rm(dir, { recursive: true, force: true });
  }
});

test("--show-model reports Worker policy without issuing an AI completion", async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    assert.equal(req.url, "/v1/model-policy");
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, "Bearer a-research-token-more-than-32-characters");
    calls++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      purpose: "dialogue_turn", provider: "openai", model: "gpt-4o-mini", ready: false,
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const result = await runCLI(["--show-model"], {
      RESEARCH_AI_PROVIDER: "cloudflare",
      RESEARCH_AI_BASE_URL: "http://127.0.0.1:" + server.address().port + "/v1",
      RESEARCH_PROXY_TOKEN: "a-research-token-more-than-32-characters",
      RESEARCH_AI_MODEL: "ignored-local-model",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /model=gpt-4o-mini ready=false/);
    assert.doesNotMatch(result.stdout, /ignored-local-model|research-token/);
    assert.equal(calls, 1);
  } finally {
    server.close();
    await once(server, "close");
  }
});
