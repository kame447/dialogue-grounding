/**
 * Trial-local, in-memory public event sequencer and single-flight AI runner.
 *
 * Integration contract (this module does not wire the existing web/session API):
 * - enqueue({clientId, text}) accepts each human utterance synchronously. Persist
 *   the returned public event before acknowledging it over HTTP if crash recovery
 *   is required. Idempotency and event IDs are scoped to this queue/trial; retain
 *   the queue throughout retries. The pending bound rejects NEW messages before
 *   acceptance, never evicts an accepted message. The full transcript/dedup map
 *   lives for the trial and must not be silently truncated.
 * - initialEvents contains AI-only scripted public events, assigned ordinary
 *   sequence/turn numbers once at creation. They are never pending human work
 *   and cannot start a model request. Optional human clientId values are echoed
 *   for optimistic UI reconciliation; absent IDs do not enable deduplication.
 * - runAiTurn({events, pendingHumanEvents, lastEventId, revision, requestSeq,
 *   signal, privateState}) performs judgment AND generation against this exact
 *   public snapshot. Consecutive human events are one request but stay distinct
 *   events. Build model history from events, retaining speaker order; do not add
 *   synthetic assistant turns or silently drop all but the latest correction.
 * - Return {text, privateState?}. Stage ledger, graph, committed judgment history
 *   and private memory in the detached privateState; NEVER commit external state
 *   in runAiTurn. Only the queue atomically installs that candidate with the AI
 *   event after checking the snapshot again. getPrivateState() is server-only;
 *   never merge it into getSnapshot(), HTTP polling or participant state.
 * - Existing session.turn() commits internally and is NOT a safe runAiTurn
 *   adapter. Replace history.length / 2 + 1 and paired publicTurnsFromHistory
 *   indexing with event-sourced turn=seq. Upgrade trace.turnIndex, reference
 *   sourceTurn/mention/antecedent IDs and memory grounding to cite each actual
 *   event (including every coalesced human message). An aborted/stale judgment
 *   must not enter committed ownJudgmentHistory, ledger, graph or public history.
 * - AbortSignal is advisory. A superseded request retains the single-flight
 *   slot until it settles, even if transport ignores cancellation. Configure a
 *   transport timeout in the adapter; the queue never overlaps requests to work
 *   around a hung transport. Errors retain messages and require explicit retry;
 *   stale requests automatically yield to the latest snapshot.
 * - close() rejects new messages and invalidates in-flight work without erasing
 *   public events. This module never finalizes names, submits or scores a task.
 *   Existing submission/persistence coordination must be integrated separately.
 */

export class HumanMessageQueueError extends Error {
  constructor(code) {
    super("Human message queue failed: " + code);
    this.name = "HumanMessageQueueError";
    this.code = code;
  }
}

const fail = (code) => { throw new HumanMessageQueueError(code); };
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const validText = (value, limit) => typeof value === "string" && value.trim().length > 0 && value.length <= limit;
const publicCopy = ({ nonReferential, ...event }) => event;
const frozenEvents = (events) => Object.freeze(events.map((event) => Object.freeze({ ...event })));
function clonePrivate(value) {
  try { return structuredClone(value); }
  catch { fail("invalid_private_state"); }
}

