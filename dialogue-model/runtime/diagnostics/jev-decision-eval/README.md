# Jev判断＋観察メモの接続確認

**AUDIT-01で差し戻された旧ハーネスの再現専用。** 以下の手動手順・台本・期待・ゲートは21e9fdeの歴史的記録として凍結し、新規評価には使わない。文・expect/check・集計・合否規則を変えて旧不合格をgreen化しない。旧runと保存claimも書き換えない。

`gate.ts` の局所再計算は `legacy_private_plan` を明示し、旧計画特徴claimを再現する。再計算結果を報告する場合はlegacy再現である旨を付記する。現行runtimeは `none` なので、同じ入力でも特徴claimと応答のカバレッジが異なる。旧ゲートの合格は、旧oracleの意味的妥当性や現行runtimeの意味的機能の認証ではない。以下は当時の手順・説明として残す。

決定0002に基づく研究用opt-inの手動ハーネス。Jevが行動を決め、Lunaは初回観察・指定再観察・メモに基づく局所抽出・発話表現を担当する。実APIは研究者／親だけが実行し、CIと子エージェントは模擬のみを使う。importだけでは設定読込、Keychain参照、通信を行わない。

採否介入と実験条件は未決のため、比較・盲検化・Argon評価のファイルは生成しない。ゲート合格は配線と合成台本の期待を満たしたことを示す。解釈の正しさ、実参加者に対する効果、語用上の自然さを証明するものではない。旧 `local-grounding-eval/` は旧構成の参考として残す。

台本（`cases.ts`）・期待値・ゲート（`gate.ts`）を追加・変更するときは、実装の前に独立監査役Astraの事前監査を受け、実行後の不合格もAstraが原因を切り分ける（[決定0003](../../../decisions/0003-independent-test-audit.md)）。ゲートを通すために期待値を後から変えない。Argonはテストの監査に使わない。

## 手動実行（研究者／親）

```sh
node --env-file=.env dialogue-model/runtime/diagnostics/jev-decision-eval/live.ts \
  --out /absolute/path/outside-any-repository --seed 1701 \
  --local-timeout-ms 60000 --observation-timeout-ms 60000 --decision-timeout-ms 30000
```

`.env`は既存の研究用Workerクライアント設定にだけ使う。purposeは`dialogue_turn`、生成モデルはWorkerのmodel-policyから確認し各応答で一致を検査する。Jevは既存の研究用Keychain経路を使い、モデルIDの完全一致または`-YYYYMMDD`付きの返却を許可して返却IDを残す。判断器と局所分類器は台本ごとに新しく作り、費用上限は各アダプタの既定を維持する。seedは自分側刺激の生成seedであり、生成文の再現性を保証しない。

`--case <id>`は一件の診断用。省略した台本を合格扱いにせず、全体ゲートには`catalog_incomplete`が残る。`--local-timeout-ms`は1〜60000の整数、省略時はruntime既定。`--observation-timeout-ms`も1〜60000の整数で、初回観察と指定再観察の両方へ適用する。省略時は観察器の既定20秒を維持し、指定値は`run.private.json`の`observationTimeoutMs`へ記録する。局所抽出の予算とは独立している。`--decision-timeout-ms`は1〜60000の整数で、指示対象推定1回と各行動判断（必要な2段を含む）の時間予算へ適用する。省略時はJevアダプタの既定を維持し、指定値を`run.private.json`へ記録する。費用上限は変更しない。入力や出力パスが不正ならモデルを呼ぶ前に拒否する。出力先は必須で、Git管理下やリポジトリを指すsymlinkを拒否する。

## 合成台本とゲート

`cases.ts`の5本は新規の匿名日本語発話だけを持つ。人間側の当該発話だけを順次公開し、未来発話・`expect`・`check`・`referentScenario`はモデルへ渡さない。馬／牛の複数の見立て、別命題への部分同意と否定、複数候補、名前の拒否と提案、保留と再訪、情報が増えない返答と追加の特徴を含む。固定の先行AI文や行動を要求する指示は使わない。実際の生成が前提に合わなければ不成立として残す。

| 台本 | 指示対象の観測場面 |
| --- | --- |
| `continuing-referent` | (a) 同じ図形への「それ」「その形」が続く |
| `animal-construal` | (b) 同じ図形に馬／牛という別の見立てがある |
| `two-candidates` | (c) 類似する2図形で候補が割れる |
| `repair-information` | (d) 修復中に新しい特徴が加わる |
| `compound-and-shift` | (e) 複合発話のあと別図形へ移る |

