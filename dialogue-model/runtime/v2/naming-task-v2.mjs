// v2 naming task: scattered unlabeled boards with opaque per-side ids, immediate
// asynchronous human messages, and private submissions scored only after both
// sides submit. The participant sees only their own scene and public events;
// the model sees only its own image, own anchors and public events.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createTrialV2, participantView, modelView } from "../stimuli/scatter-v2.mjs";
import { scoreTrial as defaultScoreTrial, normalizeName } from "../scoring.mjs";
import { createHumanMessageQueue } from "../web/human-message-queue.mjs";
import { createDialogueV2 } from "./dialogue-v2.mjs";
import { NamingTaskError } from "../naming-error.mjs";
import { STRATEGIES } from "../judgment/instructions.mjs";
import { STATUSES } from "../judgment/schema.mjs";
import { selectParticipantJev, participantLunaClient, withParticipantJevTurn, restoreParticipantJevLedger,
  participantInitialObservation } from "../web/participant-jev-wiring.ts";
import { researchHash } from "./research-profile.ts";
import { settleJevTurnTraces, settleAiPublicClaims } from "./jev-turn.ts";

export const VERSION = 2;
const SCRIPTED_OPENING = "まず、どの図形から話しましょうか？";
const NAME_LIMIT = 200;
const clone = (value) => structuredClone(value);
// Research latency records keep enum-like codes only, never messages or bodies.
const errorCode = (error) => typeof error?.code === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(error.code) ? error.code : "error";
const safeCodes = (values) => Array.isArray(values) ? values.map((value) => typeof value === "string" && /^[a-z][a-z0-9_]{0,59}$/.test(value) ? value : "invalid") : [];

/** Names keyed by the submitter's own opaque ids; null or "" means not agreed / unknown. */
export function validateNamesV2(value, slots) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NamingTaskError("invalid_submission");
  const keys = Object.keys(value);
  if (keys.length !== slots.length || !slots.every((slot) => Object.hasOwn(value, slot))) throw new NamingTaskError("invalid_submission");
  return Object.fromEntries(slots.map((slot) => {
    const name = value[slot];
    if (name === null) return [slot, null];
    if (typeof name !== "string" || name.length > NAME_LIMIT) throw new NamingTaskError("invalid_submission");
    return [slot, name.trim() || null];
  }));
}

export function parseAiNamesV2(text, slots) {
  let value;
  try { value = JSON.parse(String(text).replace(/^\s*```(?:json)?|```\s*$/g, "").trim()); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).length !== slots.length || !slots.every((slot) => Object.hasOwn(value, slot))) return null;
  if (!slots.every((slot) => value[slot] === null || (typeof value[slot] === "string" && value[slot].length <= NAME_LIMIT))) return null;
  return Object.fromEntries(slots.map((slot) => [slot, typeof value[slot] === "string" && value[slot].trim() ? value[slot].trim() : null]));
}

/**
 * @param {{ client, strategy, seed, referenceMemory?: boolean, runDir?: string | null, createTrial?, scoreTrial?,
 *   judge?: import('../judgment/schema.mjs').DialogueJudge | null, now?: () => number, restore?: object | null, onPersist?: Function | null,
 *   decisionShadowClient?: {chooseAction(request: object): Promise<any>} | null,
 *   activeDecision?: {purpose: string, client: {chooseAction(request: object): Promise<any>}} | null,
 *   utteranceStyle?: string, groundingShadow?: import('./grounding-shadow.ts').GroundingShadowOptions | null,
 *   localGrounding?: import('../local-grounding/contract.ts').LocalGroundingOptions | null,
 *   jevResearch?: import('../web/participant-jev-wiring.ts').JevResearchOptions | null,
 *   onLocalGroundingTrace?: ((record: import('./local-grounding-turn.ts').LocalGroundingResearchRecord) => unknown) | null }} options
 *   groundingShadow is a researcher-only, default-off shadow; a restored trial keeps it only if it started with it.
 */
