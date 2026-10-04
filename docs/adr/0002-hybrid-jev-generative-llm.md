# ADR 0002: Hybrid Jev and generative model pipeline

Status: proposed

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
