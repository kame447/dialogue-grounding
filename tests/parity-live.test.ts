// Mechanical synthetic mocks only; no model accuracy oracle or live credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat, readdir, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESEARCH_TRIAL_PROFILE_V1, normalizedJson, researchHash, researchTrialProfile } from "../dialogue-model/runtime/v2/research-profile.ts";
import { runParityLive, runParityLiveFromManifest } from "../dialogue-model/runtime/diagnostics/parity-live/live.ts";
import type { Dependencies, Options } from "../dialogue-model/runtime/diagnostics/parity-live/live.ts";
import { RunBudget, compareParity } from "../dialogue-model/runtime/diagnostics/parity-live/audit.ts";
import { alternatingTrials, validateRunManifest } from "../dialogue-model/runtime/diagnostics/parity-live/manifest.ts";
import { pairedReplay } from "../dialogue-model/runtime/diagnostics/parity-live/replay.ts";
import { lunaWire } from "../dialogue-model/runtime/diagnostics/parity-live/luna-wire.ts";
import { createChatClient } from "../dialogue-model/runtime/client.mjs";
import { createServer } from "node:http";
import { SYNTHETIC_PROBES } from "../dialogue-model/runtime/diagnostics/parity-live/cases.ts";
import { APPROVED_RUN_MANIFEST } from "../dialogue-model/runtime/diagnostics/parity-live/manifest.ts";
import { createHash } from "node:crypto";
import { EVIDENCE_NORMALIZED_ENVELOPE_FIELDS, projectReplayValue } from "../dialogue-model/runtime/diagnostics/parity-live/evidence.ts";
import type { TestContext } from "node:test";

const MODEL = "synthetic-luna", KEY = "sk-or-SYNTHETIC-parity-local-key-0000", TEXT = "細長い部分があります。";
const caps = { jevUsd: 2, jevPosts: 208, lunaCalls: 131, lunaPosts: 393, lunaTokens: 1500000 };
const pause = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
const manifest = () => ({ id: "synthetic-wiring", seed: 1701, figureSets: 1 as const, approval: "pending" as const,
  lunaRequest: { timeoutMs: null, maxCompletionTokens: null }, caps: { ...caps }, trials: alternatingTrials(["probe"]) });
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "parity-wiring-")); t.after(() => rm(root, { recursive: true, force: true }));
  return { outputDir: join(root, "runs"), cacheDir: join(root, "cache"), scripts: [{ id: "probe", humanTurns: ["形を教えてください。", "続きを教えてください。"] }], manifest: manifest() };
}
function dependencies(config: any = {}) {
  let anchors: any[] = [];
  const labels: string[] = [], sent: any[] = [];
  const deps: Dependencies = { execution: "mock", createLunaClient(label) {
    labels.push(label);
    return { async getModelPolicy() { return { purpose: "dialogue_turn", ready: true, model: MODEL, provider: "openai" }; },
      async complete(messages: any[], options: any) {
        sent.push({ provider: "luna", label, phase: options.phase });
        await config.onCall?.(label, options.phase);
        let text = config.partial ? TEXT + "四角い部分があります。" : TEXT;
        if (options.phase === "observation_initial") {
          anchors = JSON.parse(messages[1].content).ownAnchors;
          text = JSON.stringify({ figures: anchors.map(a => ({ id: a.id, holistic: [], analytic: { shapes: ["細長い部分"], composition: "部分が接する", relations: [] }, unknowns: [] })) });
        } else if (options.phase === "local_extraction") {
          const input = JSON.parse(messages[1].content);
          text = config.localSegment ? JSON.stringify([{ segmentId: "s1", quote: input.publicTurns.at(-1).text,
            targets: [input.ownSlots[0]], aspect: "part", proposition: "形を尋ねる", name: null, linkedIssueId: null, respondsToTurn: null }]) : "[]";
        }
        else if (options.phase === "observation_targeted") {
          const input = JSON.parse(messages[1].content);
          text = JSON.stringify({ figures: input.figureIds.map((figureId: string) => ({ figureId, supports: ["細長い部分"], contradicts: [], unknown: [] })) });
        }
        else if (options.phase === "ai_extraction") {
          const first = { segmentId: "s1", quote: TEXT, targets: [JSON.parse(messages[1].content).ownSlots[0]], aspect: "part",
            proposition: "細長い部分がある", name: null, linkedIssueId: null, respondsToTurn: null };
          text = config.empty ? "[]" : JSON.stringify(config.partial ? [first, { ...first, segmentId: "s2", quote: "四角い部分があります。", proposition: "四角い部分がある" }] : [first]);
        }
        if (config.leak && options.phase === "generation") text = KEY;
        return { text, model: MODEL, usage: { inputTokens: 10, outputTokens: 2 } };
      } };
  }, createJevTransport(label) { let observed = false; return { readKey: async () => KEY, async fetchImpl(_url, init) {
    const p = JSON.parse(String(init.body)); sent.push({ provider: "jev", label, questions: Object.keys(p.questions) });
    const ask = config.observe && p.questions.action && !observed;
    const answers = Object.fromEntries(Object.entries(p.questions).map(([name, q]: [string, any]) => {
      const values = Object.keys(q.criteria), selected = name === "observe_targets" ? "subset_0" : name === "observe_aspect" ? "part"
        : name === "target" && ask ? "figure_0" : name === "human_referent" || name === "target" || name.endsWith("_antecedent") ? "none"
        : name === "action" ? ask ? "request_observation" : "accept" : name.startsWith("candidate_") ? "exclude" : name.endsWith("_act") ? "assert" : config.partial && name === "segment_1_support" ? "not_expressed" : "expressed";
      return [name, { type: "choice", choice: selected, probabilities: Object.fromEntries(values.map(v => [v, v === selected ? 1 : 0])), confidence: 1 }];
    }));
    if (ask) observed = true;
    return Response.json({ model: "typesafe/jev-1.14", id: "gen-synthetic-parity", usage: config.unknownCost ? {} : { cost: config.cost ?? 0.001 }, answers });
  } }; } };
  return { deps, labels, sent };
}

test("profile is deeply frozen, deterministic and label-free; historical defaults are not overwritten", () => {
  assert.equal(Object.isFrozen(RESEARCH_TRIAL_PROFILE_V1.localGrounding), true);
  assert.equal(RESEARCH_TRIAL_PROFILE_V1.localGrounding.aiPublicClaims, true);
  assert.equal(RESEARCH_TRIAL_PROFILE_V1.timeouts.decisionMs, 15000);
  assert.equal(normalizedJson({ b: [2, 1], a: 1 }), '{"a":1,"b":[2,1]}');
  const profile = researchTrialProfile({ timeoutMs: null, maxCompletionTokens: null });
  assert.ok(!JSON.stringify(profile).includes("repair-first"));
  assert.equal(profile.outputLimit, "worker_dependent_effective_value_unverified");
  assert.equal(researchHash(profile), researchHash(JSON.parse(JSON.stringify(profile))));
});

test("warm-up is separate; both labels reuse the same cached memo with fresh adapters and offline paired replay", async t => {
  const options = await fixture(t), h = dependencies(), result = await runParityLive(options, h.deps);
  assert.equal(result.summary.status, "wiring_passed", JSON.stringify(result.summary));
  assert.deepEqual(h.labels, ["warmup", "bypass-enabled", "repair-first"]);
  assert.equal(h.sent.filter(c => c.phase === "observation_initial").length, 1);
  assert.ok(result.trials.every(trial => trial.cache?.status === "HIT"));
  assert.equal(result.trials[0].identity.memo, result.trials[1].identity.memo);
  for (const trial of result.trials) {
    assert.ok(trial.replay.every(r => r.result.status === "same_material_same_payload"));
    assert.equal(trial.calls.filter(c => c.phase === "observation_initial").length, 0);
    assert.ok(trial.turns[1].state.graph.records.some((r: any) => r.id === "3:pub1"));
    assert.equal(trial.turns[0].state.aiPublic!.pending!.status, "ready");
    assert.equal((await stat(join(result.directory, `trial-${trial.order}.private.json`))).mode & 0o777, 0o600);
  }
  const files = await readdir(options.cacheDir); assert.equal(files.length, 1);
  const original = await readFile(join(options.cacheDir, files[0]), "utf8");
  const next = await runParityLive(options, dependencies().deps);
  assert.equal(next.summary.status, "wiring_passed", JSON.stringify(next.summary));
  assert.equal(next.summary.cacheAudit?.status, "HIT");
  assert.equal(await readFile(join(options.cacheDir, files[0]), "utf8"), original);
  assert.notEqual(next.directory, result.directory);
});

test("approved probe catalog and run order match a literal fixture; no expected response fields", () => {
  assert.deepEqual(SYNTHETIC_PROBES, [
    { id: "S0", humanTurns: ["細い棒の先に四角がある形のこと。", "うん、その形。"] },
    { id: "S1", humanTurns: ["四角と三角がつながった形があるよね。", "四角はあるね。でも三角は上じゃないと思う。", "それを『いす』って呼ぼうか。", "うん、いすでいい。"] },
    { id: "S2", humanTurns: ["鳥に見えるのが二つあって、まだどっちか分からない。", "羽みたいな部分が細い方のこと。", "細い方を『つばめ』って呼ぼう。"] },
    { id: "S3", humanTurns: ["細長い形を『ぼう』って呼ぼう。", "うん、ぼうでいい。", "でも、ぼうの先の形がまだよく分からない。"] },
  ]);
  assert.ok(SYNTHETIC_PROBES.every(s => Object.isFrozen(s) && Object.isFrozen(s.humanTurns)));
  assert.deepEqual(APPROVED_RUN_MANIFEST.trials.map(t => [t.stage, t.scriptId, t.label]), [
    ["smoke", "S0", "repair-first"], ["main", "S0", "bypass-enabled"], ["main", "S0", "repair-first"],
    ["main", "S1", "repair-first"], ["main", "S1", "bypass-enabled"], ["main", "S2", "bypass-enabled"],
    ["main", "S2", "repair-first"], ["main", "S3", "repair-first"], ["main", "S3", "bypass-enabled"],
  ]);
  assert.deepEqual(APPROVED_RUN_MANIFEST.caps, { jevUsd: 2, jevPosts: 208, lunaCalls: 131, lunaPosts: 393, lunaTokens: 1500000 });
});

