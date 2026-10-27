// Synthetic public utterances and injected local models only. No external API.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDialogueV2 } from "../dialogue-model/runtime/v2/dialogue-v2.mjs";
import { createNamingTaskV2 } from "../dialogue-model/runtime/v2/naming-task-v2.mjs";
import { createHumanMessageQueue } from "../dialogue-model/runtime/web/human-message-queue.mjs";
import { findLocalPublicationViolations, settleLocalTraces, type LocalGroundingResearchRecord } from "../dialogue-model/runtime/v2/local-grounding-turn.ts";
import { LOCAL_EXTRACTION_INSTRUCTIONS, LocalExtractionError, type LocalExtractionErrorCode } from "../dialogue-model/runtime/local-grounding/extract.ts";
import { LocalClassificationError, type LocalClassificationErrorCode } from "../dialogue-model/runtime/local-grounding/classify.ts";
import type { LocalGroundingOptions, LocalSegmentProposal, LocalClassificationInput } from "../dialogue-model/runtime/local-grounding/contract.ts";

const ids = Array.from({ length: 6 }, (_, i) => `s-000${i + 1}`);
const anchors = ids.map((id, x) => ({ id, bbox: { x, y: 0, w: 1, h: 1 }, centroid: { x, y: 0 } }));
const image = { mimeType: "image/png", base64: "c3ludGhldGlj" };
const utterance = "四角い部分があります";
const events = [{ id: "event-1", seq: 1, speaker: "human", text: utterance }];
const core = { action: "accept", targetSlot: null, candidateName: null, discriminatingFeature: null, note: null };
const reference = (slot: string) => ({ slots: [slot], epistemic: "grounded", intent: "feature_assertion",
  feature: { slot, feature: "四角い部分", polarity: "confirmed" }, nameAcceptance: null, deferSlot: null, revisitSlot: null });
const segment = (slot: string, quote = utterance): LocalSegmentProposal => ({ segmentId: "s1", quote, targets: [slot],
  aspect: "part", proposition: "四角い部分がある", name: null, linkedIssueId: null, respondsToTurn: null });
const options = (): LocalGroundingOptions => ({
  extractor: { async extract(input) { return [segment(input.ownSlots[0], input.publicTurns.at(-1)!.text)]; } },
  classifier: { async classify(input) { return input.segments.map(s => ({ segmentId: s.segmentId, act: "assert", respondsToClaimId: null, rawScore: 0.01 })); } },
});
function harness(extra: Record<string, unknown> = {}) {
  const calls: unknown[] = [];
  const client = { async complete(messages: unknown, request: unknown) { calls.push({ messages, request }); return { text: "そう見えるんですね。" }; } };
  const judge = { async judge(input: { ownLedger: Record<string, unknown> }) { return { ...core, reference: reference(Object.keys(input.ownLedger)[0]) }; } };
  const dialogue = createDialogueV2({ client, judge, image, anchors, strategy: "repair-first", referenceMemory: true, ...extra } as any);
  const initial = dialogue.initialPrivateState();
  const run = (input: Record<string, unknown> = {}) => dialogue.runAiTurn({ events, privateState: initial, lastEventId: "event-1", ...input });
  return { dialogue, initial, calls, run, client, judge };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("local grounding omitted and null keep requests, private state and traces byte identical", async () => {
  const implicit = harness(), explicit = harness({ localGrounding: null });
  const a = await implicit.run(), b = await explicit.run();
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(JSON.stringify(implicit.calls), JSON.stringify(explicit.calls));
  assert.equal(JSON.stringify(implicit.dialogue.getAttempts()), JSON.stringify(explicit.dialogue.getAttempts()));
  // Originally captured from e06b04e; re-captured for the Luna public-act change after checking the only
  // differences are humanNaming/publication on traces, the Luna generator text and the Luna accept scope.
  // Guards the request, output state and trace bytes, not just null's alias.
  const bytes = JSON.stringify({ result: a, calls: implicit.calls, attempts: implicit.dialogue.getAttempts() });
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "3bea3cb9b5e96f764d3f83b932a407be14a9a148d47161aa2d8571257c07feb0");
  assert.ok(!JSON.stringify(implicit.dialogue.getAttempts()).includes("localGrounding"));
  assert.ok(!JSON.stringify(implicit.calls).includes("局所問題の作業メモ"));
});

test("options require reference memory and validate both local functions and a positive finite timeout", () => {
  assert.throws(() => harness({ localGrounding: options(), referenceMemory: false }), /requires reference memory/);
  for (const value of [{}, { extractor: {} }, { ...options(), classifier: {} },
    ...[0, -1, NaN, Infinity, null, "20"].map(timeoutMs => ({ ...options(), timeoutMs }))]) {
    assert.throws(() => harness({ localGrounding: value }), /Invalid local grounding/);
  }
  harness({ localGrounding: { ...options(), timeoutMs: 0.5 } });
  harness({ localGrounding: { ...options(), timeoutMs: Number.MAX_VALUE } });
});

test("claims join existing mention/feature operations only in the returned detached state", async () => {
  const h = harness({ localGrounding: options() });
  const before = JSON.stringify(h.initial);
  const result = await h.run();
  assert.equal(JSON.stringify(h.initial), before);
  assert.deepEqual(result.privateState.graph.records.map((r: any) => r.kind), ["mention", "feature", "claim"]);
  const trace = h.dialogue.getAttempts()[0].localGrounding;
  assert.equal(trace.status, "ok"); assert.equal(trace.segments, 1); assert.equal(trace.accepted, 1);
  assert.deepEqual(trace.rejected, []);
  assert.ok(JSON.stringify(h.calls).includes("1:local1"), "generation sees the current staged issue");
  assert.ok(JSON.stringify(h.calls).includes("四角い部分がある"), "generation sees the issue's proposition, not only its state");
});

