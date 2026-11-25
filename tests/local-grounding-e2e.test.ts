// Deterministic synthetic integration; no participant data or live API.
import test from "node:test";
import assert from "node:assert/strict";
import { createDialogueV2 } from "../dialogue-model/runtime/v2/dialogue-v2.mjs";
import { createNamingTaskV2 } from "../dialogue-model/runtime/v2/naming-task-v2.mjs";
import { createReferenceGraph, applyReferenceUpdate } from "../dialogue-model/runtime/memory/reference-graph.mjs";
import { deriveLocalIssues } from "../dialogue-model/runtime/local-grounding/derive.ts";
import { createMockLocalExtractor, createMockLocalClassifier } from "../dialogue-model/runtime/local-grounding/mocks.ts";
import { SYNTHETIC_CASES, SYNTHETIC_SLOTS } from "../dialogue-model/runtime/diagnostics/local-grounding-eval/cases.ts";
import type { SyntheticCase } from "../dialogue-model/runtime/diagnostics/local-grounding-eval/cases.ts";
import type { LocalClassificationInput, LocalExtractionInput, LocalGroundingOptions } from "../dialogue-model/runtime/local-grounding/contract.ts";

type Any = any; // Existing JS v2 adapters expose runtime-validated, dynamically shaped records.
const strategies = ["repair-first", "bypass-enabled"];
const anchors = SYNTHETIC_SLOTS.map((id, index) => ({ id, bbox: { x: index * 10, y: 10, w: 8, h: 8 }, centroid: { x: index * 10 + 4, y: 14 } }));
const image = { mimeType: "image/png", base64: Buffer.from("synthetic-own-image-only").toString("base64") };
const safeAct = { action: "accept", targetSlot: null, candidateName: null, discriminatingFeature: null, note: null };
const judge = { async judge() { return { ...safeAct }; } };
const generator = () => ({ async complete() { return { text: "なるほど、続きを聞かせてください。", model: "mock" }; } });
const eventsOf = (example: SyntheticCase) => example.publicTurns.map((turn) => ({ seq: turn.turn, id: `synthetic-${turn.turn}`, speaker: turn.speaker, text: turn.text }));

function seedGraph(example: SyntheticCase) {
  let graph = createReferenceGraph({ slots: SYNTHETIC_SLOTS });
  for (const turn of [...new Set(example.priorClaims.map((claim) => claim.turn))].sort((a, b) => a - b)) {
    const operations = example.priorClaims.filter((claim) => claim.turn === turn).map(({ turn: _turn, ...claim }) => ({ kind: "claim", ...claim }));
    graph = applyReferenceUpdate(graph, { expectedRevision: graph.revision, turn, operations }, {
      generationSucceeded: true, publicTurns: example.publicTurns.filter((prior) => prior.turn <= turn),
    } as Any);
  }
  return graph;
}

function scripted(example: SyntheticCase, score = 1) {
  const extractionInputs: LocalExtractionInput[] = [], classificationInputs: LocalClassificationInput[] = [];
  const segments = example.segments.map((segment, index) => ({ segmentId: `s${index + 1}`, quote: segment.quote,
    targets: [...segment.targets], aspect: segment.aspect, proposition: segment.proposition, name: segment.name ?? null,
    linkedIssueId: segment.linkedIssue ?? null,
    respondsToTurn: segment.antecedent ? example.priorClaims.find((claim) => claim.id === segment.antecedent)!.sourceTurn : null }));
  const extractor = createMockLocalExtractor((input: LocalExtractionInput) => { extractionInputs.push(structuredClone(input)); return structuredClone(segments); });
  const classifier = createMockLocalClassifier((input: LocalClassificationInput) => {
    classificationInputs.push(structuredClone(input));
    return input.segments.map((segment) => ({ segmentId: segment.segmentId, act: example.segments[Number(segment.segmentId.slice(1)) - 1].act,
      respondsToClaimId: example.segments[Number(segment.segmentId.slice(1)) - 1].antecedent ?? null, rawScore: score }));
  });
  return { localGrounding: { extractor, classifier }, extractionInputs, classificationInputs };
}