test("independent sampling divergence is not a neutrality failure; equal materials with changed payload are identified", async t => {
  const result = await runParityLive(await fixture(t), dependencies().deps), [a, b] = result.trials;
  b.turns[0].actionMaterial = ["different_material"]; b.turns[0].actionInputs = ["different_payload"]; b.turns[0].internalSha256 = "different_private_state";
  const report = compareParity(a, b);
  assert.equal(report.publicDivergenceTurn, null); assert.equal(report.internalDivergenceTurn, 1);
  assert.equal(report.cells.find(c => c.turn === 1 && c.stage === "actionInputs")?.status, "not_comparable_upstream_material_difference");
  b.turns[0].actionMaterial = a.turns[0].actionMaterial;
  assert.ok(compareParity(a, b).unmet.includes("actionInputs_1_mismatch"));
});

test("paired replay reconstructs native wire bodies offline and detects a changed recorded request hash", async t => {
  const result = await runParityLive(await fixture(t), dependencies().deps), item = result.trials[0].replay[0];
  const { createTrialV2, modelView } = await import("../dialogue-model/runtime/stimuli/scatter-v2.mjs");
  const board = modelView(createTrialV2({ seed: 1701 }));
  item.tape.expectedRequests[0].requestSha256 = "changed";
  const replay = await pairedReplay(item.tape, { ownImage: { mimeType: board.mimeType, base64: board.png.toString("base64") }, ownAnchors: board.anchors }, MODEL, result.trials[0].profile);
  assert.equal(replay.status, "same_material_payload_mismatch"); assert.equal(replay.labelsEqual, true); assert.equal(replay.reproducedRecordedPayloads, false);
});

test("public packets contain only prefix/hash, no private fields or future dialogue", async t => {
  const result = await runParityLive(await fixture(t), dependencies().deps);
  const packet = JSON.parse(await readFile(join(result.directory, "public-0-1.packet.json"), "utf8"));
  assert.deepEqual(Object.keys(packet).sort(), ["prefix", "sha256"]);
  assert.deepEqual(packet.prefix, [{ turn: 1, speaker: "human", text: "形を教えてください。" }]);
  assert.equal(packet.sha256, researchHash(packet.prefix));
});

