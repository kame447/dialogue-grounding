import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat, writeFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, parse, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createDialogueSession, STRATEGIES } from "./session.mjs";
import { createLunaJudge } from "./judgment/luna.mjs";
import { STATUSES } from "./judgment/schema.mjs";
import { SLOTS } from "./stimuli/board.mjs";
import { createOwnImageRotationSheet } from "./visual/own-image-rotation.mjs";

// Fixed participant-facing coordinates, never figure identities.
export { SLOTS, STRATEGIES };
const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FINAL_INSTRUCTIONS = [
  "【実験環境からの非公開最終提出要求。対話相手の発話ではありません】",
  "対話は終了しました。自分自身の画像と公開対話履歴だけから、あなた自身の画面上の6位置に付ける最終名称を提出してください。",
  'JSONオブジェクトだけを返してください。キーは「上段左」「上段中」「上段右」「下段左」「下段中」「下段右」の6つで、値は名称の文字列です。未命名は空文字列にしてください。',
  "説明、Markdown、追加キーは含めないでください。相手の画面上の位置を回答しないでください。",
].join("\n");

export class NamingTaskError extends Error {
  constructor(code) {
    super("Naming task failed: " + code);
    this.name = "NamingTaskError";
    this.code = code;
  }
}

export function validateSubmission(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== SLOTS.length ||
      !SLOTS.every((slot) => Object.hasOwn(value, slot) && typeof value[slot] === "string" && value[slot].length <= 200)) {
    throw new NamingTaskError("invalid_submission");
  }
  return Object.fromEntries(SLOTS.map((slot) => [slot, value[slot].trim()]));
}

