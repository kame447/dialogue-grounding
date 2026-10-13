# 処理構成（Architecture）

## 基本構造

システムは、正規化、構造抽出、閉集合判定、整合性検証、人間レビューを分離します。

概念レベルで並列な処理段階として、入力正規化、重なり発話解析、エピソードと局所問題の状態管理、M/P/ER 判定、発話機能 span 抽出、span ラベル判定、制約検証、review queue 生成、監査保存を設けます。

## Stage 0: deterministic normalization

管理用ノイズ記号だけを削除し、保持対象の文字起こし記号は残します。

発話 No.、話者、A/H ラベル、区分は固定列として変更しません。

<o>...</o> は正規表現ではなく構造として解析し、親話者と重なり話者の文字列、元位置、再構成した親発話を保持します。

## Stage 1: dialogue state preparation

現在の active episode、主要参照対象、active local issue、直前の M state を内部状態として管理します。

局所問題は公式ラベルではなく内部追跡用です。対象同定、位置、方向、特徴、見立て、名称、課題仕様などの問題次元を保持します。

局所問題の自由記述名は閉集合ではないため、必要なら生成モデルまたは人間が短い issue summary を作成します。Jev は issue identity を生成せず、現在行が同じ issue を扱っているか、別 issue へ移ったかという相対判断を担当する候補とします。

## Stage 2: event judgments

Jev によって episode boundary、M event、P event、ER event を判定します。

ここで M event は状態そのものではなく、現在行へ新たな状態ラベルを書く必要があるかを含む event 判断です。継続時は CONTINUE を返します。

P event も同様に、新規開始または変更がなければ NONE を返します。

ER event は episode end 以外では原則 NONE です。

## Stage 3: span proposal

発話機能は任意文字範囲を扱うため、Jev に直接全文から span を生成させません。

通常部分については生成モデルが function-bearing span candidate を抽出します。重なり部分については Stage 0 の構造解析結果を必ず候補として保持します。

span proposal はラベルを確定しません。文字列、元位置、話者、overlap、候補理由だけを生成します。

## Stage 4: span label judgment

各 span candidate に対し、Jev が a1–a30 または NONE を閉集合判定します。

複数ラベルが必要な場合は、primary choice と boundary competitor verification を分離します。最初から 30 ラベルを自由な多値生成にしません。

## Stage 5: constraint validation

意味判断を変更せず、出力形式と階層制約を検査します。

例として、M の継続重複、P の継続重複、ER の end 行以外への付与、span と範囲一覧の不一致、overlap 範囲違反、部分 ID 重複、固定列変更などを検出します。

一部の意味制約も review flag として検出します。例として、M4 と ER0 は矛盾ではないためエラーにしません。一方、P2 と P4 が同一切替位置に同時採用された場合は競合として review に回します。

## Stage 6: human review

研究用 strict mode では、すべての最終ラベルを人間が確認します。

開発用 assist mode では、低確信、候補差が小さい、基準競合、モデル不一致、span 抽出不確実、構造 validator 違反の事例を優先表示します。

## Stage 7: audit

モデル出力と人間確定値を分離して保存します。

最低限、input hash、row id、model id、rubric version、ruleset version、context ids、raw choice probabilities、selected candidate、review flag、human decision、timestamp を保持します。

実発話本文を audit log に複製するかどうかは保存先のセキュリティ条件で切り替えます。Git リポジトリへは保存しません。