async function runCase(example: SyntheticCase, strategy = "repair-first", score = 1) {
  const mocks = scripted(example, score);
  const dialogue = createDialogueV2({ client: generator(), judge, strategy, image, anchors, referenceMemory: true,
    localGrounding: mocks.localGrounding } as Any);
  const before = { ...dialogue.initialPrivateState(), graph: seedGraph(example) };
  const events = eventsOf(example);
  const result = await dialogue.runAiTurn({ events, privateState: before, lastEventId: events.at(-1)!.id });
  return { dialogue, before, result, ...mocks };
}

for (const example of SYNTHETIC_CASES) {
  test(`synthetic v2 partial grounding: ${example.id}`, async () => {
    const { result, before } = await runCase(example);
    const issues = deriveLocalIssues(result.privateState.graph);
    for (const expected of example.expected) {
      const actual = issues.find((issue) => (!expected.issueId || issue.issueId === expected.issueId) &&
        issue.aspect === expected.aspect && JSON.stringify(issue.targets) === JSON.stringify(expected.targets));
      assert.ok(actual, `${example.id}: missing ${JSON.stringify(expected)}`);
      assert.equal(actual.state, expected.state, `${example.id}: ${expected.aspect}`);
      assert.equal(actual.nameState, expected.nameState, `${example.id}: ${expected.aspect} nameState`);
    }
    // None of these local updates is an instruction to promote the six-figure ledger.
    assert.deepEqual(result.privateState.ledger, before.ledger);
    assert.ok(Object.values(result.privateState.ledger).every((entry: Any) => entry.status === "unassigned"));
    for (const prior of example.priorClaims) {
      const stored = result.privateState.graph.records.find((record: Any) => record.id === prior.id);
      assert.deepEqual(stored, { kind: "claim", ...prior }, "local updates preserve every earlier attributed claim");
    }
    const agreedTargets = (items: Array<{ targets: string[]; nameState: string | null }>) => items.filter((issue) => issue.nameState === "agreed").map((issue) => issue.targets).sort();
    assert.deepEqual(agreedTargets(issues), agreedTargets(example.expected), "name agreement cannot spread to a different target");
    assert.equal(issues.filter((issue) => issue.aspect === "referent" && issue.state === "supported").length,
      example.expected.filter((issue) => issue.aspect === "referent" && issue.state === "supported").length,
      "local feature agreement cannot establish whole-figure identification");
    for (const segment of example.segments.filter((segment) => segment.linkedIssue)) {
      const continuation = result.privateState.graph.records.find((record: Any) => record.kind === "claim" &&
        record.sourceTurn === example.publicTurns.at(-1)!.turn && record.quote === segment.quote);
      assert.equal(continuation?.issueId, segment.linkedIssue, "defer/revisit preserve the stable local issue identity");
    }
    assert.deepEqual(before.graph, seedGraph(example), "adapter never mutates caller state");
  });
}

test("strategies share byte-identical extraction/classification input; model scores never promote issues", async () => {
  for (const example of SYNTHETIC_CASES) {
    const repair = await runCase(example, strategies[0], 0);
    const bypass = await runCase(example, strategies[1], 1);
    assert.ok(JSON.stringify(repair.extractionInputs) === JSON.stringify(bypass.extractionInputs), "strategy extraction inputs must be byte-identical");
    assert.ok(JSON.stringify(repair.classificationInputs) === JSON.stringify(bypass.classificationInputs), "strategy classification inputs must be byte-identical");
    assert.deepEqual(deriveLocalIssues(repair.result.privateState.graph), deriveLocalIssues(bypass.result.privateState.graph));
  }
});