test("both strategies receive identical extraction, classification and generation information", async () => {
  const seen: unknown[][] = [], generation: unknown[][] = [];
  for (const strategy of ["repair-first", "bypass-enabled"]) {
    const local = options(), inputs: unknown[] = [];
    const extract = local.extractor.extract, classify = local.classifier.classify;
    local.extractor.extract = async (input, opts) => { inputs.push(structuredClone(input)); return extract(input, opts); };
    local.classifier.classify = async (input, opts) => { inputs.push(structuredClone(input)); return classify(input, opts); };
    const h = harness({ strategy, localGrounding: local }); await h.run();
    seen.push(inputs); generation.push(h.calls);
  }
  assert.deepEqual(seen[0], seen[1]);
  assert.deepEqual(generation[0], generation[1]);
});

test("one rejected segment preserves valid local claims and the existing memory", async () => {
  const local = options();
  local.extractor.extract = async () => [segment(ids[0]), { ...segment(ids[0], "SYNTHETIC_PRIVATE_CANARY"), segmentId: "PRIVATE_CANARY_ID" }];
  const h = harness({ localGrounding: local }); const result = await h.run();
  assert.deepEqual(result.privateState.graph.records.map((r: any) => r.kind), ["mention", "feature", "claim"]);
  const trace = h.dialogue.getAttempts()[0].localGrounding;
  assert.equal(trace.rejected.length, 1);
  assert.ok(!JSON.stringify(trace).includes("CANARY"));
});

test("trace permits only known classifier kinds and extraction diagnostic codes", async () => {
  for (const classifierKind of ["unverified_injected", "luna_standin", "jev_local_test", "jev", "SYNTHETIC_PRIVATE_CANARY"]) {
    const local = options();
    Object.assign(local.classifier, { metadata: { classifierKind } });
    Object.assign(local.extractor, { lastDiagnostics: { rejectedSegments: 1, reasons: ["quote_not_found"] } });
    const h = harness({ localGrounding: local }); await h.run();
    const trace = h.dialogue.getAttempts()[0].localGrounding;
    assert.equal(trace.classifierKind, classifierKind === "luna_standin" || classifierKind === "jev_local_test" ? classifierKind : "unverified_injected");
    assert.deepEqual(trace.extraction, { rejectedSegments: 1, reasons: ["quote_not_found"] });
    assert.ok(!JSON.stringify(trace).includes("CANARY"));
  }
  const local = options();
  Object.assign(local.extractor, { lastDiagnostics: { rejectedSegments: 1, reasons: ["SYNTHETIC_PRIVATE_CANARY"] } });
  const h = harness({ localGrounding: local }); await h.run();
  assert.equal(h.dialogue.getAttempts()[0].localGrounding.extraction, undefined);
});

test("graph operation budget drops only overflowing claims and keeps the original mention", async () => {
  const local = options();
  const quotes = Array.from({ length: 16 }, (_, i) => `特徴${i + 1}`);
  local.extractor.extract = async () => quotes.map((quote, i) => ({ ...segment(ids[0], quote), segmentId: `s${i + 1}`, proposition: quote }));
  const h = harness({ localGrounding: local });
  const result = await h.run({ events: [{ ...events[0], text: quotes.join("、") }] });
  const trace = h.dialogue.getAttempts()[0].localGrounding;
  assert.equal(trace.status, "ok");
  assert.equal(trace.accepted, 15);
  assert.equal(trace.rejected.length, 1);
  assert.equal(trace.rejected[0].reason, "memory_invalid_update");
  assert.equal(result.privateState.graph.records[0].kind, "mention");
  assert.equal(result.privateState.graph.records.length, 16);
});

test("generation failure rolls back all claims and existing reference updates", async () => {
  const h = harness({ localGrounding: options(), client: { async complete() { throw new Error("SYNTHETIC_PRIVATE_CANARY"); } } });
  await assert.rejects(h.run());
  assert.deepEqual(h.initial.graph.records, []);
  assert.equal(h.dialogue.getAttempts()[0].localGrounding.accepted, 1);
  assert.ok(!JSON.stringify(h.dialogue.getAttempts()).includes("CANARY"));
});

test("supersede during extraction settles promptly and ignores late extractor output", async () => {
  const entered = gate(), late = gate(); let classifications = 0, extractions = 0;
  const local = options();
  local.extractor.extract = async input => {
    if (++extractions === 1) { entered.release(); await late.promise; }
    return [segment(input.ownSlots[0], input.publicTurns.at(-1)!.text)];
  };
  const classify = local.classifier.classify;
  local.classifier.classify = async (input, opts) => { classifications++; return classify(input, opts); };
  const h = harness({ localGrounding: local });
  const queue = createHumanMessageQueue({ runAiTurn: h.dialogue.runAiTurn, initialPrivateState: h.initial });
  queue.enqueue({ text: utterance }); await entered.promise;
  queue.enqueue({ text: "四角い部分ではありません" }); await queue.whenIdle();
  const state = queue.getPrivateState();
  assert.equal(state.judgments.length, 1);
  assert.equal(state.graph.records.filter((r: any) => r.kind === "claim").length, 1);
  assert.equal(state.graph.records.find((r: any) => r.kind === "claim").sourceTurn, 2);
  assert.equal(h.dialogue.getAttempts()[0].localGrounding.status, "aborted");
  const snapshot = JSON.stringify(state);
  late.release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(classifications, 1, "abandoned extraction cannot start a classifier later");
  assert.equal(JSON.stringify(queue.getPrivateState()), snapshot);
});

