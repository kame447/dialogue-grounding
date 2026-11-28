# 回転別観察メモ120方向の見立て合議（2026-11-28）

研究者の依頼により、回転別観察メモ120方向（30図形×0/90/180/270度）の全体・部分の見立てを、Claude Opus 5.5 と GPT-6.1 Terra（effort ultra）が実画像から独立に観察し、照合して決めた合議案。**AIによる案であり、研究者の確認前で、正解名称ではない。** 実験runtime、参加者画面、本番、既存試行には反映していない。新しい停止経路は設けていない。確定済みの分割（全30図形・117領域）と、形・面積・位置・接続の幾何情報は変更していない。

## 基準

- コードとデータ: commit `4307078`。確認画面（http://127.0.0.1:5498）を配信している `/Users/Shogo/Developer/dialogue-grounding-part-observation-20261128` と、関係するファイル（`server.ts`、`client.js`、`index.html`、`concrete-construal-draft.json`、`apply-concrete-draft.ts`、`primary-regions-data.ts`、`review-results-final.json`）のハッシュが一致することを確認した。
- catalog revision `review-final-dae9359580d64a83`。`review-results-final.json` の全30図形（117領域、すべて確認済み）と、`primary-regions-data.ts` の120方向の領域構成（構成片）が全方向で一致することを確認した。

## 手順

1. **画像の作成**（`render-observation-images.ts`）。catalog から幾何情報（輪郭・重心・面積・形名・接続）だけを読み、旧案の見立て文は読まない。無地のシルエットは実験の描画関数（`dialogue-model/runtime/stimuli/render.mjs` の `renderPolygons`）で白地に黒、内部の境界なしで描く。主要領域の画像は確認画面と同じ5色で塗り分け、内部の境界だけを白線で分け、重心に P1〜Pn を記す。全図形で縮尺は共通（最大辺540単位）。出力は方向ごとの480×480画像240枚、Opus用の6枚組（1200×800、実験画面と同じ2段3列）20組、Terra用の4フォルダ（各30項目）と、全ファイルの SHA-256 を記した manifest。画像はリポジトリ外（下記の作業用ディレクトリ）に置いた。
2. **第1ラウンド：独立観察**。
   - Terra 4体（`gpt-6.1-terra`、effort `ultra`、ORRERY の正規 delegate で起動）: FrostyGauss（a）、RainyPascal（b）、SturdyLangmuir（c）、CherryLavoisier（d）。1フォルダが1つの回転角の30図形で、各観察者は各図形を1方向だけ見る。項目番号は無作為な順で、図形IDと回転角は伏せた。シルエットを先に見て全体の見立てを考え、次に色分け画像で P ID ごとの役割と根拠・反証を書く。候補は0〜3件。上位分類（動物・鳥・道具・塊など）は不可、無理な具体化はせず「見立てなし」を許す。
   - Opus（統括の CherryCurie、`claude-opus-5-5`、effort max）: 6枚組20組を無作為な順（同じ図形の別方向が同じ組・隣の組に入らない順）で見て、同じ形式で記録した。後述の変更までに48方向を記録した。
3. **研究者の追加指示による変更**（14:27、dashboard の `+ NEW AGENT` で起動）。Opus 側も4体（CalmFermi a、GoldNewton b、CreamMaxwell c、DapperEinstein d。いずれも `claude-opus-5-5`、effort max）に分け、同じ担当の Terra と直接合議する。統括の記録済み36方向（a10・b10・c8・d8）は割当の正本 `logs/assignment.json` で再利用し、残り84方向は各 Opus が独立に観察した。統括は以降の逐次観察をやめ、統合と品質確認に専念した。統括の残り12方向の記録は割当に含めず、品質確認の照合にだけ使った。
4. **第2ラウンド：同じ担当の Opus と Terra の合議**。各 Opus は自分の独立結果を保存してから、親の再利用分と Terra の独立結果を読み、ORRERY Mail で Terra に争点とレビューを依頼した。Terra は反論・支持・修正案を `round2-crossreview.json` に返し、双方で再観察して合意案を作った。結果は各担当の `paired-consensus.json`（全30項目、両者の独立回答、合意候補、合意状態、採否の理由）。
5. **統合と品質確認**（`integrate-consensus.ts`）。4組の結果を図形・方向のIDへ対応させ、120方向がそろうこと、各候補が全 P ID を確定 catalog の ID のとおりに持つこと、候補が3件以内であること、見立てなしと候補の有無の整合、上位分類の名詞が無いことを機械検証した。統合規則は次のとおり。
   - `合意`・`一部合意`: 双方が支持した候補だけを採用する。片方だけの候補は `discussion` に残す。
   - `未合意`: 候補を採用せず「見立てなし（未合意）」とし、双方の案を `discussion` に残す。
   - 双方が見立てなしと判断した方向は `合意` の見立てなし。
   その後、統括が120方向すべてをシルエットと色分け画像で確認し、名詞の具体性、部分の役割と位置・形の対応、向きの記述を点検した。
