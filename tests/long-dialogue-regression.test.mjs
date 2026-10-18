import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNamingTask, SLOTS, STRATEGIES } from "../dialogue-model/runtime/naming-task.mjs";
import { createDialogueSession } from "../dialogue-model/runtime/session.mjs";
import { SAFE_JUDGMENT } from "../dialogue-model/runtime/judgment/schema.mjs";
import { createTrial } from "../dialogue-model/runtime/stimuli/board.mjs";
import { createOwnImageRotationSheet } from "../dialogue-model/runtime/visual/own-image-rotation.mjs";
import { scoreTrial } from "../dialogue-model/runtime/scoring.mjs";
import {
  createReferenceGraph, applyReferenceUpdate, snapshotReferenceGraph,
  summarizeForJudge, REFERENCE_LIMITS,
} from "../dialogue-model/runtime/memory/reference-graph.mjs";

// Entirely invented Japanese exchanges and scripted outputs: a deterministic
// orchestration instrument, NOT evidence of Luna's vision, strategy, success,
// or human naturalness. Lengths sample test workloads, never runtime minima.
const LENGTHS = [60, 80, 120];
const OPTIONS = [
  { visualAid: false, referenceMemory: false }, { visualAid: true, referenceMemory: false },
  { visualAid: false, referenceMemory: true }, { visualAid: true, referenceMemory: true },
];
const SEED = 713;
const trial = createTrial({ seed: SEED }); // Real, differently arranged PNGs, rendered once.
const ownImage = { mimeType: trial.ai.mimeType, base64: trial.ai.png.toString("base64") };
let rotationUrl;
function ownRotationUrl() {
  rotationUrl ??= "data:image/png;base64," + createOwnImageRotationSheet(trial.ai.png, { enabled: true }).png.toString("base64");
  return rotationUrl;
}
const names = ["ことり", "ふね", "はっぱ", "かさ", "やま", "こねこ"];
const ids = Object.values(trial.key.ai);
const finalFor = (side) => Object.fromEntries(SLOTS.map((slot) =>
  [slot, "PRIVATE-FINAL-" + names[ids.indexOf(trial.key[side][slot])]]));
const humanLines = [
  "細長い形を見ています。仮の呼び名を相談しませんか。",
  "見立ては少し違いますが、尖りが二つある形の話ですか。",
  "今は区別しきれないので、この形はいったん保留しましょう。",
  "さっき保留した形に戻って、特徴をもう一度照らし合わせたいです。",
  "呼び名を少し直してもよさそうです。細い部分のつながりは同じですね。",
  "その名前でよいと思います。次の形の話も続けましょう。",
  "全部決めたつもりでも、似た形を取り違えていないか確かめたいです。",
  "向きの説明が違っても、同じ形を指していそうですね。",
  "さっきの呼び名を使うと、ほかの形とも区別しやすいです。",
  "はい、見立ての細部は違っても、その呼び名なら共有できそうです。",
];

function exchange(index, length) {
  const slotIndex = Math.floor(index * SLOTS.length / length);
  const step = index - Math.ceil(slotIndex * length / SLOTS.length);
  const targetSlot = SLOTS[slotIndex], name = names[slotIndex];
  const action = ["propose_name", "confirm", "defer", "revisit", "repair", "agree", "close"][step] ?? "accept";
  const judgment = { ...SAFE_JUDGMENT, action, note: "PRIVATE-JUDGE-NOTE",
    ...(!["accept", "close"].includes(action) ? { targetSlot } : {}),
    ...(["propose_name", "confirm"].includes(action) ? { candidateName: "仮の" + name } : {}),
    ...(["repair", "agree"].includes(action) ? { candidateName: name } : {}),
    ...(action === "confirm" ? { discriminatingFeature: "くぼみの数" } : {}),
    ...(action === "agree" ? { followUp: { action: "move_on", targetSlot: null, candidateName: null, discriminatingFeature: null } } : {}),
  };
  return { slotIndex, step, judgment,
    human: `相談${index + 1}: ${humanLines[step % humanLines.length]}くぼみも手掛かりにしています。`,
    ai: `返答${index + 1}: ` + (["まず仮の呼び名で相談しましょう。", "くぼみの数も確かめませんか。",
      "いったん保留しておきましょう。", "先ほどの形に戻りましょう。", `呼び名を${name}に直します。`,
      `${name}で合意しましょう。次の形も相談しましょう。`, "全て合意したので対話を終えてよさそうです。"]
      [step] ?? "その特徴なら区別しやすそうですね。"),
  };
}

