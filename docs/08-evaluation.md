# Evaluation Plan

## 現在の 5 対話の扱い

現在の確定済み 5 対話は、ラベル定義と運用基準の形成にも使われています。

そのため、この 5 対話に対する一致率を未知データへの汎化性能とは解釈しません。

これらは、既存の最終ラベルと新しい Jev パイプラインの互換性を確認する regression benchmark として使います。

## 第一段階

最初に M/P/ER と episode boundary だけを評価します。

発話機能 span を同時に始めると、span 抽出誤りと分類誤りが混ざるためです。

M については event-level の accuracy、macro F1、各ラベル precision/recall/F1、confusion matrix、CONTINUE の誤検出を確認します。

P については同様に、特に P1/P2/P3/P4/P5/P6 間の confusion を確認します。

ER は episode end 行だけを母集団として評価します。

episode boundary は start/end の event precision/recall/F1 に加えて、正解境界から何発話ずれたかを記録します。

## 第二段階

発話機能は span proposal と label judgment を分離して評価します。

span exact match、文字単位 precision/recall/F1、a-label macro F1、span+label exact match、多重ラベル完全一致を記録します。

重なり発話については通常 span と別に集計します。

## confidence calibration

Choice probabilities が利用可能な場合、confidence bin ごとの accuracy を確認します。

threshold は「高信頼とみなした事例でどれだけ誤るか」と「人間レビューへ回す割合」のトレードオフで設定します。

threshold を現在の 5 対話へ過適合させないため、対話単位の leave-one-dialogue-out も補助的に確認します。ただし、基準自体が全 5 対話の検討から形成されているため、これも完全な外部妥当性評価ではありません。

## locked holdout

実運用前に、基準調整へ使用していない新規対話を locked holdout として確保します。

holdout の final label は、Jev 用 rubric や threshold を確定するまで参照しません。

最終的な性能主張は holdout を中心に行います。

## human baseline

可能になった段階で独立二重符号化を行い、人間同士の一致度も測定します。

モデル対 gold の一致だけではなく、人間間の不一致が大きいラベルにモデル誤りが集中しているかを確認します。

Cohen の kappa 等を使う場合は、状態/event 単位と span 単位を混同せず、適切な単位で算出します。

## error analysis

数値だけでなく、誤りを boundary error、context insufficiency、label-definition confusion、issue-tracking error、span extraction error、overlap parsing error、formatting error に分類します。

改善は、最も件数が多い誤りからではなく、研究上の結論へ影響する重大度と再現性を合わせて優先します。
