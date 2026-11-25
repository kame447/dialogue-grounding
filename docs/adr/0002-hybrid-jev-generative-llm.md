# ADR 0002: Hybrid Jev and generative model pipeline

Status: proposed（判断権限の部分は 2026-10-20 に[決定0002](../../dialogue-model/decisions/0002-jev-decision-and-visual-observation.md)で具体化）

> 2026-10-20：閉集合判断をJevに寄せる方針は、対話行動の決定にも及ぶ形で採用された。次の対話行動はJevが単独で選び、生成モデル（Luna）は観察・自由記述と、選ばれた行動の文章化を担う。現行の方針は[SSOT](../../dialogue-model/README.md)と決定0002を参照。

## Context

M0–M4、P1–P6、ER0/ER1 は候補集合が閉じています。

一方、発話機能は任意文字範囲を抽出する必要があり、重なり発話によって一つの機能が複数区間へ分かれる場合があります。

局所問題の内容要約も自由記述性があります。

## Decision

閉集合判断は Jev を第一候補とします。

任意 span の提案と局所問題の短い内容要約は生成モデルまたは人間へ残します。

生成モデルがラベルを最終確定せず、Jev の closed-set judgment と human review を通します。

## Consequence

すべてを Jev へ寄せる構成より複雑になります。

一方で、Jev が得意な型付き判断と、生成モデルが必要な自由形式処理を分離でき、誤り原因も測定しやすくなります。
