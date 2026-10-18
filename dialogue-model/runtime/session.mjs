import { createLunaJudge } from "./judgment/luna.mjs";
import { createOwnLedger, validateJudgment, applyJudgment } from "./judgment/schema.mjs";
import { STRATEGIES, TASK_INSTRUCTIONS, ownImageMessage, publicMessages } from "./judgment/instructions.mjs";
export { STRATEGIES };

// Identical across conditions. Only the judge selects a strategy-dependent act.
const GENERATOR_INSTRUCTIONS = [
  "【公開発話の生成】与えられた判断を、相手に向けた自然な日本語のチャット発話にしてください。",
  "1回は1〜2文です。主actionとfollowUpで指定された範囲だけを扱い、相手の発言を短く受け止め、親しみやすいです・ます調で返してください。硬いビジネス敬語、長い前置き、講義調は避けてください。",
  "指定されたactionの対話機能を実現し、自分で別のactionに置き換えないでください。candidateNameがあればその名称を使ってください。",
  "followUpがあれば、主actionを先にfollowUpを後に、両方の機能を全体で1〜2文にまとめて表現してください。以下のaction別制約はそれぞれの対象に適用し、主actionでの合意をfollowUpの別対象への合意に広げないでください。followUpがなければ主actionだけを表現してください。",
  "confirmは相手への質問・確認として表現し、propose_nameは命名の提案として表現してください。どちらも名称への合意・確定を表明せず、相手が確認や提案に答えられる形にしてください。",
  "名称への合意・確定を表明できるのはagreeのときだけです。agreeでは対象のcandidateNameへの合意を明示してください。candidateNameがnullなら、targetSlotのownLedgerに記録された名前を使ってください。",
  "repairでは自分の誤対応・改名・対応の取り消しを自己訂正として明示してください。訂正した候補を合意済みとして扱わないでください。",
  "deferでは対象を未解決のまま保留することを、revisitでは保留した対象へ再訪して相談を再開することを相手に分かるように伝えてください。どちらも新たな名称合意として表明しないでください。",
  "move_onでは別対象への移行を協調的に伝え、closeでは対話終了を相談してください。全対象の名称が合意済みとは断定しないでください。acceptでは相手の発言を受け止め、対象や名前に合意したふりをしないでください。",
  "targetSlotは自分自身の内部参照です。上段左・上段中・上段右・下段左・下段中・下段右や、自分の画面上の位置を相手に言わないでください。相手の画面では配置も向きも異なるため、位置の選択を相手に求めないでください。",
  "自分の画像を見て候補を回転させて考え、相手の上下左右の説明を自分の同じ向きに固定して解釈しないでください。対象は全体の見立てと特徴で指してください。",
  "confirmではdiscriminatingFeatureを使い、向きに依存しにくい特徴を1つ挙げ、相手が答えられる具体的な確認にしてください。単に同じ形かどうかだけを尋ねず、尖りの数・四角い部分の有無・細長さ・くぼみなどを自分の画像から確かめてください。",
  "公開応答を踏まえ、同じ確認の言い換え反復を避けてください。見立ての完全一致までは求めず、画像で確認できない特徴や対象を追加しないでください。",
  "判断JSON、内部位置名、内部ラベル、作業メモ、方略の説明、思考過程を出力せず、公開する発話だけを返してください。",
].join("\n");

export function createDialogueSession({ client, strategy, image = null, judge = null }) {
  if (!client || typeof client.complete !== "function") throw new Error("A chat client is required");
  if (!STRATEGIES.includes(strategy)) throw new Error("Unsupported dialogue strategy");
  // Copy only participant-visible image fields, never arbitrary caller metadata.
  const ownImage = image === null ? null : { mimeType: image.mimeType, base64: image.base64 };
  ownImageMessage(ownImage);
  const dialogueJudge = judge ?? createLunaJudge(client);
  if (typeof dialogueJudge.judge !== "function") throw new Error("A dialogue judge is required");
  const history = [];
  const judgmentHistory = [];
  let ownLedger = createOwnLedger();
  let pending = false;
  const ledgerMessage = () => ({ role: "system", content: "AI自身の作業メモ（非公開・正解表ではない）:\n" + JSON.stringify({ ownLedger }) });

  return {
    getHistory() { return publicMessages(history); },
    getOwnLedger() { return structuredClone(ownLedger); },
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
          ...ownImageMessage(ownImage), ledgerMessage(), ...publicMessages(history),
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
      const visibleHistory = [...publicMessages(history), { role: "user", content: utterance }];
      try {
        const judgment = validateJudgment(await dialogueJudge.judge({ image: ownImage, publicHistory: visibleHistory,
          strategy, ownLedger: structuredClone(ownLedger), ownJudgmentHistory: judgmentHistory
            .filter((item) => item.status === "committed")
            .flatMap(({ judgment }) => [judgment, ...(judgment.followUp ? [judgment.followUp] : [])]
              .map(({ action, targetSlot, candidateName }) => ({ action, targetSlot, candidateName }))),
        }), { ownLedger });
        trace.judgment = judgment;
        trace.validation = dialogueJudge.getDiagnostics?.().at(-1) ?? null;
        trace.status = "generation_error";
        const { action, targetSlot, candidateName, discriminatingFeature } = judgment;
        const result = await client.complete([
          { role: "system", content: TASK_INSTRUCTIONS },
          { role: "system", content: GENERATOR_INSTRUCTIONS },
          { role: "system", content: "この発話の判断（非公開）:\n" + JSON.stringify({ action, targetSlot, candidateName, discriminatingFeature,
            ...(Object.hasOwn(judgment, "followUp") ? { followUp: judgment.followUp } : {}),
          }) },
          ...ownImageMessage(ownImage), ledgerMessage(), ...visibleHistory,
        ], { phase: "generation" });
        if (typeof result?.text !== "string" || !result.text.trim()) throw new Error("The chat client returned no utterance");
        // Commit ledger and public history together only after generation succeeds.
        ownLedger = applyJudgment(ownLedger, judgment);
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
