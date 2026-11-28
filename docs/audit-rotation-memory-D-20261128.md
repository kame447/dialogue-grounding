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

## 4. 試験の状況（2026-11-28 18:58 時点）

試験は `exp/AquaGauss` の `tests/rotation-memory-audit-*.test.ts`。統合ブランチでは `AUDIT_REQUIRE_ROTATION_MEMORY=1` を付け、B1・C のコードか元データが無ければ失敗にする（付けない木では該当の試験を skip する）。

| 項目 | 状況（コミット） |
|---|---|
| 旧受付の観察キャッシュ鍵（36通り） | 済（`a7c1966`。基点・B2 の 471a11b・C の b896dbc で一致） |
| 旧受付の承認済み記録（plan 含む、46通り。拒否も同じ） | 済（`af9d11c`。基点・B2 の eb9dfc7 で一致。許す差は新規受付の `rotationMemory` の pin 3キーだけ） |
| 旧版のバイト（旧 Jev 要求・回転条件文・旧生成指示） | 既存の試験（rotation-legacy-bytes ほか）で確認。B2 の 471a11b で77/77 |
| 120方向・468領域・領域ID/members の一致・未合意3領域・全方向なしの合成 | 済（`7be915d`。B1 の作業中の木と C の b896dbc で9/9。SandyCurie の集計と一致） |
| 回転の向き（ラベル r の幾何 = 実際の提示で時計回り r 度） | 済（`7be915d`。提示された自側・相手側の重心が確定分割を時計回りに回した幾何と120方向すべてで一致。逆向きなら不一致を検出） |
| 投影の全件照合（現在・相対90/180/270・確信度の印・wholeAnywhere・プライバシー・決定性） | 済（`7be915d`） |
| 3/4/6図形の予算: Jev の state が回転別メモで `invalid_input` にならない | 済（`4ff6b3c`。C の作業中の木と b896dbc で378件、基点で通る条件はすべて通る。増分の最大 +1,454/+1,833/+2,540 字 = 統括の目安より大きい） |
| 回転別メモの部分が3回転方式でバイト同一・課題条件の文が重ならない | 済（`f1c35cb`。C の b896dbc で合格） |
| 生成へ渡る特徴の文言に領域IDが無い（P-3） | 済（`5b15d85`。B1 の cd7f326 を取り込んだ木で2件合格。修正前の b896dbc は失敗） |
| 新 pin: 承認→開始→冷復元が準備待ちに入らない・claim ゼロ・初回 API ゼロ | SandyCurie が B2 の作業中の差分で先に確認（承認200・claim 0・初回推論0・束なしの冷復元）。D の独立試験は B2 の次のコミット後 |
| 新 pin のモデル入力に旧テンプレートの見立てが無い（F6@0 の旧全体候補、F15@270 の現方向 P3 の旧「翼や尖った突起」。F15@0#P2・P3 と F15@90#P3 の最終採用の「翼」は除外しない） | 未（生成・局所抽出・AI 抽出・再観察の組立済みプロンプトの確認と一緒に、C のコミット後） |
| 両方略（repair-first・bypass-enabled）で生成・抽出の回転別メモの部分がバイト同一 | 未（C の生成側のコミット後。Jev の呼び出しは方略に依らず同一入力） |
| 層ごとの最悪値（名詞・役割・full の 3/4/6図形） | 未（B1・C の層の関数が固定された後） |
| 冷復元は保存分だけ・pin と束の不一致で止まらない | SandyCurie が確認。D の独立試験は B2 の次のコミット後 |
| プロンプト整理の監査（旧メモ前提の指示の残り、同一呼び出しの重複、角度の読み上げ・順序の強制・追加の質問・停止が無いか、自然な日本語） | 途中（Jev 判断の組立済み: P-1〜P-4 を統括が採用。C の最終コミット後に Jev・生成・抽出・再観察を再確認） |

プロンプト監査の途中所見（C の作業中の木、Jev の `action` 問い）: P-1 同一呼び出し内の重複3か所（instructions の追加段落・accept の基準・request_observation の基準）→ 追加段落を削除、P-2 accept と confirm の基準の重複 → accept 側に残す、P-3 領域IDが特徴の文言に入る → B1 が文言を修正済み、P-4 prospect の前置き4文が3つの問いに重複（基点から不変）→ 新しい版で1回にまとめる。旧メモ前提の再観察の誘導は消え、回転条件の文と回転別メモの凡例は分かれている。

## 5. 再現手順
- 旧鍵・旧受付の記録: `node --test tests/rotation-memory-audit-old-keys.test.ts tests/rotation-memory-audit-old-plans.test.ts`（他の木は `AUDIT_REPO_ROOT=<worktree>`、読み取りだけ）。
- 投影・幾何・予算・回転方式・領域ID: `AUDIT_REPO_ROOT=<B1・C の変更を取り込んだ木> AUDIT_DATA_DIR=<consensus-120.json などの置き場（統合ブランチでは不要）> AUDIT_REQUIRE_ROTATION_MEMORY=1 node --test tests/rotation-memory-audit-projection.test.ts tests/rotation-memory-audit-budget.test.ts tests/rotation-memory-audit-modes.test.ts tests/rotation-memory-audit-region-id.test.ts`。B1 の木と C の木が別なら `AUDIT_MEMORY_ROOT=<B1 の木>`。
- Jev state の実測: `node tests/support/rotation-memory-audit-measure-jev-state.mjs [<repo root>]`。
- 描画サイズ: `git show 4e09b62:docs/review/construal-consensus-20261128/consensus-120.json`、`git show 1c5fd3e:docs/review/part-construal-20261128/part-construal-468.json` を取り出して `node tests/support/rotation-memory-audit-measure-render.mjs <consensus> <part>`。
- node: `export PATH="/Users/Shogo/.local/share/fnm/aliases/default/bin:$PATH"`（v24）。zsh では変数を単語分割しない（`files=(…)` の配列で渡す）。
- 他の担当の成果を検査するときは、`git worktree add --detach <自分の領域> <SHA>` で自分の木に取り出し、他の担当の木には書かない。