for (const stop of [false, true]) test(`actual local HTTP retry accounting, stop after first POST=${stop}`, async t => {
  let posts = 0;
  const server = createServer((req, res) => {
    req.resume(); res.setHeader("Content-Type", "application/json");
    if (req.method === "GET") { res.end(JSON.stringify({ purpose: "dialogue_turn", model: MODEL, provider: "openai", ready: true })); return; }
    if (++posts === 1) { res.statusCode = 503; res.end("{}"); return; }
    res.end(JSON.stringify({ model: MODEL, choices: [{ message: { content: TEXT } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address() as { port: number }, budget = new RunBudget(caps);
  const connection = lunaWire({ timeoutMs: null, maxCompletionTokens: null }, budget);
  const client = createChatClient({ provider: "cloudflare", apiKey: "synthetic-token", purpose: "dialogue_turn", baseUrl: `http://127.0.0.1:${address.port}/v1` },
    connection.instrumentFetch(fetch), { sleep: async () => { if (stop) budget.stop("test_threshold"); } });
  await client.getModelPolicy();
  budget.lunaCalls++;
  connection.setActive({ phase: "generation", turn: 1, requestSha256: researchHash([{ role: "user", content: "hello" }]) } as any);
  if (stop) await assert.rejects(client.complete([{ role: "user", content: "hello" }]));
  else assert.equal((await client.complete([{ role: "user", content: "hello" }])).text, TEXT);
  assert.equal(budget.lunaCalls, 1); assert.equal(posts, stop ? 1 : 2); assert.equal(budget.lunaPosts, posts);
  assert.equal(connection.records.filter(c => c.kind === "policy_get").length, 1);
  assert.equal(budget.observedLunaTokens, stop ? 0 : 8);
  assert.equal(budget.snapshot().missingInputTokens, 1); assert.equal(budget.snapshot().missingOutputTokens, 1);
  assert.equal(budget.snapshot().totalUsd, null);
});

test("unknown Jev billing is sticky across labels and stops before any later send", async t => {
  const h = dependencies({ unknownCost: true }), result = await runParityLive(await fixture(t), h.deps);
  assert.equal(result.summary.status, "wiring_failed"); assert.equal(result.summary.budget.jevUnknown, true);
  assert.equal(h.sent.filter(c => c.provider === "jev").length, 1);
  assert.equal(result.trials.length, 1); assert.equal(result.summary.skipped.length, 1);
});

test("empty extraction records normal skips, keeps final pending unapplied, and does not require conditional paths", async t => {
  const result = await runParityLive(await fixture(t), dependencies({ empty: true }).deps);
  assert.equal(result.summary.status, "wiring_passed", JSON.stringify(result.summary));
  assert.ok(result.trials.every(trial => !trial.calls.some(c => c.phase === "ai_function" || c.phase === "ai_support")));
});

test("shared ledger reserves sends atomically; late known bills update once without reopening a stopped run", () => {
  const budget = new RunBudget({ ...caps, jevPosts: 2 });
  const a = budget.reserve("jev", "decision", 1), b = budget.reserve("jev", "decision", 1);
  assert.throws(() => budget.reserve("jev", "decision", 1), /budget_stop/);
  budget.unknown(a); budget.unknown(b);
  budget.observe(a, { costUsd: 0.01 }); budget.observe(a, { costUsd: 0.01 });
  assert.equal(budget.observedJevUsd, 0.01); assert.equal(budget.sends[1].costUsd, null);
  assert.equal(budget.halted, true); assert.throws(() => budget.reserve("jev", "decision", 2));
});

test("all in-flight IDs and known/unknown consumption are frozen when a threshold is detected", () => {
  const budget = new RunBudget({ ...caps, jevUsd: 0.01 });
  const a = budget.reserve("jev", "decision", 1), b = budget.reserve("jev", "ai_function", 1), c = budget.reserve("jev", "ai_support", 1);
  budget.observe(a, { costUsd: 0.02 });
  assert.equal(budget.stops[0].reason, "observed_jev_budget");
  assert.deepEqual(budget.stops[0].inFlight.map(s => s.id), [b.id, c.id]);
  assert.ok(budget.stops[0].inFlight.every(s => s.costUsd === null));
  assert.throws(() => budget.reserve("jev", "decision", 2));
  budget.observe(b, { costUsd: 0.03 }); budget.observe(c, { costUsd: 0.04 });
  assert.equal(budget.observedJevUsd, 0.09);
  assert.deepEqual(budget.stops[0].inFlight.map(s => s.costUsd), [null, null]);
});

test("a late HTTP completion backfills partial usage without a new send or reopening the stopped run", async () => {
  const budget = new RunBudget(caps), connection = lunaWire({ timeoutMs: null, maxCompletionTokens: null }, budget);
  const entered = pause(), hold = pause(), messages = [{ role: "user", content: "hello" }]; let sent = 0;
  connection.setActive({ id: 1, phase: "generation", turn: 1, requestSha256: researchHash(messages), sendIds: [] } as any);
  budget.lunaCalls++;
  const fetchImpl = connection.instrumentFetch(async () => { sent++; entered.release(); await hold.promise;
    return Response.json({ model: MODEL, usage: { prompt_tokens: 7 }, choices: [] }); });
  const work = fetchImpl("http://synthetic.invalid/v1/chat/completions", { method: "POST", body: JSON.stringify({ purpose: "dialogue_turn", messages }) });
  await entered.promise; budget.stop("trial_timeout"); connection.close();
  assert.equal(budget.sends[0].status, "sent_result_unknown"); assert.equal(budget.sends[0].inputTokens, null);
  hold.release(); await work;
  assert.equal(budget.sends[0].inputTokens, 7); assert.equal(budget.sends[0].outputTokens, null);
  assert.equal(budget.snapshot().missingInputTokens, 0); assert.equal(budget.snapshot().missingOutputTokens, 1);
  assert.equal(sent, 1); assert.equal(budget.halted, true);
  await assert.rejects(fetchImpl("http://synthetic.invalid/v1/chat/completions", { method: "POST", body: "{}" }));
  assert.equal(sent, 1);
});

test("15-minute cut returns without waiting for an ignored abort, publishes nothing late and records remaining cells", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entered = pause(), hold = pause(), h = dependencies({ onCall: async (label: string, phase: string) => {
    if (label !== "warmup" && phase === "generation") { entered.release(); await hold.promise; }
  } });
  const work = runParityLive(await fixture(t), h.deps); await entered.promise;
  t.mock.timers.tick(15 * 60 * 1000);
  const result = await work;
  assert.equal(result.summary.failure, "trial_timeout"); assert.equal(result.trials[0].turns.length, 0);
  assert.equal(result.trials[0].failureAtTurn, 1);
  assert.deepEqual(result.trials[0].notReached, [3]);
  assert.equal(result.trials[0].lastCommittedState?.judgments.length, 0);
  const before = JSON.stringify(result.trials);
  hold.release(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(JSON.stringify(result.trials), before);
});

test("smoke gates are backed by validated communication; normal skips do not block stage transition", async t => {
  const options = await fixture(t); options.manifest.trials = [
    { stage: "smoke", scriptId: "probe", label: "repair-first" }, ...alternatingTrials(["probe"]),
  ];
  const result = await runParityLive(options, dependencies({ empty: true }).deps);
  assert.equal(result.summary.status, "wiring_passed", JSON.stringify(result.summary));
  assert.equal(result.trials[0].gates?.passed, true);
  assert.equal(result.trials.length, 3);
});

test("targeted observation stays per trial, never rewrites the shared initial memo, and replays with frozen results", async t => {
  const options = await fixture(t), result = await runParityLive(options, dependencies({ observe: true }).deps);
  assert.equal(result.summary.status, "wiring_passed", JSON.stringify(result.summary));
  for (const trial of result.trials) {
    assert.equal(trial.calls.filter(c => c.phase === "observation_targeted").length, 1);
    assert.equal(trial.turns[0].trace[0].decisions.length, 2);
    const observedId = trial.turns[0].trace[0].reobservations[0].request.figureIds[0];
    assert.equal(trial.turns[0].state.observationMemo!.figures.find(f => f.id === observedId)!.reobservations.length, 1);
    assert.ok(trial.replay.every(r => r.result.status === "same_material_same_payload"));
  }
  const file = (await readdir(options.cacheDir))[0], cache = JSON.parse(await readFile(join(options.cacheDir, file), "utf8"));
  assert.ok(cache.memo.figures.every((f: any) => f.reobservations.length === 0));
});

test("manifest-file entry point applies recorded values, rejects unsafe paths and keeps default clients unopened", async t => {
  const options = await fixture(t), manifestFile = join(options.outputDir, "..", "manifest.private.json");
  await writeFile(manifestFile, JSON.stringify(options.manifest), { mode: 0o600 });
  const result = await runParityLiveFromManifest({ ...options, manifestFile }, dependencies({ empty: true }).deps);
  assert.equal(result.summary.status, "wiring_passed");
  assert.equal(result.summary.manifestSha256, researchHash(options.manifest));
  await chmod(manifestFile, 0o644);
  await assert.rejects(runParityLiveFromManifest({ ...options, manifestFile }, dependencies().deps), /unsafe_manifest/);
  const h = dependencies();
  await assert.rejects(runParityLive({ ...options, outputDir: process.cwd() }, h.deps));
  assert.deepEqual(h.labels, []);
});

test("partial AI sources retain candidate-level applied IDs and reproduced closed rejection reasons", async t => {
  const result = await runParityLive(await fixture(t), dependencies({ partial: true }).deps);
  assert.equal(result.summary.status, "wiring_passed", JSON.stringify(result.summary));
  for (const coverage of result.summary.coverage) {
    const source = coverage.aiPublic[0], validation = source.candidateValidation as any;
    assert.equal(source.pendingStatus, "partial"); assert.equal(source.status, "partial");
    assert.equal(validation.matchesRecordedCandidates, true);
    assert.deepEqual(validation.rejected, [{ segmentId: "segment_2", reason: "unsupported_expression", candidateKey: "2#2" }]);
    assert.deepEqual(source.candidates.map(c => [c.candidateKey, c.graphId, c.applied]), [["2#1", "3:pub1", true]]);
  }
});

test("overlapping complete calls keep retry ownership while another call is in flight", async () => {
  const budget = new RunBudget(caps), connection = lunaWire({ timeoutMs: null, maxCompletionTokens: null }, budget);
  const sleeping = pause(), retry = pause(), enteredSecond = pause(), second = pause(); let firstPosts = 0;
  const client = createChatClient({ provider: "cloudflare", apiKey: "synthetic-token", purpose: "dialogue_turn", baseUrl: "http://synthetic.invalid/v1" },
    connection.instrumentFetch(async (_url, init) => {
      const text = JSON.parse(String(init?.body)).messages[0].content;
      if (text === "first" && ++firstPosts === 1) return new Response("{}", { status: 503 });
      if (text === "second") { enteredSecond.release(); await second.promise; }
      return Response.json({ model: MODEL, usage: { prompt_tokens: 1, completion_tokens: 1 }, choices: [{ message: { content: TEXT } }] });
    }), { sleep: async () => { sleeping.release(); await retry.promise; } });
  const start = (id: number, text: string) => {
    const messages = [{ role: "user", content: text }]; budget.lunaCalls++;
    return connection.withCall({ id, sendIds: [], phase: "generation", turn: id, requestSha256: researchHash(messages) } as any, () => client.complete(messages));
  };
  const a = start(1, "first"); await sleeping.promise;
  const b = start(2, "second"); await enteredSecond.promise;
  retry.release(); await a; second.release(); await b;
  assert.deepEqual(budget.sends.map(s => s.logicalCallId), [1, 2, 1]);
  assert.equal(budget.lunaCalls, 2); assert.equal(budget.lunaPosts, 3); assert.equal(budget.observedLunaTokens, 4);
});

// Independent verifier: do not use the implementation's JSON/hash/ledger helpers.
function independentHash(value: any): string {
  const canonical = (v: any): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v !== null && typeof v === "object"
    ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function instrumentedDependencies(config: any = {}) {
  const base = dependencies(config), create = base.deps.createLunaClient;
  base.deps.createLunaClient = async (label, options) => {
    const mock = await create(label, options); let phase = "", retried = false;
    const guardedFetch = options.instrumentFetch(async (_url, init) => {
        if ((init?.method ?? "GET") === "GET") return Response.json(await mock.getModelPolicy());
        if (config.retryLuna && label !== "warmup" && phase === "generation" && !retried) { retried = true; return new Response("{}", { status: 503 }); }
        const reply = await mock.complete(JSON.parse(String(init?.body)).messages, { phase });
        return Response.json({ model: reply.model, choices: [{ message: { content: reply.text } }],
          usage: { prompt_tokens: reply.usage?.inputTokens, completion_tokens: reply.usage?.outputTokens } });
      });
    const client = createChatClient({ provider: "cloudflare", apiKey: "synthetic-luna-evidence-token", purpose: "dialogue_turn", baseUrl: "http://synthetic.invalid/v1",
      timeoutMs: options.request.timeoutMs ?? undefined, maxCompletionTokens: options.request.maxCompletionTokens ?? undefined }, async (url, init) => {
      if (config.extraBodyKey && label !== "warmup" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)); body[config.extraBodyKey] = label === "bypass-enabled" ? 0 : 1;
        return guardedFetch(url, { ...init, body: JSON.stringify(body) });
      }
      return guardedFetch(url, init);
    }, { sleep: async () => {} });
    return { getModelPolicy: () => client.getModelPolicy(), complete(messages, opts) { phase = opts?.phase ?? ""; return client.complete(messages, opts); } };
  };
  return base;
}

test("independent evidence contains both raw replay sides, ordered sends/instances and cache byte receipts", async t => {
  const options = await fixture(t), result = await runParityLive(options, instrumentedDependencies({ observe: true }).deps);
  assert.equal(result.summary.status, "wiring_passed"); assert.equal(result.summary.evidenceWriteFailed, false);
  const path = join(result.directory, "verifier-evidence.private.json"), e = JSON.parse(await readFile(path, "utf8"));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(e.version, 1); assert.equal(e.runId, result.summary.runId); assert.equal(e.pairedReplay.length, 4);
  for (const pair of e.pairedReplay) {
    const trial = result.trials[pair.trialOrder], tape = trial.replay.find(r => r.tape.events.at(-1)!.seq === pair.turn)!.tape;
    assert.equal(pair.turn, tape.events.at(-1)!.seq);
    assert.deepEqual([pair.left.label, pair.right.label], ["repair-first", "bypass-enabled"]);
    assert.notEqual(pair.left, pair.right);
    for (const side of [pair.left, pair.right]) {
      assert.equal(independentHash(side.material), side.materialSha256);
      assert.deepEqual(side.material.state, tape.state); assert.deepEqual(side.material.events, tape.events); assert.deepEqual(side.material.profile, trial.profile);
      assert.ok(side.material.profile.lunaRequest); assert.equal(side.material.boundary.luna, "canonical_http_json");
      assert.ok(side.material.own.ownImage.byteSha256);
      assert.equal(side.requests.length, tape.expectedRequests.length);
      for (const [i, r] of side.requests.entries()) { assert.equal(independentHash(r.payload), r.payloadSha256);
        assert.deepEqual([r.provider, r.phase, r.preProjectionPayloadSha256], [tape.expectedRequests[i].provider, tape.expectedRequests[i].phase, tape.expectedRequests[i].requestSha256]);
        if (r.phase !== "observation_targeted") assert.equal(r.payloadSha256, tape.expectedRequests[i].requestSha256);
        if (r.provider === "jev") { assert.ok(r.payload.questions); assert.equal(typeof r.payload.state, "string"); } }
    }
    assert.deepEqual(pair.left.material, pair.right.material); assert.deepEqual(pair.left.requests, pair.right.requests);
  }
  assert.deepEqual(e.events.map((v: any) => v.seq), e.events.map((_v: any, i: number) => i + 1));
  assert.ok(e.events.every((v: any, i: number) => !i || v.at >= e.events[i - 1].at));
  const sends = e.events.filter((v: any) => v.type === "send");
  assert.equal(sends.length, result.summary.budget.lunaPosts + result.summary.budget.jevPosts);
  for (const s of sends) {
    assert.ok(s.provider && s.instanceId && s.callId && s.phase && s.requestedModel);
    const reserve = e.events.find((v: any) => v.type === "reserve" && v.sendId === s.sendId);
    const response = e.events.find((v: any) => v.type === "response" && v.sendId === s.sendId);
    assert.ok(reserve.seq < s.seq && s.seq < response.seq);
    assert.equal(reserve.instanceId, s.instanceId); assert.equal(response.instanceId, s.instanceId);
    if (s.provider === "jev") assert.equal(typeof s.priorObservedMaximumUsd, "number");
  }
  assert.equal(e.events.filter((v: any) => v.type === "complete").length, result.summary.budget.lunaCalls);
  assert.equal(e.events.filter((v: any) => v.type === "policy_get").length, 3);
  for (const id of new Set(sends.map((s: any) => s.instanceId))) assert.equal(new Set(sends.filter((s: any) => s.instanceId === id).map((s: any) => s.trialOrder)).size, 1);
  assert.equal(e.cache.length, 3); assert.equal(e.cache[0].beforeSha256, null); assert.equal(e.cache[0].status, "MISS");
  const cacheBytes = await readFile(join(options.cacheDir, (await readdir(options.cacheDir))[0]));
  assert.equal(e.cache[0].afterSha256, createHash("sha256").update(cacheBytes).digest("hex"));
  assert.deepEqual(e.cache[0].memo, JSON.parse(cacheBytes.toString()).memo);
  for (const receipt of e.cache) {
    assert.equal(independentHash(receipt.memo), receipt.memoSha256); assert.equal(receipt.validated, true);
    assert.equal(receipt.requestedModel, receipt.returnedModel);
    assert.ok(receipt.memo.figures.every((f: any) => f.reobservations.length === 0));
    if (receipt.trialOrder !== null) { assert.equal(receipt.status, "HIT"); assert.equal(receipt.beforeSha256, e.cache[0].afterSha256); assert.equal(receipt.afterSha256, e.cache[0].afterSha256); }
  }
  const raw = await readFile(path, "utf8"); assert.ok(!raw.includes(KEY)); assert.ok(!raw.includes("synthetic-luna-evidence-token")); assert.ok(!raw.includes("data:image/"));
});

test("prelisted envelope metadata never removes nested model label/timestamps", () => {
  assert.deepEqual(EVIDENCE_NORMALIZED_ENVELOPE_FIELDS, ["label", "runId", "timestamp", "timestamps", "startedAt", "finishedAt", "createdAt"]);
  const payload = { label: "model-label", nested: { timestamp: "significant", instructions: "full instructions" } };
  assert.deepEqual(projectReplayValue(payload, { mimeType: "image/png", base64: "c3ludGhldGlj" }), payload);
  assert.notEqual(independentHash(payload), independentHash({ ...payload, nested: { ...payload.nested, timestamp: "changed" } }));
});

test("evidence retains unknown-to-late-usage revisions on one send ID after a run stop", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entered = pause(), hold = pause();
  const h = instrumentedDependencies({ onCall: async (label: string, phase: string) => {
    if (label !== "warmup" && phase === "generation") { entered.release(); await hold.promise; }
  } });
  const work = runParityLive(await fixture(t), h.deps); await entered.promise; t.mock.timers.tick(15 * 60 * 1000);
  const result = await work, path = join(result.directory, "verifier-evidence.private.json");
  assert.equal(result.summary.failure, "trial_timeout"); assert.equal(result.summary.evidenceWriteFailed, false);
  const before = JSON.parse(await readFile(path, "utf8")), stop = before.events.find((v: any) => v.type === "stop" && v.scope === "run");
  const unknown = before.events.find((v: any) => v.type === "response" && v.provider === "luna" && v.status === "unknown");
  assert.ok(stop.inFlight.includes(unknown.sendId)); assert.ok(!before.events.some((v: any) => v.seq > stop.seq && ["send", "commit"].includes(v.type)));
  hold.release(); await new Promise<void>(resolve => setImmediate(resolve)); await new Promise<void>(resolve => setImmediate(resolve));
  const latest = await result.flushBilling(); assert.equal(latest.evidenceWriteFailed, false);
  const after = JSON.parse(await readFile(path, "utf8")), revisions = after.events.filter((v: any) => v.type === "response" && v.sendId === unknown.sendId);
  assert.equal(revisions.at(-1).inputTokens, 10); assert.equal(revisions.at(-1).outputTokens, 2);
  assert.ok(revisions.at(-1).seq > stop.seq); assert.equal(result.trials[0].turns.length, 0);
  assert.equal(after.events.filter((v: any) => v.type === "send").length, before.events.filter((v: any) => v.type === "send").length);
});

test("unknown Jev billing is evidenced before its run stop without subsequent sends or commits", async t => {
  const result = await runParityLive(await fixture(t), instrumentedDependencies({ unknownCost: true }).deps);
  const e = JSON.parse(await readFile(join(result.directory, "verifier-evidence.private.json"), "utf8"));
  const response = e.events.find((v: any) => v.type === "response" && v.provider === "jev"), stop = e.events.find((v: any) => v.type === "stop" && v.reason === "jev_cost_unknown");
  assert.equal(response.costUsd, null); assert.ok(response.seq < stop.seq);
  assert.ok(!e.events.some((v: any) => v.seq > stop.seq && ["send", "commit"].includes(v.type)));
});

test("instance spending guard and known-cost schema failure remain distinguishable evidence", async t => {
  const capped = await runParityLive(await fixture(t), instrumentedDependencies({ cost: 0.02 }).deps);
  const events = JSON.parse(await readFile(join(capped.directory, "verifier-evidence.private.json"), "utf8")).events;
  const cap = events.find((e: any) => e.type === "stop" && e.scope === "instance" && e.reason === "cost_cap");
  assert.ok(cap.instanceId); assert.ok(!events.some((e: any) => e.type === "send" && e.instanceId === cap.instanceId && e.seq > cap.seq));
  const h = instrumentedDependencies(), original = h.deps.createJevTransport;
  h.deps.createJevTransport = label => {
    const native = original(label); return { ...native, async fetchImpl(url, options) {
      const response = await native.fetchImpl(url, options), body = JSON.parse(String(options.body));
      if (body.questions.action) { const data = await response.json(); data.answers = {}; return Response.json(data); }
      return response;
    } };
  };
  const invalid = await runParityLive(await fixture(t), h.deps);
  const e = JSON.parse(await readFile(join(invalid.directory, "verifier-evidence.private.json"), "utf8")).events;
  const error = e.find((v: any) => v.type === "response" && v.provider === "jev" && v.status === "error");
  assert.equal(error.costUsd, 0.001);
  const latest = new Map<number, any>(); for (const r of e.filter((v: any) => v.type === "response" && v.provider === "jev")) latest.set(r.sendId, r);
  assert.equal([...latest.values()].reduce((n, r) => n + r.costUsd, 0), invalid.summary.budget.observedJevUsd);
});

test("setup failure before cached.get records not_attempted without fabricated cache validation", async t => {
  for (const stage of ["luna_client", "jev_transport"] as const) {
    const h = instrumentedDependencies();
    if (stage === "luna_client") { const create = h.deps.createLunaClient;
      h.deps.createLunaClient = (label, options) => { if (label !== "warmup") throw new Error("synthetic setup failure"); return create(label, options); };
    } else h.deps.createJevTransport = () => { throw new Error("synthetic setup failure"); };
    const result = await runParityLive(await fixture(t), h.deps);
    assert.equal(result.summary.status, "wiring_failed"); assert.equal(result.trials[0].completed, false);
    const e = JSON.parse(await readFile(join(result.directory, "verifier-evidence.private.json"), "utf8"));
    assert.deepEqual(e.cache.find((c: any) => c.trialOrder === 0), { trialOrder: 0, status: "not_attempted", reason: `setup_failed:${stage}` });
    assert.deepEqual(result.trials[0].notReached, [1, 3]);
  }
});

for (const terminal of ["ai_function", "ai_support", "ai_extraction"] as const) test(`PL-1: terminal ${terminal} threshold stops state adoption/publication without a later send`, async t => {
  const options = await fixture(t); options.scripts[0].humanTurns = [options.scripts[0].humanTurns[0]];
  options.manifest.trials = options.manifest.trials.slice(0, 1);
  if (terminal === "ai_extraction") options.manifest.caps.lunaTokens = 48;
  else options.manifest.caps.jevUsd = terminal === "ai_function" ? 0.003 : 0.004;
  const h = instrumentedDependencies({ empty: terminal === "ai_extraction" });
  if (terminal === "ai_function") {
    const create = h.deps.createJevTransport;
    h.deps.createJevTransport = label => { const native = create(label); return { ...native, async fetchImpl(url, init) {
      const response = await native.fetchImpl(url, init), p = JSON.parse(String(init.body)), state = JSON.parse(p.state);
      if (state.aiSeq && p.questions.segment_0_act) {
        const data = await response.json(), answer = data.answers.segment_0_act;
        answer.choice = "acknowledge"; answer.probabilities = Object.fromEntries(Object.keys(answer.probabilities).map(k => [k, k === "acknowledge" ? 1 : 0]));
        return Response.json(data);
      }
      return response;
    } }; };
  }
  const result = await runParityLive(options, h.deps), trial = result.trials[0];
  assert.equal(result.summary.failure, terminal === "ai_extraction" ? "luna_token_budget" : "observed_jev_budget");
  assert.equal(result.summary.budget.jevUnknown, false);
  assert.equal(trial.turns.length, 0); assert.equal(trial.lastCommittedState!.judgments.length, 0);
  assert.equal(trial.lastCommittedState!.aiPublic!.pending, null);
  assert.ok(!(await readdir(result.directory)).includes("public-0-2.packet.json"));
  const e = JSON.parse(await readFile(join(result.directory, "verifier-evidence.private.json"), "utf8"));
  const stop = e.events.find((v: any) => v.type === "stop" && v.scope === "run");
  assert.ok(stop); assert.ok(!e.events.some((v: any) => v.seq > stop.seq && ["send", "commit"].includes(v.type)));
  assert.equal(e.events.filter((v: any) => v.type === "send").at(-1).phase, terminal);
});

test("PL-1: terminal extraction also stops at the observed mock token threshold", async t => {
  const options = await fixture(t); options.scripts[0].humanTurns = [options.scripts[0].humanTurns[0]];
  options.manifest.trials = options.manifest.trials.slice(0, 1); options.manifest.caps.lunaTokens = 48;
  const result = await runParityLive(options, dependencies({ empty: true }).deps);
  assert.equal(result.summary.failure, "luna_token_budget"); assert.equal(result.trials[0].turns.length, 0);
  assert.equal(result.trials[0].lastCommittedState!.judgments.length, 0);
});

for (const stall of ["fetch", "body"] as const) test(`PL-2: Jev local timeout stops immediately with unresolved ${stall}, and late billing stays on its send ID`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entered = pause(), hold = pause(), h = instrumentedDependencies({ localSegment: true }), create = h.deps.createJevTransport;
  h.deps.createJevTransport = label => { const native = create(label); return { ...native, async fetchImpl(url, init) {
    const p = JSON.parse(String(init.body)), state = JSON.parse(p.state);
    if (!p.questions.segment_0_act || state.aiSeq) return native.fetchImpl(url, init);
    if (stall === "fetch") { entered.release(); await hold.promise; return native.fetchImpl(url, init); }
    const body = await (await native.fetchImpl(url, init)).text();
    return new Response(new ReadableStream({ start(controller) {
      entered.release(); void hold.promise.then(() => { controller.enqueue(new TextEncoder().encode(body)); controller.close(); });
    } }), { headers: { "Content-Type": "application/json" } });
  } }; };
  const work = runParityLive(await fixture(t), h.deps); await entered.promise; t.mock.timers.tick(15000);
  const result = await work;
  assert.equal(result.summary.failure, "jev_cost_unknown"); assert.equal(result.trials[0].turns.length, 0);
  assert.equal(result.summary.budget.jevPosts, 1); assert.equal(result.summary.budget.jevUnknown, true);
  const e = JSON.parse(await readFile(join(result.directory, "verifier-evidence.private.json"), "utf8"));
  const stop = e.events.find((v: any) => v.type === "stop" && v.reason === "jev_cost_unknown");
  assert.ok(!e.events.some((v: any) => v.seq > stop.seq && ["send", "commit", "complete"].includes(v.type)));
  const id = result.summary.budget.sends.find(s => s.provider === "jev")!.id;
  hold.release(); await new Promise<void>(r => setImmediate(r)); await new Promise<void>(r => setImmediate(r));
  const latest = await result.flushBilling();
  assert.equal(latest.sends.find(s => s.id === id)!.costUsd, 0.001); assert.equal(latest.jevPosts, 1); assert.equal(latest.halted, true);
  assert.equal(result.trials[0].lastCommittedState!.judgments.length, 0);
});

test("PL-2: no Jev send means no unknown charge; normal billed cleanup also stays known", async t => {
  const h = instrumentedDependencies(), create = h.deps.createJevTransport;
  h.deps.createJevTransport = label => ({ ...create(label), readKey: async () => { throw new Error("synthetic key unavailable"); } });
  const refused = await runParityLive(await fixture(t), h.deps);
  assert.equal(refused.summary.budget.jevPosts, 0); assert.equal(refused.summary.budget.jevUnknown, false);
  const normal = await runParityLive(await fixture(t), instrumentedDependencies().deps);
  assert.equal(normal.summary.status, "wiring_passed"); assert.equal(normal.summary.budget.jevUnknown, false);
});

test("PL-3: required evidence write failure is save_failed and fails G3", async t => {
  for (const mode of ["create", "replace"]) {
  const options = await fixture(t), h = instrumentedDependencies(), create = h.deps.createLunaClient;
  h.deps.createLunaClient = async (label, settings) => {
    if (label === "warmup") {
      const dir = join(options.outputDir, (await readdir(options.outputDir))[0]);
      if (mode === "create") await rm(join(dir, "verifier-evidence.private.json"));
      await mkdir(join(dir, "verifier-evidence.private.pending.json"));
    }
    return create(label, settings);
  };
  const result = await runParityLive(options, h.deps);
  assert.equal(result.summary.status, "save_failed"); assert.equal(result.summary.failure, "evidence_record_failed");
  assert.equal(result.summary.auditability.status, "save_failed");
  assert.ok(result.summary.gates.every(g => g?.G3.passed === false && g.G3.evidencePresent === false));
  assert.equal((await readdir(result.directory)).includes("verifier-evidence.private.json"), mode === "replace");
  }
});

test("PL-3: late evidence/billing persistence failure reports final auditability diff without rewriting snapshot", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const entered = pause(), hold = pause();
  const h = instrumentedDependencies({ onCall: async (label: string, phase: string) => {
    if (label !== "warmup" && phase === "generation") { entered.release(); await hold.promise; }
  } });
  const work = runParityLive(await fixture(t), h.deps); await entered.promise; t.mock.timers.tick(15 * 60 * 1000);
  const result = await work, before = JSON.stringify(result.summary);
  assert.equal(result.summary.auditability.status, "auditable");
  await mkdir(join(result.directory, "verifier-evidence.private.pending.json"));
  await rm(join(result.directory, "billing.private.jsonl")); await mkdir(join(result.directory, "billing.private.jsonl"));
  hold.release(); await new Promise<void>(r => setImmediate(r)); await new Promise<void>(r => setImmediate(r));
  const latest = await result.flushBilling();
  assert.equal(latest.auditability.status, "save_failed"); assert.equal(latest.auditability.snapshotStatus, "auditable");
  assert.equal(latest.auditability.changedSinceSnapshot, true);
  assert.ok(latest.auditability.diff.evidenceWriteFailed); assert.ok(latest.auditability.diff.billingWriteFailed);
  assert.equal(JSON.stringify(result.summary), before);
});

test("PL-4: both native offline serializers reproduce complete HTTP payloads and each recorded POST/retry", async t => {
  const options = await fixture(t); options.manifest.lunaRequest = { timeoutMs: 10000, maxCompletionTokens: 321 } as any;
  const result = await runParityLive(options, instrumentedDependencies({ observe: true, retryLuna: true }).deps);
  assert.equal(result.summary.status, "wiring_passed");
  const e = JSON.parse(await readFile(join(result.directory, "verifier-evidence.private.json"), "utf8"));
  for (const pair of e.pairedReplay) {
    const trial = result.trials[pair.trialOrder], replay = trial.replay.find(r => r.tape.events.at(-1)!.seq === pair.turn)!;
    assert.equal(replay.result.actualLunaHttpMeasured, true); assert.equal(replay.result.reproducedRecordedPayloads, true);
    for (const side of [pair.left, pair.right]) for (const [i, r] of side.requests.entries()) {
      assert.equal(r.payloadDomain, "canonical_http_json"); assert.equal(independentHash(r.payload), r.payloadSha256);
      assert.equal(r.preProjectionPayloadSha256, replay.tape.expectedRequests[i].requestSha256);
      if (r.provider === "luna") {
        assert.deepEqual(Object.keys(r.payload).sort(), ["max_completion_tokens", "messages", "purpose"]);
        assert.equal(r.payload.purpose, "dialogue_turn"); assert.equal(r.payload.max_completion_tokens, 321);
        assert.equal(r.completeMessagesSha256, replay.tape.expectedRequests[i].messagesSha256);
        const actual = trial.http.filter(h => h.sendId !== null && replay.tape.expectedRequests[i].sendIds!.includes(h.sendId));
        assert.ok(actual.length > 0); assert.ok(actual.every(h => h.hashScheme === "canonical_json_sha256" && h.requestSha256 === r.preProjectionPayloadSha256));
        if (r.phase === "generation" && pair.turn === 1) assert.equal(actual.length, 2);
      }
    }
  }
  const { createTrialV2, modelView } = await import("../dialogue-model/runtime/stimuli/scatter-v2.mjs"), board = modelView(createTrialV2({ seed: 1701 }));
  const trial = result.trials[0], tape = trial.replay[0].tape, changed = { ...trial.profile, lunaRequest: { ...trial.profile.lunaRequest, maxCompletionTokens: 322 } };
  const replay = await pairedReplay(tape, { ownImage: { mimeType: board.mimeType, base64: board.png.toString("base64") }, ownAnchors: board.anchors }, MODEL, changed as any);
  assert.equal(replay.status, "same_material_payload_mismatch"); assert.equal(replay.reproducedRecordedPayloads, false); assert.equal(replay.labelsEqual, true);
  assert.deepEqual(replay.sides[0].requests.filter(r => r.provider === "luna").map(r => r.completeMessagesSha256),
    tape.expectedRequests.filter(r => r.provider === "luna").map(r => r.messagesSha256));
});

for (const key of ["temperature", "model", "top_p", "unknown_body_key"]) test(`PL-4: extra Luna body key ${key} is refused before an actual trial POST`, async t => {
  const result = await runParityLive(await fixture(t), instrumentedDependencies({ extraBodyKey: key }).deps);
  assert.equal(result.summary.failure, "invalid_luna_wire"); assert.equal(result.summary.budget.lunaPosts, 1);
  assert.equal(result.summary.budget.jevPosts, 0); assert.equal(result.summary.budget.jevUnknown, false);
  assert.equal(result.trials[0].turns.length, 0);
  const e = JSON.parse(await readFile(join(result.directory, "verifier-evidence.private.json"), "utf8"));
  const refusal = e.events.find((v: any) => v.type === "refused" && v.reason === "invalid_luna_wire");
  assert.ok(refusal); assert.ok(!e.events.some((v: any) => v.seq > refusal.seq && ["send", "commit"].includes(v.type)));
});

async function saveGateFixture(t: { after(fn: () => Promise<void>): void }) {
  const options = await fixture(t); options.scripts[0].humanTurns = [options.scripts[0].humanTurns[0]];
  options.manifest.trials = [{ stage: "smoke", scriptId: "probe", label: "repair-first" }, ...alternatingTrials(["probe"])];
  return options;
}

test("PL-3 warm-up billing save failure starts zero trials and records separate warm-up saving failure", async t => {
  const options = await saveGateFixture(t), h = instrumentedDependencies(), create = h.deps.createLunaClient;
  h.deps.createLunaClient = async (label, settings) => {
    if (label === "warmup") await mkdir(join(options.outputDir, (await readdir(options.outputDir))[0], "billing.private.jsonl"));
    return create(label, settings);
  };
  const result = await runParityLive(options, h.deps);
  assert.equal(result.summary.status, "save_failed"); assert.equal(result.summary.failure, "billing_record_failed");
  assert.deepEqual(h.labels, ["warmup"]); assert.equal(result.trials.length, 0); assert.deepEqual(result.summary.gates, []);
  assert.equal(result.summary.warmupSaving.status, "save_failed"); assert.equal(result.summary.warmupSaving.billingWriteFailed, true);
  assert.equal(result.summary.warmupSaving.evidencePresent, true);
  assert.equal(result.summary.skipped.length, 3);
  assert.ok(result.summary.skipped.every((s: any) => s.status === "not_reached" && s.reason === "save_failed:billing.private.jsonl"));
});

test("PL-3 probe A: billing failure in smoke fails historical G3 and prevents all mains", async t => {
  const options = await saveGateFixture(t), h = instrumentedDependencies(), create = h.deps.createLunaClient;
  h.deps.createLunaClient = async (label, settings) => {
    if (label !== "warmup") {
      const file = join(options.outputDir, (await readdir(options.outputDir))[0], "billing.private.jsonl");
      await rm(file); await mkdir(file);
    }
    return create(label, settings);
  };
  const result = await runParityLive(options, h.deps), smoke = result.trials[0];
  assert.deepEqual(h.labels, ["warmup", "repair-first"]); assert.equal(result.trials.length, 1);
  assert.equal(smoke.completed, true); assert.equal(smoke.failure, null); assert.equal(result.summary.budget.jevUnknown, false);
  assert.equal(smoke.gates!.G3.passed, false); assert.equal(smoke.gates!.G3.evidencePresent, true);
  assert.equal(smoke.gates!.G3.saving.billingWriteFailed, true); assert.equal(smoke.gates!.G3.saving.requiredWritesComplete, false);
  assert.ok(Object.values(smoke.gates!.G3.saving.fields).every(Boolean));
  assert.equal(result.summary.status, "save_failed"); assert.equal(result.summary.executionFailure, null);
  const saved = JSON.parse(await readFile(join(result.directory, "trial-0.private.json"), "utf8"));
  assert.deepEqual(saved.gates, smoke.gates); assert.deepEqual(saved.gates, result.summary.gates[0]);
  assert.equal(result.summary.skipped.length, 2);
  assert.ok(result.summary.skipped.every((s: any) => s.status === "not_reached" && s.reason === "save_failed:billing.private.jsonl"));
});

test("PL-3 probe B: later main evidence failure stops the next main without rewriting good smoke G3", async t => {
  const options = await saveGateFixture(t), h = instrumentedDependencies(), create = h.deps.createLunaClient;
  h.deps.createLunaClient = async (label, settings) => {
    if (label === "bypass-enabled") await mkdir(join(options.outputDir, (await readdir(options.outputDir))[0], "verifier-evidence.private.pending.json"));
    return create(label, settings);
  };
  const result = await runParityLive(options, h.deps);
  assert.deepEqual(h.labels, ["warmup", "repair-first", "bypass-enabled"]); assert.equal(result.trials.length, 2);
  assert.equal(result.summary.warmupSaving.status, "auditable");
  const smoke = JSON.parse(await readFile(join(result.directory, "trial-0.private.json"), "utf8"));
  const main = JSON.parse(await readFile(join(result.directory, "trial-1.private.json"), "utf8"));
  assert.equal(smoke.gates.G3.passed, true); assert.equal(main.gates.G3.passed, false);
  assert.deepEqual(smoke.gates, result.trials[0].gates); assert.deepEqual(smoke.gates, result.summary.gates[0]);
  assert.deepEqual(main.gates, result.trials[1].gates); assert.deepEqual(main.gates, result.summary.gates[1]);
  assert.equal(result.summary.status, "save_failed"); assert.equal(result.summary.auditability.status, "save_failed");
  assert.equal(result.summary.executionFailure, null);
  assert.equal(result.summary.skipped.length, 1);
  assert.equal((result.summary.skipped[0] as any).reason, "save_failed:verifier-evidence.private.json");
  const final = await result.flushBilling(); assert.equal(final.auditability.status, "save_failed");
  assert.equal(final.auditability.changedSinceSnapshot, false); assert.equal(result.summary.gates[0]!.G3.passed, true);
});

for (const file of ["run.private.json", "warmup.private.json", "public-0-2.packet.json", "trial-0.private.json"]) test(`PL-3 required record ${file} failure blocks the next trial`, async t => {
  const options = await saveGateFixture(t), h = instrumentedDependencies(), create = h.deps.createLunaClient;
  const warmFault = file === "run.private.json" || file === "warmup.private.json";
  let injected = false;
  h.deps.createLunaClient = async (label, settings) => {
    if (!injected && (warmFault ? label === "warmup" : label !== "warmup")) {
      injected = true; const target = join(options.outputDir, (await readdir(options.outputDir))[0], file);
      if (file === "run.private.json") await rm(target);
      await mkdir(target);
    }
    return create(label, settings);
  };
  const result = await runParityLive(options, h.deps);
  assert.equal(result.summary.status, "save_failed"); assert.equal(result.summary.failure, "required_record_failed");
  assert.equal(result.summary.executionFailure, null); assert.equal(result.summary.auditability.requiredWritesComplete, false);
  assert.ok(result.summary.auditability.recordReceipts.some(r => r.file === file && r.status === "failed"));
  assert.equal(result.trials.length, warmFault ? 0 : 1); assert.equal(h.labels.length, warmFault ? 1 : 2);
  if (!warmFault) assert.equal(result.trials[0].gates!.G3.passed, false);
  assert.ok(result.summary.skipped.every((s: any) => s.reason === `save_failed:${file}`));
  if (file === "run.private.json") assert.equal(result.summary.warmupSaving.fields.manifest, false);
});

test("PL-3 final summary write failure preserves historical G3 and returns a matching auditability snapshot", async t => {
  const options = await saveGateFixture(t), h = instrumentedDependencies(), create = h.deps.createLunaClient;
  h.deps.createLunaClient = async (label, settings) => {
    if (label === "warmup") await mkdir(join(options.outputDir, (await readdir(options.outputDir))[0], "summary.private.json"));
    return create(label, settings);
  };
  const result = await runParityLive(options, h.deps);
  assert.equal(result.summary.status, "save_failed"); assert.equal(result.summary.failure, "required_record_failed");
  assert.equal(result.summary.executionFailure, null); assert.equal(result.summary.auditability.status, "save_failed");
  assert.ok(result.summary.gates.every(g => g!.G3.passed));
  for (const trial of result.trials) assert.deepEqual(JSON.parse(await readFile(join(result.directory, `trial-${trial.order}.private.json`), "utf8")).gates, trial.gates);
  const final = await result.flushBilling(); assert.equal(final.auditability.snapshotStatus, "save_failed");
  assert.equal(final.auditability.changedSinceSnapshot, false);
});

// PREAPPROVAL-15: explicit phase settings only; these values select no live run.
function phaseClock(t: TestContext) {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scheduled: Array<{ at: number; ms: number }> = [], timer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", ((fn: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    scheduled.push({ at: now, ms: ms ?? 0 }); return timer(fn, ms, ...args);
  }) as typeof setTimeout);
  return { scheduled, now: () => now, advance(ms: number) { now += ms; t.mock.timers.tick(ms); } };
}
function phaseDependencies(config: any = {}, hooks: {
  luna?(label: string, options: any): Promise<void> | void;
  jev?(phase: string, init: RequestInit): Promise<void> | void;
} = {}) {
  const h = dependencies(config), createLuna = h.deps.createLunaClient, createJev = h.deps.createJevTransport;
  const luna: Array<{ label: string; phase: string; timeoutMs: number; signal: AbortSignal }> = [];
  h.deps.createLunaClient = async (label, settings) => {
    const base = await createLuna(label, settings);
    return { getModelPolicy: () => base.getModelPolicy(), async complete(messages, options) {
      luna.push({ label, phase: options!.phase!, timeoutMs: options!.timeoutMs!, signal: options!.signal! });
      await hooks.luna?.(label, options);
      return base.complete(messages, options);
    } };
  };
  h.deps.createJevTransport = label => {
    const base = createJev(label);
    return { ...base, async fetchImpl(url, init) {
      const p = JSON.parse(String(init.body)), state = JSON.parse(p.state);
      const phase = p.questions.human_referent ? "human_referent" : Object.keys(p.questions).some(k => k.endsWith("_support"))
        ? "ai_support" : Object.keys(p.questions).some(k => k.endsWith("_act")) ? state.aiSeq ? "ai_function" : "local_function" : "decision";
      await hooks.jev?.(phase, init); return base.fetchImpl(url, init);
    } };
  };
  return { ...h, luna };
}

