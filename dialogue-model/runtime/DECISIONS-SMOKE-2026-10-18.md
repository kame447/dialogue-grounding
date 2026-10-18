# OpenRouter Decisions 比較経路の監査・デプロイ・実API疎通（2026-10-18）

研究正本は [../README.md](../README.md) です。この記録は研究用Workerの接続確認であり、実験結果・方略効果・モデル性能の証拠ではありません。判断モデルは既定OFFのshadow診断のままで、会話・名称合意・採点を置き換えません。送信したのは合成データだけで、実参加者・原対話のデータは外部に送っていません。

## 監査（Sol子による独立監査とOpusのレビュー）

- **APIの形**: 公式の `POST https://openrouter.ai/api/alpha/decisions`（`model`・`state`・`questions`、choice回答の `choice`・`probabilities`・`confidence`、`usage`）に一致。実応答（Jev・Luna Decisions各1件、合成テキスト）をそのまま検証器とクライアントに通し、日付付きのモデル名（`typesafe/jev-1.14-20261014`・`openai/gpt-6-luna-decisions-20261006`）、整数の確率（Jevの0/1）、`output_tokens` を受け付けることを確認した。模擬テストだけで通る想定は見つからなかった。
- **修正した問題**（すべて回帰テスト付き）:
  1. shadow比較の2回の呼び出しを、公開発話の生成前に待っていた。比較を有効にすると毎回の応答と非同期キューが最大20秒遅れていた。待たずに実行し、結果は非公開の試行記録だけに書くよう修正した。
  2. 比較の待機中に新しい人間の発話で古い試行が取り消されても、例外が握りつぶされ、古い文脈で有料の発話生成が走っていた。
  3. 上流の402（残高不足）と不正な応答本文が一般のエラーに埋もれていた。
  4. 上流の `provider`・`id` を長さだけで通しており、上流が鍵を返した場合にWorkerが鍵を応答へ含め得た。形式を固定し、応答に鍵が含まれれば502にするよう修正した。
- **問題なし**: 認証が全処理より先、無効・鍵なしで閉じる、モデルIDと設問をWorkerが管理する、既存の `/v1/chat/completions`・`UPSTREAM_API_KEY`・`DIALOGUE_MODEL` は不変、比較の入力に相手の画像・正解表・図形ID・未来の発話を含まない、比較結果は参加者の状態に出ない。
- テスト: `npm test` 550件すべて成功（CI成功）。

## デプロイ（研究用Worker `dialogue-grounding-ai-proxy` のみ）

| 段階 | 版 | 内容 |
| --- | --- | --- |
| 変更前 | `5bfd1826` | ロールバック先 |
| Secret登録 | — | `OPENROUTER_DECISIONS_API_KEY` をキーチェーンからパイプで登録（値は表示していない）。既存の `RESEARCH_PROXY_TOKEN`・`UPSTREAM_API_KEY` は不変 |
| 無効のままデプロイ | `c71bd6e8` | `RESEARCH_DECISIONS_ENABLED=false`。Luna対話モデルのポリシー（`gpt-6-luna`）、Lunaの実発話1件（200）、未認証401、Decisionsは503を確認 |
| 有効化 | `1debe1e0` | デプロイ時の `--var RESEARCH_DECISIONS_ENABLED:true` のみで有効化。Gitの `wrangler.jsonc` は `false` のままで、Gitから再デプロイすると無効に戻る |

## 実API疎通（合成2ケース×2モデル、Worker経由）

| ケース | Jev 1.14 | GPT-6 Luna Decisions |
| --- | --- | --- |
| 候補が2つで名称採用の意図なし | confirm（agree確率0.00） | confirm（0.01） |
| 対象が1つに定まり明示的な採用提案あり | agree（0.86） | agree（0.46） |

- 遅延（Worker経由）: 414–603 ms。直接呼び出しの初回は、Luna Decisions 4.7 s、Jev 0.6 s。
- 課金: この日の呼び出しは合計 約$0.0004（OpenRouterの月$10上限内。鍵の利用状況で上限$10・月次リセットを確認）。Lunaの実発話1件はOpenAI側の既存経路。
- 失敗: 直接呼び出しのJevで1回、応答前の接続エラーがあり、再試行で成功。Worker経由の失敗は0件。
- 誤合意: 曖昧なケースでは両モデルとも合意を選ばなかった。明示的な採用提案があるケースでも、Luna Decisionsのagree確率は0.46にとどまり、Jevより慎重だった。2件だけの合成例で、比較の結論には使えない。

## 未解決・判断事項

- 比較の入力は文章だけで、画像を含まない。Lunaの判断（対象・名前・特徴）を仮説として含むため、Jev・Luna Decisionsは独立した判断ではなく、Lunaの仮説に条件付けられた比較になる（README記載）。画像を含めた比較は未実装。
- 実参加者の対話をOpenRouter（TypeSafe・OpenAI）へ送る前に、同意・匿名化・提供者の保存条件の確認が必要。
- 判断モデルを会話の行動選択に使うか、閾値、評価方法は未承認で、shadowのまま。
