import test from "node:test";
import assert from "node:assert/strict";
import { createHumanMessageQueue, createHumanMessageSequencer, HumanMessageQueueError } from "../dialogue-model/runtime/web/human-message-queue.mjs";

const now = () => 1234;
const message = (clientId, text = clientId) => ({ clientId, text });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => queueMicrotask(resolve));
const hasCode = (code) => (error) => error instanceof HumanMessageQueueError && error.code === code;

test("human events commit immediately with stable event-sourced turn, ID and timestamp", () => {
  const a = createHumanMessageSequencer({ now }), b = createHumanMessageSequencer({ now });
  for (const state of [a, b]) {
    assert.deepEqual(state.acceptHuman(message("first", "鳥かも")), {
      duplicate: false, event: { id: "event-1", speaker: "human", text: "鳥かも", at: "1970-01-01T00:00:01.234Z", seq: 1, turn: 1, clientId: "first" },
    });
    state.acceptHuman(message("second", "訂正、船です"));
    const request = state.beginRequest();
    assert.equal(request.lastEventId, "event-2");
    assert.deepEqual(request.pendingHumanEvents.map((event) => event.text), ["鳥かも", "訂正、船です"]);
    assert.equal(state.completeRequest(request, { text: "船ですね" }).status, "committed");
    state.acceptHuman(message("third", "もう一つ相談したいです"));
    assert.deepEqual(state.getSnapshot().events.map((event) => [event.seq, event.turn, event.speaker]),
      [[1, 1, "human"], [2, 2, "human"], [3, 3, "ai"], [4, 4, "human"]]);
  }
  assert.deepEqual(a.getSnapshot(), b.getSnapshot(), "same operations/clock are deterministic");
});

test("microtask batching keeps two or more consecutive human utterances separate", async () => {
  const calls = [];
  const queue = createHumanMessageQueue({ now, runAiTurn: async (request) => {
    calls.push(request); return { text: "全部読みました" };
  } });
  queue.enqueue(message("one")); queue.enqueue(message("two")); queue.enqueue(message("three"));
  assert.equal(calls.length, 0);
  assert.equal(queue.getSnapshot().events.length, 3);
  await queue.whenIdle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].events.length, 3);
  assert.deepEqual(calls[0].pendingHumanEvents.map((event) => event.text), ["one", "two", "three"]);
  assert.deepEqual(queue.getSnapshot().events.map((event) => event.speaker), ["human", "human", "human", "ai"]);
});

test("correction during processing aborts then discards stale answer AND its ledger/graph", async () => {
  const first = deferred(), second = deferred(), calls = [];
  let live = 0, maxLive = 0;
  const queue = createHumanMessageQueue({ now, initialPrivateState: { ledger: "before", graph: [], judgments: [] },
    runAiTurn: async (request) => {
      calls.push(request); live++; maxLive = Math.max(live, maxLive);
      try { return await (calls.length === 1 ? first.promise : second.promise); }
      finally { live--; }
    } });
  queue.enqueue(message("first", "鳥")); await tick();
  const receipt = queue.enqueue(message("correction", "いえ、船でした"));
  assert.equal(receipt.event.seq, 2);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls.length, 1, "abort-ignoring old transport retains the single-flight slot");
  first.resolve({ text: "鳥ですね", privateState: { ledger: "STALE", graph: ["STALE"], judgments: ["STALE"] } });
  await tick(); await tick();
  assert.equal(calls.length, 2);
  assert.equal(maxLive, 1);
  assert.equal(calls[1].lastEventId, "event-2");
  assert.deepEqual(calls[1].events.map((event) => event.text), ["鳥", "いえ、船でした"]);
  assert.deepEqual(calls[1].privateState, { ledger: "before", graph: [], judgments: [] });
  assert.deepEqual(queue.getSnapshot().events.map((event) => event.speaker), ["human", "human"]);
  second.resolve({ text: "船ですね", privateState: { ledger: "ship", graph: ["event-2"], judgments: ["new"] } });
  await queue.whenIdle();
  assert.deepEqual(queue.getSnapshot().events.map((event) => event.text), ["鳥", "いえ、船でした", "船ですね"]);
  assert.deepEqual(queue.getPrivateState(), { ledger: "ship", graph: ["event-2"], judgments: ["new"] });
  assert.deepEqual(queue.getSnapshot().pendingHumanEventIds, []);
});