test("supersede after local verification cannot install a stale generation snapshot", async () => {
  const entered = gate(), late = gate(); let calls = 0;
  const h = harness({ localGrounding: options(), client: { async complete() {
    if (++calls === 1) { entered.release(); await late.promise; }
    return { text: "そう見えるんですね。" };
  } } });
  const queue = createHumanMessageQueue({ runAiTurn: h.dialogue.runAiTurn, initialPrivateState: h.initial });
  queue.enqueue({ text: utterance }); await entered.promise;
  queue.enqueue({ text: "細長い部分です" }); late.release(); await queue.whenIdle();
  const state = queue.getPrivateState();
  assert.equal(state.judgments.length, 1);
  assert.ok(state.graph.records.filter((r: any) => r.kind === "claim").every((r: any) => r.sourceTurn === 2));
  assert.deepEqual(queue.getSnapshot().events.map((e: any) => e.speaker), ["human", "human", "ai"]);
});

for (const phase of ["extractor", "classifier"] as const) {
  test(`${phase} timeout keeps the turn and legacy memory, and ignores late operations`, async t => {
    let clock = 0;
    t.mock.method(performance, "now", () => clock);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const local = options(), entered = gate(), late = gate(), records: LocalGroundingResearchRecord[] = [];
    local.timeoutMs = 5;
    if (phase === "extractor") local.extractor.extract = async () => { entered.release(); await late.promise; return [segment(ids[0])]; };
    else local.classifier.classify = async () => { entered.release(); await late.promise; return [{ segmentId: "s1", act: "assert", respondsToClaimId: null, rawScore: 1 }]; };
    const h = harness({ localGrounding: local, onLocalGroundingTrace: (record: LocalGroundingResearchRecord) => records.push(record) }); const work = h.run();
    // Expire the shared deadline only after the selected phase has started.
    await entered.promise;
    clock = local.timeoutMs;
    t.mock.timers.tick(local.timeoutMs);
    const result = await work;
    assert.deepEqual(result.privateState.graph.records.map((r: any) => r.kind), ["mention", "feature"]);
    assert.equal(h.dialogue.getAttempts()[0].localGrounding.status, "timeout");
    assert.equal(records[0][phase].errorCode, "timeout");
    assert.equal(records[0][phase === "extractor" ? "classifier" : "extractor"].errorCode, undefined);
    const before = JSON.stringify(h.dialogue.getAttempts());
    const researchBefore = JSON.stringify(records);
    late.release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.stringify(h.dialogue.getAttempts()), before);
    assert.equal(JSON.stringify(records), researchBefore);
  });
  test(`${phase} exception records only a fixed reason and does not fail the turn`, async () => {
    const local = options();
    const fail = async (): Promise<never> => { throw Object.assign(new Error("SYNTHETIC_PRIVATE_CANARY"), { code: "private_canary" }); };
    if (phase === "extractor") local.extractor.extract = fail; else local.classifier.classify = fail;
    const h = harness({ localGrounding: local }); const result = await h.run();
    assert.equal(result.privateState.graph.records.filter((r: any) => r.kind === "claim").length, 0);
    const trace = h.dialogue.getAttempts()[0].localGrounding;
    assert.equal(trace.status, "error");
    assert.equal(trace.rejected[0].reason, `${phase}_failed`);
    assert.ok(!JSON.stringify(h.dialogue.getAttempts()).toLowerCase().includes("canary"));
  });
}

test("research errors expose only each stage's existing closed codes", async () => {
  const extractionCodes: LocalExtractionErrorCode[] = ["invalid_input", "invalid_json", "invalid_response", "invalid_quote", "duplicate_segment", "timeout", "aborted", "unavailable"];
  const classificationCodes: LocalClassificationErrorCode[] = ["invalid_input", "invalid_json", "invalid_response", "segment_mismatch", "timeout", "aborted", "unavailable"];
  for (const phase of ["extractor", "classifier"] as const) {
    const errors = phase === "extractor" ? extractionCodes.map(code => new LocalExtractionError(code)) : classificationCodes.map(code => new LocalClassificationError(code));
    const expectedCodes = phase === "extractor" ? extractionCodes : classificationCodes;
    for (const [index, error] of errors.entries()) {
      const records: LocalGroundingResearchRecord[] = [], local = options();
      error.message = "SYNTHETIC_PRIVATE_CANARY";
      const fail = async (): Promise<never> => { throw error; };
      if (phase === "extractor") local.extractor.extract = fail; else local.classifier.classify = fail;
      const h = harness({ localGrounding: local, onLocalGroundingTrace: (record: LocalGroundingResearchRecord) => records.push(record) });
      const result = await h.run();
      assert.equal(result.privateState.graph.records.filter((r: any) => r.kind === "claim").length, 0);
      assert.equal(records[0][phase].errorCode, expectedCodes[index]);
      assert.equal(records[0][phase === "extractor" ? "classifier" : "extractor"].errorCode, undefined);
      assert.equal(settleLocalTraces(records, result.privateState)[0][phase].errorCode, expectedCodes[index]);
      assert.ok(!JSON.stringify({ records, attempts: h.dialogue.getAttempts() }).includes("CANARY"));
    }
  }
});

