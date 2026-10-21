// Offline producer captures only. Never imports the independent verifier.
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mock } from "node:test";
import type { MockTracker } from "node:test";
import { createChatClient } from "../../dialogue-model/runtime/client.mjs";
import { runParityLive } from "../../dialogue-model/runtime/diagnostics/parity-live/live.ts";
import type { Dependencies, LunaClient, Options } from "../../dialogue-model/runtime/diagnostics/parity-live/live.ts";

export const FAILURE_SCENARIOS = ["observation_timeout", "policy_get_failed", "post_cache", "cache_read_failed", "cache_read_and_save_failed"] as const;
export type FailureScenario = typeof FAILURE_SCENARIOS[number];
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Storage = { name: string; mode: number; external: true; regular: boolean };
export type Capture = {
  trials: any[]; packets: Array<{ name: string; value: any }>; storage: Storage[]; billing: any[];
  directories: Record<string, number>; run: any; summary: any; failure: any; evidence: any; warmup?: any;
};
export type Captures = Record<FailureScenario, Capture>;
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const FIXTURE_DIRECTORY = fileURLToPath(new URL("../fixtures/parity-verify/failure-path/", import.meta.url));
export const FIXED_DATE_MS = 1_700_000_000_000;
// Exact paths, with * matching only one scenario name. No recursive key deletion:
// payload/material subtrees and all call/send IDs remain significant.
export const COMPARISON_EXCLUSIONS = Object.freeze(["*/run/runId", "*/summary/runId", "*/evidence/runId"]);
export const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

function scenarioOptions(root: string): Options {
  return { outputDir: join(root, "runs"), cacheDir: join(root, "cache"),
    scripts: [{ id: "probe", humanTurns: ["形を教えてください。"] }],
    manifest: { id: "synthetic-wiring", seed: 1701, figureSets: 1, approval: "pending",
      lunaRequest: { timeoutMs: null, maxCompletionTokens: null },
      caps: { jevUsd: 2, jevPosts: 208, lunaCalls: 131, lunaPosts: 393, lunaTokens: 1500000 },
      trials: [{ stage: "smoke", scriptId: "probe", label: "repair-first" },
        { stage: "main", scriptId: "probe", label: "bypass-enabled" }, { stage: "main", scriptId: "probe", label: "repair-first" }] } };
}

function scenarioDependencies(options: Options, scenario: FailureScenario, entered: ReturnType<typeof gate>): Dependencies {
  const MODEL = "synthetic-luna", TEXT = "細長い部分があります。";
  const policy = { purpose: "dialogue_turn", ready: true, model: MODEL, provider: "openai" };
  return { execution: "mock", createLunaClient(label, settings) {
    let phase = "";
    const complete: LunaClient["complete"] = async (messages, request) => {
      let text = TEXT;
      const input = () => JSON.parse(String(messages[1].content));
      if (request?.phase === "observation_initial") {
        text = JSON.stringify({ figures: input().ownAnchors.map((a: { id: string }) => ({ id: a.id, holistic: [],
          analytic: { shapes: ["細長い部分"], composition: "部分が接する", relations: [] }, unknowns: [] })) });
      } else if (request?.phase === "local_extraction") text = "[]";
      else if (request?.phase === "ai_extraction") {
        if (label !== "warmup" && scenario.startsWith("cache_read")) {
          for (const name of await readdir(options.cacheDir)) await rm(join(options.cacheDir, name));
          if (scenario === "cache_read_and_save_failed") {
            await mkdir(join(options.outputDir, (await readdir(options.outputDir))[0], "trial-0.private.json"), { mode: 0o700 });
          }
        }
        text = JSON.stringify([{ segmentId: "s1", quote: TEXT, targets: [input().ownSlots[0]], aspect: "part",
          proposition: "細長い部分がある", name: null, linkedIssueId: null, respondsToTurn: null }]);
      }
      return { text, model: MODEL, usage: { inputTokens: 10, outputTokens: 2 } };
    };
    const fetchImpl = settings.instrumentFetch(async (_url, init) => {
      if ((init?.method ?? "GET") === "GET") {
        return scenario === "policy_get_failed" ? new Response("{}", { status: 401 }) : Response.json(policy);
      }
      if (scenario === "observation_timeout") {
        const signal = init!.signal!;
        const pending = new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("synthetic abort")), { once: true });
        });
        entered.release(); return pending;
      }
      const reply = await complete(JSON.parse(String(init?.body)).messages, { phase });
      return Response.json({ model: reply.model, choices: [{ message: { content: reply.text } }],
        usage: { prompt_tokens: reply.usage!.inputTokens, completion_tokens: reply.usage!.outputTokens } });
    });
    const native = createChatClient({ provider: "cloudflare", apiKey: "fixture-auth-material", purpose: "dialogue_turn",
      baseUrl: "http://synthetic.invalid/v1", timeoutMs: settings.request.timeoutMs ?? undefined,
      maxCompletionTokens: settings.request.maxCompletionTokens ?? undefined }, fetchImpl, { sleep: async () => {} });
    return { getModelPolicy: () => native.getModelPolicy(), complete(messages, request) {
      // The post-cache case intentionally performs no completion HTTP POST.
      if (scenario === "post_cache") return complete(messages, request);
      phase = request?.phase ?? ""; return native.complete(messages, request);
    } };
  }, createJevTransport() {
    return { readKey: async () => "sk-or-SYNTHETIC-parity-fixture-0000", async fetchImpl(_url, init) {
      const body = JSON.parse(String(init.body));
      const answers = Object.fromEntries(Object.entries(body.questions).map(([name, raw]) => {
        const criteria = (raw as { criteria: Record<string, unknown> }).criteria;
        const choice = name === "human_referent" || name === "target" || name.endsWith("_antecedent") ? "none"
          : name === "action" ? "accept" : name.startsWith("candidate_") ? "exclude" : name.endsWith("_act") ? "assert" : "expressed";
        return [name, { type: "choice", choice, probabilities: Object.fromEntries(Object.keys(criteria).map(v => [v, v === choice ? 1 : 0])), confidence: 1 }];
      }));
      return Response.json({ model: "typesafe/jev-1.14", id: "gen-synthetic-parity", usage: { cost: 0.001 }, answers });
    } };
  } };
}