test("a correction after resolution but before completion still invalidates old output", async () => {
  const first = deferred(), requests = [];
  const queue = createHumanMessageQueue({ now, runAiTurn(request) {
    requests.push(request); return requests.length === 1 ? first.promise : { text: "latest" };
  } });
  queue.enqueue(message("one")); await tick();
  first.resolve({ text: "old", privateState: "old" });
  queue.enqueue(message("two"));
  await queue.whenIdle();
  assert.equal(requests.length, 2);
  assert.deepEqual(queue.getSnapshot().events.map((event) => event.text), ["one", "two", "latest"]);
  assert.equal(queue.getPrivateState(), null);
});

test("stable clientId is idempotent during processing and after reply; conflicts fail", async () => {
  const wait = deferred(), calls = [];
  const queue = createHumanMessageQueue({ now, maxPendingMessages: 1, runAiTurn: async (request) => {
    calls.push(request); return wait.promise;
  } });
  const first = queue.enqueue(message("same", "同じ発話")); await tick();
  assert.deepEqual(queue.enqueue(message("same", "同じ発話")), { ...first, duplicate: true });
  assert.equal(calls[0].signal.aborted, false, "duplicate must not invalidate useful work");
  assert.throws(() => queue.enqueue(message("same", "別の発話")), hasCode("client_id_conflict"));
  wait.resolve({ text: "返答" }); await queue.whenIdle();
  assert.equal(queue.enqueue(message("same", "同じ発話")).event.id, first.event.id);
  await queue.whenIdle();
  assert.equal(calls.length, 1);
  queue.close();
  assert.equal(queue.enqueue(message("same", "同じ発話")).duplicate, true, "late retry can retrieve its original receipt after close");
});

test("late cancel/completion from an older request cannot cancel or release newer work", () => {
  const state = createHumanMessageSequencer({ now });
  for (const unknown of [undefined, null, {}]) {
    assert.equal(state.isCurrent(unknown), false);
    assert.equal(state.cancelRequest(unknown), false);
    assert.equal(state.failRequest(unknown).status, "stale");
    assert.equal(state.completeRequest(unknown, { text: "unknown" }).status, "stale");
  }
  state.acceptHuman(message("one")); const first = state.beginRequest();
  state.acceptHuman(message("two"));
  assert.throws(() => state.beginRequest(), hasCode("busy"));
  assert.equal(state.completeRequest(first, { text: "old" }).status, "stale");
  const second = state.beginRequest();
  assert.equal(state.cancelRequest(first), false);
  assert.equal(state.failRequest(first).status, "stale");
  assert.equal(state.completeRequest(first, { text: "late old" }).status, "stale");
  assert.equal(state.isCurrent(second), true);
  assert.equal(state.completeRequest({ ...second }, { text: "forged" }).status, "stale");
  assert.equal(state.isCurrent(second), true, "request identity cannot be reconstructed from revision alone");
  assert.equal(state.completeRequest(second, { text: "current" }).status, "committed");
  assert.equal(state.completeRequest(second, { text: "duplicate AI" }).status, "stale");
  assert.equal(state.getSnapshot().events.length, 3);
});

test("manual cancellation invalidates even without a later human; retries preserve order", () => {
  const state = createHumanMessageSequencer({ now });
  state.acceptHuman(message("one")); const first = state.beginRequest();
  assert.equal(state.cancelRequest(first), true);
  assert.equal(state.completeRequest(first, { text: "cancelled", privateState: "bad" }).status, "stale");
  const retry = state.beginRequest();
  assert.equal(retry.requestSeq, 2);
  assert.equal(retry.revision, first.revision);
  assert.deepEqual(retry.pendingHumanEvents, first.pendingHumanEvents);
  assert.equal(state.completeRequest(retry, { text: "retry" }).status, "committed");
  assert.equal(state.getPrivateState(), null);
});

