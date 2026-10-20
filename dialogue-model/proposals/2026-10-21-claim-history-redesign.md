# 命題履歴と公開証拠の再設計（設計案、2026-10-21）

> 文書区分：設計案（proposal）。現行計画の唯一の正本は[SSOT](../README.md)。この文書は独立監査役（Astra）の事前監査を受けるための実装前設計であり、承認された範囲だけを[決定0004](../decisions/0004-claim-history-and-public-evidence.md)とSSOTに反映する。研究上の意味注釈規則・新しい発話機能・閾値・実験条件はここで決めない。

## 背景

2026-10-20の実接続評価（referent E2E 2）と独立監査（AUDIT-01、F1–F8）、2026-10-21の協議（Astra R1）で、次の問題が確認された。

| ID | 問題 | 現行コードの位置 |
| --- | --- | --- |
| F6 | Jevが内部で選んだ確認特徴が、公開文に現れていないのにAIの公開claimになる | `local-grounding/verify.ts` `recordAiClaims`（`discriminatingFeature` を proposition にし、quote は公開文の先頭） |
| F2 | AIの複合説明が1つのclaimになり、人間の部分的な応答2つが同じissueの `contested` に潰れる | `recordAiClaims`、`verifyLocalUpdate` のissue継承、`deriveLocalIssues` |
| F7 | 図形対象が未特定（none/multiple）でも修復したい名前・先行主張がある場面を表現できない | `decision/jev-decision.ts` `checkSelection`（`detail_target_required`）、`verify.ts`・`reference-graph.mjs` の空targetへの応答拒否 |
| F1/F3/F4/F5/F8 | 固定台本の期待値が実際の公開文脈を前提にしていない、未到達・評価不能が不合格に混在する、三つの「対象」の混同、再観察の必須化 | `diagnostics/jev-decision-eval/cases.ts`・`gate.ts` |

協議で追加に再現された不具合：
- 空targetの公開名称提案への明示的応答が `inconsistent_claim_response` で棄却される（`verify.ts:114`、`reference-graph.mjs:221`）。
- 合意済み名称のある図形に特徴だけのrepairを適用すると、名称が `unassigned/null` に消える（`judgment/schema.mjs` `applyAct`）。部分更新の原則（決定0001）に反する。

ユーザー（研究者）は2026-10-21に、「図形対象が未特定でも修復すべき問題はあり得る」ことを承認した。ただし「名付けをやめたい」が常に修復であるとは決めていない。

## 方針（原則）

1. **公開証拠と内部計画を分ける。** Jevが選んだ行動・対象・名称・特徴は「計画（intent）」であり、相手との間に公開された命題ではない。AIのclaimは、公開されたAI発話そのものから作る。
2. **命題の履歴は不変のイベント、現在の状態は導出。** 新しい大規模グラフは作らず、既存の `referenceGraph` の `claim` 記録を拡張する。状態は毎回履歴から再導出する。
3. **両話者の発話を同程度の粒度の命題に分ける。** どの命題に同意・否定・保留・訂正したかを命題単位で追跡する。部分同意を図形全体・名前・別の特徴へ広げない。
4. **修復の「問題」と「図形」を分ける。** 図形が未特定でも、公開済みの問題（名称提案、見立て、特徴、質問）を指定できる。公開根拠のない対象・問題は補わない。
5. **評価を3層に分け、評価不能・未到達・未測定を成功に数えない。**

## A. 公開証拠からAIのclaimを作る（F6）

### A1 処理順序

```
公開イベント（コミット済みAI発話）
  → 抽出候補（Luna：分節・対象候補・命題の言い換え）
  → 意味確認（Jev：閉集合。この引用はこの命題を表しているか）＋発話機能（Jev：閉集合）
  → 構造検証（プログラム：引用・先行claim・対象・名称・話者権限）
  → コミット（claimイベント）
```

