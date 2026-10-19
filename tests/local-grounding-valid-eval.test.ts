// Only deterministic clients/judges/classifiers. Importing the CLI calls no API.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateValidityGate, auditLocalTurn } from "../dialogue-model/runtime/diagnostics/local-grounding-eval/gate.ts";
import type { AuditReceipt } from "../dialogue-model/runtime/diagnostics/local-grounding-eval/gate.ts";
import { runLiveEvaluation, parseLiveArguments } from "../dialogue-model/runtime/diagnostics/local-grounding-eval/live.ts";
import type { LiveDependencies } from "../dialogue-model/runtime/diagnostics/local-grounding-eval/live.ts";
import type { LiveCase } from "../dialogue-model/runtime/diagnostics/local-grounding-eval/live-cases.ts";
import { LocalExtractionError } from "../dialogue-model/runtime/local-grounding/extract.ts";
import { LocalClassificationError } from "../dialogue-model/runtime/local-grounding/classify.ts";
import { createMockLocalExtractor, createMockLocalClassifier } from "../dialogue-model/runtime/local-grounding/mocks.ts";
import { recordAiClaims } from "../dialogue-model/runtime/local-grounding/verify.ts";
import { createReferenceGraph, applyReferenceUpdate } from "../dialogue-model/runtime/memory/reference-graph.mjs";

