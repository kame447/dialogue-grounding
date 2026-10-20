# 匿名合成による局所 grounding 評価（手動専用）

旧記録の再計算では `gate.ts` が `legacy_private_plan` を明示して計画特徴claimを再現する。報告にはlegacy再現と付記し、保存済みの結果やclaimを変更しない。現行runtimeは `none` に固定され、特徴claimへの応答のカバレッジが異なる。以下の旧手順の合格を現行runtimeの機能認証とみなさない。

## 是正後の実生成比較: live.ts

部分更新の比較には `live.ts` を使います。以前の `run.ts` は固定したAI発話と再計算判断を併用し、抽出器に画像・アンカーがない時期の結果も含むため、部分更新の効果検証として成立しません。旧結果は自然さの参考に限ります。Luna暫定分類器の結果をJevの精度評価と解釈しません。

`live-cases.ts` は今回新規に書いた匿名の**人間側だけ**の合成台本6本です。AIに説明・命名提案を指示する文や、理由なく自分の同意を取り消す流れは使いません。実対話・Excel・過去5対話・正解表は使いません。期待actはゲート専用で、モデルへ渡しません。AIの発話は毎回 `createDialogueV2` の通常経路で生成し、公開する応答と採用した判断を対応付けます。抽出器には判断と同じ自分側の画像・pixelアンカーを渡し、相手画像は作成も送信もしません。

```sh
node --env-file=.env dialogue-model/runtime/diagnostics/local-grounding-eval/live.ts \
  --out /absolute/path/outside-any-repository/evaluation \
  --mode both --seed 1701 --strategy bypass-enabled
```

Worker設定は下記の旧経路と同じです。Luna抽出・判断・生成は同じWorker client（`dialogue_turn`）を共有し、全応答のmodelとmodel-policyが一致することを検査します。分類だけは研究者が手動で有効にしたローカルJevアダプタを用い、既存のKeychain readerを分類呼出時に使います。分類器はケースごとに1インスタンスを作り、前置き・新側の分岐・実マルチターンで共有します。既定の費用上限0.05USDはそのケース内の累計に適用され、上限到達はゲート未達になります。Jevキーを `.env`、成果物、コンソールへ書きません。子エージェント・CIは実APIを呼びません。モデルポリシー・Worker・既定の方略は変更しません。

`--local-timeout-ms <整数>` で、抽出・分類を合わせた1局所ターンの時間予算を1〜60000msの範囲で指定できます。たとえば画像付き抽出の配線確認では `--mode branch --local-timeout-ms 60000` と指定します。未指定時は既存の局所処理予算（通常20000ms）を維持し、判断・生成・Jevアダプタ固有の上限は変えません。指定値は `run.private.json` に保存します。時間予算を増やしてもゲートの要件は同じです。

`--mode branch` は局所ONで評価直前まで前置きを実生成し、その**同じ公開履歴・privateState・判断履歴**の複製から、旧OFF／新ONの次応答を生成します。これは共通の局所ON前置きを条件とする「次ターンの追加更新」の比較です。旧側にも前置き時点のgraphは残るため、局所記憶が一度もなかった場合の比較とは解釈しません。

`--mode multiturn` は両条件で同じ人間台本を最初から実行し、AIの発話は各条件で実生成します。先行AI発話は一致するとは限りません。`both` は両方式を別行で出力します。board seedは同じ刺激を再現するための値であり、APIの生成seedではありません。生成の乱数は固定できません。実行順・盲検A/Bの順はケース／方式ごとに乱数で決めます。

台本の内容と期待は次のとおりです。`expect` は明示された機能が必要なステップだけに付け、複合発話は配列で両方の機能を要求します。相槌には同意や名称受諾の期待を付けません。

| caseId | 局所問題 | 必須の期待 |
| --- | --- | --- |
| partial-feature-mismatch | 四角への部分同意と、三角のつながり方への否定・保留 | agree＋deny、defer |
| human-name-proposal | 人間からの命名提案と、同じ図形かという留保 | name_propose |
| name-with-different-construal | 見立てが違っても呼び名を受諾 | name_accept |
| name-rejection | 見立ては残したまま呼び名を拒否 | name_reject |
| defer-switch-revisit | 向きを保留し、別図形を挟んで再訪 | defer、revisit |
| ambiguous-backchannel | 短い「うん」と、命名への合意ではないという補足 | なし（構造項目は同じく必須） |