- **対象**：公開されるAI発話のみ。生成ガードで書き直された場合は最終的に公開される文だけ。未公開の生成、中断、汎用fallback（`publishedFallback=true`）は抽出対象から除外し、除外理由を記録する。
- **実行時点（R3改訂）**：AI発話Tの抽出・意味確認は、**同じAIターンの中で、生成ガードを通過した最終文に対して**行い、その結果を同じAIターンの状態（`JevPrivateState`）に入れる。状態は現行のトランザクション境界（返答が公開されたときだけ状態を適用）でコミットされるので、AI claimは公開と原子的にコミットされ、次の人間ターンの成否に依存しない。最後のAI発話も同じターンで処理されるため、別の終了処理は不要。
- **入力の時点固定（R3改訂）**：抽出・意味確認の入力は、そのAIターンの生成時点の状態（T−1までの公開発話、その時点のissue要約・先行claim・観察メモ版、およびT本文）に限る。後続の人間発話や後のビューは構造上入らない。観察メモの版・ハッシュを記録する。
- **失敗時（R3改訂）**：抽出・意味確認が失敗しても、公開は止めない（両条件で同じ）。状態には `aiExtraction[T] = { status: "pending", attempts, inputSnapshot }` を入れ、claimは作らない。次の人間ターンの冒頭で、保存した `inputSnapshot` を入力として再試行する（後の情報は入れない）。そのターンが失敗しても `pending` は前の状態に残るので失われない。成功した時点で `completed` とclaimを同じ状態更新でコミットする。再試行の上限は工学的設定（両条件同一、試行を記録）で、上限に達したら `failed`（claimなし）。
- **ID**：claim IDは完成した抽出結果からだけ作る（`<T>:ai<k>`、kは完成結果内の分節順）。途中失敗の部分結果にIDを振らない。`completed` の結果が状態にあれば再試行しない（再抽出で分節が変わっても既存IDと混ざらない）。
- **抽出失敗の意味**：`pending`/`failed` の発話は「未抽出」であり「内容がなかった」ではない。下流（進展判定など）では `unknown` として扱う。
- **旧形式の状態（R3追加）**：本方式は新しい試行（スキーマ版を上げた状態）に限る。旧スキーマの状態（計画由来のAI claimを含みうる）を新方式の検証済みclaimとして復元しない。旧版状態の読み込みは明示的に失敗させる。
- **遅延**：AIターンごとに抽出・意味確認の呼び出しが増える。両条件同一で、遅延・費用を記録する。

### A2 意味確認（quoteの存在 ≠ 命題の支持）

- 抽出された分節ごとに、Jevに閉集合で問う：「この公開引用（必要なら照応先の公開claim）は、この命題を表していますか」— `expressed` / `not_expressed` / `unclear`。`expressed` だけを構造検証へ進める。`unclear`・`not_expressed` は棄却理由として記録する。
- この問いの入力は、公開発話（prefix）、引用、命題の言い換え、照応先の公開claimのみ。**観察メモは渡さない**（メモの特徴が公開内容に混ざるのを防ぐ）。観察メモは対象候補の解釈（どの自分側図形か）にだけ使う。
- 同じ意味確認を人間側の分節にも適用する（話者による非対称をなくす）。
- **照応先との整合（R3改訂）**：同じ呼び出しの独立な質問は互いの答えを見られない。そこで、発話機能（act・応答先 `respondsTo`）を先に問い、**選ばれた応答先を固定した状態で**意味確認を問う（局所処理の段を一つ増やす）。意味確認の選択肢は `expressed_responds`（引用は命題を表し、この応答先への応答である）/ `expressed_independent`（命題は表すが、この応答先への応答ではない）/ `not_expressed` / `unclear`。応答系のact（agree/deny/name_accept/name_reject/withdraw）は `expressed_responds` のときだけ受理する。独立系のact（assert/construe/ask/name_propose）は `expressed_responds` または `expressed_independent` で受理し、後者では応答先を外して診断を残す。別のclaimを根拠にした「表している」を、選ばれた応答先へ流用しない。
- プログラムの「検証済み」は、構造・出典を通過した解釈であって意味の真実ではない。

### A3 引用と照応の根拠を分ける

- `quote`：今回の公開発話のリテラル部分（直接の根拠）。
- `antecedent`：照応を解く先行の公開claim ID（「うん」「その名前で」などの応答先）。
- 名称の**新規導入**（`name_propose`）は今回の公開文にリテラルで現れることを要求する。名称の**受諾・拒否**は、検証済みの先行名称提案を参照すれば、今回の文に名称が現れなくてよい（現行 `verify.ts:128–136` の区別を維持）。

### A4 計画（intent）と公開実現の対応は診断のみ

