# Privacy and Reproducibility

## データ管理

実対話データ、音声、動画、完成済みアノテーション Excel はこの Git リポジトリへ保存しません。

リポジトリには設計文書、スキーマ、架空例、テスト用 synthetic data だけを置きます。

外部 API へ送るデータは、氏名などの直接識別情報を除去し、話者を記号化したものに限定します。

入力データがモデル学習に利用されない設定を使用するという既存の研究運用を維持します。

## secret

TYPESAFE_API_KEY 等は環境変数または secret manager から読み込みます。

API key を設定ファイル、example、audit log、error log へ出力しません。

secret scan は実装時に導入しますが、短い発話を誤って除外する汎用 sanity filter と結合しません。

## reproducibility

各 run では model id を latest のまま記録するだけでなく、可能なら固定バージョンを指定します。

ruleset、rubric、schema、adapter の version または commit hash を manifest に保存します。

入力ファイルそのものを Git に入れない代わりに、入力全体と各 row の hash を保存します。

同じ入力、同じ基準、同じモデルバージョンで再実行した際に、どの程度判定が一致するかを stability test として測定します。

## context provenance

各判定で参照した前後発話の row id を保存します。

これにより、同じ current utterance でも context expansion の有無によって結果が変わった場合に追跡できます。

## leakage prevention

完成済み正解ラベル、具体的な裁定済み発話例、過去のモデル出力を evaluation prompt へ混入させません。

一般化した基準と、評価対象データの具体例を分離します。

現在の 5 対話は基準作成に関与しているため、完全な unseen evaluation と表現しません。

## logging

raw text を含む debug log は標準で無効とします。

必要な場合も、アクセス制御されたローカル run directory に限定し、CI artifact や GitHub Actions log へ出さない設計にします。
