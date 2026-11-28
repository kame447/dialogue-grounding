# 回転別観察メモの独立監査（D）2026-11-28

担当: AquaGauss（claude-sonnet-5-5）。実装担当（B1・B2・C・A0）と同系統のモデルによる独立監査で、異種モデルの比較ではない。Sol（Codex）の独立監査（QuietHubble: プロンプト、SandyCurie: データ・境界）は別。所見は統括 BalmyDarwin へ ORRERY Mail で送り、このファイルは補助（再現手順と状況）である。基点は `75c66cc`、契約は private-runs の `CONTRACT.md`。

## 1. 契約の監査（第1報 mail 23461）と統括の決定

| ID | 内容 | 決定 |
|---|---|---|
| D-C1 | main への merge が自動で本番反映（`.github/workflows/deploy-tangram.yml`）。回転別メモに on/off が無い | on/off は足さない。統合 PR は研究者の最終確認まで merge しない（draft）。D は旧 pin の受付の計画・記録・組立プロンプト・観察キャッシュ鍵が main とバイト同一であることを試験する |
| D-C2 | 復元が保存済みの投影か再投影か未定義。pin と束の不一致で止まる恐れ | 採用。投影結果と sha256 を試行の記録に保存し、冷復元は保存分だけを使う。不一致でも止めず、使ったハッシュを記録する |
| D-C3 | 回転条件の文（`ROTATION_V5` 系）と回転別メモの説明の分離 | 採用。回転別メモの部分は3つの回転方式でバイト同一。回転条件の文は新版でも残す |
| D-C4 | 予算の「既存の上限」が未定義 | 3. の実測を受けて層を分ける（Jev は名詞の層、生成・抽出は詳しい層） |
| D-C5 | #262 の Terra 見立てと回転別メモの二重。`ownParts` が観察キャッシュ鍵を変える | 採用。新 pin の見立ての出所は回転別メモだけ。受付承認時の初回観察はしない。旧 pin・旧 #262 には `ownParts` を付けない |

## 2. B2 の merge コミット `471a11b` の監査（ブロッカー0）

自分の別 worktree（detached）に取り出して検査した（B2 の木は触らない）。

- 旧版のバイトは不変: `rotation-legacy-bytes`・`rotation-90-180-270-jev`・`jev-decision-legacy-freeze`・`v23-generation-prompt`・`s4-prompt-versions`・`prepared-observation-recipe/provenance`・`observation-cache/observe` の77件が合格。
- 旧受付の観察キャッシュ鍵: 3回転方式 × {legacy6, pilot4, custom3} × seed 4つ = 36通りで、Worker の初回観察鍵3種とローカルのキャッシュ鍵が 75c66cc と同一。固定試験は `tests/rotation-memory-audit-old-keys.test.ts`（期待値 `tests/fixtures/rotation-memory-audit/old-path-keys-75c66cc.json` は基点から一度だけ生成。作り直さない）。他の木の検査: `AUDIT_REPO_ROOT=<worktree> node --test tests/rotation-memory-audit-old-keys.test.ts`（読み取りだけ）。
- `jev-decision.ts` の差分は `v5Suffix` の改名（`v5LegacySuffix`）と、部分幾何があるときだけ `PART_INDEX_INSTRUCTIONS` を足す分岐だけ。`rotationPremise` は未変更。
- `tests/s4-rotation-mode.test.ts` の8件失敗は S4 の指示の出所の登録だけが原因（`promptSourceManifest()` が16→21ファイルになり `PROMPT_VERSIONS` のどの版にも一致せず、`promptVersion()` が null。`intervention-records.ts` の 2951 行付近と 3485 行付近）。バイトの後退ではない。統合の最後に確定のソースで1回だけ登録し直す。

## 3. D-C4 基点の実測（75c66cc）