- 各AIターンについて、計画（行動・名称・特徴）が公開文で実現したかを診断として記録する：`realized` / `not_realized` / `unknown`。
- `not_realized` は、Jevへの明示的な閉集合確認の結果としてのみ付ける。抽出器が落としただけの場合は `unknown`。`unknown` をどちらかへ自動変換しない。
- 「Xではない」はXを実現した証拠ではない。質問・断定・否定・引用・仮定を区別する（発話機能と意味確認で扱う）。
- この診断からclaim・名称候補・修復履歴を作らない。

### A5 下流の境界

| 下流 | 現行 | 変更案 |
| --- | --- | --- |
| claim（graph） | 計画から生成 | 公開発話の抽出から生成（A1–A3） |
| `previousAction`（Jev入力） | 計画を「前の行動」として渡す | 「非公開の計画」と明示し、公開実現の診断（A4）と、そのAI発話の検証済みclaim IDを並べて渡す。相手の既知事項として扱わない |
| `repairHistory.question` | 計画の特徴・名称の文字列 | そのAI発話の検証済み公開claim IDの列。計画の文字列は `intendedQuestion`（非公開、診断）に分離。公開claimがなければ、その修復の進展は `unknown`（停滞に数えない） |
| `ownLedger`（旧Judgment） | 計画から更新 | B6・C5を参照。計画由来であることを記録に明示 |
| `publicNames`（Jev入力） | claimの名称のうち公開文にあるもの | 変更なし（公開claim由来に限る） |

## B. 命題・issue・現在ビュー（F2）

### B1 識別子と関係の定義

| 概念 | 定義 |
| --- | --- |
| claim | 1つの公開発話の1つの分節についての不変イベント。IDは固有（`<turn>:local<k>` / `<T>:ai<k>`） |
| issue | 同じ命題の話題が続く単位。**同じaspectで図形が重なるだけではまとめない**（現行のまとめ方がF2の原因）。規則は下の表 |
| `respondsTo` | 話題上の応答関係（どのclaimに答えたか）。**issueをまたいでよい**（独立の主張が別issueのclaimに話題上応答する場合） |
| `dependsOn`（新規） | 根拠関係。応答先が撤回されると効力を失うclaim（同意・否定・名称の受諾/拒否・相槌）だけが持つ。独立の主張は、`respondsTo` があっても先行claimの撤回で無効にならない |
| `supersedes`（新規） | 置換関係。**同じ話者が自分のclaimを訂正する場合**だけ有効（自己訂正）。同じ発話内の「上、いや下」も分節の順序で表す |
| `correctionOf`（新規、任意） | 相手のclaimへの訂正案（「三角は下だよ」）。相手の旧claimを自動で置換しない |

**issueの継続規則（R3追加）**

| 場面 | 新しいclaimのissue | 関係 | 例（合成） |
| --- | --- | --- | --- |
| 応答系act（agree/deny/name_accept/name_reject/withdraw）で応答先が検証済み | 応答先のissue | `respondsTo`＋`dependsOn` | A「四角がありますね」H「うん、ある」 |
| 質問（ask）への内容的な回答（独立系act、応答先がask、意味確認が `expressed_responds`） | 質問のissue | `respondsTo` | A「出っ張りは長いですか？」H「短いほう」 |
| 検証済みの保留issueへの明示的な再訪・保留（revisit/defer、`linkedIssueId` が検証済み） | そのissue | `respondsTo`（あれば） | H「さっきの形に戻るね」 |
| 独立系act（assert/construe/name_propose/ask）で、応答先が無い、または意味確認が `expressed_independent` | **新しいissue** | 話題リンクがあれば `respondsTo`（issueをまたぐ） | A「四角があって、長さの違う出っ張りが二本」→ 四角と長さで別issue |
| 独立系actが既知claimを参照したが、同じ命題の継続か独立かを判定できない | 新しいissue（既知issueへ確定更新しない） | 診断 `continuation_undetermined` | — |
| 同じ内容の再主張・言い換え（意味的同一性の判定が無い） | 新しいissue（保守側：分割しすぎうるが誤って統合・昇格しない） | 既知の限界として記録 | — |

- 応答系actでも、応答側と応答先の図形候補がともに空でなく交わらない場合は棄却（明示的な対象矛盾の検査は残す）。複数候補のうち一つへの応答を、issue全体の支持へ広げない（stanceは応答claimの図形候補とともに記録）。
- 現行 `verify.ts` の先行issueの強制継承と、`reference-graph.mjs` の「`respondsTo` は同じissue」要件は、上の表に合わせて置き換える（応答系・質問への回答・再訪だけが同じissue、話題リンクはissueをまたいでよい）。

