import { ParticipantUsageLedger } from '../web/participant-usage.ts';
import { PARTICIPANT_USAGE_ONLY } from '../web/participant-usage-policy.ts';
// v2 naming task: scattered unlabeled boards with opaque per-side ids, immediate
// asynchronous human messages, and private submissions scored only after both
// sides submit. The participant sees only their own scene and public events;
// the model sees only its own image, own anchors and public events.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createTrialV2, participantView, modelView, ROTATION_MODES, trialStimulusV2 } from "../stimuli/scatter-v2.mjs";
import { resolveFigureSelection, validateResolvedFigureSelection } from "../stimuli/figure-bank.ts";
import { scoreTrial as defaultScoreTrial, normalizeName } from "../scoring.mjs";
import { createHumanMessageQueue } from "../web/human-message-queue.mjs";
import { createDialogueV2 } from "./dialogue-v2.mjs";
import { NamingTaskError } from "../naming-error.mjs";
import { STRATEGIES } from "../judgment/instructions.mjs";
import { STATUSES } from "../judgment/schema.mjs";
import { normalizeName as normalizeAgreedName } from "../judgment/name-evidence.mjs";
import { selectParticipantJev, participantLunaClient, withParticipantJevTurn, restoreParticipantJevLedger,
  participantInitialObservation } from "../web/participant-jev-wiring.ts";
import { allowsOrientationFallback, hasVersionedViewpoint } from "./generation-guard.ts";
import { researchHash } from "./research-profile.ts";
import { agreedNamesFromLedger, settleJevTurnTraces, settleAiPublicClaims } from "./jev-turn.ts";

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

const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/**
 * The rotation a trial uses. A restore keeps the mode its record was generated with; only a record
 * written before the field existed (no own options.rotationMode) is relative_pm90. A restore never
 * takes the caller's mode.
 */
function trialRotation(restore, rotationMode) {
  if (!restore) {
    if (!ROTATION_MODES.includes(rotationMode)) throw new NamingTaskError("invalid_options");
    return { mode: rotationMode, legacy: false };
  }
  if (!plain(restore.options)) throw new NamingTaskError("invalid_options");
  if (!Object.hasOwn(restore.options, "rotationMode")) {
    if (Object.hasOwn(restore, "stimulus")) throw new NamingTaskError("invalid_options");
    return { mode: "relative_pm90", legacy: true };
  }
  if (!ROTATION_MODES.includes(restore.options.rotationMode)) throw new NamingTaskError("invalid_options");
  return { mode: restore.options.rotationMode, legacy: false };
}

const FIGURE_STIMULUS_KEYS = ["bankVersion", "figureSetId", "figureIds", "selectionSeed", "selectionMode"];
/**
 * The figure selection a trial uses. undefined (a new trial without one, or an older record) keeps the exact
 * previous behavior and record shape. A restore takes only its own recorded selection, never the caller's.
 */
function trialFigures(restore, figureSelection, rotation) {
  try {
    if (!restore) {
      if (figureSelection === undefined) return null;
      return plain(figureSelection) && Object.hasOwn(figureSelection, "bankVersion")
        ? validateResolvedFigureSelection(figureSelection) : resolveFigureSelection(figureSelection);
    }
    if (!Object.hasOwn(restore.options, "figureSelection")) {
      if (plain(restore.stimulus) && FIGURE_STIMULUS_KEYS.some((key) => Object.hasOwn(restore.stimulus, key))) throw new Error("figures without selection");
      return null;
    }
    if (rotation.legacy) throw new Error("selection without rotation");
    return validateResolvedFigureSelection(restore.options.figureSelection);
  } catch { throw new NamingTaskError("invalid_options"); }
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
 *   utteranceStyle?: string, rotationMode?: string, groundingShadow?: import('./grounding-shadow.ts').GroundingShadowOptions | null,
 *   localGrounding?: import('../local-grounding/contract.ts').LocalGroundingOptions | null,
 *   jevResearch?: import('../web/participant-jev-wiring.ts').JevResearchOptions<import('../web/participant-jev-wiring.ts').JevResearchLedger> | null,
 *   onLocalGroundingTrace?: ((record: import('./local-grounding-turn.ts').LocalGroundingResearchRecord) => unknown) | null }} options
 *   groundingShadow is a researcher-only, default-off shadow; a restored trial keeps it only if it started with it.
 */