test("unknown, spoofed and modified exceptions cannot inject research error codes", async () => {
  for (const phase of ["extractor", "classifier"] as const) {
    const typed = phase === "extractor" ? new LocalExtractionError("invalid_json") : new LocalClassificationError("invalid_json");
    Object.assign(typed, { code: "synthetic_private_canary" });
    const getter = phase === "extractor" ? new LocalExtractionError("invalid_json") : new LocalClassificationError("invalid_json");
    Object.defineProperty(getter, "code", { get() { throw new Error("SYNTHETIC_PRIVATE_CANARY"); } });
    for (const error of [new Error("SYNTHETIC_PRIVATE_CANARY"), { name: typed.name, code: "invalid_json", response: "SYNTHETIC_PRIVATE_CANARY" }, typed, getter]) {
      const records: LocalGroundingResearchRecord[] = [], local = options();
      const fail = async (): Promise<never> => { throw error; };
      if (phase === "extractor") local.extractor.extract = fail; else local.classifier.classify = fail;
      const h = harness({ localGrounding: local, onLocalGroundingTrace: (record: LocalGroundingResearchRecord) => records.push(record) });
      await h.run();
      assert.equal(records[0][phase].errorCode, "unavailable");
      assert.ok(!JSON.stringify({ records, attempts: h.dialogue.getAttempts() }).toLowerCase().includes("canary"));
    }
  }
});

test("external abort records only the interrupted stage and ignores its late failure", async () => {
  for (const phase of ["extractor", "classifier"] as const) {
    const records: LocalGroundingResearchRecord[] = [], local = options(), entered = gate(), late = gate(), controller = new AbortController();
    const pending = async (): Promise<never> => { entered.release(); await late.promise; throw new Error("SYNTHETIC_PRIVATE_CANARY"); };
    if (phase === "extractor") local.extractor.extract = pending; else local.classifier.classify = pending;
    const h = harness({ localGrounding: local, onLocalGroundingTrace: (record: LocalGroundingResearchRecord) => records.push(record) });
    const running = h.run({ signal: controller.signal });
    await entered.promise; controller.abort();
    await assert.rejects(running, { name: "AbortError" });
    assert.equal(records[0].status, "aborted");
    assert.equal(records[0][phase].errorCode, "aborted");
    assert.equal(records[0][phase === "extractor" ? "classifier" : "extractor"].errorCode, undefined);
    const before = JSON.stringify(records);
    late.release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.stringify(records), before);
  }
});

test("guard fallback keeps claims from public human speech under the same publication boundary", async () => {
  const h = harness({ localGrounding: options(), client: { async complete() { return { text: "船と呼びましょう。" }; } } });
  const result = await h.run();
  assert.equal(h.dialogue.getAttempts()[0].generationGuard.fallback, true);
  assert.equal(result.privateState.graph.records.filter((r: any) => r.kind === "claim").length, 1);
  assert.equal(result.text, "なるほど、そう見えるんですね。");
});

test("a committed public AI naming proposal is staged as a prior claim before human classification", async () => {
  const local = options(); let seen!: LocalClassificationInput;
  local.extractor.extract = async () => [{ ...segment(ids[0], "うん"), aspect: "name", proposition: "船でよい", name: "船", respondsToTurn: 2 }];
  local.classifier.classify = async input => { seen = input; return [{ segmentId: "s1", act: "name_accept", respondsToClaimId: input.priorClaims[0]?.id ?? null, rawScore: 0 }]; };
  const h = harness({ localGrounding: local });
  const initial: any = h.initial;
  initial.judgments.push({ turnIndex: 1, judgment: { ...core, action: "propose_name", targetSlot: ids[0], candidateName: "船" } });
  const result = await h.run({ privateState: initial, events: [events[0], { id: "event-2", seq: 2, speaker: "ai", text: "船と呼ぶのはどうでしょう？" },
    { id: "event-3", seq: 3, speaker: "human", text: "うん" }] });
  assert.equal(seen.priorClaims[0].speaker, "ai");
  assert.equal(seen.priorClaims[0].sourceTurn, 2);
  assert.deepEqual(result.privateState.graph.records.filter((r: any) => r.kind === "claim").map((r: any) => r.act), ["name_propose", "name_accept"]);
  assert.deepEqual(initial.graph.records, [], "AI prior claim also stays detached until publication");
});

test("JSON durable restore round-trips claims and cannot enable an originally off trial", async () => {
  let saved: any;
  const h = harness(); const local = options();
  const args = { client: h.client, judge: h.judge, strategy: "repair-first", seed: 37, referenceMemory: true,
    runDir: "", localGrounding: local, onPersist: async (r: unknown) => { saved = JSON.parse(JSON.stringify(r)); } };
  const first = await createNamingTaskV2(args as any);
  first.message(utterance, "first"); await first.whenIdle();
  const before = first.researcherView().privateState;
  assert.equal(saved.options.localGrounding, true);
  const second = await createNamingTaskV2({ ...args, restore: saved } as any);
  assert.deepEqual(second.researcherView().privateState, before);
  second.message(utterance, "next"); await second.whenIdle();
  assert.equal(second.researcherView().privateState.graph.records.filter((r: any) => r.kind === "claim").length, 2);
  assert.ok(!JSON.stringify(second.getState()).includes("localGrounding"));
  assert.ok(!JSON.stringify(second.getState()).includes("claim"));
  const off = await createNamingTaskV2({ ...args, localGrounding: null } as any);
  await off.persistNow(); const offSaved = saved;
  const restoredOff = await createNamingTaskV2({ ...args, restore: offSaved } as any);
  restoredOff.message(utterance); await restoredOff.whenIdle();
  assert.equal(saved.options.localGrounding, undefined);
  assert.ok(restoredOff.researcherView().attempts.every((a: any) => a.localGrounding === undefined));
});

