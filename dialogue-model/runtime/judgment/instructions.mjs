import { OWN_SLOT_LABELS } from "../visual/own-image-rotation.mjs";

export const STRATEGIES = Object.freeze(["repair-first", "bypass-enabled"]);

export const TASK_INSTRUCTIONS = [
  "あなたは二者によるタングラム6図形の共同命名課題の参加者です。相手と相談し、各図形を共同で識別できる名前を決めてください。",
  "画像はあなた自身に提示された図形だけです。相手の画像・内部認識・正しい対応表は見えません。",
  "画像には6図形が2段3列に並びます。上段左・上段中・上段右・下段左・下段中・下段右は、あなた自身の画面上の内部参照・最終提出用の位置名です。相手の画面では配置も向きも異なります。",
  "自分の画面の位置名を相手への発話に出さないでください。相手の位置や上下左右の説明を、自分の同じ位置・向きへそのまま対応させないでください。画像内の候補を回転させて考え、向きが変わっても保たれる形の特徴で照合してください。",
  "公開された会話と自分の画像、自分自身の作業メモだけを使ってください。図形の見立てや形状について、課題に不要な完全一致まで求める必要はありません。",
].join("\n");

// The only strategy-dependent text. Equal structure and comparable specificity;
// no dialogue examples or condition-specific encouragement of task success.
export const JUDGE_POLICIES = Object.freeze({
  "repair-first": [
    "課題に関係する対象の不明確さがあれば、比較的早く弁別的特徴を使った確認・修復を選んでください。",
    "十分に対象を区別できたら名称の提案・合意へ進み、不要な見立ての一致までは求めないでください。",
    "直前の公開応答と過去の判断を確認し、同じ質問の反復を避け、別の特徴で問題を確かめてください。",
    "相手の明示的な訂正・修復要求には応じてください。保留した対象は必要な確認を経て再訪してください。",
  ].join("\n"),
  "bypass-enabled": [
    "課題に関係する対象の不明確さがあれば、必要な確認・修復に加え、判断の保留や別対象への移行も選んでください。",
    "十分に対象を区別できたら名称の提案・合意へ進み、不要な見立ての一致までは求めないでください。",
    "直前の公開応答と過去の判断を確認し、同じ質問の反復を避け、追加説明や別対象からの情報も使ってください。",
    "相手の明示的な訂正・修復要求には応じてください。保留した対象は必要に応じて後から再訪してください。",
  ].join("\n"),
});

export function ownImageMessage(image) {
  if (image === null) return [];
  if (!image || !["image/png", "image/jpeg", "image/webp"].includes(image.mimeType) || typeof image.base64 !== "string" || !image.base64) {
    throw new Error("Invalid participant image");
  }
  return [{ role: "user", content: [
    { type: "text", text: "【実験環境からの提示。公開発話ではありません】あなた（AI側）自身に提示された図形画像です。" },
    { type: "image_url", image_url: { url: "data:" + image.mimeType + ";base64," + image.base64 } },
  ] }];
}

export function publicMessages(history) {
  if (!Array.isArray(history) || !history.every((item) => item && ["user", "assistant"].includes(item.role) && typeof item.content === "string")) {
    throw new Error("Invalid public history");
  }
  return history.map(({ role, content }) => ({ role, content }));
}

export function ownRotationMessage(image = null) {
  if (image === null) return [];
  const messages = ownImageMessage(image);
  messages[0].content[0].text = "【実験環境からの提示。公開発話ではありません】直前の自分の6図形を0/90/180/270度、時計回りに回転した画像です。ラベルは自分の内部参照だけに使います。対応: " +
    JSON.stringify(OWN_SLOT_LABELS) + "。相手の画面ではありません。ラベルや内部位置を相手に言わないでください。";
  return messages;
}