### 3.1 硬い上限と失敗の形
- Jev の判断（human_referent・decision・target・detail・prospect）の `state` は 20,000 字（`jev-decision.ts` の `over()`、予約 ≈ 150 字）。固定の削り順（repairHistory→4 / reobservations→1 / claims→16 / publicTurns→16 / observation 細部 / …）の外の項目は縮められず、最後に `fail("invalid_input")` で判断の要求が失敗する（新しい停止の経路）。
- 生成・抽出・観察の memo は `observationContextMessages` が 19,000 字ごとに分割する（1 message ≤ 20,000 字は proxy の `MAX_TEXT_CHARS`、message 数 ≤ 256、抽出の state ≤ 192,000 字）。失敗ではなくトークン・遅延・利用量の問題になる。
- memo を含む呼び出しは1 AI 手番あたり約10回（Jev POST 約7、局所抽出・AI 抽出・生成）。memo が +1,000 字なら1手番で約 +10,000 字。

### 3.2 現行の memo と Jev state
- 現行の初回 memo の実サイズ（2026-11-20 の実記録80件。字数だけ測り、内容は写していない）: 6図形で全体 2,577〜3,515 字（中央 3,298）、1図形 388〜621 字（中央 536）。
- Jev state の字数（`tests/support/rotation-memory-audit-measure-jev-state.mjs`。合成の対話、memo 540 字/図形。ストレスは発話 ×2・claim ×3）:

| 図形数 | AI 4手番 | 8 | 13 | 24 | 32 |
|---|---|---|---|---|---|
| 3（典型） | 3,707 | 4,759 | 6,148 | 9,060 | 11,240 |
| 4（典型） | 4,373 | 5,424 | 6,813 | 9,725 | 11,905 |
| 6（典型） | 5,705 | 6,754 | 8,143 | 11,055 | 13,235 |
| 3（ストレス） | 5,506 | 8,077 | 11,383 | 18,475 | invalid_input |
| 4（ストレス） | 6,172 | 8,742 | 12,048 | 19,140 | invalid_input |
| 6（ストレス） | 7,504 | 10,072 | 13,378 | 19,818（claim 6件を省略） | invalid_input |

24 AI 手番の典型の余白は 3/4/6図形で約 10.9k / 10.3k / 8.9k 字。ストレスは悲観的な仮定だが、余白が小さい対話では回転別メモの字数がそのまま失敗の手前を縮める。

### 3.3 回転別メモの描画サイズの見積もり（`tests/support/rotation-memory-audit-measure-render.mjs`）
実データ（consensus-120 と part-construal-468）の全4方向、候補の名詞は全て残す。形式は B1 のものではなくサイズ感。

| 描画 | 1図形 最小/中央/最大 | 最悪の組 3/4/6図形の合計 |
|---|---|---|
| 名詞だけ | 155 / 202 / 277 | 827 / 1,100 / 1,612 |
| ＋全体の役割 | 231 / 414 / 674 | 1,863 / 2,419 / 3,506 |
| ＋姿勢・向き・確信度・owner | 465 / 836 / 1,413 | 3,793 / 4,891 / 7,041 |

### 3.4 提案（D）と統括の決定
Jev の state には名詞の層だけ（最悪の組で 3/4/6図形 ≤ 約 0.9k / 1.2k / 1.7k 字）、詳しい層（役割・姿勢・向き）は生成と抽出の memo にだけ。ブロックの上限を固定した上で Jev の削り順に組み込むか `reserve` に加算し、最悪の6図形の組（F15/F1/F19/F23/F13/F27）＋長い履歴でも `invalid_input` が出ないことを構成上示す。

## 4. 試験の状況（2026-11-28 19:35 時点）

試験は `exp/AquaGauss` の `tests/rotation-memory-audit-*.test.ts`（7ファイル）。統合ブランチでは `AUDIT_REQUIRE_ROTATION_MEMORY=1` を付け、B1・B2・C のコードか元データが無ければ失敗にする（付けない木では該当の試験を skip する）。C の 36802c9（B2 の 3c8fa0e・B1 の cd7f326 を含む）で 8 ファイル 25 件すべて合格（B2-F1 は 31b1d72 で解消）。

