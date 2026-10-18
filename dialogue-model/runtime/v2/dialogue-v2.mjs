// v2 dialogue: unlabeled scattered boards, opaque own ids, asynchronous human
// messages. This module is a pure adapter for the human message queue: each
// runAiTurn works on one immutable public snapshot plus a detached private state
// and returns the next private state; the queue alone decides whether to commit.
// v1 (createDialogueSession) is untouched.
import { createLunaJudge } from "../judgment/luna.mjs";
import { createOwnLedger, validateJudgment, applyJudgment } from "../judgment/schema.mjs";
import { STRATEGIES, TASK_INSTRUCTIONS_V2, ownImageMessage, publicMessages } from "../judgment/instructions.mjs";
import { createReferenceGraph, applyReferenceUpdate, snapshotReferenceGraph, ReferenceGraphError, REFERENCE_LIMITS } from "../memory/reference-graph.mjs";
import { stageMemory, prepareMemory } from "../judgment/memory.mjs";

// Identical across strategies. Holistic first; analysis only when the judge asks for it.
export const GENERATOR_INSTRUCTIONS_V2 = [
  "【公開発話の生成】与えられた判断を、相手に向けた自然な日本語のチャット発話にしてください。",
  "まず相手の発話に短く応じ、必要なら全体の印象・身近なものへの見立てを1つ伝えてください。形の分析は、判断に discriminatingFeature があるとき（相手が識別に迷う・詳細を求める、複数候補が残る、食い違いが未解決など）だけにし、その場合も特徴は1つに絞って相手の反応を待ってください。",
  "挨拶や「どれからにしますか」のような漠然とした開始には、短く受け止めて相手に選んでもらうか、簡単な見立てを1つだけ出してください。先回りして詳しい形の説明や名前の一括提案をしないでください。",
  "1回は1〜2文、親しみやすいです・ます調で返してください。講義調、長い前置き、特徴の列挙は避けてください。短さ自体は目的ではありません。",
  "指定されたactionの対話機能を実現し、自分で別のactionに置き換えないでください。followUpがあれば主actionを先に、両方を全体で1〜2文にまとめてください。",
  "agreeにdiscriminatingFeatureがあるときは、質問にせず、合意の発話の中でその特徴に短く触れて、どの図形のことか相手に分かるようにしてください。",
  "confirmは相手への短い確認、propose_nameは命名の提案として表現し、どちらも合意を表明しないでください。合意を表明できるのはagreeのときだけです。repairでは自己訂正を明示し、repair以外では取り違えや取り消しを表明しないでください。defer/revisitは保留・再訪であることが分かるように伝えてください。acceptでは受け止めるだけにしてください。",
  "targetSlotや内部参照ID、画像内の座標・範囲は自分だけの作業メモです。相手に言わず、位置での指定も求めないでください。相手の画面では配置も向きも異なります。",
  "自分の画面の向きに依存する上下左右・右向き・上端・下端などの語で形を説明しないでください。特徴を伝えるときは、回転しても変わらない尖りの数や大小・くぼみ・細長さ・四角の有無・部分同士のつながりから選んでください。",
  "公開履歴と矛盾する説明、同じ確認の言い換え反復、画像にない特徴の追加をしないでください。判断JSON、作業メモ、方略の説明、思考過程は出力せず、公開する発話だけを返してください。",
].join("\n");

const FINAL_INSTRUCTIONS_V2 = [
  "【実験環境からの非公開最終提出要求。対話相手の発話ではありません】",
  "対話は終了しました。自分自身の画像と公開対話履歴だけから、自分の6図形それぞれの最終名称を提出してください。",
  "JSONオブジェクトだけを返してください。キーは作業メモにある自分の6つの内部参照IDで、値は名称の文字列です。合意できていない図形は空文字列にしてください。",
  "説明、Markdown、追加キーは含めないでください。",
].join("\n");

const clone = (value) => structuredClone(value);

/** Public events -> chat messages, keeping every speaker turn (consecutive human messages stay distinct). */
export function eventsToHistory(events) {
  return events.map((event) => {
    if (!event || !["human", "ai"].includes(event.speaker) || typeof event.text !== "string") throw new Error("Invalid public event");
    return { role: event.speaker === "human" ? "user" : "assistant", content: event.text };
  });
}

/** Public events -> provenance turns numbered by event sequence, newest window only. */
export function eventsToPublicTurns(events) {
  return events.map((event) => ({ turn: event.seq, speaker: event.speaker, text: event.text })).slice(-REFERENCE_LIMITS.publicTurns);
}

function abortIf(signal) {
  if (signal?.aborted) {
    const error = new Error("superseded");
    error.name = "AbortError";
    throw error;
  }
}

/**
 * @param {{ client, strategy, image: {mimeType, base64}, anchors: {id, bbox, centroid}[], judge?, referenceMemory?: boolean }} options
 */
