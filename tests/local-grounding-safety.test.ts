// Synthetic fixtures and in-process clients only. Never call a live endpoint.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, stat, realpath, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArguments, validateOutputDirectory, loadEvaluationCases, assertPublicText, runEvaluation, generateNextReply, evaluationErrorLine } from "../dialogue-model/runtime/diagnostics/local-grounding-eval/run.ts";
import { createNamingTaskV2 } from "../dialogue-model/runtime/v2/naming-task-v2.mjs";
import { createTrialV2 } from "../dialogue-model/runtime/stimuli/scatter-v2.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const policy = { syntheticOnly: true, containsRealParticipantData: false, containsExcelOrPast5Dialogues: false };
const publicTurns = [{ turn: 1, speaker: "human", text: "細い形から話したいです。" }];
const document = (overrides: object = {}) => ({ dataPolicy: policy,
  sequences: [{ sequenceId: "external-synthetic", publicTurns, ownCandidateContext: "PRIVATE-CANDIDATE-CONTEXT",
    expectedLocalInterpretation: { secret: "GOLD-MUST-NOT-ENTER-PROMPT" } }], ...overrides });
const options = (outputDir: string, casesFile?: string) => ({ outputDir, casesFile, seed: 51, strategy: "bypass-enabled" as const });
const local = () => ({ extractor: { async extract() { return []; } }, classifier: { async classify() { return []; } } });
function client(reply = "細い形ですね。") {
  const calls: any[] = [];
  return { calls, async complete(messages: any[], { phase }: any = {}) {
    calls.push({ messages: structuredClone(messages), phase });
    return { text: phase === "judgment" ? JSON.stringify({ action: "accept", targetSlot: null, candidateName: null,
      discriminatingFeature: null, note: null, reference: null }) : reply, model: "mock-model" };
  } };
}
const jsonLines = async (directory: string, file: string): Promise<any[]> => (await readFile(join(directory, file), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
async function assertFailedPair(directory: string, code: string) {
  assert.deepEqual(await jsonLines(directory, "blinded.jsonl"), []);
  assert.deepEqual(await jsonLines(directory, "completed.private.jsonl"), []);
  assert.deepEqual(await jsonLines(directory, "failures.jsonl"), [{ caseId: "external-synthetic", code }]);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "mapping.private.json"), "utf8")).mapping, []);
}

test("harness requires an explicit output directory and rejects ambiguous CLI options", () => {
  assert.throws(() => parseArguments([]), /output_directory_required/);
  for (const args of [["--out"], ["--out", "/tmp/a", "--input", "x"], ["--out", "/tmp/a", "--out", "/tmp/b"],
    ["--out", "/tmp/a", "--seed", "NaN"], ["--out", "/tmp/a", "--strategy", "other"]]) assert.throws(() => parseArguments(args), /invalid_arguments/);
  assert.deepEqual(parseArguments(["--out", "/tmp/eval", "--cases", "/tmp/synthetic.json", "--seed", "71"]),
    { outputDir: "/tmp/eval", casesFile: "/tmp/synthetic.json", seed: 71, strategy: "bypass-enabled" });
  assert.deepEqual(parseArguments(["--resume", "--out", "/tmp/existing-run", "--case", "synthetic-one"]),
    { outputDir: "/tmp/existing-run", seed: 1701, strategy: "bypass-enabled", resume: true, caseId: "synthetic-one" });
  assert.throws(() => parseArguments(["--out", "/tmp/a", "--resume", "--resume"]), /invalid_arguments/);
  assert.equal(evaluationErrorLine(new Error("privacy_rejected")), "synthetic_evaluation_failed privacy_rejected\n");
  assert.equal(evaluationErrorLine(Object.assign(new Error("raw private body"), { code: "timeout" })), "synthetic_evaluation_failed timeout\n");
  assert.equal(evaluationErrorLine(new Error("Bearer private-body-token")), "synthetic_evaluation_failed evaluation_unavailable\n");
});

