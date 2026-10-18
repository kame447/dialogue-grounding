# Decisions 判断精度の評価計画（エンジニアリング用・研究者未承認）

ブランチ `research/decisions-eval`（PR #18 `37d7186` から分岐）。研究正本は [../../README.md](../../README.md) で、この評価は実験結果・方略効果の証拠ではありません。正解ラベルは**研究者未承認の暫定基準**であり、判断モデルは shadow のままです。既存会話・方略・名称合意には反映しません。

## 外部送信の境界

- 送るのは**完全な合成の公開発話**と**AI側の架空の候補情報**（架空の内部ID・作業メモ・仮説）だけ。実参加者の記録・図形画像・アノテーション原文は送らない。
- モデルへの `state` は PR #18 の `buildDecisionEvidence`（shadow と同じ形）で作り、`questions` は Worker 固定の9行動の choice のみ。両モデルに同一の state・同一の questions を送る。
- 正解・ラベル・カテゴリ名・メモは state に入れない。採点はローカルだけで行う。
- 鍵は Worker 側だけ。クライアントは既存の研究用 Worker トークンで `/v1/decisions` を呼ぶ。

## 事例セット（`cases.mjs`）

- **ベース事例50件以上**。各ベースを `repair-first`・`bypass-enabled` の2方略に展開して**100件以上**にする。方略間で発話・メモ・仮説は同一で、`strategy` と方略ごとのラベルだけが違う。
- 層（各3ベース以上）:
  - `impression_only`: 抽象図形の見立てだけ
  - `unidentified_referent`: 参照対象が未同定
  - `multiple_similar_candidates`: 同形の候補が複数
  - `explicit_adoption`: 明示的な名称採用の意思
  - `bare_backchannel`: 単なる相槌
  - `explicit_repair_request`: 明示的な修復要求
  - `defer_request`: 判断保留
  - `later_reprocessing`: 後から再処理・再訪
  - `progress_priority`: 進行優先
  - `suboptimal_agreement`: 次善的な合意
  - `closing`: 会話終了
  - `self_correction_needed`: AIの仮説が公開発話と矛盾する
- 各事例（方略ごと）に `acceptable`（許容 action 集合、1つ以上）と `dangerous`（危険な action 集合）を付け、両者は交わらない。単一の正解 action に強制しない。どちらにも入らない action は中立とする。
- 根拠の短いメモ（`rationale`）を付ける。ローカル専用。

## 指標（方略別・層別・モデル別）

- 許容率: 選択が `acceptable` に入る割合
- 危険率: 選択が `dangerous` に入る割合
- **誤agree**: `agree` が危険集合に入る事例で agree を選んだ割合
- **過剰confirm**: confirm が危険集合に入る事例（同定・採用意思が十分）で confirm を選んだ割合
- **不当なrepair**: repair が危険集合に入る事例で repair を選んだ割合
- 確率: 誤agree リスク事例での P(agree) の平均と最大
- 無回答（エラー・不正応答）数、遅延（中央値・p90）、費用（合計）
- 2モデルの一致率。勝者は決めない。

## 実行

1. mock テスト（ネットワークなし）: 事例のスキーマ、層の網羅、方略展開の同一性、`acceptable`/`dangerous` が交わらないこと、state にラベルが入らないこと、呼び出し上限、採点の計算、ログに state 本文が出ないこと。
2. 実API（研究者の明示実行のみ `--live`）: 上限は **200 コール**（約100事例×2モデル）、並列は控えめ、月$10上限の範囲内。事例ごとの結果はリポジトリ外の非公開ディレクトリに保存し、標準出力は集計だけにする。

## 未検証・承認事項

- ラベル・閾値は暫定。実画像・実人間対話への外的妥当性は未検証。
- 判断モデルを会話の行動選択に使うかは研究者の承認事項。