const isJudge = (messages) => messages.some((m) => typeof m.content === "string" && m.content.includes("【非公開の対話判断】"));
const isFinal = (messages) => messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("【実験環境からの非公開最終提出要求"));
const publicText = (messages) => messages.filter((m) => ["user", "assistant"].includes(m.role) && typeof m.content === "string");
const acts = (judgment) => [judgment, ...(judgment.followUp ? [judgment.followUp] : [])]
  .map(({ action, targetSlot, candidateName }) => ({ action, targetSlot, candidateName }));

function instrument(length, { visualAid = false, referenceMemory = false } = {}) {
  const expectedHistory = [], expectedActs = [], expectedTraces = [];
  const counts = { judgment: 0, generation: 0, final: 0 };
  let index = 0, fault = null;
  const client = { async complete(messages) {
    const judging = isJudge(messages), final = isFinal(messages);
    counts[final ? "final" : judging ? "judgment" : "generation"]++;
    const imageMessages = messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((p) => p.type === "image_url") : []);
    assert.equal(imageMessages.length, visualAid ? 2 : 1);
    assert.equal(imageMessages[0].image_url.url, "data:image/png;base64," + ownImage.base64);
    if (visualAid) {
      assert.equal(imageMessages[1].image_url.url, ownRotationUrl());
      const ownIndex = messages.findIndex((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"));
      assert.ok(Array.isArray(messages[ownIndex + 1].content));
      assert.equal(messages[ownIndex + 1].content.find((p) => p.type === "image_url")?.image_url.url, ownRotationUrl());
    }
    // Exclude image bytes: short figure IDs could occur coincidentally in base64.
    const text = JSON.stringify(messages.map((m) => ({ ...m, content: Array.isArray(m.content)
      ? m.content.filter((p) => p.type !== "image_url") : m.content })));
    assert.doesNotMatch(text, /PRIVATE-JUDGE-NOTE|PRIVATE-HUMAN-IMAGE|PRIVATE-FINAL-|PRIVATE-TRANSPORT-ERROR|humanSubmission|aiSubmission|matchedCount/);
    for (const id of ids) assert.equal(text.includes(id), false, "scoring identity leaked to model");
    assert.equal(JSON.stringify(messages).includes(trial.human.png.toString("base64")), false);
    if (final) {
      assert.doesNotMatch(text, /ownReferences|referenceGraph|memoryOps|nameAcceptance|deferSlot|revisitSlot|private_own_slots_not_ground_truth/);
      assert.deepEqual(publicText(messages).slice(0, -1), expectedHistory);
      return { text: JSON.stringify(finalFor("ai")), model: "scripted-test-only" };
    }
    const item = exchange(index, length);
    assert.deepEqual(publicText(messages), [...expectedHistory, { role: "user", content: item.human }], "no future, duplicated, or reordered public utterances");
    if (judging) {
      const note = messages.find((m) => typeof m.content === "string" && m.content.includes('"ownJudgmentHistory"'));
      assert.ok(note);
      const memory = JSON.parse(note.content.slice(note.content.indexOf("\n") + 1));
      assert.deepEqual(memory.ownJudgmentHistory, expectedActs, "replay committed primary/follow-up acts exactly once");
      if (referenceMemory) {
        const referenceNote = messages.find((m) => typeof m.content === "string" && m.content.includes('"ownReferences"'));
        assert.ok(referenceNote);
        const references = JSON.parse(referenceNote.content.slice(referenceNote.content.indexOf("\n") + 1));
        const summary = references.ownReferences;
        assert.ok(summary, "enabled judge receives private referent memory");
        assert.equal(summary.scope, "private_own_slots_not_ground_truth");
        assert.equal(summary.revision, index, "failed attempts cannot advance reference revision");
        assert.ok(JSON.stringify(summary).length <= 6000);
        assert.deepEqual(Object.keys(summary.ownSlots), SLOTS);
        assert.equal(references.currentTurn, index + 1);
      } else assert.equal(Object.hasOwn(memory, "ownReferences"), false);
      if (fault === "judge_error") { fault = null; throw new Error("PRIVATE-TRANSPORT-ERROR"); }
      if (fault === "invalid_json") { fault = null; return { text: "not JSON", model: "scripted-test-only" }; }
      // The instrument supplies semantic interpretation only. The runtime owns
      // quotes, turn numbers, speakers, confidence, IDs and graph operations.
      return { text: JSON.stringify({ ...item.judgment, ...(referenceMemory ? { reference: {
        slots: [SLOTS[item.slotIndex]], epistemic: "grounded", intent: "feature_assertion",
        feature: { slot: SLOTS[item.slotIndex], feature: "くぼみ", polarity: "confirmed" },
        nameAcceptance: null, deferSlot: null, revisitSlot: null,
      } } : {}) }), model: "scripted-test-only" };
    }
    assert.doesNotMatch(text, /ownJudgmentHistory|repair-first|bypass-enabled|ownReferences|referenceGraph|memoryOps|nameAcceptance|deferSlot|revisitSlot|private_own_slots_not_ground_truth/);
    if (fault === "generation_error") { fault = null; throw new Error("PRIVATE-TRANSPORT-ERROR"); }
    return { text: item.ai, model: "scripted-test-only", retryCount: 0 };
  } };
  return { client, counts, expectedHistory, expectedTraces,
    select(next) { index = next; }, failWith(next) { fault = next; },
    committed() {
      const item = exchange(index, length);
      expectedHistory.push({ role: "user", content: item.human }, { role: "assistant", content: item.ai });
      expectedActs.push(...acts(item.judgment));
      expectedTraces.push({ turnIndex: index + 1, status: "committed" });
    },
    failed(status) { expectedTraces.push({ turnIndex: index + 1, status }); },
  };
}

function privateState(state, completed = false) {
  for (const key of ["key", "ownLedger", "judgments", "requests", "scoring", "options", "reference", "referenceGraph", "ownReferences", "visualAid", "referenceMemory"]) {
    assert.equal(Object.hasOwn(state, key), false, key + " must remain private");
  }
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE-JUDGE-NOTE|PRIVATE-TRANSPORT-ERROR|ownJudgmentHistory|memoryOps|nameAcceptance|deferSlot|revisitSlot/);
  if (!completed) {
    assert.equal(Object.hasOwn(state, "aiSubmission"), false);
    assert.equal(Object.hasOwn(state, "result"), false);
    // The participant's own private human submission may be visible to them.
    assert.doesNotMatch(JSON.stringify(state.publicHistory), /PRIVATE-FINAL-/);
  }
}