| 項目 | 状況（コミット） |
|---|---|
| 旧受付の観察キャッシュ鍵（36通り） | 済（`a7c1966`。基点・B2 の 471a11b/3c8fa0e・C の 2bc86ee で一致） |
| 旧受付の承認済み記録（plan 含む、46通り。拒否も同じ） | 済（`af9d11c`。基点・B2 の eb9dfc7/3c8fa0e で一致。許す差は新規受付の `rotationMemory` の pin 3キーだけ） |
| 旧版のバイト（旧 Jev 要求・回転条件文・旧生成指示） | 既存の試験（rotation-legacy-bytes ほか）。B2 の 471a11b で77/77 |
| 120方向・468領域・領域ID/members・未合意3領域・全方向なしの合成 | 済（`7be915d`） |
| 回転の向き（実際の提示で時計回り r 度） | 済（`7be915d`。逆向きなら不一致を検出） |
| 投影の全件照合（現在・相対90/180/270・確信度の印・wholeAnywhere・プライバシー・決定性） | 済（`7be915d`） |
| 3/4/6図形の予算: Jev の state が回転別メモで `invalid_input` にならない | 済（`4ff6b3c`。基点で通る条件は全て通る。増分の最大 +1,454/+1,833/+2,540 字） |
| 回転別メモの部分が3回転方式でバイト同一・課題条件の文が重ならない | 済（`f1c35cb`） |
| 生成へ渡る特徴の文言に領域IDが無い（P-3） | 済（`5b15d85`。B1 の cd7f326 で解消） |
| 新 pin: 承認→開始→冷復元が準備待ちに入らない・claim ゼロ・初回 API ゼロ | SandyCurie が先に確認。B2 の 3c8fa0e の自身の試験（13件＋Worker統合2件）を D の木で再実行して合格 |
| 新 pin のモデル入力に旧テンプレートの見立てが無い（F6@0・F15@270#P3） | 済（`600869b`。B2＋C の合成の木で合格） |
| 特徴の候補にメモの定型のプレースホルダが並ばない（B2-F1） | 済（`3075916`。C の 31b1d72 で解消） |
| 両方略で生成・抽出の回転別メモの部分がバイト同一 | 未（Jev の呼び出しは方略に依らず同一入力。生成・抽出は C の純関数の層で方略の入力を持たない） |
| 層ごとの最悪値（nouns 1.1k/1.5k/2.2k、roles 3.5k/4.6k/6.8k、full 4.2k/5.5k/8.1k の 3/4/6図形） | 実測済み（2bc86ee）。固定の試験は B1・C の層の関数が確定した後 |
| 冷復元は保存分だけ・pin と束の不一致で止まらない | SandyCurie が確認。B2 の Worker 統合2件でも確認 |
| プロンプト整理の監査 | 2bc86ee で P-1・P-2・P-3 解消を確認。**残り: G-1（生成の凡例と指示の「回した見え方の向きの語」の重複）・G-2=P-4（prospect の前置き4文が3回）は C の次のコミット待ち**、G-3（抽出の層を nouns＋最小の regions へ）は統括の判断で C が模擬対話で確認、G-4（「一、二個」の数の制約）は C の判断 |
| 自然な日本語の発話（実 API の短い試験。模擬とは別） | 済（02aae4e の生成の要求 8回、`gpt-6-luna`。下の 6.） |

## 6. 実 API の短い試験（模擬とは別。統括の許可 mail 23527）と S4 の独立確認

- **実 API の試験**: 統合ブランチ head 02aae4e の実際の v24 パイプラインを模擬の上流で走らせて捕捉した生成の要求（新 pin・回転別メモあり・3図形・`postGenerationCheck: 'off'`）を、研究用 proxy（`purpose: dialogue_turn`、`gpt-6-luna`）へ1回ずつ、計8回（6場面＋両方略の差の2回）。失敗0・再試行0・入力 約6.5k字・所要 2.3〜5.4秒。要求・応答は private-runs 配下（0700/0600）で、リポジトリには入れていない。評価者は Sonnet 5.5（実装担当と同系統）。
- 自動検査（8件）: 角度の数値・領域ID・内部語・相手の向きの断定・同一図形/合意の断定・質問は0件。現在向きに見立てがあれば優先（a）、なければ初手から別の向きを「向きを変えて見ると」で使う（b・f）、相手の説明から別の向きに気づく（d）、全方向で全体なしでも部分を使う（e）。方略の差で使い方は変わらない（b・d の2組）。
- 所見（非ブロッキング）: 「見立て」の語が口語に写り少し硬い（N-1）、否定の後（c）は別の向きに移らず形の描写になった（N-2。1回のみ）、「こちらでも向きを変えて見ると〜」が図形の一致を匂わせ得る（N-3。研究者の確認事項）。
- **S4 の独立確認**: 36802c9 の木で S4 関連20ファイルを流すと 289 件中 84 件が失敗。scratch の木で現在の `promptSourceManifest()` の結果を新しい版として `PROMPT_VERSIONS` に足し（`fixed`・`native` は直近の版のものを流用）、同じ20ファイルを流すと **289/289 合格**。失敗は全て「指示の出所が未登録」だけで、旧版の文面・検証の挙動の回帰は混ざっていない。再登録の手順: `promptSourceManifest()` に新しい静的テキストのファイルを加え、確定のソースの指紋で版を足し、`rotation` を持つ要求の写しを `native` に足し、failure-path の fixture を一度だけ取り直す。

