# Jev による判断の設計（Jev Judgment Design）

## Jev を使う条件

Jev は、候補集合を事前に明示でき、出力が短い判断へ使用します。

自由記述の説明生成、任意 span 生成、未知の局所問題名生成は Jev の主要責務にしません。

## episode boundary

現在行が active episode に対してどの位置にあるかを Choice で判定します。

候補は NONE、START、END、REVIEW とします。

既存運用では未解決対象を保留して別対象へ移る場合、旧 episode の end を直前行に置き、転換発話を新 episode の start 側へ置けるため、初期設計では END_AND_START を標準候補にしません。実データで必要性が確認された場合だけ追加します。

episode 番号そのものは Jev に生成させず、host が順番に付番します。

## M event

Choice 候補は CONTINUE、M0、M1、M2、M3、M4、REVIEW とします。

CONTINUE は直前状態がそのまま続き、現在行に M ラベルを書かないことを意味します。

Jev には直前 M state と active local issue を渡し、M2 を形式的に補完しないこと、M1 から M3/M4 へ直接遷移可能であることを明示します。

## P event

Choice 候補は NONE、P1、P2、P3、P4、P5、P6、REVIEW とします。

P2/P4 は移行先ではなく切替の主機能で区別します。

P3 は通常の傾聴やフィラーを除外し、応答関連位置、判断未確定の可視的証拠、同一問題の維持を必要条件として rubric に記述します。

## ER event

Choice 候補は NONE、ER0、ER1、REVIEW とします。

episode boundary が END でない行では、host 側で ER 判定自体を呼ばない構成も許可します。この方が無効候補を減らせるため、初期実装では staged call を優先します。

## 発話機能

各 span に対する primary label を Choice で判定します。候補は a1–a30、NONE、REVIEW です。

発話機能は多重付与を許すため、primary Choice だけで最終確定しません。primary label の競合集合に対して追加 verification を行います。

典型的な競合集合は、a1/a3/a4/a11、a15/a16/a30、a8/a17/a18、a9/a10/a11 などです。競合集合は運用基準から明示的に管理し、モデルが自由に生成しません。

追加 verification には Noul を使い、各候補機能が独立に成立するかを判定する案を採ります。threshold は gold 互換性評価で調整します。

## Noul

Noul は、review routing と補助的な二値判定に使用します。

例として、same_local_issue、candidate_requires_review、secondary_function_present のような二値判断が候補です。

Noul の値を人間用の 0–100 確信度へ直接変換しません。モデル確信度と人間自己評価は別の意味を持つため、別フィールドで保存します。

## Score

初期設計では Score を必須にしません。

曖昧性、説明十分性、context sufficiency のような順序尺度に使う可能性はありますが、Choice の probabilities と review rule で足りるなら導入しません。

## speculative fan-out

同一 state から独立に答えられる質問は一つの Jev request へまとめます。

ただし、episode boundary の結果によって ER の有効性が変わるような依存関係は、無理に一括化せず staged call にします。

速度より判定契約の明確さを優先します。
