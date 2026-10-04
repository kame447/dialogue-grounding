# ADR 0001: Design-first private repository

Status: accepted

## Context

対話アノテーションは、単純な row classification ではなく、状態継続、episode、局所問題、span、重なり、複数ラベル、人間最終確認を含みます。

jev-curate は有用な参考実装ですが、目的は dataset curation であり、そのまま fork すると keep/reject 中心の抽象化に設計が引っ張られる可能性があります。

## Decision

最初に private repository で設計文書を固定します。

実装は、annotation contract、evaluation、data contract、privacy rule のレビュー後に開始します。

実データは repository に入れません。

## Consequence

実装開始は少し遅くなりますが、既存の研究基準を実装都合で変える危険を減らせます。

後から jev-curate を fork しても、独自実装しても、比較基準が残ります。
