import { ACTIONS, FOLLOW_UP_ACTIONS, SAFE_JUDGMENT, validateJudgment, validateOwnLedger, JudgmentValidationError } from "./schema.mjs";
import { STRATEGIES, TASK_INSTRUCTIONS, JUDGE_POLICIES, ownImageMessage, publicMessages } from "./instructions.mjs";

const JUDGE_INSTRUCTIONS = [
  "【非公開の対話判断】次の公開発話を生成するために、対話上の判断をJSONだけで返してください。これは対話相手への発話ではありません。",
  "必須キーは action, targetSlot, candidateName, discriminatingFeature, note の5個です。任意キーとしてfollowUpを追加できます。action は " + ACTIONS.join(" | ") + " です。",
  "targetSlot は自分の6位置の1つ、またはnull。candidateName は名称文字列またはnull。discriminatingFeature は候補を区別する画像上の特徴1つ、またはnull。note は短い作業メモまたはnullで、相手には公開されません。",
  "propose_name は対象と名前候補を選ぶ、agree は対象の名前に合意する、confirm は対象を区別する特徴で確かめる、repair は自分の対応・名称を訂正する、defer は保留、revisit は保留対象へ戻る、move_on は別対象へ進む、accept は相手の発言を受け止める、close は対話終了を相談する判断です。",
  "ownLedger は自分の過去判断を記録した作業メモで、相手との正しい対応を保証しません。記憶した名前を別名へ変更する場合はrepairを選び、相手に自己訂正を伝えてください。誤対応を取り消すrepairではcandidateName=nullで自分の枠を空にできます。",
  "confirm・propose_name・agreeではcandidateNameに対象の名前候補を保持できます。confirmでまだ照合中でも、話題の名前候補があればtargetSlotとcandidateNameを記録してください。confirmの候補名は仮の記憶であり、名称への合意を意味しません。",
  "相手が提案した名前を受け入れる・同意するときは、confirmやacceptではなく必ずagreeを選び、対象のtargetSlotとcandidateNameを指定してください。propose_nameには対象枠と名称が必要です。既存の名前にagreeする場合のcandidateNameはnullでも構いません。",
  "followUpは不要なら省略またはnull、必要ならaction, targetSlot, candidateName, discriminatingFeatureだけを持つ1個のオブジェクトです。followUp.actionは " + FOLLOW_UP_ACTIONS.join(" | ") + " のいずれかで、noteや入れ子のfollowUpは含めないでください。",
  "相手の発話に現在の対象への合意と次の対象への移行・提案依頼が含まれる場合は、主actionで先に合意を扱い、followUpで次の対象への提案や確認を扱えます。次の提案を求められたら、自分の画像と公開対話から対象と候補名を判断し、合意だけで止めずにfollowUpで応じてください。",
  "主actionの後にfollowUpを適用します。followUpにも同じ対象・候補名・弁別的特徴の制約、同名重複禁止、既存名の変更にはrepairが必要という制約が適用されます。1回の返答に必要な追加判断だけを選び、方略に応じた確認や保留の選択を維持してください。",
  "ownJudgmentHistoryの直前までの対象と名前候補を確認してください。同じ対象について話し続けているときは直前のtargetSlotを維持し、その対象を別の枠と解釈し直す場合はrepairで明示してください。別の対象へ話題が移った場合と混同しないでください。",
  "同じ名前を同時に2つの枠へ記録しないでください。名前を別枠へ移す必要がある場合は、まず元の枠をrepairとcandidateName=nullで明示的に空にし、その後に対象を照合して割り当て直してください。",
  "confirmにはdiscriminatingFeatureが必要です。相手の説明に当てはまりうる自分の候補が複数あるとき、それらを互いに区別する、自分の画像で観察できる特徴を1つ選んでください。相手の説明の単なる言い換えや、候補同士で違いのない特徴にしないでください。回転しても変わりにくい尖りの数・細長さ・くぼみなどを自分の画像で確かめてください。",
  "相手から名称が出るのを待つだけにせず、画像から未命名の対象の名前を提案できます。画像にない特徴・図形を推測で作らないでください。",
  "同じ質問を繰り返さず、公開応答に合わせて判断を更新してください。どの方略でも、見立ての完全一致と対象の識別を区別してください。",
  "各名称は200文字以内、特徴は400文字以内、メモは1000文字以内。説明文・Markdown・上記以外の追加キーは返さないでください。",
].join("\n");

/** @returns {import('./schema.mjs').DialogueJudge & {getDiagnostics(): object[]}} */
export function createLunaJudge(client) {
  if (!client || typeof client.complete !== "function") throw new Error("A chat client is required");
  const diagnostics = [];
  return {
    getDiagnostics() { return structuredClone(diagnostics); },
    async judge({ image = null, publicHistory, strategy, ownLedger, ownJudgmentHistory = [] }) {
      if (!STRATEGIES.includes(strategy)) throw new Error("Unsupported dialogue strategy");
      const ledger = validateOwnLedger(ownLedger);
      const previous = ownJudgmentHistory.map(({ action, targetSlot, candidateName = null }) => {
        if (!ACTIONS.includes(action) || !(targetSlot === null || Object.hasOwn(ledger, targetSlot)) ||
            !(candidateName === null || (typeof candidateName === "string" && candidateName.trim().length > 0 && candidateName.length <= 200)) ||
            (targetSlot === null && candidateName !== null)) throw new Error("Invalid own judgment history");
        return { action, targetSlot, candidateName: candidateName?.trim() ?? null };
      });
      const messages = [
        { role: "system", content: TASK_INSTRUCTIONS },
        { role: "system", content: JUDGE_POLICIES[strategy] },
        { role: "system", content: JUDGE_INSTRUCTIONS },
        ...ownImageMessage(image),
        { role: "system", content: "AI自身の作業メモ（公開発話ではない）:\n" + JSON.stringify({ ownLedger: ledger, ownJudgmentHistory: previous }) },
        ...publicMessages(publicHistory),
      ];
      const failures = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await client.complete(attempt ? [...messages,
          { role: "system", content: "前回の判断は検証できませんでした。検証理由: " + failures.at(-1) + "。既存枠の改名はrepairを使ってください。同名が別枠にある場合は元の枠をrepairとcandidateName=nullで空にしてから再割当してください。上記JSON形式と制約を守って再提出してください。" }] : messages,
        { phase: "judgment" });
        try {
          const judgment = validateJudgment(JSON.parse(response.text), { ownLedger: ledger });
          diagnostics.push({ attempts: attempt + 1, fallback: false, failures });
          return judgment;
        } catch (error) {
          failures.push(error instanceof JudgmentValidationError ? error.code : "invalid_json");
        }
      }
      diagnostics.push({ attempts: 2, fallback: true, failures });
      return { ...SAFE_JUDGMENT };
    },
  };
}