test("generation failure and abort leave all local changes uncommitted", async () => {
  const example = SYNTHETIC_CASES[0];
  for (const abort of [false, true]) {
    const mocks = scripted(example);
    const controller = new AbortController();
    const client = { async complete() {
      if (abort) { controller.abort(); return { text: "未公開の下書きです。" }; }
      throw Object.assign(new Error("PRIVATE-UPSTREAM-BODY"), { code: "provider_http_error", status: 502 });
    } };
    const dialogue = createDialogueV2({ client, judge, strategy: "repair-first", image, anchors, referenceMemory: true,
      localGrounding: mocks.localGrounding } as Any);
    const state = { ...dialogue.initialPrivateState(), graph: seedGraph(example) };
    const saved = structuredClone(state);
    await assert.rejects(dialogue.runAiTurn({ events: eventsOf(example), privateState: state, signal: controller.signal, lastEventId: "synthetic-3" }));
    assert.deepEqual(state, saved);
    assert.doesNotMatch(JSON.stringify(dialogue.getAttempts()), /PRIVATE-UPSTREAM-BODY|未公開の下書き/);
  }
});

test("memory OFF and omitted/null local option retain byte-identical requests and state", async () => {
  const example = SYNTHETIC_CASES[3];
  for (const referenceMemory of [false, true]) {
    const outputs: Any[] = [];
    for (const explicit of [false, true]) {
      const requests: Any[] = [];
      const client = { async complete(messages: Any[], options: Any) { requests.push({ messages, options }); return { text: "なるほど。" }; } };
      const dialogue = createDialogueV2({ client, judge, strategy: "repair-first", image, anchors, referenceMemory,
        ...(explicit ? { localGrounding: null } : {}) } as Any);
      const result = await dialogue.runAiTurn({ events: eventsOf(example), privateState: dialogue.initialPrivateState(), lastEventId: "synthetic-3" });
      outputs.push({ result, requests });
      assert.equal(result.privateState.graph === null, !referenceMemory);
      assert.ok(!JSON.stringify(dialogue.getAttempts()).includes("localGrounding"));
    }
    assert.ok(JSON.stringify(outputs[0]) === JSON.stringify(outputs[1]), "OFF requests and state must be byte-identical");
  }
  assert.throws(() => createDialogueV2({ client: generator(), judge, strategy: "repair-first", image, anchors,
    referenceMemory: false, localGrounding: scripted(example).localGrounding } as Any));
});

test("naming-task commits, restores local state, preserves opt-in and rolls back failed generation", async () => {
  const records: Any[] = [];
  let fail = false, extractionCalls = 0;
  const localGrounding: LocalGroundingOptions = {
    extractor: createMockLocalExtractor((input: LocalExtractionInput) => { extractionCalls++; return [{ segmentId: "s1", quote: input.publicTurns.at(-1)!.text,
      targets: [input.ownSlots[0]], aspect: "part", proposition: "四角がある", name: null, linkedIssueId: null, respondsToTurn: null }]; }),
    classifier: createMockLocalClassifier((input: LocalClassificationInput) => input.segments.map((segment) => ({ segmentId: segment.segmentId, act: "assert", respondsToClaimId: null, rawScore: 1 }))),
  };
  const client = { async complete() { if (fail) throw new Error("PRIVATE-FAILURE-BODY"); return { text: "なるほど。", model: "mock" }; } };
  const base = { client, judge, strategy: "bypass-enabled", seed: 155, runDir: null, referenceMemory: true, localGrounding,
    onPersist: async (record: Any) => { records.push(structuredClone(record)); } };
  const task = await createNamingTaskV2(base as Any);
  task.message("四角が一つあります。", "synthetic-first");
  await task.whenIdle();
  const saved = structuredClone(records.at(-1));
  const before = structuredClone(task.researcherView().privateState);
  assert.ok(deriveLocalIssues(before.graph).length > 0);
  const restored = await createNamingTaskV2({ ...base, restore: saved } as Any);
  assert.deepEqual(restored.researcherView().privateState, before);
  assert.deepEqual(restored.getState().events, task.getState().events);
  const callsBefore = extractionCalls;
  fail = true;
  restored.message("四角についてもう一度話したいです。", "synthetic-second");
  await restored.whenIdle();
  assert.equal(restored.getState().aiStatus, "error");
  assert.deepEqual(restored.researcherView().privateState, before);
  assert.ok(extractionCalls > callsBefore);
  assert.doesNotMatch(JSON.stringify(records.at(-1)), /PRIVATE-FAILURE-BODY/);
  fail = false;
  await restored.retry();
  await restored.whenIdle();
  assert.equal(restored.getState().aiStatus, "idle");
  assert.equal(restored.researcherView().privateState.judgments.length, before.judgments.length + 1);
});

