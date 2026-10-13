# アノテーション（Annotation）

既存の対話データに対するアノテーションと、その作業を Jev／生成モデルで支援するための領域です。全体の目次は [文書総合目次](../docs/README.md) にあります。

このフォルダの目的は「人間がどのような内部状態にあったかを推定すること」ではなく、発話系列上に観察可能な証拠に基づいて、発話機能 a1–a30、ずれ状態 M0–M4、調整過程 P1–P6、エピソード結果 ER0/ER1 などを一貫して記述することです。

Jev は研究仮説そのものを検証するモデルではなく、閉集合判断を支援する一次判定器として扱います。最終的な研究用ラベルは人間が確認します。

> 状態：2026-10-04〜06 に作成した設計文書です。実装はまだありません。2026-10-12 以降の対話モデル側の方針変更（[研究の現在の状態](../docs/current-research-status.md)）はこの領域のラベル定義を変更していません。

## 文書

まず読むもの：

- [アノテーション契約](annotation-contract.md) — 観察可能性の原則と各ラベルの定義
- [文脈と状態](context-and-state.md) — Jev へ渡す文脈と状態の管理
- [評価計画](evaluation.md) — アノテーション支援の評価
- [工程](roadmap.md) — アノテーション支援の段階

設計の詳細：

- [範囲](scope.md)
- [発話区間（span）のアノテーション](span-annotation.md)
- [Jev による判断の設計](jev-judgment-design.md)
- [処理構成](architecture.md)
- [データ契約](data-contract.md)
- [人間による確認](human-review.md)
- [個人情報と再現性](privacy-and-reproducibility.md)
- [参考実装 jev-curate の分析](reference-analysis.md)

関連する設計判断：[ADR 0001・0002](../docs/README.md#設計判断記録adr)

対話そのものを LLM でモデル化し、ずれ・不確実性の許容や「やり過ごし」の役割を検証する設計は [../dialogue-model/](../dialogue-model/README.md) に分離しています。
