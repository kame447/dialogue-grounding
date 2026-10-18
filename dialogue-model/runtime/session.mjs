import { createLunaJudge } from "./judgment/luna.mjs";
import { createOwnLedger, validateJudgment, applyJudgment } from "./judgment/schema.mjs";
import { STRATEGIES, TASK_INSTRUCTIONS, ownImageMessage, ownRotationMessage, publicMessages } from "./judgment/instructions.mjs";
import { createReferenceGraph, snapshotReferenceGraph, applyReferenceUpdate, ReferenceGraphError } from "./memory/reference-graph.mjs";
import { stageMemory, prepareMemory, visibleTurns } from "./judgment/memory.mjs";
export { STRATEGIES };

// Identical across conditions. Only the judge selects a strategy-dependent act.
const GENERATOR_INSTRUCTIONS = [
  "【公開発話の生成】与えられた判断を、相手に向けた自然な日本語のチャット発話にしてください。",
  "1回は1〜2文です。主actionとfollowUpで指定された範囲だけを扱い、相手の発言を短く受け止め、親しみやすいです・ます調で返してください。硬いビジネス敬語、長い前置き、講義調は避けてください。",
  "指定されたactionの対話機能を実現し、自分で別のactionに置き換えないでください。candidateNameがあればその名称を使ってください。",
  "followUpがあれば、主actionを先にfollowUpを後に、両方の機能を全体で1〜2文にまとめて表現してください。以下のaction別制約はそれぞれの対象に適用し、主actionでの合意をfollowUpの別対象への合意に広げないでください。followUpがなければ主actionだけを表現してください。",
  "1発話で伝える形の特徴は原則1つに絞り、判断のdiscriminatingFeatureまたは相手の質問への答えを優先してください。複数の特徴の列挙や説明調を避け、相手の反応を待ってください。followUpがある場合も発話全体でこの原則を守ってください。短さ自体を目的にせず、対象の識別に必要な情報を一つずつ共有してください。",
  "confirmは相手への質問・確認として表現し、propose_nameは命名の提案として表現してください。どちらも名称への合意・確定を表明せず、相手が確認や提案に答えられる形にしてください。",
  "名称への合意・確定を表明できるのはagreeのときだけです。agreeでは対象のcandidateNameへの合意を明示してください。candidateNameがnullなら、targetSlotのownLedgerに記録された名前を使ってください。",
  "repairでは自分の対応の取り違え・合意済み名の訂正を自己訂正として明示してください。訂正した候補を合意済みとして扱わないでください。",
  "主actionとfollowUpそれぞれの対象について、repair以外では取り違えや取り消しを表明しないでください。仮名の言い換えをagreeで受け入れるときは、誤対応の訂正や取り消しにせず、新しい呼び名で合意するだけにしてください。",
  "deferでは対象を未解決のまま保留することを、revisitでは保留した対象へ再訪して相談を再開することを相手に分かるように伝えてください。どちらも新たな名称合意として表明しないでください。",
  "move_onでは別対象への移行を協調的に伝え、closeでは対話終了を相談してください。全対象の名称が合意済みとは断定しないでください。acceptでは相手の発言を受け止め、対象や名前に合意したふりをしないでください。",
  "targetSlotは自分自身の内部参照です。上段左・上段中・上段右・下段左・下段中・下段右や、自分の画面上の位置を相手に言わないでください。相手の画面では配置も向きも異なるため、位置の選択を相手に求めないでください。",
  "自分の画像を見て候補を回転させて考え、相手の上下左右の説明を自分の同じ向きに固定して解釈しないでください。対象は全体の見立てと特徴で指してください。",
  "形の説明には、自分の画面の向きに依存する上下左右・右向き・上端・下端などの語を使わないでください。回転しても変わらない、尖りの数や大小・くぼみ・細長さ・四角の有無・部分同士のつながりから、区別に必要な特徴を1つ選んで伝えてください。",
  "confirmではdiscriminatingFeatureを使い、回転しても変わらない特徴を1つ挙げ、相手が答えられる具体的な確認にしてください。単に同じ形かどうかだけを尋ねず、自分の画像からその特徴を確かめてください。",
  "公開履歴を確認し、自分が以前述べた形の特徴と矛盾する説明をしないでください。観察を訂正する必要がある場合も、特徴を黙ってすり替えず、指定されたrepairの範囲で自己訂正を伝えてください。",
  "公開応答を踏まえ、同じ確認の言い換え反復を避けてください。見立ての完全一致までは求めず、画像で確認できない特徴や対象を追加しないでください。",
  "判断JSON、内部位置名、内部ラベル、作業メモ、方略の説明、思考過程を出力せず、公開する発話だけを返してください。",
].join("\n");

