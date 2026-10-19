// Synthetic images/memos in temporary private directories only. No real API.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, readdir, stat, rm, mkdir, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspect } from "node:util";
import { createObservationCache, createObservationCacheKey, observationCacheFileName, ObservationCacheError } from "../dialogue-model/runtime/observation/cache.ts";
import { OBSERVATION_INITIAL_INSTRUCTIONS, OBSERVATION_MEMO_VERSION, mergeReobservation } from "../dialogue-model/runtime/observation/observe.ts";
import type { ObservationCacheKey } from "../dialogue-model/runtime/observation/cache.ts";
import type { ObservationInput, ObservationMemo } from "../dialogue-model/runtime/observation/contract.ts";

const MODEL = "test-vision-20261020";
const image = Buffer.from("synthetic-own-image-bytes-v1");
const input: ObservationInput = { ownImage: { mimeType: "image/png", base64: image.toString("base64") },
  ownAnchors: Array.from({ length: 6 }, (_, i) => ({ id: `own-${i + 1}`, bbox: { x: i * 110, y: 10, w: 100, h: 80 }, centroid: { x: i * 110 + 50, y: 50 } })) };
function raw() { return { figures: input.ownAnchors.map(a => ({ id: a.id,
  holistic: [{ construal: "何かが立っているような全体", basis: ["細い部分が四角から伸びる"], status: "hypothesis" }],
  analytic: { shapes: ["四角", "三角"], composition: "四角と細い三角が接する", relations: ["細い部分が辺に接する"] }, unknowns: ["細い部分の役割は不明"] })) }; }
const code = (wanted: string, reason?: string) => (error: unknown) => error instanceof ObservationCacheError && error.code === wanted &&
  error.message === wanted && (reason === undefined || error.audit?.reason === reason);
function client(model: unknown = MODEL) {
  let calls = 0;
  return { get calls() { return calls; }, async complete(_messages: unknown, options: { phase: string }) {
    calls++; assert.equal(options.phase, "observation_initial");
    return { text: JSON.stringify(raw()), model };
  } };
}
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
function canonical(v: any): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
function reseal(entry: any) { const { contentHash: _old, ...payload } = entry; return { ...payload, contentHash: sha(canonical(payload)) }; }
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "observation-cache-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const upstream = client();
  const cache = await createObservationCache({ directory, modelId: MODEL, client: upstream, onMiss: "observe" });
  const first = await cache.get(input);
  const file = join(directory, observationCacheFileName(createObservationCacheKey(input, { modelId: MODEL })));
  return { directory, upstream, cache, first, file };
}

test("MISS creates only a private initial memo; the next call is a detached HIT with exact provenance", async t => {
  const { directory, upstream, cache, first, file } = await fixture(t);
  assert.equal(first.audit.status, "MISS"); assert.equal(first.audit.reason, "not_found"); assert.equal(first.audit.observation, "created");
  assert.equal(upstream.calls, 1); assert.equal(first.audit.source?.modelId, MODEL);
  assert.equal(first.audit.source?.instructionHash, sha(OBSERVATION_INITIAL_INSTRUCTIONS));
  assert.equal(first.audit.source?.formatVersion, OBSERVATION_MEMO_VERSION);
  assert.equal(first.audit.source?.createdAt, first.memo.observedAt);
  assert.ok(Number.isSafeInteger(first.audit.source?.durationMs)); assert.ok(first.audit.elapsedMs >= 0);
  assert.ok(Object.entries(first.audit.key).every(([k, v]) => k === "formatVersion" || typeof v === "string" && v.length === 12));
  assert.equal((await stat(directory)).mode & 0o777, 0o700); assert.equal((await stat(file)).mode & 0o777, 0o600);
  const original = await readFile(file, "utf8");
  first.memo.figures[0].analytic.composition = "dialogue mutation";
  const hit = await cache.get(input);
  assert.equal(hit.audit.status, "HIT"); assert.equal(hit.audit.reason, "match"); assert.equal(hit.audit.observation, "reused");
  assert.notEqual(hit.memo.figures[0].analytic.composition, "dialogue mutation");
  hit.audit.source!.modelId = "mutated";
  assert.equal((await cache.get(input)).audit.source?.modelId, MODEL);
  assert.equal(upstream.calls, 1); assert.equal(await readFile(file, "utf8"), original);
  assert.deepEqual(await readdir(directory), [observationCacheFileName(createObservationCacheKey(input, { modelId: MODEL }))]);
});

