// Node-only, opt-in initial observation storage. No API accepts dialogue memos.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { outsideRepositoryDirectory } from "../naming-task.mjs";
import { createLunaObserver, OBSERVATION_INITIAL_INSTRUCTIONS, OBSERVATION_MEMO_VERSION,
  snapshotObservationInput, validateObservationMemo, ObservationError } from "./observe.ts";
import type { ObservationClient } from "./observe.ts";
import type { ObservationInput, ObservationMemo, ObservationOptions } from "./contract.ts";

export type ObservationCacheKey = {
  imageHash: string; anchorsHash: string; modelId: string; instructionHash: string; formatVersion: number;
};
export type ObservationCacheSource = {
  createdAt: string; modelId: string; instructionHash: string; formatVersion: number; durationMs: number;
};
export type ObservationCacheReason = "match" | "not_found" | "invalid_json" | "invalid_entry" | "content_hash_mismatch" |
  "image_mismatch" | "anchors_mismatch" | "model_mismatch" | "instructions_mismatch" | "format_mismatch" | "invalid_memo" |
  "unsafe_path" | "unsafe_permissions" | "io_error";
export type ObservationCacheAudit = {
  status: "HIT" | "MISS";
  reason: ObservationCacheReason;
  key: { id: string; image: string; anchors: string; model: string; instructions: string; formatVersion: number };
  source: ObservationCacheSource | null;
  observation: "reused" | "created" | "none";
  elapsedMs: number;
};
const ERROR_CODES = ["invalid_input", "unsafe_path", "unsafe_permissions", "io_error", "cache_miss", "busy",
  "model_unverified", "model_mismatch", "observation_failed", "timeout", "aborted"] as const;
export type ObservationCacheErrorCode = typeof ERROR_CODES[number];
export class ObservationCacheError extends Error {
  code: ObservationCacheErrorCode;
  audit: ObservationCacheAudit | null;
  constructor(code: ObservationCacheErrorCode, audit: ObservationCacheAudit | null = null) {
    const safe = ERROR_CODES.includes(code) ? code : "io_error";
    super(safe); this.name = safe === "aborted" ? "AbortError" : "ObservationCacheError"; this.code = safe;
    this.audit = audit === null ? null : structuredClone(audit);
  }
}
type Entry = { key: ObservationCacheKey; memo: ObservationMemo; source: ObservationCacheSource; contentHash: string };
type ReadResult = { entry: Entry; reason: "match" } | { entry: null; reason: Exclude<ObservationCacheReason, "match"> };
export type CachedObservation = { memo: ObservationMemo; audit: ObservationCacheAudit };
export type ObservationCache = { get(input: ObservationInput, options?: ObservationOptions): Promise<CachedObservation> };
const MAX_FILE_BYTES = 192000;
const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && Object.getPrototypeOf(v) === Object.prototype &&
  Reflect.ownKeys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const model = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(v);
