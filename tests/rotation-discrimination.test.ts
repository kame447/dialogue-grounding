// Offline geometry and local mock HTTP only; no paid request is sent.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binomialTail, leakFindings, parseSame, parseSlot, renderBoard, renderSingle, wilson } from "../dialogue-model/runtime/diagnostics/rotation/bench-common.ts";
import { FIGURE_IDS, rotationMargin, invariantIou, presentedIou, rankPairs, pairwiseInvariant, seedAnalysis, turningDistance, huDistance, outerContour } from "../dialogue-model/runtime/diagnostics/rotation/shape-similarity.ts";
import { buildVisionMessages, planVision } from "../dialogue-model/runtime/diagnostics/rotation/vision-bench.ts";
import { PHRASES, buildVerbalMessages, planVerbal, describe } from "../dialogue-model/runtime/diagnostics/rotation/verbal-bench.ts";
import { CALL_BUDGET, confusion, isOutsideRepository, main, planAll, summarizeAll } from "../dialogue-model/runtime/diagnostics/rotation/run.ts";

const requestText = (messages: unknown) => JSON.stringify(messages);
const textParts = (messages: Array<{ content: Array<{ type: string; text?: string }> }>) =>
  messages.flatMap((m) => m.content.filter((p) => p.type === "text").map((p) => p.text!));

test("rotation-invariant measures: identity, rotation and symmetry", () => {
  for (const id of FIGURE_IDS) {
    assert.ok(invariantIou(id, id, { step: 45, size: 48 }).iou > 0.999);
    assert.ok(presentedIou(id, 0, id, 90, 48) < 1, "presented overlap is orientation-dependent");
    assert.ok(turningDistance(id, id, 120) < 1e-9);
    assert.ok(outerContour(id).length >= 3);
  }
  assert.ok(Math.abs(huDistance("F3", "F4", 64) - huDistance("F4", "F3", 64)) < 1e-9);
  // Rotating one figure by a quarter turn leaves its invariant score at 1.
  const quarter = invariantIou("F2", "F2", { step: 90, size: 48 });
  assert.equal(quarter.degrees, 0);
});

test("pair ranking covers 15 unordered pairs and puts different figures below identity", () => {
  const rows = rankPairs(pairwiseInvariant());
  assert.equal(rows.length, 15);
  for (const row of rows) assert.ok(row.invariantIou < 0.95 && row.turningDistance > 0.1);
  // vision-bench fixes these pairs from the same ranking.
  assert.deepEqual(rows.slice(0, 3).map((r) => r.a + r.b), ["F3F4", "F1F6", "F3F6"]);
  assert.deepEqual(rows.slice(-3).map((r) => r.a + r.b).sort(), ["F2F6", "F4F5", "F5F6"]);
});

test("appearance margin is positive without rotation and shrinks with it", () => {
  assert.ok(rotationMargin(0, 32).every((r) => r.margin > 0 && Math.abs(r.self - 1) < 1e-12));
  const quarter = rotationMargin(90, 32);
  assert.ok(quarter.filter((r) => r.margin > 0).length < 6);
});

test("v2 seed analysis: the two screens always differ by a quarter turn", () => {
  const result = seedAnalysis(137, 32);
  assert.equal(result.figures.length, 6);
  for (const row of result.figures) {
    assert.ok([90, 270].includes(row.relativeRotation));
    assert.equal(row.invariantRank, 1);
  }
});

test("v2 seed analysis follows the researcher-selected rotation mode", () => {
  assert.deepEqual(seedAnalysis(137, 32, "relative_pm90"), seedAnalysis(137, 32));
  const aligned = seedAnalysis(137, 32, "relative_0");
  assert.equal(aligned.rotationMode, "relative_0");
  for (const row of aligned.figures) {
    assert.equal(row.relativeRotation, 0);
    assert.equal(row.presentedRank, 1);
  }
  assert.equal(aligned.presentedMisranked, 0);
  assert.throws(() => seedAnalysis(137, 32, "relative_45" as never), /unknown rotation mode/u);
});

test("offline report names its rotation mode", async () => {
  const logs: string[] = [];
  const original = console.log;
  console.log = (line: string) => { logs.push(line); };
  try { await main(["offline", "--seeds", "137", "--rotation-mode", "relative_0"]); }
  finally { console.log = original; }
  const report = JSON.parse(logs.join("\n"));
  assert.equal(report.rotationMode, "relative_0");
  assert.equal(report.perSeed[0].presentedMisranked, 0);
  // live/plan benches do not use scatter-v2 layouts, so the flag must not be silently ignored there.
  for (const command of ["plan", "live"]) {
    await assert.rejects(main([command, "--rotation-mode", "relative_0"]), /offline only/u);
  }
});

test("dry-run plan stays within the 300-call budget and is deterministic", () => {
  const items = planAll(["vision", "verbal"]);
  assert.equal(items.length, 168);
  assert.ok(items.length <= CALL_BUDGET);
  assert.deepEqual(planAll(["vision", "verbal"]).map((i) => i.itemId), items.map((i) => i.itemId));
  const sd = planVision().filter((i) => i.kind === "same_different");
  assert.equal(sd.filter((i) => i.expected).length, sd.length / 2);
});