まず全選択ケースの局所ON前置きを作ります。**台本ごと**に次の構造項目を検査し、不適格な台本は理由コードを記録して比較対象から外します。他の台本は続行します。

- 公開済みAI発話とコミット済み判断に由来するAI claimが1件以上、own slot付きclaimが1件以上。
- その台本に付けた各expectが、同じ人間ターンの検証済み・対象付きclaimとして成立すること。複合expectは全要素を満たすこと。
- 採用graphの新claimと、前状態・公開引用・抽出／分類結果からプログラムのverifierを独立に再実行した操作が一致し、未検証更新は0件。
- 全局所ターンの分類証跡が `jev_local_test`、status=ok、有効なcallIndex、返却modelが `typesafe/jev-1.14` または `typesafe/jev-1.14-YYYYMMDD`。返却IDは省略せず非公開記録へ保存。
- callbackのturnIndex／lastEventId／attemptNumberが採用judgmentと一致し、`settleLocalTraces` がcommittedと認定すること。stagedだけでは認定しません。

そのうえで、**実行全体の適格台本の合計**に、検証済みの同意・否定・名称受諾がそれぞれ1件以上あることを要求します。各台本に全機能を要求しません。構造項目を落とした台本のclaimは合計に使わず、適格台本が0件なら `no_eligible_cases` で拒否します。この全体ゲートが未達なら比較生成へ進みません。

比較中も新側の各台本に構造ゲートを適用します。失敗した台本は旧新のペアごと除外し、`both` では両モードから同じ台本を除外します。残った比較対象だけで、各モードの同意・否定・名称受諾を再集計し、すべてのモードで全体ゲートを通るまで盲検ファイルを作りません。前置きで成立した機能を、除外済み台本から借りて最終ゲートを通すことはありません。

人間の続きの発話が実際のAI提案と噛み合わない場合も `script_mismatch` で除外し、固定AI文・強制した判断・人工claimで補完しません。比較対象は適格になった台本に限られるため、除外数・理由・最終caseIdを評価結果と一緒に記録します。自然さや解釈の正しさ、効果・課題成功は、ゲートとは別に評価します。

出力先は必須で、Gitリポジトリ内とそこへ向かうsymlinkを拒否します。毎回 `local-live-<乱数>` を新規作成（0700）し、ファイルは0600で保存します。

- `<case>.prefix.private.json`: 実生成の公開履歴、採用判断とのprovenance、台本の構造ゲート（`gate.scope=case`）、C callbackとsettle結果（失敗時のみ `records[].extractor.errorCode`／`records[].classifier.errorCode` に固定コードを保持）、分類の返却model／responseId／費用／固定失敗理由、独立監査、分岐直前のledger／graph／判断履歴snapshot（AI claimの出典確認に使う `generationGuard.fallback` も保持）。判断はreferenceを含み、自由記述note・画像・プロンプト・API生応答は保存しません。
- `<case>.<mode>-<condition>.private.json`: 各条件の同じ診断。失敗途中の試行は `-failed` に残ります。
- `gate.private.json`: 比較前の全体ゲート（`scope=run`）、台本ごとの構造ゲート・件数・返却Jev model IDs、適格／除外caseId。
- `final-gates.private.json`: 比較完了後、最終比較対象だけで再集計したモード別の全体ゲート。
- `exclusions.private.json`: 除外したcaseId・stage・固定の未達項目／エラーコード。prefixの不適格も比較中の不適格も記録します。
- `result.private.json`: 最終status、適格／除外caseIdまたは全体ゲートの未達項目。
- `failures.private.json`: 前置き失敗のcaseId／stage／許可済み固定コード。比較失敗はケース別failureファイルへ固定コードで保存します。
- `<case>.<mode>.completed.private.json`: 完了ペアを逐次保存する診断用checkpoint。**A/B条件が読めるため評価者には渡しません。** 後続失敗でも残ります。後から除外された台本のcheckpointも残るため、評価対象は最終 `blinded.jsonl` の収録分だけです。
- `mapping.private.json`: 最終的な条件対応表。評価者へ渡しません。
- `blinded.jsonl`: **全必須ゲート通過後だけ**作成。branchは `publicTurns`＋`responses.A/B`、multiturnは各条件の番号付き `dialogues.A/B` です。評価者にはこれと `argon-prompt.md` だけを渡します。

