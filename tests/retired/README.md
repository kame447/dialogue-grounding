# 旧 local-grounding-eval 後段検査の退役記録

研究者決定日: **2026-10-21**。旧構成（決定0002以前、Lunaが行動を選ぶ `dialogue-v2`）の評価ハーネスを凍結・退役し、現行runtime向けには保守しない。

- 保存元commit: `a4d9e21b0ff6c57173319babace579da775aa213`
- 保存元path: `tests/local-grounding-valid-eval.test.ts`
- [元ソース全体の非実行スナップショット](local-grounding-valid-eval.a4d9e21.source.txt)のSHA-256: `76da081b8fa352245ecf35571f9ef217dd75c586bb5c2091678331b54d95a3eb`

保存ファイルは、共有helper・importを含む元ファイル全体を**バイト不変**で保存した公開リポジトリの合成テストソースである。保存物に含まれる23件すべてを退役させたわけではなく、対象は下の11件だけ。元の失敗を修正してpassさせたのではなく、明示的な研究者決定により11件を現行CIの分母から除外した。退役11件は、現行CIのpass/skip件数とは別枠で記録する。退役前の11failという実行記録も、そのまま保持する。

この `.source.txt` は現行CIでは非実行であり、TypeScriptの解決・型検査の対象にも入れない。`npm test` のglobと `tsconfig.runtime.json` は変更していない。スナップショットはソース保存物であって、自動再実行可能な歴史runtimeではない。旧runの後段再現には対応する当時のruntime・基準commitと別途承認された再現設計が必要であり、現行noneと旧ゲートの組合せで再現できるとは扱わない。

現在の旧fixture・旧評価条件で後段へ到達しないことと、noneを使う任意の入力が常に停止することは別である。CLIの実行禁止機構は追加していない。旧台本の意味的oracleの妥当性も、この退役判断では再認定・否定しない。

## 退役対象の正確な11件

位置はすべて **a4d9e21b0ff6c57173319babace579da775aa213 の元ファイル**の行である。以前の21e9fdeの行番号とは混ぜない。現行ファイルではこれら11個の `test(...)` ブロックだけを除去し、残る12件の本文、共有helper、fixture、分類器応答は保持する。

| 元の開始行 | 正確なテスト名 |
| --- | --- |
| 133 | `real dialogue runtime generates/publishes prefixes, branches identical state and runs independent E2E arms` |
| 171 | `an invalid script is excluded with reasons while eligible scripts continue to comparison` |
| 210 | `actual Jev adapter with mock HTTP supplies model-checked evidence to the live gate` |
| 246 | `new E2E arm is gated again after a valid prefix and keeps blind files absent on later classifier failure` |
| 269 | `generation failure leaves staged claims uncommitted and preserves completed prefix diagnostics` |
| 316 | `local timeout reaches extraction and the remaining classification budget in every live stage` |
| 456 | `live branch and E2E cohorts can supply agreement, denial and naming in different scripts` |
| 469 | `a later invalid E2E case is removed from both modes without stopping the remaining cases` |
| 495 | `global function coverage is required before comparison and recomputed after case exclusion` |
| 540 | `a prefix provider failure or model mismatch excludes that script without poisoning later scripts` |
| 563 | `an abandoned model call belongs to its excluded script and cannot invalidate the next script` |

## 責務移行対応表（独立監査 2026-10-21 承認。未移行の責務はそのまま残す）

以下は責務とギャップを確認するための提案であり、後継ハーネスの採用・設計・実装の承認ではない。SPEC-v2は設計案であり、各項目は**移行候補・設計待ち・実装待ち**として記す。新構成の同一prefix対の入力比較だけで、独立branch/multiturn比較全体を代替したとは扱わない。