- **実 API の追試（c×3・f×1、OFF、C の 900cbd8＋B2 の a84f75c）**: 4回・失敗0。自動検査は0件（角度の数値・領域ID・内部語・相手の向きの断定・同一図形/合意の断定・質問）。否定の後（c）は3回中1回が「向きを変えて見ると〜」で別の向きを使い、他は今の向きの根拠の言い直し（TASK の「使ってよい」の範囲）。「見立て」の語は f の1回に残った（N-1 は母数が小さく有意な改善とは言えない。新しい禁止の文は足さない方針なので現状で許容、研究者の確認事項）。
- **`postGenerationCheck: 'on'` の観察の出所**（QuietHubble の指摘1）: 生成（roles 層）の path `rotation/turned/1/whole/0` と抽出（nouns 層）の `rotation/turned/1/view` を受け付け、同じ候補なら一致、同じ向きの別候補・別の向き・候補を名指さない引用は不一致にする（候補の単位。B2 の修正）。独立試験 `tests/rotation-memory-audit-source-paths.test.ts`（`e47df99`・`446c779`）。C の 900cbd8 だけでは失敗し、B2 の候補単位の修正で合格する。
- **A0（確認ページ）の独立確認**: 稼働中の状態の写し（revision 50、確認済み1・未確認119）で、実際の `server.ts` と反映スクリプトを使って確認。起動・GET で状態ファイルは不変、旧い画面の保存は `results`・`currentId` を保つ、独立部分と全体の反映は dry-run で書かず、実行後 `results`・`currentId`・確認済みは不変、F1@0 は「確認済み」・自由文のまま「要照合」の印だけが付く、2回目は変更なし。稼働中のサーバーと本物の状態ファイルには触れていない。

## 5. 再現手順
- 旧鍵・旧受付の記録: `node --test tests/rotation-memory-audit-old-keys.test.ts tests/rotation-memory-audit-old-plans.test.ts`（他の木は `AUDIT_REPO_ROOT=<worktree>`、読み取りだけ）。
- 投影・幾何・予算・回転方式・領域ID: `AUDIT_REPO_ROOT=<B1・C の変更を取り込んだ木> AUDIT_DATA_DIR=<consensus-120.json などの置き場（統合ブランチでは不要）> AUDIT_REQUIRE_ROTATION_MEMORY=1 node --test tests/rotation-memory-audit-projection.test.ts tests/rotation-memory-audit-budget.test.ts tests/rotation-memory-audit-modes.test.ts tests/rotation-memory-audit-region-id.test.ts`。B1 の木と C の木が別なら `AUDIT_MEMORY_ROOT=<B1 の木>`。
- Jev state の実測: `node tests/support/rotation-memory-audit-measure-jev-state.mjs [<repo root>]`。
- 描画サイズ: `git show 4e09b62:docs/review/construal-consensus-20261128/consensus-120.json`、`git show 1c5fd3e:docs/review/part-construal-20261128/part-construal-468.json` を取り出して `node tests/support/rotation-memory-audit-measure-render.mjs <consensus> <part>`。
- node: `export PATH="/Users/Shogo/.local/share/fnm/aliases/default/bin:$PATH"`（v24）。zsh では変数を単語分割しない（`files=(…)` の配列で渡す）。
- 他の担当の成果を検査するときは、`git worktree add --detach <自分の領域> <SHA>` で自分の木に取り出し、他の担当の木には書かない。
