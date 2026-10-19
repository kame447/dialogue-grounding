// Synthetic public text and mock clients only; never contact an external model.
import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { createLunaLocalExtractor, buildLocalExtractionMessages, parseLocalExtraction, LocalExtractionError,
  LOCAL_EXTRACTION_INSTRUCTIONS } from "../dialogue-model/runtime/local-grounding/extract.ts";
import { createMockLocalExtractor, LocalMockError } from "../dialogue-model/runtime/local-grounding/mocks.ts";
import { ownImageMessage } from "../dialogue-model/runtime/judgment/instructions.mjs";
import { createTrialV2, modelView } from "../dialogue-model/runtime/stimuli/scatter-v2.mjs";
import type { LocalExtractionInput, LocalOwnAnchor, LocalSegmentProposal } from "../dialogue-model/runtime/local-grounding/contract.ts";

const input: LocalExtractionInput = { turn: 3, ownSlots: ["own-a", "own-b"], issueSummary: "向きが未確認",
  ownImage: { mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTbkAAAAASUVORK5CYII=" },
  ownAnchors: [{ id: "own-a", bbox: { x: 10, y: 20, w: 100, h: 80 }, centroid: { x: 55, y: 65 } },
    { id: "own-b", bbox: { x: 180, y: 100, w: 80, h: 100 }, centroid: { x: 220, y: 160 } }],
  publicTurns: [{ turn: 1, speaker: "human", text: "船みたいですね" }, { turn: 2, speaker: "ai", text: "四角い部分がありますか" },
    { turn: 3, speaker: "human", text: "四角はあります。でも三角は下です。船と呼ぼう" }] };
const segment: LocalSegmentProposal = { segmentId: "s1", quote: "四角はあります", targets: ["own-a"], aspect: "part",
  proposition: "四角い部分がある", name: null, linkedIssueId: null, respondsToTurn: 2 };
const code = (wanted: string) => (error: unknown) => error instanceof LocalExtractionError && error.code === wanted;

test("extracts independent clauses with literal quotes and no state promotion", async () => {
  const proposals: LocalSegmentProposal[] = [segment,
    { ...segment, segmentId: "s2", quote: "三角は下です", aspect: "orientation", proposition: "三角が下にある", respondsToTurn: null },
    { ...segment, segmentId: "s3", quote: "船と呼ぼう", aspect: "name", proposition: "船という名前を提案", name: "船", targets: [] }];
  const calls: unknown[] = [];
  const extractor = createLunaLocalExtractor({ async complete(messages, options) {
    calls.push({ messages, phase: options.phase, timeoutMs: options.timeoutMs, aborted: options.signal.aborted });
    return { text: JSON.stringify(proposals) };
  } }, { timeoutMs: 3210 });
  assert.deepEqual(await extractor.extract(input), proposals);
  assert.equal((calls[0] as { phase: string }).phase, "local_extraction");
  assert.equal((calls[0] as { timeoutMs: number }).timeoutMs, 3210);
  assert.match(LOCAL_EXTRACTION_INSTRUCTIONS, /construal/);
  assert.match(LOCAL_EXTRACTION_INSTRUCTIONS, /相槌だけを合意と見なさず/);
  assert.match(LOCAL_EXTRACTION_INSTRUCTIONS, /targets: \[\]/);
});

test("both strategies produce byte-identical requests; only whitelisted present-time public fields are forwarded", async () => {
  const requests: string[] = [];
  const extractor = createLunaLocalExtractor({ async complete(messages) { requests.push(JSON.stringify(messages)); return { text: "[]" }; } });
  for (const strategy of ["repair-first", "bypass-enabled"]) {
    await extractor.extract({ ...input, strategy, gold: "GOLD_CANARY", partnerImage: "PARTNER_CANARY", future: "FUTURE_CANARY",
      publicTurns: [...input.publicTurns.map((t) => ({ ...t, gold: "GOLD_CANARY" })), { turn: 4, speaker: "ai", text: "FUTURE_CANARY" },
        { turn: 3, speaker: "ai", text: "UNPUBLISHED_CANARY" }] } as LocalExtractionInput);
  }
  assert.equal(requests[0], requests[1]);
  assert.doesNotMatch(requests[0], /CANARY|repair-first|bypass-enabled|strategy/);
  assert.deepEqual(Object.keys(JSON.parse(buildLocalExtractionMessages(input)[1].content)), ["turn", "publicTurns", "ownSlots", "issueSummary", "ownAnchors"]);
});

test("extractor receives the same multimodal own-image format as the v2 judge and matching pixel anchors", async () => {
  const messages = buildLocalExtractionMessages(input);
  assert.deepEqual(messages.slice(2), ownImageMessage(input.ownImage));
  const context = JSON.parse(messages[1].content);
  assert.deepEqual(context.ownAnchors, input.ownAnchors);
  assert.deepEqual(context.ownAnchors.map((a: { id: string }) => a.id), input.ownSlots);
  assert.equal(Object.hasOwn(context, "ownImage"), false);
  assert.doesNotMatch(messages[1].content, /base64|image_url/);
  assert.match(LOCAL_EXTRACTION_INSTRUCTIONS, /ピクセル座標/);
  assert.match(LOCAL_EXTRACTION_INSTRUCTIONS, /画像上の根拠/);
  assert.match(LOCAL_EXTRACTION_INSTRUCTIONS, /slot IDや名前だけで推測しない/);
  let calls = 0;
  const extractor = createLunaLocalExtractor({ async complete(sent) {
    calls++; assert.deepEqual(sent, messages); return { text: JSON.stringify([segment]) };
  } });
  assert.deepEqual(await extractor.extract(input), [segment]); assert.equal(calls, 1);
});

test("own image and anchor extensions are projected rather than forwarding partner data or gold", () => {
  const decorated = { ...input,
    ownImage: { ...input.ownImage, partnerImage: "PARTNER_CANARY" },
    ownAnchors: input.ownAnchors.map(a => ({ ...a, gold: "GOLD_CANARY", bbox: { ...a.bbox, answer: "ANSWER_CANARY" },
      centroid: { ...a.centroid, partner: "PARTNER_CANARY" } })),
  };
  const messages = buildLocalExtractionMessages(decorated);
  assert.doesNotMatch(JSON.stringify(messages), /CANARY/);
  assert.deepEqual(JSON.parse(messages[1].content).ownAnchors, input.ownAnchors);
});

test("the existing v2 model projection supplies compatible own image and pixel anchors", () => {
  const view = modelView(createTrialV2({ seed: 9 }));
  const own: LocalExtractionInput = { ...input, ownSlots: view.anchors.map((a: LocalOwnAnchor) => a.id), ownAnchors: view.anchors,
    ownImage: { mimeType: "image/png", base64: view.png.toString("base64") } };
  const messages = buildLocalExtractionMessages(own);
  assert.deepEqual(messages.slice(2), ownImageMessage(own.ownImage));
  assert.deepEqual(JSON.parse(messages[1].content).ownAnchors, view.anchors);
  assert.equal(JSON.stringify(messages).includes("figureId"), false);
  assert.equal(JSON.stringify(messages).includes('"key"'), false);
});

test("invalid JSON and envelope, unknown keys, and out-of-set aspects are rejected with typed errors", () => {
  for (const raw of ["```json\n[]\n```", "[{SECRET_RAW", ""]) assert.throws(() => parseLocalExtraction(raw, input), code("invalid_json"));
  for (const value of [{ segments: [] }, null, [{ ...segment, gold: "SECRET_RAW" }], [{ ...segment, aspect: "agree" }],
    [{ ...segment, targets: ["partner-a"] }], [{ ...segment, targets: ["own-a", "own-a"] }], [{ ...segment, name: "船" }],
    [{ ...segment, respondsToTurn: 3 }], [{ ...segment, respondsToTurn: 999 }], [{ ...segment, respondsToTurn: -1 }],
    [{ ...segment, linkedIssueId: false }], [{ ...segment, name: undefined }]]) {
    assert.throws(() => parseLocalExtraction(JSON.stringify(value), input), code("invalid_response"));
  }
});

test("quotes must be literal current-turn spans, and duplicate ids reject the entire extraction", () => {
  for (const quote of ["船みたいですね", "四角があります", "三角は上です"]) {
    assert.throws(() => parseLocalExtraction(JSON.stringify([{ ...segment, quote }]), input), code("invalid_quote"));
  }
  assert.throws(() => parseLocalExtraction(JSON.stringify([segment, segment]), input), code("duplicate_segment"));
});

test("relocates equivalent quote spelling to the original literal span", () => {
  const variation: LocalExtractionInput = { ...input, publicTurns: [{ turn: 3, speaker: "human", text: "ＡＢＣ の トリ ですね" }] };
  const quoted = { ...segment, quote: "abcのとり", respondsToTurn: null };
  assert.deepEqual(parseLocalExtraction(JSON.stringify([quoted]), variation), [{ ...quoted, quote: "ＡＢＣ の トリ" }]);
});

test("an unlocatable quote drops only that segment and diagnostics contain counts and fixed reasons", async () => {
  const raw = JSON.stringify([segment, { ...segment, segmentId: "bad", quote: "RAW_SECRET_CANARY" }]);
  const extractor = createLunaLocalExtractor({ async complete() { return { text: raw }; } });
  assert.deepEqual(await extractor.extract(input), [segment]);
  assert.deepEqual(extractor.lastDiagnostics, { rejectedSegments: 1, reasons: ["quote_not_found"] });
  const mutable = extractor.lastDiagnostics;
  mutable.reasons.length = 0;
  assert.deepEqual(extractor.lastDiagnostics.reasons, ["quote_not_found"]);
  assert.doesNotMatch(JSON.stringify(extractor.lastDiagnostics), /RAW_SECRET_CANARY|bad|quote.*RAW/);
});

test("all-invalid quotes still raise a typed error; legitimate [] remains distinguishable", async () => {
  let raw = JSON.stringify([{ ...segment, quote: "RAW_SECRET_CANARY" }]);
  const extractor = createLunaLocalExtractor({ async complete() { return { text: raw }; } });
  await assert.rejects(extractor.extract(input), code("invalid_quote"));
  assert.deepEqual(extractor.lastDiagnostics, { rejectedSegments: 1, reasons: ["quote_not_found"] });
  raw = "[]";
  assert.deepEqual(await extractor.extract(input), []);
  assert.deepEqual(extractor.lastDiagnostics, { rejectedSegments: 0, reasons: [] });
});

test("a normalized quote cannot bypass the original literal-span length budget", async () => {
  const long: LocalExtractionInput = { ...input, publicTurns: [{ turn: 3, speaker: "human", text: "三" + " ".repeat(200) + "角" }] };
  const extractor = createLunaLocalExtractor({ async complete() { return { text: JSON.stringify([{ ...segment, quote: "三角", respondsToTurn: null }]) }; } });
  await assert.rejects(extractor.extract(long), code("invalid_quote"));
  assert.deepEqual(extractor.lastDiagnostics, { rejectedSegments: 1, reasons: ["quote_span_too_long"] });
});

test("all output length budgets are enforced without truncating evidence", () => {
  for (const patch of [{ segmentId: "s".repeat(65) }, { quote: "四".repeat(161) }, { proposition: "形".repeat(161) },
    { aspect: "name", name: "名".repeat(81) }, { linkedIssueId: "i".repeat(129) }]) {
    assert.throws(() => parseLocalExtraction(JSON.stringify([{ ...segment, ...patch }]), input), code("invalid_response"));
  }
  assert.throws(() => parseLocalExtraction(JSON.stringify(Array.from({ length: 33 }, (_, i) => ({ ...segment, segmentId: `s${i}` }))), input), code("invalid_response"));
  assert.throws(() => parseLocalExtraction(" ".repeat(48001), input), code("invalid_response"));
});

test("invalid or ambiguous inputs fail before calling the client", async () => {
  let calls = 0;
  const extractor = createLunaLocalExtractor({ async complete() { calls++; return { text: "[]" }; } });
  for (const value of [{ ...input, turn: 0 }, { ...input, publicTurns: [] }, { ...input, ownSlots: ["a", "a"] },
    { ...input, issueSummary: "x".repeat(12001) }, { ...input, publicTurns: [...input.publicTurns, input.publicTurns[2]] }]) {
    await assert.rejects(extractor.extract(value), code("invalid_input"));
  }
  assert.equal(calls, 0);
  assert.throws(() => createLunaLocalExtractor({ complete: async () => ({ text: "[]" }) }, { timeoutMs: 0 }), code("invalid_input"));
});

test("missing or malformed images and inconsistent anchors fail closed before any model call", async () => {
  let calls = 0;
  const extractor = createLunaLocalExtractor({ async complete() { calls++; return { text: "[]" }; } });
  const badImages: unknown[] = [undefined, null, {}, { mimeType: "image/svg+xml", base64: input.ownImage.base64 },
    { mimeType: "image/png", base64: "" }, { mimeType: "image/png", base64: "not base64!" },
    { mimeType: "image/png", base64: "data:image/png;base64,AAAA" }, { mimeType: "image/png", base64: "AAA" },
    { mimeType: "image/png", base64: "A===" }];
  const first = input.ownAnchors[0], second = input.ownAnchors[1];
  const badAnchors: unknown[] = [undefined, null, [], [first], [first, first], [first, { ...second, id: "partner-a" }],
    [first, { ...second, bbox: { x: 1, y: 1, width: 1, height: 1 } }],
    [first, { ...second, bbox: { ...second.bbox, w: 0 } }], [first, { ...second, centroid: { x: NaN, y: 100 } }],
    [first, { ...second, bbox: { ...second.bbox, x: -1 } }], [first, { ...second, bbox: { ...second.bbox, h: Infinity } }],
    [first, { ...second, centroid: { x: 999, y: 100 } }]];
  for (const ownImage of badImages) await assert.rejects(extractor.extract({ ...input, ownImage } as LocalExtractionInput), code("invalid_input"));
  for (const ownAnchors of badAnchors) await assert.rejects(extractor.extract({ ...input, ownAnchors } as LocalExtractionInput), code("invalid_input"));
  assert.equal(calls, 0);
});

test("own image bodies never appear in errors or diagnostics, even if a provider echoes them", async () => {
  for (const complete of [async () => { throw new Error(input.ownImage.base64); },
    async () => ({ text: input.ownImage.base64 }), async () => ({ text: JSON.stringify([{ ...segment, quote: input.ownImage.base64 }]) })]) {
    const extractor = createLunaLocalExtractor({ complete });
    await assert.rejects(extractor.extract(input), (error: unknown) => {
      assert.ok(error instanceof LocalExtractionError);
      assert.ok(!inspect(error, { showHidden: true }).includes(input.ownImage.base64));
      return true;
    });
    assert.ok(!JSON.stringify(extractor.lastDiagnostics).includes(input.ownImage.base64));
  }
});

test("timeout and caller abort settle even for a client ignoring signal; pre-abort never calls it", async () => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  const extractor = createLunaLocalExtractor({ complete(_m, options) { calls++; signal = options.signal; return new Promise(() => {}); } });
  await assert.rejects(extractor.extract(input, { timeoutMs: 10 }), code("timeout"));
  assert.equal(signal?.aborted, true);
  const controller = new AbortController();
  const pending = extractor.extract(input, { signal: controller.signal });
  await Promise.resolve();
  controller.abort("SECRET_ABORT_REASON");
  await assert.rejects(pending, code("aborted"));
  assert.equal(signal?.aborted, true);
  await assert.rejects(extractor.extract(input, { signal: controller.signal }), code("aborted"));
  assert.equal(calls, 2);
});

