import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable, Readable } from "node:stream";
import { createNamingTask, SLOTS, STRATEGIES } from "../dialogue-model/runtime/naming-task.mjs";
import { createTrial } from "../dialogue-model/runtime/stimuli/board.mjs";
import { scoreTrial } from "../dialogue-model/runtime/scoring.mjs";
import { main as namingCLI } from "../dialogue-model/runtime/naming-cli.mjs";

// These scripted outputs are a test instrument, not evidence that Luna can
// perceive these images, negotiate names, or implement either strategy.
const SEED = 713;
const trial = createTrial({ seed: SEED });
const names = ["こねこ", "ふね", "はっぱ", "かさ", "やま", "とり"];
const ids = [...new Set(Object.values(trial.key.human))].sort();
const nameById = Object.fromEntries(ids.map((id, i) => [id, names[i]]));
const submission = (side) => Object.fromEntries(SLOTS.map((slot) => [slot, nameById[trial.key[side][slot]]]));
const isJudge = (messages) => messages.some((m) => m.role === "system" && m.content.includes("【非公開の対話判断】"));
const isFinal = (messages) => messages.at(-1).content.includes("最終提出要求");
const judgment = { action: "propose_name", targetSlot: SLOTS[0], candidateName: "PRIVATE-LEDGER-CANDIDATE",
  discriminatingFeature: null, note: "PRIVATE-JUDGMENT-NOTE" };

// Optional, test-local mutation. The red command deliberately substitutes a
// position-based scorer without editing production or any pre-existing test:
// NAMING_REGRESSION_FAULT=slot-alignment node --test --test-name-pattern='six-name oracle' tests/naming-regression.test.mjs
const scoringUnderTest = process.env.NAMING_REGRESSION_FAULT === "slot-alignment"
  ? (input) => scoreTrial({ ...input, key: { human: input.key.human, ai: input.key.human } })
  : scoreTrial;

function assertSixMatched(result) {
  assert.equal(result.success, true, "six distinct names must agree by private figure correspondence");
  assert.equal(result.matchedCount, 6);
  assert.equal(result.total, 6);
  assert.equal(result.figures.length, 6);
  for (const id of ids) {
    const row = result.figures.find((item) => item.figureId === id);
    assert.ok(row, "every private figure must have exactly one result row");
    assert.equal(row.human.slot, SLOTS.find((slot) => trial.key.human[slot] === id));
    assert.equal(row.ai.slot, SLOTS.find((slot) => trial.key.ai[slot] === id));
    assert.notEqual(row.human.slot, row.ai.slot);
    assert.equal(row.human.rawName, nameById[id]);
    assert.equal(row.ai.rawName, nameById[id]);
    assert.equal(row.matched, true);
  }
}

function assertPrivateState(state, { finalVisible = false } = {}) {
  for (const field of ["key", "judgments", "ownLedger", "ownJudgmentHistory", "requests", "scoring"]) {
    assert.equal(Object.hasOwn(state, field), false, field + " must remain private");
  }
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE-LEDGER-CANDIDATE|PRIVATE-JUDGMENT-NOTE|targetSlot|discriminatingFeature/);
  if (!finalVisible) {
    assert.equal(Object.hasOwn(state, "aiSubmission"), false);
    assert.equal(Object.hasOwn(state, "result"), false);
    for (const id of ids) assert.equal(JSON.stringify(state).includes(id), false);
  }
}

function scriptedClient(finalSubmission = submission("ai")) {
  const calls = [];
  let failGeneration = false;
  const client = {
    async complete(messages) {
      calls.push(structuredClone(messages));
      if (isJudge(messages)) {
        const index = messages.filter((m) => m.role === "user" && typeof m.content === "string").length - 1;
        return { text: JSON.stringify({ ...judgment, targetSlot: SLOTS[index % 6],
          candidateName: judgment.candidateName + "-" + index }), model: "scripted-test-only" };
      }
      if (isFinal(messages)) return { text: JSON.stringify(finalSubmission), model: "scripted-test-only" };
      if (failGeneration) { failGeneration = false; throw new Error("PRIVATE-UPSTREAM-ERROR"); }
      return { text: "公開の固定応答です。", model: "scripted-test-only" };
    },
  };
  return { client, calls, failNextGeneration() { failGeneration = true; } };
}

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), "naming-regression-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function taskOptions(client, strategy, extra = {}) {
  return { client, strategy, seed: SEED, createTrial: () => trial, scoreTrial: scoringUnderTest, runDir: "", ...extra };
}

