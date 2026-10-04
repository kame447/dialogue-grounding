# Span Annotation

## 問題設定

発話機能 a1–a30 は、発話全体ではなく機能を担う最小文字列範囲へ付与します。

一つの発話に複数 span があり、同一 span に複数機能が成立する場合があります。

重なり発話では、親話者と重なり話者を分離し、親発話者の一つの機能が重なり部分で分断されても一つの span record として複数区間を保持します。

このため、発話機能を単純な row classification として扱いません。

## deterministic overlap parser

<o>...</o> は最初に決定的に抽出します。

重なり部分の話者は二者対話では親話者ではない側です。

重なり部分はラベルなしでも span record を残します。

親話者の解釈用テキストでは <o>...</o> 内を除去し、残った親話者文字列を原順序で連結します。

## span proposal

生成モデルは、再構成した親発話と局所文脈から、機能を担う最小 span 候補を提案します。

生成モデルの出力は、対象文字列、再構成テキスト上の位置、候補理由に限定します。a ラベルを最終確定しません。

span が重なり除去位置をまたぐ場合、host が元の正規化後原文へ逆写像し、複数半開区間へ変換します。

## label judgment

Jev は各 span candidate に対して primary a-label を Choice で判定します。

その後、競合または独立機能の可能性がある場合だけ secondary verification を行います。

複数ラベルが採用された場合は一つの span record の label 配列として保持し、出力時に規定の区切り形式へ変換します。

## position invariant

開始位置は最初の区間の start、終了位置は最後の区間の end とします。

範囲一覧の各区間を原文から取り出し、順番に連結した文字列が対象部分と完全一致しなければ structural error とします。

この validator は意味判断を修正しません。位置計算、採番、範囲一覧だけを修正対象とします。

## NONE

通常部分で a-label が成立しない span candidate は破棄します。

重なり部分で a-label が成立しない場合は、話者と範囲を記録する必要があるため NONE のまま record を残します。

## span 評価

評価時は、span proposal と label judgment を分けます。

span exact match、文字単位 precision/recall/F1、label match、span+label exact match を別に計測します。

これにより、正しい範囲を抽出できなかった誤りと、範囲は正しいが a-label を誤った誤りを分離します。