test("input/output paths reject this repository, any Git tree, ignored paths and symlinks into them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-grounding-paths-"));
  try {
    for (const path of [repository, join(repository, ".ignored-evaluation", "new")]) await assert.rejects(validateOutputDirectory(path), /repository_output_forbidden/);
    const gitTree = join(directory, "another-checkout");
    await mkdir(gitTree);
    await writeFile(join(gitTree, ".git"), "gitdir: synthetic");
    await assert.rejects(validateOutputDirectory(join(gitTree, "ignored", "new")), /repository_output_forbidden/);
    const link = join(directory, "repo-link");
    await symlink(repository, link);
    await assert.rejects(validateOutputDirectory(join(link, "new")), /repository_output_forbidden/);
    await assert.rejects(loadEvaluationCases(join(repository, "package.json")), /repository_output_forbidden/);
    await assert.rejects(loadEvaluationCases(join(link, "package.json")), /repository_output_forbidden/);
    const file = join(directory, "not-directory");
    await writeFile(file, "synthetic");
    await assert.rejects(validateOutputDirectory(file), /invalid_output_directory/);
    assert.equal(await validateOutputDirectory(join(directory, "new", "nested")), resolve(await realpath(directory), "new", "nested"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("external cases require synthetic attestation, bounded public turns and no private payloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-grounding-input-"));
  try {
    const path = join(directory, "synthetic.json");
    await writeFile(path, JSON.stringify(document()));
    assert.deepEqual(await loadEvaluationCases(path), [{ id: "external-synthetic", publicTurns }]);
    for (const invalid of [document({ dataPolicy: { ...policy, containsRealParticipantData: true } }),
      document({ dataPolicy: { ...policy, containsExcelOrPast5Dialogues: true } }), document({ sequences: [] }), document({ sequences: [null] }),
      document({ sequences: [{ sequenceId: "bad", publicTurns: [{ ...publicTurns[0], image: "private" }] }] }),
      document({ sequences: [{ sequenceId: "bad", publicTurns: [{ ...publicTurns[0], turn: 2 }] }] }),
      document({ sequences: [{ sequenceId: "bad", publicTurns: [{ ...publicTurns[0], text: "data:image/png;base64,secret" }] }] })]) {
      await writeFile(path, JSON.stringify(invalid));
      await assert.rejects(loadEvaluationCases(path), /synthetic_attestation_required|invalid_cases|privacy_rejected/);
    }
    await writeFile(path, "not JSON");
    await assert.rejects(loadEvaluationCases(path), /invalid_cases_file/);
    await writeFile(path, " ".repeat(2_000_001));
    await assert.rejects(loadEvaluationCases(path), /invalid_cases_file/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("public export rejects tokens, images, private memo and prompt echoes", () => {
  for (const text of ["Bearer fake-token", "Ｂｅａｒｅｒ　ｆａｋｅ－ｔｏｋｅｎ", "sk-proj-abcdefghijk", "API_KEY=private", "RESEARCH_PROXY_TOKEN=private",
    "data:image/png;base64,abcdef", "A".repeat(240), "ownLedger の内容", "targetSlot: s-ab12", "AI自身の作業メモ（非公開）",
    "【公開発話の生成】", "この発話の判断（非公開）", "nameState is agreed", "issueId=3:ai1", "1:local1", "private-sentinel-12345"]) {
    assert.throws(() => assertPublicText(text, ["private-sentinel-12345"]), /privacy_rejected/);
  }
  assert.doesNotThrow(() => assertPublicText("四角は合っていますが、名前はまだ相談したいです。"));
});

test("blind export separates mapping, retains only public case fields and never overwrites prior runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-grounding-export-"));
  try {
    const path = join(directory, "synthetic.json");
    await writeFile(path, JSON.stringify(document()));
    const mock = client();
    const first = await runEvaluation(options(directory, path), { client: mock, createLocalGrounding: local, expectedModel: "mock-model", randomOrder: () => true });
    const second = await runEvaluation(options(directory, path), { client: mock, createLocalGrounding: local, randomOrder: () => false });
    assert.notEqual(first, second);
    assert.deepEqual((await readdir(first)).sort(), ["blinded.jsonl", "completed.private.jsonl", "failures.jsonl", "mapping.private.json", "run.private.json"]);
    const blinded = await readFile(join(first, "blinded.jsonl"), "utf8");
    assert.doesNotMatch(blinded, /localGrounding|referenceMemory|expected|GOLD|PRIVATE|mock-model|seed|strategy|new|old/);
    const row = JSON.parse(blinded.trim());
    assert.deepEqual(row.publicTurns, publicTurns);
    assert.deepEqual(Object.keys(row.responses), ["A", "B"]);
    const key = JSON.parse(await readFile(join(first, "mapping.private.json"), "utf8"));
    assert.deepEqual(key.mapping, [{ caseId: "external-synthetic", A: "new", B: "old" }]);
    assert.ok(!/GOLD-MUST|PRIVATE-CANDIDATE/.test(JSON.stringify(mock.calls)), "private case metadata must not enter model requests");
    const images = mock.calls.flatMap((call) => call.messages.flatMap((message: any) => Array.isArray(message.content) ?
      message.content.filter((part: any) => part.type === "image_url").map((part: any) => part.image_url.url) : []));
    assert.ok(images.length > 1 && images.every((image: string) => image === images[0]), "old/new pairs use the same seed-derived own image bytes");
    if (process.platform !== "win32") {
      assert.equal((await stat(first)).mode & 0o777, 0o700);
      assert.equal((await stat(join(first, "blinded.jsonl"))).mode & 0o777, 0o600);
      assert.equal((await stat(join(first, "mapping.private.json"))).mode & 0o777, 0o600);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("path/input refusal precedes network; failed pairs retain only a fixed failure code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-grounding-refuse-"));
  try {
    const path = join(directory, "synthetic.json");
    await writeFile(path, JSON.stringify(document()));
    const mock = client();
    await assert.rejects(runEvaluation(options(repository, path), { client: mock, createLocalGrounding: local }), /repository_output_forbidden/);
    assert.equal(mock.calls.length, 0);
    const output = join(directory, "results");
    await writeFile(path, JSON.stringify(document({ sequences: [{ sequenceId: "synthetic-secret", publicTurns: [
      { ...publicTurns[0], text: "private-sentinel-12345" },
    ] }] })));
    await assert.rejects(runEvaluation(options(output, path), { client: mock, createLocalGrounding: local, secrets: ["private-sentinel-12345"] }), /privacy_rejected/);
    assert.equal(mock.calls.length, 0, "known secrets in input must be refused before any model call");
    await writeFile(path, JSON.stringify(document()));
    const changed = await runEvaluation(options(output, path), { client: mock, createLocalGrounding: local, expectedModel: "different" });
    await assertFailedPair(changed, "model_changed");
    const leaking = client("Bearer private-sentinel-12345");
    const rejected = await runEvaluation(options(output, path), { client: leaking, createLocalGrounding: local, secrets: ["private-sentinel-12345"] });
    await assertFailedPair(rejected, "privacy_rejected");
    const failed = { async complete() { throw new Error("sk-proj-private-body-12345"); } };
    const unavailable = await runEvaluation(options(output, path), { client: failed, createLocalGrounding: local });
    await assertFailedPair(unavailable, "evaluation_unavailable");
    for (const directory of [changed, rejected, unavailable]) for (const file of await readdir(directory)) {
      const text = await readFile(join(directory, file), "utf8");
      assert.ok(!/private-sentinel|sk-proj-private-body/.test(text), "raw credentials/errors must never enter artifacts");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("consecutive human messages are replayed as one pending snapshot, with no unpublished intermediate response", async () => {
  const mock = client();
  const example = { id: "consecutive", publicTurns: [
    { turn: 1, speaker: "human" as const, text: "四角のある形です。" },
    { turn: 2, speaker: "human" as const, text: "さっきの説明に訂正があります。" },
  ] };
  await generateNextReply(example, options("/unused"), mock, null);
  assert.equal(mock.calls.filter((call) => call.phase === "judgment").length, 1);
  assert.equal(mock.calls.filter((call) => call.phase === "generation").length, 1);
  const humans = mock.calls[0].messages.filter((message: any) => message.role === "user" && typeof message.content === "string");
  assert.deepEqual(humans.map((message: any) => message.content), example.publicTurns.map((turn) => turn.text));
});

test("a raw private instruction echo is refused even without credential or internal-field markers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-grounding-prompt-echo-"));
  try {
    const path = join(directory, "synthetic.json");
    await writeFile(path, JSON.stringify(document()));
    const base = client();
    const mock = { async complete(messages: any[], callOptions: any) {
      if (callOptions?.phase === "generation") return { text: messages[0].content.split("\n")[0], model: "mock-model" };
      return base.complete(messages, callOptions);
    } };
    const output = join(directory, "results");
    const result = await runEvaluation(options(output, path), { client: mock, createLocalGrounding: local });
    await assertFailedPair(result, "privacy_rejected");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("local-grounding participant/API payloads exclude private memory; model inputs exclude partner image, key and future speech", async () => {
  const trial = createTrialV2({ seed: 1551 });
  const secretImage = "PARTNER-IMAGE-NEVER-TRANSMIT";
  trial.human.png = Buffer.from(secretImage);
  for (const key of Object.keys(trial.key.human)) trial.key.human[key] = "PRIVATE-ANSWER-KEY-HUMAN";
  for (const key of Object.keys(trial.key.ai)) trial.key.ai[key] = "PRIVATE-ANSWER-KEY-AI";
  const records: any[] = [], inputs: any[] = [], calls: any[] = [];
  const localGrounding = {
    extractor: { async extract(input: any) {
      inputs.push({ kind: "extract", input: structuredClone(input) });
      return [{ segmentId: "s1", quote: input.publicTurns.at(-1).text, targets: [input.ownSlots[0]], aspect: "part",
        proposition: "四角がある", name: null, linkedIssueId: null, respondsToTurn: null }];
    } },
    classifier: { async classify(input: any) {
      inputs.push({ kind: "classify", input: structuredClone(input) });
      return input.segments.map((segment: any) => ({ segmentId: segment.segmentId, act: "assert", respondsToClaimId: null, rawScore: 1 }));
    } },
  };
  const generation = { async complete(messages: any[]) { calls.push(structuredClone(messages)); return { text: "なるほど。", model: "mock" }; } };
  const judge = { async judge(input: any) {
    inputs.push({ kind: "judge", input: structuredClone(input) });
    return { action: "accept", targetSlot: null, candidateName: null, discriminatingFeature: null, note: null };
  } };
  const task = await createNamingTaskV2({ client: generation, judge, strategy: "repair-first", seed: 1551, referenceMemory: true,
    localGrounding, runDir: null, createTrial: () => trial,
    onPersist: async (record: any) => { records.push(structuredClone(record)); } } as any);
  task.message("四角い部分があります。", "synthetic-one");
  await task.whenIdle();
  const firstInputs = JSON.stringify(inputs);
  task.message("FUTURE-PUBLIC-TURN-SENTINEL", "synthetic-two");
  await task.whenIdle();
  assert.ok(!firstInputs.includes("FUTURE-PUBLIC-TURN-SENTINEL"), "future speech must not enter earlier model requests");
  const modelInputs = JSON.stringify({ inputs, calls });
  for (const secret of [secretImage, Buffer.from(secretImage).toString("base64"), "PRIVATE-ANSWER-KEY-HUMAN", "PRIVATE-ANSWER-KEY-AI"])
    assert.ok(!modelInputs.includes(secret));
  for (const id of Object.keys(trial.key.human)) assert.ok(!modelInputs.includes(id));
  assert.ok(inputs.some((input) => input.kind === "extract"));
  assert.ok(inputs.some((input) => input.kind === "classify"));
  for (const request of calls) {
    const images = request.flatMap((message: any) => Array.isArray(message.content) ? message.content.filter((part: any) => part.type === "image_url").map((part: any) => part.image_url.url) : []);
    assert.equal(images.length, 1);
    assert.ok(images[0] === "data:image/png;base64," + trial.ai.png.toString("base64"), "only the AI's own image is sent");
  }
  // getState is the participant API serialization boundary.
  const api = JSON.stringify(task.getState());
  assert.doesNotMatch(api, /localGrounding|issueSummary|referenceGraph|ownLedger|priorClaims|claimIds|judgment|ai_hypothesis|data:image|PRIVATE-ANSWER/);
  const record = JSON.stringify(records.at(-1));
  assert.doesNotMatch(record, /data:image|PARTNER-IMAGE|AI自身の作業メモ|公開発話の生成|この発話の判断/);
  assert.ok(!record.includes(trial.ai.png.toString("base64")));
});

test("local model failures and guarded drafts cannot leak raw private response bodies into public state or research records", async () => {
  for (const phase of ["extract", "classify", "generation"]) {
    const records: any[] = [];
    const privateBody = "private_prompt_image_token_12345";
    const localGrounding = {
      extractor: { async extract(input: any) {
        if (phase === "extract") throw Object.assign(new Error(privateBody), { code: privateBody });
        return [{ segmentId: "s1", quote: input.publicTurns.at(-1).text, targets: [input.ownSlots[0]], aspect: "part",
          proposition: "四角がある", name: null, linkedIssueId: null, respondsToTurn: null }];
      } },
      classifier: { async classify(input: any) {
        if (phase === "classify") throw Object.assign(new Error(privateBody), { code: privateBody });
        return input.segments.map((segment: any) => ({ segmentId: segment.segmentId, act: "assert", respondsToClaimId: null, rawScore: 1 }));
      } },
    };
    const generation = { async complete() {
      if (phase === "generation") throw Object.assign(new Error(privateBody), { code: "provider_http_error" });
      // Both drafts deliberately contain a private id/field; publication must use the safe guard fallback.
      return { text: "ownLedger s-ab12", model: "mock" };
    } };
    const judge = { async judge() { return { action: "accept", targetSlot: null, candidateName: null, discriminatingFeature: null, note: null }; } };
    const task = await createNamingTaskV2({ client: generation, judge, strategy: "repair-first", seed: 1552, referenceMemory: true,
      localGrounding, runDir: null, onPersist: async (record: any) => { records.push(structuredClone(record)); } } as any);
    task.message("四角い部分があります。");
    await task.whenIdle();
    const api = JSON.stringify(task.getState());
    assert.ok(!api.includes(privateBody));
    assert.doesNotMatch(api, /ownLedger|s-ab12|localGrounding|issueSummary/);
    const record = JSON.stringify(records.at(-1));
    assert.ok(!record.includes(privateBody));
    assert.doesNotMatch(record, /s-ab12/);
    assert.equal(task.getState().aiStatus, phase === "generation" ? "error" : "idle");
  }
});

test("model drift in an extractor cannot be hidden by the local pipeline's fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-grounding-model-drift-"));
  try {
    const path = join(directory, "synthetic.json");
    await writeFile(path, JSON.stringify(document()));
    const base = client();
    const mock = { async complete(messages: any[], callOptions: any) {
      const response = await base.complete(messages, callOptions);
      return { ...response, model: callOptions?.phase === "local_extraction" ? "different-model" : "mock-model" };
    } };
    const output = join(directory, "results");
    const result = await runEvaluation(options(output, path), { client: mock, expectedModel: "mock-model", randomOrder: () => false,
      createLocalGrounding: (shared) => ({ extractor: { async extract() {
        try { await shared.complete([{ role: "user", content: "匿名合成の抽出要求" }], { phase: "local_extraction" }); } catch { /* normal local fallback */ }
        return [];
      } }, classifier: { async classify() { return []; } } }),
    });
    await assertFailedPair(result, "model_changed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("local ON rejects raw private instruction, image and credential echoes before participant publication", async () => {
  for (const kind of ["prompt", "image", "credential"] as const) {
    const records: any[] = [];
    let draft = "";
    const generation = { async complete(messages: any[]) {
      if (kind === "prompt") draft = messages[0].content.split("\n")[0];
      else if (kind === "image") draft = "data:image/png;base64,c3ludGhldGljLWltYWdl";
      else draft = "Bearer synthetic-test-token-12345";
      return { text: draft, model: "mock" };
    } };
    const judge = { async judge() { return { action: "accept", targetSlot: null, candidateName: null, discriminatingFeature: null, note: null }; } };
    const task = await createNamingTaskV2({ client: generation, judge, strategy: "repair-first", seed: 1553, referenceMemory: true,
      localGrounding: local(), runDir: null, onPersist: async (record: any) => { records.push(structuredClone(record)); } } as any);
    task.message("細い形を見ています。");
    await task.whenIdle();
    assert.equal(task.getState().aiStatus, "idle");
    assert.ok(!task.getState().events.some((event: any) => event.text === draft), `${kind}: private echo must not be published`);
    assert.ok(!JSON.stringify(records.at(-1)).includes(draft), `${kind}: raw rejected draft must not enter research records`);
  }
});

test("the local publication fallback also refuses unsafe dynamic names", async () => {
  const credential = "Bearer synthetic-test-token-12345";
  const generation = { async complete() { return { text: "ownLedger s-ab12", model: "mock" }; } };
  const judge = { async judge(input: any) { return { action: "propose_name", targetSlot: Object.keys(input.ownLedger)[0],
    candidateName: credential, discriminatingFeature: null, note: null }; } };
  const task = await createNamingTaskV2({ client: generation, judge, strategy: "repair-first", seed: 1554, referenceMemory: true,
    localGrounding: local(), runDir: null } as any);
  task.message("呼び名を考えたいです。");
  await task.whenIdle();
  assert.equal(task.getState().aiStatus, "idle");
  assert.ok(!task.getState().events.some((event: any) => /Bearer|ownLedger|s-ab12/.test(event.text)), "unsafe dynamic fields must not reappear in the publication fallback");
});

const sequences = ["one", "two", "three"].map((id) => ({ sequenceId: `synthetic-${id}`,
  publicTurns: [{ turn: 1, speaker: "human", text: `合成ケース${id}の形を見ています。` }] }));

test("completed pairs are durable before the next case; a case failure is isolated and resume skips completed pairs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-grounding-resume-"));
  try {
    const path = join(directory, "synthetic.json");
    await writeFile(path, JSON.stringify(document({ sequences })));
    const output = join(directory, "results");
    const base = client(), progress: any[] = [];
    const mock = { async complete(messages: any[], callOptions: any) {
      const human = messages.filter((message) => message.role === "user" && typeof message.content === "string").at(-1)?.content;
      if (human === sequences[1].publicTurns[0].text) {
        const [run] = await readdir(output);
        const saved = await jsonLines(join(output, run), "blinded.jsonl");
        assert.deepEqual(saved.map((row) => row.caseId), ["synthetic-one"], "first case must already be saved");
        throw Object.assign(new Error("Bearer synthetic-upstream-secret"), { code: "provider_http_error" });
      }
      return base.complete(messages, callOptions);
    } };
    const dependencies = { client: mock, createLocalGrounding: local, expectedModel: "mock-model", randomOrder: () => false,
      onCaseResult: (result: any) => { progress.push(result); } };
    const run = await runEvaluation(options(output, path), dependencies);
    assert.deepEqual(progress, [{ caseId: "synthetic-one", status: "completed" },
      { caseId: "synthetic-two", status: "failed", code: "provider_http_error" }, { caseId: "synthetic-three", status: "completed" }]);
    const before = await jsonLines(run, "blinded.jsonl");
    const mappingBefore = JSON.parse(await readFile(join(run, "mapping.private.json"), "utf8")).mapping;
    assert.deepEqual(before.map((row) => row.caseId), ["synthetic-one", "synthetic-three"]);
    assert.deepEqual(await jsonLines(run, "failures.jsonl"), [{ caseId: "synthetic-two", code: "provider_http_error" }]);
    const retry = client(), resumed: any[] = [];
    assert.equal(await runEvaluation({ ...options(run, path), resume: true }, { ...dependencies, client: retry,
      randomOrder: () => true, onCaseResult: (result) => { resumed.push(result); } }), run);
    assert.deepEqual(resumed, [{ caseId: "synthetic-one", status: "skipped" }, { caseId: "synthetic-two", status: "completed" },
      { caseId: "synthetic-three", status: "skipped" }]);
    for (const call of retry.calls) {
      const humans = call.messages.filter((message: any) => message.role === "user" && typeof message.content === "string");
      assert.ok(humans.every((message: any) => message.content === sequences[1].publicTurns[0].text), "resume must call only the failed case");
    }
    const after = await jsonLines(run, "blinded.jsonl");
    assert.deepEqual(after.slice(0, 2), before);
    assert.equal(after[2].caseId, "synthetic-two");
    const mappingAfter = JSON.parse(await readFile(join(run, "mapping.private.json"), "utf8")).mapping;
    assert.deepEqual(mappingAfter.slice(0, 2), mappingBefore);
    assert.deepEqual(mappingAfter[2], { caseId: "synthetic-two", A: "new", B: "old" });
    const finished = client();
    await runEvaluation({ ...options(run, path), resume: true }, { ...dependencies, client: finished });
    assert.equal(finished.calls.length, 0, "fully completed runs must not generate again");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("--case selects one case and resume refuses changed seed, strategy, input or model before model calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-grounding-single-case-"));
  try {
    const path = join(directory, "synthetic.json");
    await writeFile(path, JSON.stringify(document({ sequences })));
    const mock = client();
    const dependencies = { client: mock, createLocalGrounding: local, expectedModel: "mock-model" };
    const run = await runEvaluation({ ...options(directory, path), caseId: "synthetic-two" }, dependencies);
    assert.deepEqual((await jsonLines(run, "blinded.jsonl")).map((row) => row.caseId), ["synthetic-two"]);
    const calls = mock.calls.length;
    await assert.rejects(runEvaluation({ ...options(directory, path), caseId: "absent" }, dependencies), /case_not_found/);
    for (const changed of [{ seed: 52 }, { strategy: "repair-first" as const }]) {
      await assert.rejects(runEvaluation({ ...options(run, path), resume: true, ...changed }, dependencies), /resume_mismatch/);
    }
    await assert.rejects(runEvaluation({ ...options(run, path), resume: true }, { ...dependencies, expectedModel: "different-model" }), /resume_mismatch/);
    await writeFile(path, JSON.stringify(document({ sequences: sequences.slice(0, 2) })));
    await assert.rejects(runEvaluation({ ...options(run, path), resume: true }, dependencies), /resume_mismatch/);
    assert.equal(mock.calls.length, calls);
    await writeFile(path, JSON.stringify(document({ sequences })));
    await runEvaluation({ ...options(run, path), resume: true, caseId: "synthetic-one" }, dependencies);
    assert.deepEqual((await jsonLines(run, "blinded.jsonl")).map((row) => row.caseId), ["synthetic-two", "synthetic-one"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("resume repairs interrupted journal/projection writes without repeating a completed pair", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-grounding-journal-"));
  try {
    const path = join(directory, "synthetic.json");
    await writeFile(path, JSON.stringify(document()));
    const dependencies = { client: client(), createLocalGrounding: local };
    const run = await runEvaluation(options(directory, path), dependencies);
    const journal = await readFile(join(run, "completed.private.jsonl"), "utf8");
    const blinded = await readFile(join(run, "blinded.jsonl"), "utf8");
    const mapping = await readFile(join(run, "mapping.private.json"), "utf8");
    await appendFile(join(run, "completed.private.jsonl"), '{"row":');
    await appendFile(join(run, "failures.jsonl"), '{"caseId":');
    await writeFile(join(run, "blinded.jsonl"), '{"partial":');
    await writeFile(join(run, "mapping.private.json"), "interrupted");
    const unused = client();
    await runEvaluation({ ...options(run, path), resume: true }, { ...dependencies, client: unused });
    assert.equal(unused.calls.length, 0);
    assert.equal(await readFile(join(run, "completed.private.jsonl"), "utf8"), journal);
    assert.equal(await readFile(join(run, "blinded.jsonl"), "utf8"), blinded);
    assert.equal(await readFile(join(run, "mapping.private.json"), "utf8"), mapping);
    assert.equal(await readFile(join(run, "failures.jsonl"), "utf8"), "");
    await appendFile(join(run, "completed.private.jsonl"), '{"invalid":"entry"}\n');
    await assert.rejects(runEvaluation({ ...options(run, path), resume: true }, { ...dependencies, client: unused }), /invalid_resume/);
    assert.equal(unused.calls.length, 0);
    await assert.rejects(stat(join(run, ".evaluation.lock")), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("resume refuses concurrent writers and artifact symlinks before making model requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-grounding-resume-boundary-"));
  try {
    const path = join(directory, "synthetic.json");
    await writeFile(path, JSON.stringify(document()));
    const run = await runEvaluation(options(directory, path), { client: client(), createLocalGrounding: local });
    const unused = client();
    const resume = { ...options(run, path), resume: true };
    await writeFile(join(run, ".evaluation.lock"), "evaluation_in_progress\n");
    await assert.rejects(runEvaluation(resume, { client: unused, createLocalGrounding: local }), /evaluation_busy/);
    assert.equal(await readFile(join(run, ".evaluation.lock"), "utf8"), "evaluation_in_progress\n");
    await rm(join(run, ".evaluation.lock"));
    await rm(join(run, "blinded.jsonl"));
    await symlink(join(repository, "package.json"), join(run, "blinded.jsonl"));
    await assert.rejects(runEvaluation(resume, { client: unused, createLocalGrounding: local }), /repository_output_forbidden/);
    assert.equal(unused.calls.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("model drift invalidates only its own case, and unsafe resumed responses are never projected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-grounding-resume-privacy-"));
  try {
    const path = join(directory, "synthetic.json");
    await writeFile(path, JSON.stringify(document({ sequences: sequences.slice(0, 2) })));
    const base = client();
    const mock = { async complete(messages: any[], callOptions: any) {
      const response = await base.complete(messages, callOptions);
      return { ...response, model: callOptions?.phase === "local_extraction" && messages[0].content === sequences[0].publicTurns[0].text ? "different-model" : "mock-model" };
    } };
    const run = await runEvaluation(options(directory, path), { client: mock, expectedModel: "mock-model", randomOrder: () => false,
      createLocalGrounding: (shared) => ({ extractor: { async extract(input) {
        await shared.complete([{ role: "user", content: input.publicTurns.at(-1)!.text }], { phase: "local_extraction" });
        return [];
      } }, classifier: { async classify() { return []; } } }),
    });
    assert.deepEqual((await jsonLines(run, "blinded.jsonl")).map((row) => row.caseId), ["synthetic-two"]);
    assert.deepEqual(await jsonLines(run, "failures.jsonl"), [{ caseId: "synthetic-one", code: "model_changed" }]);
    const original = await readFile(join(run, "blinded.jsonl"), "utf8");
    const entries = await jsonLines(run, "completed.private.jsonl");
    entries[0].row.responses.A = "Bearer synthetic-private-token";
    await writeFile(join(run, "completed.private.jsonl"), JSON.stringify(entries[0]) + "\n");
    const unused = client();
    await assert.rejects(runEvaluation({ ...options(run, path), resume: true }, { client: unused, createLocalGrounding: local, expectedModel: "mock-model" }), /privacy_rejected/);
    assert.equal(unused.calls.length, 0);
    assert.equal(await readFile(join(run, "blinded.jsonl"), "utf8"), original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