test("phaseTimeouts: omission preserves literal V1/effective/approved-manifest hashes; explicit profiles are detached and frozen", () => {
  const defaults = researchTrialProfile({ timeoutMs: null, maxCompletionTokens: null });
  assert.equal(researchHash(RESEARCH_TRIAL_PROFILE_V1), "b3025144c8048d4ff0f77e8689d7572bd67b967291dd3e7cc802b6e80a843229");
  assert.equal(researchHash(defaults), "926ff7b7fb7c75a7003b97d0a68358a955c38427fc4743baf4284e769af54a58");
  assert.equal(researchHash(APPROVED_RUN_MANIFEST), "2341321ef82803d2da21aaf46529eac5252ca9a9cd8c34c59f66534e0a38ea50");
  assert.deepEqual(validateRunManifest(APPROVED_RUN_MANIFEST), APPROVED_RUN_MANIFEST);
  assert.equal(Object.hasOwn(validateRunManifest(APPROVED_RUN_MANIFEST), "phaseTimeouts"), false);
  const selected = { observationMs: 60000, localMs: 59000 }, profile = researchTrialProfile(defaults.lunaRequest, selected);
  assert.deepEqual(profile.timeouts, { observationMs: 60000, localMs: 59000, decisionMs: 15000, generationMs: 40000 });
  assert.ok(Object.isFrozen(profile) && Object.isFrozen(profile.timeouts) && Object.isFrozen(profile.lunaRequest));
  selected.observationMs = 1; assert.equal(profile.timeouts.observationMs, 60000);
  assert.notEqual(researchHash(profile), researchHash(defaults));
  assert.notEqual(researchHash(profile), researchHash(researchTrialProfile(defaults.lunaRequest, { observationMs: 60000, localMs: 60000 })));
  assert.notEqual(researchHash(profile), researchHash(researchTrialProfile(defaults.lunaRequest, { observationMs: 59000, localMs: 59000 })));
  assert.deepEqual(defaults.timeouts, { observationMs: 20000, localMs: 20000, decisionMs: 15000, generationMs: 40000 });
});