6. **確認画面への反映**（`apply-consensus-to-review.ts`）。反映前に状態と書き出しJSONを退避し、未確認・メモなしで、旧AI案（catalog の初期案、または `apply-concrete-draft.ts` が書いた第2案）と完全に一致する行だけを置き換える。研究者が確認済み・要修正にした行、編集した行、メモ、部分の「形・位置の説明」（幾何から生成した文）、現在位置（currentId）は保持する。保存時に revision が変わっていれば上書きせず、最新状態を読み直して変更行を報告して止まる。
7. **検証**。下記「検証」を参照。

## 独立性の確保

- どの観察者にも旧案（`concrete-construal-draft.json`、catalog の見立て文、`part-construal-hypotheses.json`、`whole-construal-hypotheses.json`、確認画面の状態）を見せていない。Terra の作業ディレクトリはリポジトリ外に置き、作業ディレクトリ以外のファイル、既存リポジトリ、確認画面、ウェブ検索を禁止した。
- 第1ラウンドの各結果は、他者の結果を読む前に SHA-256 を記録した（`logs/sha256.json` と下記の値）。Terra の完了報告には見立ての内容を書かせず、パスと件数だけにした。
- Opus 4体は、自分の第1段階を保存するまで親の記録・Terra の結果・対応表を読まない手順で作業した（逸脱は下記）。

第1ラウンドの SHA-256（他者の結果を読む前に記録）:

| 記録 | SHA-256（先頭16桁） | 記録時刻（UTC） |
|---|---|---|
| Terra a・b・c・d の `round1-observations.json` | `dfa3edc4f9082be9`・`f556015d30c9583f`・`d725edb1b472c3a8`・`f1169b05b6e6b1ec` | 05:23 |
| 統括（CherryCurie）の独立記録48方向 `opus-parent-round1.jsonl` | `e766d87ce94f82f1` | 05:28 |
| Opus a・b・c・d の `round1-independent.json` | `c040276d16dfad8c`・`5eea5f1c21965a02`・`11b2b4c9a31a932b`・`02ef764b6cc0358f` | 05:49〜05:55 |

## 結果

担当と回転角の対応: a=270度、b=180度、c=90度、d=0度。

| 担当（Opus × Terra） | 合意 | 一部合意 | 未合意 | 見立てなし | 採用候補 |
|---|---|---|---|---|---|
| a（CalmFermi × FrostyGauss） | 26 | 3 | 1 | 13 | 22 |
| b（GoldNewton × RainyPascal） | 29 | 1 | 0 | 9 | 24 |
| c（CreamMaxwell × SturdyLangmuir） | 25 | 5 | 0 | 10 | 27 |
| d（DapperEinstein × CherryLavoisier） | 29 | 1 | 0 | 8 | 26 |
| 計 | 109 | 10 | 1 | 40 | 99 |

- 見立てありは80方向（採用候補99件、確信度は中16・低83）。見立てなしは40方向で、うち39は双方が見立てなしと判断した合意、1方向（F9@270）は未合意。
- 未合意の F9@270 は、Opus 側の拳銃・ハチドリ（いずれも低）に対し Terra が見立てなしを維持した。
- 同じ名詞が複数の方向に付く。ハト6、カモ・リス・人・犬・キツネ各5、ウサギ・猫各4、金魚・ニワトリ各3など。鳥の種名の根拠は弱く、図形を区別する目的には使いにくい（各ペアも同旨を記録）。
- 全方向の候補・部分の対応・根拠・弱点・合議の経過は `consensus-120.json` と `consensus-120.md` にある。