async function readCapture(directory: string, options: Options, root: string): Promise<Capture> {
  const records = { trials: [], packets: [], storage: [], billing: [], directories: {} } as unknown as Capture;
  for (const [name, path] of Object.entries({ root, output: options.outputDir, cache: options.cacheDir, run: directory })) {
    records.directories[name] = (await lstat(path)).mode & 0o777;
  }
  for (const name of (await readdir(directory)).sort()) {
    const file = join(directory, name), info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error("unexpected_symlink");
    records.storage.push({ name, mode: info.mode & 0o777, external: true, regular: info.isFile() });
    if (!info.isFile()) continue;
    const text = await readFile(file, "utf8");
    if (name === "billing.private.jsonl") { records.billing = text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); continue; }
    const value = JSON.parse(text);
    if (/^trial-\d+\.private\.json$/u.test(name)) records.trials.push(value);
    else if (name.startsWith("public-")) records.packets.push({ name, value });
    else {
      const keys = { "run.private.json": "run", "summary.private.json": "summary", "failure.private.json": "failure",
        "warmup.private.json": "warmup", "verifier-evidence.private.json": "evidence" } as const;
      const key = keys[name as keyof typeof keys];
      if (!key) throw new Error(`unexpected_capture_file:${name}`);
      records[key] = value;
    }
  }
  return records; // Parsed producer values are never repaired or normalized here.
}

export async function captureFailureFixtures(tracker: MockTracker = mock): Promise<Captures> {
  const captures = {} as Captures;
  for (const scenario of FAILURE_SCENARIOS) {
    const root = await mkdtemp(join(tmpdir(), "parity-failure-fixture-"));
    let clock = 0;
    try {
      tracker.method(performance, "now", () => clock);
      tracker.timers.enable({ apis: ["setTimeout", "Date"], now: FIXED_DATE_MS });
      const options = scenarioOptions(root), entered = gate();
      const work = runParityLive(options, scenarioDependencies(options, scenario, entered));
      if (scenario === "observation_timeout") { await entered.promise; clock = 20000; tracker.timers.tick(20000); }
      const result = await work;
      await result.flushBilling();
      captures[scenario] = await readCapture(result.directory, options, root);
    } finally {
      tracker.reset(); await rm(root, { recursive: true, force: true });
    }
  }
  return captures;
}

/** Comparison copy only: the persisted producer records retain their real IDs. */
export function comparableCaptures(captures: Captures): Json {
  const copy = structuredClone(captures);
  for (const scenario of FAILURE_SCENARIOS) for (const path of COMPARISON_EXCLUSIONS) {
    const [, owner, field] = path.split("/");
    delete (copy[scenario][owner as "run" | "summary" | "evidence"])[field];
  }
  return copy as unknown as Json;
}

/** Hash the generator, local import closure, and all instruction-source files. */
export async function fixtureSourceHashes(captures: Captures): Promise<Record<string, string>> {
  const queued = ["tests/support/generate-failure-fixture.ts", ...Object.keys(captures.observation_timeout.run.promptSources.files)
    .map(file => `dialogue-model/runtime/${file}`)];
  const hashes: Record<string, string> = {};
  for (let i = 0; i < queued.length; i++) {
    const file = queued[i]; if (hashes[file]) continue;
    const text = await readFile(join(ROOT, file), "utf8"); hashes[file] = sha256(text);
    for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'](\.[^"']+\.(?:ts|mjs))["']/gu)) {
      const dependency = relative(ROOT, resolve(ROOT, dirname(file), match[1]));
      if (dependency.startsWith("..")) throw new Error("source_outside_repository");
      queued.push(dependency);
    }
  }
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
}

export async function writeFailureFixture(destination = FIXTURE_DIRECTORY, tracker: MockTracker = mock) {
  const captures = await captureFailureFixtures(tracker), sourceFiles = await fixtureSourceHashes(captures);
  const raw = JSON.stringify(captures, null, 2) + "\n";
  const metadata = { schemaVersion: "parity_live_failure_capture_v1", baseCommit: "3071720", execution: "mock",
    fixtureSha256: sha256(raw), sourceFiles, scenarios: [...FAILURE_SCENARIOS],
    comparisonExclusions: [...COMPARISON_EXCLUSIONS], controlledClock: { dateMs: FIXED_DATE_MS, performanceStartMs: 0 },
    provenance: "Unmodified parsed producer JSON/JSONL from runParityLive with native serializers and instrumented mock fetch; directory and storage modes are observed before cleanup. No real API, Keychain or private research data." };
  await mkdir(destination, { recursive: true, mode: 0o700 }); await chmod(destination, 0o700);
  for (const [file, contents] of [["producer-records.json", raw], ["capture-metadata.json", JSON.stringify(metadata, null, 2) + "\n"]]) {
    const path = join(destination, file); await writeFile(path, contents, { mode: 0o600 }); await chmod(path, 0o600);
  }
  return metadata;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const metadata = await writeFailureFixture(process.argv[2] ? resolve(process.argv[2]) : FIXTURE_DIRECTORY);
  console.log(JSON.stringify({ fixtureSha256: metadata.fixtureSha256, scenarios: metadata.scenarios }));
}
