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
import { buildDecisionEvidence } from "./decision-evidence.mjs";
import { resolveActiveJudgment } from "./active-judge.mjs";
import { findGuardViolations, rewriteReasons, fallbackUtterance } from "./generation-guard.ts";

// Identical across strategies. Holistic first; analysis only when the judge asks for it.
export const GENERATOR_INSTRUCTIONS_V2 = [
  "【公開発話の生成】与えられた判断を、相手に向けた自然な日本語のチャット発話にしてください。",
  "まず相手の発話に短く応じ、必要なら全体の印象・身近なものへの見立てを1つ伝えてください。形の分析は、共通教示の分析トリガー（相手が迷い・曖昧さ・食い違いを表明したか特徴・詳細を求めた、公開対話の矛盾が未解決、または名前を確定しようとする時点で対象を1つに絞れず誤った合意の実害がある）に基づく判断に discriminatingFeature があるときだけにし、その場合も特徴は1つに絞って相手の反応を待ってください。内部に候補が複数残るだけでは分析を始めないでください。",
  "挨拶や「どれからにしますか」のような漠然とした開始には、短く受け止めて相手に選んでもらうか、簡単な見立てを1つだけ出してください。先回りして詳しい形の説明や名前の一括提案をしないでください。",
  "1回は1〜2文、親しみやすいです・ます調で返してください。講義調、長い前置き、特徴の列挙は避けてください。短さ自体は目的ではありません。",
  "「合意」「候補」「案」「受け取りました」のような手続きを説明する言葉は避け、普段のチャットのように言ってください。合意した後に同じ特徴の説明を繰り返さないでください。",
  "指定されたactionの対話機能を実現し、自分で別のactionに置き換えないでください。followUpがあれば主actionを先に、両方を全体で1〜2文にまとめてください。",
  "propose_nameやagreeにdiscriminatingFeatureがあるときは、質問にせず、その特徴に短く触れて自分がどの図形のことと理解したかを相手に示してください。discriminatingFeatureがないときは、相手の見立てを短く受け止め、自分の画像の全体の見立てと結び付けて理解を表してください。必要なら自分の見立てを1つ返せます。判断にない尖り・四角・くぼみなどの形の数や特徴を作って補わないでください。propose_nameでは相手が出した名前を候補として受けるだけにし、合意は表明しないでください。",
  "confirmは相手への短い確認、propose_nameは命名の提案として表現し、どちらも合意を表明しないでください。合意を表明できるのはagreeのときだけです。repairでは自己訂正を明示し、repair以外では取り違えや取り消しを表明しないでください。defer/revisitは保留・再訪であることが分かるように伝えてください。acceptでは受け止めるだけにしてください。",
  "targetSlotや内部参照ID、画像内の座標・範囲は自分だけの作業メモです。相手に言わず、位置での指定も求めないでください。相手の画面では配置も向きも異なります。",
  "自分の画面の向きに依存する上下左右・右向き・上端・下端などの語で形を説明しないでください。特徴を伝えるときは、回転しても変わらない尖りの数や大小・くぼみ・細長さ・四角の有無・部分同士のつながりから選んでください。",
  "公開履歴と矛盾する説明、同じ確認の言い換え反復、画像にない特徴の追加をしないでください。判断JSON、作業メモ、方略の説明、思考過程は出力せず、公開する発話だけを返してください。",
].join("\n");

// Opt-in research option (default off), identical across strategies: one dialogue
// function per turn and chat-like brevity. Never changes the judged act itself.
export const UTTERANCE_STYLES = Object.freeze(["default", "concise"]);
export const CONCISE_INSTRUCTIONS_V2 = [
  "【短いチャット】この発話では、指定されたactionの対話機能を1つだけ実現してください。挨拶や相槌だけで終えず相手の発話の内容に応じ、相槌は短い一言までにし、次の図形・次の名前・別の話題は出さないでください。",
  "人間同士のチャットのように、多くは1文で、相手の発話と同じくらいの長さにしてください。相手の言葉の言い直しや自分の見立ての繰り返しはしないでください。確認したい特徴などの必要な内容は削らず、短さのために不自然にしないでください。",
].join("\n");

const FINAL_INSTRUCTIONS_V2 = [
  "【実験環境からの非公開最終提出要求。対話相手の発話ではありません】",
  "対話は終了しました。自分自身の画像と公開対話履歴だけから、自分の6図形それぞれの最終名称を提出してください。",
  "JSONオブジェクトだけを返してください。キーは作業メモにある自分の6つの内部参照IDで、値は名称の文字列です。合意できていない図形は空文字列にしてください。",
  "説明、Markdown、追加キーは含めないでください。",
].join("\n");

const clone = (value) => structuredClone(value);

