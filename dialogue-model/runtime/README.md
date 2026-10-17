# 対話実験用 AI 接続基盤（試作）

このディレクトリは「外部AIを実際に呼び、AI側の図形画像と公開対話履歴から次の一発話を生成する」ための最小実行基盤です。研究方針の正本は [../README.md](../README.md) であり、この接続基盤の存在は未決定の実験手続きを確定しません。

## 使い方

Node.js 22 以上を使います。外部パッケージのインストールは不要です。

```sh
cp .env.example .env
# .env に RESEARCH_AI_API_KEY と RESEARCH_AI_MODEL を設定
node --env-file=.env dialogue-model/runtime/cli.mjs --check
node --env-file=.env dialogue-model/runtime/cli.mjs --smoke
node --env-file=.env dialogue-model/runtime/cli.mjs --strategy repair-first --image /path/to/ai-side-six-figures.png
```

`--check` はローカル設定だけを検証し、通信しません。`--smoke` はモデルに短いテキストを1回送り、外部接続を確認します。図形対話の実行時は必ず自分（AI）側の6図形画像を `--image` で指定します。対話中は `/exit` で終了します。1発話だけ試すには `--message 'この図形は何と呼びますか？'` を追加できます。

同じモデル・画像を使い、`--strategy bypass-enabled` に変えると「曖昧さを許容する」条件を実行できます。現段階の2条件は発話生成プロンプトの方略指示だけが異なる暫定的な接続デモであり、方略差が実際に十分生じることは検証されていません。研究デザインの正式な操作化や閾値は未確定です。

## API の設定

`.env` は各自のローカル環境にのみ作り、Gitに追加しないでください。APIキーはチャットに貼り付ける必要はありません。

```dotenv
RESEARCH_AI_PROVIDER=openai
RESEARCH_AI_MODEL=利用する画像対応モデルID
RESEARCH_AI_API_KEY=あなたのAPIキー
```

`RESEARCH_AI_PROVIDER=gemini` に変更すれば Gemini の OpenAI-compatible endpoint に接続します（その場合も `RESEARCH_AI_MODEL` に Gemini の画像対応モデルIDを指定）。その他の Chat Completions 互換プロバイダは `RESEARCH_AI_PROVIDER=custom` と `RESEARCH_AI_BASE_URL` を設定して使用します。ネイティブ Anthropic API や Jev API はこの互換通信実装の対象外です。プロバイダやモデルごとに画像対応、料金、データ利用条件を確認してください。

必要に応じて `RESEARCH_AI_TIMEOUT_MS` と `RESEARCH_AI_MAX_COMPLETION_TOKENS` を指定できます。比較時はこれらの値とモデルIDを両条件で同じにします。`max_completion_tokens` はモデル依存なので、未設定時は送信しません。

## 実装範囲と安全上の境界

AIには自分側のPNG/JPEG/WebP画像（最大10MiB）と現在までの公開対話を送ります。相手側の画像・真の図形対応・完成済みアノテーション・将来の発話は保持も送信もしません。失敗したAPI要求は履歴に加えません。対話内容のファイル保存、採点、正解管理、被験者のランダム割付、実験UI、Jevによるアノテーション、セッション間復旧はまだ実装していません。

出力は端末に表示されるため、端末側で自動記録している環境に注意してください。外部API事業者によるデータ保存・学習利用の条件は事業者ごとに異なります。実対話を送る場合は必ず匿名化と送信条件を確認してください。

`npm test` でプロバイダ通信、画像送信、条件間の入力対称性、履歴の分離、HTTPエラー処理を模擬サーバーで検証します。これは本物のAPIキーを使った疎通試験や自然な対話性能評価の代用ではありません。