export async function createNamingTaskV2({
  client, strategy, seed, referenceMemory = true, runDir = process.env.RESEARCH_RUN_DIR,
  createTrial = createTrialV2, scoreTrial = defaultScoreTrial, judge = null, now = () => Date.now(),
  restore = null, onPersist = null, onPersistFailure = null, onPersistSlow = null, decisionShadowClient = null, activeDecision = null, utteranceStyle = "default",
  groundingShadow = null, localGrounding = null, onLocalGroundingTrace = null, jevResearch = null, rotationMode = "relative_pm90", figureSelection = undefined,
}) {
  // Checked before any generation, observation or persist.
  const rotation = trialRotation(restore, rotationMode);
  const figures = trialFigures(restore, figureSelection, rotation);
  // Restored trials retain their recorded condition, including legacy memory-off trials.
  if (restore) referenceMemory = restore.options?.referenceMemory === undefined ? false : restore.options.referenceMemory;
  const style = restore?.options?.utteranceStyle ?? utteranceStyle;
  const jev = selectParticipantJev(restore, jevResearch, { referenceMemory, strategy, style,
    legacy: [localGrounding, activeDecision, decisionShadowClient, groundingShadow] });
  const dialogueRecoveryEnabled = !!jev && !allowsOrientationFallback(jev.generationRetryVersion);
  let dialogueInterruption = restore?.dialogueInterruption;
  if (restore && Object.hasOwn(restore, "dialogueInterruption") &&
      (!dialogueRecoveryEnabled || !["participant_paused", "budget_exhausted"].includes(dialogueInterruption) ||
        restore.status !== "dialogue" || restore.queueState?.closed !== false ||
        restore.queueState?.errorCode !== "ai_unavailable" ||
        !Array.isArray(restore.queueState.pendingHumanEventIds) || !restore.queueState.pendingHumanEventIds.length)) {
    throw new NamingTaskError("invalid_options");
  }
  if (!STRATEGIES.includes(strategy)) throw new NamingTaskError("invalid_strategy");
  // Luna records keep their attempts across restores; a malformed list is refused, never replaced.
  if (restore && !jev && Object.hasOwn(restore, "attempts") && !Array.isArray(restore.attempts)) throw new NamingTaskError("invalid_options");
  if (!Number.isSafeInteger(seed)) throw new NamingTaskError("invalid_seed");
  if (typeof referenceMemory !== "boolean") throw new NamingTaskError("invalid_options");
  // A restored trial keeps the style it started with, whatever the deployment now says.
  if (!["default", "concise"].includes(style)) throw new NamingTaskError("invalid_options");
  // Shadow records are private research data; they survive restore with the record.
  const grounding = restore && restore.options?.groundingShadow !== true ? null : groundingShadow;
  const local = restore && restore.options?.localGrounding !== true ? null : localGrounding;
  const groundingRecords = Array.isArray(restore?.groundingShadow) ? clone(restore.groundingShadow) : [];
  const directory = runDir ? await (await import("../naming-task.mjs")).outsideRepositoryDirectory(runDir) : null;
  const trial = createTrial({ seed, rotationMode: rotation.mode, ...(figures ? { figureSelection: figures } : {}) });
  // Generation-time angles; a restored record must match what is shown again.
  const stimulus = trialStimulusV2(trial);
  if (!stimulus || stimulus.rotationMode !== rotation.mode) throw new NamingTaskError("invalid_options");
  if (restore && !rotation.legacy && (JSON.stringify(restore.stimulus) !== JSON.stringify(stimulus) || restore.trialId !== trial.trialId)) {
    throw new NamingTaskError("invalid_options");
  }
  const scene = participantView(trial);
  const model = modelView(trial);
  const humanSlots = scene.shapes.map((shape) => shape.id);
  const requests = restore?.requests ? clone(restore.requests) : [];
  // Private per-attempt timings; they survive restore with the record.
  const turnTimings = Array.isArray(restore?.turnTimings) ? clone(restore.turnTimings) : [];
  const jevTraces = jev && restore ? clone(restore.jevTraces) : [];
  // Attempts recorded before a restore; this construction's dialogue starts its own list from empty.
  const priorAttempts = Array.isArray(restore?.attempts) ? clone(restore.attempts) : [];
  const allAttempts = () => [...clone(priorAttempts), ...dialogue.getAttempts()];
  let aiPublicSettlement = jev && restore ? clone(restore.aiPublicSettlement) : null;
  let initialObservation = jev && restore ? clone(restore.initialObservation) : null;
  const usage = jev?.ledger instanceof ParticipantUsageLedger ? jev.ledger : null;
  if (jev && restore && !usage) restoreParticipantJevLedger(jev.ledger, restore.jevLedger);
  if (dialogueInterruption === "budget_exhausted" && (usage || !jev?.ledger.stopReason())) throw new NamingTaskError("invalid_options");
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
      localGrounding: jev.localGrounding, ...(usage ? { usagePolicy: PARTICIPANT_USAGE_ONLY } : {}), maxReobservations: jev.profile.maxReobservations,
      rotationMode: rotation.mode,
      interventionPolicy: jev.profile.interventionPolicy, decisionTimeoutMs: jev.profile.timeouts.decisionMs,
      ...(jev.profile.questionLayout !== "two_stage_v1" ? { questionLayout: jev.profile.questionLayout } : {}),
      ...(jev.profile.dialoguePolicy ? { dialoguePolicy: jev.profile.dialoguePolicy } : {}),
      generationRetryVersion: jev.generationRetryVersion,
      newTrialAgreeNameScopeVersion: jev.newTrialAgreeNameScopeVersion,
      onJevTurnTrace: (record) => {
        jevTraces.push(clone(record));
        if (!usage && Object.values(record.aiPublic?.stages ?? {}).some(stage => stage.error === "cost_cap")) jev.ledger.stop("cost_cap");
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
      if (usage) await persist(); // Ensure the accepted input and clientId are durable before any RPC.
      const result = await (usage ? usage.runTurn(input.lastEventId, input.signal, () => dialogue.runAiTurn(input)) : jev ? withParticipantJevTurn(jev.ledger, input.requestSeq, () => dialogue.runAiTurn(input)) : dialogue.runAiTurn(input));
      if (jev?.ledger.halted) throw new NamingTaskError("ai_unavailable");
      if (jev?.namingRestoreVersion) {
        const trace = jevTraces.at(-1);
        if (trace?.status === "staged" && trace.lastEventId === input.lastEventId && trace.aiPublic) {
          const application = trace.aiPublic.application;
          const nameIds = new Set(application.nameIds);
          // Keep the dependencies before a later turn can prune them. The usual trace settlement still identifies the committed attempt.
          application.nameAcceptances = result.privateState.graph.records
            .filter(claim => claim.kind === "claim" && claim.act === "name_accept" && nameIds.has(claim.id))
            .map(({ id, respondsTo }) => ({ id, respondsTo }));
        }
      }
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
  let initialQueue = restore?.queueState;
  if (initialQueue && usage?.needsExplicitRetry(initialQueue.pendingHumanEventIds.at(-1))) {
    // A restored POST may already have reached the provider. Reuse the existing queue error/retry path.
    initialQueue = { ...initialQueue, errorCode: 'ai_unavailable' };
  }
  const queue = createHumanMessageQueue({ runAiTurn: timedAiTurn,
    initialPrivateState, now,
    initialEvents: [{ speaker: "ai", text: SCRIPTED_OPENING, nonReferential: true }],
    ...(initialQueue ? { initialState: initialQueue } : {}) });
  const recordId = restore?.recordId ?? randomUUID();
  const startedAt = restore?.startedAt ?? new Date(now()).toISOString();
  let humanSubmission = restore?.humanSubmission ?? null, aiSubmission = restore?.aiSubmission ?? null,
    result = restore?.scoring?.result ?? null, closed = restore?.closed ?? false,
    finalError = restore?.finalError ?? null;

  function publicEvents() {
    return queue.getSnapshot().events.map(({ id, speaker, text, at, clientId }) => ({ id, speaker, text, at,
      ...(speaker === "human" && clientId !== undefined ? { clientId } : {}) }));
  }

  // A stopped generation retains the queue, including on a process restore.
  function markBudgetInterruption(snapshot) {
    if (!dialogueRecoveryEnabled || usage || snapshot.status !== "error") return;
    const reason = jev.ledger.stopReason();
    if (!reason) return;
    dialogueInterruption = "budget_exhausted";
    if (!jev.ledger.halted) jev.ledger.stop(reason);
  }

  // Writes are serialized; each writes the latest state.
  let writing = Promise.resolve();
  // A failed write used to vanish: its callers (a finished turn, a research update) discard the rejection. Each failure is kept as a closed code and a time,
  // reported once to onPersistFailure (the server's standard error), and carried in the next record that is written (research metadata, never shown to a participant).
  const PERSIST_FAILURE_LIMIT = 20;
  const PERSIST_CODES = new Set(["record_build_failed", "record_store_rejected", "record_invalid", "owner_expired", "record_write_failed"]);
  // Sub-reasons of record_store_rejected (a store rejection folds several causes into one error code).
  const PERSIST_REASONS = new Set(["cas_conflict", "owner_expired", "record_deleted", "owner_state_invalid", "store_invalid", "store_io", "size_limit", "store_unknown",
    // Sub-reasons of record_build_failed: the record's own assembly threw before any write.
    "build_state_invalid", "build_graph_invalid", "build_clone_failed", "build_unknown"]);
  // Closed classification of a build exception; never its message, stack or text.
  function buildReason(error) {
    try {
      if (error?.name === "DataCloneError") return "build_clone_failed";
      const code = error?.code;
      if (code === "invalid_state") return "build_state_invalid";
      if (["invalid_graph", "missing_provenance", "future_antecedent", "invalid_retraction", "capacity_exceeded", "invalid_record", "duplicate_id"].includes(code)) return "build_graph_invalid";
    } catch { /* A hostile getter is unknown. */ }
    return "build_unknown";
  }
  const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
  // A restored history is accepted only in the closed form this code writes.
  const persistFailures = Array.isArray(restore?.persistFailures) ? restore.persistFailures.filter((entry) =>
    entry && PERSIST_CODES.has(entry.code) && typeof entry.at === "string" && ISO_TIME.test(entry.at) && Number.isFinite(Date.parse(entry.at)))
    .slice(-PERSIST_FAILURE_LIMIT).map(({ code, at, reason }) => ({ code, at, ...(PERSIST_REASONS.has(reason) ? { reason } : {}) })) : [];
  let persistStage = "build";
  function persistFailureFields(error) {
    if (persistStage === "build") return { code: "record_build_failed", reason: buildReason(error) };
    switch (error?.code) {
      case "trial_unavailable": return { code: "record_store_rejected", reason: PERSIST_REASONS.has(error?.reason) ? error.reason : "store_unknown" };
      case "assignment_record_invalid": return { code: "record_invalid" };
      case "owner_expired": return { code: "owner_expired" };
      default: return { code: "record_write_failed" };
    }
  }
  function notePersistFailure(error) {
    let at;
    try { at = new Date(now()).toISOString(); } catch { at = new Date(0).toISOString(); }
    const failure = { ...persistFailureFields(error), at };
    persistFailures.push(failure);
    if (persistFailures.length > PERSIST_FAILURE_LIMIT) persistFailures.splice(0, persistFailures.length - PERSIST_FAILURE_LIMIT);
    try { if (typeof onPersistFailure === "function") onPersistFailure({ ...failure }); } catch { /* A reporting failure never changes the write's outcome. */ }
  }
  async function guardedWrite() {
    persistStage = "build";
    try { await writeRecord(); } catch (error) { notePersistFailure(error); throw error; }
  }
  // Writes are serialized, and each one writes the latest state at the moment it starts. So at most one write needs to wait behind the running one:
  // a persist() that arrives while a write is queued but not started joins it (the state it asked to save is written by that very write).
  // A call that arrives after a write has started queues a new one, so a change made after the start is still written afterwards.
  // Every caller still gets the outcome of a write that began after its call; a failed write rejects all of its callers, as before.
  let queuedWrite = null;
  const PERSIST_SLOW_MS = 10000;
  // A call that joined a queued write used to have a write of its own. If the shared write fails, each joined call therefore gets one more attempt (all of them together,
  // in one further write), so a transient failure cannot leave the latest state unwritten just because several calls had merged; a failure of that attempt is final.
  function persist(retryOnFailure = true) {
    if (queuedWrite) {
      queuedWrite.joined++;
      const shared = queuedWrite.promise;
      return retryOnFailure ? shared.catch(() => persist(false)) : shared;
    }
    const entry = { joined: 0, queuedAt: now(), promise: null };
    const run = async () => {
      queuedWrite = null;                                  // started: later calls queue the next write
      const startedAt = now();
      try { await guardedWrite(); }
      finally {
        const waited = startedAt - entry.queuedAt, took = now() - startedAt;
        if ((waited >= PERSIST_SLOW_MS || took >= PERSIST_SLOW_MS) && typeof onPersistSlow === "function") {
          try { onPersistSlow({ waitedMs: Math.max(0, Math.round(waited)), tookMs: Math.max(0, Math.round(took)), joined: entry.joined }); } catch { /* diagnostics only */ }
        }
      }
    };
    entry.promise = writing.then(run, run);
    queuedWrite = entry;
    writing = entry.promise.catch(() => {});
    return entry.promise;
  }
  async function writeRecord() {
    if (!directory && !onPersist) return;
    const snapshot = queue.getSnapshot();
    markBudgetInterruption(snapshot);
    const privateState = queue.getPrivateState();
    const record = {
      recordId, version: VERSION, trialId: trial.trialId, seed, strategy, startedAt, updatedAt: new Date(now()).toISOString(),
      options: { visualAid: false, referenceMemory, decisionShadow: Boolean(decisionShadowClient), activeDecision: activeDecision?.purpose ?? null, utteranceStyle: style,
        // Legacy records keep their original shape; they never gain rotation fields on restore.
        ...(rotation.legacy ? {} : { rotationMode: rotation.mode }),
        // Present only for a trial that selected figures, so earlier records keep their shape.
        ...(figures ? { figureSelection: clone(figures) } : {}),
        // Present only when on, so default-off records keep their previous shape.
        ...(grounding ? { groundingShadow: true } : {}), ...(local ? { localGrounding: true } : {}),
        ...(!jev && restore?.options?.jevResearch === false ? { jevResearch: false } : {}),
        ...(jev ? { jevResearch: true, profileSha256: researchHash(jev.profile), interventionPolicy: clone(jev.profile.interventionPolicy), ...(jev.technicalTrial ? { technicalTrial: clone(jev.technicalTrial) } : {}),
          // two_stage_v2 records name their layout; two_stage_v1 records keep their previous shape.
          ...(jev.profile.questionLayout !== "two_stage_v1" ? { questionLayout: jev.profile.questionLayout } : {}),
          // The policy a new two_stage_v3 trial was created with; a record without one never gains it.
          ...(jev.profile.dialoguePolicy ? { dialoguePolicy: jev.profile.dialoguePolicy } : {}),
          ...(jev.namingRestoreVersion ? { jevNamingRestoreVersion: jev.namingRestoreVersion } : {}),
          ...(hasVersionedViewpoint(jev.generationRetryVersion) ? { generationRetryVersion: jev.generationRetryVersion } : {}) } : {}) },
      ...(rotation.legacy ? {} : { stimulus: clone(stimulus) }),
      status: result ? "completed" : closed ? "submitting" : "dialogue",
      // Origin is research metadata only; queue/model/participant events stay ordinary public speech.
      events: snapshot.events.map((event) => event.seq === 1 && event.speaker === "ai" && event.text === SCRIPTED_OPENING
        ? { ...event, origin: "scripted_opening" } : event),
      // Same role/content shape as v1 so offline metrics apply unchanged.
      publicHistory: snapshot.events.map((e) => ({ role: e.speaker === "human" ? "user" : "assistant", content: e.text })),
      judgments: privateState.judgments, attempts: allAttempts(), ownLedger: privateState.ledger,
      ...(grounding || groundingRecords.length ? { groundingShadow: clone(groundingRecords) } : {}),
      ...(referenceMemory ? { referenceGraph: dialogue.snapshotGraph(privateState) } : {}),
      ...(jev ? { jevTraces: settleJevTurnTraces(jevTraces, privateState), aiPublicSettlement: clone(aiPublicSettlement),
        initialObservation: clone(initialObservation), jevLedger: jev.ledger.snapshot() } : {}),
      humanSubmission, aiSubmission, closed, finalError,
      ...(dialogueInterruption ? { dialogueInterruption } : {}),
      ...(persistFailures.length ? { persistFailures: persistFailures.map((entry) => ({ ...entry })) } : {}),
      queueState: queue.getDurableState(), scoring: result ? { key: trial.key, result } : null, requests, turnTimings,
      diagnostics: aiSubmission ? {
        ledgerFinalMismatch: (() => { const slots = dialogue.slots.filter((s) => (privateState.ledger[s].name ?? null) !== (aiSubmission[s] ?? null)); return { count: slots.length, slots }; })(),
        ledgerStatusCounts: Object.fromEntries(STATUSES.map((status) => [status, dialogue.slots.filter((s) => privateState.ledger[s].status === status).length])),
      } : null,
    };
    persistStage = "write";
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

  let recoveryInFlight = null;
  async function resumePendingDialogue() {
    const snapshot = queue.getSnapshot();
    if (snapshot.status !== "error") return;
    markBudgetInterruption(snapshot);
    if (dialogueInterruption !== "budget_exhausted") {
      dialogueInterruption = undefined;
      await queue.retry();
    }
    await persist();
  }

  await persist();
  return {
    version: VERSION,
    /** Accept a human message immediately, even while the AI is thinking. */
    message(text, clientId) {
      if (closed) throw new NamingTaskError("dialogue_closed");
      if (typeof text !== "string" || !text.trim() || text.length > 2000) throw new NamingTaskError("invalid_message");
      if (dialogueRecoveryEnabled) {
        const snapshot = queue.getSnapshot();
        const duplicate = clientId !== undefined && snapshot.events.some(event => event.clientId === clientId);
        if (snapshot.status === "error" && !duplicate) throw new NamingTaskError("ai_retry_required");
      }
      const receipt = queue.enqueue({ clientId, text: text.trim() });
      queue.whenIdle().then(() => persist()).catch(() => {});
      return { eventId: receipt.event.id, duplicate: receipt.duplicate };
    },
    async whenIdle() { await queue.whenIdle(); await persist(); },
    async persistNow() { await persist(); },
    async retry() {
      if (!dialogueRecoveryEnabled) { await queue.retry(); await persist(); return; }
      recoveryInFlight ??= resumePendingDialogue().finally(() => { recoveryInFlight = null; });
      await recoveryInFlight;
    },
    async interruptDialogue() {
      const snapshot = queue.getSnapshot();
      if (!dialogueRecoveryEnabled || snapshot.status !== "error" || recoveryInFlight) throw new NamingTaskError("ai_busy");
      markBudgetInterruption(snapshot);
      dialogueInterruption ??= "participant_paused";
      await persist();
    },
    getState() {
      const snapshot = queue.getSnapshot();
      const recovery = snapshot.status !== "error" ? "active" : dialogueRecoveryEnabled && !usage && jev.ledger.stopReason() ? "unavailable" :
        dialogueInterruption === "participant_paused" ? "paused" : "retry";
      return clone({
        // No seed or seed-derived trial id: either would let a client regenerate the boards and key.
        version: VERSION, sessionId: recordId, scene,
        events: publicEvents(),
        aiStatus: snapshot.status === "pending" || snapshot.status === "processing" ? "thinking" : snapshot.status === "error" ? "error" : "idle",
        submitted: humanSubmission !== null, aiSubmitted: aiSubmission !== null, closed,
        ...(dialogueRecoveryEnabled ? { dialogueRecovery: recovery } : {}),
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
    researcherView() { return { key: clone(trial.key), privateState: queue.getPrivateState(), attempts: allAttempts(),
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
    const agreed = jev?.profile.questionLayout === "two_stage_v3"
      ? Object.entries(agreedNamesFromLedger(snapshot.privateState.ledger)) : [];
    for (let attempt = 0; attempt < 2 && !aiSubmission; attempt++) {
      let response;
      try { response = await dialogue.finalRequest(snapshot, attempt > 0); }
      catch { finalError = "ai_unavailable"; await persist(); throw new NamingTaskError("ai_unavailable"); }
      const names = parseAiNamesV2(response.text, dialogue.slots);
      if (names && agreed.every(([slot, name]) => normalizeAgreedName(names[slot]) === normalizeAgreedName(name))) {
        aiSubmission = names;
      }
    }
    if (!aiSubmission) { finalError = "submission_error"; await persist(); throw new NamingTaskError("submission_error"); }
    finalError = null;
    try { await scoreIfReady(); } catch { finalError = "scoring_error"; await persist(); throw new NamingTaskError("scoring_error"); }
    await persist();
    return { submitted: true };
  }
}