test("OFF records are byte-identical for omitted/null options and restore cannot silently enable the feature", async () => {
  for (const referenceMemory of [false, true]) {
    let saved: Any;
    const base = { client: generator(), judge, strategy: "repair-first", seed: 156, runDir: null,
      referenceMemory, now: () => 1000, onPersist: async (record: Any) => { saved = structuredClone(record); } };
    const first = await createNamingTaskV2(base as Any);
    const restore = structuredClone(saved);
    const records: string[] = [];
    for (const explicit of [false, true]) {
      await createNamingTaskV2({ ...base, restore, ...(explicit ? { localGrounding: null } : {}),
        onPersist: async (record: Any) => { records.push(JSON.stringify(record)); } } as Any);
    }
    assert.equal(records[0], records[1]);
    assert.ok(!records[0].includes("localGrounding"));
    if (referenceMemory) {
      let calls = 0;
      const enabled = { extractor: createMockLocalExtractor(() => { calls++; return []; }),
        classifier: createMockLocalClassifier(() => []) };
      const restored = await createNamingTaskV2({ ...base, restore, localGrounding: enabled } as Any);
      restored.message("四角の形を見ています。");
      await restored.whenIdle();
      assert.equal(calls, 0, "an OFF trial cannot acquire local grounding on restore");
      assert.equal(first.getState().events.length, 1);
    }
  }
});

test("published AI primary naming proposal becomes the short acknowledgement's verified antecedent through the normal queue", async () => {
  let judgments = 0, generations = 0;
  const requests: LocalClassificationInput[] = [];
  const namingJudge = { async judge(input: Any) {
    return judgments++ === 0 ? { action: "propose_name", targetSlot: Object.keys(input.ownLedger)[0], candidateName: "帆", discriminatingFeature: null, note: null } : { ...safeAct };
  } };
  const localGrounding = {
    extractor: createMockLocalExtractor((input: LocalExtractionInput) => input.publicTurns.at(-1)!.text === "うん。" ? [{
      segmentId: "s1", quote: "うん", targets: [input.ownSlots[0]], aspect: "name", proposition: "帆と呼ぶ", name: "帆", linkedIssueId: null,
      respondsToTurn: input.publicTurns.filter((turn) => turn.speaker === "ai").at(-1)!.turn,
    }] : []),
    classifier: createMockLocalClassifier((input: LocalClassificationInput) => {
      requests.push(structuredClone(input));
      const primary = input.priorClaims.find((claim) => claim.speaker === "ai" && claim.act === "name_propose" && claim.name === "帆");
      return input.segments.map((segment) => ({ segmentId: segment.segmentId, act: "name_accept", respondsToClaimId: primary?.id ?? null, rawScore: 1 }));
    }),
  };
  const client = { async complete() { return { text: generations++ === 0 ? "『帆』と呼ぶのはどうでしょう？" : "はい、続きを聞かせてください。", model: "mock" }; } };
  const task = await createNamingTaskV2({ client, judge: namingJudge, strategy: "repair-first", seed: 158, referenceMemory: true,
    localGrounding, runDir: null } as Any);
  task.message("名前を相談したいです。");
  await task.whenIdle();
  task.message("うん。");
  await task.whenIdle();
  assert.equal(task.getState().aiStatus, "idle");
  const state = task.researcherView().privateState;
  const issue = deriveLocalIssues(state.graph).find((issue) => issue.aspect === "name");
  assert.equal(issue?.nameState, "agreed");
  assert.equal(issue?.state, "supported");
  const primary = requests.at(-1)!.priorClaims.find((claim) => claim.act === "name_propose");
  assert.equal(primary?.source, "ai_hypothesis");
  assert.equal(primary?.sourceTurn, 3);
  assert.match(primary!.id, /:ai1$/);
  assert.equal(Object.values(state.ledger).filter((entry: Any) => entry.status === "agreed").length, 0,
    "a local name acceptance is not a program instruction to certify figure identification");
});
