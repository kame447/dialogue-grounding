# Reference Analysis: jev-curate

## 参照時点

AkashPriyadarshii/jev-curate の main、commit ea7048c1d2ff67253c3afa8fec7a0738983595cd を設計参考とします。

jev-curate は、Parquet/JSONL の多数 row に対して Jev の Choice、Score、Noul を使い、dataset curation を高速化する Rust/Python 実装です。

## 流用価値が高い部分

streaming reader/writer、並列 worker、rate limiter、retry/backoff、single request 内の複数 question、input token tracking、audit.jsonl、manifest.json、resume 用 row hash は、本プロジェクトでも有用です。

特に、複数の独立 judgment を一 request に speculative fan-out する構造は、M/P 補助判定や span の競合ラベル verification と相性があります。

## そのまま使えない部分

現行の CurateFilter は state を実質的に text 一項目として Jev へ渡します。本研究では speaker、前後文脈、active episode、active local issue、previous M state 等が必要です。

現行 pre_filter_sanity は 10 文字未満を reject します。対話データでは「あー。」「はい。」「うーん。」等が分析上重要なため、この条件は使用できません。

現行 CurateVerdict は scores と nouls を主に保持し、annotation に必要な Choice と probabilities を最終出力へ十分露出していません。

現行出力は clean/rejected/errors の curation を中心としており、本研究で必要な label prediction、review state、human final、span range を表現しません。

現行 reader は主 text column を抽出する用途であり、複数列からなる対話 row と conversation state をそのまま扱う設計ではありません。

## 採用方針

初期段階では jev-curate を直接 fork して本設計を制約しません。

まず本リポジトリで annotation contract と evaluation を固定し、その後に、jev-curate の一部構造を library として使う、必要部分を移植する、fork する、独自実装する、の四案を比較します。

判断基準はコード再利用量ではなく、annotation semantics を歪めずに保守できるかです。

## 最小変更で利用する場合

少なくとも state の任意 JSON 化、Choice/probabilities の保存、短文 sanity filter の無効化、keep/reject 以外の annotation verdict、conversation-level state、custom output writer が必要です。

これらが upstream の一般用途として自然でない場合は、無理に upstream-compatible な設計にせず adapter/fork 側へ置きます。