台本の語やカテゴリを観察プロンプトの例として追加しない。どの図形が正しいかの正解表、期待順位、分布の変化量はモデルへ渡さず、自動で正誤を確定しない。`referent-trajectories.private.jsonl`の発話番号・原スコア・メモ出典と刺激を用いて、研究者が実行後に独立して集計する。現出力は未採点である。

`repair-information`の「棒の方には四角がない」は、図形についての否定形の主張として`assert`（part）を期待する。先行命題への応答を表す`deny`とは区別する。

各台本で、自分の6図形と観察メモのID／pixel region一致、初回観察ちょうど1回、再観察とJevの依頼の対応、観察以外の画像送信0、Luna判断呼出し0、全Jev判断の返却モデルと証跡、最終行動との一致、公開文の既存guard、局所更新の独立再検証、宣言した発話ごとの期待を監査する。局所同意を図形全体や名称の合意へ昇格させない。公開文の検査は既存の字句guardの範囲であり、意味全体の一致を自動保証しない。

全台本を通して、見立てを即不一致にしない事例、部分同意、複数候補、否定、修復の進捗／停滞、指定再観察の存在を確認する。成功した台本だけを選ばず、一件でも失敗・構造不成立なら全体を不合格にする。修復の進展は、図形についての新規内容（`assert/agree/deny/construe/name_propose/name_accept/name_reject`、question/progress論点を除く）、または候補の非空の真部分集合への絞り込みだけで判定する。内容はaspect／act／命題／名称と対象の重なりで比較し、新しいIDの反復や対象集合の拡大だけを新規内容にしない。理解困難・相槌、候補拡大・空集合化、削除だけは停滞として、before/after・removedも観測根拠として保存する。まだ返答のない最新の確認はunknownのままにし、固定のターン数で終了を決めない。

新ハーネスの`auditJevLocalTurn`は、インストール済みの局所操作を独立再検証する。先行Jev判断がmultipleなら候補集合をAI特徴claimに保持し、単一図形や名称の合意に縮めない。guard fallback公開ターンからはAI claimを作らない。旧構成の`local-grounding-eval/gate.ts`は変更しない。

各人間ターンで、行動判断より先に指示対象を専用の1問1呼出しで推定する。`humanReferent`は自分6図形ID＋none／multipleの全8生スコア、または明示的なunknown（scores=null）を持つ。合計を1に直したり、最大値から対象や合意を確定したりしない。次の行動の`target`、局所claimのtargets、再観察のfigureIdsは別項目であり、指示対象と一致する必要はない。

ゲートは推定回数・行動より先の順序・全8ラベルと値域・返却モデル、推定直前の観察メモの版／UTF-8 JSON SHA-256、コミット済みtraceとの一致を監査する。推定を行動判断へ渡したstatus/scoresは再観察後も同一であることを確認し、新しい人間ターンでは再推定する。推定失敗や不正値はunknownとして記録し、それだけでゲートを不合格にしない。既知の推定で予算が欠ける場合は不合格。不明で予算自体が得られない場合は省略集計のmissingCallsに残す。

`referent`の件数・入力予算は、行動判断の`inputBudget.calls`と別に集計する。各ターンには専用推定が1回加わるので、再観察を含むターンでは最大4回の行動用HTTPに推定1回が加わる。画像は推定・行動判断へ送らない。公開文の指示対象分布フィールドのechoは拒否し、分布やメモhashは非公開の研究用記録だけに保存する。

単独liveは1方略だけを実行するため、runとgateに`conditionNeutrality: "not_measured; verified_by_regression"`を明記する。両条件を実測済みとは扱わず、それだけで不合格にもしない。同じ前置きの実C runtimeを両方略で模擬実行し、推定と判断のrequest JSONがバイト同一であることを回帰テストで確認する。`compareConditionInputs`は、対になった試行の入力hashとメモ出典を照合し、片側がなければnot_measuredを返す。対の出力は比較効果の検証ではない。

Jevの問いは、段1でaction／target／multiple候補の集合、必要な場合だけ段2で名称・特徴または再観察対象／論点を選ぶ。判断1回あたり最大2呼び出し。再観察は1ターン最大1回で、再観察前後の判断2回では最大4呼び出しになる。