test("cache keys hash image bytes and normalize anchor ordering/property order without relabeling", () => {
  const key = createObservationCacheKey(input, { modelId: MODEL });
  assert.equal(key.imageHash, sha(image));
  const reordered = { ...input, ownAnchors: [...input.ownAnchors].reverse().map(a => ({ centroid: a.centroid, bbox: a.bbox, id: a.id })) };
  assert.deepEqual(createObservationCacheKey(reordered, { modelId: MODEL }), key);
  const changed = structuredClone(input); changed.ownAnchors[0].id = "new-id";
  assert.notEqual(createObservationCacheKey(changed, { modelId: MODEL }).anchorsHash, key.anchorsHash);
});

test("one-byte image changes, anchor changes, ID changes, rotation/layout and model changes never reuse the memo", async t => {
  const { directory, upstream, file } = await fixture(t);
  const original = await readFile(file, "utf8");
  const bytes = Buffer.from(image); bytes[0] ^= 1;
  const oneByte = { ...input, ownImage: { ...input.ownImage, base64: bytes.toString("base64") } };
  const moved = structuredClone(input); moved.ownAnchors[0].bbox.x++; moved.ownAnchors[0].centroid.x++;
  const renamed = structuredClone(input); renamed.ownAnchors[0].id = "own-renamed";
  const rotated = { ...input, ownImage: { ...input.ownImage, base64: Buffer.from("synthetic-rotated-render").toString("base64") } };
  const layout = structuredClone(input); layout.ownAnchors = layout.ownAnchors.map(a => ({ ...a, bbox: { ...a.bbox, y: a.bbox.y + 100 }, centroid: { ...a.centroid, y: a.centroid.y + 100 } }));
  for (const [own, modelId] of [[oneByte, MODEL], [moved, MODEL], [renamed, MODEL], [rotated, MODEL], [layout, MODEL], [input, "another-model"]] as const) {
    const strict = await createObservationCache({ directory, modelId });
    await assert.rejects(strict.get(own), code("cache_miss", "not_found"));
  }
  assert.equal(upstream.calls, 1); assert.equal(await readFile(file, "utf8"), original);
});

test("well-formed stale image/anchor/model/prompt/schema keys are diagnosed even if copied to the expected filename", async t => {
  const { directory, file } = await fixture(t);
  const original = JSON.parse(await readFile(file, "utf8"));
  const cases: Array<[keyof ObservationCacheKey, string | number, string]> = [
    ["imageHash", sha("other-image"), "image_mismatch"], ["anchorsHash", sha("other-anchors"), "anchors_mismatch"],
    ["modelId", "other-model", "model_mismatch"], ["instructionHash", sha("other-instructions"), "instructions_mismatch"],
    ["formatVersion", OBSERVATION_MEMO_VERSION + 1, "format_mismatch"],
  ];
  const strict = await createObservationCache({ directory, modelId: MODEL });
  for (const [field, value, reason] of cases) {
    const changed = structuredClone(original); changed.key[field] = value;
    await writeFile(file, JSON.stringify(reseal(changed)));
    await assert.rejects(strict.get(input), code("cache_miss", reason));
  }
});

test("missing, malformed, tampered and semantically invalid files are never adopted", async t => {
  const { directory, file } = await fixture(t);
  const original = JSON.parse(await readFile(file, "utf8"));
  const strict = await createObservationCache({ directory, modelId: MODEL });
  await rm(file); await assert.rejects(strict.get(input), code("cache_miss", "not_found"));
  await writeFile(file, "not JSON", { mode: 0o600 });
  await assert.rejects(strict.get(input), code("cache_miss", "invalid_json"));
  const changed = structuredClone(original); changed.memo.figures[0].analytic.composition = "改ざん";
  await writeFile(file, JSON.stringify(changed));
  await assert.rejects(strict.get(input), code("cache_miss", "content_hash_mismatch"));
  const invalid = structuredClone(original); invalid.memo.figures[0].id = "partner-only";
  await writeFile(file, JSON.stringify(reseal(invalid)));
  await assert.rejects(strict.get(input), code("cache_miss", "invalid_memo"));
  const conversation = structuredClone(original); conversation.memo.figures[0].reobservations = [{
    figureId: "own-1", observedAt: original.memo.observedAt, issue: { aspect: "name", question: "public dialogue", partnerConstrual: null }, supports: [], contradicts: [], unknown: [] }];
  await writeFile(file, JSON.stringify(reseal(conversation)));
  await assert.rejects(strict.get(input), code("cache_miss", "invalid_memo"));
  await writeFile(file, JSON.stringify({ ...original, participant: "PARTICIPANT_CANARY" }));
  await assert.rejects(strict.get(input), code("cache_miss", "invalid_entry"));
});

