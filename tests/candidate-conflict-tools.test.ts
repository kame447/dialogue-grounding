// Researcher-only diagnostics: synthetic seed and fixtures, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScorerMessages, parseScorerReply, ownCrops, featuresOf, SCORER_INSTRUCTION, LABELS } from "../dialogue-model/runtime/diagnostics/candidate-conflict/scorer.ts";
import { parseArgs, outputDirectory } from "../dialogue-model/runtime/diagnostics/candidate-conflict/common.ts";
import { main as replayMain } from "../dialogue-model/runtime/diagnostics/candidate-conflict/replay.ts";
import { plannedInputs } from "../dialogue-model/runtime/diagnostics/candidate-conflict/planned-decisions.ts";
import { createTrialV2 } from "../dialogue-model/runtime/stimuli/scatter-v2.mjs";
import { createOwnLedger } from "../dialogue-model/runtime/judgment/schema.mjs";

const SEED = 4242;
const DIR = "dialogue-model/runtime/diagnostics/candidate-conflict";

test("scorer prompt carries only crops and feature texts: no ids, key or gold", () => {
  const trial = createTrialV2({ seed: SEED });
  const crops = ownCrops(SEED);
  const messages = buildScorerMessages(crops, ["細長い斜めの部分がある", "深いV字の切れ込みがある"]);
  const text = JSON.stringify(messages);
  const forbidden = [...Object.keys(trial.key.ai), ...Object.keys(trial.key.human), ...Object.values(trial.key.ai) as string[], "gold", "key", "seed", String(SEED)];
  for (const token of forbidden) assert.ok(!text.replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/g, "").includes(token), token);
  assert.equal(messages[0].content, SCORER_INSTRUCTION);
  const images = messages.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((p: any) => p.type === "image_url").map((p: any) => p.image_url.url) : []);
  assert.deepEqual([...images].sort(), crops.map((c) => "data:image/png;base64," + c.png.toString("base64")).sort());
  // Research Worker accepts at most 4 parts per user message.
  assert.ok(messages.every((m: any) => !Array.isArray(m.content) || m.content.length <= 4));
  assert.throws(() => buildScorerMessages(crops, []), /invalid_scorer_batch/);
});

test("scorer replies map labels back to own ids privately", () => {
  const crops = ownCrops(SEED);
  const features = ["a", "b"];
  const scores = parseScorerReply('```json\n{"1": ["A", "Z", "A"], "2": []}\n```', crops, features);
  assert.equal(scores.a.fits.length, 1);
  assert.ok(crops.some((c) => c.id === scores.a.fits[0]));
  assert.deepEqual(scores.b, { fits: [] });
  assert.equal(LABELS.length, crops.length);
  assert.deepEqual(featuresOf([{ judgment: { discriminatingFeature: "x", followUp: null }, diagnostics: { conflict: { candidates: [{ id: "s", feature: "y" }] } } },
    { judgment: { discriminatingFeature: "x" }, diagnostics: {} }]), ["x", "y"]);
});

test("tools default to a dry run and refuse live runs without an outside output directory", async () => {
  assert.equal(parseArgs([], []).live, false);
  assert.throws(() => parseArgs(["--unknown", "x"], []), /invalid_arguments/);
  await assert.rejects(outputDirectory(parseArgs(["--live"], [])), /output_required/);
  await assert.rejects(outputDirectory(parseArgs(["--out", "dialogue-model"], [])), /repository_output_forbidden/);
  const fixture = mkdtempSync(join(tmpdir(), "cc-tools-"));
  const ids = ["s-0001", "s-0002", "s-0003", "s-0004", "s-0005", "s-0006"];
  const record = { seed: SEED, events: [{ seq: 1, speaker: "ai", text: "まず" }, { seq: 2, speaker: "human", text: "鳥みたい" }],
    judgments: [{ turnIndex: 2, ownLedgerBefore: createOwnLedger(ids), judgment: { action: "accept", targetSlot: null, candidateName: null } }] };
  writeFileSync(join(fixture, "run.json"), JSON.stringify(record));
  const logs: string[] = [];
  const result = await replayMain(["--record", "S9=" + join(fixture, "run.json"), "--strategies", "S9=repair-first,bypass-enabled"], (line: string) => logs.push(line));
  assert.equal(result.todo.length, 4);
  assert.deepEqual(JSON.parse(logs[0]), { mode: "dry-run", jobs: 4, todo: 4, maxLunaCalls: 8, cap: 0 });
});

test("planned Decisions inputs hold public text and AI hypotheses, never the key", () => {
  const ids = ["s-0001", "s-0002", "s-0003", "s-0004", "s-0005", "s-0006"];
  const record = { seed: SEED, scoring: { key: { human: { "h-1": "F1" }, ai: { "s-0001": "F1" } } },
    events: [{ seq: 1, speaker: "human", text: "鳥みたい" }],
    judgments: [{ turnIndex: 1, ownLedgerBefore: createOwnLedger(ids) }] };
  const judgment = { action: "confirm", targetSlot: "s-0001", candidateName: "鳥", discriminatingFeature: "尖りが一つ", note: null };
  const planned = plannedInputs([{ id: "S9:1:repair-first:opt", judgment }, { id: "synthetic-011:repair-first:def", judgment: { ...judgment, targetSlot: "s-0a11" } }],
    new Map([["S9", record]]));
  assert.equal(planned.length, 2);
  for (const p of planned) { assert.equal(p.purpose, "decision_jev"); assert.ok(!/F1|h-1|scoring|gold/.test(p.state)); }
});

test("committed diagnostics contain no private paths or data", () => {
  for (const name of readdirSync(DIR)) {
    const text = readFileSync(join(DIR, name), "utf8");
    assert.ok(!/\/Users\/|private-runs|Research\/|[0-9a-f]{8}-[0-9a-f]{4}-/.test(text), name);
  }
});