test("provider errors, prompts, raw output and abort reasons never appear in errors", async () => {
  for (const complete of [async () => { throw Object.assign(new Error("sk-secret PROMPT_CANARY RAW_CANARY"), { code: "SECRET_CODE", cause: "RAW_CANARY" }); },
    async () => ({ text: "PROMPT_CANARY sk-secret RAW_CANARY" })]) {
    const extractor = createLunaLocalExtractor({ complete });
    await assert.rejects(extractor.extract(input), (e: unknown) => {
      assert.ok(e instanceof LocalExtractionError);
      assert.doesNotMatch(inspect(e, { showHidden: true }) + JSON.stringify(e), /sk-secret|CANARY|SECRET_CODE/);
      assert.equal(Object.hasOwn(e, "cause"), false);
      return true;
    });
  }
  const forged = Object.assign(new LocalExtractionError("invalid_response"), { code: "sk-secret", prompt: "PROMPT_CANARY" });
  await assert.rejects(createLunaLocalExtractor({ async complete() { throw forged; } }).extract(input), (e: unknown) => {
    assert.ok(e instanceof LocalExtractionError);
    assert.equal(e.code, "unavailable");
    assert.doesNotMatch(inspect(e), /sk-secret|CANARY/);
    return true;
  });
  await assert.rejects(createLunaLocalExtractor({ async complete() { throw { code: "timeout", raw: "RAW_CANARY" }; } }).extract(input), code("timeout"));
});