test("phaseTimeouts: strict nested and top-level validation, accepted endpoints and private manifest round-trip", async t => {
  const { loadRunManifest } = await import("../dialogue-model/runtime/diagnostics/parity-live/manifest.ts");
  const options = await fixture(t), file = join(options.outputDir, "..", "phase-manifest.private.json");
  for (const phaseTimeouts of [{ observationMs: 1, localMs: 60000 }, { observationMs: 60000, localMs: 1 }]) {
    const value = { ...options.manifest, phaseTimeouts };
    assert.deepEqual(validateRunManifest(value), value);
    await writeFile(file, JSON.stringify(value), { mode: 0o600 }); assert.deepEqual(await loadRunManifest(file), value);
    const before = { ...phaseTimeouts }, detached = validateRunManifest(value);
    detached.phaseTimeouts!.localMs = 2; assert.deepEqual(value.phaseTimeouts, before);
  }
  const invalid: unknown[] = [null, undefined, [], [60000, 60000], {}, { observationMs: 1 }, { localMs: 1 }, "60000",
    { observationMs: 1, localMs: 1, aiPublicMs: 1 }, { observationMs: 1, localMs: 1, decisionMs: 1 }];
  for (const field of ["observationMs", "localMs"]) for (const value of [null, "60000", 0, -1, 60001, 1.5, NaN, Infinity, -Infinity, true]) {
    invalid.push({ observationMs: 60000, localMs: 60000, [field]: value });
  }
  for (const phaseTimeouts of invalid) assert.throws(() => validateRunManifest({ ...options.manifest, phaseTimeouts } as any));
  for (const phaseTimeouts of invalid.filter(v => v !== undefined)) {
    assert.throws(() => researchTrialProfile(options.manifest.lunaRequest, phaseTimeouts as any));
  }
  assert.throws(() => validateRunManifest({ ...options.manifest, phaseTimeouts: { observationMs: 1, localMs: 1 }, extra: 1 } as any));
});

