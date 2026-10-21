// Mechanical synthetic mocks only; no model accuracy oracle or live credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat, readdir, writeFile, chmod } from "node:fs/promises";
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
        } else if (options.phase === "local_extraction") text = "[]";
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
  assert.equal(replay.status, "same_material_payload_mismatch"); assert.equal(replay.labelsEqual, true); assert.equal(replay.reproducedRecordedWire, false);
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
    const mock = await create(label, options); let phase = "";
    const client = createChatClient({ provider: "cloudflare", apiKey: "synthetic-luna-evidence-token", purpose: "dialogue_turn", baseUrl: "http://synthetic.invalid/v1" },
      options.instrumentFetch(async (_url, init) => {
        if ((init?.method ?? "GET") === "GET") return Response.json(await mock.getModelPolicy());
        const reply = await mock.complete(JSON.parse(String(init?.body)).messages, { phase });
        return Response.json({ model: reply.model, choices: [{ message: { content: reply.text } }],
          usage: { prompt_tokens: reply.usage?.inputTokens, completion_tokens: reply.usage?.outputTokens } });
      }));
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
      assert.ok(side.material.profile.lunaRequest); assert.equal(side.material.boundary.luna, "complete_messages");
      assert.ok(side.material.own.ownImage.byteSha256);
      assert.equal(side.requests.length, tape.expectedRequests.length);
      for (const [i, r] of side.requests.entries()) { assert.equal(independentHash(r.payload), r.payloadSha256);
        assert.deepEqual([r.provider, r.phase, r.recordedRequestSha256], [tape.expectedRequests[i].provider, tape.expectedRequests[i].phase, tape.expectedRequests[i].requestSha256]);
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