test("generation/network errors retain all accepted human events and explicit retry reuses them", async () => {
  let fail = true;
  const requests = [];
  const queue = createHumanMessageQueue({ now, initialPrivateState: { ledger: "before" }, runAiTurn: async (request) => {
    requests.push(request);
    request.privateState.ledger = "candidate";
    if (fail) throw new Error("PRIVATE-API-KEY PROMPT RAW-UPSTREAM-RESPONSE");
    return { text: "recovered", privateState: request.privateState };
  } });
  queue.enqueue(message("one")); queue.enqueue(message("two"));
  await queue.whenIdle();
  assert.equal(requests.length, 1, "no unbounded automatic retry on error");
  assert.equal(queue.getSnapshot().status, "error");
  assert.equal(queue.getSnapshot().errorCode, "ai_unavailable");
  assert.doesNotMatch(JSON.stringify(queue.getSnapshot()), /PRIVATE|API-KEY|PROMPT|UPSTREAM/);
  assert.deepEqual(queue.getPrivateState(), { ledger: "before" });
  assert.deepEqual(queue.getSnapshot().events.map((event) => event.text), ["one", "two"]);
  assert.equal(queue.enqueue(message("one")).duplicate, true);
  await queue.whenIdle(); assert.equal(requests.length, 1);
  fail = false; await queue.retry();
  assert.deepEqual(requests[1].pendingHumanEvents, requests[0].pendingHumanEvents);
  assert.equal(requests[1].requestSeq, 2);
  assert.equal(queue.getSnapshot().status, "idle");
  assert.deepEqual(queue.getPrivateState(), { ledger: "candidate" });
});

test("abort rejection is stale and automatically retries against the latest messages", async () => {
  const requests = [];
  const queue = createHumanMessageQueue({ now, runAiTurn(request) {
    requests.push(request);
    if (requests.length > 1) return { text: "corrected" };
    return new Promise((resolve, reject) => request.signal.addEventListener("abort", () => reject(new Error("PRIVATE-abort")), { once: true }));
  } });
  queue.enqueue(message("one")); await tick(); queue.enqueue(message("two"));
  await queue.whenIdle();
  assert.equal(requests.length, 2);
  assert.equal(queue.getSnapshot().errorCode, null);
  assert.equal(queue.getSnapshot().events.at(-1).text, "corrected");
});

test("new human message after error resumes with all unhandled messages", async () => {
  let calls = 0;
  const queue = createHumanMessageQueue({ now, runAiTurn: async ({ pendingHumanEvents }) => {
    if (++calls === 1) throw new Error("private");
    return { text: pendingHumanEvents.map((event) => event.text).join(" + ") };
  } });
  queue.enqueue(message("one")); await queue.whenIdle();
  queue.enqueue(message("two")); await queue.whenIdle();
  assert.equal(queue.getSnapshot().events.at(-1).text, "one + two");
});

test("pending bound rejects before acceptance and idempotency survives a full buffer", async () => {
  const wait = deferred();
  const queue = createHumanMessageQueue({ now, maxPendingMessages: 2, runAiTurn: () => wait.promise });
  queue.enqueue(message("one")); queue.enqueue(message("two"));
  assert.equal(queue.enqueue(message("one")).duplicate, true);
  assert.throws(() => queue.enqueue(message("three")), hasCode("pending_full"));
  assert.equal(queue.getSnapshot().revision, 2);
  wait.resolve({ text: "reply" }); await queue.whenIdle();
  assert.equal(queue.enqueue(message("three")).event.seq, 4, "rejected message neither consumed sequence nor reserved clientId");
  await queue.whenIdle();
});