export function createDialogueSession({ client, strategy, image = null, judge = null, rotationImage = null, referenceMemory = false }) {
  if (!client || typeof client.complete !== "function") throw new Error("A chat client is required");
  if (!STRATEGIES.includes(strategy)) throw new Error("Unsupported dialogue strategy");
  if (typeof referenceMemory !== "boolean") throw new Error("Invalid memory option");
  // Copy only participant-visible image fields, never arbitrary caller metadata.
  const ownImage = image === null ? null : { mimeType: image.mimeType, base64: image.base64 };
  ownImageMessage(ownImage);
  const rotations = rotationImage === null ? null : { mimeType: rotationImage.mimeType, base64: rotationImage.base64 };
  ownRotationMessage(rotations);
  const dialogueJudge = judge ?? createLunaJudge(client);
  if (typeof dialogueJudge.judge !== "function") throw new Error("A dialogue judge is required");
  const history = [];
  const judgmentHistory = [];
  let ownLedger = createOwnLedger();
  let graph = referenceMemory ? createReferenceGraph() : null;
  let pending = false;
  const ledgerMessage = () => ({ role: "system", content: "AI自身の作業メモ（非公開・正解表ではない）:\n" + JSON.stringify({ ownLedger }) });

  return {
    getHistory() { return publicMessages(history); },
    getOwnLedger() { return structuredClone(ownLedger); },
    getReferenceGraph() { return graph ? snapshotReferenceGraph(graph) : null; },
    // Private research diagnostics: orchestration persists these, never getState.
    getJudgmentHistory() { return structuredClone(judgmentHistory); },
    async finalRequest(instructions) {
      if (typeof instructions !== "string" || !instructions.trim()) throw new Error("Final instructions are required");
      if (pending) throw new Error("Concurrent turns are not supported");
      pending = true;
      try {
        return await client.complete([
          { role: "system", content: TASK_INSTRUCTIONS },
          { role: "system", content: "これは非公開の最終提出です。作業メモは初期候補であり正解ではありません。自分の画像と公開対話を照合し、最終的な名称はあなた自身で判断してください。" },
          ...ownImageMessage(ownImage), ...ownRotationMessage(rotations), ledgerMessage(), ...publicMessages(history),
          { role: "user", content: instructions },
        ], { phase: "final_submission" });
      } finally { pending = false; }
    },
    async turn(utterance) {
      if (typeof utterance !== "string" || !utterance.trim()) throw new Error("A nonempty public utterance is required");
      if (pending) throw new Error("Concurrent turns are not supported");
      pending = true;
      const trace = { turnIndex: history.length / 2 + 1, judgment: null,
        ownLedgerBefore: structuredClone(ownLedger), ownLedgerAfter: structuredClone(ownLedger),
        validation: null, status: "judge_error" };
      if (graph) trace.memory = { opsApplied: 0, rejected: null, interpretation: false };
      const visibleHistory = [...publicMessages(history), { role: "user", content: utterance }];
      const publicTurns = graph ? visibleTurns(visibleHistory) : null;
      try {
        const rawJudgment = await dialogueJudge.judge({ image: ownImage, publicHistory: visibleHistory,
          ...(rotations ? { rotationImage: rotations } : {}),
          ...(graph ? { referenceContext: { graph, turn: trace.turnIndex, publicTurns } } : {}),
          strategy, ownLedger: structuredClone(ownLedger), ownJudgmentHistory: judgmentHistory
            .filter((item) => item.status === "committed")
            .flatMap(({ judgment }) => [judgment, ...(judgment.followUp ? [judgment.followUp] : [])]
              .map(({ action, targetSlot, candidateName }) => ({ action, targetSlot, candidateName }))),
        });
        let judgment, memoryUpdate;
        if (graph) {
          const core = { ...rawJudgment }; delete core.reference;
          const validCore = validateJudgment(core, { ownLedger });
          try {
            judgment = validateJudgment(rawJudgment, { ownLedger });
            const staged = prepareMemory(graph, trace.turnIndex, judgment.reference, publicTurns);
            memoryUpdate = staged.update;
            trace.memory.interpretation = judgment.reference != null;
            trace.memory.rejected = staged.rejected;
          } catch (error) {
            judgment = { ...validCore, reference: null };
            trace.memory.rejected = "memory_" + (error instanceof ReferenceGraphError || error?.name === "JudgmentValidationError" ? error.code : "invalid_update");
            memoryUpdate = stageMemory(graph, trace.turnIndex, null, publicTurns);
          }
        } else judgment = validateJudgment(rawJudgment, { ownLedger });
        trace.judgment = { ...judgment };
        delete trace.judgment.reference;
        trace.validation = dialogueJudge.getDiagnostics?.().at(-1) ?? null;
        if (graph) trace.memory.rejected ??= trace.validation?.failures?.filter((code) => code.startsWith("memory_")).join(",") || null;
        trace.status = "generation_error";
        const { action, targetSlot, candidateName, discriminatingFeature } = judgment;
        const result = await client.complete([
          { role: "system", content: TASK_INSTRUCTIONS },
          { role: "system", content: GENERATOR_INSTRUCTIONS },
          { role: "system", content: "この発話の判断（非公開）:\n" + JSON.stringify({ action, targetSlot, candidateName, discriminatingFeature,
            ...(Object.hasOwn(judgment, "followUp") ? { followUp: judgment.followUp } : {}),
          }) },
          ...ownImageMessage(ownImage), ...ownRotationMessage(rotations), ledgerMessage(), ...visibleHistory,
        ], { phase: "generation" });
        if (typeof result?.text !== "string" || !result.text.trim()) throw new Error("The chat client returned no utterance");
        // Commit ledger and public history together only after generation succeeds.
        const nextLedger = applyJudgment(ownLedger, judgment);
        const nextGraph = graph ? applyReferenceUpdate(graph, memoryUpdate, { publicTurns, generationSucceeded: true }) : null;
        ownLedger = nextLedger;
        graph = nextGraph;
        if (graph) trace.memory.opsApplied = memoryUpdate.operations.length;
        history.push({ role: "user", content: utterance }, { role: "assistant", content: result.text });
        trace.ownLedgerAfter = structuredClone(ownLedger);
        trace.status = "committed";
        return result;
      } finally {
        judgmentHistory.push(structuredClone(trace));
        pending = false;
      }
    },
  };
}
