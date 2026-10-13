# 図形の命名対話 DEMO（人間1人＋AI1体・実モデル未接続）

## 公開デモURL

**https://dg-tangram-ai-demo.kame-website.workers.dev/**

1. 上のURLを開いて「デモを始める」を押します（1人で完結します）。
2. 左（スマホでは「図形」タブ）の6図形について、右の「会話」で模擬AIと呼び方を相談します。模擬AIは「図形2は鳥」のように番号と名前を書くと記録します。
3. 「会話を終えて名前を決める」→ 6つの名前をAIに見せずに入力・確定 → 3問のアンケート → 結果（一致数）の順に進みます。
4. 結果画面の「このデモのデータを削除」で、そのルームのデータをすぐ消せます。

**2台構成（PC1＝人間、PC2＝外部AIエージェント）:** 研究者が `/#/researcher` で「外部AI用ルームを作成」を押し、PC1で「参加者用URL」を開き、PC2で表示されたコマンド（`DG_AGENT_TOKEN=… node agent/stub-agent.mjs --base … --room …`）を実行します。参加者URLにはAIトークンが含まれません。手順と通信仕様は [`docs/agent-protocol.md`](docs/agent-protocol.md)。

> **DEMO／実モデル未接続。** 相手は動作確認用の**模擬AI**（サーバー上の規則ベースの文字列処理）または外部エージェント用の**スタブ**で、VLM・LLMには接続していません。図形を見ることも、認識・見立て・確認要否の判断もしません。模擬AIの名前提出は、会話中の「図形N は…」をサーバー内の対応表で写すだけなので、結果の一致は**基盤化の成功やAIの能力を示しません**。本番の人間実験・研究データには使えません。A/B条件差や精神的努力の低下を示すものでもなく、質問項目・刺激は未校正です。

## データの保存期間

- 新しいルームは作成から**30日**で、Durable Object のアラームにより会話・名前・回答を含む全データが自動削除されます（暫定値）。
- 終了したルームも30日までは保持され、結果画面または `delete_room` で参加者がすぐに削除できます。削除後・期限後のリンクは無効になります。
- サーバーにはトークンのSHA-256ハッシュのみ保存します。外部へのデータ送信・外部API呼び出し・課金はありません。

## 構成（現行）

| パス | 内容 |
| --- | --- |
| `src/ai/protocol.ts` | ブラウザ・Worker・エージェント共通の型付きプロトコル（v2）と上限値 |
| `src/app/` | 参加者UI（導入・ワークスペース・名前・アンケート・結果）、研究者コンソール、`tokens.css`（デザイントークン）/`app.css` |
| `worker/` | Cloudflare Worker と Durable Object `TangramRoom`（フェーズ、漏洩防止スナップショット、30日アラーム、削除、レート制限） |
| `worker/partners/` | 将来のマルチモーダルモデル用 `PartnerAdapter` と、明示的な模擬実装 `mockAi.ts` |
| `agent/stub-agent.mjs` | 別PCから接続する依存なしのヘッドレス・スタブ（`decide()` が将来のモデル接続点） |
| `e2e-ai/` | Playwright（1440×900 / 390×844 / 320×640、模擬AI完走、外部エージェント、漏洩、再接続、スクリーンショット） |

旧ブラウザ内モック版（2ラウンド・A/B表示なし）は `#/legacy`（研究者画面 `#/legacy/researcher`）に隔離して残しています。人間2人向けの旧DEMOは別Worker `dg-tangram-live-demo` のまま変更していません（この Worker には含みません）。

## 起動・テスト

Node.js 22 以上（このマシンでは `~/.local/share/fnm/node-versions/v24.20.0/installation/bin` を PATH に追加）。

```bash
cd experiment
npm ci
npm run worker:dev   # build + wrangler dev → http://127.0.0.1:8795/
npm test             # Vitest（UI・ドメイン・Worker）
npm run e2e:ai       # Playwright（新DEMO、ローカルWorkerを起動）
AI_BASE_URL=https://dg-tangram-ai-demo.kame-website.workers.dev npm run e2e:ai   # 公開URLに対して
npm run e2e          # 旧モック版（#/legacy）
npm run deploy       # dg-tangram-ai-demo へデプロイ
```