### B2 現在ビュー（導出、保存しない）

一つの排他的な状態にまとめず、軸を分ける。

| 軸 | 値 |
| --- | --- |
| lifecycle（claim） | `active` / `superseded`（自己訂正で置換） / `withdrawn`（本人撤回）/ `void`（依存先の撤回で効力喪失） |
| stance（claim） | 相手の支持claim IDの集合、相手の否定claim IDの集合（両方が非空なら競合） |
| focus（issue） | `open` / `deferred` / `revisited` |
| issue state | 現行の `unconfirmed` / `supported` / `denied` / `contested` / `deferred` / `withdrawn` を維持（互換）。命題単位のstanceから集約 |
| name state | 現行どおり（`no_name` / `unclear` / `not_agreed` / `agreed` / `unknown`） |

- 質問（ask）への「はい」は、質問者がその内容を既に主張していた証拠にしない。
- AI自身の観察仮説（`ai_hypothesis` / `own_observation`）は、相手の支持claimなしに支持済みにならない。

### B3 話者の権限

- 自分のclaimだけを撤回・置換できる。
- 相手の否定は相手のclaimを `superseded` にしない（stanceに否定として記録される）。
- 相手の訂正案（`correctionOf`）は新しいclaimとして記録し、元の話者がそれに同意しても、元のclaimを自動で `superseded` にはしない（元の話者が撤回または自己訂正したときに変わる）。
- 撤回の撤回、支持の撤回、置換済みclaimへの過去参照は、履歴として保持する。

**実装範囲の段階分け（R3追加）**：置換・訂正と名称状態の組合せは規則が未確定なので、次のように分ける。

| 段階 | 実装する | 実装しない（unsupported、記録のみ） |
| --- | --- | --- |
| 第1段階 | `withdraw`（本人の撤回）と、`dependsOn` を持つ応答系claimだけへの依存伝播（`void`）。独立claimは `respondsTo` があっても無効にならない。名称状態は現行規則を維持しつつ、「後の上書き」の判定には**現在有効な（void/withdrawnでない）claimだけ**を使う。旧合意の後に出た新提案が後で撤回された場合など、旧合意の復活が問題になる場面は `agreed` に戻さず `unknown` とする（保守側） | `supersedes`・`correctionOf`（自己訂正・同一発話内訂正を含む）、撤回の撤回、支持の撤回。該当しそうな発話は通常のclaimとして記録し、置換の効力は付けない（`supersedes_unsupported` 診断） |
| 第2段階 | 置換の遷移表（旧名称Xの受諾の扱い、名称状態、focus）を研究者確認・Astra事前監査の後に実装 | — |

A9（同一発話内の自己訂正）は第2段階の評価に回す。

### B4 極性は先行命題に対して判定する

- 文の否定形を先行命題への否定とみなさない。内容が両立することも、同意の発話機能とは別である。
- 発話機能（agree/deny等）は、先行命題の対象・範囲・部分・話者への応答関係が成立するときに付く。曖昧なら `unknown` に残す。
- 最終的な注釈規則は研究者の定義と事前監査済みのoracleに従う。分類器の指示文には上の区別だけを書き、特定の例文の正解を書かない。

### B5 相槌の応答先（ai1固定の撤廃）

- 現行は「直前のAI発話の1番目のclaim（`ai1`）」にだけ相槌を結び付ける。原子化すると番号順は意味的な主従を表さない。
- **R3改訂**：新しい相槌の意味規則（どのclaimへの応答とみなすか）は**研究者判断（OPEN）**とし、本設計では採用しない。実装するのは、ID番号（`ai1`）だけを根拠に応答先を決める・拒否する処理をやめ、短い相槌の応答先を確定できない場合は `acknowledge`（リンクなし）に残すことだけ。2aの試験で、内容・根拠・選択済み応答先を固定し、番号だけで正当な応答が拒否・付け替えされないことを確かめる。

### B6 永続記録と有限の作業ビュー

- `referenceGraph` は有限の作業記憶（記録数・操作数・公開ターン数の上限とprune）である。原子化で記録数が増える。
- 変更案：全claimイベントを試行ごとの非公開研究記録に追記専用で保存する（スキーマ版、出典ID、元のAI発話seq）。モデル入力用のビューは従来どおり有限で、省略件数を記録する。pruneされたclaimを解決済み・撤回済みとして扱わない。
- 上限値の変更が必要になった場合は、工学的理由と影響（何が落ちるか）を記録する。研究上の閾値として扱わない。