/** Deterministic state machine: no networking, timers, logs or model decisions. */
export function createHumanMessageSequencer({
  now = Date.now, maxPendingMessages = 64, maxTextLength = 12000, initialPrivateState = null,
  initialEvents = [],
} = {}) {
  if (typeof now !== "function" || !positive(maxPendingMessages) || !positive(maxTextLength) || !Array.isArray(initialEvents)) fail("invalid_options");
  const events = [], pending = [], clients = new Map();
  let privateState = clonePrivate(initialPrivateState);
  let active = null, requestSeq = 0, closed = false, lastMillis = 0, errorCode = null;
  function nextEvent(speaker, text, clientId, nonReferential = false) {
    const millis = now();
    if (!Number.isSafeInteger(millis) || millis < 0 || millis > 8640000000000000) fail("invalid_clock");
    // Wall-clock regression never changes ordering or moves timestamps backward.
    const atMillis = Math.max(lastMillis, millis), seq = events.length + 1;
    if (!positive(seq)) fail("sequence_exhausted");
    return { event: Object.freeze({ id: `event-${seq}`, speaker, text, at: new Date(atMillis).toISOString(), seq, turn: seq,
      ...(speaker === "human" && clientId !== undefined ? { clientId } : {}),
      ...(nonReferential ? { nonReferential: true } : {}) }), atMillis };
  }
  for (const initial of initialEvents) {
    if (!initial || typeof initial !== "object" || Array.isArray(initial) || initial.speaker !== "ai" || !validText(initial.text, maxTextLength)) fail("invalid_options");
    // Scripted setup speech is public dialogue, never evidence of a proposed name.
    const { event, atMillis } = nextEvent("ai", initial.text, undefined, true);
    events.push(event); lastMillis = atMillis;
  }
  const isCurrent = (request) => Boolean(!closed && active && active.request === request && !active.invalid && request.revision === events.length);
  function finish(request) {
    if (!active || active.request !== request) return false;
    active = null;
    return true;
  }
  return Object.freeze({
    acceptHuman(input) {
      if (!input || typeof input !== "object" || Array.isArray(input) ||
          (input.clientId !== undefined && (typeof input.clientId !== "string" || !/^[A-Za-z0-9_.:-]{1,80}$/.test(input.clientId))) ||
          !validText(input.text, maxTextLength)) fail("invalid_message");
      const previous = input.clientId === undefined ? null : clients.get(input.clientId);
      if (previous) {
        if (previous.text !== input.text) fail("client_id_conflict");
        return { event: publicCopy(previous), duplicate: true };
      }
      if (closed) fail("closed");
      if (pending.length >= maxPendingMessages) fail("pending_full");
      const { event, atMillis } = nextEvent("human", input.text, input.clientId);
      events.push(event); pending.push(event);
      if (input.clientId !== undefined) clients.set(input.clientId, event);
      lastMillis = atMillis; errorCode = null;
      if (active) active.invalid = true;
      return { event: publicCopy(event), duplicate: false };
    },
    beginRequest() {
      if (active) fail("busy");
      if (closed || !pending.length) return null;
      if (!positive(requestSeq + 1)) fail("sequence_exhausted");
      const request = Object.freeze({ requestSeq: requestSeq + 1, revision: events.length,
        lastEventId: events.at(-1).id, events: frozenEvents(events), pendingHumanEvents: frozenEvents(pending),
        privateState: clonePrivate(privateState) });
      requestSeq++; active = { request, invalid: false }; errorCode = null;
      return request;
    },
    isCurrent,
    completeRequest(request, result) {
      if (!isCurrent(request)) { finish(request); return { status: "stale" }; }
      // Prepare everything that can fail before changing public/private state.
      if (!result || !validText(result.text, maxTextLength)) fail("invalid_ai_result");
      const nextPrivate = Object.hasOwn(result, "privateState") ? clonePrivate(result.privateState) : privateState;
      const { event, atMillis } = nextEvent("ai", result.text);
      if (!isCurrent(request)) { finish(request); return { status: "stale" }; }
      events.push(event); privateState = nextPrivate; pending.length = 0;
      lastMillis = atMillis; finish(request); errorCode = null;
      return { status: "committed", event: publicCopy(event) };
    },
    failRequest(request) {
      const current = isCurrent(request);
      if (finish(request) && current) errorCode = "ai_unavailable";
      return { status: current ? "error" : "stale" };
    },
    // Invalidate, but do not release a running transport's slot prematurely.
    cancelRequest(request) {
      if (!active || active.request !== request) return false;
      active.invalid = true;
      return true;
    },
    close() { closed = true; if (active) active.invalid = true; },
    getPrivateState() { return clonePrivate(privateState); },
    getSnapshot({ afterSeq = 0 } = {}) {
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || afterSeq > events.length) fail("invalid_cursor");
      // Explicit allowlist: never spread requests, model results or exceptions.
      return { revision: events.length, lastEventId: events.at(-1)?.id ?? null,
        events: events.filter((event) => event.seq > afterSeq).map(publicCopy),
        pendingHumanEventIds: pending.map((event) => event.id),
        status: closed ? "closed" : active ? "processing" : errorCode ? "error" : pending.length ? "pending" : "idle",
        errorCode };
    },
  });
}

/**
 * Async runner. enqueue() returns before AI starts (one microtask batches short
 * consecutive messages). whenIdle() waits for the runner to stop, including an
 * error pause; it never rejects with a raw upstream exception. retry() resumes
 * retained pending events explicitly, without re-enqueuing or renumbering them.
 */
export function createHumanMessageQueue({ runAiTurn, ...options } = {}) {
  if (typeof runAiTurn !== "function") fail("invalid_runner");
  const state = createHumanMessageSequencer(options);
  let running = null, controller = null, current = null, retryRequested = false;
  async function drain() {
    for (;;) {
      current = state.beginRequest();
      if (!current) return;
      controller = new AbortController();
      let outcome;
      try {
        const result = await runAiTurn({ ...current, signal: controller.signal });
        outcome = state.completeRequest(current, result);
      } catch {
        // No exception message, cause, prompt, key or response body is retained.
        outcome = state.failRequest(current);
      } finally { current = null; controller = null; }
      if (outcome.status === "error") return;
    }
  }
  function start() {
    if (!running) {
      // Assign before invoking user code, including synchronous mock adapters.
      retryRequested = false;
      running = Promise.resolve().then(drain).finally(() => {
        running = null;
        const status = state.getSnapshot().status;
        // A new human message/retry may arrive after drain returns but before
        // this finalizer runs. Do not strand it in that microtask boundary.
        if (status === "pending" || (retryRequested && status === "error")) start();
      });
    }
    return running;
  }
  async function whenIdle() { while (running) await running; }
  return Object.freeze({
    enqueue(input) {
      const receipt = state.acceptHuman(input);
      if (!receipt.duplicate) {
        // Acceptance/invalidation is durable in state before abort listeners run.
        controller?.abort();
        start();
      }
      return receipt;
    },
    getSnapshot: state.getSnapshot,
    getPrivateState: state.getPrivateState,
    retry() { retryRequested = true; start(); return whenIdle(); },
    whenIdle,
    close() { state.close(); controller?.abort(); },
  });
}
