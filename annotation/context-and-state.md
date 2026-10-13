# 文脈と状態（Context and State）

## 基本文脈

運用基準では、原則として直前 1–3 発話と直後 1–3 発話を確認し、必要時だけ同じ対象・特徴を扱う範囲まで広げます。

この方針をそのまま initial context policy とします。

ただし、単純な固定窓だけでは P2/P4 や保留された局所問題を扱えないため、局所窓と active state を併用します。

## context bundle

Jev へ渡す context bundle は、current utterance、speaker、previous local turns、post context、active episode summary、active local issue summary、previous M state、fixed metadata から構成します。

post context は後続証拠を許すラベルの解釈補助として使用します。一方、後の最終結果を使って過去の M/P を遡及的に決めないよう、用途を限定します。

## evidence policy

状態判定には、後の最終解消や再処理の有無を正解情報として使用しません。

P3 では、同一問題について相手の補足が実際に後続することは強い証拠になり得ますが、必須条件ではありません。

P4 と P6 の区別に、後で実際に戻ったかどうかを直接使いません。その位置までの系列から、保留なのか明示的断念なのかを判定します。

P2 は過去の未解決問題へ戻るため、過去 episode/issue history を必要とします。ただし、その後最終的に解消したかは P2 判定条件にしません。

## local issue

local issue は公式アノテーションラベルではなく、文脈管理用の内部単位です。

issue dimension は target identity、position、orientation、feature、interpretation、name、task procedure、other のような閉集合候補を持てます。

issue content は自由記述になり得るため、短い summary を生成モデルまたは人間が作ります。

同じ主要対象でも issue dimension が変わる場合は、同一 episode 内の別 local issue として追跡できます。

## active state

active M state は、最後に明示された M event から host が決定的に復元します。

Jev に毎回「現在の state を再推定」させません。Jev は現在行で state change が起きるかを判定します。

同様に episode id も host が管理します。

## context expansion

初期窓で context sufficiency が低い場合だけ、同一 active issue または episode 内で追加文脈を広げます。

拡張上限は実装時のベンチマークで決めます。設計段階では固定値を規範化しません。

拡張しても判断不能なら REVIEW を返し、モデルに無理な確定をさせません。