test("local publication checks reject echoes without treating ordinary utterances as private fields", () => {
  const instruction = "非公開の作業メモを引用せず、対話相手に向けた自然な発話だけを返してください。";
  const messages = [{ role: "system", content: instruction }];
  for (const text of ["四角い部分がある形ですね。", "名前はまだ決めずにお話しできますか？", "画像ではそう見えるんですね。",
    "ベアという呼び方はどうでしょう？", "Bearerという単語", "sk-は短い接頭辞です。", "api_keyという表記", "1:1の比率でしょうか？", "船っぽい形です。内側にくぼみもあります。"] ) {
    assert.deepEqual(findLocalPublicationViolations(text, messages), [], text);
  }
  assert.deepEqual(findLocalPublicationViolations("ownLedger s-ab12", messages), ["internal_id", "internal_field"]);
  assert.deepEqual(findLocalPublicationViolations("issueId 1:local1", messages), ["internal_field", "internal_id"]);
  assert.deepEqual(findLocalPublicationViolations("3:ai1", messages), ["internal_id"]);
  assert.ok(findLocalPublicationViolations("ｏｗｎＬｅｄｇｅｒ　ｓ－ａｂ１２", messages).includes("internal_id"));
  assert.deepEqual(findLocalPublicationViolations(instruction, messages), ["internal_prompt_echo"]);
  assert.deepEqual(findLocalPublicationViolations(instruction, [{ role: "user", content: instruction }]), [], "public history is not a private instruction");
  assert.deepEqual(findLocalPublicationViolations("短い公開文です。", [{ role: "system", content: "短い公開文です。" }]), [], "short coincidental phrases are not prompt echoes");
});

for (const [label, draft, expected] of [
  ["spaced internal tokens", "ownLedger s-ab12", "internal_field"],
  ["local issue tokens", "issueId 1:local1", "internal_field"],
  ["image URI", "data:image/png;base64,U1lOVEhFVElDX09OTFk=", "internal_image"],
  ["bearer", "Bearer synthetic-test-token-12345", "internal_credential"],
  ["key prefix", "sk-synthetic-test-key-12345", "internal_credential"],
  ["key assignment", "api_key=synthetic-test-key-12345", "internal_credential"],
] as const) {
  test(`opt-in publication guard rejects ${label} through rewrite and fallback`, async () => {
    const h = harness({ localGrounding: options(), client: { async complete() { return { text: draft }; } } });
    const result = await h.run();
    const guard = h.dialogue.getAttempts()[0].generationGuard;
    assert.ok(guard.violations.includes(expected));
    assert.equal(guard.regenerated, true); assert.equal(guard.fallback, true);
    assert.equal(result.text, "なるほど、そう見えるんですね。");
    assert.equal(result.privateState.graph.records.filter((r: any) => r.kind === "claim").length, 1);
    assert.ok(!JSON.stringify(h.dialogue.getAttempts()).includes(draft));
  });
}

test("private local instructions and rewrite instructions cannot be echoed into public speech", async () => {
  let calls = 0;
  const drafts: string[] = [];
  const h = harness({ localGrounding: options(), client: { async complete(messages: { role: string; content: unknown }[]) {
    const message = ++calls === 1 ? messages.find(m => typeof m.content === "string" && m.content.startsWith("局所問題の作業メモ"))! : messages.at(-1)!;
    const text = (message.content as string).split("\n")[0]; drafts.push(text); return { text };
  } } });
  const result = await h.run();
  const guard = h.dialogue.getAttempts()[0].generationGuard;
  assert.equal(guard.fallback, true); assert.ok(guard.violations.includes("internal_prompt_echo"));
  assert.equal(result.text, "なるほど、そう見えるんですね。");
  for (const draft of drafts) assert.ok(!JSON.stringify(h.dialogue.getAttempts()).includes(draft));
});

test("safe regeneration after a local leak keeps the model's ordinary public response", async () => {
  let calls = 0;
  const h = harness({ localGrounding: options(), client: { async complete() {
    return { text: ++calls === 1 ? "ownLedger s-ab12" : "四角い部分がある形ですね。" };
  } } });
  const result = await h.run();
  assert.equal(result.text, "四角い部分がある形ですね。");
  assert.equal(h.dialogue.getAttempts()[0].generationGuard.fallback, false);
});

test("local checks revalidate dynamic fallback names and features before publication", async () => {
  for (const [action, field] of [["propose_name", "candidateName"], ["confirm", "discriminatingFeature"]] as const) {
    for (const value of ["Bearer synthetic-test-token-12345", "data:image/png;base64,AAA", "ownLedger s-ab12"]) {
      const h = harness({ localGrounding: options(),
        judge: { async judge() { return { ...core, action, targetSlot: ids[0], [field]: value }; } },
        client: { async complete() { return { text: "ownLedger s-ab12" }; } } });
      const result = await h.run();
      assert.ok(!result.text.includes(value));
      assert.deepEqual(findLocalPublicationViolations(result.text, []), []);
      assert.equal(result.text, action === "propose_name" ? "その名前の候補はどうでしょう？" : "どの形のことか、もう少し教えてもらえますか？");
    }
  }
});

test("off keeps the existing publication behavior for the known whitespace boundary case", async () => {
  const h = harness({ client: { async complete() { return { text: "ownLedger s-ab12" }; } } });
  const result = await h.run();
  assert.equal(result.text, "ownLedger s-ab12");
  assert.deepEqual(h.dialogue.getAttempts()[0].generationGuard.violations, []);
});

test("local extractor receives the judge's own image and pixel anchors as detached copies", async () => {
  const local = options(); let judgmentInput: any, extractionInput: any;
  local.extractor.extract = async input => {
    extractionInput = structuredClone(input);
    input.ownImage.base64 = "caller-mutation";
    input.ownAnchors[0].bbox.x = 999;
    return [segment(input.ownSlots[0])];
  };
  const h = harness({ localGrounding: local, judge: { async judge(input: unknown) { judgmentInput = structuredClone(input); return core; } } });
  await h.run();
  assert.deepEqual(extractionInput.ownImage, judgmentInput.image);
  assert.deepEqual(extractionInput.ownAnchors, judgmentInput.ownAnchors);
  assert.deepEqual(extractionInput.ownAnchors, anchors);
  assert.ok(!JSON.stringify(h.calls).includes("caller-mutation"));
  assert.equal(anchors[0].bbox.x, 0);
});