async function exerciseTurns(target, script, length, history, assertDuring = () => {}) {
  const failedAt = new Set([1, Math.floor(length / 2), length - 1]);
  for (let index = 0; index < length; index++) {
    script.select(index);
    const utterance = exchange(index, length).human;
    if (failedAt.has(index) || index === length - 2) {
      const status = index === length - 2 ? "judge_error" : "generation_error";
      script.failWith(status);
      const before = history();
      await assert.rejects(target.turn(utterance));
      script.failed(status);
      assert.deepEqual(history(), before, "failed turn cannot publish either half of an exchange");
      await assertDuring(false);
    }
    if (index === Math.floor(length / 4)) script.failWith("invalid_json");
    await target.turn(utterance);
    script.committed();
    assert.deepEqual(history(), script.expectedHistory);
    await assertDuring(true);
  }
}

for (const strategy of STRATEGIES) for (const length of LENGTHS) {
  test(`${strategy}: session survives ${length} exchanges with atomic ledger, retries and ordered traces`, async () => {
    const script = instrument(length);
    const session = createDialogueSession({ strategy, client: script.client,
      image: { ...ownImage, humanImage: "PRIVATE-HUMAN-IMAGE", key: trial.key } });
    await exerciseTurns(session, script, length, () => session.getHistory());
    const traces = session.getJudgmentHistory();
    assert.deepEqual(script.counts, { judgment: length + 5, generation: length + 3, final: 0 });
    assert.deepEqual(traces.map(({ turnIndex, status }) => ({ turnIndex, status })), script.expectedTraces);
    assert.equal(traces.filter((trace) => trace.status === "committed").length, length);
    for (let index = 0; index < traces.length; index++) {
      const trace = traces[index];
      assert.deepEqual(trace.ownLedgerBefore, index ? traces[index - 1].ownLedgerAfter : Object.fromEntries(SLOTS.map((slot) => [slot, { status: "unassigned", name: null }])));
      if (trace.status !== "committed") assert.deepEqual(trace.ownLedgerBefore, trace.ownLedgerAfter);
    }
    const retried = traces.find((trace) => trace.status === "committed" && trace.turnIndex === Math.floor(length / 4) + 1);
    assert.deepEqual(retried.validation, { attempts: 2, fallback: false, failures: ["invalid_json"] });
    assert.deepEqual(session.getOwnLedger(), Object.fromEntries(SLOTS.map((slot, i) => [slot, { status: "agreed", name: names[i] }])));
    // Detached snapshots cannot rewrite committed history, ledger or diagnostics.
    session.getHistory()[0].content = "tampered";
    session.getOwnLedger()[SLOTS[0]].name = "tampered";
    traces[0].status = "tampered";
    assert.deepEqual(session.getHistory(), script.expectedHistory);
    assert.equal(session.getOwnLedger()[SLOTS[0]].name, names[0]);
    assert.equal(session.getJudgmentHistory()[0].status, "committed");
  });

  for (const options of OPTIONS) test(`${strategy}: ${length} naming exchanges (visual=${options.visualAid}, memory=${options.referenceMemory}) stay private and score only after both submissions`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "long-dialogue-regression-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const script = instrument(length, options);
    let scoreCalls = 0;
    const task = await createNamingTask({ client: script.client, strategy, seed: SEED,
      ...options, createTrial: () => trial, runDir: directory, scoreTrial(input) {
        scoreCalls++;
        assert.deepEqual(input, { key: trial.key, humanSubmission: finalFor("human"), aiSubmission: finalFor("ai") });
        return scoreTrial(input);
      } });
    assert.deepEqual(task.getHumanImage().png, trial.human.png);
    const detachedImage = task.getHumanImage(); detachedImage.png.fill(0);
    assert.deepEqual(task.getHumanImage().png, trial.human.png);
    const [filename] = await readdir(directory);
    const record = async () => JSON.parse(await readFile(join(directory, filename), "utf8"));
    await exerciseTurns(task, script, length, () => task.getState().publicHistory, async () => {
      const state = task.getState();
      privateState(state);
      assert.equal(state.status, "dialogue", "close speech and long history cannot force submission");
      assert.equal(state.busy, false);
      assert.equal(state.humanSubmitted, false); assert.equal(state.aiSubmitted, false);
      assert.equal(scoreCalls, 0);
      if (options.referenceMemory) {
        const saved = await record(), graph = saved.referenceGraph;
        const committedCount = script.expectedHistory.length / 2;
        assert.equal(graph.revision, committedCount, "only successful exchanges advance graph revision");
        assert.equal(graph.lastTurn, committedCount);
        assert.ok(JSON.stringify(graph).length <= REFERENCE_LIMITS.graphChars);
        assert.ok(graph.mentions.length <= REFERENCE_LIMITS.records);
        for (const slot of SLOTS) assert.ok(graph.ownSlots[slot].features.length <= REFERENCE_LIMITS.featuresPerSlot);
        if (committedCount) assert.deepEqual(saved.judgments.at(-1).memory, {
          opsApplied: saved.judgments.at(-1).status === "committed" ? 2 : 0, rejected: null,
          interpretation: saved.judgments.at(-1).status !== "judge_error",
        });
        for (const mention of graph.mentions) {
          assert.equal(mention.id, `${mention.sourceTurn}:human`, "runtime assigns public-source IDs");
          assert.equal(mention.speaker, "human");
          assert.equal(mention.quote, exchange(mention.sourceTurn - 1, length).human, "runtime quotes actual public speech");
          assert.equal(mention.scope, "human_reference_interpretation");
        }
      }
    });
    const beforeFinal = await record();
    assert.deepEqual(beforeFinal.options, options);
    if (options.referenceMemory) {
      assert.equal(beforeFinal.referenceGraph.revision, length);
      assert.equal(beforeFinal.referenceGraph.lastTurn, length);
      assert.ok(!beforeFinal.referenceGraph.mentions.some((mention) => mention.id === "1:human"), "old unpinned mentions are pruned in the session too");
      for (const trace of beforeFinal.judgments) {
        if (trace.judgment) {
          assert.equal(Object.hasOwn(trace.judgment, "reference"), false, "raw interpretation is excluded from persisted judgment trace");
          assert.equal(Object.hasOwn(trace.judgment, "memoryOps"), false);
        }
      }
    } else assert.equal(Object.hasOwn(beforeFinal, "referenceGraph"), false);
    assert.equal(beforeFinal.scoring, null);
    assert.equal(beforeFinal.humanSubmission, null); assert.equal(beforeFinal.aiSubmission, null);
    assert.deepEqual(beforeFinal.publicHistory, script.expectedHistory);
    assert.deepEqual(beforeFinal.judgments.map(({ turnIndex, status }) => ({ turnIndex, status })), script.expectedTraces);
    assert.equal(beforeFinal.judgments.filter((trace) => trace.status === "committed").length, length);
    for (const trace of beforeFinal.judgments.filter((item) => item.status !== "committed")) {
      assert.deepEqual(trace.ownLedgerBefore, trace.ownLedgerAfter);
    }
    assert.deepEqual(beforeFinal.ownLedger, Object.fromEntries(SLOTS.map((slot, i) => [slot, { status: "agreed", name: names[i] }])));
    assert.equal(beforeFinal.requests.filter((request) => request.status === "error").length, 4);
    assert.doesNotMatch(JSON.stringify(beforeFinal), /PRIVATE-TRANSPORT-ERROR|image_url|base64/);
    const aiFirst = length !== 80; // Both private submission orders in each strategy.
    const partial = aiFirst ? await task.submitAI() : await task.submitHuman(finalFor("human"));
    privateState(partial); assert.equal(scoreCalls, 0);
    assert.equal((await record()).scoring, null);
    const completed = aiFirst ? await task.submitHuman(finalFor("human")) : await task.submitAI();
    privateState(completed, true);
    assert.equal(completed.status, "completed");
    assert.equal(completed.result.matchedCount, 6); assert.equal(completed.result.success, true);
    assert.equal(scoreCalls, 1); assert.equal(script.counts.final, 1);
    assert.deepEqual(script.counts, { judgment: length + 5, generation: length + 3, final: 1 }, "no additional judgment/model phase is introduced");
    assert.deepEqual(completed.publicHistory, script.expectedHistory, "private submissions cannot create public turns");
    await assert.rejects(task.turn("提出後の発話"), { code: "dialogue_closed" });
    await assert.rejects(task.submitAI(), { code: "already_submitted" });
    await assert.rejects(task.submitHuman(finalFor("human")), { code: "already_submitted" });
    assert.equal(scoreCalls, 1);
    const saved = await record();
    if (options.referenceMemory) assert.deepEqual(saved.referenceGraph, beforeFinal.referenceGraph, "private final submissions do not mutate referent memory");
    assert.equal(saved.judgments.length, length + 4);
    assert.deepEqual(saved.publicHistory, script.expectedHistory);
    assert.equal(saved.scoring.result.success, true);
  });
}