async function canonicalDestination(path) {
  let ancestor = resolve(path);
  const tail = [];
  for (;;) {
    try { return resolve(await realpath(ancestor), ...tail.reverse()); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (ancestor === parse(ancestor).root) throw error;
      tail.push(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
}

// Refuse ignored directories as well as symlinks back into any Git worktree.
export async function outsideRepositoryDirectory(path) {
  if (typeof path !== "string" || !path.trim()) throw new NamingTaskError("invalid_output_directory");
  const destination = await canonicalDestination(path);
  const repository = await realpath(REPOSITORY);
  const rel = relative(repository, destination);
  if (!rel || (!rel.startsWith("../") && rel !== ".." && !isAbsolute(rel))) {
    throw new NamingTaskError("repository_output_forbidden");
  }
  for (let cursor = destination;; cursor = dirname(cursor)) {
    try {
      await stat(join(cursor, ".git"));
      throw new NamingTaskError("repository_output_forbidden");
    } catch (error) {
      if (error instanceof NamingTaskError) throw error;
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
    if (cursor === dirname(cursor)) break;
  }
  return destination;
}

function clone(value) { return structuredClone(value); }
function tokenCount(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function httpStatus(value) { return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null; }

export async function createNamingTask({
  client, strategy, seed, createTrial, scoreTrial, createJudge = createLunaJudge, runDir = process.env.RESEARCH_RUN_DIR,
  visualAid = false, referenceMemory = false,
} = {}) {
  if (!STRATEGIES.includes(strategy)) throw new NamingTaskError("invalid_strategy");
  if (!Number.isSafeInteger(seed)) throw new NamingTaskError("invalid_seed");
  if (typeof visualAid !== "boolean" || typeof referenceMemory !== "boolean") throw new NamingTaskError("invalid_options");
  if (!createTrial) ({ createTrial } = await import("./stimuli/board.mjs"));
  if (!scoreTrial) ({ scoreTrial } = await import("./scoring.mjs"));
  let directory;
  if (runDir !== undefined && runDir !== "") directory = await outsideRepositoryDirectory(runDir);
  const trial = await createTrial({ seed });
  if (!trial || !Buffer.isBuffer(trial.ai?.png) || !Buffer.isBuffer(trial.human?.png) ||
      trial.ai.mimeType !== "image/png" || trial.human.mimeType !== "image/png" || !trial.key) {
    throw new NamingTaskError("invalid_trial");
  }
  let rotationImage = null;
  if (visualAid) {
    try {
      const sheet = createOwnImageRotationSheet(trial.ai.png, { enabled: true });
      rotationImage = { mimeType: sheet.mimeType, base64: sheet.png.toString("base64") };
    } catch { throw new NamingTaskError("invalid_trial"); }
  }
  const recordId = randomUUID();
  const requests = [];
  const meteredClient = {
    async complete(messages, options = {}) {
      const started = performance.now();
      // Leave room for the client's fixed envelope under the Worker's 18 MiB
      // cap. Each own-image message has only text + image, below four parts.
      if (visualAid && Buffer.byteLength(JSON.stringify({ purpose: "dialogue_turn", messages })) > 18 * 1024 * 1024 - 1024) {
        throw new NamingTaskError("request_too_large");
      }
      try {
        const response = await client.complete(messages);
        requests.push({ kind: options.phase ?? (closed ? "final_submission" : "dialogue_turn"), status: "ok",
          httpStatus: null,
          retryCount: tokenCount(response.retryCount) ?? 0, timeoutMs: tokenCount(response.timeoutMs),
          model: typeof response.model === "string" ? response.model : null,
          usage: { inputTokens: tokenCount(response.usage?.inputTokens), outputTokens: tokenCount(response.usage?.outputTokens) },
          latencyMs: Math.round(performance.now() - started) });
        return response;
      } catch (error) {
        requests.push({ kind: options.phase ?? (closed ? "final_submission" : "dialogue_turn"), status: "error",
          httpStatus: httpStatus(error?.status),
          retryCount: tokenCount(error?.retryCount) ?? 0, timeoutMs: tokenCount(error?.timeoutMs),
          model: null, usage: { inputTokens: null, outputTokens: null }, latencyMs: Math.round(performance.now() - started) });
        throw new NamingTaskError("ai_unavailable");
      }
    },
  };
  if (!client || typeof client.complete !== "function") throw new NamingTaskError("invalid_client");
  const session = createDialogueSession({ client: meteredClient, strategy, judge: createJudge(meteredClient),
    image: { mimeType: trial.ai.mimeType, base64: trial.ai.png.toString("base64") }, rotationImage, referenceMemory });
  let humanSubmission = null;
  let aiSubmission = null;
  let result = null;
  let closed = false;
  let busy = false;
  let finalFailed = false;
  let scoringFailed = false;
  const startedAt = new Date().toISOString();
  const trialStatus = () => result ? "completed" : scoringFailed ? "scoring_error" : finalFailed ? "submission_error" : closed ? "submitting" : "dialogue";

  function completionDiagnostics() {
    if (!humanSubmission || !aiSubmission) return null;
    const ledger = session.getOwnLedger();
    // Literal working-name changes, not the provisional task scoring rule.
    // An unassigned null name and an empty final answer both mean unnamed.
    const slots = SLOTS.filter((slot) => (ledger[slot].name ?? "") !== aiSubmission[slot]);
    return {
      ledgerFinalMismatch: { count: slots.length, slots },
      ledgerStatusCounts: Object.fromEntries(STATUSES.map((status) => [status, SLOTS.filter((slot) => ledger[slot].status === status).length])),
    };
  }

  async function persist() {
    if (!directory) return;
    const record = {
      recordId, trialId: trial.trialId, seed: trial.seed ?? seed, strategy, startedAt,
      options: { visualAid, referenceMemory },
      ...(referenceMemory ? { referenceGraph: session.getReferenceGraph() } : {}),
      updatedAt: new Date().toISOString(), status: trialStatus(),
      publicHistory: session.getHistory(), judgments: session.getJudgmentHistory(), ownLedger: session.getOwnLedger(), humanSubmission, aiSubmission,
      scoring: result ? { key: trial.key, result } : null, requests,
      diagnostics: completionDiagnostics(),
    };
    const temporary = join(directory, "." + recordId + ".tmp");
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // Recheck existing symlinks immediately before writing.
      if (await outsideRepositoryDirectory(directory) !== directory) throw new NamingTaskError("repository_output_forbidden");
      await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, join(directory, recordId + ".json"));
    } catch {
      await rm(temporary, { force: true }).catch(() => {});
      throw new NamingTaskError("record_write_failed");
    }
  }
  async function scoreIfReady() {
    if (humanSubmission && aiSubmission && !result) {
      try {
        result = clone(await scoreTrial({ key: clone(trial.key), humanSubmission: clone(humanSubmission), aiSubmission: clone(aiSubmission) }));
        scoringFailed = false;
      } catch {
        scoringFailed = true;
        throw new NamingTaskError("scoring_error");
      }
    }
  }
  function state() {
    return {
      trialId: trial.trialId, seed: trial.seed ?? seed, strategy, slots: [...SLOTS],
      status: trialStatus(),
      busy, publicHistory: session.getHistory(), humanSubmitted: Boolean(humanSubmission), aiSubmitted: Boolean(aiSubmission),
      humanSubmission: clone(humanSubmission),
      // Withhold names and scoring until both participants have committed.
      ...(result ? { aiSubmission: clone(aiSubmission), result: clone(result) } : {}),
    };
  }
  async function operate(action) {
    if (busy) throw new NamingTaskError("busy");
    busy = true;
    try { await action(); }
    finally { busy = false; }
    return state();
  }
  await persist();
  return {
    getState: state,
    getHumanImage() { return { png: Buffer.from(trial.human.png), mimeType: trial.human.mimeType }; },
    turn(utterance) {
      return operate(async () => {
        if (closed) throw new NamingTaskError("dialogue_closed");
        if (typeof utterance !== "string" || !utterance.trim() || utterance.length > 12000) throw new NamingTaskError("invalid_utterance");
        try { await session.turn(utterance); }
        finally { await persist(); }
      });
    },
    submitHuman(submission) {
      return operate(async () => {
        if (humanSubmission) throw new NamingTaskError("already_submitted");
        humanSubmission = validateSubmission(submission);
        closed = true;
        try { await scoreIfReady(); }
        finally { await persist(); }
      });
    },
    submitAI() {
      return operate(async () => {
        if ((aiSubmission && !scoringFailed) || finalFailed) throw new NamingTaskError("already_submitted");
        const wasClosed = closed;
        closed = true;
        try {
          if (!aiSubmission) {
            try {
              for (let attempt = 0; attempt < 2; attempt++) {
                const response = await session.finalRequest(FINAL_INSTRUCTIONS + (attempt ? "\n前回は指定JSON形式として検証できませんでした。上記形式を厳守して再提出してください。" : ""));
                try { aiSubmission = validateSubmission(JSON.parse(response.text)); break; }
                catch { if (attempt === 1) throw new NamingTaskError("invalid_ai_submission"); }
              }
            } catch (error) {
              if (error instanceof NamingTaskError && error.code === "invalid_ai_submission") finalFailed = true;
              else closed = wasClosed;
              throw error instanceof NamingTaskError ? error : new NamingTaskError("ai_unavailable");
            }
          }
          await scoreIfReady();
        } finally { await persist(); }
      });
    },
  };
}