const version = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const duration = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const iso = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const errno = (e: unknown) => (e as { code?: unknown })?.code;
function fail(code: ObservationCacheErrorCode): never { throw new ObservationCacheError(code); }
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k])).join(",") + "}";
  return JSON.stringify(v);
}
function initialMemo(value: unknown, input: ObservationInput): ObservationMemo {
  const memo = validateObservationMemo(value, { ownAnchors: input.ownAnchors });
  if (memo.figures.some(f => f.reobservations.length !== 0)) fail("invalid_input");
  return memo;
}
function keyValid(value: unknown): value is ObservationCacheKey {
  return exact(value, ["imageHash", "anchorsHash", "modelId", "instructionHash", "formatVersion"]) && digest(value.imageHash) &&
    digest(value.anchorsHash) && model(value.modelId) && digest(value.instructionHash) && version(value.formatVersion);
}
function sourceValid(value: unknown): value is ObservationCacheSource {
  return exact(value, ["createdAt", "modelId", "instructionHash", "formatVersion", "durationMs"]) && iso(value.createdAt) && model(value.modelId) &&
    digest(value.instructionHash) && version(value.formatVersion) && duration(value.durationMs);
}
/** All key material is derived from the current own projection and fixed program versions. */
export function createObservationCacheKey(input: ObservationInput, { modelId }: { modelId: string }): ObservationCacheKey {
  if (!model(modelId)) fail("invalid_input");
  let own: ObservationInput;
  try { own = snapshotObservationInput(input); } catch { return fail("invalid_input"); }
  const bytes = Buffer.from(own.ownImage.base64, "base64");
  if (bytes.toString("base64") !== own.ownImage.base64) fail("invalid_input");
  const ordered = [...own.ownAnchors].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { imageHash: hash(bytes), anchorsHash: hash(canonical(ordered)), modelId,
    instructionHash: hash(OBSERVATION_INITIAL_INSTRUCTIONS), formatVersion: OBSERVATION_MEMO_VERSION };
}
/** Filename is data-independent except for its validated key hash; no paths from model text. */
export function observationCacheFileName(key: ObservationCacheKey): string {
  if (!keyValid(key)) fail("invalid_input");
  return hash(canonical(key)) + ".json";
}
function summary(key: ObservationCacheKey): ObservationCacheAudit["key"] {
  return { id: observationCacheFileName(key).slice(0, 12), image: key.imageHash.slice(0, 12), anchors: key.anchorsHash.slice(0, 12),
    model: hash(key.modelId).slice(0, 12), instructions: key.instructionHash.slice(0, 12), formatVersion: key.formatVersion };
}
function mismatch(actual: ObservationCacheKey, expected: ObservationCacheKey): ObservationCacheReason | null {
  if (actual.imageHash !== expected.imageHash) return "image_mismatch";
  if (actual.anchorsHash !== expected.anchorsHash) return "anchors_mismatch";
  if (actual.modelId !== expected.modelId) return "model_mismatch";
  if (actual.instructionHash !== expected.instructionHash) return "instructions_mismatch";
  if (actual.formatVersion !== expected.formatVersion) return "format_mismatch";
  return null;
}
async function directoryPath(path: string, create = false): Promise<boolean> {
  try {
    if (await outsideRepositoryDirectory(path) !== path) fail("unsafe_path");
    if (create) await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("unsafe_path");
    if ((info.mode & 0o777) !== 0o700) fail("unsafe_permissions");
    if (await outsideRepositoryDirectory(path) !== path) fail("unsafe_path");
    return true;
  } catch (error) {
    if (error instanceof ObservationCacheError) throw error;
    if (errno(error) === "ENOENT" && !create) return false;
    if ((error as { code?: unknown })?.code === "repository_output_forbidden") fail("unsafe_path");
    return fail("io_error");
  }
}
async function readEntry(directory: string, key: ObservationCacheKey, input: ObservationInput): Promise<ReadResult> {
  let file;
  try {
    if (!await directoryPath(directory)) return { entry: null, reason: "not_found" };
    file = await open(join(directory, observationCacheFileName(key)), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1) return { entry: null, reason: "unsafe_path" };
    if ((info.mode & 0o777) !== 0o600) return { entry: null, reason: "unsafe_permissions" };
    if (info.size > MAX_FILE_BYTES) return { entry: null, reason: "invalid_entry" };
    const raw = await file.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(raw) > MAX_FILE_BYTES) return { entry: null, reason: "invalid_entry" };
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return { entry: null, reason: "invalid_json" }; }
    if (!exact(value, ["key", "memo", "source", "contentHash"]) || !keyValid(value.key) || !sourceValid(value.source) || !digest(value.contentHash)) return { entry: null, reason: "invalid_entry" };
    const { contentHash, ...payload } = value;
    if (hash(canonical(payload)) !== contentHash) return { entry: null, reason: "content_hash_mismatch" };
    const reason = mismatch(value.key, key);
    if (reason) return { entry: null, reason: reason as Exclude<ObservationCacheReason, "match"> };
    if (value.source.modelId !== key.modelId || value.source.instructionHash !== key.instructionHash || value.source.formatVersion !== key.formatVersion) return { entry: null, reason: "invalid_entry" };
    let memo: ObservationMemo;
    try { memo = initialMemo(value.memo, input); } catch { return { entry: null, reason: "invalid_memo" }; }
    if (memo.observedAt !== value.source.createdAt || raw.includes(input.ownImage.base64)) return { entry: null, reason: "invalid_memo" };
    return { entry: { key: { ...key }, memo, source: structuredClone(value.source), contentHash }, reason: "match" };
  } catch (error) {
    if (error instanceof ObservationCacheError) return { entry: null, reason: error.code as "unsafe_path" | "unsafe_permissions" | "io_error" };
    if (errno(error) === "ENOENT") return { entry: null, reason: "not_found" };
    return { entry: null, reason: errno(error) === "ELOOP" ? "unsafe_path" : "io_error" };
  } finally { await file?.close().catch(() => {}); }
}
async function storeEntry(directory: string, key: ObservationCacheKey, memo: ObservationMemo, source: ObservationCacheSource): Promise<void> {
  const payload = { key, memo, source };
  const text = JSON.stringify({ ...payload, contentHash: hash(canonical(payload)) }) + "\n";
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) fail("invalid_input");
  const temporary = join(directory, ".initial-" + randomUUID() + ".tmp");
  let file;
  try {
    await directoryPath(directory);
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(text, "utf8"); await file.sync(); await file.close(); file = undefined;
    await directoryPath(directory);
    await rename(temporary, join(directory, observationCacheFileName(key)));
  } catch (error) {
    if (error instanceof ObservationCacheError) throw error;
    fail("io_error");
  } finally { await file?.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}