test("callback is off with the feature and adds no request, state or attempt bytes", async () => {
  const records: LocalGroundingResearchRecord[] = [];
  const baseline = harness(), h = harness({ onLocalGroundingTrace: (record: LocalGroundingResearchRecord) => records.push(record) });
  assert.deepEqual(await h.run(), await baseline.run());
  assert.deepEqual(h.calls, baseline.calls);
  assert.deepEqual(h.dialogue.getAttempts(), baseline.dialogue.getAttempts());
  assert.deepEqual(records, []);
  assert.throws(() => harness({ onLocalGroundingTrace: 1 }), /Invalid local grounding trace callback/);
});

test("private callback emits staged claims and settlement uses only installed judgments", async () => {
  const records: LocalGroundingResearchRecord[] = [];
  let during: LocalGroundingResearchRecord[] = [], queue: any;
  const h = harness({ localGrounding: options(), onLocalGroundingTrace: (record: LocalGroundingResearchRecord) => {
    records.push(record); during = settleLocalTraces(records, queue.getPrivateState());
  } });
  queue = createHumanMessageQueue({ runAiTurn: h.dialogue.runAiTurn, initialPrivateState: h.initial });
  queue.enqueue({ text: utterance }); await queue.whenIdle();
  assert.equal(records[0].status, "staged");
  assert.equal(during[0].status, "superseded", "a pre-publication candidate is not proof of a commit");
  const settled = settleLocalTraces(records, queue.getPrivateState());
  assert.equal(settled[0].status, "committed"); assert.equal(records[0].status, "staged", "settlement is pure");
  assert.equal(settled[0].attemptNumber, 1);
  assert.deepEqual(records[0].verification.accepted, ["1:local1"]);
  assert.equal(records[0].claims[0].sourceTurn, 1);
  assert.equal(records[0].extractor.segments[0].quote, utterance);
  assert.equal(records[0].extractor.segments[0].act, "assert");
  assert.ok(!Object.hasOwn(records[0].extractor, "errorCode"));
  assert.ok(!Object.hasOwn(records[0].classifier, "errorCode"));
  assert.ok(!Object.hasOwn(records[0].verification, "diagnostics"));
  assert.ok(!JSON.stringify(records).includes(image.base64));
  assert.ok(!JSON.stringify(h.dialogue.getAttempts()).includes("extractor"));
});

test("late queue supersede of a staged result is distinguished from the installed turn", async () => {
  const records: LocalGroundingResearchRecord[] = []; let queue: any;
  const h = harness({ localGrounding: options(), onLocalGroundingTrace: (record: LocalGroundingResearchRecord) => {
    records.push(record);
    if (record.turnIndex === 1) queue.enqueue({ text: "別の特徴です" });
  } });
  queue = createHumanMessageQueue({ runAiTurn: h.dialogue.runAiTurn, initialPrivateState: h.initial });
  queue.enqueue({ text: utterance }); await queue.whenIdle();
  assert.deepEqual(records.map(r => r.status), ["staged", "staged"]);
  assert.deepEqual(settleLocalTraces(records, queue.getPrivateState()).map(r => r.status), ["superseded", "committed"]);
  assert.equal(queue.getPrivateState().judgments.length, 1);
});

test("aborted generation keeps a private attempt record without certifying its claims", async () => {
  const records: LocalGroundingResearchRecord[] = [], entered = gate(), late = gate(); let calls = 0;
  const h = harness({ localGrounding: options(), onLocalGroundingTrace: (record: LocalGroundingResearchRecord) => records.push(record),
    client: { async complete() { if (++calls === 1) { entered.release(); await late.promise; } return { text: "なるほど。" }; } } });
  const queue = createHumanMessageQueue({ runAiTurn: h.dialogue.runAiTurn, initialPrivateState: h.initial });
  queue.enqueue({ text: utterance }); await entered.promise; queue.enqueue({ text: "別の特徴です" }); late.release(); await queue.whenIdle();
  assert.deepEqual(records.map(r => r.status), ["aborted", "staged"]);
  assert.deepEqual(settleLocalTraces(records, queue.getPrivateState()).map(r => r.status), ["aborted", "committed"]);
});

test("retry identity prevents a failed attempt with the same public event from becoming committed", async () => {
  const records: LocalGroundingResearchRecord[] = []; let calls = 0;
  const h = harness({ localGrounding: options(), onLocalGroundingTrace: (record: LocalGroundingResearchRecord) => records.push(record),
    client: { async complete() { if (++calls === 1) throw new Error("SYNTHETIC_PRIVATE_CANARY"); return { text: "なるほど。" }; } } });
  const queue = createHumanMessageQueue({ runAiTurn: h.dialogue.runAiTurn, initialPrivateState: h.initial });
  queue.enqueue({ text: utterance }); await queue.whenIdle(); await queue.retry();
  assert.deepEqual(records.map(r => r.attemptNumber), [1, 2]);
  assert.equal(records[0].turnIndex, records[1].turnIndex); assert.equal(records[0].lastEventId, records[1].lastEventId);
  assert.deepEqual(settleLocalTraces(records, queue.getPrivateState()).map(r => r.status), ["error", "committed"]);
  const wrongAttempt = { ...records[1], attemptNumber: 1 };
  assert.equal(settleLocalTraces([wrongAttempt], queue.getPrivateState())[0].status, "superseded");
  assert.ok(!JSON.stringify(records).includes("CANARY"));
});

