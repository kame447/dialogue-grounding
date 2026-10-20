// Only deterministic clients/judges/classifiers. Importing the CLI calls no API.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateValidityGate, evaluateRunGate, auditLocalTurn } from "../dialogue-model/runtime/diagnostics/local-grounding-eval/gate.ts";
import type { AuditReceipt } from "../dialogue-model/runtime/diagnostics/local-grounding-eval/gate.ts";
import { runLiveEvaluation, parseLiveArguments } from "../dialogue-model/runtime/diagnostics/local-grounding-eval/live.ts";
import type { LiveDependencies } from "../dialogue-model/runtime/diagnostics/local-grounding-eval/live.ts";
import { LIVE_CASES } from "../dialogue-model/runtime/diagnostics/local-grounding-eval/live-cases.ts";
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

function distributedCases() {
  const acts = ["agree", "deny", "name_accept"] as const;
  const cases = acts.map(act => ({ id: act, steps: script.steps.map((s, i) => ({ text: s.text + (i === 0 ? "（" + act + "）" : ""),
    ...(s.expect === act ? { expect: act } : {}) })) }));
  const deps = dependencies({ cases }), original = deps.createLocalGrounding;
  deps.createLocalGrounding = client => {
    const local = original(client), classify = local.classifier.classify;
    local.classifier.classify = async (input, options) => {
      const chosen = cases.find(c => c.steps[0].text === input.publicTurns[0].text)!.id;
      const verdicts = await classify(input, options);
      return verdicts.map(v => acts.includes(v.act as any) && v.act !== chosen ? { ...v, act: "unknown", respondsToClaimId: null } : v);
    };
    return local;
  };
  return { acts, cases, deps };
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



test("empty extraction or mismatched live prefix blocks comparisons and every blind artifact", async () => temporary(async outputDir => {
  const deps = dependencies({ createLocalGrounding: () => ({ extractor: createMockLocalExtractor(() => []), classifier: createMockLocalClassifier(() => []) }) });
  const result = await runLiveEvaluation({ ...config, outputDir }, deps);
  assert.equal(result.status, "gate_failed");
  assert.ok(result.unmet?.includes("agree_missing"));
  assert.ok(result.unmet?.includes("classifier_evidence_invalid"));
  assert.ok(!(await readdir(result.directory)).some(p => p === "blinded.jsonl" || p === "mapping.private.json"));
  assert.equal(deps.judgments.length, script.steps.length - 1, "no comparison generation before gate");
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
  // Historical forged-feature fixture for the frozen fallback audit only.
  const operation = recordAiClaims({ graph, turn: 3, publicTurns, featureSource: "legacy_private_plan", priorAct: { ...judgment, turn: 2 } }).operations[0];
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


test("six new human-only scripts avoid elicitation commands and represent different local issues", () => {
  assert.equal(LIVE_CASES.length, 6);
  assert.equal(new Set(LIVE_CASES.map(c => c.id)).size, 6);
  const expected = new Set<string>();
  for (const c of LIVE_CASES) {
    assert.ok(c.steps.length >= 4);
    for (const step of c.steps) {
      assert.deepEqual(Object.keys(step).filter(k => !["text", "expect"].includes(k)), []);
      assert.doesNotMatch(step.text, /説明して|提案して|選んで|取り消して|撤回/);
      for (const act of typeof step.expect === "string" ? [step.expect] : step.expect ?? []) expected.add(act);
    }
  }
  for (const act of ["agree", "deny", "name_accept", "name_propose", "name_reject", "defer", "revisit"]) assert.ok(expected.has(act));
  const backchannel = LIVE_CASES.find(c => c.id === "ambiguous-backchannel")!;
  assert.ok(backchannel.steps.some(s => s.text === "うん。" && s.expect === undefined));
});

test("case gates enforce structure independently while required functions are covered across eligible scripts", () => {
  const inputs = ["agree", "deny", "name_accept"].map(act => ({ caseId: act, receipts: [receipt(act as "agree" | "deny" | "name_accept")] }));
  for (const c of inputs) {
    const result = evaluateValidityGate(c.receipts, { scope: "case" });
    assert.ok(result.passed); assert.equal(result.scope, "case");
  }
  const run = evaluateRunGate(inputs);
  assert.ok(run.passed); assert.equal(run.scope, "run");
  assert.deepEqual(run.includedCaseIds, ["agree", "deny", "name_accept"]);
  const missing = evaluateRunGate(inputs.slice(0, 2));
  assert.deepEqual(missing.unmet, ["name_accept_missing"]);
  assert.ok(missing.cases.every(c => c.passed), "no script is required to supply every function");
  const unverified = structuredClone(inputs); unverified[2].receipts[0].unverified = 1;
  const blocked = evaluateRunGate(unverified);
  assert.deepEqual(blocked.excludedCaseIds, ["name_accept"]);
  assert.ok(blocked.unmet.includes("name_accept_missing"), "excluded scripts cannot supply function coverage");
  assert.ok(blocked.cases[2].unmet.includes("unverified_updates"));
  for (const flaw of ["ai", "target", "classifier", "pipeline"] as const) {
    const bad = structuredClone(inputs);
    const r = bad[0].receipts[0];
    if (flaw === "ai") r.verified = r.verified.filter(c => c.speaker !== "ai");
    if (flaw === "target") r.verified.forEach(c => { c.targets = []; });
    if (flaw === "classifier") r.classifierOk = false;
    if (flaw === "pipeline") r.pipelineOk = false;
    const result = evaluateRunGate(bad);
    assert.ok(result.excludedCaseIds.includes("agree"));
    assert.ok(!result.passed, "another case's structural evidence cannot rescue this one");
  }
});

test("compound expectations require every function in that same human turn", () => {
  const compound = receipt("agree"); compound.expected = ["agree", "deny"];
  assert.ok(evaluateValidityGate([compound], { scope: "case" }).unmet.includes("script_mismatch"));
  compound.verified.push({ ...receipt("deny").verified[0], id: "3:local2" });
  assert.ok(evaluateValidityGate([compound], { scope: "case" }).passed);
  assert.equal(evaluateRunGate([{ caseId: "compound", receipts: [compound] }]).passed, false, "name acceptance remains mandatory globally");
});








test("expect arrays reject empty, duplicate or non-function labels before any model call", async () => temporary(async outputDir => {
  for (const expect of [[], ["agree", "agree"], ["ER1"], ["agree", "invalid"], null, { act: "agree" }]) {
    const c = structuredClone(script); (c.steps[1] as any).expect = expect;
    const deps = dependencies({ cases: [c] });
    await assert.rejects(runLiveEvaluation({ ...config, outputDir }, deps), /invalid_cases/);
    assert.equal(deps.calls.length, 0);
  }
  assert.deepEqual(await readdir(outputDir), []);
}));

test("R5-c: the fixed synthetic-cycle prefix is ineligible and starts no comparison", async () => temporary(async outputDir => {
  // This fixed mock fixture checks a completed prefix boundary; it neither
  // certifies downstream comparison nor replaces the 11 retired tests.
  const progress: Array<{ caseId: string; stage: string; turn?: number }> = [];
  const extractionTurns: number[] = [], classificationTurns: number[] = [];
  const deps = dependencies({ onProgress: value => progress.push(structuredClone(value)) });
  const factory = deps.createLocalGrounding;
  let factories = 0;
  deps.createLocalGrounding = client => {
    factories++;
    const local = factory(client), extract = local.extractor.extract, classify = local.classifier.classify;
    // Observe calls without altering the existing mock's responses or errors.
    local.extractor.extract = async (input, options) => { extractionTurns.push(input.turn); return extract(input, options); };
    local.classifier.classify = async (input, options) => { classificationTurns.push(input.turn); return classify(input, options); };
    return local;
  };
  assert.deepEqual(deps.cases!.map(c => c.id), ["synthetic-cycle"]);
  const result = await runLiveEvaluation({ outputDir, seed: 1701, strategy: "bypass-enabled", mode: "both" }, deps);
  assert.equal(result.status, "gate_failed"); assert.equal(result.excludedCases, 1);
  const load = async (file: string) => JSON.parse(await readFile(join(result.directory, file), "utf8"));
  const [savedResult, gate, exclusions, failures, prefix] = await Promise.all([
    load("result.private.json"), load("gate.private.json"), load("exclusions.private.json"), load("failures.private.json"),
    load("synthetic-cycle.prefix.private.json"),
  ]);
  const runUnmet = ["ai_claims_missing", "targeted_claims_missing", "agree_missing", "deny_missing", "name_accept_missing",
    "classifier_evidence_invalid", "local_pipeline_incomplete", "no_eligible_cases"];
  assert.deepEqual([...result.unmet!].sort(), [...runUnmet].sort());
  assert.deepEqual({ ...savedResult, unmet: [...savedResult.unmet].sort() },
    { status: "gate_failed", stage: "prefix", unmet: [...runUnmet].sort() });
  assert.equal(gate.scope, "run"); assert.equal(gate.passed, false);
  assert.deepEqual([...gate.unmet].sort(), [...runUnmet].sort());
  assert.deepEqual(gate.includedCaseIds, []); assert.deepEqual(gate.excludedCaseIds, ["synthetic-cycle"]);
  assert.deepEqual(gate.counts, { aiClaims: 0, targetedClaims: 0, agree: 0, deny: 0, name_accept: 0, unverified: 0 });
  assert.deepEqual(gate.returnedModels, []);
  const caseGate = { scope: "case", passed: false, unmet: ["script_mismatch"],
    counts: { aiClaims: 1, targetedClaims: 3, agree: 0, deny: 0, name_accept: 1, unverified: 0 },
    returnedModels: ["typesafe/jev-1.14-20261014"] };
  assert.deepEqual(gate.cases, [{ caseId: "synthetic-cycle", ...caseGate }]);
  assert.deepEqual(prefix.gate, caseGate);
  assert.deepEqual(exclusions, [{ caseId: "synthetic-cycle", stage: "prefix", unmet: ["script_mismatch"] }]);
  // The case's missing verified agree/deny responses cause script_mismatch.
  // evaluateRunGate excludes it, then evaluates EMPTY eligible receipts. Its
  // classifier_evidence_invalid/local_pipeline_incomplete are secondary run
  // diagnostics, not classifier transport errors or an unfinished prefix.

  assert.deepEqual(progress, [
    { caseId: "synthetic-cycle", stage: "prefix", turn: 1 }, { caseId: "synthetic-cycle", stage: "prefix", turn: 3 },
    { caseId: "synthetic-cycle", stage: "prefix", turn: 5 }, { caseId: "synthetic-cycle", stage: "prefix", turn: 7 },
  ]);
  assert.equal(factories, 1);
  assert.deepEqual(extractionTurns, [1, 3, 5, 7]); assert.deepEqual(classificationTurns, [1, 3, 5, 7]);
  assert.equal(deps.judgments.length, 4);
  assert.deepEqual(deps.calls.map(c => c.options.phase), ["generation", "generation", "generation", "generation"]);
  assert.equal(prefix.caseId, "synthetic-cycle"); assert.equal(prefix.stage, "prefix");
  assert.deepEqual(prefix.publicTurns.map((t: any) => [t.turn, t.speaker]), [
    [1, "human"], [2, "ai"], [3, "human"], [4, "ai"], [5, "human"], [6, "ai"], [7, "human"], [8, "ai"],
  ]);
  assert.deepEqual(prefix.provenance.map((p: any) => [p.humanTurn, p.aiTurn]), [[1, 2], [3, 4], [5, 6], [7, 8]]);
  for (const provenance of prefix.provenance) {
    assert.equal(prefix.publicTurns.find((t: any) => t.turn === provenance.aiTurn).text, provenance.text);
  }
  assert.deepEqual(prefix.records.map((r: any) => r.turnIndex), [1, 3, 5, 7]);
  assert.deepEqual(prefix.records.map((r: any) => r.classifier.callIndex), [1, 2, 3, 4]);
  assert.equal(prefix.snapshot.judgments.length, 4);
  for (const [index, record] of prefix.records.entries()) {
    assert.equal(record.status, "committed"); assert.equal(record.localStatus, "ok");
    assert.equal(record.classifier.kind, "jev_local_test"); assert.equal(record.classifier.status, "ok");
    assert.equal(Object.hasOwn(record.extractor, "errorCode"), false);
    assert.equal(Object.hasOwn(record.classifier, "errorCode"), false);
    const installed = prefix.snapshot.judgments[index];
    assert.equal(installed.status, "committed"); assert.equal(installed.turnIndex, record.turnIndex);
    assert.equal(installed.lastEventId, record.lastEventId);
    assert.equal(installed.localGrounding.attemptNumber, record.attemptNumber);
  }
  assert.deepEqual(prefix.classifierEvidence.map((e: any) => [e.callIndex, e.status, e.reason]),
    [[1, "ok", null], [2, "ok", null], [3, "ok", null], [4, "ok", null]]);
  assert.deepEqual(prefix.receipts.map((r: any) => r.turn), [1, 3, 5, 7]);
  for (const receipt of prefix.receipts) {
    assert.equal(receipt.pipelineOk, true); assert.equal(receipt.classifierOk, true); assert.equal(receipt.unverified, 0);
  }
  assert.deepEqual(failures, []);

  assert.deepEqual(prefix.records.map((r: any) => r.classifier.verdicts), [
    [{ segmentId: "s1", act: "assert", respondsToClaimId: null }],
    [{ segmentId: "s1", act: "agree", respondsToClaimId: null }],
    [{ segmentId: "s1", act: "deny", respondsToClaimId: null }],
    [{ segmentId: "s1", act: "name_accept", respondsToClaimId: "7:ai1" }],
  ]);
  const [first, agreement, denial, naming] = prefix.records;
  assert.deepEqual(first.verification, { accepted: ["1:local1"], rejected: [] });
  assert.deepEqual(first.claims.map((c: any) => [c.id, c.speaker, c.act]), [["1:local1", "human", "assert"]]);
  for (const record of [agreement, denial]) {
    assert.deepEqual(record.verification, { accepted: [], rejected: [{ segmentId: "s1", reason: "missing_claim_response" }] });
    assert.deepEqual(record.aiClaims, []); assert.deepEqual(record.claims, []);
  }
  assert.deepEqual(naming.verification, { accepted: ["7:ai1", "7:local1"], rejected: [] });
  assert.deepEqual(naming.aiClaims.map((c: any) => [c.id, c.aspect, c.act, c.sourceTurn]), [["7:ai1", "name", "name_propose", 6]]);
  assert.deepEqual(naming.claims.map((c: any) => [c.id, c.aspect, c.act, c.respondsTo]), [["7:local1", "name", "name_accept", "7:ai1"]]);
  const aiClaims = prefix.snapshot.graph.records.filter((r: any) => r.kind === "claim" && r.speaker === "ai");
  assert.deepEqual(aiClaims.map((c: any) => [c.id, c.aspect, c.act, c.sourceTurn]), [["7:ai1", "name", "name_propose", 6]]);
  assert.equal(aiClaims.filter((c: any) => c.aspect === "part").length, 0);

  // Exact prefix progress/call counts and this file set jointly exclude later
  // branch/multiturn work; unexecuted plans do not count as downstream success.
  assert.deepEqual((await readdir(result.directory)).sort(), ["exclusions.private.json", "failures.private.json", "gate.private.json",
    "result.private.json", "run.private.json", "synthetic-cycle.prefix.private.json"]);
}));