export function createDialogueV2({ client, strategy, image, anchors, judge = null, referenceMemory = false }) {
  if (!client || typeof client.complete !== "function") throw new Error("A chat client is required");
  if (!STRATEGIES.includes(strategy)) throw new Error("Unsupported dialogue strategy");
  if (typeof referenceMemory !== "boolean") throw new Error("Invalid memory option");
  const ownImage = { mimeType: image.mimeType, base64: image.base64 };
  ownImageMessage(ownImage);
  const slots = anchors.map((anchor) => anchor.id);
  const ownAnchors = anchors.map(({ id, bbox, centroid }) => ({ id, bbox: { ...bbox }, centroid: { ...centroid } }));
  const dialogueJudge = judge ?? createLunaJudge(client);
  // Research-only trace of every attempted run (including superseded or failed ones).
  const attempts = [];

  function initialPrivateState() {
    return {
      ledger: createOwnLedger(slots),
      judgments: [],
      graph: referenceMemory ? createReferenceGraph({ slots }) : null,
    };
  }

  async function runAiTurn({ events, signal, privateState, lastEventId }) {
    const state = clone(privateState);
    const humanEvents = events.filter((event) => event.speaker === "human");
    const latest = humanEvents.at(-1);
    if (!latest) throw new Error("No human message to answer");
    const history = eventsToHistory(events);
    const publicTurns = state.graph ? eventsToPublicTurns(events) : null;
    const trace = { turnIndex: latest.seq, lastEventId, humanEventIds: events.filter((e) => e.speaker === "human" &&
      e.seq > (state.judgments.at(-1)?.turnIndex ?? 0)).map((e) => e.id),
      judgment: null, ownLedgerBefore: clone(state.ledger), ownLedgerAfter: clone(state.ledger), validation: null, status: "judge_error" };
    if (state.graph) trace.memory = { opsApplied: 0, rejected: null, interpretation: false };
    attempts.push(trace);
    const rawJudgment = await dialogueJudge.judge({
      version: 2, image: ownImage, ownAnchors, publicHistory: history, strategy, ownLedger: clone(state.ledger),
      ...(state.graph ? { referenceContext: { graph: state.graph, turn: latest.seq, publicTurns } } : {}),
      ownJudgmentHistory: state.judgments.flatMap(({ judgment }) => [judgment, ...(judgment.followUp ? [judgment.followUp] : [])]
        .map(({ action, targetSlot, candidateName }) => ({ action, targetSlot, candidateName }))),
    });
    abortIf(signal);
    let judgment, memoryUpdate = null;
    if (state.graph) {
      const core = { ...rawJudgment }; delete core.reference;
      const validCore = validateJudgment(core, { ownLedger: state.ledger, agreeEvidence: true });
      try {
        judgment = validateJudgment(rawJudgment, { ownLedger: state.ledger, agreeEvidence: true });
        const staged = prepareMemory(state.graph, latest.seq, judgment.reference, publicTurns);
        memoryUpdate = staged.update;
        trace.memory.interpretation = judgment.reference != null;
        trace.memory.rejected = staged.rejected;
      } catch (error) {
        judgment = { ...validCore, reference: null };
        trace.memory.rejected = "memory_" + (error instanceof ReferenceGraphError || error?.name === "JudgmentValidationError" ? error.code : "invalid_update");
        memoryUpdate = stageMemory(state.graph, latest.seq, null, publicTurns);
      }
    } else judgment = validateJudgment(rawJudgment, { ownLedger: state.ledger, agreeEvidence: true });
    trace.judgment = { ...judgment };
    delete trace.judgment.reference;
    trace.validation = dialogueJudge.getDiagnostics?.().at(-1) ?? null;
    trace.status = "generation_error";
    const { action, targetSlot, candidateName, discriminatingFeature } = judgment;
    const result = await client.complete([
      { role: "system", content: TASK_INSTRUCTIONS_V2 },
      { role: "system", content: GENERATOR_INSTRUCTIONS_V2 },
      { role: "system", content: "この発話の判断（非公開）:\n" + JSON.stringify({ action, targetSlot, candidateName, discriminatingFeature,
        ...(Object.hasOwn(judgment, "followUp") ? { followUp: judgment.followUp } : {}) }) },
      ...ownImageMessage(ownImage),
      { role: "system", content: "AI自身の作業メモ（非公開・正解表ではない）:\n" + JSON.stringify({ ownLedger: state.ledger, agreeEvidence: true }) },
      ...history,
    ], { phase: "generation" });
    abortIf(signal);
    if (typeof result?.text !== "string" || !result.text.trim()) throw new Error("The chat client returned no utterance");
    const nextLedger = applyJudgment(state.ledger, judgment);
    const nextGraph = state.graph ? applyReferenceUpdate(state.graph, memoryUpdate, { publicTurns, generationSucceeded: true }) : null;
    if (state.graph) trace.memory.opsApplied = memoryUpdate.operations.length;
    trace.ownLedgerAfter = clone(nextLedger);
    trace.status = "staged";
    // The queue installs this only if the snapshot is still current.
    return { text: result.text, privateState: { ledger: nextLedger, judgments: [...state.judgments, { ...clone(trace), status: "committed" }], graph: nextGraph } };
  }

  async function finalRequest({ events, privateState }, retry = false) {
    return client.complete([
      { role: "system", content: TASK_INSTRUCTIONS_V2 },
      { role: "system", content: "これは非公開の最終提出です。作業メモは初期候補であり正解ではありません。自分の画像と公開対話を照合し、最終的な名称はあなた自身で判断してください。" },
      ...ownImageMessage(ownImage),
      { role: "system", content: "自分の画像内の各図形の内部参照ID（非公開）:\n" + JSON.stringify(ownAnchors) },
      { role: "system", content: "AI自身の作業メモ（非公開・正解表ではない）:\n" + JSON.stringify({ ownLedger: privateState.ledger }) },
      ...publicMessages(eventsToHistory(events)),
      { role: "user", content: FINAL_INSTRUCTIONS_V2 + (retry ? "\n前回は指定JSON形式として検証できませんでした。キーは内部参照ID6個だけにして再提出してください。" : "") },
    ], { phase: "final_submission" });
  }

  return Object.freeze({
    slots: Object.freeze([...slots]),
    initialPrivateState,
    runAiTurn,
    finalRequest,
    snapshotGraph(privateState) { return privateState.graph ? snapshotReferenceGraph(privateState.graph) : null; },
    getAttempts() { return clone(attempts); },
  });
}
