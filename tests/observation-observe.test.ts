// Synthetic own-side anchors and mock clients only; no real API or answer table.
import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { createLunaObserver, buildObservationMessages, buildReobservationMessages, parseInitialObservation,
  parseReobservation, mergeReobservation, validateObservationMemo, ObservationError, OBSERVATION_LIMITS,
  OBSERVATION_INITIAL_INSTRUCTIONS, observationContextMessages } from "../dialogue-model/runtime/observation/observe.ts";
import { createMockObserver } from "../dialogue-model/runtime/observation/mocks.ts";
import type { ObservationInput, ObservationIssue, ObservationMemo, ReobservationInput, ReobservationResult } from "../dialogue-model/runtime/observation/contract.ts";
import { ownImageMessage } from "../dialogue-model/runtime/judgment/instructions.mjs";

const initialTime = "2026-10-20T00:00:00.000Z";
const laterTime = "2026-10-20T00:01:00.000Z";
const input: ObservationInput = {
  ownImage: { mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTbkAAAAASUVORK5CYII=" },
  ownAnchors: Array.from({ length: 6 }, (_, i) => ({ id: `own-${i + 1}`, bbox: { x: i * 110, y: 10, w: 100, h: 80 }, centroid: { x: i * 110 + 50, y: 50 } })),
};
const initial = () => ({ figures: input.ownAnchors.map(a => ({ id: a.id,
  holistic: [{ construal: "馬のような全体", basis: ["上端の細い突起が首に見える"], status: "hypothesis" }],
  analytic: { shapes: ["三角の部分", "四角の部分"], composition: "四角に細い三角が接する", relations: ["三角が四角の一辺に接する"] },
  unknowns: ["重なりの境界は不明"] })) });
const memo = () => parseInitialObservation(JSON.stringify(initial()), input, { observedAt: initialTime });
const issue: ObservationIssue = { aspect: "construal", question: "牛の見立てを支える部分と反証はあるか", partnerConstrual: "牛" };
const targeted = (m = memo()): ReobservationInput => ({ ...input, memo: m, figureIds: ["own-2"], issue });
const evidence = () => ({ figures: [{ figureId: "own-2", supports: ["頭に見える部分に二つの突起がある"],
  contradicts: ["脚に見える部分は一つしか見えない"], unknown: ["突起が角か耳かは不明"] }] });
const reobserved = (): ReobservationResult => parseReobservation(JSON.stringify(evidence()), targeted(), { observedAt: laterTime });
const code = (wanted: string) => (error: unknown) => error instanceof ObservationError && error.code === wanted && error.message === wanted;

test("one initial call observes all six own figures; regions and timestamps are program-owned", async () => {
  const calls: string[] = [];
  const observer = createLunaObserver({ async complete(messages, options) {
    calls.push(options.phase);
    assert.equal(options.timeoutMs, 3210); assert.equal(options.signal.aborted, false);
    assert.deepEqual(messages.slice(2), ownImageMessage(input.ownImage));
    assert.deepEqual(JSON.parse(messages[1].content as string), { ownAnchors: input.ownAnchors });
    return { text: JSON.stringify({ figures: initial().figures.reverse() }) };
  } }, { timeoutMs: 3210, now: () => new Date(initialTime) });
  const result = await observer.observeAll(input);
  assert.deepEqual(calls, ["observation_initial"]);
  assert.equal(result.observedAt, initialTime);
  assert.deepEqual(result.figures.map(f => [f.id, f.region]), input.ownAnchors.map(a => [a.id, a.bbox]));
  assert.ok(result.figures.every(f => f.holistic[0].status === "hypothesis" && f.reobservations.length === 0));
  assert.equal(Object.hasOwn(result.figures[0], "name"), false);
  assert.equal(Object.hasOwn(result.figures[0], "action"), false);
  assert.doesNotMatch(JSON.stringify(result), /base64|image_url/);
  assert.match(OBSERVATION_INITIAL_INSTRUCTIONS, /唯一の正解・確定名称と扱わない/);
});

test("observation inputs project only own image and anchors, identically across strategies", () => {
  const requests = ["repair-first", "bypass-enabled"].map(strategy => buildObservationMessages({ ...input, strategy,
    partnerImage: "PARTNER_CANARY", gold: "GOLD_CANARY", future: "FUTURE_CANARY",
    ownImage: { ...input.ownImage, gold: "IMAGE_CANARY" },
    ownAnchors: input.ownAnchors.map(a => ({ ...a, name: "LABEL_CANARY", partnerSlot: "PAIR_CANARY" })),
  } as ObservationInput));
  assert.equal(JSON.stringify(requests[0]), JSON.stringify(requests[1]));
  assert.doesNotMatch(JSON.stringify(requests), /CANARY|repair-first|bypass-enabled/);
  assert.equal(JSON.stringify(requests[0]).split(input.ownImage.base64).length - 1, 1);
});

test("targeted observation receives only requested textual figures and returns support, counterevidence and unknowns", async () => {
  const before = memo(); const saved = structuredClone(before);
  const observer = createLunaObserver({ async complete(messages, options) {
    assert.equal(options.phase, "observation_targeted");
    const context = JSON.parse(messages[1].content as string);
    assert.deepEqual(context.figureIds, ["own-2"]); assert.deepEqual(context.issue, issue);
    assert.deepEqual(context.figures.map((f: { id: string }) => f.id), ["own-2"]);
    assert.deepEqual(context.ownAnchors.map((a: { id: string }) => a.id), ["own-2"]);
    assert.deepEqual(messages.slice(2), ownImageMessage(input.ownImage));
    assert.match(messages[0].content as string, /迎合せず/); assert.match(messages[0].content as string, /正解ではありません/);
    return { text: JSON.stringify(evidence()) };
  } }, { now: () => new Date(laterTime) });
  const result = await observer.reobserve(targeted(before));
  assert.equal(result.observedAt, laterTime); assert.deepEqual(result.issue, issue);
  assert.deepEqual(result.figures, evidence().figures); assert.deepEqual(before, saved);
  const after = mergeReobservation(before, result);
  assert.deepEqual(before, saved); assert.equal(after.observedAt, initialTime);
  for (const [index, f] of after.figures.entries()) {
    if (f.id !== "own-2") assert.deepEqual(f, saved.figures[index]);
    else {
      const { reobservations, ...initialFields } = f;
      const { reobservations: _empty, ...original } = saved.figures[index];
      assert.deepEqual(initialFields, original);
      assert.deepEqual(reobservations, [{ ...result.figures[0], observedAt: laterTime, issue }]);
    }
  }
  result.figures[0].supports[0] = "mutated";
  assert.notEqual(after.figures[1].reobservations[0].supports[0], "mutated");
});

test("strict initial JSON rejects unknown keys, invented or duplicate IDs, nonhypotheses and oversized descriptions", () => {
  const mutations: Array<(value: ReturnType<typeof initial>) => void> = [
    v => { (v as unknown as Record<string, unknown>).gold = "CANARY"; },
    v => { (v.figures[0] as unknown as Record<string, unknown>).region = input.ownAnchors[0].bbox; },
    v => { v.figures[0].id = "partner-only"; }, v => { v.figures[0].id = v.figures[1].id; },
    v => { v.figures.pop(); }, v => { v.figures[0].holistic[0].status = "agreed"; },
    v => { v.figures[0].holistic[0].basis = []; },
    v => { (v.figures[0].analytic as unknown as Record<string, unknown>).name = "確定名"; },
    v => { v.figures[0].analytic.shapes = ["形".repeat(241)]; },
    v => { v.figures[0].unknowns = Array(17).fill("不明"); },
    v => { v.figures[0].analytic.composition = " "; },
  ];
  for (const mutate of mutations) {
    const value = initial(); mutate(value);
    assert.throws(() => parseInitialObservation(JSON.stringify(value), input, { observedAt: initialTime }), code("invalid_response"));
  }
  for (const raw of ["```json\n{}\n```", "not json"]) assert.throws(() => parseInitialObservation(raw, input, { observedAt: initialTime }), code("invalid_json"));
  assert.throws(() => parseInitialObservation(" ".repeat(48001), input, { observedAt: initialTime }), code("invalid_response"));
});

test("initial observations may remain unknown and have multiple tentative construals", () => {
  const value = initial();
  value.figures[0].holistic = [];
  value.figures[0].analytic = { shapes: [], composition: "境界は確認できない", relations: [] };
  value.figures[1].holistic.push({ construal: "牛のような全体", basis: ["上端の突起が角にも見える"], status: "hypothesis" });
  const result = parseInitialObservation(JSON.stringify(value), input, { observedAt: initialTime });
  assert.deepEqual(result.figures[0].holistic, []); assert.equal(result.figures[1].holistic.length, 2);
  assert.ok(result.figures[1].holistic.every(h => h.status === "hypothesis"));
});

test("invalid own image and anchor sets fail before any request", async () => {
  let calls = 0;
  const observer = createLunaObserver({ async complete() { calls++; return { text: JSON.stringify(initial()) }; } });
  const changed = structuredClone(input); changed.ownAnchors[0].centroid.x = -1;
  const duplicate = structuredClone(input); duplicate.ownAnchors[0].id = duplicate.ownAnchors[1].id;
  const badRegion = structuredClone(input); badRegion.ownAnchors[0].bbox.w = 0;
  for (const value of [changed, duplicate, badRegion, { ...input, ownAnchors: input.ownAnchors.slice(1) },
    { ...input, ownImage: { mimeType: "image/png", base64: "data:image/png;base64,AAAA" } },
    { ...input, ownImage: { mimeType: "image/gif", base64: "AAAA" } }]) {
    await assert.rejects(observer.observeAll(value as ObservationInput), code("invalid_input"));
  }
  assert.equal(calls, 0);
});

test("targeted JSON cannot rewrite an issue or return unrequested, duplicated or malformed figures", () => {
  const mutations: Array<(v: ReturnType<typeof evidence>) => void> = [
    v => { v.figures[0].figureId = "own-1"; }, v => { v.figures.push(v.figures[0]); }, v => { v.figures = []; },
    v => { (v as unknown as Record<string, unknown>).issue = issue; },
    v => { (v.figures[0] as unknown as Record<string, unknown>).action = "agree"; },
    v => { v.figures[0].contradicts = ["反証".repeat(121)]; },
  ];
  for (const mutate of mutations) {
    const value = evidence(); mutate(value);
    assert.throws(() => parseReobservation(JSON.stringify(value), targeted(), { observedAt: laterTime }), code("invalid_response"));
  }
  for (const value of [{ ...targeted(), figureIds: [] }, { ...targeted(), figureIds: ["own-2", "own-2"] },
    { ...targeted(), figureIds: ["partner-only"] }, { ...targeted(), issue: { ...issue, aspect: "made_up" } }]) {
    assert.throws(() => buildReobservationMessages(value as ReobservationInput), code("invalid_input"));
  }
});

test("restore validation checks IDs, regions, timestamps, unknown keys and detached snapshots", () => {
  const original = mergeReobservation(memo(), reobserved());
  const restored = validateObservationMemo(JSON.parse(JSON.stringify(original)), { ownAnchors: input.ownAnchors });
  assert.deepEqual(restored, original); restored.figures[0].unknowns.push("変更");
  assert.notDeepEqual(restored, original);
  const mutations: Array<(m: ObservationMemo) => void> = [
    m => { m.figures[0].region.x++; }, m => { m.figures[0].id = "unknown"; },
    m => { m.figures[0].reobservations = [structuredClone(m.figures[1].reobservations[0])]; },
    m => { m.figures[1].reobservations[0].observedAt = "2026-10-19T00:00:00.000Z"; },
    m => { m.observedAt = "2026-02-30T00:00:00.000Z"; },
    m => { (m.figures[1].reobservations[0].issue as unknown as Record<string, unknown>).gold = "CANARY"; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(original); mutate(changed);
    assert.throws(() => validateObservationMemo(changed, { ownAnchors: input.ownAnchors }), code("invalid_input"));
  }
});

test("merge appends separate issues and rejects history overflow atomically", () => {
  const original = memo(); const first = mergeReobservation(original, reobserved());
  const secondResult = { ...reobserved(), observedAt: "2026-10-20T00:02:00.000Z", issue: { ...issue, aspect: "orientation" as const, question: "細い部分の向き" } };
  const second = mergeReobservation(first, secondResult);
  assert.equal(second.figures[1].reobservations.length, 2); assert.equal(first.figures[1].reobservations.length, 1);
  assert.deepEqual(second.figures[1].reobservations.map(r => r.issue.aspect), ["construal", "orientation"]);
  const full = structuredClone(first);
  full.figures[1].reobservations = Array.from({ length: OBSERVATION_LIMITS.reobservations }, () => structuredClone(first.figures[1].reobservations[0]));
  const saved = JSON.stringify(full);
  assert.throws(() => mergeReobservation(full, secondResult), code("invalid_input")); assert.equal(JSON.stringify(full), saved);
  assert.equal(original.figures[1].reobservations.length, 0);
  const wrong = { ...reobserved(), figures: [{ ...reobserved().figures[0], figureId: "other" }] };
  assert.throws(() => mergeReobservation(first, wrong), code("invalid_input"));
});

test("image bodies and raw upstream failures cannot enter memo or error records", async () => {
  for (const leaked of [input.ownImage.base64, "data:image/png;base64,QUJD", "image_url: private image"]) {
    const value = initial(); value.figures[0].unknowns = [leaked];
    const observer = createLunaObserver({ async complete() { return { text: JSON.stringify(value) }; } });
    await assert.rejects(observer.observeAll(input), error => {
      assert.ok(error instanceof ObservationError);
      assert.doesNotMatch(inspect(error), /iVBOR|QUJD|private image|CANARY/); return true;
    });
  }
  const escaped = JSON.stringify(initial()).replace("重なりの境界は不明", input.ownImage.base64.replaceAll("/", "\\/"));
  assert.throws(() => parseInitialObservation(escaped, input, { observedAt: initialTime }), code("invalid_response"));
  const upstream = createLunaObserver({ async complete() { throw new Error("API_KEY_CANARY " + input.ownImage.base64); } });
  await assert.rejects(upstream.observeAll(input), error => {
    assert.ok(code("unavailable")(error)); assert.doesNotMatch(inspect(error), /API_KEY_CANARY|iVBOR/); return true;
  });
});

test("observation honors deadlines and abort even for a noncooperative client", async () => {
  let downstream: AbortSignal | undefined;
  const observer = createLunaObserver({ complete(_messages, options) { downstream = options.signal; return new Promise(() => {}); } }, { timeoutMs: 10 });
  await assert.rejects(observer.observeAll(input), code("timeout")); assert.equal(downstream?.aborted, true);
  const controller = new AbortController();
  const pending = observer.observeAll(input, { signal: controller.signal, timeoutMs: 1000 }); controller.abort();
  await assert.rejects(pending, code("aborted"));
  const before = new AbortController(); before.abort();
  await assert.rejects(observer.observeAll(input, { signal: before.signal }), code("aborted"));
  await assert.rejects(observer.observeAll(input, { timeoutMs: 0 }), code("invalid_input"));
});

test("caller mutation during observation cannot alter the request or adopted provenance", async () => {
  const mutable = structuredClone(input); let release!: (value: { text: string }) => void;
  const observer = createLunaObserver({ complete() { return new Promise(resolve => { release = resolve; }); } }, { now: () => new Date(initialTime) });
  const pending = observer.observeAll(mutable); await new Promise(resolve => setImmediate(resolve));
  mutable.ownAnchors[0].id = "changed"; mutable.ownAnchors[0].bbox.x = 999; mutable.ownImage.base64 = "QUJD";
  release({ text: JSON.stringify(initial()) });
  assert.deepEqual(await pending, memo());
});

test("mock observer provides detached callbacks, cancellation and fixed failures without network", async () => {
  const indices: number[] = [];
  const observer = createMockObserver({ observeAll(own, options) { indices.push(options.callIndex); own.ownAnchors[0].id = "callback mutation"; return memo(); },
    reobserve(_own, options) { indices.push(options.callIndex); return reobserved(); } });
  const own = structuredClone(input); assert.deepEqual(await observer.observeAll(own), memo());
  assert.equal(own.ownAnchors[0].id, "own-1"); assert.deepEqual(await observer.reobserve(targeted()), reobserved());
  assert.deepEqual(indices, [0, 1]);
  const delayed = createMockObserver({ observeAll: () => memo(), reobserve: () => reobserved() }, { delayMs: 50, timeoutMs: 5 });
  await assert.rejects(delayed.observeAll(input), code("timeout"));
  const failed = createMockObserver({ observeAll() { throw new Error("SECRET_CANARY"); }, reobserve: () => reobserved() });
  await assert.rejects(failed.observeAll(input), code("unavailable"));
});

test("large targeted context respects the proxy's 20k text budget without omitting evidence", () => {
  const m = memo(); const result = reobserved();
  for (let index = 0; index < 8; index++) m.figures[1].reobservations.push({ figureId: "own-2", observedAt: laterTime, issue,
    supports: Array(16).fill("画像上の部分についての観察".repeat(16)), contradicts: result.figures[0].contradicts, unknown: [] });
  const messages = buildReobservationMessages(targeted(m));
  const contexts = messages.slice(1, -1);
  assert.ok(contexts.length > 1); assert.ok(contexts.every(message => typeof message.content === "string" && message.content.length <= 20000));
  const state = contexts.map(message => (message.content as string).split("\n").slice(1).join("\n")).join("");
  assert.deepEqual(JSON.parse(state).figures, [m.figures[1]]);
  assert.deepEqual(messages.slice(-1), ownImageMessage(input.ownImage));
  const unicode = "あ".repeat(18999) + "🐄" + "い".repeat(19001);
  const unicodeMessages = observationContextMessages(unicode);
  assert.equal(unicodeMessages.map(message => message.content.split("\n").slice(1).join("\n")).join(""), unicode);
  assert.ok(unicodeMessages.every(message => !/[\uD800-\uDBFF]$/u.test(message.content)));
});