test("provenance snapshot remains stable when the caller mutates input during extraction", async () => {
  const mutable = structuredClone(input);
  const extractor = createLunaLocalExtractor({ async complete() {
    mutable.publicTurns[2].text = "別の発話";
    mutable.ownImage.base64 = "CHANGED_IMAGE";
    mutable.ownAnchors[0].id = "CHANGED_ANCHOR";
    mutable.ownAnchors[0].bbox.x = 9999;
    return { text: JSON.stringify([segment]) };
  } });
  assert.deepEqual(await extractor.extract(mutable), [segment]);
});

test("extractor mock is deterministic and simulates delay, timeout, abort and sanitized failure", async () => {
  const indexes: number[] = [];
  const mock = createMockLocalExtractor((_input, options) => { indexes.push(options.callIndex); return [segment]; }, { delayMs: 1 });
  const first = await mock.extract(input);
  first[0].quote = "mutated";
  assert.deepEqual(await mock.extract(input), [segment]);
  assert.deepEqual(indexes, [0, 1]);
  const slow = createMockLocalExtractor(() => [segment], { delayMs: 50 });
  await assert.rejects(slow.extract(input, { timeoutMs: 5 }), (e: unknown) => e instanceof LocalMockError && e.code === "timeout");
  const controller = new AbortController();
  const pending = slow.extract(input, { signal: controller.signal });
  controller.abort("sk-secret");
  await assert.rejects(pending, (e: unknown) => e instanceof LocalMockError && e.code === "aborted");
  await assert.rejects(createMockLocalExtractor(() => { throw new Error("sk-secret"); }).extract(input),
    (e: unknown) => e instanceof LocalMockError && e.code === "mock_failure" && !inspect(e).includes("sk-secret"));
});
