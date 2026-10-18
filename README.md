# dialogue-grounding

現在の研究目的・実験計画・評価方針・未決定事項は、[現行の研究・実験計画（SSOT）](dialogue-model/README.md)に集約しています。研究計画を知りたい場合は、この1ファイルだけを参照してください。

## タングラム共同命名 v2 公開デモ

現在の操作確認ページは [タングラム共同命名 v2](https://tangram-grounding-experiment.kame-website.workers.dev/) です（認証不要）。Cloudflare上のTypeScriptエントリポイント、デプロイ手順と制約は [公開版README](workers/tangram-experiment/README.md) を参照してください。

## 研究領域

`annotation/` は既存の人間対話で観察された表象のずれと調整を記述する領域です。発話機能 a1–a30、ずれ状態 M0–M4、調整過程 P1–P6、エピソード結果 ER0/ER1、局所問題の後続処理を扱います。

`dialogue-model/` は、人間の対話における調整の働きを、LLMを用いた共同課題や実験を通して検討する領域です。議論やレビューの記録はこのディレクトリ以下に残しますが、現在の採用事項と計画の優先順位は[SSOT](dialogue-model/README.md)に従います。

対話モデルに外部AIを接続する最小実行基盤は[接続手順](dialogue-model/runtime/README.md)にあります。研究用Cloudflare WorkerにAPIキーをSecretとして登録し、ローカルにはWorker接続トークンのみを置くことで、OpenAI・Geminiの互換APIで画像付き対話を試せます。これは確定済み実験プロトコルではありません。

## 資料の扱い

日付付き提案は検討履歴、設計レビューは批評、決定記録は採用理由の記録であり、別々の現行仕様書ではありません。計画変更はSSOTを更新することで反映します。

実対話データ、音声、完成済みアノテーション、個人識別情報はGitリポジトリに保存しません。