test("callback failures and mutation cannot change the generated result or graph", async () => {
  const h = harness({ localGrounding: options(), onLocalGroundingTrace: async (record: LocalGroundingResearchRecord) => {
    record.claims.length = 0; throw new Error("SYNTHETIC_PRIVATE_CANARY");
  } });
  const result = await h.run(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.privateState.graph.records.filter((r: any) => r.kind === "claim").length, 1);
  assert.ok(!JSON.stringify(h.dialogue.getAttempts()).includes("CANARY"));
});

test("Jev trace uses current response evidence, allows dated snapshots, and drops unrelated fields", async () => {
  for (const model of ["typesafe/jev-1.14", "typesafe/jev-1.14-20261020", "SYNTHETIC_PRIVATE_CANARY"]) {
    const records: LocalGroundingResearchRecord[] = [], local = options(); let evidence: unknown = null;
    const classify = local.classifier.classify;
    Object.assign(local.classifier, { metadata: { classifierKind: "jev_local_test", model: "typesafe/jev-1.14", calibrated: false } });
    Object.defineProperty(local.classifier, "lastEvidence", { get: () => evidence });
    local.classifier.classify = async (input, opts) => {
      const verdicts = await classify(input, opts);
      evidence = { callIndex: 1, status: "ok", model, rawResponse: "SYNTHETIC_PRIVATE_CANARY", imageBody: image.base64 };
      return verdicts;
    };
    const h = harness({ localGrounding: local, onLocalGroundingTrace: (record: LocalGroundingResearchRecord) => records.push(record) }); await h.run();
    assert.equal(records[0].classifier.kind, "jev_local_test");
    assert.equal(records[0].classifier.model, model.startsWith("typesafe/") ? model : null);
    assert.equal(records[0].classifier.callIndex, 1);
    assert.equal(records[0].classifier.status, "ok");
    assert.ok(!JSON.stringify(records).includes("CANARY")); assert.ok(!JSON.stringify(records).includes(image.base64));
    assert.ok(!JSON.stringify(records).includes("rawScore"));
  }
});

test("stale Jev evidence is not attributed to a later classification", async () => {
  const records: LocalGroundingResearchRecord[] = [], local = options();
  Object.assign(local.classifier, { metadata: { classifierKind: "jev_local_test" },
    lastEvidence: { callIndex: 5, status: "ok", model: "typesafe/jev-1.14" } });
  const h = harness({ localGrounding: local, onLocalGroundingTrace: (record: LocalGroundingResearchRecord) => records.push(record) }); await h.run();
  assert.equal(records[0].classifier.model, null); assert.equal(records[0].classifier.callIndex, null);
  assert.equal(records[0].classifier.status, "error");
});

test("research projection redacts image bodies, credential shapes and known private instructions", async () => {
  const records: LocalGroundingResearchRecord[] = [], local = options();
  local.extractor.extract = async () => [image.base64, "Bearer synthetic-test-token-12345", LOCAL_EXTRACTION_INSTRUCTIONS.split("\n")[0]].map((proposition, index) => ({ ...segment(ids[0]), segmentId: `s${index + 1}`, proposition }));
  const h = harness({ localGrounding: local, onLocalGroundingTrace: (record: LocalGroundingResearchRecord) => records.push(record) }); await h.run();
  assert.equal(records[0].claims.length, 3);
  assert.ok(records[0].claims.every(claim => claim.redacted && claim.proposition === "[redacted]"));
  assert.ok(records[0].extractor.segments.every(s => s.redacted));
  assert.ok(!JSON.stringify(records).includes(image.base64)); assert.ok(!JSON.stringify(records).includes("Bearer"));
});

test("research separates public AI claims from human claims in verification order", async () => {
  const records: LocalGroundingResearchRecord[] = [], local = options();
  local.extractor.extract = async () => [{ ...segment(ids[0], "うん"), aspect: "name", proposition: "船でよい", name: "船", respondsToTurn: 2 }];
  local.classifier.classify = async input => [{ segmentId: "s1", act: "name_accept", respondsToClaimId: input.priorClaims[0].id, rawScore: null }];
  const h = harness({ localGrounding: local, onLocalGroundingTrace: (record: LocalGroundingResearchRecord) => records.push(record) });
  (h.initial.judgments as any[]).push({ turnIndex: 1, judgment: { ...core, action: "propose_name", targetSlot: ids[0], candidateName: "船" } });
  await h.run({ events: [events[0], { id: "event-2", seq: 2, speaker: "ai", text: "船と呼ぶのはどうでしょう？" },
    { id: "event-3", seq: 3, speaker: "human", text: "うん" }], lastEventId: "event-3" });
  assert.deepEqual(records[0].aiClaims.map(c => c.id), ["3:ai1"]);
  assert.deepEqual(records[0].claims.map(c => c.id), ["3:local1"]);
  assert.deepEqual(records[0].verification.accepted, ["3:ai1", "3:local1"]);
  assert.equal(records[0].aiClaims[0].sourceTurn, 2);
  assert.equal(records[0].claims[0].respondsTo, "3:ai1");
});