/** Reads validated initial memos. Only the explicit MISS branch can create a file.
 * modelId is the exact model ID reported by the completion client, never an alias match.
 */
export async function createObservationCache({ directory, modelId, client, onMiss = "error", timeoutMs = 20000 }: {
  directory: string; modelId: string; client?: ObservationClient; onMiss?: "error" | "observe"; timeoutMs?: number;
}): Promise<ObservationCache> {
  if (typeof directory !== "string" || !directory.trim() || !isAbsolute(directory) || !model(modelId) ||
      !["error", "observe"].includes(onMiss) || !version(timeoutMs) || timeoutMs > 60000 ||
      (onMiss === "observe" && (!client || typeof client.complete !== "function"))) fail("invalid_input");
  let root: string;
  try { root = await outsideRepositoryDirectory(directory); } catch { return fail("unsafe_path"); }
  await directoryPath(root);
  return {
    async get(input, options = {}) {
      const started = performance.now();
      let own: ObservationInput;
      try { own = snapshotObservationInput(input); } catch { return fail("invalid_input"); }
      own.ownAnchors = [...own.ownAnchors].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const key = createObservationCacheKey(own, { modelId });
      const audit = (status: "HIT" | "MISS", reason: ObservationCacheReason, source: ObservationCacheSource | null,
        observation: ObservationCacheAudit["observation"]): ObservationCacheAudit => ({ status, reason, key: summary(key),
          source: source === null ? null : structuredClone(source), observation, elapsedMs: Math.max(0, Math.round(performance.now() - started)) });
      if (options.signal?.aborted) throw new ObservationCacheError("aborted", audit("MISS", "not_found", null, "none"));
      if (options.timeoutMs !== undefined && (!version(options.timeoutMs) || options.timeoutMs > 60000)) fail("invalid_input");
      let loaded = await readEntry(root, key, own);
      if (options.signal?.aborted) throw new ObservationCacheError("aborted", audit("MISS", loaded.reason, null, "none"));
      if (loaded.entry) return { memo: structuredClone(loaded.entry.memo), audit: audit("HIT", "match", loaded.entry.source, "reused") };
      if (["unsafe_path", "unsafe_permissions", "io_error"].includes(loaded.reason)) throw new ObservationCacheError(loaded.reason as "unsafe_path" | "unsafe_permissions" | "io_error", audit("MISS", loaded.reason, null, "none"));
      if (onMiss === "error") throw new ObservationCacheError("cache_miss", audit("MISS", loaded.reason, null, "none"));
      const lockPath = join(root, "." + observationCacheFileName(key) + ".lock");
      let lock;
      try {
        await directoryPath(root, true);
        try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
        catch (error) { throw new ObservationCacheError(errno(error) === "EEXIST" ? "busy" : "io_error", audit("MISS", loaded.reason, null, "none")); }
        // Another caller may have completed its initial observation before this lock.
        loaded = await readEntry(root, key, own);
        if (loaded.entry) return { memo: structuredClone(loaded.entry.memo), audit: audit("HIT", "match", loaded.entry.source, "reused") };
        if (["unsafe_path", "unsafe_permissions", "io_error"].includes(loaded.reason)) throw new ObservationCacheError(loaded.reason as "unsafe_path" | "unsafe_permissions" | "io_error");
        let returnedModel: unknown;
        const observer = createLunaObserver({ async complete(messages, requestOptions) {
          const response = await client!.complete(messages, requestOptions);
          returnedModel = (response as { model?: unknown })?.model;
          return response;
        } }, { timeoutMs });
        const observed = performance.now();
        const memo = initialMemo(await observer.observeAll(own, options), own);
        if (options.signal?.aborted) fail("aborted");
        if (!model(returnedModel)) fail("model_unverified");
        if (returnedModel !== modelId) fail("model_mismatch");
        const source: ObservationCacheSource = { createdAt: memo.observedAt, modelId: returnedModel, instructionHash: key.instructionHash,
          formatVersion: key.formatVersion, durationMs: Math.max(0, Math.round(performance.now() - observed)) };
        await storeEntry(root, key, memo, source);
        return { memo: structuredClone(memo), audit: audit("MISS", loaded.reason, source, "created") };
      } catch (error) {
        const code = error instanceof ObservationCacheError ? error.code : error instanceof ObservationError && ["timeout", "aborted"].includes(error.code) ?
          error.code as "timeout" | "aborted" : "observation_failed";
        throw new ObservationCacheError(code, audit("MISS", loaded.reason, null, "none"));
      } finally { if (lock) { await lock.close().catch(() => {}); await unlink(lockPath).catch(() => {}); } }
    },
  };
}
