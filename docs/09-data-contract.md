# Data Contract

## raw input

入力の固定列は、utterance_no、speaker、utterance、ah_label、segment_type とします。

元 Excel の列名は adapter 層で対応付けます。

utterance_no、speaker、ah_label、segment_type は変更しません。

utterance は管理用ノイズ記号だけを除去した normalized_utterance を別フィールドへ作り、原文も保持します。

## internal row

内部 row は少なくとも次の情報を持ちます。

row_id はファイル内で一意な ID です。

dialogue_id は対話単位の ID です。

utterance_no は元番号です。

speaker は A/B 等の記号化話者です。

raw_utterance と normalized_utterance を分けます。

episode_id、active_issue_id、previous_m_state は host が管理する状態です。

pre_context_ids と post_context_ids は、どの発話を判定文脈へ入れたかを記録します。

## model judgment

各判定は、task、candidate_set_version、selected、probabilities、confidence、model_id、rubric_hash、context_hash、review_required を持ちます。

selected だけを保存して probabilities を捨てません。

Jev の confidence と、人間が記入する 0–100 の自己評価確信度は別フィールドです。

## span record

span record は part_id、parent_utterance_no、part_no、speaker、target_text、parent_text、labels、overlap、ranges、start、end、proposal_model、label_model、review_status を持ちます。

ranges は半開区間の配列として内部保持し、Excel 出力時だけ 0-2;9-13 のような規定文字列へ変換します。

target_text は ranges の各区間を parent_text から抽出して連結した文字列と完全一致しなければなりません。

## annotation event

episode event、M event、P event、ER event は別フィールドで保存します。

最終 Excel へ書き戻す際だけ、既存フォーマットの各列へ変換します。

これにより、モデル内部表現と既存成果物フォーマットを分離します。

## audit record

audit record は raw dialogue text を必須にしません。

input hash、row id、context ids、model id、rubric version、ruleset version、prediction、candidate distribution、review decision、final decision、timestamp を基本とします。

研究データを含む完全な run artifact は Git 管理せず、アクセス制御された保存先へ置きます。

## versioning

ruleset_version、prompt_or_rubric_version、model_version、adapter_version、schema_version を独立に持ちます。

同じ model_version でも ruleset が違う結果を混ぜて比較しません。