## 品質確認（統括）

統括が120方向すべてを、シルエットと色分け画像で各ペアの結果と照合した（`qa-120.json`）。結果は「整合」97、「注記」23で、合議の結論を統括が変更した方向はない。注記の主な内容:

- 合議中に新しく出た候補、または見立てなしから候補へ移った項目（例: F27@180 のツバメ、F15@0 のカエデの葉、F3@0 の走っている人、F4@180 のリス、F6@180 のウサギ）。画像との整合は確認したが、説得による影響の可能性を残す。
- 統括の割当外の観察（12方向）と結論が違う項目（例: F9@180 は統括が帆船・中、ペアは船体と帆のずれで見立てなし）。
- 親（統括）の独立回答が見立てなしで、ペアがエンゼルフィッシュ（低）で合意した F28@90。ペアは親の判断を優先する余地を示したが、統括は合意を保持した。
- 例示語との重なり（下記「手順からの逸脱と制約」）と、同じ種名の繰り返し。

## 確認画面への反映

- 反映前: revision 37（2026-11-28T04:56:13Z 保存）、現在位置 F5@0、確認済み1（F1@0）、未確認119。未確認119行はすべてメモなしで、`apply-concrete-draft.ts` の第2案と完全に一致していた。
- 反映後: revision 38。119行の全体の見立て・根拠・部分の見立てを合議案に置き換えた。確認状態（すべて未確認のまま）、メモ、部分の「形・位置の説明」、現在位置 F5@0、研究者が確認済みにした F1@0 の内容は変えていない。分割・面積・形・位置・接続・位置関係の値は、反映前後の書き出しJSONで全方向一致を確認した。
- 見立てなしの方向は全体の見立てを「見立てなし」または「見立てなし（未合意）」とし、根拠に理由を書き、部分の見立てを空欄にした。
- 退避先（リポジトリ外）: `/Users/Shogo/Research/dialogue-grounding/private-runs/2026-11-28-construal-consensus-CherryCurie/review-backups/` の `apply-*` に、反映前の状態（API と状態ファイルの写し）、反映前後の書き出しJSON、計画、反映後の状態。サーバー自身の `review-state.previous.json` も revision 37 を保持している。
- 確認画面を開いたままのブラウザは古い revision を持つ。次に保存しようとするとサーバーは上書きを拒否し、画面に退避と再読み込みの案内が出る。続けて確認する前に再読み込みが必要。

## 検証

- `node --test docs/review/construal-consensus-20261128/apply-consensus-to-review.test.ts`: 1件成功。実際の `server.ts` を一時ディレクトリと空きポートで起動し、確認済み・要修正・編集済み・メモ付きの行と現在位置を保持すること、未確認で旧案のままの行だけを置き換えること、退避ファイル、書き出し、読み取り後に画面側の保存が入った場合に上書きせず変更行を報告することを確認した。
- 型検査: TypeScript 7.0.2 で `tsconfig.runtime.json` と同じ strict 設定を新しい5つの `.ts` に適用し、エラーなし（`docs/review` は CI の型検査対象外のため一時設定で実施）。
- API と状態ファイルの照合: 反映後の状態ファイルと API が一致し、119行が合議案と完全一致、F1@0 は反映前と完全一致、確認状態とメモに変化なし。
- 実ブラウザ（`verify-review-browser.ts`、playwright-core 1.65.0 の headless Chromium、使い捨てのプロファイル）:
  - 稼働中の画面（http://127.0.0.1:5498）は読み取りだけ。現在位置 F5@0 の表示が保存内容と一致し、「JSONを書き出す」で得たファイルが `/api/export` と一致した。確認の前後で revision は38のまま。
  - 反映後の状態ファイルの写しを別ポートの同じ `server.ts` で開いた画面で、7方向（F12@0、F9@270、F14@0、F28@90、F27@180、F30@90、F1@0）の表示が保存内容と一致し、メモの入力が保存されて再読み込み後も残り、「確認して次へ」で確認済みになり、書き出しJSONに反映されることを確認した。ページエラーなし。稼働中の確認状態を操作で変えないため、保存と確認の操作はこの写しで行った。
  - 証跡（リポジトリ外）: 同じ作業用ディレクトリの `verify-post-update/`（`verify-result.json`、画面写真、書き出しJSON）。反映前にも同じ検証を `verify-pre-update/` で実施した。