## 検証結果（2026-10-13）

| 項目 | 結果 |
| --- | --- |
| `npm run build`（tsc + worker tsc + vite build） | 成功 |
| `npm test`（Vitest） | 49 / 49 passed（Worker 22件: 30日期限・模擬AI・外部エージェント・トークン分離・冪等送信・レート制限・漏洩防止・削除 ほか） |
| `npm run e2e:ai`（ローカル Worker、desktop 1440×900 / mobile 390×844 / narrow 320×640） | 22 / 22 passed |
| `npm run e2e`（legacy `#/legacy`） | 14 / 14 passed |
| 公開URL | `/` と `/api/health` が HTTP 200、他オリジンからのルーム作成は 403。公開URLで模擬AIの完走（会話→名前→アンケート→結果→削除）、別プロセスのスタブエージェントによる外部AIモードの完走、モバイルの漏洩検査が通過 |

スクリーンショットは `npm run e2e:ai -- capture.spec.ts` で `screenshots/{local,deployed}/<project>/` に保存されます（Git 管理外）。1440×900・390×844・320×640 の全段階を目視で確認して修正しました。

---

## 旧ブラウザ内モック版（legacy・`#/legacy`）

以下は以前の版の説明で、記録として残しています。

研究課題（共通基盤形成で、表象のずれ・不確実性を課題遂行に支障のない範囲で許容することが精神的努力を軽減し会話を円滑にするか）を検証するための参加者インターフェースの叩き台です。仕様は [`../dialogue-model/proposals/2026-10-13-interface-prototype-task.md`](../dialogue-model/proposals/2026-10-13-interface-prototype-task.md) です。

### 起動（legacy）

Node.js 22 以上が必要です（このマシンでは `~/.local/share/fnm/node-versions/v24.20.0/installation/bin` を PATH に追加）。

```bash
cd experiment
npm ci
npm run dev          # http://localhost:5173/#/legacy  旧参加者画面
                     # http://localhost:5173/#/legacy/researcher  旧研究者デモ画面
npm run build        # 型検査 + 本番ビルド（dist/）
npm test             # Vitest 単体テスト
npm run e2e          # Playwright（desktop 1280x800 / mobile Pixel 7）
```

デモ用 URL パラメータ: `?mockLatency=300`（モックの応答遅延 ms、既定 900）、`?mockFailNext=1`（次の N 回の相手呼び出しを失敗させ、エラー表示と再送信を確認）。

### 画面構成

**参加者画面（`#/legacy`）** — 上部に常時 DEMO 表示。
1. はじめに → 仮同意（本番の正式同意ではないと明示） → 課題説明
2. ラウンド 1：自分の 6 図形（拡大・選択強調・自分だけのメモ）＋相手とのチャット（Enter 送信 / Shift+Enter 改行、入力中表示、失敗時の再送信）。「会話を終えて名前の入力へ」→ 確認ダイアログでのみ次へ進む
3. 6 図形の名前を独立に提出（空欄・重複〔全角/空白/大小文字を正規化〕をロック前に拒否、確認後は変更不可）
4. ブロック質問：精神的努力 E（9 件法・主）、進めやすさ F（7 件法）、煩わしさ（7 件法）、任意の自然さ・満足度、自由記述 — 正誤表示より前
5. ラウンド 2（別の図形セット）→ 同上
6. 2 ラウンドの直接比較 → 結果（DEMO 照合） → 終了

条件（A/B）、相手側の配置、採点用 ID は参加者画面に描画しません。図形番号は参加者の画面内だけのものです。

**研究者デモ画面（`#/legacy/researcher`）** — 「実験本番には使用禁止・本番はサーバー側の権限制御が必要」と明示。4 系列の割付表と新規セッション作成、ブロックごとの図形セットと人間側/相手側配置、イベントログ（種別フィルタ）、モック応答と診断、提出記録、評価プレビュー（生データの照合表のみ。割合や集計グラフは出しません）、アンケート値（欠損表示）、JSON エクスポート/インポート、二段階リセット。