test("explicit MISS regeneration validates and replaces only initial content and then reuses it", async t => {
  const { cache, upstream, file } = await fixture(t);
  await writeFile(file, "corrupt JSON");
  const result = await cache.get(input);
  assert.equal(result.audit.status, "MISS"); assert.equal(result.audit.reason, "invalid_json"); assert.equal(result.audit.observation, "created");
  assert.equal(upstream.calls, 2); assert.equal((await cache.get(input)).audit.status, "HIT"); assert.equal(upstream.calls, 2);
});

test("dialogue reobservations and both strategy runs stay separate from the shared initial memo", async t => {
  const { directory, file, first } = await fixture(t); const bytes = await readFile(file, "utf8");
  const strict = await createObservationCache({ directory, modelId: MODEL });
  const trials: ObservationMemo[] = [];
  for (const strategy of ["repair-first", "bypass-enabled"]) {
    const loaded = await strict.get({ ...input, strategy, publicTurns: [{ speaker: "human", text: "PARTNER_TURN_CANARY" }],
      partnerImage: "PARTNER_IMAGE_CANARY", gold: "GOLD_CANARY" } as ObservationInput);
    trials.push(loaded.memo);
    const local = mergeReobservation(loaded.memo, { observedAt: loaded.memo.observedAt, issue: { aspect: "name", question: "PARTNER_TURN_CANARY", partnerConstrual: null },
      figures: [{ figureId: "own-1", supports: ["DIALOGUE_CANARY"], contradicts: [], unknown: [] }] });
    assert.equal(local.figures[0].reobservations.length, 1);
  }
  assert.deepEqual(trials[0], trials[1]); assert.deepEqual(trials[0], first.memo);
  assert.equal(await readFile(file, "utf8"), bytes); assert.doesNotMatch(bytes, /CANARY|base64|image_url|c3ludGhldGlj/);
  const parsed = JSON.parse(bytes); assert.deepEqual(Object.keys(parsed), ["key", "memo", "source", "contentHash"]);
  assert.ok(parsed.memo.figures.every((f: any) => f.reobservations.length === 0));
});

test("actual response model is required and must exactly match the selected model", async t => {
  const directory = await mkdtemp(join(tmpdir(), "observation-cache-model-")); t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [returnedModel, expected] of [[undefined, "model_unverified"], [null, "model_unverified"], ["MODEL SECRET", "model_unverified"],
    ["test-vision", "model_mismatch"], [MODEL + "-different", "model_mismatch"]] as const) {
    const upstream = client(returnedModel);
    // Explicit undefined is omitted by this custom client, not replaced by its default argument.
    const wrapped = { async complete(messages: unknown, options: { phase: string }) { const response = await upstream.complete(messages, options); return { ...response, model: returnedModel }; } };
    const cache = await createObservationCache({ directory, modelId: MODEL, client: wrapped, onMiss: "observe" });
    await assert.rejects(cache.get(input), code(expected));
    assert.deepEqual(await readdir(directory), []);
  }
});