test("six-name oracle follows private shuffled figures, not identical displayed positions", () => {
  assert.equal(ids.length, 6);
  assert.notDeepEqual(trial.human.png, trial.ai.png);
  for (const slot of SLOTS) assert.notEqual(trial.key.human[slot], trial.key.ai[slot]);
  // Check real rendered stimuli rather than an image-free scoring fixture.
  for (const side of ["human", "ai"]) {
    assert.equal(trial[side].png.subarray(1, 4).toString(), "PNG");
    assert.equal(trial[side].png.readUInt32BE(16), 1200);
    assert.equal(trial[side].png.readUInt32BE(20), 800);
  }
  assertSixMatched(scoringUnderTest({ key: trial.key, humanSubmission: submission("human"), aiSubmission: submission("ai") }));
});

test("independent wrong fixtures falsify six-name success: position-copy, swap, duplicate, missing", () => {
  const humanSubmission = submission("human"), aiSubmission = submission("ai");
  const evaluate = (human, ai, key = trial.key) => scoreTrial({ key, humanSubmission: human, aiSubmission: ai });
  const positionCopy = evaluate(humanSubmission, { ...humanSubmission });
  assert.equal(positionCopy.success, false);
  assert.equal(positionCopy.matchedCount, 0);
  // The exact success oracle itself rejects a superficially six-row result.
  assert.throws(() => assertSixMatched(positionCopy), assert.AssertionError);

  const swapped = { ...aiSubmission };
  [swapped[SLOTS[1]], swapped[SLOTS[4]]] = [swapped[SLOTS[4]], swapped[SLOTS[1]]];
  const swapResult = evaluate(humanSubmission, swapped);
  assert.equal(swapResult.success, false);
  assert.equal(swapResult.matchedCount, 4);
  assert.deepEqual(new Set(swapResult.figures.filter((row) => !row.matched).map((row) => row.figureId)),
    new Set([trial.key.ai[SLOTS[1]], trial.key.ai[SLOTS[4]]]));

  const repeated = Object.fromEntries(SLOTS.map((slot) => [slot, "同じ名前"]));
  const duplicate = evaluate(repeated, repeated);
  assert.equal(duplicate.matchedCount, 6);
  assert.equal(duplicate.success, false, "six pairwise matches alone are insufficient");
  assert.equal(duplicate.duplicateNames.human[0].slots.length, 6);
  assert.equal(duplicate.duplicateNames.ai[0].slots.length, 6);
  assert.throws(() => assertSixMatched(duplicate), assert.AssertionError);

  const missing = { ...aiSubmission }; delete missing[SLOTS[2]];
  const missingResult = evaluate(humanSubmission, missing);
  assert.equal(missingResult.success, false);
  assert.equal(missingResult.matchedCount, 5);
  assert.deepEqual(missingResult.unnamed.ai, [{ slot: SLOTS[2], figureId: trial.key.ai[SLOTS[2]] }]);

  for (const badKey of [
    { ...trial.key, ai: { ...trial.key.ai, [SLOTS[0]]: trial.key.ai[SLOTS[1]] } },
    { ...trial.key, human: Object.fromEntries(SLOTS.slice(1).map((slot) => [slot, trial.key.human[slot]])) },
    { ...trial.key, ai: { ...trial.key.ai, [SLOTS[0]]: "unknown-private-figure" } },
  ]) assert.throws(() => evaluate(humanSubmission, aiSubmission, badKey), TypeError);
});