### 構成

| パス | 内容 |
| --- | --- |
| `src/domain/` | 型、4 系列割付、状態機械 `reduce()`、名前検証、照合、sessionStorage 保存 |
| `src/participant/` | 参加者画面と `usePartner`（PartnerPort 呼び出しの駆動） |
| `src/partner/` | `PartnerPort` 契約と `MockPartner` |
| `src/stimuli/` | DEMO 自作タングラム風シルエット α/β 各 6、配置生成、SVG 描画 |
| `src/researcher/` | 研究者デモ画面 |
| `e2e/` | Playwright シナリオ |
| `docs/architecture.md` | 層構成、状態遷移、イベントと測定の対応、既知の制約 |
| `docs/partner-port.md` | AI 接続口、依存方向、正解 ID 漏洩を防ぐ本番境界案 |

### データとプライバシー

- 保存先はこのタブの `sessionStorage` だけです（タブを閉じると消えます）。系列の巡回割付カウンタのみ `localStorage` に置きます。外部送信はしません。
- 現状はブラウザ内完結のため、相手配置・条件・採点 ID は開発者ツールから見えます。本番ではサーバー側へ移す必要があります（`docs/partner-port.md`）。
- 実在の参加者データ、元論文の刺激画像、私的資料はこのディレクトリに含めません。図形はすべて自作のデモであり、刺激としての妥当性は未検証です。
- 質問紙は本プロジェクト独自の暫定文言です。NASA-TLX や Paas 尺度の正式版ではありません。

### 次の AI 統合口

`PartnerPort.respond({ history, visibleStimuli, policyContext })` と `submitNames(...)` をサーバー側実装に差し替えます。将来は画像知覚と「今ここで確認が必要か」の判断を単一のマルチモーダルモデルに集約し、自然文生成は別コンポーネントとして差し替え可能にする構想です（`docs/partner-port.md`）。閉集合モデルの確率をそのまま使うかは未決です。

### テスト結果（legacy版、2026-10-13 初版時点）

2026-10-13 時点、macOS・Node 24.20・Playwright 1.63（Chromium 1243）での実行結果:

| 項目 | 結果 |
| --- | --- |
| `npm run build`（tsc + vite build） | 成功（JS 275.6 kB / gzip 85.2 kB） |
| `npm test`（Vitest, 6 files） | 27 / 27 passed — 4 系列割付と均衡、同一セット再利用なし、遷移拒否、重複送信、名前の空欄・重複（NFKC 正規化）、ロック後不変、質問紙の範囲と欠損記録、イベント順序と時刻、リロード復元、照合、図形の幾何（7 片・辺接触で連結・非重複・相互 IoU < 0.55）、静的データと生成器の一致、MockPartner の非漏洩・失敗・中断 |
| `npm run e2e`（desktop 1280×800 / mobile Pixel 7） | 14 / 14 passed — 全工程のクリック完走とイベント順序、参加者画面への条件・ID・研究者メモ非表示、名前と質問紙の検証、戻る操作の無効化、リロード復元、二重クリック・連続 Enter、相手失敗→再送信、研究者画面の割付・記録・JSON・二段階リセット、全画面で横スクロールなし |

E2E は各画面のスクリーンショットを `test-results/screens/{desktop,mobile}/` に保存します（Git 管理外）。目視で、ボタン文字の折り返しと研究者画面のモバイル横はみ出しを見つけて修正済みです。Claude in Chrome による実ブラウザ操作でも参加者画面・研究者画面を確認しました。

### 残課題

- サーバー（割付・記録・権限制御・匿名 ID）、正式な説明同意、データ管理方針
- 刺激の妥当性検証（命名しやすさの偏り、難易度の均衡）と、必要なら研究者が承認した刺激への差し替え
- 質問紙文言のレビュー、比較質問の項目設計
- 本物の PartnerPort 実装と、その遅延・失敗時の扱いの実験上の取り決め
- スクリーンリーダー実機（VoiceOver / NVDA）での確認（現状は役割・ラベル・ライブリージョンの実装と Playwright のアクセシブルネーム検証まで）
