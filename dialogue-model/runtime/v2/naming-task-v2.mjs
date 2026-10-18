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
import { outsideRepositoryDirectory, NamingTaskError } from "../naming-task.mjs";
import { STRATEGIES } from "../judgment/instructions.mjs";
import { STATUSES } from "../judgment/schema.mjs";

export const VERSION = 2;
const SCRIPTED_OPENING = "まず、どの図形から話しましょうか？";
const NAME_LIMIT = 200;
const clone = (value) => structuredClone(value);

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

export async function createNamingTaskV2({
  client, strategy, seed, referenceMemory = false, runDir = process.env.RESEARCH_RUN_DIR,
  createTrial = createTrialV2, scoreTrial = defaultScoreTrial, judge = null, now = () => Date.now(),
}) {
  if (!STRATEGIES.includes(strategy)) throw new NamingTaskError("invalid_strategy");
  if (!Number.isSafeInteger(seed)) throw new NamingTaskError("invalid_seed");
  if (typeof referenceMemory !== "boolean") throw new NamingTaskError("invalid_options");
  const directory = runDir ? await outsideRepositoryDirectory(runDir) : null;
  const trial = createTrial({ seed });
  const scene = participantView(trial);
  const model = modelView(trial);
  const humanSlots = scene.shapes.map((shape) => shape.id);
  const requests = [];
  const trackingClient = {
    async complete(messages, options = {}) {
      const started = now();
      try {
        const response = await client.complete(messages, options);
        requests.push({ kind: options.phase ?? "dialogue", status: "ok", model: response?.model ?? null,
          usage: response?.usage ?? null, latencyMs: now() - started, retryCount: response?.retryCount ?? 0 });
        return response;
      } catch (error) {
        requests.push({ kind: options.phase ?? "dialogue", status: "error", httpStatus: Number.isInteger(error?.status) ? error.status : null,
          latencyMs: now() - started, retryCount: error?.retryCount ?? 0 });
        throw error;
      }
    },
  };
  const dialogue = createDialogueV2({ client: trackingClient, strategy, image: { mimeType: model.mimeType, base64: model.png.toString("base64") },
    anchors: model.anchors, judge, referenceMemory });
  const queue = createHumanMessageQueue({ runAiTurn: dialogue.runAiTurn, initialPrivateState: dialogue.initialPrivateState(),
    now, initialEvents: [{ speaker: "ai", text: SCRIPTED_OPENING, nonReferential: true }] });
  const recordId = randomUUID();
  const startedAt = new Date(now()).toISOString();
  let humanSubmission = null, aiSubmission = null, result = null, closed = false, finalError = null;

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
    if (!directory) return;
    const snapshot = queue.getSnapshot();
    const privateState = queue.getPrivateState();
    const record = {
      recordId, version: VERSION, trialId: trial.trialId, seed, strategy, startedAt, updatedAt: new Date(now()).toISOString(),
      options: { visualAid: false, referenceMemory },
      status: result ? "completed" : closed ? "submitting" : "dialogue",
      // Origin is research metadata only; queue/model/participant events stay ordinary public speech.
      events: snapshot.events.map((event) => event.seq === 1 ? { ...event, origin: "scripted_opening" } : event),
      // Same role/content shape as v1 so offline metrics apply unchanged.
      publicHistory: snapshot.events.map((e) => ({ role: e.speaker === "human" ? "user" : "assistant", content: e.text })),
      judgments: privateState.judgments, attempts: dialogue.getAttempts(), ownLedger: privateState.ledger,
      ...(referenceMemory ? { referenceGraph: dialogue.snapshotGraph(privateState) } : {}),
      humanSubmission, aiSubmission, scoring: result ? { key: trial.key, result } : null, requests,
      diagnostics: aiSubmission ? {
        ledgerFinalMismatch: (() => { const slots = dialogue.slots.filter((s) => (privateState.ledger[s].name ?? null) !== (aiSubmission[s] ?? null)); return { count: slots.length, slots }; })(),
        ledgerStatusCounts: Object.fromEntries(STATUSES.map((status) => [status, dialogue.slots.filter((s) => privateState.ledger[s].status === status).length])),
      } : null,
    };
    const temporary = join(directory, "." + recordId + ".tmp");
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (await outsideRepositoryDirectory(directory) !== directory) throw new NamingTaskError("repository_output_forbidden");
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
    researcherView() { return { key: clone(trial.key), privateState: queue.getPrivateState(), attempts: dialogue.getAttempts() }; },
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