| a4d9e21の対象行（上表のテスト名で識別） | 退役する検査責務 | 既存検査の限定した範囲 | 未移行の責務・SPEC-v2の状態 |
| --- | --- | --- | --- |
| 133 | 同じ公開履歴/privateState/判断からのbranch、独立multiturnアーム。未来発話/expectの非混入、盲検成果物のprivate field非混入、0700/0600権限、供与画像だけの送信も含む。 | E1の当該mock対のrequest JSONとreceipt投影の一致、および同ファイルの入力非混入・権限検査。E3の観察以外の画像送信検査。これらは個別の配線検査。 | 旧branchの同一state複製、独立比較アーム、生成されなくなる比較/盲検成果物の非混入・権限検査は未測定。後継比較設計は移行候補・設計待ち・実装待ち。 |
| 171 | 空の抽出で不適格な台本だけを除外し、適格台本は比較まで継続する。 | E1に故障caseと後続caseの記録を保持する検査はあるが、旧cohort選別/比較完遂とは異なる。 | 適格/不適格台本の選別と後続比較の統合は未移行。SPEC-v2への移行候補・設計待ち・実装待ち。 |
| 210 | `createJevLocalTestClassifier`（局所機能分類adapter）のHTTP/model証跡を旧live gateへ接続し、snapshot/mismatch/cost capを検査する。 | E2に固定model/URL、日付snapshot、model不一致、cost capのadapter単体検査が既存。行動判断の `jev-decision-client` だけで同じ責務を担ったとは言わない。 | 局所分類adapterから旧ハーネスゲートへの統合段は退役。後継統合は移行候補・設計待ち・実装待ち。 |
| 246 | 成立したprefix後の新E2Eアームでのclassifier失敗、同一ケースの分類器共有、盲検出力の抑止。 | E3/E4の単一ターン失敗・非コミット境界は個別検査であり、比較アームを実行する検査ではない。 | prefix後のE2E分類器失敗と共有インスタンス/比較成果物の統合は未移行。移行候補・設計待ち・実装待ち。 |
| 269 | prefix中とbranch中の生成失敗、staged claim非コミット、完了prefix診断の保持、固定診断と漏洩抑止。 | E3の生成失敗/unsafe rewriteの全候補state非公開、E4の生成失敗でclaim/reference更新をrollbackする個別検査が既存。 | prefixから比較段へまたがる失敗・完了診断の保持は未移行。移行候補・設計待ち・実装待ち。 |
| 316 | 抽出の設定予算と分類の**残り時間予算**をprefix/branch/E2E全段で検査する。 | E1の観察予算テストは初回/指定観察の予算とlocal_extractionへの値を検査する範囲に限る。 | これだけで分類残余時間や全比較段を検査したとは扱わない。分類残余/全段統合はギャップ。移行候補・設計待ち・実装待ち。 |
| 456 | 異なる台本がagree/deny/name_acceptを分担するcohort、全branch/multiturnの最終ゲートと全盲検行の成立。 | E5の純粋ゲート単体は台本別構造と適格台本間の機能集計を検査する。 | 実際の比較cohortを完走する統合は未移行。後継機能カバレッジ層への移行候補・設計待ち・実装待ち。 |
| 469 | 後段E2Eで不適格になった台本を両modeから除外し、他台本を続行。先のprivate branch checkpointは保持しつつ盲検から除き、最終case集合を再集計する。 | 一般的なprovider/model失敗や純粋な集合ゲートとは異なる責務。 | 後段除外・両modeへの伝播・checkpointの扱い・最終再集計は未移行。移行候補・設計待ち・実装待ち。 |
| 495 | prefix全体の必須機能不足では比較を開始せず、後段の台本除外後も機能を再集計し、除外台本から機能を借りない。 | E5の純粋な適格台本/機能ゲートは既存。R5-cの `R5-c: the fixed synthetic-cycle prefix is ineligible and starts no comparison` は、固定fixtureの完了prefixが不適格となった場合の比較非開始だけを検査する。 | 実比較アーム除外後のcohort/機能再計算は未移行。移行候補・設計待ち・実装待ち。 |
| 540 | prefixのprovider/model失敗を当該台本へ帰属し、後続の正常台本は比較完遂。秘密情報を保存しない。 | E1の失敗case記録・typed failure・機密非漏洩は個別検査。 | 後続台本の旧比較完遂と盲検case選別を代替しない。後継統合は移行候補・設計待ち・実装待ち。 |
| 563 | timeoutで破棄した遅延応答を次のcaseへ誤帰属させず、次のcaseを比較完遂させる。 | E2のtimeout後の遅延応答/evidence隔離とE3のsuperseded判断の非インストールは個別検査。一般的provider/model失敗と同じ責務ではない。 | cross-caseの遅延応答帰属と後続比較完遂は未移行。移行候補・設計待ち・実装待ち。 |

既存検査への参照（現在のテスト本文が示す範囲に限る）:

- E1: [Jev評価の模擬配線試験](../jev-decision-eval.test.ts)。`both strategies give the same referent and decision request JSON from the same prefixes`、`mock pipeline completes publication while S1 feature coverage and repair progress remain lost`、`observation factory budget reaches initial and targeted calls and is recorded separately from local processing`、`provider/model failure keeps every case, previous checkpoints and typed failures, and cannot pass`。
- E2: [局所機能分類adapterの単体試験](../local-grounding-jev-local-test.test.ts)。`wire uses fixed model/URL, two closed choices per segment, safe aliases and the existing state whitelist`、`accepts only exact Jev-1.14 or its dated snapshot, preserving the actual response ID`、`observed-cost stop rule prevents the next estimated overspend and missing costs halt the instance`、`late responses cannot overwrite a timed-out call or account unverified late costs`。
- E3: [Jevターンの模擬試験](../jev-turn-pipeline.test.ts)。`Jev mode observes once, never calls Luna judge, and sends no image outside observation`、`generation failure and unsafe rewrite keep the entire candidate state unpublished`、`a superseded decision settles promptly and its late result never installs`。
- E4: [局所更新トランザクションの試験](../local-grounding-v2.test.ts)。`generation failure rolls back all claims and existing reference updates` ほか。単一ターンの非コミットを後段比較完遂と混同しない。
- E5: [現行ファイルに残す純粋ゲート試験](../local-grounding-valid-eval.test.ts)。`case gates enforce structure independently while required functions are covered across eligible scripts` ほか。ハーネス後段の到達を実証したものではない。

R5-cの `R5-c: the fixed synthetic-cycle prefix is ineligible and starts no comparison` を、独立再現・固定oracleの限定承認に基づいて1件追加した。`dependencies()` のsynthetic-cycle、seed=1701、bypass-enabled、mode=bothで、4ターンのprefixが正常に公開・コミットされた後、caseのscript_mismatchにより比較を開始しないことを検査する。run未達の8項目には適格receiptゼロによる二次診断が含まれる。元から残す12件と新規1件を実行し、退役11件は別枠とする。none全入力の普遍的停止、新構成の後段検査の完成、退役した11件の代替達成は主張しない。