ゲート未達時の最終標準出力は `status=gate_failed` と固定の未達項目だけです。プロバイダの生エラー、トークン・APIキー・画像本文・プロンプトは出力しません。漏出検知が発火した候補は公開にも診断にも保存しません。これは任意の言い換えによる漏出まで検出するものではありません。

`--case partial-feature-mismatch` などで1系列の前置きだけを調べられます。選択した系列だけで全体の3機能を満たさなければ、構造が成立していても比較へ進まず `gate_failed` になります。方略は `--strategy bypass-enabled`／`--strategy repair-first` の両方を選べます。新live経路は現在 `--resume` と外部の固定AI系列のインポートを受け付けません。途中までの非公開checkpointを保持しますが、自動再開は未実装です。失敗した全実行のやり直しに先立ち、固定コードとゲートの未達箇所を確認してください。

模擬検証は `node --test tests/local-grounding-valid-eval.test.ts`。実APIによる成立性・効果確認は研究者／親の手動実行で別途行います。

## 旧固定prefix経路: 自然さの参考専用

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

各実行で新しいランダムディレクトリを作り、以下を権限700/600で保存します。開始時と完了時に標準出力へそのサブディレクトリ名を表示します。各ケースのcompleted/skippedもcaseId付きで表示します。

- `blinded.jsonl`: caseId、番号付き公開発話、A/Bの次応答だけ。評価者にはこのファイルと `argon-prompt.md` を渡します。
- `mapping.private.json`: 条件対応、board seed、方略。評価が終わるまで評価者から隠します。
- `failures.jsonl`: 失敗したcaseIdと許可済み固定コードだけ。失敗ごとに追記し、再開で成功した後も履歴を残します。
- `run.private.json`: 再開条件（seed、方略、モデル、公開入力のハッシュ）。入力本文や認証情報を含みません。
- `completed.private.jsonl`: ケースごとの盲検応答と条件対応を一つにした再開用journal。**条件が読めるため評価者に渡さないでください。**

画像本文、内部メモ、プロンプト、期待状態、トークン数、認証情報、上流の生エラーを出力しません。出力応答が画像・認証文字列・内部フィールド・非公開指示の定型句を含む場合は、そのケースのA/B両方を保存しません。他ケースは続行します。ケース内でモデルが変わった場合も、そのケースだけを失敗として扱います。固定コードはstderrにも`{"caseId":"...","code":"privacy_rejected"}`等の形で出し、1件でも失敗した実行の終了コードは1です。開始前の拒否や保存障害は`synthetic_evaluation_failed <固定コード>`、未知の原因は`evaluation_unavailable`となります。

完了したケースから保存するため、後続の失敗で先の成果を失いません。journalを先に確定してから`blinded.jsonl`へ追記し、対応表を更新します。モデル出力の任意の言い換えまで検知できる完全な漏えい検出器ではないため、共有前に研究者が内容を確認します。

1ケースだけ調べるには`--case <id>`を付けます。再開時は**出力ルートではなく、開始時に表示された既存runサブディレクトリ**を`--out`に指定し、初回と同じ`--seed`・`--strategy`・`--cases`を使います。入力内容・モデル等が変わっていれば`resume_mismatch`で拒否します。`--case`の選択は変更でき、同じcatalogの他ケースを後から追加できます。

```sh
node --env-file=.env dialogue-model/runtime/diagnostics/local-grounding-eval/run.ts \
  --out /absolute/path/outside-any-repository/evaluation --case local-agree-deny
node --env-file=.env dialogue-model/runtime/diagnostics/local-grounding-eval/run.ts \
  --out /absolute/path/outside-any-repository/evaluation/local-grounding-RUNID --resume
```

`--resume`はjournalで完了済みのケースを飛ばし、失敗・未実行のケースだけを最初から生成します。ケース内で片側だけ成功していても再開時にはA/Bを両方作り直します。中断されたjournalの末尾断片は破棄し、盲検出力と対応表を確定済みjournalから復旧するため、完了ケースの重複行やA/Bの再割当を防ぎます。旧形式（schemaVersion 1）のrunは再開対象外です。

同じrunの同時更新は`.evaluation.lock`で拒否します（`evaluation_busy`）。通常終了・例外時は自動解除します。プロセスを強制終了した場合は、元の実行が停止したことを確認してから、そのrun内の`.evaluation.lock`だけを削除して再開してください。盲検ファイル・対応表・journalは手動で削除しません。

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
