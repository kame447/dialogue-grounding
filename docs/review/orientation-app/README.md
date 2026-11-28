# 回転別観察メモ確認
全30図形の確定分割（117主要領域）を維持し、実装側で事前作成済みの0/90/180/270度の120通りの観察メモを人手確認する研究者用ローカル画面。
元図形と確定領域を表示し、角度ごとの全体・部分見立て、根拠、説明文を編集できる。分割・面積・形状・位置座標・隣接情報は読み取り専用。図形・角度ごとに確認状態とメモを保存する。未確認のみを絞り込める。
```sh
node docs/review/orientation-app/server.ts
```
既定URL: http://127.0.0.1:5498/
保存先: ~/Library/Application Support/dialogue-grounding/orientation-review-v1/review-state.json
入力のたびにMacのJSONへ原子的に保存し、直前版を別ファイルに保持する。通信失敗時はブラウザへ一時退避し、競合時に無条件上書きしない。JSONを書き出し・再取り込みできる。データのハッシュが異なる場合は既存結果を上書きしない。出力には各方向の幾何情報と編集後の説明・仮説・確認状態を含める。
元の分割確認結果は変更せず、実験の観察メモへの採用は別途行う。現在の見立てはAIによる未確認の案で、全30図形の分割確定とは区別する。実験runtimeおよび参加者画面は変更しない。
```sh
node --test docs/review/orientation-app/orientation-review.test.ts
```
ブラウザ検証には既存のplaywright-coreとChromiumを指定してbrowser-smoke.mjsを実行する。検証用サーバーとデータは別の一時ディレクトリ・ポートを用いる。

### 具体的な見立ての候補案（第2案）
`concrete-construal-draft.json` は120方向の実際の輪郭と主要領域を参照して作成した具体的な候補（原則2件）と、第1候補に対応する部分の役割。見立ては未確認の仮説であり、別の候補や対象に当てはまらない場合も許す。 `apply-concrete-draft.ts` は元の案から未変更かつ未確認の行だけを確認ページの保存結果へ適用する。既に確認した行、変更した行、メモを付けた行は維持する。既存の確定分割と幾何情報、実験runtimeは変更しない。候補の具体性の改善は、実際の認識の正しさを保証するものではない。

### 独立部分の見立て
全体の見立てとその部分の役割（「全体の見立てでの役割」）とは別に、各領域が単独で、または全体の中の位置・形との関係で何の部分に見えるかを、領域ごとに候補0〜3件（名詞・何の部分か・確信度・根拠の種類・根拠・弱点）と「見立てなし」で持つ。AI案（未確認）・確認済み・編集済み・未作成を枠の色と札で区別する。「確認して次へ」でその方向のAI案が確認済みになり、欄を編集すると編集済みになる。方向の完了は、確認済みかつAI案の未確認が無いこと（進み具合と「未確認のみ」もこの意味）。
- 保存: 状態ファイルのトップレベル `independentParts`（`results` とは別。`schemaVersion` と `sourceSha256` は不変）。旧版の保存内容は読み込み時にメモリ上だけで空の欄を補い、次の保存まで保存ファイルを書き換えない。`independentParts` を送らない旧版の画面・道具の保存は層を変えず、旧版のサーバーを通しても層は保たれる。層が壊れていれば起動を拒否し、空で置き換えない。
- 書き出し: 各部分に `independentPart`（`reviewStatus`: `ai_unreviewed`・`researcher_confirmed`・`researcher_edited`、`candidates`（`rank`・`noun`・`owner`・`basis`・`confidence`・`evidence`・`weaknesses`）、`noCandidate`、`noCandidateReason`、`ai`（`agreementStatus`・`discussion`、AI案が無ければ `null`））とトップに `independentPartSchemaVersion`。名詞が空の下書きの候補は含めない。取り込みはこの形から層を復元し、層を持たない旧版の書き出しは現在の層を保つ。
- AI案の反映: `docs/review/part-construal-20261128/apply-part-construal-to-review.ts`（`--dry-run` あり。確認済み・編集済みの欄、全体の見立て、メモ、現在位置は変えず、保存時に revision が変わっていれば上書きしない）。稼働中のページの切り替えは同じフォルダの `review-page-switch-runbook.md`、切り替え後の確認は `verify-switch.ts`。
```sh
node --test docs/review/orientation-app/independent-part-review.test.ts docs/review/part-construal-20261128/apply-part-construal-to-review.test.ts
```
実ブラウザでの確認は `browser-independent-parts.ts`（headless Chromium・使い捨てプロファイル・空きポートの `server.ts`。稼働中のページには触れない）。`PART_CONSTRUAL` に `part-construal-468.json`、`REVIEW_STATE_COPY` に状態ファイルの**写し**（任意）、`EVIDENCE_DIR` に新しい出力先を指定する。確認の前に `ps` で他の担当のブラウザが動いていないことを確かめ、一系列で実行する。
```sh
PLAYWRIGHT_CORE_PATH=<playwright-core> CHROMIUM_PATH=<chromium> PART_CONSTRUAL=<part-construal-468.json> node docs/review/orientation-app/browser-independent-parts.ts
```

### 全体の見立ての構造化
自由文の全体の見立て（`whole`・`wholeBasis`・「全体の見立てでの役割」）とは別に、方向ごとに候補0〜3件（名詞・姿勢・向き・確信度・その方向の全領域の役割・根拠・弱点）と「見立てなし」を構造化して持つ。研究者の確認後に確認済みの書き出しから束を作り直すため、自由文を解析せずに済ませる層。独立部分の見立てと同じ操作感と状態（AI案・確認済み・編集済み・未作成）で、全体の見立ての欄の下に「全体の見立ての候補」として出る。
- 保存: トップレベル `wholeConstruals`（`schemaVersion: tangram_whole_construal_review_v1`、`rows` は120方向）。独立部分の層と同じ扱い（旧版の保存内容には空の層をメモリ上だけで補い、`wholeConstruals` を送らない旧版の画面・道具の保存は層を変えず、旧版のサーバーを通しても保たれる）。
- 自由文との照合の印 `needsTextCheck`（画面では「自由文と要照合」）: 反映時に自由文が AI 案の文と一致しない行（研究者が手で直した行）に付く。構造化の欄は自動で埋めず、AI 案を未確認の参考として入れるだけ。構造化の後に自由文を編集した行にも付き、構造化の欄を編集するか「確認して次へ」を押すと外れる。
- 書き出し: 各方向（`results[]`）に `wholeConstrual`（`reviewStatus`、`candidates`（`rank`・`noun`・`posture`・`direction`・`confidence`・`parts`（`id`・`role`、領域の並びどおり全領域）・`evidence`・`weaknesses`）、`noConstrual`、`noConstrualReason`、`needsTextCheck`、`ai`（`agreementStatus`・`discussion`、AI案が無ければ `null`））とトップに `wholeConstrualSchemaVersion`。名詞が空の下書きの候補は含めない。取り込みは各方向の `wholeConstrual` から層を復元し、無い方向は現在の層を保つ。
- AI案の反映: `docs/review/part-construal-20261128/apply-whole-construal-to-review.ts`（`--consensus consensus-120.json`、独立部分と同じ安全性と `--dry-run`）。
- 方向の完了＝確認済み、かつ2つの層に「AI案の未確認」も「自由文と要照合」の印も無いこと。
```sh
node --test docs/review/orientation-app/whole-construal-review.test.ts docs/review/part-construal-20261128/apply-whole-construal-to-review.test.ts
```