// What the public utterance may claim for each typed act (shared by both strategies).
export const ACTION_SCOPE_V2 = Object.freeze({
  accept: "受け止めるだけ。名前に決まったとは言わない",
  propose_name: "どの図形と理解したかを示すか名前を出すだけ。決まった・それでいこうとは言わない",
  confirm: "確認するだけ。決まった・それでいこうとは言わない",
  agree: "この名前に決まったことを伝えてよい",
  repair: "自分の取り違え・決めた名前の訂正であることを明示する",
  defer: "後で戻ることを伝える。決まったとは言わない",
  revisit: "保留していた図形に戻る。決まったとは言わない",
  move_on: "別の図形に進む。決まったとは言わない",
  close: "終わりにしてよいか相談する",
});

/** Public events -> chat messages, keeping every speaker turn (consecutive human messages stay distinct). */
export function eventsToHistory(events) {
  return events.map((event) => {
    if (!event || !["human", "ai"].includes(event.speaker) || typeof event.text !== "string") throw new Error("Invalid public event");
    return { role: event.speaker === "human" ? "user" : "assistant", content: event.text };
  });
}

/** Public events -> provenance turns numbered by event sequence, newest window only. */
export function eventsToPublicTurns(events) {
  return events.map((event) => ({ turn: event.seq, speaker: event.speaker, text: event.text,
    ...(event.nonReferential === true ? { nonReferential: true } : {}) })).slice(-REFERENCE_LIMITS.publicTurns);
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
export function createDialogueV2({ client, strategy, image, anchors, judge = null, referenceMemory = false,
  decisionShadowClient = null, onResearchUpdate = null, activeDecision = null, utteranceStyle = "default" }) {
  if (!client || typeof client.complete !== "function") throw new Error("A chat client is required");
  if (!STRATEGIES.includes(strategy)) throw new Error("Unsupported dialogue strategy");
  if (typeof referenceMemory !== "boolean") throw new Error("Invalid memory option");
  if (!UTTERANCE_STYLES.includes(utteranceStyle)) throw new Error("Invalid utterance style");
  const concise = utteranceStyle === "concise";
  if (decisionShadowClient !== null && typeof decisionShadowClient?.chooseAction !== "function") {
    throw new Error("Invalid decision shadow client");
  }
  if (onResearchUpdate !== null && typeof onResearchUpdate !== "function") throw new Error("Invalid research update callback");
  if (activeDecision !== null && (!activeDecision || !["decision_jev", "decision_luna"].includes(activeDecision.purpose) ||
      typeof activeDecision.client?.chooseAction !== "function")) throw new Error("Invalid active decision client");
  if (activeDecision && decisionShadowClient) throw new Error("Active and shadow decisions are mutually exclusive");
  const ownImage = { mimeType: image.mimeType, base64: image.base64 };
  ownImageMessage(ownImage);
  const slots = anchors.map((anchor) => anchor.id);
  const ownAnchors = anchors.map(({ id, bbox, centroid }) => ({ id, bbox: { ...bbox }, centroid: { ...centroid } }));
  const dialogueJudge = judge ?? createLunaJudge(client);
  // Research-only trace of every attempted run (including superseded or failed ones).
  const attempts = [];
  const notifyResearchUpdate = () => {
    Promise.resolve().then(() => onResearchUpdate?.()).catch(() => {});
  };

  function startDecisionShadow(trace, input) {
    const purposes = ["decision_jev", "decision_luna"];
    const errors = (error) => purposes.map((purpose) => ({ purpose, status: "error", error }));
    let evidence;
    try { evidence = buildDecisionEvidence(input); }
    catch {
      trace.decisionShadow = errors("evidence_unavailable");
      notifyResearchUpdate();
      return;
    }
    trace.decisionShadow = { status: "pending" };
    // Research work has no awaited dependency on generation or queue completion.
    Promise.allSettled(purposes.map((purpose) => Promise.resolve().then(() =>
      decisionShadowClient.chooseAction({ purpose, state: evidence })))).then((results) => {
      trace.decisionShadow = clone(results.map((result, index) => result.status === "fulfilled" ? {
        purpose: purposes[index], model: result.value.model, action: result.value.action,
        provider: result.value.provider ?? null, id: result.value.id ?? null,
        probabilities: result.value.probabilities, usage: result.value.usage ?? null,
        latencyMs: result.value.latencyMs ?? null, status: "ok",
      } : { purpose: purposes[index], status: "error", error: "decision_unavailable" }));
    }).catch(() => {
      trace.decisionShadow = errors("decision_unavailable");
    }).then(notifyResearchUpdate).catch(() => {});
  }

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
    // Concise style: the unspoken followUp is removed from the act itself, so the
    // ledger, memory and generation never carry an act the partner did not hear.
    if (concise) {
      trace.utteranceStyle = { style: utteranceStyle, droppedFollowUp: judgment.followUp ? clone(judgment.followUp) : null };
      if (judgment.followUp) judgment = { ...judgment, followUp: null };
    }
    if (activeDecision) {
      let decision;
      const started = performance.now();
      try {
        const evidence = buildDecisionEvidence({ events, ownLedger: state.ledger, judgment, strategy });
        decision = { ...await activeDecision.client.chooseAction({ purpose: activeDecision.purpose, state: evidence }), purpose: activeDecision.purpose };
      } catch (error) { decision = { error, purpose: activeDecision.purpose, latencyMs: Math.round(performance.now() - started) }; }
      abortIf(signal);
      const resolved = resolveActiveJudgment({ lunaJudgment: judgment, decision, ownLedger: state.ledger, strategy });
      judgment = resolved.judgment;
      trace.activeJudge = resolved.record;
      if (state.graph) {
        const staged = prepareMemory(state.graph, latest.seq, judgment.reference, publicTurns);
        memoryUpdate = staged.update;
        trace.memory.interpretation = judgment.reference != null;
        trace.memory.rejected ??= staged.rejected;
      }
    }
    trace.judgment = { ...judgment };
    delete trace.judgment.reference;
    if (decisionShadowClient) {
      startDecisionShadow(trace, { events, ownLedger: state.ledger, judgment, strategy });
    }
    abortIf(signal);
    trace.validation = dialogueJudge.getDiagnostics?.().at(-1) ?? null;
    trace.status = "generation_error";
    const { action, targetSlot, candidateName, discriminatingFeature } = judgment;
    const generationMessages = [
      { role: "system", content: TASK_INSTRUCTIONS_V2 },
      { role: "system", content: GENERATOR_INSTRUCTIONS_V2 },
      ...(concise ? [{ role: "system", content: CONCISE_INSTRUCTIONS_V2 }] : []),
      { role: "system", content: "この発話の判断（非公開）:\n" + "主actionで言えること: " + ACTION_SCOPE_V2[action] +
        (judgment.followUp ? "。followUpで言えること: " + ACTION_SCOPE_V2[judgment.followUp.action] : "") + "\n" + JSON.stringify({ action, targetSlot, candidateName, discriminatingFeature,
        ...(Object.hasOwn(judgment, "followUp") ? { followUp: judgment.followUp } : {}) }) },
      ...ownImageMessage(ownImage),
      { role: "system", content: "AI自身の作業メモ（非公開・正解表ではない）:\n" + JSON.stringify({ ownLedger: state.ledger, agreeEvidence: true }) },
      ...(trace.activeJudge && trace.activeJudge.finalAction !== trace.activeJudge.lunaAction ? [{
        role: "system", content: "【この発話の表現範囲（非公開）】この発話のactionは" + action + "です。" + ACTION_SCOPE_V2[action] + "。" +
          (action === "agree" ? "" : "相手が名前を提案していても、このactionでは名称への合意・決定を表す表現（呼びましょう／でいいですね／決まり 等）を使わないでください。") +
          (action === "accept" ? "受け止めや見立ての共有にとどめてください。" : "このactionで指定された対話機能の範囲だけを表現してください。") +
          "内部の判断・処理・ラベルを相手に説明せず、公開する発話だけを返してください。",
      }] : []),
      ...history,
    ];
    let result = await client.complete(generationMessages, { phase: "generation" });
    abortIf(signal);
    if (typeof result?.text !== "string" || !result.text.trim()) throw new Error("The chat client returned no utterance");
    // Publication rules for the committed act (agreement only under agree, self-repair
    // only under repair, never internal ids/fields). Wording never changes the act.
    trace.generationGuard = { violations: findGuardViolations(result.text, action), regenerated: false, fallback: false };
    if (trace.generationGuard.violations.length) {
      abortIf(signal);
      trace.generationGuard.regenerated = true;
      let retry = null;
      try {
        retry = await client.complete([...generationMessages, {
          role: "system", content: "【公開発話の書き直し】この発話のactionは" + action + "です。" + ACTION_SCOPE_V2[action] +
            "。" + rewriteReasons(trace.generationGuard.violations) + "内部処理は説明せず、公開する発話だけを返してください。",
        }], { phase: "generation" });
      } catch { /* Retry failure is private; never retain a raw provider error. */ }
      abortIf(signal);
      const retryCodes = typeof retry?.text === "string" && retry.text.trim() ? findGuardViolations(retry.text, action) : null;
      trace.generationGuard.violations = [...new Set([...trace.generationGuard.violations, ...(retryCodes ?? [])])];
      if (retryCodes && retryCodes.length === 0) result = retry;
      else {
        result = { text: fallbackUtterance(judgment) };
        trace.generationGuard.fallback = true;
      }
    }
    const nextLedger = applyJudgment(state.ledger, judgment);
    const nextGraph = state.graph ? applyReferenceUpdate(state.graph, memoryUpdate, { publicTurns, generationSucceeded: true }) : null;
    if (state.graph) trace.memory.opsApplied = memoryUpdate.operations.length;
    trace.ownLedgerAfter = clone(nextLedger);
    trace.status = "staged";
    const committedTrace = { ...clone(trace), status: "committed" };
    // Committed judgments keep a pending marker; settled shadow data belongs only to attempts.
    if (decisionShadowClient) committedTrace.decisionShadow = { status: "pending" };
    // The queue installs this only if the snapshot is still current.
    return { text: result.text, privateState: { ledger: nextLedger, judgments: [...state.judgments, committedTrace], graph: nextGraph } };
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