test("validation never partially appends malformed human inputs", () => {
  const state = createHumanMessageSequencer({ now, maxTextLength: 4 });
  for (const value of [null, [], {}, "text", message("", "ok"), message("with spaces", "ok"), message("a", ""), message("a", " \n"), message("a", 1), message("a", "12345")]) {
    assert.throws(() => state.acceptHuman(value), hasCode("invalid_message"));
    assert.equal(state.getSnapshot().revision, 0);
  }
  assert.equal(state.acceptHuman(message("a", " ok ")).event.text, " ok ", "public text is preserved exactly");
  for (const options of [{ maxPendingMessages: 0 }, { maxTextLength: -1 }, { maxPendingMessages: 1.1 }, { now: 1 }]) {
    assert.throws(() => createHumanMessageSequencer(options), hasCode("invalid_options"));
  }
  assert.throws(() => createHumanMessageQueue({}), hasCode("invalid_runner"));
});

test("invalid AI results/unstageable private state do not commit a public or private fragment", async () => {
  for (const result of [undefined, {}, { text: " " }, { text: "reply", privateState: () => {} }]) {
    const queue = createHumanMessageQueue({ now, initialPrivateState: "before", runAiTurn: () => result });
    queue.enqueue(message("one")); await queue.whenIdle();
    assert.equal(queue.getSnapshot().events.length, 1);
    assert.equal(queue.getSnapshot().status, "error");
    assert.equal(queue.getPrivateState(), "before");
    assert.deepEqual(queue.getSnapshot().pendingHumanEventIds, ["event-1"]);
  }
});

test("polling snapshots and model input exclude arbitrary metadata, staged secrets and raw errors", async () => {
  const initial = { ledger: "PRIVATE-LEDGER", graph: "PRIVATE-GRAPH" }, output = { text: "public reply", privateState: { judgment: "PRIVATE-JUDGMENT" }, apiKey: "PRIVATE-API-KEY" };
  let input;
  const queue = createHumanMessageQueue({ now, initialPrivateState: initial, runAiTurn(request) {
    input = request; return output;
  } });
  initial.ledger = "mutated";
  queue.enqueue({ ...message("one", "public human"), image: "PRIVATE-HUMAN-IMAGE", gold: "PRIVATE-GOLD", apiKey: "PRIVATE-INPUT-KEY", at: "spoofed", speaker: "ai" });
  await queue.whenIdle();
  assert.equal(input.privateState.ledger, "PRIVATE-LEDGER");
  assert.doesNotMatch(JSON.stringify(input.events), /PRIVATE|spoofed|apiKey|gold/);
  assert.doesNotMatch(JSON.stringify(queue.getSnapshot()), /PRIVATE|privateState|judgment|apiKey|gold|requestSeq/);
  const snapshot = queue.getSnapshot(); snapshot.events[0].text = "mutation"; snapshot.pendingHumanEventIds.push("fake");
  assert.equal(queue.getSnapshot().events[0].text, "public human");
  assert.throws(() => { input.events[0].text = "mutation"; }, TypeError);
  output.privateState.judgment = "mutated";
  const privateCopy = queue.getPrivateState(); privateCopy.judgment = "mutated again";
  assert.equal(queue.getPrivateState().judgment, "PRIVATE-JUDGMENT");
});

test("cursor polling includes every actual event exactly once and timestamps cannot regress", () => {
  const times = [100, 50, 200];
  const state = createHumanMessageSequencer({ now: () => times.shift() });
  state.acceptHuman(message("one")); state.acceptHuman(message("two"));
  const request = state.beginRequest(); state.completeRequest(request, { text: "reply" });
  assert.deepEqual(state.getSnapshot({ afterSeq: 1 }).events.map((event) => event.seq), [2, 3]);
  assert.deepEqual(state.getSnapshot({ afterSeq: 3 }).events, []);
  assert.deepEqual(state.getSnapshot().events.map((event) => event.at), [new Date(100).toISOString(), new Date(100).toISOString(), new Date(200).toISOString()]);
  for (const afterSeq of [-1, 4, NaN, 1.5, "1"]) assert.throws(() => state.getSnapshot({ afterSeq }), hasCode("invalid_cursor"));
});

