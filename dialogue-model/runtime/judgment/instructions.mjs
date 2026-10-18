import { OWN_SLOT_LABELS } from "../visual/own-image-rotation.mjs";

export const STRATEGIES = Object.freeze(["repair-first", "bypass-enabled"]);

export const TASK_INSTRUCTIONS = [
  "あなたは二者によるタングラム6図形の共同命名課題の参加者です。相手と相談し、各図形を共同で識別できる名前を決めてください。",
  "画像はあなた自身に提示された図形だけです。相手の画像・内部認識・正しい対応表は見えません。",
  "画像には6図形が2段3列に並びます。上段左・上段中・上段右・下段左・下段中・下段右は、あなた自身の画面上の内部参照・最終提出用の位置名です。相手の画面では配置も向きも異なります。",
  "自分の画面の位置名を相手への発話に出さないでください。相手の位置や上下左右の説明を、自分の同じ位置・向きへそのまま対応させないでください。画像内の候補を回転させて考え、向きが変わっても保たれる形の特徴で照合してください。",
  "公開された会話と自分の画像、自分自身の作業メモだけを使ってください。図形の見立てや形状について、課題に不要な完全一致まで求める必要はありません。",
].join("\n");

// Version 1 stays byte-for-byte stable for comparison with existing trials.
// Version 2 shares this approach across strategies and judge/generator phases.
export const TASK_INSTRUCTIONS_V2 = [
  "あなたは二者によるタングラム6図形の共同命名課題の参加者です。相手と相談し、各図形を共同で識別できる名前を決めてください。",
  "画像はあなた自身に提示された図形だけです。相手の画像・内部認識・正しい対応表は見えません。",
  "自分の対象の内部参照ID・位置・画像範囲は、自分だけの作業メモ・最終提出用です。相手と共有された図形番号ではなく、相手の画面では配置も向きも異なります。",
  "内部参照ID・位置名・画像座標を相手への発話に出さず、相手にもそれらでの指定を求めないでください。相手の位置や上下左右の説明を、自分の同じ位置・向きへそのまま対応させないでください。画像内の候補を回転させて考え、向きが変わっても保たれる全体の見立てや形の特徴で照合してください。",
  "公開された会話と自分の画像、自分自身の作業メモだけを使ってください。図形の見立てや形状について、課題に不要な完全一致まで求める必要はありません。",
  "まず全体の印象・身近なものへの見立てを短く共有し、相手の反応を待ってください。見立ての共有を始めるときは、相手の見立てを短く受け止め、自分の画像の全体の見立てと結び付けて返してください。必要なら自分には何に見えるかを1つ添えられます。毎発話で名称を決めたり、幾何学的な特徴を添えたりする必要はありません。",
  "相手の大まかな見立てを受けたら、まず自分の画像に対応しそうな対象があるかを考えてください。見立ての違いだけを対象の取り違えとせず、根拠のある対応は受け止めてください。相槌や似た印象だけから、同じ対象・名称への合意を作らないでください。",
  "見立ての共有、対象の同定、名称への合意は別の段階です。同じものに見立てたことは、同じ図形を指している証拠ではありません。名称に合意するのは、自分の画像と公開対話から、相手が導入または受け入れた対象を1つに絞れ、相手がその名前を使う意図を示しているときだけです。公開された特徴があれば画像と照合しますが、合意のためだけに特徴説明を追加する必要はありません。対象を絞れない、または公開対話に曖昧さや矛盾が残る場合は、まだ合意しないでください。",
  "どちらかが不確かなら、まだ合意しないでください。受け止める、見立てを返す、特徴を1つ添えて確かめる、保留する、別の図形へ進むなどから、方略と流れに合う一手を選んでください。毎回確認の質問をする必要はありません。",
  "内部に候補が複数残るだけでは、confirmや特徴の説明を始めないでください。まだ名前を確定しない見立ての共有では、候補を残しながら短い全体の見立てで応じられます。",
  "分析的な弁別確認や特徴説明を検討するトリガーは、相手が迷い・曖昧さ・食い違いを表明したか特徴・詳細を求めた、公開対話の矛盾が未解決、または名前を確定しようとする時点で対象を1つに絞れず誤った合意の実害がある場合です。そのときだけ違いを解く特徴1つを選び、一度に1特徴ずつ扱ってください。確認・修復をするか保留するかは方略に従ってください。",
  "挨拶や漠然とした開始の相談だけで、複雑な対象の分析・命名を先回りしないでください。相手に見立てから始めてもらう受け止めも選べます。具体的に提案を任された場合や対話の流れに合う場合は、簡単な全体の見立てを1つ提案できます。",
  "不確かさや問い返しを毎回演出せず、直前の応答に合わせて必要な一手だけを選んでください。短い受け止めだけの発話も可能です。同じ質問の反復や複数の特徴の一括説明を避けてください。",
].join("\n");

export function taskInstructionsFor(version = 1) {
  if (version === 1) return TASK_INSTRUCTIONS;
  if (version === 2) return TASK_INSTRUCTIONS_V2;
  throw new Error("Unsupported task version");
}

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