test("phaseTimeouts: both labels, saved records, timeout identities and native paired replay bind the same effective profile", async t => {
  const options = await fixture(t), selected = { ...options, manifest: { ...options.manifest,
    lunaRequest: { timeoutMs: 60000, maxCompletionTokens: null }, phaseTimeouts: { observationMs: 60000, localMs: 59000 } } };
  const result = await runParityLive(selected, instrumentedDependencies({ observe: true, localSegment: true }).deps);
  assert.equal(result.summary.status, "wiring_passed");
  const expected = researchTrialProfile(selected.manifest.lunaRequest, selected.manifest.phaseTimeouts), hash = researchHash(expected);
  const run = JSON.parse(await readFile(join(result.directory, "run.private.json"), "utf8"));
  const summary = JSON.parse(await readFile(join(result.directory, "summary.private.json"), "utf8"));
  const evidence = JSON.parse(await readFile(join(result.directory, "verifier-evidence.private.json"), "utf8"));
  assert.deepEqual(run.manifest, selected.manifest); assert.equal(run.manifestSha256, researchHash(selected.manifest));
  for (const record of [run, summary, ...result.trials]) { assert.deepEqual(record.profile, expected); assert.equal(record.profileSha256, hash); }
  assert.deepEqual(result.trials.map(v => v.label), ["bypass-enabled", "repair-first"]);
  for (const trial of result.trials) {
    const saved = JSON.parse(await readFile(join(result.directory, `trial-${trial.order}.private.json`), "utf8"));
    assert.deepEqual(saved.profile, expected); assert.equal(saved.profileSha256, hash);
    assert.equal(trial.identity.profile, hash); assert.equal(trial.identity.timeouts, researchHash(expected.timeouts));
    assert.ok(trial.replay.every(r => r.result.status === "same_material_same_payload"));
  }
  for (const pair of evidence.pairedReplay) {
    assert.deepEqual(pair.left.material.profile, expected); assert.deepEqual(pair.right.material.profile, expected);
  }
});