### B7 対象候補

- `targets` はAIが公開発話を自分側の図形候補に対応付けた解釈であり、`[]` は未解決として正当。`[]` を特定済みへ補完しない。
- 複数候補のうち一つについての応答、二図形の比較、同じ名前の別提案、候補の絞り込みは別関係である。本設計ではissueのまとめ方から図形の重なりを外す（B1）。対象関係の詳細な型（どれか一つ／すべて／比較）は実接続の結果を見て決める（未決）。

## C. 修復の問題参照（F7）

### C1 問題参照の候補

Jevに「この行動が扱う公開済みの問題」を閉集合で問う。候補は公開claimに由来するものに限る。

- 現在の作業ビューで `open` または `deferred` のissue
- 今回の人間発話の検証済みclaimが参照したissue（撤回・置換済みのclaimへの言及を含む。参照できることと、支持・名称採用の根拠として有効なことは別）
- 名称issueは、名前の文字列ではなく、どの話者のどの提案・受諾・撤回かを示すclaim IDで識別する
- 選択肢 `no_issue`（特定の公開問題についての行動ではない）と `unselectable`（複数あり一つに選べない・根拠不足）を区別する
- 候補数の上限は工学的設定とし、省略件数を記録する

AIが公開根拠のない問題を自由に作って受理することはしない。

### C2 2段階の問いのどこで聞くか（R3改訂）

問題参照と特徴を同じ呼び出しの独立な質問にすると、互いの答えを見られない。そこで2段目では、**問題参照と必要なdetailを組にした一つの閉集合の質問**（`focus`）にする。候補の組はプログラムが公開claimと観察メモから作る。

| 段 | 現行 | 変更案 |
| --- | --- | --- |
| 1段目 | 行動・図形対象（none/single/multiple＋候補） | 変更なし。ただし `repair`/`confirm` に `none` を選んでも1段目では棄却しない（2段目の後に検証） |
| 2段目 | 名称/特徴/再観察（行動に必要なもの、図形対象の範囲内） | `repair`/`confirm`/`defer`/`revisit` は `focus` の一問。`propose_name`/`agree`/`request_observation` は現行のまま（問題参照は問わない） |
| 2段目の後の検証 | — | 下の決定表。不整合は棄却（`invalid_decision`＋理由コード）。候補から対象を補わない |

`focus` の候補（問題の種類：視覚＝referent/part/contour/orientation/position/construal、名称＝name、その他＝question/progress）

| 行動 | 図形対象 | 候補の組 |
| --- | --- | --- |
| repair/confirm | single/multiple | （視覚issue, 範囲内の特徴）、（名称issue・その他issue, 特徴なし）、（`no_issue`, 範囲内の特徴）。issueは図形候補が空か図形対象と交わるものだけ（交わらないissueは候補に出さない） |
| repair/confirm | none | （issue, 特徴なし）［種類を問わない］、`no_issue`、`unselectable` |
| defer | 任意 | （issue）、`no_issue`、`unselectable`。issueは図形対象が空でなければ図形候補が空か交わるもの |
| revisit | 任意 | （保留中のissue）、`no_issue`、`unselectable`。保留中＝focusが `deferred` のもの |

決定表（2段目の後）

| 行動 | 図形対象 | focus | 結果 | ledger・旧Judgment |
| --- | --- | --- | --- | --- |
| repair/confirm | none | issue | 受理 | 変えない。旧 `validateJudgment` を通さない |
| repair/confirm | none | `no_issue` | 棄却 `repair_basis_required` | — |
| repair/confirm | none | `unselectable` | 棄却 `repair_issue_unselectable` | — |
| repair/confirm | single | 視覚issue＋特徴／`no_issue`＋特徴 | 受理（現行と同等） | 下のC5 |
| repair/confirm | single | 名称・その他issue（特徴なし） | 受理 | 名称・状態を変えない |
| repair/confirm | multiple | 上と同じ組 | 受理（現行のmultipleFeatureと同様） | 変えない |
| defer | 任意 | issue | 受理。そのissueのfocusを `deferred` に | 変えない（図形全体の名称をdeferredにしない） |
| defer | 任意 | `no_issue`/`unselectable` | 受理（特定のissueを保留したとは記録しない。一般的な保留として記録） | 変えない |
| revisit | 任意 | 保留中のissue | 受理 | 変えない |
| revisit | 任意 | `no_issue`/`unselectable` | 棄却 `revisit_basis_required`（具体的な対象のない再訪を実施済みにしない） | — |
| 全行動 | 任意 | issueの図形候補が空でなく図形対象と交わらない | 候補に出ない。万一返れば棄却 `issue_target_conflict` | — |