## 手順からの逸脱と制約

- 研究者の追加指示（14:27）により、統括の独立観察は48方向で止めた。合議では36方向を再利用し、84方向を Opus 4体が観察した。統括の残り12方向は品質確認の参照だけに使った。
- 統括は同じ図形の4方向を、組を離した無作為な順で見た。そのため統括の観察は方向間で完全には独立していない。Terra と Opus 4体は各図形を1方向だけ見た。
- 例示語: 統括への依頼文に「犬、猫、カワセミ、フライ返し」、Opus 4体の作業指示に「犬、猫、ペンギン、フライ返し」が例として書かれていた。Terra への指示には例を入れていない。合議案のうち例示語と同じ名詞は犬5、猫4、ペンギン1（F1@180）、フライ返し1（F16@90）。F16@90 のフライ返しは Opus 子の独立回答に由来する（Terra の独立回答はシャベル）。
- GoldNewton（b）と DapperEinstein（d）は、第1段階の保存前に作業ディレクトリの `mapping.json`（項目と図形ID・回転角の対応だけで見立ては含まない）を一度開いたと自己申告した。
- CherryLavoisier（d）の書き込みは、起動時の予約が解放されていたため予約ガードに2回止められ、本人の `reserve_files` で取り直して保存した。FrostyGauss（a）と RainyPascal（b）は起動時の予約を前提に第2ラウンドのファイルを書いた（RainyPascal はシェルで書き込み）。ガードの拒否はなかった。
- CalmFermi（a）は Terra の第2ラウンドの後に F2@270 のウサギと F15@270 のキツネへ支持を加え、Terra に通知した。統合の時点で異議は届いていない。
- Terra の各画面に Codex の週間利用上限の残り 6%→5% の表示があった。4体とも両ラウンドを完了した。
- 見立ては形からの仮説で、確信度の多くは低い。確認画面の119方向は未確認のままで、研究者の確認は終わっていない。実験の観察メモ（runtime）への採用は別途の判断が必要。

## ファイル

- `render-observation-images.ts`: 観察用画像の生成（画像はリポジトリ外。`logs/observation-images-manifest.json` に全画像の SHA-256）。
- `integrate-consensus.ts`: 4組の結果の検証と統合、記録の複製。
- `apply-consensus-to-review.ts` と `apply-consensus-to-review.test.ts`: 確認画面への反映とその検証。
- `verify-review-browser.ts`: 実ブラウザでの確認。
- `consensus-120.json`: 120方向の合議案（候補、部分の対応、根拠、弱点、合意状態、双方の独立回答、合議の経過、品質確認）。`consensus-120.md` は読みやすい一覧。
- `qa-120.json`: 統括の品質確認。
- `logs/`: 独立判断と合議の記録。Terra の第1・第2ラウンド、Opus 4体の独立観察と合議依頼・合議結果、統括の独立記録（`opus-parent-round1.jsonl` と組・位置の対応表）、割当、作業指示、ハッシュ（`sha256.json`）。

## 再現

```sh
node docs/review/construal-consensus-20261128/render-observation-images.ts <新しい出力ディレクトリ>
node docs/review/construal-consensus-20261128/integrate-consensus.ts --run <作業用ディレクトリ> --out docs/review/construal-consensus-20261128 --qa <qa-120.json>
node docs/review/construal-consensus-20261128/apply-consensus-to-review.ts --consensus docs/review/construal-consensus-20261128/consensus-120.json --drafts docs/review/orientation-app/concrete-construal-draft.json --backup-dir <新しい退避先> --state-file <review-state.json> [--dry-run]
PLAYWRIGHT_CORE_PATH=<playwright-core> node docs/review/construal-consensus-20261128/verify-review-browser.ts --state-file <review-state.json> --out <新しい証跡ディレクトリ>
node --test docs/review/construal-consensus-20261128/apply-consensus-to-review.test.ts
```

作業用ディレクトリ（リポジトリ外、画像・退避・検証証跡を含む）: `/Users/Shogo/Research/dialogue-grounding/private-runs/2026-11-28-construal-consensus-CherryCurie/`