const script: LiveCase = { id: "synthetic-cycle", steps: [
  { text: "四角のある図形を一つ説明して。" },
  { text: "その図形の四角という説明は合っている。", expect: "agree" },
  { text: "その図形の四角という説明には反対。呼び名を「帆」と提案して。", expect: "deny" },
  { text: "提案してくれた、その図形の名前「帆」でいい。", expect: "name_accept" },
  { text: "次の手がかりは何にしよう？" },
] };
const config = { seed: 1701, strategy: "bypass-enabled" as const, mode: "both" as const };
function dependencies(extra: Partial<LiveDependencies> = {}): LiveDependencies & { calls: any[]; judgments: any[] } {
  const calls: any[] = [], judgments: any[] = [];
  const client = { async complete(messages: any[], options: any) {
    calls.push({ messages, options });
    // The mock generation deliberately follows the same valid committed act.
    const name = messages.some(m => typeof m.content === "string" && m.content.includes('"candidateName":"帆"'));
    return { text: name ? "この図形は「帆」と呼びませんか？" : "四角がある図形ですね。", model: "worker-fixed" };
  } };
  return { calls, judgments, client, expectedModel: "worker-fixed", cases: [script], randomOrder: () => false,
    judge: { async judge(input: any) {
      judgments.push(structuredClone(input));
      const humanCount = input.publicHistory.filter((m: any) => m.role === "user").length;
      const targetSlot = Object.keys(input.ownLedger)[0];
      return { action: humanCount === 3 ? "propose_name" : "accept", targetSlot,
        candidateName: humanCount === 3 ? "帆" : null, discriminatingFeature: humanCount < 3 ? "四角" : null, note: null, reference: null };
    } },
    createLocalGrounding: () => {
      let evidence: any = null, callIndex = 0;
      const extractor = createMockLocalExtractor(input => {
        assert.ok(input.ownImage.base64.length > 0);
        assert.equal(input.ownImage.mimeType, "image/png");
        assert.deepEqual(input.ownAnchors.map(a => a.id).sort(), [...input.ownSlots].sort());
        assert.ok(!Object.keys(input).some(k => /partner|gold|answer/i.test(k)));
        const quote = input.publicTurns.at(-1)!.text;
        const naming = quote.includes("名前");
        return [{ segmentId: "s1", quote, targets: [input.ownSlots[0]], aspect: naming ? "name" : "part",
          proposition: naming ? "帆という名前でいい" : "四角のある図形", name: naming ? "帆" : null,
          linkedIssueId: null, respondsToTurn: null }];
      });
      const mock = createMockLocalClassifier(input => {
        const text = input.publicTurns.at(-1)!.text;
        const act = text.includes("合って") ? "agree" : text.includes("反対") ? "deny" : text.includes("名前") ? "name_accept" : "assert";
        const prior = [...input.priorClaims].reverse().find(c => c.speaker === "ai" && c.aspect === (act === "name_accept" ? "name" : "part"));
        evidence = { callIndex: ++callIndex, classifierKind: "jev_local_test", status: "ok", model: "typesafe/jev-1.14-20261014" };
        return [{ segmentId: "s1", act, respondsToClaimId: ["agree", "deny", "name_accept"].includes(act) ? prior?.id ?? null : null, rawScore: null }];
      });
      return { extractor, classifier: { metadata: { classifierKind: "jev_local_test", calibrated: false, model: "typesafe/jev-1.14" },
        get lastEvidence() { return evidence; }, classify: mock.classify } as any };
    }, ...extra };
}
async function temporary(fn: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "valid-local-"));
  try { await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
function receipt(act: "agree" | "deny" | "name_accept"): AuditReceipt {
  const c: any = { kind: "claim", id: "3:local1", speaker: "human", act, targets: ["s-0001"], respondsTo: "3:ai1" };
  return { turn: 3, verified: [c, { ...c, id: "3:ai1", speaker: "ai", act: "assert", respondsTo: null }], unverified: 0,
    classifierOk: true, pipelineOk: true, model: "typesafe/jev-1.14-20261014", expected: act };
}

test("validity gate demands every category, target, verified update, classifier and matching script step", () => {
  const receipts = [receipt("agree"), receipt("deny"), receipt("name_accept")];
  assert.equal(evaluateValidityGate(receipts).passed, true);
  const changed = structuredClone(receipts); changed[1].verified = [];
  assert.ok(evaluateValidityGate(changed).unmet.includes("deny_missing"));
  assert.ok(evaluateValidityGate(changed).unmet.includes("script_mismatch"));
  for (const field of ["classifierOk", "pipelineOk"] as const) {
    const modified = structuredClone(receipts); modified[0][field] = false;
    assert.equal(evaluateValidityGate(modified).passed, false);
  }
  const injected = structuredClone(receipts); injected[0].unverified = 1;
  assert.ok(evaluateValidityGate(injected).unmet.includes("unverified_updates"));
  assert.ok(evaluateValidityGate([]).unmet.includes("ai_claims_missing"));
});

test("audit refuses a graph claim without independently reproduced verifier provenance", () => {
  const graph = createReferenceGraph({ slots: Array.from({ length: 6 }, (_, i) => `s-000${i + 1}`) });
  const publicTurns = [{ turn: 1, speaker: "human" as const, text: "四角がある。" }];
  const after = applyReferenceUpdate(graph, { expectedRevision: 0, turn: 1, operations: [{ kind: "claim", id: "1:local1",
    issueId: "1:local1", targets: ["s-0001"], aspect: "part", act: "assert", proposition: "四角がある", name: null,
    speaker: "human", sourceTurn: 1, quote: "四角がある。", respondsTo: null, source: "partner_statement" }] },
    { publicTurns, generationSucceeded: true });
  const result = auditLocalTurn({ before: { graph, judgments: [] }, after: { graph: after, judgments: [] },
    publicTurns, segments: [], verdicts: [] });
  assert.equal(result.unverified, 1); assert.equal(result.verified.length, 0);
  assert.equal(result.pipelineOk, false); assert.equal(result.classifierOk, false);
});

test("live CLI accepts only human-script modes and requires an external output path", async () => {
  assert.throws(() => parseLiveArguments([]), /output_directory_required/);
  for (const args of [["--out", "x", "--mode", "fixed"], ["--out", "x", "--cases", "legacy.json"], ["--out", "x", "--resume"]]) {
    assert.throws(() => parseLiveArguments(args), /invalid_arguments/);
  }
  assert.equal(parseLiveArguments(["--out", "/tmp/evaluation", "--mode", "branch", "--case", "synthetic-cycle"]).mode, "branch");
  const deps = dependencies();
  await assert.rejects(runLiveEvaluation({ ...config, outputDir: process.cwd() }, deps), /repository_output_forbidden/);
  assert.equal(deps.calls.length, 0);
});

test("real dialogue runtime generates/publishes prefixes, branches identical state and runs independent E2E arms", async () => temporary(async outputDir => {
  const deps = dependencies();
  const result = await runLiveEvaluation({ ...config, outputDir }, deps);
  assert.equal(result.status, "completed", JSON.stringify(result));
  const rows = (await readFile(join(result.directory, "blinded.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(rows.map(r => r.mode), ["branch", "multiturn"]);
  assert.deepEqual(rows[1].dialogues.A.filter((t: any) => t.speaker === "human").map((t: any) => t.text), script.steps.map(s => s.text));
  const branch = deps.judgments.filter(i => i.publicHistory.filter((m: any) => m.role === "user").length === 5).slice(0, 2);
  assert.deepEqual(branch[0], branch[1]);
  const prefix = JSON.parse(await readFile(join(result.directory, script.id + ".prefix.private.json"), "utf8"));
  assert.equal(prefix.provenance.length, 4);
  assert.ok(prefix.gate.passed);
  assert.ok(prefix.records.every((r: any) => !Object.hasOwn(r.extractor, "errorCode") && !Object.hasOwn(r.classifier, "errorCode")));
  assert.deepEqual(prefix.gate.returnedModels, ["typesafe/jev-1.14-20261014"]);
  for (const provenance of prefix.provenance) {
    assert.equal(prefix.publicTurns.find((t: any) => t.turn === provenance.aiTurn).text, provenance.text);
  }
  assert.equal((await stat(join(result.directory, "blinded.jsonl"))).mode & 0o777, 0o600);
  assert.equal((await stat(result.directory)).mode & 0o777, 0o700);
  const blind = JSON.stringify(rows);
  assert.ok(!blind.includes("classifierKind") && !blind.includes("targetSlot") && !blind.includes("expected"));
  // Actual generation goes through the supplied client, with own image only.
  assert.ok(deps.calls.every(c => ["generation", "regeneration", "guard_rewrite"].includes(c.options.phase)));
  const firstMessages = JSON.stringify(deps.calls[0].messages);
  for (const step of script.steps.slice(1)) assert.ok(!firstMessages.includes(step.text), "future human speech stays outside inputs");
  assert.ok(!firstMessages.includes('"expect"'));
}));

test("empty extraction or mismatched live prefix blocks comparisons and every blind artifact", async () => temporary(async outputDir => {
  const deps = dependencies({ createLocalGrounding: () => ({ extractor: createMockLocalExtractor(() => []), classifier: createMockLocalClassifier(() => []) }) });
  const result = await runLiveEvaluation({ ...config, outputDir }, deps);
  assert.equal(result.status, "gate_failed");
  assert.ok(result.unmet?.includes("agree_missing"));
  assert.ok(result.unmet?.includes("classifier_evidence_invalid"));
  assert.ok(!(await readdir(result.directory)).some(p => p === "blinded.jsonl" || p === "mapping.private.json"));
  assert.equal(deps.judgments.length, script.steps.length - 1, "no comparison generation before gate");
}));

test("one invalid script among valid cases prevents all comparisons", async () => temporary(async outputDir => {
  const altered = structuredClone(script); altered.id = "mismatched"; altered.steps[1].text = "よく分からないから説明を続けて。";
  const deps = dependencies({ cases: [script, altered] });
  const result = await runLiveEvaluation({ ...config, outputDir }, deps);
  assert.equal(result.status, "gate_failed");
  assert.ok(result.unmet?.includes("script_mismatch"));
  assert.equal(deps.judgments.length, 8);
  assert.ok(!(await readdir(result.directory)).includes("blinded.jsonl"));
}));

test("public and private outputs refuse prompt/image/credential echoes and model drift with fixed diagnostics", async () => {
  for (const text of ["data:image/png;base64,QUJD", "Bearer synthetic_token_1234", "sk-or-SYNTHETICSECRET0123"]) await temporary(async outputDir => {
    const deps = dependencies({ client: { async complete() { return { text, model: "worker-fixed" }; } } });
    const result = await runLiveEvaluation({ ...config, outputDir }, deps);
    assert.equal(result.status, "gate_failed");
    const artifacts = await readdir(result.directory);
    const prefix = JSON.parse(await readFile(join(result.directory, script.id + ".prefix.private.json"), "utf8"));
    assert.ok(prefix.snapshot.judgments.some((j: any) => j.generationGuard.fallback === true));
    assert.ok(!artifacts.includes("blinded.jsonl"));
    for (const f of artifacts) assert.ok(!(await readFile(join(result.directory, f), "utf8")).includes(text));
  });
  await temporary(async outputDir => {
    const result = await runLiveEvaluation({ ...config, outputDir }, dependencies({ client: { async complete() { throw new Error("Bearer PRIVATE_ERROR_TOKEN"); } } }));
    const failures = await readFile(join(result.directory, "failures.private.json"), "utf8");
    assert.ok(failures.includes("evaluation_unavailable")); assert.ok(!failures.includes("PRIVATE_ERROR_TOKEN"));
  });
  await temporary(async outputDir => {
    const result = await runLiveEvaluation({ ...config, outputDir }, dependencies({ client: { async complete() { return { text: "四角ですね。", model: "changed" }; } } }));
    assert.equal(result.status, "gate_failed");
    assert.ok((await readFile(join(result.directory, "failures.private.json"), "utf8")).includes("model_changed"));
  });
});


test("actual Jev adapter with mock HTTP supplies model-checked evidence to the live gate", async () => {
  const { createJevLocalTestClassifier } = await import("../dialogue-model/runtime/local-grounding/jev-local-test.ts");
  for (const returnedModel of ["typesafe/jev-1.14", "typesafe/jev-1.14-20261014", "typesafe/jev-1.14-unapproved", "cost_cap"]) await temporary(async outputDir => {
    const deps = dependencies(), original = deps.createLocalGrounding;
    let httpCalls = 0;
    deps.createLocalGrounding = client => ({ extractor: original(client).extractor,
      classifier: createJevLocalTestClassifier({ enabled: true, readKey: async () => "sk-or-SYNTHETIC-MOCK-ONLY-1234567890",
        fetchImpl: async (_url, request) => {
          httpCalls++;
          const payload = JSON.parse(request.body as string), state = JSON.parse(payload.state);
          const text = state.publicTurns.at(-1).text;
          const act = text.includes("合って") ? "agree" : text.includes("反対") ? "deny" : text.includes("名前") ? "name_accept" : "assert";
          const prior = state.priorClaims.findLastIndex((c: any) => c.speaker === "ai" && c.aspect === (act === "name_accept" ? "name" : "part"));
          const answers = Object.fromEntries(Object.entries(payload.questions).map(([key, value]: [string, any]) => {
            const choice = key.endsWith("_act") ? act : ["agree", "deny", "name_accept"].includes(act) && prior >= 0 ? "claim_" + prior : "none";
            return [key, { type: "choice", choice, confidence: 1,
              probabilities: Object.fromEntries(Object.keys(value.criteria).map(label => [label, label === choice ? 1 : 0])) }];
          }));
          return Response.json({ model: returnedModel === "cost_cap" ? "typesafe/jev-1.14" : returnedModel, id: "synthetic-response-" + httpCalls, answers,
            usage: { input_tokens: 10, output_tokens: 0, cost: returnedModel === "cost_cap" ? 1 : 0.00001 } });
        } })! });
    const result = await runLiveEvaluation({ ...config, mode: "branch", outputDir }, deps);
    assert.ok(httpCalls > 0);
    assert.equal(result.status, (returnedModel.endsWith("unapproved") || returnedModel === "cost_cap") ? "gate_failed" : "completed");
    if (result.status === "completed") {
      const gate = JSON.parse(await readFile(join(result.directory, "gate.private.json"), "utf8"));
      assert.deepEqual(gate.returnedModels, [returnedModel]);
    } else assert.ok(!(await readdir(result.directory)).includes("blinded.jsonl"));
    if (returnedModel === "cost_cap") {
      const prefix = JSON.parse(await readFile(join(result.directory, script.id + ".prefix.private.json"), "utf8"));
      assert.ok(prefix.classifierEvidence.some((e: any) => e.reason === "cost_cap"));
    }
    for (const file of await readdir(result.directory)) assert.ok(!(await readFile(join(result.directory, file), "utf8")).includes("sk-or-"));
  });
});

test("new E2E arm is gated again after a valid prefix and keeps blind files absent on later classifier failure", async () => temporary(async outputDir => {
  const deps = dependencies(), original = deps.createLocalGrounding;
  let factories = 0, classifications = 0;
  deps.createLocalGrounding = client => {
    factories++;
    const local = original(client), base = local.classifier as any;
    return { extractor: local.extractor, classifier: {
      get metadata() { return base.metadata; },
      get lastEvidence() { const e = base.lastEvidence; return e && { ...e, status: classifications > 4 ? "error" : e.status }; },
      async classify(input: any, options: any) { classifications++; return base.classify(input, options); },
    } as any };
  };
  const result = await runLiveEvaluation({ ...config, mode: "multiturn", outputDir }, deps);
  assert.equal(factories, 1, "one case shares the same cost-capped classifier across stages");
  assert.equal(result.status, "gate_failed");
  assert.ok(result.unmet?.includes("classifier_evidence_invalid"));
  const preflight = JSON.parse(await readFile(join(result.directory, "gate.private.json"), "utf8"));
  assert.ok(preflight.passed);
  assert.ok(!(await readdir(result.directory)).includes("blinded.jsonl"));
  assert.ok(!(await readdir(result.directory)).includes("mapping.private.json"));
}));


test("generation failure leaves staged claims uncommitted and preserves completed prefix diagnostics", async () => {
  for (const failureAt of [2, 5]) await temporary(async outputDir => {
    const deps = dependencies(), original = deps.client;
    let generations = 0;
    deps.client = { async complete(messages, options) {
      if (++generations === failureAt) throw new Error("RAW_PRIVATE_PROVIDER_FAILURE");
      return original.complete(messages, options);
    } };
    const result = await runLiveEvaluation({ ...config, mode: "branch", outputDir }, deps);
    assert.equal(result.status, failureAt === 2 ? "gate_failed" : "failed");
    if (failureAt === 5) assert.equal(result.code, "evaluation_unavailable");
    const prefixPath = join(result.directory, script.id + (failureAt === 2 ? ".prefix-failed.private.json" : ".prefix.private.json"));
    const prefix = JSON.parse(await readFile(prefixPath, "utf8"));
    if (failureAt === 2) {
      assert.equal(prefix.snapshot.judgments.length, 1);
      assert.ok(prefix.records.some((r: any) => r.turnIndex === 3 && r.status !== "committed"));
      assert.ok(prefix.snapshot.graph.records.every((r: any) => r.turn === 1));
    } else assert.ok(prefix.gate.passed);
    for (const file of await readdir(result.directory)) assert.ok(!(await readFile(join(result.directory, file), "utf8")).includes("RAW_PRIVATE_PROVIDER_FAILURE"));
    assert.ok(!(await readdir(result.directory)).includes("blinded.jsonl"));
  });
});

test("local timeout CLI validates the extractor's millisecond bounds without changing the omitted default", async () => {
  const defaults = parseLiveArguments(["--out", "/tmp/synthetic-evaluation"]);
  assert.ok(!Object.hasOwn(defaults, "localTimeoutMs"));
  for (const milliseconds of [1, 45000, 60000]) {
    assert.equal(parseLiveArguments(["--out", "/tmp/synthetic-evaluation", "--local-timeout-ms", String(milliseconds)]).localTimeoutMs, milliseconds);
  }
  for (const value of ["0", "-1", "1.5", "60001", "NaN", "Infinity", "invalid", " "]) {
    assert.throws(() => parseLiveArguments(["--out", "/tmp/synthetic-evaluation", "--local-timeout-ms", value]), /invalid_arguments/);
  }
  for (const args of [["--out", "x", "--local-timeout-ms"], ["--out", "x", "--local-timeout-ms", "20000", "--local-timeout-ms", "60000"]]) {
    assert.throws(() => parseLiveArguments(args), /invalid_arguments/);
  }
  await temporary(async outputDir => {
    const deps = dependencies();
    for (const localTimeoutMs of [0, -1, 0.5, 60001, NaN, Infinity, "60000", null]) {
      await assert.rejects(runLiveEvaluation({ ...config, outputDir, localTimeoutMs } as any, deps), /invalid_arguments/);
    }
    assert.equal(deps.calls.length, 0);
    assert.deepEqual(await readdir(outputDir), []);
  });
});

test("local timeout reaches extraction and the remaining classification budget in every live stage", async () => temporary(async outputDir => {
  for (const scenario of [
    { localTimeoutMs: undefined, factoryTimeoutMs: undefined, expected: 20000 },
    { localTimeoutMs: undefined, factoryTimeoutMs: 12000, expected: 12000 },
    { localTimeoutMs: 45000, factoryTimeoutMs: 12000, expected: 45000 },
  ]) {
    const deps = dependencies(), original = deps.createLocalGrounding;
    const extraction: number[] = [], classification: number[] = [];
    deps.createLocalGrounding = client => {
      const local = original(client), extract = local.extractor.extract, classify = local.classifier.classify;
      local.timeoutMs = scenario.factoryTimeoutMs;
      local.extractor.extract = async (input, options) => { extraction.push(options!.timeoutMs!); return extract(input, options); };
      local.classifier.classify = async (input, options) => { classification.push(options!.timeoutMs!); return classify(input, options); };
      return local;
    };
    const result = await runLiveEvaluation({ ...config, outputDir, ...(scenario.localTimeoutMs === undefined ? {} : { localTimeoutMs: scenario.localTimeoutMs }) }, deps);
    assert.equal(result.status, "completed");
    assert.equal(extraction.length, script.steps.length * 2, "ON prefix, ON branch and ON E2E all use the configured budget");
    assert.ok(extraction.every(value => value === scenario.expected));
    assert.equal(classification.length, extraction.length);
    assert.ok(classification.every(value => value > 0 && value <= scenario.expected));
    const manifest = JSON.parse(await readFile(join(result.directory, "run.private.json"), "utf8"));
    assert.equal(manifest.localTimeoutMs, scenario.localTimeoutMs);
  }
}));


test("prefix preserves fixed per-stage error codes while provider errors and modified codes stay private", async () => {
  for (const stage of ["extractor", "classifier"] as const) {
    for (const kind of ["typed", "unknown", "modified"] as const) await temporary(async outputDir => {
      const deps = dependencies(), original = deps.createLocalGrounding;
      deps.createLocalGrounding = client => {
        const local = original(client);
        const error = kind === "unknown" ? new Error("PRIVATE_PROVIDER_MESSAGE") :
          stage === "extractor" ? new LocalExtractionError("invalid_json") : new LocalClassificationError("invalid_json");
        Object.assign(error, { message: "PRIVATE_PROVIDER_MESSAGE", response: "data:image/png;base64,PRIVATE_IMAGE" });
        if (kind !== "typed") Object.assign(error, { code: kind === "modified" ? "PRIVATE_MODIFIED_CODE" : "invalid_json" });
        if (stage === "extractor") local.extractor.extract = async () => { throw error; };
        else local.classifier.classify = async () => { throw error; };
        return local;
      };
      const result = await runLiveEvaluation({ ...config, outputDir, localTimeoutMs: 45000 }, deps);
      assert.equal(result.status, "gate_failed");
      const text = await readFile(join(result.directory, script.id + ".prefix.private.json"), "utf8");
      const prefix = JSON.parse(text);
      assert.equal(prefix.records.length, script.steps.length - 1);
      assert.ok(prefix.records.every((r: any) => r[stage].errorCode === (kind === "typed" ? "invalid_json" : "unavailable")));
      const other = stage === "extractor" ? "classifier" : "extractor";
      assert.ok(prefix.records.every((r: any) => !Object.hasOwn(r[other], "errorCode")));
      assert.ok(!(await readdir(result.directory)).includes("blinded.jsonl"));
      for (const file of await readdir(result.directory)) {
        const artifact = await readFile(join(result.directory, file), "utf8");
        for (const canary of ["PRIVATE_PROVIDER_MESSAGE", "PRIVATE_MODIFIED_CODE", "PRIVATE_IMAGE", "data:image/"]) assert.ok(!artifact.includes(canary));
      }
    });
  }
});


test("independent audit refuses even a literal AI feature claim from a published fallback turn", () => {
  const publicTurns = [{ turn: 1, speaker: "human" as const, text: "図形を説明して。" },
    { turn: 2, speaker: "ai" as const, text: "四角がある図形ですね。" }, { turn: 3, speaker: "human" as const, text: "続けて。" }];
  const initial = createReferenceGraph({ slots: Array.from({ length: 6 }, (_, i) => `s-000${i + 1}`) });
  const graph = applyReferenceUpdate(initial, { expectedRevision: 0, turn: 1, operations: [] },
    { publicTurns: publicTurns.slice(0, 1), generationSucceeded: true });
  const judgment = { action: "accept", targetSlot: "s-0001", candidateName: null, discriminatingFeature: "四角", note: null };
  // A plausible, graph-valid claim with literal public provenance still cannot
  // stand in for a program-owned fallback that did not publish the chosen act.
  const operation = recordAiClaims({ graph, turn: 3, publicTurns, priorAct: { ...judgment, turn: 2 } }).operations[0];
  assert.ok(operation);
  const after = applyReferenceUpdate(graph, { expectedRevision: graph.revision, turn: 3, operations: [operation] },
    { publicTurns, generationSucceeded: true });
  const previous = { turnIndex: 1, judgment, generationGuard: { fallback: true } };
  const input = { before: { graph, judgments: [previous] }, after: { graph: after, judgments: [previous] }, publicTurns, segments: [], verdicts: [] };
  const fallback = auditLocalTurn(input);
  assert.equal(fallback.verified.filter(c => c.speaker === "ai").length, 0);
  assert.equal(fallback.unverified, 1);
  // The same published text and judgment remain valid after a normal generation.
  const ordinary = auditLocalTurn({ ...input, before: { graph, judgments: [{ ...previous, generationGuard: { fallback: false } }] } });
  assert.equal(ordinary.verified.filter(c => c.speaker === "ai").length, 1);
  assert.equal(ordinary.unverified, 0);
});