- 1回の判断の呼び出しは最大2回のまま（defer/revisitは `focus` のために2段目を使う）。
- 候補の組の数は既存の上限（255）を使い、超える場合は黙って省略せず入力エラーとする（現行と同じ）。候補issueの数の上限が必要なら工学的設定として記録する。
- 代わりの行動をどう選ぶか（棄却後）は既存の未決事項のまま。

### C3 局所の発話機能

- 既存のact集合で表せるもの：自分の名称提案の撤回＝`withdraw`（aspect=name）、相手の名称提案の拒否＝`name_reject`（相手の先行提案が必須）。
- 合意済み・提案済み名称の再検討（「やっぱり別の名前にしない？」）、見立ての違いの表明（否定ではない併存）は、既存の `revisit`（保留が前提）や `deny` に押し込めない。新しいactを加えるかは、先行文脈・話者・対象・効果・unknownを示した定義表を研究者が確認してから決める（**未決**）。本設計の実装範囲では新しいactを加えず、該当場面は `unknown` を許容する。
- 「名付けをやめたい」の機能を一つに決め打ちしない。先行提案があるか、誰の提案か、合意済みかで変わる。

### C4 空targetの応答

- 局所検証（`verify.ts`）と保存時検証（`reference-graph.mjs`）が、図形候補が空のclaimへの応答を拒否している。両方を、「応答側も空、または応答先の候補に含まれる」場合に受理するよう揃える。
- 応答者の話者権限の検査（現行は人間固定）を、AI側の抽出経路でも対称に適用する。
- 図形未特定の名前を受諾しても、単一図形の `agreed` に変換しない（最終的な図形‐名称対応の採点とは別）。

### C5 旧Judgment・ledgerへの影響（R3改訂）

- Jev経路では、`repair`/`confirm`/`defer`/`revisit` の判断が**ledger（図形‐名称の作業状態）の名称と状態を変えない**（opt-inの引数。旧経路の既定は変えない）。ledgerを変えるのは、`propose_name`（名称を仮に置く）と `agree`（公開の名称提案への同意の検証を通過したもの）だけとする。名称に関する修復・確認で名称を変えたい場合も、その変更は後の `propose_name`/`agree` と局所claim（撤回・拒否）で表す。
- 根拠：ledgerは `finalRequest`（最終提出）の入力になる（`v2/jev-turn.ts:414`）。非公開の計画だけで最終提出の名称が消えたり保留になったりするのを防ぐ。
- ledgerは「AIの非公開の計画から更新された作業状態」であり、公開の合意（局所claimの名称状態）とは別であることを記録に明示する。最終提出にどちらを使うかの見直しは研究者判断（OPEN）。

### C6 修復の進展（R3改訂）

- 修復エントリの `issueId` は、`focus` で選ばれたissue。issueが無い（`no_issue`）なら `null` のまま（現行の「同じ図形の最後のclaim」は流用しない）。
- 修復の「問い」は、そのAIターンの公開AI claimのうち、選ばれたissueに属する、または選ばれたissueのclaimに応答するもの（issueが `null` なら、図形対象の候補を持つ ask/assert のAI claim）に限る。該当が無ければ進展は `unknown`。
- 進展の値を記述的に分ける：`candidates_narrowed`（候補の図形が絞られた、構造的）／`new_claims_lexical`（文字列上の新しい内容がある。**意味的な新情報であるとは判定していない**）／`no_new_claims`／`unknown`（公開の問いが無い・抽出未完了・判定不能）／`not_operationalized`（図形未特定の名前・進行の問題。SSOTの定義の適用が未決）。現行の `changed` は `candidates_narrowed` と `new_claims_lexical` に分け、Jevへの説明にも「文字列上の差であり意味的進展の判定ではない」と書く（両条件同一）。`unknown`・`not_operationalized` を停滞に数えない。
- 意味的な新規性の判定方法、図形未特定の問題の進展の定義は**研究者判断（OPEN）**。評価では独立の事後注釈で照合する。

