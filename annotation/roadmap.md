# アノテーション支援の工程（Roadmap）

## Phase 0: design freeze

現在の運用基準を annotation contract へ写し、モデル都合の簡略化がないか人間が確認します。

Jev の責務と生成モデルの責務を固定します。

evaluation metric と leakage rule を実装前に固定します。

## Phase 1: M/P/ER prototype

span annotation を入れず、既存 row と文脈から M/P/ER と episode boundary だけを判定します。

現在の 5 対話に対して regression benchmark を行います。

特に P2/P3/P4、M1/M2/M3/M4 の誤りを分析します。

## Phase 2: state and issue tracking

active episode、previous M state、active local issue の host-side state machine を導入します。

固定窓だけの場合と、issue-aware context expansion を使う場合を比較します。

## Phase 3: span pipeline

deterministic overlap parser を実装します。

生成モデルによる span proposal と Jev による a-label judgment を分離して導入します。

span exactness と label accuracy を別々に評価します。

## Phase 4: review interface

review trigger と audit schema を実装します。

strict research mode では全件確認、assist mode では優先レビューを可能にします。

## Phase 5: locked holdout

基準調整に使っていない新規対話を確保し、rubric と threshold を凍結した状態で評価します。

この段階の結果を、未知データへの性能評価として扱います。

## Phase 6: implementation source decision

prototype の結果を見て、jev-curate fork、partial reuse、独自 Rust 実装、Python orchestration のどれを採るか決めます。

設計段階では実装言語や fork 方針を先に固定しません。
