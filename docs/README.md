# 文書総合目次

このリポジトリのすべての文書を、目的・状態・日付で引けるようにした索引です。迷ったら、まず [研究の現在の状態](current-research-status.md) を読んでください。

## 目的別の入口

| 知りたいこと | 最初に読む | 次に読む |
| --- | --- | --- |
| いま何が決まっていて何が未決か | [研究の現在の状態](current-research-status.md) | [2026-10-13 研究者の明確化](../dialogue-model/proposals/2026-10-13-researcher-clarification.md) |
| 研究の目的・課題・評価の最新方針 | [2026-10-13 研究者の明確化](../dialogue-model/proposals/2026-10-13-researcher-clarification.md) | [2026-10-12 対話整理・再協議依頼](../dialogue-model/proposals/2026-10-12-research-clarification-and-measurement-brief.md) |
| 既存の人間対話データの分析（アノテーション） | [アノテーション領域](../annotation/README.md) | [アノテーション契約](../annotation/annotation-contract.md) |
| 対話モデル研究の全体 | [対話モデル領域](../dialogue-model/README.md) | [提案一覧](../dialogue-model/proposals/README.md) |
| 実験UI | [研究の現在の状態 §5](current-research-status.md#5-実装実験uiの状況) | main には未マージ（下記「main にない文書」） |
| 決まったこと | [決定記録](../dialogue-model/decisions/README.md)（対話モデル）、[ADR](#設計判断記録adr)（アノテーション基盤） | — |
| 古い案・履歴 | 下記の文書台帳で状態が superseded／draft のもの | [AIレビュー草案の扱い](../dialogue-model/reviews/README.md) |
| 原資料の所在 | [研究資料一覧](../dialogue-model/references/source-inventory.md) | — |

## 状態の表記

| 状態 | 意味 |
| --- | --- |
| current | 現在の方針として読んでよい（ただし研究者の正式決定とは限らない） |
| researcher-clarification | 研究者が明確にした方針の記録 |
| discussion-summary | 研究者との対話の要約と依頼。検討結果ではない |
| draft | 検討中の案。確定仕様ではない |
| proposed | 提案された判断。採用されていない |
| accepted | 採用された判断 |
| partly-superseded | 基本的な考え方は残るが、一部が新しい文書で置き換えられた |
| superseded | 新しい文書で置き換えられた。履歴として残す |
| local-only | Git に入れていない（研究者未承認・非公開など） |
| index | 案内・目次 |

## 文書台帳

最終更新は Git の最終コミット日（今回の整理による見出し・案内の追加は除く）です。言語は本文の主な言語です。

### 入口・横断

| 文書 | 内容 | 状態 | 日付 | 言語 |
| --- | --- | --- | --- | --- |
| [README.md](../README.md) | リポジトリの入口 | index | 2026-10-13 | 日本語 |
| [docs/README.md](README.md) | 本書。文書総合目次と更新履歴 | index | 2026-10-13 | 日本語 |
| [docs/current-research-status.md](current-research-status.md) | 現在の状態と確度 | current | 2026-10-13 | 日本語 |

### 対話モデル（dialogue-model/）

| 文書 | 内容 | 状態 | 日付 | 言語 |
| --- | --- | --- | --- | --- |
| [README.md](../dialogue-model/README.md) | 領域の索引 | index | 2026-10-13 | 日本語 |
| [proposals/2026-10-13-researcher-clarification.md](../dialogue-model/proposals/2026-10-13-researcher-clarification.md) | 上位仮説・基本条件・参加者内比較・単一マルチモーダルLLM方針 | researcher-clarification（最新） | 2026-10-13 | 日本語 |
| [proposals/2026-10-12-research-clarification-and-measurement-brief.md](../dialogue-model/proposals/2026-10-12-research-clarification-and-measurement-brief.md) | 研究者との対話整理、楽さと円滑さの区別、再協議依頼 | discussion-summary（一部は 2026-10-13 明確化で更新） | 2026-10-12 | 日本語 |
| [proposals/2026-10-12-initial-experiment-plan.md](../dialogue-model/proposals/2026-10-12-initial-experiment-plan.md) | 初回の実験案（三層構造を含む） | draft／superseded（履歴） | 2026-10-12 | 日本語 |
| [proposals/README.md](../dialogue-model/proposals/README.md) | 提案の一覧 | index | 2026-10-13 | 日本語 |
| [research-hypothesis.md](../dialogue-model/research-hypothesis.md) | 研究仮説（やり過ごし中心の初期の定式化） | partly-superseded | 2026-10-06 | 日本語 |
| [observable-information-policy.md](../dialogue-model/observable-information-policy.md) | 観察可能な情報の原則 | current | 2026-10-06 | 日本語 |
| [model-design.md](../dialogue-model/model-design.md) | repair-first／bypass-enabled の比較設計 | partly-superseded | 2026-10-06 | 日本語 |
| [evaluation.md](../dialogue-model/evaluation.md) | 評価計画（初期） | partly-superseded | 2026-10-06 | 日本語 |
| [roadmap.md](../dialogue-model/roadmap.md) | 研究工程（初期） | partly-superseded | 2026-10-06 | 日本語 |
| [decisions/README.md](../dialogue-model/decisions/README.md) | 決定記録の置き場。**記録はまだない** | index | 2026-10-12 | 日本語 |
| [reviews/README.md](../dialogue-model/reviews/README.md) | Opus／Astra レビュー草案の扱いと状態（本文は local-only） | index | 2026-10-13 | 日本語 |
| [references/source-inventory.md](../dialogue-model/references/source-inventory.md) | 非公開原資料の一覧と保管場所 | current | 2026-10-12 | 日本語 |

### アノテーション（annotation/）

2026-10-04〜06 に作成した、既存の人間対話へのアノテーションと Jev 支援の設計です。実装はまだありません。2026-10-12 以降の対話モデル側の方針変更の影響は受けていません。

| 文書 | 内容 | 状態 | 日付 | 言語 |
| --- | --- | --- | --- | --- |
| [README.md](../annotation/README.md) | 領域の索引 | index | 2026-10-13 | 日本語 |
| [scope.md](../annotation/scope.md) | 範囲 | current（設計） | 2026-10-06 | 日本語 |
| [annotation-contract.md](../annotation/annotation-contract.md) | ラベル a1–a30、M0–M4、P1–P6、ER0/ER1 の契約 | current（設計） | 2026-10-06 | 日本語 |
| [context-and-state.md](../annotation/context-and-state.md) | 文脈と状態の管理 | current（設計） | 2026-10-06 | 日本語 |
| [span-annotation.md](../annotation/span-annotation.md) | 発話区間（span）の扱い | current（設計） | 2026-10-06 | 日本語 |
| [jev-judgment-design.md](../annotation/jev-judgment-design.md) | Jev による閉集合判断の設計 | current（設計） | 2026-10-06 | 日本語 |
| [architecture.md](../annotation/architecture.md) | 処理段階（Stage 0–7） | current（設計） | 2026-10-06 | 日本語 |
| [data-contract.md](../annotation/data-contract.md) | データ形式 | current（設計） | 2026-10-06 | 日本語 |
| [evaluation.md](../annotation/evaluation.md) | アノテーション支援の評価計画 | current（設計） | 2026-10-06 | 日本語 |
| [human-review.md](../annotation/human-review.md) | 人間による確認 | current（設計） | 2026-10-06 | 日本語 |
| [privacy-and-reproducibility.md](../annotation/privacy-and-reproducibility.md) | 個人情報と再現性 | current（設計） | 2026-10-06 | 日本語 |
| [reference-analysis.md](../annotation/reference-analysis.md) | 参考実装 jev-curate の分析 | current（設計） | 2026-10-06 | 日本語 |
| [roadmap.md](../annotation/roadmap.md) | アノテーション支援の工程 | current（設計） | 2026-10-06 | 日本語 |

### 設計判断記録（ADR）

アノテーション基盤についての初期の判断です。原文を保持し、日本語の要約をここに付けます。

| 文書 | 日本語の要約 | 状態 | 日付 |
| --- | --- | --- | --- |
| [0001-design-first-private-repo.md](adr/0001-design-first-private-repo.md) | 実装より先に非公開リポジトリで設計文書を固め、実データは入れない | accepted | 2026-10-04 |
| [0002-hybrid-jev-generative-llm.md](adr/0002-hybrid-jev-generative-llm.md) | 閉集合判断は Jev、任意区間の抽出と要約は生成モデルまたは人間に分ける | proposed | 2026-10-04 |

### その他

| ファイル | 内容 |
| --- | --- |
| [examples/synthetic-dialogue.jsonl](../examples/synthetic-dialogue.jsonl) | 合成の対話例（実データではない） |
| [scripts/check-md-links.py](../scripts/check-md-links.py) | Markdown のローカル相対リンク検査 |

## main にない文書

次の文書は Git の別ブランチまたはローカルにだけあり、main からはリンクしません。

| 文書 | 場所 | 状態 |
| --- | --- | --- |
| 実験UI叩き台の README・設計・仕様（`experiment/`、`dialogue-model/proposals/2026-10-13-interface-prototype-task.md`） | draft PR #1（`feat/experiment-ui-prototype-20261013`） | 未マージ。DEMO・AI未接続 |
| 2台通信（live pair）デモの文書 | 作業中のブランチ | 未マージ・作業中 |
| Opus／Astra のレビュー草案 10 件 | 研究者の Mac 上の `dialogue-model/reviews/`（未追跡） | local-only。研究者未承認 |
| 原資料（Excel・PDF）とテキスト抽出 | Git 外の非公開保管場所 | local-only。Git に入れない |

## 英語文書の扱い

- 研究者が主に読む案内文（[reviews/README.md](../dialogue-model/reviews/README.md)、[研究資料一覧](../dialogue-model/references/source-inventory.md)）は 2026-10-13 に日本語へ訳し直しました。
- 各文書の英語の見出しは「日本語（English）」の形にしました。ファイル名は外部からの参照を壊さないよう変更していません。
- 本文中の専門用語（repair-first、bypass-enabled、span、context bundle など）、ラベル記号、コード記号、固有名は英語のまま残しています。
- ADR は原文を変えず、本書に日本語の要約を付けています。

## 更新履歴

| 日付 | 内容 |
| --- | --- |
| 2026-10-04 | アノテーション設計と ADR 0001／0002 を作成 |
| 2026-10-06 | annotation/ と dialogue-model/ に分離。研究仮説・モデル設計・評価・ロードマップを作成 |
| 2026-10-12 | 初期実験案、研究者との対話整理・再協議依頼、研究資料一覧を追加。Opus／Astra レビューを依頼（草案は local-only） |
| 2026-10-13 | 研究者の明確化を記録。本目次と現在の状態を新設し、入口を一本化。古い文書に状態の案内を付け、英語の案内文を日本語化。リンク検査スクリプトを追加 |
