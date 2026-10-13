# dialogue-grounding

共同活動での共通基盤形成について、人間がずれや不確実性をどこまで許容し、成功を保ちながら精神的努力や会話の円滑さを調整しているかを研究するためのリポジトリです。「やり過ごし」はその許容を実現する方略の一つとして扱います。

## 最初に読む

1. [研究の現在の状態](docs/current-research-status.md) — 何が決まり、何が未決かを確度つきで示します。
2. [文書総合目次](docs/README.md) — すべての文書の状態・日付・言語と更新履歴です。

## 現行の目的・課題・評価

[2026-10-13 研究者による明確化](dialogue-model/proposals/2026-10-13-researcher-clarification.md)が最新です。要点：

- タングラム6図形の共同命名で、ずれ・不確実性の許容が、成功を維持しつつ精神的努力と会話の円滑さにどう影響するかを問う。
- 6図形を区別できる名前が必須条件。成功は名前と対象の対応で判断する。
- 同じ参加者が条件 A・B を両方体験し、AB／BA の順序を均衡化する。
- 形状・見立てと対象対応の判断は単一のマルチモーダルLLMに統合する方針を優先する。モデルAPIは未接続。
- 尺度・効果の大きさ・人数は未確定。LLMの挙動だけで人間の認知機構を証明したとは言わない。

その前段の整理は [2026-10-12 対話整理・再協議依頼](dialogue-model/proposals/2026-10-12-research-clarification-and-measurement-brief.md) にあります。

## 研究データの分析（annotation/）

[アノテーション領域](annotation/README.md)では、既存の人間対話を、発話系列上に観察できる証拠に基づいて記述します（発話機能 a1–a30、ずれ状態 M0–M4、調整過程 P1–P6、エピソード結果 ER0/ER1）。Jev や生成モデルは支援に使いますが、参加者の「本当の内部状態」は推定しません。

## 対話モデル（dialogue-model/）

[対話モデル領域](dialogue-model/README.md)では、人間対話で観察された調整を、LLMを用いた対話モデルと人間参加者の実験で検討します。モデルには、その時点までに参加者が利用できる情報だけを与えます（[観察可能な情報の原則](dialogue-model/observable-information-policy.md)）。

## 実験UI

AI未接続の DEMO 叩き台が draft PR #1 にあり、2台通信のデモも別ブランチで作業中です。どちらも **main には未マージ**で、本番実験やデプロイは行っていません。状況は [現在の状態 §5](docs/current-research-status.md#5-実装実験uiの状況) を参照してください。

## 判断済みと未決

- 正式な決定記録：[dialogue-model/decisions/](dialogue-model/decisions/README.md)（対話モデル側はまだ記録なし）、[docs/adr/](docs/README.md#設計判断記録adr)（アノテーション基盤）
- 研究者の方針と未決事項の一覧：[研究の現在の状態](docs/current-research-status.md)

## 旧版・履歴

- [2026-10-12 初期実験案](dialogue-model/proposals/2026-10-12-initial-experiment-plan.md) — 三層構造などを含む初回の案。現在は履歴です。
- 2026-10-06 の [研究仮説](dialogue-model/research-hypothesis.md)・[モデル設計](dialogue-model/model-design.md)・[評価計画](dialogue-model/evaluation.md)・[ロードマップ](dialogue-model/roadmap.md) — 基本的な考え方は有効ですが、一部が最新方針で置き換わっています。各文書の冒頭に案内があります。
- Opus／Astra のレビュー草案は研究者未承認のため Git に入れていません（[扱い](dialogue-model/reviews/README.md)）。

## データの扱い

実対話データ、音声、完成済みアノテーションファイル、原資料（Excel・PDF）、個人識別情報はこのリポジトリに保存しません。保管場所は [研究資料一覧](dialogue-model/references/source-inventory.md) にあります。