Jevの`inputBudget`は全判断の各段（再観察前の判断も含む）を記録し、入力上限、省略した項目数・字数をゲートに集計する。`inputBudget.calls`は段の試行数で、費用上限等でHTTP送信前に止まった段も含む。外側の段1予算を重複加算せず、段2の省略も数える。省略自体で不合格にはしない。予算記録がない場合や値が不正な場合は停止する。

## 出力と中断

実行ごとに外部出力先の下へランダム名のディレクトリ（0700）を作り、ファイルは0600で保存する。

| ファイル | 内容 |
| --- | --- |
| `run.private.json` | 構成、seed、モデル、全台本／選択台本ID、台本hash、指定した時間予算、暫定介入なしの指定 |
| `attempts.private.jsonl` | 初回観察と各ターンの完了・失敗チェックポイント、公開履歴、局所処理とJevの追跡記録 |
| `<case-id>.private.json` | 試行ごとの観察、送信phase／画像件数、独立監査、全公開履歴、失敗時の固定診断 |
| `completed.private.jsonl` | 成否を含む試行の終了記録 |
| `failures.private.jsonl` | 失敗時のみ。caseId、発話番号、固定エラーコード。観察失敗は`observationErrorCode`と`observationPhase`も保存 |
| `gate.private.json` | 全試行のゲート、返却モデル、推定と行動それぞれの省略集計、条件中立性の未測定表示、失敗一覧 |
| `referent-trajectories.private.jsonl` | 完了ターンのcaseId・発話番号・合成人間発話・推定原記録・独立したactionTarget。正誤は未採点 |

一件の失敗で他の台本を捨てない。成功済みターンは随時追記するので、中断しても以前のチェックポイントは残る。再開による合格ケースの選別は実装しない。`counts.invalidDecisions`は`invalid_decision`で停止した試行数を集計する。新モードのdefer／move_onは未特定・複数対象を許すが、revisitには単一対象が必要であり、失敗を別行動へ置き換えない。

指示対象推定の試行は`referents`へ、失敗・中断したターンでも記録する。原プロンプトを保存せず、同じ白リストbuilderから作ったrequestのSHA-256と参照メモの版／hashを残す。推定結果はstrict validatorで再検証し、不正な戻り値・未知例外・任意のerrorフィールドを保存しない。型付きabortはターンを中断し、公開しない。

Jevの失敗も`decisionAttempts`へ固定エラー、返却モデル、responseId、費用、入力予算の許可項目を保存する。`stages`はaction_target／detail別に同じ項目とstatusを持ち、段2が失敗しても段1の記録を保持する。外側の`choices`は段1のラベルで、各段の`choices`は同一入力から再構成した送信質問と照合する。段2の質問は検証済みの段1ラベルからだけ再構成する。`choices`は送信した全質問の閉集合と照合できたラベルだけを保存し、不正・部分回答は空にする。`inconsistent_decision`／`invalid_decision`の`rejectionCode`はアダプタの固定閉集合だけを許し、成功・他の失敗はnullとする。棄却された判断は公開せず、代わりの行動を選ばない。失敗した判断の入力省略もゲートの予算集計に含める。APIの生応答、選択肢の説明文、例外本文は残さない。

相手画像、正解表、実対話、分析ラベルは扱わない。画像本文、資格情報、プロンプトや生のプロバイダエラーは保存しない。未知例外は固定`evaluation_unavailable`へ正規化する。危険な文字列を追跡記録に検出した場合はその値を`{redacted:true}`へ置換し、全体ゲートを不合格にする。失敗・棄却を含む記録は残す。

観察の追加診断はruntimeの型付き`JevTurnError`からだけ取得する。`observationErrorCode`は観察器の固定閉集合へ再正規化し、`observationPhase`は`initial`／`targeted`だけを許す。初回観察はターン追跡記録を作る前に失敗するため、その例外の安全な診断を失敗ファイルと試行ファイルへ残す。例外本文や任意の`error.code`は転記しない。

## 模擬検証

```sh
node --test tests/jev-decision-eval.test.ts
```

実JevアダプタもKeychain／HTTPを模擬に差し替えて検証する。模擬実行の成果物には`execution: "mock"`を付け、実接続の証跡と区別する。
