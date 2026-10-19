# 匿名合成による局所 grounding 評価（手動専用）

研究目的の正本は [dialogue-model/README.md](../../../README.md)、設計原則は[決定0001](../../../decisions/0001-partial-grounding-state.md)。本ハーネスは実験条件や尺度の採用を意味しません。CI・`npm test` は模擬clientだけを使用し、このCLIを実行しません。

`cases.ts` の16ケースは今回新規に書いた匿名の合成日本語です。研究者の実対話、Excel、過去5対話、参加者ログ、正解対応表を利用していません。`priorClaims` と `segments` は決定的E2E用の入力、`expected` は論点別の期待状態です。M/P/ER/aの研究ラベルを機械変換しません。これらのテスト用メタデータは実APIに送りません。

Node 24で、研究用Workerの設定がある環境から手動実行します。出力先の指定は必須です。

```sh
node --env-file=.env dialogue-model/runtime/diagnostics/local-grounding-eval/run.ts \
  --out /absolute/path/outside-any-repository/evaluation \
  --seed 1701 --strategy bypass-enabled
```

`RESEARCH_AI_PROVIDER=cloudflare`、Worker URL、`RESEARCH_PROXY_TOKEN` が必要です。クライアントは既存 `createChatClient` を共有し、`purpose=dialogue_turn` のみ送信します。モデルIDはWorker側で解決し、読み取り専用model-policyのreadyと各応答のモデルの一致を検査します。APIキー・トークンを成果物やエラーへ出力しません。対話モデル以外の外部サービス、Argon自体への送信は行いません。

同じケース・同じboard seed・同じ方略・同じclient・同じ生成設定で次の二条件を比較します。

- 旧: referenceMemory ON、localGrounding OFF。
- 新: referenceMemory ON、localGrounding ON。Luna抽出＋`createLunaLocalClassifier` の暫定分類器（Jev本番精度の評価ではありません）。

ケースごとに実行順とA/B提示順を暗号学的乱数で入れ替えます。board seedは刺激再現用であり、APIのサンプリングseedを設定するものではありません。確率的な生成の一致は保証しません。

公開prefixを各人間発話まで再生し、先行AI発話はケースの固定文を使います。判断と局所抽出・分類は通常経路で再計算し、最後の人間発話への次応答だけ実生成します。状態を期待ラベルから投入しません。固定AI文と再計算した過去判断が異なる場合も、公開引用の検証は通常どおり行われます。このため、ケースの期待局所状態を満たしたかの決定的E2Eと、実モデルの自然さの評価は異なる検証です。公開履歴は同じですが、条件ごとに過去判断を再計算するばらつきが残ります。

各実行で新しいランダムディレクトリを作り、以下を権限700/600で保存します。
完了時に標準出力へそのサブディレクトリ名だけを表示します。

- `blinded.jsonl`: caseId、番号付き公開発話、A/Bの次応答だけ。評価者にはこのファイルと `argon-prompt.md` を渡します。
- `mapping.private.json`: 条件対応、board seed、方略。評価が終わるまで評価者から隠します。

画像本文、内部メモ、プロンプト、期待状態、トークン数、認証情報、上流の生エラーを出力しません。出力応答が画像・認証文字列・内部フィールド・非公開指示の定型句を含む場合は保存を拒否します。全ケース成功前は結果を書きません。既存ファイルは上書きしません。モデル出力の任意の言い換えまで検知できる完全な漏えい検出器ではないため、共有前に研究者が内容を確認します。

外部の匿名合成系列も指定できます。リポジトリ内ファイル・他のGit作業ツリー・そこへ向かうsymlinkを入出力とも拒否します。参加者ログの匿名化やインポート用の機能ではありません。

```sh
node --env-file=.env dialogue-model/runtime/diagnostics/local-grounding-eval/run.ts \
  --out /absolute/path/outside-any-repository/evaluation \
  --cases /absolute/path/outside-any-repository/synthetic-sequences.json
```

外部JSONの形式は `{dataPolicy:{syntheticOnly:true,containsRealParticipantData:false,containsExcelOrPast5Dialogues:false},sequences:[{sequenceId,publicTurns:[{turn:1,speaker:"human",text:"新規合成発話"}]}]}` です。1〜32個の連番turn、最後はhuman、1〜100系列、2MB以下のJSONだけを受け付けます。`ownCandidateContext`、期待ラベル、評価尺度などは読み込んでも破棄し、モデル・盲検出力へ渡しません。任意の入力ファイルや研究記録をモデルへ送る汎用経路はありません。

模擬検証:

```sh
node --test tests/local-grounding-e2e.test.ts tests/local-grounding-safety.test.ts
npm run typecheck:runtime
```