for (const strategy of STRATEGIES) test(`${strategy}: a short dialogue can submit without a forced minimum length`, async () => {
  const script = instrument(60);
  let scoreCalls = 0;
  const task = await createNamingTask({ client: script.client, strategy, seed: SEED,
    createTrial: () => trial, runDir: "", scoreTrial(input) { scoreCalls++; return scoreTrial(input); } });
  await task.turn(exchange(0, 60).human);
  script.committed();
  await task.submitHuman(finalFor("human"));
  assert.equal(scoreCalls, 0);
  const completed = await task.submitAI();
  assert.equal(scoreCalls, 1);
  assert.equal(completed.status, "completed");
  assert.equal(completed.publicHistory.length, 2);
});

for (const length of LENGTHS) test(`standalone reference graph: ${length} updates remain bounded and preserve early names`, () => {
  // Graph API is tested separately: this does not claim session integration.
  const observations = SLOTS.map((slot) => ({ slot, feature: "くぼみ" }));
  let graph = createReferenceGraph({ ownObservations: observations });
  for (let turn = 1; turn <= length; turn++) {
    const slotIndex = (turn - 1) % SLOTS.length, slot = SLOTS[slotIndex];
    const naming = turn <= SLOTS.length;
    const quote = naming ? `${names[slotIndex]}で合意します` : `くぼみをもう一度確認しました（相談${turn}）`;
    const mention = { kind: "mention", id: `${turn}:m`, sourceTurn: turn, speaker: "human", quote,
      slots: [slot], confidence: 0.8, epistemic: "grounded", intent: naming ? "name_acceptance" : "feature_assertion", antecedent: null };
    const operation = naming
      ? { kind: "name", id: `${turn}:name`, slot, name: names[slotIndex], agreement: "explicit", mentionIds: [mention.id], replaces: null }
      : { kind: "feature", id: `${turn}:feature`, slot, feature: "くぼみ", polarity: "confirmed", mentionId: mention.id };
    const update = { expectedRevision: graph.revision, turn, operations: [mention, operation] };
    const options = { publicTurns: [{ turn, speaker: "human", text: quote }] };
    if (turn === Math.floor(length / 2)) {
      const before = JSON.stringify(graph);
      assert.throws(() => applyReferenceUpdate(graph, update, { ...options, generationSucceeded: false }), { code: "generation_not_succeeded" });
      assert.equal(JSON.stringify(graph), before);
    }
    graph = applyReferenceUpdate(graph, update, { ...options, generationSucceeded: true });
    assert.ok(graph.records.length <= REFERENCE_LIMITS.records);
    assert.ok(JSON.stringify(graph).length <= REFERENCE_LIMITS.graphChars);
    const summary = summarizeForJudge(graph, { maxChars: 3000 });
    assert.ok(summary.length <= 3000);
    assert.deepEqual(Object.keys(JSON.parse(summary).ownSlots), SLOTS);
    assert.equal(graph.revision, turn); assert.equal(graph.lastTurn, turn);
  }
  const snapshot = snapshotReferenceGraph(graph);
  for (const [index, slot] of SLOTS.entries()) {
    assert.equal(snapshot.ownSlots[slot].status, "agreed");
    assert.equal(snapshot.ownSlots[slot].candidate.name, names[index]);
    assert.deepEqual(snapshot.ownSlots[slot].candidate.sourceTurns, [index + 1]);
    assert.equal(snapshot.ownSlots[slot].features.length, REFERENCE_LIMITS.featuresPerSlot);
    assert.deepEqual(snapshot.ownSlots[slot].ownObservations, [{ feature: "くぼみ", source: "own_image" }]);
  }
  assert.ok(!graph.records.some((record) => record.id === "7:feature"), "old unpinned reports are actually pruned");
  assert.ok(graph.records.some((record) => record.id === "1:m"), "early current-name provenance remains pinned");
  assert.ok(snapshot.mentions.filter((mention) => mention.speaker === "human").every((mention) => mention.scope === "human_reference_interpretation"));
});