test("phaseTimeouts: warm-up/reobservation and human/AI work cross 20s; later checks receive residual shared budgets", async t => {
  const clock = phaseClock(t), checks: Array<{ phase: string; timer: number }> = [];
  const h = phaseDependencies({ observe: true, localSegment: true }, {
    luna(_label, options) {
      if (["observation_initial", "observation_targeted"].includes(options.phase)) clock.advance(25000);
      if (["local_extraction", "ai_extraction"].includes(options.phase)) clock.advance(50000);
    },
    jev(phase) {
      checks.push({ phase, timer: clock.scheduled.at(-1)!.ms });
      if (phase === "local_function") clock.advance(2000);
      if (phase === "ai_function") clock.advance(4000);
    },
  });
  const options = await fixture(t), result = await runParityLive({ ...options, manifest: { ...options.manifest,
    phaseTimeouts: { observationMs: 60000, localMs: 60000 } } }, h.deps);
  assert.equal(result.summary.status, "wiring_passed");
  assert.ok(clock.now() > 20000);
  for (const phase of ["observation_initial", "observation_targeted", "local_extraction", "ai_extraction"]) {
    const calls = h.luna.filter(c => c.phase === phase); assert.ok(calls.length > 0);
    assert.ok(calls.every(c => c.timeoutMs === 60000), phase);
  }
  assert.ok(h.luna.filter(c => c.phase === "generation").every(c => c.timeoutMs === 40000));
  for (const [phase, expected] of [["local_function", 10000], ["ai_function", 10000], ["ai_support", 6000]] as const) {
    const calls = checks.filter(c => c.phase === phase); assert.ok(calls.length > 0); assert.ok(calls.every(c => c.timer === expected), JSON.stringify(calls));
  }
  assert.ok(checks.filter(c => ["human_referent", "decision"].includes(c.phase)).every(c => c.timer === 15000));
});

for (const phase of ["observation_initial", "observation_targeted", "local_extraction", "ai_extraction"]) {
  test(`phaseTimeouts: ${phase} continues beyond 20s and aborts at its explicit 60s deadline`, async t => {
    const clock = phaseClock(t), entered = pause(), hold = pause(); let stalled = false;
    const h = phaseDependencies({ observe: true }, { async luna(_label, options) {
      if (options.phase === phase && !stalled) { stalled = true; entered.release(); await hold.promise; }
    } });
    const options = await fixture(t), work = runParityLive({ ...options, manifest: { ...options.manifest,
      phaseTimeouts: { observationMs: 60000, localMs: 60000 } } }, h.deps);
    try {
      await entered.promise;
      const active = h.luna.find(c => c.phase === phase)!; assert.equal(active.timeoutMs, 60000);
      clock.advance(20001); assert.equal(active.signal.aborted, false);
      clock.advance(39998); assert.equal(active.signal.aborted, false);
      clock.advance(1); assert.equal(active.signal.aborted, true);
      const result = await work;
      assert.equal(result.summary.status, "wiring_failed");
      assert.ok(result.trials.every(trial => trial.turns.length === 0));
      if (phase === "observation_initial") assert.equal(result.trials.length, 0);
    } finally { hold.release(); await new Promise<void>(resolve => setImmediate(resolve)); }
  });
}

for (const [clientMs, callMs, expected] of [[20000, 60000, 20000], [60000, 20000, 20000],
  [null, 60000, 45000], [60000, 40000, 40000]] as const) {
  test(`phaseTimeouts: native client actually aborts fetch at min(${clientMs ?? "text default"}, ${callMs})=${expected}`, async t => {
    const clock = phaseClock(t), entered = pause(); let signal!: AbortSignal;
    const client = createChatClient({ provider: "cloudflare", apiKey: "synthetic-private-key", purpose: "dialogue_turn",
      baseUrl: "http://synthetic.invalid/v1", timeoutMs: clientMs ?? undefined }, async (_url, init) => {
      signal = init!.signal!; entered.release(); return new Promise<Response>(() => {});
    });
    const work = client.complete([{ role: "user", content: "synthetic" }], { timeoutMs: callMs });
    const rejected = assert.rejects(work, (error: any) => error.code === "timeout" && error.timeoutMs === expected);
    await entered.promise; clock.advance(expected - 1); assert.equal(signal.aborted, false);
    clock.advance(1); assert.equal(signal.aborted, true); await rejected;
  });
}

test("phaseTimeouts: selecting 60s phases never extends the native Jev 15s transport deadline", async t => {
  const clock = phaseClock(t), entered = pause(), hold = pause(); let signal!: AbortSignal;
  const h = phaseDependencies({}, { async jev(phase, init) {
    if (phase === "human_referent") { signal = init.signal!; entered.release(); await hold.promise; }
  } });
  const options = await fixture(t), work = runParityLive({ ...options, manifest: { ...options.manifest,
    phaseTimeouts: { observationMs: 60000, localMs: 60000 } } }, h.deps);
  try {
    await entered.promise; clock.advance(14999); assert.equal(signal.aborted, false);
    clock.advance(1); assert.equal(signal.aborted, true);
    const result = await work; assert.equal(result.summary.status, "wiring_failed"); assert.equal(result.trials[0].turns.length, 0);
  } finally { hold.release(); await new Promise<void>(resolve => setImmediate(resolve)); }
});

// PREAPPROVAL-16R2 producer-only captures. No independent verifier is imported.
export const FAILURE_SCENARIOS = ["observation_timeout", "policy_get_failed", "post_cache", "cache_read_failed", "cache_read_and_save_failed"] as const;
export type FailureScenario = typeof FAILURE_SCENARIOS[number];
export async function failureScenario(t: TestContext, scenario: FailureScenario) {
  const options = await saveGateFixture(t);
  options.scripts[0].humanTurns = options.scripts[0].humanTurns.slice(0, 1);
  const entered = pause(), interrupted: { signal: AbortSignal | null } = { signal: null };
  const h = instrumentedDependencies({ onCall: async (label: string, phase: string) => {
    if (label !== "warmup" && phase === "ai_extraction" && scenario.startsWith("cache_read")) {
      for (const file of await readdir(options.cacheDir)) await rm(join(options.cacheDir, file));
      if (scenario === "cache_read_and_save_failed") {
        await mkdir(join(options.outputDir, (await readdir(options.outputDir))[0], "trial-0.private.json"));
      }
    }
  } });
  if (scenario === "post_cache") {
    const synthetic = dependencies(), create = synthetic.deps.createLunaClient;
    h.deps.createLunaClient = async (label, settings) => {
      const base = await create(label, settings);
      const native = createChatClient({ provider: "cloudflare", apiKey: "synthetic-private-key", purpose: "dialogue_turn",
        baseUrl: "http://synthetic.invalid/v1" }, settings.instrumentFetch(async () => Response.json(await base.getModelPolicy())));
      // Intentionally inconsistent wiring: measured GET, but no HTTP POST for
      // complete. The genuine post-cache wiring failure must remain visible.
      return { getModelPolicy: () => native.getModelPolicy(), complete: base.complete };
    };
  } else if (scenario === "policy_get_failed" || scenario === "observation_timeout") {
    const create = h.deps.createLunaClient;
    h.deps.createLunaClient = (label, settings) => create(label, { ...settings,
      instrumentFetch: fetchImpl => settings.instrumentFetch(async (url, init) => {
        if (scenario === "policy_get_failed" && (init?.method ?? "GET") === "GET") return new Response("{}", { status: 401 });
        if (scenario === "observation_timeout" && init?.method === "POST") {
          interrupted.signal = init.signal!; entered.release();
          return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("synthetic abort")), { once: true }));
        }
        return fetchImpl(url, init);
      }) });
  }
  const clock = scenario === "observation_timeout" ? phaseClock(t) : null;
  const work = runParityLive(options, h.deps);
  if (clock) { await entered.promise; clock.advance(20000); }
  const result = await work;
  return { result, options, h, abortedSignal: interrupted.signal };
}
export async function capturedFailureRecords(directory: string) {
  const records: any = { trials: [], packets: [], storage: [], billing: [] };
  for (const name of (await readdir(directory)).sort()) {
    const file = join(directory, name), info = await stat(file);
    records.storage.push({ name, mode: info.mode & 0o777, external: true, regular: info.isFile() });
    if (!info.isFile()) continue;
    const text = await readFile(file, "utf8");
    if (name === "billing.private.jsonl") { records.billing = text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); continue; }
    if (!name.endsWith(".json")) continue;
    const value = JSON.parse(text);
    if (/^trial-\d+\.private\.json$/u.test(name)) records.trials.push(value);
    else if (name.startsWith("public-")) records.packets.push({ name, value });
    else if (name === "run.private.json") records.run = value;
    else if (name === "summary.private.json") records.summary = value;
    else if (name === "warmup.private.json") records.warmup = value;
    else if (name === "failure.private.json") records.failure = value;
    else if (name === "verifier-evidence.private.json") records.evidence = value;
  }
  return records;
}
function assertPlannedMapping(result: Awaited<ReturnType<typeof runParityLive>>, count: number) {
  const indices = [...result.trials.map(trial => trial.plannedIndex), ...result.summary.skipped.map(skipped => skipped.plannedIndex)];
  assert.deepEqual(indices.sort((a, b) => a - b), Array.from({ length: count }, (_, i) => i));
}
for (const scenario of FAILURE_SCENARIOS) test(`failure producer: ${scenario} retains receipt ownership and every planned slot`, async t => {
  const { result, options, abortedSignal } = await failureScenario(t, scenario), records = await capturedFailureRecords(result.directory);
  const failure = records.failure;
  assert.equal(records.run.plannedMappingVersion, 1); assertPlannedMapping(result, options.manifest.trials.length);
  assert.equal(failure.schemaVersion, "parity_live_failure_v1");
  assert.ok(result.summary.status !== "wiring_passed");
  if (!scenario.startsWith("cache_read")) {
    assert.deepEqual(Object.keys(failure).sort(), ["schemaVersion", "scope", "code", "stage", "calls", "cache", "observationCallStarted", "policy", "http", "deadlines"].sort());
    assert.equal(failure.scope, "warmup"); assert.equal(records.warmup, undefined); assert.equal(result.trials.length, 0);
    assert.equal(failure.http.measured, true); assert.ok(failure.http.records.every((r: any) => ["returned", "unknown"].includes(r.outcome)));
    assert.deepEqual(failure.deadlines.configured, { observationMs: 20000, lunaClientTimeoutMs: null });
    assert.deepEqual(failure.deadlines.applied.completeCalls.map((c: any) => c.callId), failure.calls.map((c: any) => c.id));
    assert.equal(new Set(failure.deadlines.applied.completeCalls.map((c: any) => c.callId)).size, failure.calls.length);
    assert.ok(result.summary.skipped.every(s => s.reason === `warmup_failed:${failure.code}`));
    if (scenario === "policy_get_failed") {
      assert.equal(failure.stage, "policy_get"); assert.deepEqual(failure.policy, { status: "failed", value: null });
      assert.equal(failure.observationCallStarted, false); assert.equal(failure.deadlines.applied.observationOuterMs, null);
      assert.deepEqual(failure.deadlines.applied.completeCalls, []); assert.deepEqual(failure.calls, []);
      assert.equal(failure.http.records.length, 1); assert.equal(failure.http.records[0].kind, "policy_get");
      assert.equal(result.summary.budget.lunaPosts, 0);
    } else {
      assert.equal(failure.stage, scenario === "post_cache" ? "post_cache" : "cache_get");
      assert.equal(failure.policy.status, "obtained"); assert.deepEqual(Object.keys(failure.policy.value).sort(), ["model", "provider", "purpose", "ready"]);
      assert.equal(failure.observationCallStarted, true); assert.equal(failure.deadlines.applied.observationOuterMs, 20000);
      assert.equal(failure.calls.length, 1); assert.equal(failure.deadlines.applied.completeCalls[0].callOptionTimeoutMs, 20000);
      if (scenario === "observation_timeout") {
        assert.equal(abortedSignal!.aborted, true); assert.equal(failure.cache, null); assert.equal(result.summary.budget.lunaPosts, 1);
        assert.equal(failure.http.records.filter((r: any) => r.kind === "completion_post").length, 1);
      } else {
        assert.equal(failure.code, "cache_warmup_http_wiring"); assert.equal(failure.cache.status, "MISS");
        assert.equal(failure.http.records.filter((r: any) => r.kind === "completion_post").length, 0);
      }
    }
  } else {
    assert.deepEqual(failure, { schemaVersion: "parity_live_failure_v1", scope: "after_warmup", code: "cache_read_failed", stage: "trial_loop" });
    assert.ok(records.warmup); assert.equal(result.trials.length, 1); assert.equal(result.trials[0].failure, "cache_read_failed");
    assert.equal(result.trials[0].plannedIndex, 0); assert.equal(result.trials[0].gates!.G1.cacheStable, false);
    assert.ok(result.trials[0].calls.some(c => c.provider === "luna") && result.trials[0].calls.some(c => c.provider === "jev"));
    assert.ok(result.trials[0].http.length > 0);
    assert.equal(result.summary.budget.halted, true);
    if (scenario === "cache_read_failed") {
      assert.equal(records.trials.length, 1); assert.equal(records.trials[0].failure, "cache_read_failed");
      assert.deepEqual(records.trials[0].calls, result.trials[0].calls); assert.deepEqual(records.trials[0].http, result.trials[0].http);
    } else {
      assert.equal(records.trials.length, 0); assert.equal(result.summary.status, "save_failed"); assert.equal(result.trials[0].gates!.G3.passed, false);
      assert.ok(result.summary.skipped.every(s => s.reason === "save_failed:trial-0.private.json"));
    }
  }
  const calls = [...(failure.calls ?? []), ...(records.warmup?.calls ?? []), ...records.trials.flatMap((trial: any) => trial.calls)];
  assert.equal(new Set(calls.map(c => c.id)).size, calls.length);
  const sends = [...(failure.http?.records ?? []), ...(records.warmup?.http ?? []), ...records.trials.flatMap((trial: any) => trial.http)].flatMap(r => r.sendId === null ? [] : [r.sendId]);
  assert.equal(new Set(sends).size, sends.length);
});