test("requests carry no ids, keys, answers or labels", () => {
  for (const item of planAll(["vision", "verbal"])) {
    const messages = item.kind === "verbal" ? buildVerbalMessages(item) : buildVisionMessages(item);
    for (const text of textParts(messages)) assert.deepEqual(leakFindings(text), [], item.itemId);
    const raw = requestText(messages);
    assert.doesNotMatch(raw, /"F[1-6]"|figureId|expected|rotation/u);
    for (const m of messages) for (const p of m.content) assert.ok(p.type === "text" || p.image_url.url.startsWith("data:image/png;base64,"));
  }
});

test("verbal twins differ only in the target's own orientation", () => {
  const items = planVerbal();
  assert.equal(items.length, 72);
  for (const aligned of items.filter((i) => i.view === "aligned")) {
    const rotated = items.find((i) => i.view === "rotated" && i.target === aligned.target && i.partnerRotation === aligned.partnerRotation && i.style === aligned.style)!;
    assert.equal(aligned.ownTargetRotation, aligned.partnerRotation);
    assert.ok([90, 270].includes((rotated.ownTargetRotation - aligned.partnerRotation + 360) % 360));
    assert.equal(aligned.expected, rotated.expected);
    assert.deepEqual(textParts(buildVerbalMessages(aligned)), textParts(buildVerbalMessages(rotated)));
    aligned.board.forEach((e, i) => {
      assert.equal(e.figureId, rotated.board[i].figureId);
      if (e.figureId !== aligned.target) assert.equal(e.rotation, rotated.board[i].rotation);
    });
  }
  // Invariant features avoid screen directions; oriented ones use them.
  for (const entry of Object.values(PHRASES)) assert.doesNotMatch(entry.invariant, /[上下左右]/u);
  assert.match(describe("F2", 0, "impression+oriented"), /左下/u);
});

test("images are plain grayscale PNG silhouettes", () => {
  const single = renderSingle("F1", 45), board = renderBoard(FIGURE_IDS.map((figureId) => ({ figureId, rotation: 0 })));
  for (const png of [single, board]) {
    assert.equal(png.subarray(1, 4).toString("latin1"), "PNG");
    assert.doesNotMatch(png.toString("latin1"), /tEXt|iTXt|zTXt/u);
  }
  assert.throws(() => renderBoard([]), /six/u);
});

test("parsers and interval statistics", () => {
  assert.equal(parseSlot('```json\n{"slot":"下段中"}\n```'), "下段中");
  assert.equal(parseSlot('{"slot":"中央"}'), null);
  assert.equal(parseSame('{"same": false}'), false);
  assert.equal(parseSame("same"), null);
  const [lo, hi] = wilson(5, 10);
  assert.ok(lo < 0.5 && hi > 0.5);
  assert.ok(Math.abs(binomialTail(0, 10, 0.3) - 1) < 1e-12);
  assert.ok(binomialTail(10, 10, 0.5) < 0.001);
  const table = confusion([{ target: "F1", chosen: "F6" }, { target: "F1", chosen: "none" }]);
  assert.equal(table.F1.F6, 1);
  assert.equal(table.F1.none, 1);
});

test("live runner: refuses unsafe settings, then runs against a local mock Worker", async () => {
  const token = "t".repeat(40);
  await assert.rejects(main(["live", "--bench", "verbal", "--out", "dialogue-model/tmp"], { RESEARCH_AI_PROVIDER: "cloudflare", RESEARCH_PROXY_TOKEN: token, RESEARCH_AI_BASE_URL: "http://127.0.0.1:9/v1" }), /outside the repository/u);
  assert.equal(isOutsideRepository("/repo/..cache", "/repo"), false);
  assert.equal(isOutsideRepository("/repo/..cache/x", "/repo"), false);
  assert.equal(isOutsideRepository("/repo/sub", "/repo"), false);
  assert.equal(isOutsideRepository("/elsewhere", "/repo"), true);
  assert.equal(isOutsideRepository("/", "/repo"), true);
  const out = mkdtempSync(join(tmpdir(), "rotation-bench-"));
  await assert.rejects(main(["live", "--bench", "verbal", "--out", out], { RESEARCH_AI_PROVIDER: "openai", RESEARCH_AI_API_KEY: token, RESEARCH_AI_MODEL: "m" }), /research Worker/u);
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const body = JSON.parse(data);
      bodies.push(body);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ model: "mock", choices: [{ message: { content: '{"slot":"上段左"}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  const log = console.log, err = console.error;
  console.log = () => {}; console.error = () => {};
  try {
    await main(["live", "--bench", "verbal", "--out", out, "--concurrency", "4"], { RESEARCH_AI_PROVIDER: "cloudflare", RESEARCH_PROXY_TOKEN: token, RESEARCH_AI_BASE_URL: `http://127.0.0.1:${port}/v1` });
  } finally {
    console.log = log; console.error = err;
    server.close();
  }
  assert.equal(bodies.length, 72);
  for (const body of bodies) {
    assert.equal(body.purpose, "dialogue_turn");
    assert.equal(body.model, undefined);
  }
  const [file] = readdirSync(out);
  const saved = JSON.parse(readFileSync(join(out, file), "utf8"));
  assert.equal(saved.results.length, 72);
  const expectedHits = planVerbal().filter((i) => i.expected === "上段左").length;
  assert.equal(saved.results.filter((r: { correct: boolean }) => r.correct).length, expectedHits);
  assert.ok(summarizeAll(saved.results).verbal.byView.every((row: { chance: number }) => Math.abs(row.chance - 1 / 6) < 1e-12));
  rmSync(out, { recursive: true, force: true });
});
