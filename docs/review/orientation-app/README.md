# 回転別観察メモ確認
全30図形の確定分割（117主要領域）を維持し、実装側で事前作成済みの0/90/180/270度の120通りの観察メモを人手確認する研究者用ローカル画面。
元図形と確定領域を表示し、角度ごとの全体・部分見立て、根拠、説明文を編集できる。分割・面積・形状・位置座標・隣接情報は読み取り専用。図形・角度ごとに確認状態とメモを保存する。未確認のみを絞り込める。
```sh
node docs/review/orientation-app/server.ts
```
既定URL: http://127.0.0.1:5498/
保存先: ~/Library/Application Support/dialogue-grounding/orientation-review-v1/review-state.json
入力のたびにMacのJSONへ原子的に保存し、直前版を別ファイルに保持する。通信失敗時はブラウザへ一時退避し、競合時に無条件上書きしない。JSONを書き出し・再取り込みできる。データのハッシュが異なる場合は既存結果を上書きしない。出力には各方向の幾何情報と編集後の説明・仮説・確認状態を含める。
元の分割確認結果は変更せず、実験の観察メモへの採用は別途行う。現在の見立てはAIによる未確認の案で、全30図形の分割確定とは区別する。実験runtimeおよび参加者画面は変更しない。
```sh
node --test docs/review/orientation-app/orientation-review.test.ts
```
ブラウザ検証には既存のplaywright-coreとChromiumを指定してbrowser-smoke.mjsを実行する。検証用サーバーとデータは別の一時ディレクトリ・ポートを用いる。