## D. 評価の3層（F1/F3/F4/F5/F8）

詳細とoracle一覧は[評価仕様](../runtime/diagnostics/jev-decision-eval/SPEC-v2.md)に置く。要点：

1. **配線・エラーパス層**（ローカルHTTP模擬、決定的）：停止・失敗・未公開・fail closedの経路。注入した不正応答を棄却することが期待される試験は、棄却成功を合格にできる。
2. **意味的妥当性層**：
   - 2a 局所検証器の単体検証（分類ラベルを与え、状態更新が規則どおりかを見る）。
   - 2b 固定公開履歴のリプレイ（AI発話も台本で固定した公開履歴を、実際の抽出・検証経路で処理する。oracleのclaim/issue/targetを初期状態として注入しない。評価用ハーネスの入力に限り、実運用の指示文には入れない）。
   - 2c 自由生成のlive（前提条件付きoracle。前提は公開prefixから独立に判定する）。
3. **機能カバレッジ層**：経路ごとに `not_observed`（未選択）/ `wiring_failed`（選択されたが送信・記録されない）/ `mock_demonstrated` / `live_demonstrated` を報告。自由liveで起きないことからJevの意味誤りを断定しない。機能の実証がないときに機能完成を主張しない。

結果の区分：`pass` / `fail` / `not_evaluable`（前提不成立、理由付き）/ `precondition_undetermined` / `not_reached`（段・試行ごと）/ `not_measured` / `error`。総合状態は、予定・試行・到達・評価可能・合格・不合格・未評価の件数を分母とともに示し、`fail` が一つでもあれば不合格、評価済みが0件なら「意味的証拠なし」とし合格にしない。導入に必要な件数・割合は研究者判断。

## 研究条件（変更しない）

- 2条件で、AI側画像・観察メモ・指示文・抽出/意味確認/推定の入力と処理を同じ局面・同じ公開prefixで一致させる。行動が分かれた後の履歴の一致は求めない。
- 初回観察は図形セット別キャッシュ、再観察・claim・対話履歴は対話別。
- 行動はJevが単独で選ぶ。Lunaは観察・抽出候補・文章化だけ。スコアは未校正。
- 本設計で追加する呼び出し（AI発話の抽出、意味確認、実現診断）は両条件で同じものを使い、遅延・費用を測定する。

## 研究者の判断が必要な事項（本設計では決めない）

1. 新しい局所act（名称の再検討、見立ての違いの表明など）の採否と定義。
2. 図形未特定の問題（名前・進行）に対する修復の進展の操作化。
3. 曖昧な相槌の応答先の範囲（B5）。
4. 評価で導入を承認するのに必要な件数・割合。
5. 既存の未決事項（P5の抑制、棄却後の代わりの行動、停滞後の行動、再観察の条件、閾値）。
6. 置換・訂正（supersedes/correctionOf）と名称状態の遷移（第2段階）。
7. 最終提出に、計画由来のledgerと公開claim由来の名称状態のどちらを使うか。
8. 意味的な新規性（修復の進展）の判定方法。

## 実装の分担案（Astraの事前承認後）

| 担当 | 範囲 | 主なファイル |
| --- | --- | --- |
| Sol-1 | A：AI発話の抽出・意味確認・実現診断・aiExtraction記録 | `local-grounding/extract.ts`・`classify.ts`・`verify.ts`（`recordAiClaims` 置換）・`v2/jev-turn.ts` の該当部 |
| Sol-2 | B：dependsOn/supersedes/correctionOf、導出ビュー、相槌規則、永続イベント記録 | `local-grounding/derive.ts`・`contract.ts`・`memory/reference-graph.mjs` |
| Sol-3 | C：問題参照の問い・組合せ検証・空target応答・ledger保持・修復履歴 | `decision/*`・`judgment/schema.mjs`（opt-in）・`v2/jev-turn.ts` の該当部 |
| Sol-4 | D：評価仕様のハーネス（新しいcases/gate、旧ゲートは保存） | `diagnostics/jev-decision-eval/*-v2.ts` |

ファイルの重なり（`jev-turn.ts`、`verify.ts`）はORRERYのファイル予約と統合順（B→A→C→D）で調整する。
