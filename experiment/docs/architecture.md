# 実験UIプロトタイプの構成（DEMO）

状態: 試作。実験プロトコル・質問紙・刺激の最終承認ではありません。実在の参加者には使用できません。

## 層と依存方向

```
participant/*.tsx ─┐                 researcher/ResearcherDemo.tsx
                   ├─ App.tsx（ルーティング・保存・PartnerPort駆動）
participant/usePartner.ts ── partner/PartnerPort.ts ◀── partner/MockPartner.ts（唯一の実装）
                   │
domain/session.ts（状態機械 reduce）── domain/assignment.ts / names.ts / scoring.ts / storage.ts
                   │
stimuli/sets.ts / layout.ts / StimulusSvg.tsx（DEMO自作シルエット）
```

- `domain/` は React に依存しない純粋なロジックです。画面は `Action` を送るだけで、遷移の可否は `reduce()` が判定します。
- 不正な遷移（二重クリック、古いボタン、相手応答待ち中の送信、確定済み名前の再提出など）は状態を変えず、`transition_rejected` イベントだけを残します。
- 画面は常に `session.phase` から導出されます。ブラウザの「戻る」は画面を巻き戻さず、注意表示だけを出します。リロード時は sessionStorage から復元し、応答待ちだった要求は `partner_request_failed` に変換して「再送信」を出します。

## 実験フロー（状態）

`welcome → consent（仮同意） → instructions → [chat → naming（6名称の独立提出・ロック） → survey（E/F/煩わしさ＋任意項目）] ×2（間に interblock） → comparison（直接比較） → results（DEMO照合） → done`

- 条件 A/B は `assignment.blocks[i].condition` とイベントの `condition` にのみ保持し、参加者画面には描画しません（E2E `participant-leak.spec.ts` で確認）。
- ブロック質問は名前ロック後・結果表示前です。照合結果は比較アンケートの後にだけ表示し、モック相手との照合であって研究上の成績ではないと明示します。
- 相手（モック）の最終名前は、参加者が会話を終えた時点で独立に生成されます（`usePartner.ts`）。参加者の入力には依存しません。

## 割付（4系列）

| 系列 | Round 1 | Round 2 |
| --- | --- | --- |
| S1 | A / α | B / β |
| S2 | B / α | A / β |
| S3 | A / β | B / α |
| S4 | B / β | A / α |

デモでは localStorage のカウンタで巡回割付します（個人情報なし）。本番はサーバー側で割付と記録を行う必要があります。

## 記録されるイベント

すべてのイベントは `seq`、壁時計 `at`（ISO）、単調時計 `mono`（performance.now ms）、`blockIndex`、研究者用 `condition`、`payload` を持ちます。

| 測定 | イベント | 注意 |
| --- | --- | --- |
| 発話・文字数 | `message_sent` / `message_received`（`chars`） | 双方別々に集計 |
| 入力していた時間 | `composing_started` / `composing_stopped` | 観測された入力時間であり、認知時間ではない |
| 相手待ち時間 | `partner_request_started` / `_finished` / `_failed`（`waitMs`） | API待ちは別の測定。モックの遅延は人工的 |
| 会話終了 | `naming_end_requested` | 終了確認ダイアログを経た場合のみ |
| 最終回答 | `names_locked`（参加者スロット順）、`partner_names_submitted` | 重複・空欄はロック前に拒否 |
| 質問紙 | `survey_submitted`（E 1–9、F/煩わしさ/自然さ/満足度 1–7、`missing`） | 独自の質問文。既存尺度の正式版ではない |
| 直接比較 | `comparison_submitted`（`missing`） | 2ブロック終了後 |
| モック診断 | `mock_diagnostic`（`mock: true`） | 研究結果として扱わない |

## 既知の制約（本番前に必要なこと）

- ブラウザ内で完結するため、相手配置・条件・採点IDは sessionStorage と JS バンドルに含まれます。参加者画面には描画しませんが、開発者ツールでは見えます。本番では `docs/partner-port.md` の境界案に従いサーバーへ移す必要があります。
- 正式な説明・同意手続き、匿名IDの発行、データ保存・削除方針、アクセス制御は未実装です。
- 図形は自作 SVG のデモ刺激です。学術的な刺激としての妥当性（難易度、命名しやすさの偏り）は未検証です。
- 質問紙の文言は暫定であり、レビューが必要です。