test("failure producer: skipped main before smoke preserves plannedIndex distinct from trial order", async t => {
  const options = await saveGateFixture(t), first = options.manifest.trials[0], second = options.manifest.trials[1];
  options.manifest.trials = [second, first];
  const result = await runParityLive(options, instrumentedDependencies().deps);
  assert.equal(result.trials.length, 1); assert.equal(result.trials[0].order, 0); assert.equal(result.trials[0].plannedIndex, 1);
  assert.equal(result.summary.skipped[0].plannedIndex, 0); assert.equal(result.summary.skipped[0].reason, "smoke_stage_not_ready");
  assertPlannedMapping(result, 2);
});

for (const measured of [false, true]) test(`failure producer: client setup fails with policy not requested, measured=${measured}`, async t => {
  const options = await saveGateFixture(t), h = dependencies();
  h.deps.createLunaClient = async (_label, settings) => {
    if (measured) settings.instrumentFetch(async () => { throw new Error("must not send"); });
    throw new Error("synthetic raw error must not be recorded");
  };
  const result = await runParityLive(options, h.deps), records = await capturedFailureRecords(result.directory), failure = records.failure;
  assert.equal(failure.scope, "warmup"); assert.equal(failure.stage, "client_setup");
  assert.deepEqual(failure.policy, { status: "not_requested", value: null });
  assert.deepEqual(failure.http, { measured, records: [] }); assert.deepEqual(failure.calls, []);
  assert.equal(failure.observationCallStarted, false); assert.equal(failure.deadlines.applied.observationOuterMs, null);
  assert.deepEqual(failure.deadlines.applied.completeCalls, []);
  assert.ok(!JSON.stringify(records).includes("synthetic raw error")); assertPlannedMapping(result, options.manifest.trials.length);
});

test("failure producer: an invalid policy is failed/null and retains its measured GET receipt", async t => {
  const options = await saveGateFixture(t), h = instrumentedDependencies(), create = h.deps.createLunaClient;
  h.deps.createLunaClient = async (label, settings) => {
    const base = await create(label, settings);
    return { ...base, async getModelPolicy() { return { ...await base.getModelPolicy(), ready: false }; } };
  };
  const result = await runParityLive(options, h.deps), { failure } = await capturedFailureRecords(result.directory);
  assert.equal(failure.stage, "policy_get"); assert.equal(failure.code, "invalid_model_policy");
  assert.deepEqual(failure.policy, { status: "failed", value: null }); assert.equal(failure.http.records.length, 1);
  assert.equal(failure.http.records[0].kind, "policy_get"); assert.equal(failure.observationCallStarted, false);
});

test("failure producer: other finalization exceptions still save the started trial before after_warmup", async t => {
  const { VerifierEvidence } = await import("../dialogue-model/runtime/diagnostics/parity-live/evidence.ts");
  const cache = VerifierEvidence.prototype.cache;
  t.mock.method(VerifierEvidence.prototype, "cache", function (this: InstanceType<typeof VerifierEvidence>, receipt: Parameters<InstanceType<typeof VerifierEvidence>["cache"]>[0]) {
    if (receipt.trialOrder !== null) throw new Error("synthetic finalization error");
    return cache.call(this, receipt);
  });
  const options = await saveGateFixture(t), result = await runParityLive(options, instrumentedDependencies().deps);
  const records = await capturedFailureRecords(result.directory);
  assert.equal(records.trials.length, 1); assert.equal(records.trials[0].failure, "trial_finalize_failed");
  assert.ok(records.trials[0].calls.length > 0); assert.ok(records.trials[0].http.length > 0);
  assert.deepEqual(records.failure, { schemaVersion: "parity_live_failure_v1", scope: "after_warmup", code: "trial_finalize_failed", stage: "trial_loop" });
  assert.equal(result.summary.budget.halted, true); assertPlannedMapping(result, options.manifest.trials.length);
  assert.equal(result.summary.coverage.length, 0, "unavailable coverage is not fabricated or recomputed after finalization fails");
});

test("failure producer: late warm-up usage revises the same send after close without changing failure ownership", async t => {
  const clock = phaseClock(t), entered = pause(), hold = pause(), parsed = pause();
  const options = await saveGateFixture(t), h = instrumentedDependencies(), create = h.deps.createLunaClient;
  h.deps.createLunaClient = (label, settings) => create(label, { ...settings,
    instrumentFetch: fetchImpl => settings.instrumentFetch(async (url, init) => {
      if (init?.method !== "POST") return fetchImpl(url, init);
      entered.release(); await hold.promise;
      const response = await fetchImpl(url, init), clone = response.clone.bind(response);
      response.clone = () => {
        const body = clone(), json = body.json.bind(body);
        body.json = async () => { const value = await json(); parsed.release(); return value; };
        return body;
      };
      return response;
    }) });
  const work = runParityLive(options, h.deps);
  try {
    await entered.promise; clock.advance(20000);
    const result = await work, original = await readFile(join(result.directory, "failure.private.json"), "utf8");
    const before = JSON.parse(original), send = result.summary.budget.sends[0];
    assert.equal(before.scope, "warmup"); assert.equal(send.status, "sent_result_unknown");
    assert.equal(before.http.records.find((r: any) => r.kind === "completion_post").outcome, "unknown");
    hold.release(); await parsed.promise; await new Promise<void>(resolve => setImmediate(resolve));
    const latest = await result.flushBilling();
    assert.equal(latest.sends.length, 1); assert.equal(latest.sends[0].id, send.id);
    assert.equal(latest.sends[0].inputTokens, 10); assert.equal(latest.sends[0].outputTokens, 2);
    const records = await capturedFailureRecords(result.directory);
    const revisions = records.billing.filter((v: any) => v.entry?.id === send.id);
    assert.equal(revisions.at(-1).entry.inputTokens, 10); assert.equal(revisions.at(-1).entry.outputTokens, 2);
    assert.equal(await readFile(join(result.directory, "failure.private.json"), "utf8"), original);
    assert.equal(result.trials.length, 0); assert.equal(records.trials.length, 0);
    assert.equal(records.evidence.events.filter((v: any) => v.type === "send").length, 1);
  } finally { hold.release(); }
});