test("repo paths, any other Git tree, repository symlinks and cache-file symlinks are refused", async t => {
  const directory = await mkdtemp(join(tmpdir(), "observation-cache-path-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const otherGit = join(directory, "checkout"); await mkdir(otherGit, { mode: 0o700 }); await writeFile(join(otherGit, ".git"), "gitdir: dummy");
  await symlink(resolve("."), join(directory, "repo-link"));
  for (const path of [resolve("."), resolve(".cache/observations"), join(directory, "repo-link", "cache"), join(otherGit, "cache")]) {
    await assert.rejects(createObservationCache({ directory: path, modelId: MODEL }), code("unsafe_path"));
  }
  const root = join(directory, "private"); await mkdir(root, { mode: 0o700 });
  const file = join(root, observationCacheFileName(createObservationCacheKey(input, { modelId: MODEL })));
  await symlink(resolve("package.json"), file);
  const cache = await createObservationCache({ directory: root, modelId: MODEL, client: client(), onMiss: "observe" });
  await assert.rejects(cache.get(input), code("unsafe_path")); assert.ok((await readFile(resolve("package.json"), "utf8")).includes("scripts"));
});

test("public permissions are rejected rather than silently changed or used", async t => {
  const { directory, file } = await fixture(t);
  await chmod(file, 0o644);
  const cache = await createObservationCache({ directory, modelId: MODEL });
  await assert.rejects(cache.get(input), code("unsafe_permissions"));
  await chmod(file, 0o600); await chmod(directory, 0o755);
  await assert.rejects(createObservationCache({ directory, modelId: MODEL }), code("unsafe_permissions"));
  assert.equal((await stat(directory)).mode & 0o777, 0o755);
});

test("raw errors, invalid model output, timeouts and aborts leave no cache or lock and expose fixed codes only", async t => {
  const directory = await mkdtemp(join(tmpdir(), "observation-cache-error-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const upstream = { async complete() { throw new Error("SECRET_CANARY " + input.ownImage.base64); } };
  const cache = await createObservationCache({ directory, modelId: MODEL, client: upstream, onMiss: "observe" });
  await assert.rejects(cache.get(input), error => { assert.ok(code("observation_failed")(error)); assert.doesNotMatch(inspect(error), /SECRET_CANARY|c3ludGhldGlj/); return true; });
  const invalid = await createObservationCache({ directory, modelId: MODEL, client: { async complete() { return { text: "not JSON", model: MODEL }; } }, onMiss: "observe" });
  await assert.rejects(invalid.get(input), code("observation_failed"));
  const hanging = await createObservationCache({ directory, modelId: MODEL, client: { complete() { return new Promise(() => {}); } }, onMiss: "observe", timeoutMs: 5 });
  await assert.rejects(hanging.get(input), code("timeout"));
  const controller = new AbortController(); controller.abort(); await assert.rejects(hanging.get(input, { signal: controller.signal }), code("aborted"));
  assert.deepEqual(await readdir(directory), []);
});

test("concurrent MISS calls cannot create two conflicting initial observations", async t => {
  const directory = await mkdtemp(join(tmpdir(), "observation-cache-busy-")); t.after(() => rm(directory, { recursive: true, force: true }));
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; }); let calls = 0;
  const cache = await createObservationCache({ directory, modelId: MODEL, onMiss: "observe", client: { async complete() {
    calls++; entered(); await gate; return { text: JSON.stringify(raw()), model: MODEL };
  } } });
  const pending = cache.get(input); await ready;
  try { await assert.rejects(cache.get(input), code("busy")); } finally { release(); }
  const first = await pending; const second = await cache.get(input);
  assert.equal(calls, 1); assert.equal(second.audit.status, "HIT"); assert.deepEqual(second.memo, first.memo);
});

test("MISS creation projects only the own image/anchors and never persists excluded participant or answer-key data", async t => {
  const directory = await mkdtemp(join(tmpdir(), "observation-cache-projection-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = await createObservationCache({ directory, modelId: MODEL, onMiss: "observe", client: { async complete(messages) {
    assert.doesNotMatch(JSON.stringify(messages), /CANARY|repair-first|bypass-enabled/);
    assert.equal(JSON.stringify(messages).split(input.ownImage.base64).length - 1, 1);
    return { text: JSON.stringify(raw()), model: MODEL };
  } } });
  const loaded = await cache.get({ ...input, strategy: "repair-first", publicTurns: ["PARTICIPANT_CANARY"],
    partnerImage: "PARTNER_CANARY", gold: "GOLD_CANARY", future: "FUTURE_CANARY",
    ownAnchors: input.ownAnchors.map(a => ({ ...a, partnerSlot: "CORRESPONDENCE_CANARY" })),
  } as ObservationInput);
  assert.equal(loaded.audit.status, "MISS");
  const [name] = await readdir(directory); const body = await readFile(join(directory, name), "utf8");
  assert.doesNotMatch(body, /CANARY|base64|image_url|c3ludGhldGlj/);
  assert.doesNotMatch(JSON.stringify(loaded.audit), /CANARY|observation-cache-projection/);
});