for (const strategy of STRATEGIES) {
  test(`${strategy}: six names score only after both private submissions, in either order`, async (t) => {
    for (const first of ["human", "ai"]) {
      const script = scriptedClient();
      let scoreCalls = 0;
      const task = await createNamingTask(taskOptions(script.client, strategy, { scoreTrial: (args) => {
        scoreCalls++; return scoringUnderTest(args);
      } }));
      assertPrivateState(task.getState());
      assert.deepEqual(task.getHumanImage().png, trial.human.png);
      await task.turn("公開の図形の相談です。");
      const committedHistory = task.getState().publicHistory;
      assert.equal(committedHistory.length, 2);
      assertPrivateState(task.getState());
      const partial = first === "human" ? await task.submitHuman(submission("human")) : await task.submitAI();
      assert.equal(scoreCalls, 0);
      assertPrivateState(partial);
      const completed = first === "human" ? await task.submitAI() : await task.submitHuman(submission("human"));
      assertSixMatched(completed.result);
      assert.equal(scoreCalls, 1);
      assertPrivateState(completed, { finalVisible: true });
      assert.deepEqual(completed.publicHistory, committedHistory, "private final requests never become chat turns");
      await assert.rejects(task.submitHuman(submission("human")), { code: "already_submitted" });
      await assert.rejects(task.submitAI(), { code: "already_submitted" });
      await assert.rejects(task.turn("終了後の発話"), { code: "dialogue_closed" });
      assert.equal(scoreCalls, 1);

      for (const messages of script.calls) {
        const serialized = JSON.stringify(messages);
        // Short IDs such as F1 may occur coincidentally in PNG base64 bytes.
        const textOnly = JSON.stringify(messages.map((m) => ({ ...m, content: Array.isArray(m.content)
          ? m.content.filter((part) => part.type !== "image_url") : m.content })));
        for (const id of ids) assert.equal(textOnly.includes(id), false, "gold correspondence must not enter the AI context");
        assert.equal(serialized.includes(trial.human.png.toString("base64")), false);
        const images = messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((part) => part.type === "image_url") : []);
        assert.equal(images.length, 1);
        assert.equal(images[0].image_url.url, "data:image/png;base64," + trial.ai.png.toString("base64"));
        assert.doesNotMatch(serialized, /humanSubmission|aiSubmission|matchedCount/);
      }
      assert.equal(script.calls.filter(isFinal).length, 1);
      // Returned snapshots must not mutate already committed task state.
      completed.result.success = false; completed.publicHistory[0].content = "tampered";
      assertSixMatched(task.getState().result);
      assert.deepEqual(task.getState().publicHistory, committedHistory);
    }
  });

  test(`${strategy}: failed generation rolls back history and ledger, retry commits once`, async (t) => {
    const dir = await temporary(t);
    const script = scriptedClient();
    const task = await createNamingTask(taskOptions(script.client, strategy, { runDir: dir }));
    await task.turn("最初の公開発話");
    const before = task.getState().publicHistory;
    script.failNextGeneration();
    await assert.rejects(task.turn("やり直す公開発話"), { code: "ai_unavailable" });
    assert.deepEqual(task.getState().publicHistory, before);
    assert.equal(task.getState().busy, false);
    assertPrivateState(task.getState());
    const [file] = await readdir(dir);
    const failedRecord = JSON.parse(await readFile(join(dir, file), "utf8"));
    assert.equal(failedRecord.judgments.at(-1).status, "generation_error");
    assert.deepEqual(failedRecord.judgments.at(-1).ownLedgerBefore, failedRecord.judgments.at(-1).ownLedgerAfter);
    assert.equal(failedRecord.ownLedger[SLOTS[1]].status, "unassigned");
    await task.turn("やり直す公開発話");
    const record = JSON.parse(await readFile(join(dir, file), "utf8"));
    assert.deepEqual(record.judgments.map((item) => item.status), ["committed", "generation_error", "committed"]);
    assert.equal(record.ownLedger[SLOTS[1]].name, judgment.candidateName + "-1");
    assert.deepEqual(record.publicHistory, [...before,
      { role: "user", content: "やり直す公開発話" }, { role: "assistant", content: "公開の固定応答です。" }]);
    assert.deepEqual(task.getState().publicHistory, record.publicHistory);
    const retryJudge = script.calls.filter(isJudge).at(-1);
    const memory = JSON.parse(retryJudge.find((m) => m.role === "system" && m.content.includes('"ownJudgmentHistory"')).content.split("\n").at(-1));
    assert.equal(memory.ownJudgmentHistory.length, 1, "failed judgment must not be replayed as committed");
    assert.equal(record.scoring, null);
    assert.doesNotMatch(JSON.stringify(record), /PRIVATE-UPSTREAM-ERROR|image_url|base64/);
  });

  test(`${strategy}: final task flow rejects swapped, duplicate and unnamed correspondences`, async () => {
    const swapped = submission("ai");
    [swapped[SLOTS[0]], swapped[SLOTS[5]]] = [swapped[SLOTS[5]], swapped[SLOTS[0]]];
    const repeated = Object.fromEntries(SLOTS.map((slot) => [slot, "同じ名前"]));
    const unnamed = { ...submission("ai"), [SLOTS[3]]: "" };
    for (const [human, ai, matchedCount] of [
      [submission("human"), swapped, 4], [repeated, repeated, 6], [submission("human"), unnamed, 5],
    ]) {
      const script = scriptedClient(ai);
      const task = await createNamingTask(taskOptions(script.client, strategy));
      await task.submitHuman(human);
      const state = await task.submitAI();
      assert.equal(state.status, "completed");
      assert.equal(state.result.success, false);
      assert.equal(state.result.matchedCount, matchedCount);
      assert.deepEqual(state.publicHistory, []);
    }
    const script = scriptedClient(), task = await createNamingTask(taskOptions(script.client, strategy));
    const incomplete = submission("human"); delete incomplete[SLOTS[0]];
    await assert.rejects(task.submitHuman(incomplete), { code: "invalid_submission" });
    assert.equal(task.getState().humanSubmitted, false);
    assert.equal(task.getState().status, "dialogue");
    assert.equal(script.calls.length, 0);
    const privateHuman = Object.fromEntries(SLOTS.map((slot, i) => [slot, "PRIVATE-HUMAN-COMMIT-" + i]));
    await task.submitHuman(privateHuman); await task.submitAI();
    assert.doesNotMatch(JSON.stringify(script.calls), /PRIVATE-HUMAN-COMMIT-/);
  });

  test(`${strategy}: CLI uses actual six-figure scoring and never sends future script lines`, async (t) => {
    const dir = await temporary(t), script = scriptedClient();
    const path = join(dir, "script.jsonl");
    await writeFile(path, [JSON.stringify({ utterance: "最初の公開発話" }), JSON.stringify({ utterance: "FUTURE-PUBLIC-LINE" }),
      JSON.stringify({ submission: submission("human") })].join("\n"));
    let text = "";
    const output = new Writable({ write(chunk, _encoding, done) { text += chunk; done(); } });
    const state = await namingCLI(["--strategy", strategy, "--seed", String(SEED), "--image-dir", join(dir, "images"), "--script", path],
      { RESEARCH_RUN_DIR: "" }, { client: script.client, createTrial: () => trial, output });
    assertSixMatched(state.result);
    assert.equal(state.publicHistory.length, 4);
    assert.equal(script.calls.length, 5);
    assert.doesNotMatch(JSON.stringify(script.calls.slice(0, 2)), /FUTURE-PUBLIC-LINE/);
    const [image] = await readdir(join(dir, "images"));
    assert.deepEqual(await readFile(join(dir, "images", image)), trial.human.png);
    assert.match(text, /provisional/);
    assert.match(text, /"success":true/);
    assert.doesNotMatch(text, /PRIVATE-JUDGMENT-NOTE|PRIVATE-LEDGER-CANDIDATE|image_url/);
  });
}

test("interactive CLI recovers after a failed generation without duplicating the retried turn", async (t) => {
  const dir = await temporary(t), script = scriptedClient();
  script.failNextGeneration();
  let text = "";
  const state = await namingCLI(["--strategy", "repair-first", "--seed", String(SEED), "--image-dir", join(dir, "images")],
    { RESEARCH_RUN_DIR: "" }, { client: script.client, createTrial: () => trial,
      input: Readable.from(["同じ公開発話\n同じ公開発話\n/exit\n"]),
      output: new Writable({ write(chunk, _encoding, done) { text += chunk; done(); } }) });
  assert.deepEqual(state.publicHistory, [{ role: "user", content: "同じ公開発話" }, { role: "assistant", content: "公開の固定応答です。" }]);
  assert.equal(state.status, "dialogue");
  assert.match(text, /再入力できます/);
  assert.doesNotMatch(text, /PRIVATE-UPSTREAM-ERROR|PRIVATE-JUDGMENT-NOTE/);
});