export async function createNamingTaskV2({
  client, strategy, seed, referenceMemory = false, runDir = process.env.RESEARCH_RUN_DIR,
  createTrial = createTrialV2, scoreTrial = defaultScoreTrial, judge = null, now = () => Date.now(),
  restore = null, onPersist = null, decisionShadowClient = null, activeDecision = null, utteranceStyle = "default",
  groundingShadow = null, localGrounding = null, onLocalGroundingTrace = null, jevResearch = null,
}) {
  const style = restore?.options?.utteranceStyle ?? utteranceStyle;
  const jev = selectParticipantJev(restore, jevResearch, { referenceMemory, strategy, style,
    legacy: [localGrounding, activeDecision, decisionShadowClient, groundingShadow] });
  if (!STRATEGIES.includes(strategy)) throw new NamingTaskError("invalid_strategy");
  if (!Number.isSafeInteger(seed)) throw new NamingTaskError("invalid_seed");
  if (typeof referenceMemory !== "boolean") throw new NamingTaskError("invalid_options");
  // A restored trial keeps the style it started with, whatever the deployment now says.
  if (!["default", "concise"].includes(style)) throw new NamingTaskError("invalid_options");
  // Shadow records are private research data; they survive restore with the record.
  const grounding = restore && restore.options?.groundingShadow !== true ? null : groundingShadow;
  const local = restore && restore.options?.localGrounding !== true ? null : localGrounding;
  const groundingRecords = Array.isArray(restore?.groundingShadow) ? clone(restore.groundingShadow) : [];
  const directory = runDir ? await (await import("../naming-task.mjs")).outsideRepositoryDirectory(runDir) : null;
  const trial = createTrial({ seed });
  const scene = participantView(trial);
  const model = modelView(trial);
  const humanSlots = scene.shapes.map((shape) => shape.id);
  const requests = restore?.requests ? clone(restore.requests) : [];
  // Private per-attempt timings; they survive restore with the record.
  const turnTimings = Array.isArray(restore?.turnTimings) ? clone(restore.turnTimings) : [];
  const jevTraces = jev && restore ? clone(restore.jevTraces) : [];
  const priorJevAttempts = jev && Array.isArray(restore?.attempts) ? clone(restore.attempts) : [];
  let aiPublicSettlement = jev && restore ? clone(restore.aiPublicSettlement) : null;
  let initialObservation = jev && restore ? clone(restore.initialObservation) : null;
  if (jev && restore) restoreParticipantJevLedger(jev.ledger, restore.jevLedger);
  const effectiveClient = jev ? participantLunaClient(client, jev.ledger, jev.profile) : client;
  // The queue runs one AI turn at a time, so every upstream call starts inside the
  // current attempt (requestSeq) or outside any turn (final submission: null).
  let currentRequestSeq = null;
  const trackingClient = {
    async complete(messages, options = {}) {
      const started = now(), requestSeq = currentRequestSeq;
      try {
        const response = await effectiveClient.complete(messages, options);
        requests.push({ kind: options.phase ?? "dialogue", status: "ok", model: response?.model ?? null,
          usage: response?.usage ?? null, latencyMs: now() - started, retryCount: response?.retryCount ?? 0, requestSeq });
        return response;
      } catch (error) {
        requests.push({ kind: options.phase ?? "dialogue", status: "error", httpStatus: Number.isInteger(error?.status) ? error.status : null,
          latencyMs: now() - started, retryCount: error?.retryCount ?? 0, requestSeq, errorCode: errorCode(error) });
        throw error;
      }
    },
  };
  const trackDecisions = (decisionClient, kind) => decisionClient && {
    async chooseAction(request) {
      const started = now(), requestSeq = currentRequestSeq;
      const purpose = ["decision_jev", "decision_luna"].includes(request?.purpose) ? request.purpose : null;
      try {
        const response = await decisionClient.chooseAction(request);
        requests.push({ kind, purpose, status: "ok", latencyMs: now() - started, requestSeq });
        return response;
      } catch (error) {
        requests.push({ kind, purpose, status: "error", latencyMs: now() - started, requestSeq, errorCode: errorCode(error) });
        throw error;
      }
    },
  };
  const dialogue = createDialogueV2({ client: trackingClient, strategy, image: { mimeType: model.mimeType, base64: model.png.toString("base64") },
    anchors: model.anchors, judge, referenceMemory, decisionShadowClient: trackDecisions(decisionShadowClient, "decision_shadow"),
    activeDecision: activeDecision && { ...activeDecision, client: trackDecisions(activeDecision.client, "decision_active") }, utteranceStyle: style,
    groundingShadow: grounding, onGroundingShadow: grounding ? (record) => { groundingRecords.push(record); } : null,
    localGrounding: local, onLocalGroundingTrace,
    ...(jev ? { decisionMode: "jev", observer: jev.observer, jevDecision: jev.jevDecision,
      ...(jev.technicalTrial ? { technicalTrial: clone(jev.technicalTrial) } : {}),
      localGrounding: jev.localGrounding, maxReobservations: jev.profile.maxReobservations,
      interventionPolicy: jev.profile.interventionPolicy, decisionTimeoutMs: jev.profile.timeouts.decisionMs,
      onJevTurnTrace: (record) => {
        jevTraces.push(clone(record));
        if (Object.values(record.aiPublic?.stages ?? {}).some(stage => stage.error === "cost_cap")) jev.ledger.stop("cost_cap");
      } } : {}),
    onResearchUpdate: () => persist().catch(() => {}) });
  // The queue must never see an uninitialized Jev state, even on a zero-turn submission.
  let initialPrivateState;
  if (jev && restore) {
    try { dialogue.snapshotGraph(restore.queueState.privateState); }
    catch { throw new NamingTaskError("invalid_options"); }
    initialPrivateState = restore.queueState.privateState;
  } else if (jev) {
    initialPrivateState = await dialogue.initializePrivateState();
    initialObservation = participantInitialObservation(jev.observer) ?? {
      audit: null, memoSha256: researchHash(initialPrivateState.observationMemo) };
  } else initialPrivateState = dialogue.initialPrivateState();
  async function timedAiTurn(input) {
    const attemptIndex = dialogue.getAttempts().length;
    const timing = { requestSeq: input.requestSeq, lastEventId: input.lastEventId, pendingEventIds: input.pendingHumanEvents.map((event) => event.id),
      startedAtMs: now(), endedAtMs: null, outcome: "running", errorCode: null, judgeAttempts: null, validationFailures: [],
      judgeFallback: false, guardRegenerated: false, guardFallback: false };
    turnTimings.push(timing);
    currentRequestSeq = input.requestSeq;
    try {
      const result = await (jev ? withParticipantJevTurn(jev.ledger, input.requestSeq, () => dialogue.runAiTurn(input)) : dialogue.runAiTurn(input));
      if (jev?.ledger.halted) throw new NamingTaskError("ai_unavailable");
      timing.outcome = "returned";
      return result;
    } catch (error) {
      timing.outcome = error?.name === "AbortError" ? "superseded" : "error";
      if (timing.outcome === "error") timing.errorCode = errorCode(error);
      throw error;
    } finally {
      timing.endedAtMs = now();
      if (currentRequestSeq === input.requestSeq) currentRequestSeq = null;
      const attempt = dialogue.getAttempts()[attemptIndex];
      if (attempt) {
        timing.judgeAttempts = Number.isSafeInteger(attempt.validation?.attempts) ? attempt.validation.attempts : null;
        timing.validationFailures = safeCodes(attempt.validation?.failures);
        timing.judgeFallback = attempt.validation?.fallback === true;
        timing.guardRegenerated = attempt.generationGuard?.regenerated === true;
        timing.guardFallback = attempt.generationGuard?.fallback === true;
      }
    }
  }
  const queue = createHumanMessageQueue({ runAiTurn: timedAiTurn,
    initialPrivateState, now,
    initialEvents: [{ speaker: "ai", text: SCRIPTED_OPENING, nonReferential: true }],
    ...(restore?.queueState ? { initialState: restore.queueState } : {}) });
  const recordId = restore?.recordId ?? randomUUID();
  const startedAt = restore?.startedAt ?? new Date(now()).toISOString();
  let humanSubmission = restore?.humanSubmission ?? null, aiSubmission = restore?.aiSubmission ?? null,
    result = restore?.scoring?.result ?? null, closed = restore?.closed ?? false,
    finalError = restore?.finalError ?? null;

  function publicEvents() {
    return queue.getSnapshot().events.map(({ id, speaker, text, at, clientId }) => ({ id, speaker, text, at,
      ...(speaker === "human" && clientId !== undefined ? { clientId } : {}) }));
  }

  // Writes are serialized; each writes the latest state.
  let writing = Promise.resolve();
  function persist() {
    const next = writing.then(writeRecord, writeRecord);
    writing = next.catch(() => {});
    return next;
  }
  async function writeRecord() {
    if (!directory && !onPersist) return;
    const snapshot = queue.getSnapshot();
    const privateState = queue.getPrivateState();
    const record = {
      recordId, version: VERSION, trialId: trial.trialId, seed, strategy, startedAt, updatedAt: new Date(now()).toISOString(),
      options: { visualAid: false, referenceMemory, decisionShadow: Boolean(decisionShadowClient), activeDecision: activeDecision?.purpose ?? null, utteranceStyle: style,
        // Present only when on, so default-off records keep their previous shape.
        ...(grounding ? { groundingShadow: true } : {}), ...(local ? { localGrounding: true } : {}),
        ...(!jev && restore?.options?.jevResearch === false ? { jevResearch: false } : {}),
        ...(jev ? { jevResearch: true, profileSha256: researchHash(jev.profile), interventionPolicy: clone(jev.profile.interventionPolicy), ...(jev.technicalTrial ? { technicalTrial: clone(jev.technicalTrial) } : {}) } : {}) },
      status: result ? "completed" : closed ? "submitting" : "dialogue",
      // Origin is research metadata only; queue/model/participant events stay ordinary public speech.
      events: snapshot.events.map((event) => event.seq === 1 && event.speaker === "ai" && event.text === SCRIPTED_OPENING
        ? { ...event, origin: "scripted_opening" } : event),
      // Same role/content shape as v1 so offline metrics apply unchanged.
      publicHistory: snapshot.events.map((e) => ({ role: e.speaker === "human" ? "user" : "assistant", content: e.text })),
      judgments: privateState.judgments, attempts: jev ? [...priorJevAttempts, ...dialogue.getAttempts()] : dialogue.getAttempts(), ownLedger: privateState.ledger,
      ...(grounding || groundingRecords.length ? { groundingShadow: clone(groundingRecords) } : {}),
      ...(referenceMemory ? { referenceGraph: dialogue.snapshotGraph(privateState) } : {}),
      ...(jev ? { jevTraces: settleJevTurnTraces(jevTraces, privateState), aiPublicSettlement: clone(aiPublicSettlement),
        initialObservation: clone(initialObservation), jevLedger: jev.ledger.snapshot() } : {}),
      humanSubmission, aiSubmission, closed, finalError,
      queueState: queue.getDurableState(), scoring: result ? { key: trial.key, result } : null, requests, turnTimings,
      diagnostics: aiSubmission ? {
        ledgerFinalMismatch: (() => { const slots = dialogue.slots.filter((s) => (privateState.ledger[s].name ?? null) !== (aiSubmission[s] ?? null)); return { count: slots.length, slots }; })(),
        ledgerStatusCounts: Object.fromEntries(STATUSES.map((status) => [status, dialogue.slots.filter((s) => privateState.ledger[s].status === status).length])),
      } : null,
    };
    if (onPersist) await onPersist(record);
    if (!directory) return;
    const temporary = join(directory, "." + recordId + ".tmp");
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (await (await import("../naming-task.mjs")).outsideRepositoryDirectory(directory) !== directory) throw new NamingTaskError("repository_output_forbidden");
      await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, join(directory, recordId + ".json"));
    } catch {
      await rm(temporary, { force: true }).catch(() => {});
      throw new NamingTaskError("record_write_failed");
    }
  }

  async function scoreIfReady() {
    if (!humanSubmission || !aiSubmission || result) return;
    const toScore = (names) => Object.fromEntries(Object.entries(names).map(([slot, name]) => [slot, name ?? ""]));
    result = clone(await scoreTrial({ key: clone(trial.key), humanSubmission: toScore(humanSubmission), aiSubmission: toScore(aiSubmission) }));
  }

  // Submissions require every human message to have been answered. An upstream
  // error leaves messages pending: the participant must retry, not lose them.
  function assertSettled() {
    const snapshot = queue.getSnapshot();
    if (snapshot.status === "error") throw new NamingTaskError("ai_retry_required");
    if (snapshot.status !== "idle" || snapshot.pendingHumanEventIds.length) throw new NamingTaskError("ai_busy");
  }
  let aiSubmitting = null;
  let settlementPromise = null;
  function settlePublicOnce() {
    if (!jev || aiPublicSettlement !== null) return Promise.resolve();
    settlementPromise ??= Promise.resolve().then(() => settleAiPublicClaims(jevTraces, queue.getPrivateState()))
      .then(records => { aiPublicSettlement = { status: "ok", records }; },
        () => { aiPublicSettlement = { status: "error", code: "settlement_failed" }; });
    return settlementPromise;
  }

  await persist();
  return {
    version: VERSION,
    /** Accept a human message immediately, even while the AI is thinking. */
    message(text, clientId) {
      if (closed) throw new NamingTaskError("dialogue_closed");
      if (typeof text !== "string" || !text.trim() || text.length > 2000) throw new NamingTaskError("invalid_message");
      const receipt = queue.enqueue({ clientId, text: text.trim() });
      queue.whenIdle().then(() => persist()).catch(() => {});
      return { eventId: receipt.event.id, duplicate: receipt.duplicate };
    },
    async whenIdle() { await queue.whenIdle(); await persist(); },
    async persistNow() { await persist(); },
    async retry() { await queue.retry(); await persist(); },
    getState() {
      const snapshot = queue.getSnapshot();
      return clone({
        // No seed or seed-derived trial id: either would let a client regenerate the boards and key.
        version: VERSION, sessionId: recordId, scene,
        events: publicEvents(),
        aiStatus: snapshot.status === "pending" || snapshot.status === "processing" ? "thinking" : snapshot.status === "error" ? "error" : "idle",
        submitted: humanSubmission !== null, aiSubmitted: aiSubmission !== null, closed,
        status: result ? "completed" : closed ? "submitting" : "dialogue",
        busy: snapshot.status === "pending" || snapshot.status === "processing",
        // Participant-facing result: own slots and names only, never figure ids.
        ...(result ? { result: { provisional: result.provisional, success: result.success, matchedCount: result.matchedCount, total: result.total,
          figures: result.figures.map(({ human, ai, matched }) => ({ human: { slot: human.slot, rawName: human.rawName }, ai: { rawName: ai.rawName }, matched })) } } : {}),
        ...(finalError ? { finalError } : {}),
      });
    },
    async submitHuman({ names }) {
      if (humanSubmission) throw new NamingTaskError("already_submitted");
      const valid = validateNamesV2(names, humanSlots);
      // Never close over unanswered messages: the participant waits for the reply.
      if (!closed) assertSettled();
      closed = true;
      queue.close();
      humanSubmission = valid;
      await settlePublicOnce();
      try { await scoreIfReady(); } catch { finalError = "scoring_error"; await persist(); throw new NamingTaskError("scoring_error"); }
      await persist();
      return { submitted: true };
    },
    submitAI() {
      // Concurrent calls share one final request.
      aiSubmitting ??= submitAIOnce().finally(() => { aiSubmitting = null; });
      return aiSubmitting;
    },
    // Researcher-only; never returned over the participant API.
    researcherView() { return { key: clone(trial.key), privateState: queue.getPrivateState(), attempts: jev ? [...priorJevAttempts, ...dialogue.getAttempts()] : dialogue.getAttempts(),
      groundingShadow: clone(groundingRecords) }; },
  };

  async function submitAIOnce() {
    if (aiSubmission) { await scoreIfReady(); await persist(); return { submitted: true }; }
    // Let an in-flight reply settle so the final request sees every answered message.
    await queue.whenIdle();
    if (!closed) assertSettled();
    closed = true;
    queue.close();
    const snapshot = { events: queue.getSnapshot().events, privateState: queue.getPrivateState() };
    for (let attempt = 0; attempt < 2 && !aiSubmission; attempt++) {
      let response;
      try { response = await dialogue.finalRequest(snapshot, attempt > 0); }
      catch { finalError = "ai_unavailable"; await persist(); throw new NamingTaskError("ai_unavailable"); }
      aiSubmission = parseAiNamesV2(response.text, dialogue.slots);
    }
    if (!aiSubmission) { finalError = "submission_error"; await persist(); throw new NamingTaskError("submission_error"); }
    finalError = null;
    try { await scoreIfReady(); } catch { finalError = "scoring_error"; await persist(); throw new NamingTaskError("scoring_error"); }
    await persist();
    return { submitted: true };
  }
}
