# Jev 2軸の根拠判定（研究用 shadow・既定OFF）

AIの各ターンについて、公開対話にどこまで根拠があるかをJevが独立に判定し、研究用の非公開記録だけに残す。対話の行動・発話・作業メモ・参加者画面・タイミングは変えない。両方略（repair-first / bypass-enabled）で同じ判定を行い、判定入力に方略は含めない。採用済みの研究条件ではなく、まずshadow計測で校正と誤判定率を確認するための実装である。

## 2つの閉集合軸

| 軸 | 段階 | 要点 |
| --- | --- | --- |
| 対象同定の根拠 `identification` | `supported` / `insufficient` / `contradicted` / `unknown` | 相手自身の発話による識別的特徴の独立な一致、またはAIの示した特徴への明示的な肯定があり、矛盾がない場合だけ `supported`。見立ての類似・相槌・「わかります」・AI側の仮説だけでは `insufficient`。 |
| 名称合意の根拠 `name_agreement` | `agreed` / `unclear` / `not_agreed` / `unknown` | 同じ対象の名称を両者が明示的に採用し、その後に別案・留保がない場合だけ `agreed`。名称が正しい対象を指すかはこの軸では判定しない。 |

`unknown` は、公開発話がない場合、判定対象を読み取れない場合、画像を見なければ判断できない場合に使う。各段階の基準文（短い別表現を含む）、設問文、モデルIDはWorker側の `workers/research-ai-proxy/src/grounding.ts` が持ち、クライアントは `{purpose:"grounding_jev", state}` だけを送る。2軸は1回の呼び出しで判定する。

## Jevに渡すもの・渡さないもの

`evidence.ts` の `buildGroundingEvidence` は、次の許可リストだけからテキストの状態を組み立てる。

- 判定時点（`asOfSeq`）までの公開発話。これより後の発話は落とす。最新24件まで、2万文字以内に収める。
- `aiSideClaims`：Lunaによる未検証の仮説（自分の不透明IDで表す対象、候補名、弁別特徴、予定行為）。証拠ではなく、仮説として明示する。
- AI自身の作業メモと、同じ対象への過去のAI行為。
- 任意の `aiMemory`：参照メモリの要約。メモリONのときだけ渡し、OFFでは状態をバイト単位で変えない。

相手の画像やID、正解対応表、未来の発話、goldラベル、方略、AIの画像そのものは渡さない。プログラムは入力の不足（`no_target_hypothesis`、`earlier_turns_omitted`、`no_ai_turn_yet`、`memory_unavailable`）を記録するが、それを判定結果として扱わない。

## スコアの扱い

`scores` と `confidence` はDecisions APIが返す相対スコアであり、校正されていない。gold照合と校正が終わるまでは「正しい対象である確率」と呼ばず、閾値にも使わない。既存の行動選択の probabilities とも別物である。

## 有効化（研究者の設定のみ）

- **ローカル**：`node --env-file=.env dialogue-model/runtime/web/server.mjs --grounding-shadow`
- **実験Worker**：Worker環境変数 `GROUNDING_SHADOW=on` で有効になる。未設定ならOFF。有効化には、研究用プロキシに `RESEARCH_GROUNDING_ENABLED=true` を設定したデプロイと `grounding()` RPC が必要。2026-10-19時点では**未デプロイで、研究者の承認とOpenRouterのSecretが必要**。
- **実験Workerで `GROUNDING_SHADOW=on` にすると、実際の参加者の公開発話がAIの各ターンごとに第三者（OpenRouter / Jev）へ送られ、ターンごとに費用も発生する。** 既存のLuna経路とは別の送信先になるため、研究者と倫理面の別途の判断が必要である。現在の承認は合成事例の50回以下に限られるので、デプロイ済みの実験Workerでは未設定のままにする。合成事例の実呼び出しに必要なのはプロキシ側の `RESEARCH_GROUNDING_ENABLED=true` だけである。
- 参加者のリクエストからは切り替えられない。復元した試行は、開始時にshadowがONだった場合だけONを維持する。

結果は記録の `groundingShadow` 配列（ターン、対象、状態、2軸の段階とスコア、エラーコード、遅延、費用、入力の不足）と、管理画面の「根拠の影判定」節に残る。shadowは生成の後に開始し、await しない。独自のタイムアウト（既定20秒）を持ち、失敗しても会話を止めずエラー記録になる。