test("committed fallback turns produce no AI claims, while ordinary and rewritten turns do", async () => {
  for (const publication of ["ordinary", "rewritten", "fallback"]) {
    const records: LocalGroundingResearchRecord[] = [], local = options(); let generations = 0, judgments = 0;
    local.extractor.extract = async () => [];
    const publicText = "「船」と呼ぶのはどうでしょう？四角い部分があります。";
    const h = harness({ localGrounding: local, onLocalGroundingTrace: (record: LocalGroundingResearchRecord) => records.push(record),
      judge: { async judge() { return ++judgments === 1 ? { ...core, action: "propose_name", targetSlot: ids[0], candidateName: "船", discriminatingFeature: "四角い部分" } : core; } },
      client: { async complete() {
        generations++;
        const unsafe = publication === "fallback" && generations <= 2 || publication === "rewritten" && generations === 1;
        return { text: unsafe ? "ownLedger s-ab12" : publicText };
      } } });
    const first = await h.run();
    assert.equal(first.privateState.judgments[0].generationGuard.fallback, publication === "fallback");
    assert.equal(first.privateState.judgments[0].generationGuard.regenerated, publication !== "ordinary");
    const second = await h.run({ privateState: first.privateState, events: [events[0],
      { id: "event-2", seq: 2, speaker: "ai", text: first.text },
      { id: "event-3", seq: 3, speaker: "human", text: "うん" }], lastEventId: "event-3" });
    assert.equal(records[1].aiClaims.length, publication === "fallback" ? 0 : 1);
    assert.equal(second.privateState.graph.records.filter((r: any) => r.kind === "claim" && r.speaker === "ai").length, publication === "fallback" ? 0 : 1);
    // Public text expresses the feature, but this slice has no public-text feature extraction; coverage is not demonstrated.
    assert.equal(records[1].aiClaims.filter(c => c.aspect === "part").length, 0);
    const installed = second.privateState.graph.records.filter((r: any) => r.kind === "claim" && r.speaker === "ai");
    assert.equal(installed.filter((r: any) => r.aspect === "part").length, 0);
    if (publication !== "fallback") {
      for (const claim of [records[1].aiClaims[0], installed[0]]) {
        assert.equal(claim.aspect, "name"); assert.equal(claim.act, "name_propose"); assert.equal(claim.name, "船");
        assert.equal(claim.sourceTurn, 2); assert.equal(claim.id, "3:ai1");
      }
    }
    assert.equal(records[1].verification.rejected.some(r => r.reason === "ai_fallback_utterance"), publication === "fallback");
  }
});

test("issue-link overrides are private diagnostics and do not inflate rejections", async () => {
  for (const linkedIssueId of ["1:missing", "SYNTHETIC_PRIVATE_CANARY"]) {
    const records: LocalGroundingResearchRecord[] = [], local = options();
    local.extractor.extract = async () => [{ ...segment(ids[0], "うん"), segmentId: "SYNTHETIC_PRIVATE_CANARY",
      aspect: "name", proposition: "船でよい", name: "船", respondsToTurn: 2, linkedIssueId }];
    local.classifier.classify = async input => [{ segmentId: input.segments[0].segmentId, act: "name_accept", respondsToClaimId: input.priorClaims[0].id, rawScore: null }];
    const h = harness({ localGrounding: local, onLocalGroundingTrace: (record: LocalGroundingResearchRecord) => records.push(record) });
    (h.initial.judgments as any[]).push({ turnIndex: 1, judgment: { ...core, action: "propose_name", targetSlot: ids[0], candidateName: "船" } });
    const result = await h.run({ events: [events[0], { id: "event-2", seq: 2, speaker: "ai", text: "船と呼ぶのはどうでしょう？" },
      { id: "event-3", seq: 3, speaker: "human", text: "うん" }], lastEventId: "event-3" });
    assert.deepEqual(records[0].verification.accepted, ["3:ai1", "3:local1"]);
    assert.deepEqual(records[0].verification.rejected, []);
    assert.deepEqual(records[0].verification.diagnostics, [{ segmentId: "segment_1", reason: "issue_link_overridden",
      linkedIssueId: linkedIssueId === "1:missing" ? linkedIssueId : null, resolvedIssueId: "3:ai1" }]);
    assert.deepEqual(settleLocalTraces(records, result.privateState)[0].verification, records[0].verification);
    assert.equal(h.dialogue.getAttempts()[0].localGrounding.rejected.length, 0);
    assert.ok(!JSON.stringify({ records, attempts: h.dialogue.getAttempts() }).includes("CANARY"));
  }
});

test("naming task callback and durable request identity survive restore without public trace exposure", async () => {
  let saved: any;
  const records: LocalGroundingResearchRecord[] = [], h = harness();
  const args = { client: h.client, judge: h.judge, strategy: "repair-first", seed: 41, referenceMemory: true, runDir: "",
    localGrounding: options(), onLocalGroundingTrace: (record: LocalGroundingResearchRecord) => records.push(record),
    onPersist: async (record: unknown) => { saved = JSON.parse(JSON.stringify(record)); } };
  const first = await createNamingTaskV2(args as any);
  first.message(utterance); await first.whenIdle();
  const restored = await createNamingTaskV2({ ...args, restore: saved } as any);
  restored.message(utterance); await restored.whenIdle();
  assert.deepEqual(records.map(r => r.attemptNumber), [1, 2]);
  assert.deepEqual(settleLocalTraces(records, restored.researcherView().privateState).map(r => r.status), ["committed", "committed"]);
  assert.ok(!JSON.stringify(restored.getState()).includes("extractor"));
  assert.ok(!JSON.stringify(saved).includes('"extractor"'), "detailed records leave only through the requested private callback");
});

test("untrusted extraction identifiers and extra response fields never enter the private trace", async () => {
  const records: LocalGroundingResearchRecord[] = [], local = options();
  local.extractor.extract = async () => [{ ...segment(ids[0]),
    segmentId: { key: "SYNTHETIC_PRIVATE_CANARY", imageBody: image.base64 }, rawResponse: "SYNTHETIC_PRIVATE_CANARY" } as any];
  const h = harness({ localGrounding: local, onLocalGroundingTrace: (record: LocalGroundingResearchRecord) => records.push(record) }); await h.run();
  assert.equal(typeof records[0].extractor.segments[0].segmentId, "string");
  assert.equal(records[0].verification.accepted.length, 0);
  assert.equal(records[0].verification.rejected.length, 1);
  assert.ok(!JSON.stringify(records).includes("CANARY")); assert.ok(!JSON.stringify(records).includes(image.base64));
});
