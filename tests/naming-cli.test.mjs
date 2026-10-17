import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../dialogue-model/runtime/naming-cli.mjs";
import { createChatClient } from "../dialogue-model/runtime/client.mjs";
import { SLOTS } from "../dialogue-model/runtime/naming-task.mjs";
import { SAFE_JUDGMENT } from "../dialogue-model/runtime/judgment/schema.mjs";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2qwAAAABJRU5ErkJggg==", "base64");
const names = (prefix) => Object.fromEntries(SLOTS.map((slot, i) => [slot, prefix + i]));
const createTrial = ({ seed }) => ({ trialId: "cli-trial", seed, human: { png, mimeType: "image/png" }, ai: { png, mimeType: "image/png" },
  key: { human: names("PRIVATE-ID"), ai: names("PRIVATE-ID") } });
const scoreTrial = () => ({ provisional: true, success: false, figures: [] });

async function setup(t, { fail = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "naming-cli-"));
  const payloads = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    payloads.push(JSON.parse(Buffer.concat(chunks)));
    if (fail) { res.writeHead(500); res.end("DO-NOT-DISCLOSE-RAW-ERROR"); return; }
    const judge = payloads.at(-1).messages.some((m) => m.role === "system" && m.content.includes("【非公開の対話判断】"));
    const final = payloads.at(-1).messages.at(-1).content.includes("最終提出要求");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: "mock-cli-model", choices: [{ message: { content: judge ? JSON.stringify(SAFE_JUDGMENT) : final ? JSON.stringify(names("AI-final")) : "AIの公開応答" } }] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true }); });
  const client = createChatClient({ provider: "cloudflare", purpose: "dialogue_turn", apiKey: "SECRET-CLI-KEY",
    baseUrl: "http://127.0.0.1:" + server.address().port + "/v1" });
  let output = "";
  const sink = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
  const args = ["--strategy", "repair-first", "--seed", "101", "--image-dir", join(dir, "images")];
  return { dir, payloads, args, getOutput: () => output, dependencies: { client, createTrial, scoreTrial, output: sink } };
}

test("script CLI exports only human PNG, sends each public line in order, and submits privately", async (t) => {
  const { dir, payloads, args, dependencies, getOutput } = await setup(t);
  const script = join(dir, "turns.jsonl");
  await writeFile(script, [JSON.stringify("first-public"), JSON.stringify({ utterance: "FUTURE-SECOND-PUBLIC" }),
    JSON.stringify({ submission: names("PRIVATE-HUMAN-FINAL") })].join("\n"));
  const state = await main([...args, "--script", script], { RESEARCH_RUN_DIR: "" }, dependencies);
  assert.equal(state.status, "completed"); assert.equal(state.publicHistory.length, 4);
  assert.equal(payloads.length, 5);
  assert.doesNotMatch(JSON.stringify(payloads[0]), /FUTURE-SECOND|PRIVATE-HUMAN|PRIVATE-ID/);
  assert.doesNotMatch(JSON.stringify(payloads), /PRIVATE-HUMAN-FINAL|PRIVATE-ID/);
  assert.equal(payloads[3].messages.at(-1).content, "FUTURE-SECOND-PUBLIC");
  assert.equal(payloads[4].purpose, "dialogue_turn");
  const files = await readdir(join(dir, "images")); assert.equal(files.length, 1); assert.match(files[0], /^human-.*\.png$/);
  assert.deepEqual(await readFile(join(dir, "images", files[0])), png);
  assert.match(getOutput(), /AIの公開応答/); assert.match(getOutput(), /provisional/);
  assert.doesNotMatch(getOutput(), /SECRET-CLI-KEY|PRIVATE-ID|base64/);
});

test("script without a submission performs dialogue only and never fabricates a final answer", async (t) => {
  const { dir, payloads, args, dependencies, getOutput } = await setup(t);
  const script = join(dir, "turns.jsonl");
  await writeFile(script, JSON.stringify({ utterance: "public" }) + "\n");
  const state = await main([...args, "--script", script], { RESEARCH_RUN_DIR: "" }, dependencies);
  assert.equal(payloads.length, 2); assert.equal(state.aiSubmitted, false); assert.equal(state.humanSubmitted, false);
  assert.doesNotMatch(getOutput(), /AI-final/);
});

test("interactive CLI supports /submit with six prompted positions and /exit", async (t) => {
  const { payloads, args, dependencies, getOutput } = await setup(t);
  const input = Readable.from(["public dialogue\n/submit\nname0\nname1\nname2\nname3\nname4\nname5\n"]);
  const state = await main(args, { RESEARCH_RUN_DIR: "" }, { ...dependencies, input });
  assert.equal(state.status, "completed"); assert.equal(state.humanSubmission[SLOTS[5]], "name5");
  assert.equal(payloads.length, 3); assert.match(getOutput(), /下段右の名称/);
  const exitState = await main(args, { RESEARCH_RUN_DIR: "" }, { ...dependencies, input: Readable.from(["/exit\n"]) });
  assert.equal(exitState.aiSubmitted, false); assert.equal(payloads.length, 3);
});

test("invalid JSONL is rejected before any API call or image export; repo image paths are refused", async (t) => {
  const { dir, args, dependencies, payloads } = await setup(t);
  const script = join(dir, "turns.jsonl");
  await writeFile(script, JSON.stringify({ utterance: "valid first" }) + "\ninvalid SECRET RAW\n");
  await assert.rejects(main([...args, "--script", script], { RESEARCH_RUN_DIR: "" }, dependencies), /invalid_script/);
  assert.equal(payloads.length, 0);
  assert.deepEqual(await readdir(dir), ["turns.jsonl"]);
  await assert.rejects(main([...args.slice(0, -1), "runs/images"], { RESEARCH_RUN_DIR: "" }, dependencies), /repository_output_forbidden/);
  assert.equal(payloads.length, 0);
});

test("interactive API failures have safe output and allow exit without committing failed turns", async (t) => {
  const { args, dependencies, getOutput } = await setup(t, { fail: true });
  const state = await main(args, { RESEARCH_RUN_DIR: "" }, { ...dependencies, input: Readable.from(["public\n/exit\n"]) });
  assert.deepEqual(state.publicHistory, []);
  assert.match(getOutput(), /AIに接続できませんでした/);
  assert.doesNotMatch(getOutput(), /DO-NOT-DISCLOSE|SECRET-CLI-KEY|image_url/);
});

function runCLI(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dialogue-model/runtime/naming-cli.mjs", ...args], {
      env: { ...process.env, RESEARCH_AI_API_KEY: "DO-NOT-LEAK-KEY" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject); child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
test("CLI entry point offers help and sanitizes startup errors", async () => {
  const help = await runCLI(["--help"]); assert.equal(help.code, 0); assert.match(help.stdout, /--script/);
  const bad = await runCLI(["--RAW-SECRET-OPTION"]); assert.equal(bad.code, 1);
  assert.doesNotMatch(bad.stderr, /RAW-SECRET-OPTION|DO-NOT-LEAK-KEY|Error:| at /);
});