test("bad clock cannot consume a message, sequence or idempotency key", () => {
  let time = NaN;
  const state = createHumanMessageSequencer({ now: () => time });
  assert.throws(() => state.acceptHuman(message("one")), hasCode("invalid_clock"));
  assert.equal(state.getSnapshot().revision, 0);
  time = 1;
  assert.equal(state.acceptHuman(message("one")).event.seq, 1);
});

test("close during processing preserves events and rejects late AI private/public commits", async () => {
  const wait = deferred();
  const queue = createHumanMessageQueue({ now, initialPrivateState: "before", runAiTurn: () => wait.promise });
  queue.enqueue(message("one")); await tick(); queue.close(); queue.close();
  assert.throws(() => queue.enqueue(message("two")), hasCode("closed"));
  wait.resolve({ text: "late", privateState: "bad" }); await queue.whenIdle(); await queue.retry();
  assert.equal(queue.getSnapshot().status, "closed");
  assert.equal(queue.getSnapshot().events.length, 1);
  assert.equal(queue.getPrivateState(), "before");
});

test("after one committed reply, the next request retains real history and only new pending humans", async () => {
  const calls = [];
  const queue = createHumanMessageQueue({ now, runAiTurn(request) { calls.push(request); return { text: "reply" }; } });
  queue.enqueue(message("one")); await queue.whenIdle();
  queue.enqueue(message("two")); queue.enqueue(message("three")); await queue.whenIdle();
  assert.deepEqual(calls[1].events.map((event) => event.speaker), ["human", "ai", "human", "human"]);
  assert.deepEqual(calls[1].pendingHumanEvents.map((event) => event.seq), [3, 4]);
  assert.deepEqual(queue.getSnapshot().events.map((event) => event.seq), [1, 2, 3, 4, 5]);
});

test("a message arriving at the drain/finalizer boundary is not stranded", async () => {
  let calls = 0;
  const queue = createHumanMessageQueue({ now, runAiTurn() {
    if (++calls === 1) queueMicrotask(() => queueMicrotask(() => queue.enqueue(message("boundary"))));
    return { text: "reply" };
  } });
  queue.enqueue(message("one")); await queue.whenIdle();
  assert.equal(calls, 2);
  assert.equal(queue.getSnapshot().status, "idle");
  assert.deepEqual(queue.getSnapshot().events.map((event) => event.speaker), ["human", "ai", "human", "ai"]);
});

test("detached retry and polling functions preserve failed messages without binding this", async () => {
  let calls = 0;
  const { enqueue, getSnapshot, retry, whenIdle } = createHumanMessageQueue({ now, runAiTurn() {
    if (++calls === 1) throw new Error("private sync failure");
    return { text: "recovered" };
  } });
  enqueue(message("one")); await whenIdle();
  assert.equal(getSnapshot().status, "error");
  await retry();
  assert.equal(getSnapshot().status, "idle");
});

test("many corrections stay append-only, never overlap, and eventually receive one fresh answer", async () => {
  const waits = [], requests = [];
  let live = 0, peak = 0;
  const queue = createHumanMessageQueue({ now, runAiTurn: async (request) => {
    requests.push(request); const wait = deferred(); waits.push(wait);
    live++; peak = Math.max(peak, live);
    try { return await wait.promise; } finally { live--; }
  } });
  queue.enqueue(message("start")); await tick();
  for (let i = 0; i < 10; i++) {
    queue.enqueue(message(`correction-${i}`));
    waits[i].resolve({ text: `stale-${i}`, privateState: "STALE" });
    await tick(); await tick();
  }
  assert.equal(requests.length, 11);
  assert.equal(requests.at(-1).pendingHumanEvents.length, 11);
  assert.equal(queue.getSnapshot().events.length, 11);
  waits.at(-1).resolve({ text: "all corrections considered", privateState: "LATEST" });
  await queue.whenIdle();
  assert.equal(peak, 1);
  assert.deepEqual(queue.getSnapshot().events.map((event) => event.seq), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal(queue.getSnapshot().events.filter((event) => event.speaker === "ai").length, 1);
  assert.equal(queue.getPrivateState(), "LATEST");
});
